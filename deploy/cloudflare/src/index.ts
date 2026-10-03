import { Container } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runGuildSetup, SETUP_CONFIRMATION } from './guild-setup';
import { SqlSetupLedger, saveReadiness } from './setup-ledger';
import { inspectReadiness, runtimeActive } from './readiness';
import { receiveInteraction, type InteractionCommand } from './interactions';
import { InteractionLedger, type VoiceSession } from './interaction-ledger';
import { SessionCommands, commandRuntimeActive, modelMetadataActive, type ContainerCommand, type CommandResult } from './session-commands';
import { privateJson } from './private-http';
import { scopeFingerprint } from './guild-setup';
import { VoiceCatalogStore, OwnerVoiceSelection, type VoiceModel } from './voice-models';
export { ContainerProxy } from '@cloudflare/containers';

function trialActive(env: Env): boolean {
  const remaining = Date.parse(env.VOICE_DEADLINE) - Date.now();
  return remaining > 0 && remaining <= 30 * 60 * 1000;
}

export class Voicevox extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  envVars = { VOICE_DEADLINE: '' }; // An implicit/scheduler start must fail closed.
  private get lease(): string | null {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_lease (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT, deadline INTEGER)');
    return this.ctx.storage.sql.exec<{ session_id: string | null }>('SELECT session_id FROM voice_tts_lease WHERE id=1').toArray()[0]?.session_id ?? null;
  }
  private setLease(sessionId: string | null, deadline: number = 0): void {
    void this.lease;
    this.ctx.storage.sql.exec('INSERT INTO voice_tts_lease(id, session_id, deadline) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, deadline=excluded.deadline', sessionId, deadline);
  }
  private revoke(sessionId: string): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_revoked (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('DELETE FROM voice_tts_revoked WHERE expires_at <= ?', Date.now());
    this.ctx.storage.sql.exec('INSERT INTO voice_tts_revoked(session_id, expires_at) VALUES(?, ?) ON CONFLICT(session_id) DO UPDATE SET expires_at=excluded.expires_at', sessionId, Date.now()+31*60_000);
  }
  private revoked(sessionId: string): boolean {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_revoked (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    return this.ctx.storage.sql.exec<{ expires_at: number }>('SELECT expires_at FROM voice_tts_revoked WHERE session_id=?', sessionId).toArray().some(row => row.expires_at > Date.now());
  }
  private modelCatalog = new VoiceCatalogStore(this.ctx.storage);
  async getModelCatalog(): Promise<VoiceModel[] | null> { return this.modelCatalog.get(); }
  private speechAbort: AbortController | null = null;
  async scopedSpeech(request: Request, sessionId: string, deadline: number): Promise<Response> {
    if (!trialActive(this.env) || deadline <= Date.now() || deadline > Date.parse(this.env.VOICE_DEADLINE) || this.revoked(sessionId)) return new Response(null, { status: 503 });
    if (this.speechAbort) return Response.json({ error: 'SYNTHESIS_BUSY' }, { status: 429 });
    const controller = new AbortController();
    this.speechAbort = controller;
    const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(Math.max(1, Math.min(45_000, deadline - Date.now())))]);
    try {
      const previousLease = this.lease;
      if (this.ctx.container?.running && previousLease !== sessionId) await this.destroy();
      if (this.revoked(sessionId)) throw new Error('SESSION_STOPPED');
      this.setLease(sessionId, deadline);
      await this.ctx.storage.sync();
      signal.throwIfAborted();
      if (this.revoked(sessionId) || this.lease !== sessionId) throw new Error('SESSION_STOPPED');
      await this.startAndWaitForPorts({ ports: 8080, startOptions: { envVars: { VOICE_DEADLINE: new Date(deadline).toISOString() } },
        cancellationOptions: { abort: signal, instanceGetTimeoutMS: 20_000, portReadyTimeoutMS: 30_000 } });
      signal.throwIfAborted();
      if (this.lease !== sessionId || this.revoked(sessionId)) throw new Error('SESSION_STOPPED');
      const response = await this.ctx.container!.getTcpPort(8080).fetch(new Request(request, { signal }));
      // Learn only from an already-authorized speech attempt. The adapter's
      // catalog endpoint is memory-only and never makes an engine request.
      if (!signal.aborted && this.ctx.container?.running && this.lease === sessionId && !this.revoked(sessionId)) {
        try {
          const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
          const metadata = await this.ctx.container.getTcpPort(8080).fetch('http://tts.internal/v1/models', { signal: metadataSignal, redirect: 'manual' });
          if (metadata.ok) {
            const value = await privateJson(metadata, 256 * 1024, metadataSignal);
            if (!signal.aborted && this.lease === sessionId && !this.revoked(sessionId)) await this.modelCatalog.save(value.catalog);
          } else await metadata.body?.cancel();
        } catch { /* Metadata failure does not turn valid audio into failure. */ }
      }
      return response;
    } catch {
      if (this.lease === sessionId) { this.setLease(null); await this.destroy().catch(() => {}); }
      return Response.json({ error: 'VOICE_SERVICE_UNAVAILABLE' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    } finally { if (this.speechAbort === controller) this.speechAbort = null; this.renewActivityTimeout(); }
  }
  async stopSession(sessionId: string): Promise<void> {
    // A revocation survives reconstruction and rejects any delayed outbound RPC.
    this.revoke(sessionId);
    await this.ctx.storage.sync();
    // Preserve another client's shared-TTS lease; this Bot cannot stop RSS work.
    if (this.lease !== sessionId) return;
    this.setLease(null); this.speechAbort?.abort();
    await this.destroy();
  }
  override async onActivityExpired(): Promise<void> { this.setLease(null); this.speechAbort?.abort(); await this.destroy(); }
  override onError(): void { console.warn(JSON.stringify({ event: 'voice_container_unavailable' })); }
}

export class DiscordBot extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '1m';
  // Discord's voice WebSocket and UDP are originated by the container.
  // Actual cloud DAVE/UDP connectivity is an explicit launch gate, not a unit-test claim.
  enableInternet = true;
  envVars = {
    BOT_ENABLED: 'false', VOICE_DEADLINE: '',
  };
  private commandLedger = new InteractionLedger(this.ctx.storage);
  private ownerModel = new OwnerVoiceSelection(this.ctx.storage, scopeFingerprint(this.env));
  private mutation: Promise<void> = Promise.resolve();
  private imageLease(): string | null {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_bot_image_lease (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT)');
    return this.ctx.storage.sql.exec<{ session_id: string | null }>('SELECT session_id FROM voice_bot_image_lease WHERE id=1').toArray()[0]?.session_id ?? null;
  }
  private setImageLease(sessionId: string | null): void {
    void this.imageLease();
    this.ctx.storage.sql.exec('INSERT INTO voice_bot_image_lease(id, session_id) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id', sessionId);
  }
  private commands = new SessionCommands(this.env, this.commandLedger, {
    start: (session, signal) => this.startSession(session, signal),
    invoke: (command, signal) => this.invokeCommand(command, signal),
    status: sessionId => this.sessionStatus(sessionId),
    model: (command, signal) => this.modelCommand(command, signal),
    destroy: sessionId => this.destroySession(sessionId),
    scheduleJob: async id => { await this.schedule(1, 'runCommandJob', { id }); },
    scheduleExpiry: async session => { await this.schedule(new Date(Math.ceil(session.deadline/1000)*1000), 'expireCommandSession', { sessionId: session.id }); },
    scheduleSweep: async () => { await this.schedule(95, 'sweepCommandJobs'); await this.schedule(15 * 60 + 1, 'sweepCommandJobs'); },
    scheduleStop: async sessionId => { await this.schedule(1, 'stopStoppedSession', { sessionId }); },
  });
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.then(() => {}, () => {});
    return next;
  }
  private async snapshot(signal: AbortSignal = AbortSignal.timeout(5000)): Promise<Record<string, unknown> | null> {
    if (!this.ctx.container?.running) return null;
    return privateJson(await this.ctx.container.getTcpPort(8080).fetch('http://bot.internal/health', { signal, redirect: 'manual' }));
  }
  private async startSession(session: VoiceSession, signal: AbortSignal): Promise<void> {
    return this.serialize(async () => {
      const valid = () => commandRuntimeActive(this.env) && this.commandLedger.session()?.id === session.id && this.commandLedger.session()?.status !== 'stopped';
      if (!valid()) throw new Error('SESSION_STOPPED');
      if (this.ctx.container?.running) {
        const current = await this.snapshot(signal).catch(() => null);
        if (current?.sessionId !== session.id) await this.destroy();
      }
      signal.throwIfAborted();
      if (!this.ctx.container?.running) {
        // Reconcile old onStop while the old lease is still published. SDK stop
        // on an already-stopped instance only synchronizes pending stop events.
        await this.stop();
      }
      if (!valid()) throw new Error('SESSION_STOPPED');
      // Publish/sync ownership before an external start so reconstruction can
      // always stop the correct generation, including a crash after start.
      this.setImageLease(session.id);
      await this.ctx.storage.sync();
      signal.throwIfAborted();
      if (!valid()) throw new Error('SESSION_STOPPED');
      try { await this.startAndWaitForPorts({ ports: 8080, cancellationOptions: { abort: signal, instanceGetTimeoutMS: 20_000, portReadyTimeoutMS: 25_000 },
        startOptions: { envVars: {
          BOT_ENABLED: 'true', DISCORD_COMMAND_TRANSPORT: 'http', VOICE_SESSION_ID: session.id,
          DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID: this.env.DISCORD_APPLICATION_ID,
          DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID, DISCORD_TEXT_CHANNEL_ID: this.env.DISCORD_TEXT_CHANNEL_ID,
          DISCORD_OWNER_ID: this.env.DISCORD_OWNER_ID, TTS_URL: 'http://tts.internal/v1/speech',
          VOICE_DEADLINE: new Date(session.deadline).toISOString(), VOICE_IDLE_SECONDS: this.env.VOICE_IDLE_SECONDS,
        } } }); }
      catch { await this.destroy().catch(() => {}); throw new Error('GATEWAY_START_FAILED'); }
      const until = Math.min(Date.now() + 20_000, session.deadline);
      while (valid() && Date.now() < until) {
        signal.throwIfAborted();
        const status = await this.snapshot(signal);
        if (status?.sessionId === session.id && status.ready === true) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      await this.destroy();
      throw new Error('GATEWAY_NOT_READY');
    });
  }
  private async invokeCommand(command: ContainerCommand, signal: AbortSignal): Promise<CommandResult> {
    if (!this.ctx.container?.running || this.commandLedger.session()?.id !== command.sessionId) throw new Error('SESSION_STOPPED');
    const response = await this.ctx.container.getTcpPort(8080).fetch('http://bot.internal/v1/command', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command), signal, redirect: 'manual',
    });
    const result = await privateJson(response);
    if (!response.ok || typeof result.content !== 'string' || result.content.length > 500 || typeof result.joined !== 'boolean') throw new Error('PRIVATE_COMMAND_FAILED');
    return { content: result.content, joined: result.joined };
  }
  private async sessionStatus(sessionId: string): Promise<string> {
    const snapshot = await this.snapshot();
    if (!snapshot || snapshot.sessionId !== sessionId) return '現在は未接続です';
    return snapshot.ready === true ? `音声接続: ${snapshot.voice === 'ready' ? '接続中' : '未接続'} / 待機: ${typeof snapshot.queued === 'number' ? snapshot.queued : 0}` : 'Gateway接続を確認できません';
  }
  private async destroySession(sessionId: string): Promise<void> {
    let predecessor: string | null = null;
    await this.serialize(async () => {
      const owner = this.imageLease();
      const current = this.commandLedger.session();
      // An old callback cannot kill a newer image. The latest terminal session
      // may also clean up its still-running predecessor after admission fails.
      if (!owner || (owner !== sessionId && !(current?.id === sessionId && current.status === 'stopped'))) return;
      const snapshot = await this.snapshot().catch(() => null);
      if (this.ctx.container?.running && (!snapshot || snapshot.sessionId === owner)) {
        try {
          const response = await this.ctx.container.getTcpPort(8080).fetch('http://bot.internal/v1/shutdown', {
            method:'POST',redirect:'manual',signal:AbortSignal.timeout(1000),headers:{'content-type':'application/json'},
            body:JSON.stringify({sessionId:owner,applicationId:this.env.DISCORD_APPLICATION_ID,guildId:this.env.DISCORD_GUILD_ID,
              channelId:this.env.DISCORD_TEXT_CHANNEL_ID,userId:this.env.DISCORD_OWNER_ID}),
          });await response.body?.cancel();
        } catch { /* A bounded graceful leave is followed by hard destruction. */ }
        await this.destroy();
        predecessor = owner;
      }
    });
    await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(sessionId);
    if (predecessor && predecessor !== sessionId) await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(predecessor);
  }
  override async onActivityExpired(): Promise<void> {
    const session = this.commandLedger.session();
    if (!session) { await this.destroy(); return; }
    try {
      const snapshot = await this.snapshot();
      if (this.commands.speechLease(session.id) && snapshot?.sessionId === session.id && snapshot.voice === 'ready' &&
          typeof snapshot.idleAt === 'number' && snapshot.idleAt > Date.now()) { this.renewActivityTimeout(); return; }
    } catch { /* Fail closed without raw exception data. */ }
    await this.commands.stopped(session.id);
    await this.destroySession(session.id);
  }
  override async onStop(): Promise<void> {
    if (this.ctx.container?.running) return;
    const sessionId = this.imageLease();
    if (sessionId) { await this.commands.stopped(sessionId); await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(sessionId); }
    this.setImageLease(null);
  }
  override onError(): void { console.warn(JSON.stringify({ event: 'bot_container_unavailable' })); }
  async enqueueInteraction(command: InteractionCommand): Promise<void> { await this.commands.enqueue(command); }
  async runCommandJob(payload: { id: string }): Promise<void> { try { await this.commands.run(payload.id); } catch { console.warn(JSON.stringify({ event: 'discord_command_unavailable' })); } }
  async expireCommandSession(payload: { sessionId: string }): Promise<void> { await this.commands.expire(payload.sessionId); }
  async stopStoppedSession(payload: { sessionId: string }): Promise<void> {
    if (this.commandLedger.session()?.id === payload.sessionId && this.commandLedger.session()?.status === 'stopped') await this.destroySession(payload.sessionId);
  }
  async sweepCommandJobs(): Promise<void> { await this.commands.sweep(); }
  async getSpeechLease(sessionId: string): Promise<VoiceSession | null> { return this.commands.speechLease(sessionId); }
  async getSpeechModel(sessionId: string, authorId: string): Promise<number | undefined> {
    if (!this.commands.speechLease(sessionId) || authorId !== this.env.DISCORD_OWNER_ID) return undefined;
    return this.ownerModel.get();
  }
  private async modelCommand(command: InteractionCommand, signal: AbortSignal): Promise<string> {
    if (!modelMetadataActive(this.env) || command.applicationId !== this.env.DISCORD_APPLICATION_ID ||
        command.guildId !== this.env.DISCORD_GUILD_ID || command.channelId !== this.env.DISCORD_TEXT_CHANNEL_ID ||
        command.userId !== this.env.DISCORD_OWNER_ID) throw new Error('MODEL_SCOPE_MISMATCH');
    signal.throwIfAborted();
    const catalog = await this.env.VOICEVOX.getByName('shared-voicevox').getModelCatalog();
    signal.throwIfAborted();
    return this.ownerModel.command(catalog, command, signal);
  }
  async setupGuildCommands() {
    return runGuildSetup(this.env, new SqlSetupLedger(this.ctx.storage), () => this.ctx.container?.running ?? false);
  }
  async checkReadiness() {
    // Readiness is observational. It cannot start a stopped Container.
    const snapshot = await inspectReadiness(this.env, request => this.ctx.container?.running
      ? this.ctx.container.getTcpPort(8080).fetch(request) : Promise.resolve(new Response(null, { status: 503 })));
    saveReadiness(this.ctx.storage, snapshot);
    await this.ctx.storage.sync();
    return snapshot;
  }
}

async function speech(request: Request, env: Env, sessionId?: string): Promise<Response> {
  if (!trialActive(env)) return Response.json({ error: 'TRIAL_INACTIVE' }, { status: 503 });
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/v1/speech' || url.search) return new Response(null, { status: 404 });
  try {
    const lease = sessionId ? await env.BOT.getByName('discord-singleton').getSpeechLease(sessionId) : null;
    if (sessionId && !lease) return new Response(null, { status: 503 });
    // Never trust a caller-supplied style header. RSS and non-owner Discord
    // authors keep the named default; only the owner's durable choice applies.
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.delete('x-voice-speaker-id');
    if (sessionId) {
      const authorId = request.headers.get('x-voice-author-id') ?? '';
      if (!/^\d{17,20}$/.test(authorId)) return new Response(null, { status: 400 });
      const speakerId = await env.BOT.getByName('discord-singleton').getSpeechModel(sessionId, authorId);
      if (speakerId !== undefined) forwardedHeaders.set('x-voice-speaker-id', String(speakerId));
    }
    forwardedHeaders.delete('x-voice-author-id');
    return await env.VOICEVOX.getByName('shared-voicevox').scopedSpeech(new Request(request, { headers: forwardedHeaders }), sessionId ?? 'rss-service-binding', lease?.deadline ?? Date.parse(env.VOICE_DEADLINE));
  } catch {
    return Response.json({ error: 'VOICE_SERVICE_UNAVAILABLE' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

DiscordBot.outboundByHost = {
  'tts.internal': (request, env, context) => {
    const sessionId = request.headers.get('x-voice-session-id') ?? '';
    if (context.className !== 'DiscordBot' || context.containerId !== env.BOT.idFromName('discord-singleton').toString() ||
        !/^[0-9a-f-]{36}$/.test(sessionId)) return new Response(null, { status: 403 });
    return speech(request, env, sessionId);
  },
};

// RSS backend will use this named service binding. Never put a service secret into browser JS.
export class VoiceApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> { return speech(request, this.env); }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return receiveInteraction(request, env, command => env.BOT.getByName('discord-singleton').enqueueInteraction(command),
      work => ctx.waitUntil(work), () => commandRuntimeActive(env));
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // A private RPC performs setup without inherited Container fetch/start. The
    // RPC independently verifies all guards, including actual container.running.
    if (String(env.CONFIRM_DISCORD_SETUP) === SETUP_CONFIRMATION) {
      try {
        const receipt = await env.BOT.getByName('discord-singleton').setupGuildCommands();
        console.log(JSON.stringify({ event: 'discord_setup_result', receipt }));
      } catch { console.warn(JSON.stringify({ event: 'discord_setup_guard_rejected' })); }
      return;
    }
    // Housekeeping observes durable jobs and deadlines; it never starts voice.
    await env.BOT.getByName('discord-singleton').sweepCommandJobs();
    if (!runtimeActive(env)) return;
    try {
      const snapshot = await env.BOT.getByName('discord-singleton').checkReadiness();
      console.log(JSON.stringify({ event: 'discord_gateway_readiness', snapshot }));
    } catch { console.warn(JSON.stringify({ event: 'discord_gateway_readiness_unavailable' })); }
  },
} satisfies ExportedHandler<Env>;
