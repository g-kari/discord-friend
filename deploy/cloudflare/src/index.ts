import { Container } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runGuildSetup, SETUP_CONFIRMATION, APPROVED_SCOPE_FINGERPRINT } from './guild-setup';
import { SqlSetupLedger, saveReadiness } from './setup-ledger';
import { runGlobalCommandSetup } from './global-command-setup';
import { SqlGlobalSetupLedger } from './global-setup-ledger';
import { inspectReadiness, runtimeActive } from './readiness';
import { receiveInteraction, type InteractionCommand } from './interactions';
import { InteractionLedger, type VoiceSession } from './interaction-ledger';
import { SessionCommands, commandRuntimeActive, modelMetadataActive, type ContainerCommand, type CommandResult, type VoiceSpeechLease } from './session-commands';
import { privateJson } from './private-http';
import { commandScopeAllowed, installedScope, principalFingerprint, sameSessionScope, type SessionScope } from './scope-policy';
import { scopeFingerprint } from './guild-setup';
import { VoiceCatalogStore, OwnerVoiceSelection, type VoiceModel } from './voice-models';
import { SESSION_LIMIT_MS, dailySessionBounded } from './usage-ledger';
export { ContainerProxy } from '@cloudflare/containers';

function trialActive(env: Env): boolean {
  const remaining = Date.parse(env.VOICE_DEADLINE) - Date.now();
  return remaining > 0 && remaining <= 30 * 60 * 1000;
}
function speechDeadlineActive(env: Env, sessionId: string, deadline: number): boolean {
  const remaining = deadline - Date.now();
  if (!(remaining > 0)) return false;
  // Daily Discord permission does not open or extend the separate RSS service.
  if (String(env.VOICE_USAGE_MODE) === 'daily' && sessionId !== 'rss-service-binding') return remaining <= SESSION_LIMIT_MS && commandRuntimeActive(env);
  return remaining <= 30 * 60_000 && trialActive(env) && deadline <= Date.parse(env.VOICE_DEADLINE);
}
// Fixed health phases only; never relay free-form Bot data or infer TTS warmth.
const SPEECH_PHASE_LABELS = Object.freeze({
  connecting: 'Bot接続準備中',
  'awaiting-text': '初回読み上げ待機（投稿時に音声を準備）',
  preparing: '音声準備中（初回は起動待ち）',
  speaking: '読み上げ中',
  idle: '読み上げ待機中',
  stopped: '読み上げ停止（次の投稿で再開）',
  failed: '読み上げ失敗（次の投稿で再試行）',
  reconnecting: '音声接続の復旧待ち',
  disconnected: '未接続',
  ended: 'セッション終了',
});
interface SpeechLease { sessionId: string | null; deadline: number; generation: string | null }

export class Voicevox extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  envVars = { VOICE_DEADLINE: '' }; // An implicit/scheduler start must fail closed.
  // All starts use guarded RPC. Inherited Container.fetch would start on any
  // request, including a health probe, before a speech lease exists.
  override async fetch(_request: Request): Promise<Response> { return new Response(null, { status: 404 }); }
  private get leaseState(): SpeechLease {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_lease (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT, deadline INTEGER)');
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_lease_generation (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL)');
    const row = this.ctx.storage.sql.exec<{ session_id: string | null; deadline: number }>('SELECT session_id, deadline FROM voice_tts_lease WHERE id=1').toArray()[0];
    const epoch = this.ctx.storage.sql.exec<{ generation: string }>('SELECT generation FROM voice_tts_lease_generation WHERE id=1').toArray()[0];
    return { sessionId: row?.session_id ?? null, deadline: row?.deadline ?? 0, generation: epoch?.generation ?? null };
  }
  private get lease(): string | null { return this.leaseState.sessionId; }
  private setLease(sessionId: string | null, deadline: number = 0): void {
    void this.lease;
    this.ctx.storage.sql.exec('INSERT INTO voice_tts_lease(id, session_id, deadline) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, deadline=excluded.deadline', sessionId, deadline);
    this.ctx.storage.sql.exec('INSERT INTO voice_tts_lease_generation(id, generation) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation', crypto.randomUUID());
  }
  private ownsLease(expected: SpeechLease): boolean {
    const current = this.leaseState;
    return current.sessionId === expected.sessionId && current.deadline === expected.deadline && current.generation === expected.generation;
  }
  private mutation: Promise<void> = Promise.resolve();
  private pendingCleanup = 0;
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(operation, operation);
    this.mutation = next.then(() => {}, () => {});
    return next;
  }
  private revoke(sessionId: string): void {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_revoked (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    this.ctx.storage.sql.exec('DELETE FROM voice_tts_revoked WHERE expires_at <= ?', Date.now());
    this.ctx.storage.sql.exec('INSERT INTO voice_tts_revoked(session_id, expires_at) VALUES(?, ?) ON CONFLICT(session_id) DO UPDATE SET expires_at=excluded.expires_at', sessionId, Date.now() + SESSION_LIMIT_MS + 60_000);
  }
  private revoked(sessionId: string): boolean {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_tts_revoked (session_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    return this.ctx.storage.sql.exec<{ expires_at: number }>('SELECT expires_at FROM voice_tts_revoked WHERE session_id=?', sessionId).toArray().some(row => row.expires_at > Date.now());
  }
  private modelCatalog = new VoiceCatalogStore(this.ctx.storage);
  async getModelCatalog(): Promise<VoiceModel[] | null> { return this.modelCatalog.get(); }
  private speechAbort: AbortController | null = null;
  private speechOwner: SpeechLease | null = null;
  async scopedSpeech(request: Request, sessionId: string, deadline: number): Promise<Response> {
    if (!speechDeadlineActive(this.env, sessionId, deadline) || this.revoked(sessionId)) return new Response(null, { status: 503 });
    if (this.speechAbort || this.pendingCleanup) return Response.json({ error: 'SYNTHESIS_BUSY' }, { status: 429 });
    const controller = new AbortController();
    this.speechAbort = controller;
    let attempt: SpeechLease | null = null;
    const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(Math.max(1, Math.min(45_000, deadline - Date.now())))]);
    try {
      await this.serialize(async () => {
        const previousLease = this.lease;
        if (previousLease !== sessionId && (this.ctx.container?.running || previousLease)) await this.destroy();
        // Reconcile the SDK predecessor's stop callback before publishing the
        // successor lease, as the Bot adapter does for its image generation.
        if (!this.ctx.container?.running) await this.stop();
        signal.throwIfAborted();
        if (this.revoked(sessionId) || !speechDeadlineActive(this.env, sessionId, deadline)) throw new Error('SESSION_STOPPED');
        this.setLease(sessionId, deadline);
        attempt = this.leaseState;
        this.speechOwner = attempt;
        await this.ctx.storage.sync();
        // Persist cleanup before external startup. A process exit does not prove
        // that the underlying resource has been reclaimed by the platform.
        await this.schedule(new Date(Math.ceil(deadline / 1000) * 1000), 'expireSpeechLease', attempt);
        signal.throwIfAborted();
        const imageEnv: Record<string, string> = { VOICE_DEADLINE: new Date(deadline).toISOString(), VOICE_USAGE_MODE: 'trial', VOICE_SESSION_STARTED_AT: '' };
        if (String(this.env.VOICE_USAGE_MODE) === 'daily') {
          // Independently require the durable Bot reservation before a TTS start.
          const permitted = await this.env.BOT.getByName('discord-singleton').getSpeechLease(sessionId);
          if (!permitted || permitted.deadline !== deadline || !dailySessionBounded(permitted.startedAt, deadline, Date.now())) throw new Error('SESSION_STOPPED');
          imageEnv.VOICE_USAGE_MODE = 'daily';
          imageEnv.VOICE_SESSION_STARTED_AT = new Date(permitted.startedAt).toISOString();
          signal.throwIfAborted();
        }
        if (this.revoked(sessionId) || !speechDeadlineActive(this.env, sessionId, deadline) || !this.ownsLease(attempt)) throw new Error('SESSION_STOPPED');
        await this.startAndWaitForPorts({ ports: 8080, startOptions: { envVars: imageEnv },
          cancellationOptions: { abort: signal, instanceGetTimeoutMS: 20_000, portReadyTimeoutMS: 30_000 } });
        signal.throwIfAborted();
        if (!this.ownsLease(attempt) || !speechDeadlineActive(this.env, sessionId, deadline) || this.revoked(sessionId)) throw new Error('SESSION_STOPPED');
      });
      const response = await this.ctx.container!.getTcpPort(8080).fetch(new Request(request, { signal }));
      // Learn only from an already-authorized speech attempt. The adapter's
      // catalog endpoint is memory-only and never makes an engine request.
      if (!signal.aborted && attempt && this.ctx.container?.running && this.ownsLease(attempt) && !this.revoked(sessionId)) {
        try {
          const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
          const metadata = await this.ctx.container.getTcpPort(8080).fetch('http://tts.internal/v1/models', { signal: metadataSignal, redirect: 'manual' });
          if (metadata.ok) {
            const value = await privateJson(metadata, 256 * 1024, metadataSignal);
            if (!signal.aborted && this.ownsLease(attempt) && !this.revoked(sessionId)) await this.modelCatalog.save(value.catalog);
          } else await metadata.body?.cancel();
        } catch { /* Metadata failure does not turn valid audio into failure. */ }
      }
      return response;
    } catch {
      // A failed request is not permanent revocation. In particular RSS reuses
      // its identity; only this attempt's durable generation may be reclaimed.
      if (attempt && this.ownsLease(attempt)) {
        try { await this.reclaimLease(attempt); }
        catch { await this.schedule(15, 'retryFailedLease', attempt).catch(() => {}); }
      }
      return Response.json({ error: 'VOICE_SERVICE_UNAVAILABLE' }, { status: 503, headers: { 'cache-control': 'no-store' } });
    } finally {
      if (this.speechAbort === controller) { this.speechAbort = null; this.speechOwner = null; }
      this.renewActivityTimeout();
    }
  }
  async stopSession(sessionId: string): Promise<void> {
    // A revocation survives reconstruction and rejects any delayed outbound RPC.
    this.revoke(sessionId);
    await this.ctx.storage.sync();
    // Preserve another client's shared-TTS lease; this Bot cannot stop RSS work.
    if (this.lease !== sessionId) return;
    try { await this.reclaimLease(this.leaseState); }
    catch { await this.schedule(15, 'reconcileExpiredLease'); throw new Error('VOICE_CLEANUP_UNAVAILABLE'); }
  }
  private async reclaimLease(expected: SpeechLease): Promise<void> {
    if (!this.ownsLease(expected)) return;
    if (this.speechOwner && this.speechOwner.generation === expected.generation) this.speechAbort?.abort();
    // Every queued cleanup keeps admission closed. Overlapping callbacks cannot
    // replace/release each other's barrier while a destroy is still pending.
    this.pendingCleanup++;
    try {
      await this.serialize(async () => {
        if (!this.ownsLease(expected)) return;
        await this.destroy(); // Also discard an exited process's resource.
        if (this.ownsLease(expected)) {
          this.setLease(null);
          await this.ctx.storage.sync();
        }
      });
    } finally { this.pendingCleanup--; }
  }
  async expireSpeechLease(payload: SpeechLease): Promise<void> {
    if (!payload.sessionId || !this.ownsLease(payload) || payload.deadline > Date.now()) return;
    // RSS uses a reusable identity. Expiry invalidates this deadline, not every
    // later authorized RSS lease for the same service-binding name.
    try { await this.reclaimLease(payload); }
    catch {
      // SDK one-shot callbacks are consumed even after failure. Keep durable
      // ownership and explicitly re-arm; the Bot Cron also reconciles expiry.
      await this.schedule(15, 'expireSpeechLease', payload);
      throw new Error('VOICE_CLEANUP_UNAVAILABLE');
    }
  }
  async cleanupStoppedLease(payload: SpeechLease): Promise<void> {
    if (this.ctx.container?.running || this.speechAbort) return;
    try { await this.reclaimLease(payload); }
    catch { await this.schedule(15, 'cleanupStoppedLease', payload); throw new Error('VOICE_CLEANUP_UNAVAILABLE'); }
  }
  async retryFailedLease(payload: SpeechLease): Promise<void> {
    try { await this.reclaimLease(payload); }
    catch { await this.schedule(15, 'retryFailedLease', payload); throw new Error('VOICE_CLEANUP_UNAVAILABLE'); }
  }
  async reconcileExpiredLease(): Promise<void> {
    const current = this.leaseState;
    if (current.sessionId && speechDeadlineActive(this.env, current.sessionId, current.deadline) && !this.revoked(current.sessionId)) return;
    if (current.sessionId && this.revoked(current.sessionId)) await this.stopSession(current.sessionId);
    else if (current.sessionId) await this.reclaimLease(current);
    else if (!this.speechAbort) await this.reclaimLease(current);
  }
  override async onStop(): Promise<void> {
    const current = this.leaseState;
    if (!this.ctx.container?.running && current.sessionId) await this.schedule(1, 'cleanupStoppedLease', current);
  }
  override async onActivityExpired(): Promise<void> { await this.reclaimLease(this.leaseState); }
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
  override async fetch(_request: Request): Promise<Response> { return new Response(null, { status: 404 }); }
  private commandLedger = new InteractionLedger(this.ctx.storage);
  private ownerModel = new OwnerVoiceSelection(this.ctx.storage, installedScope(this.env) ? principalFingerprint(this.env) : scopeFingerprint(this.env), installedScope(this.env) && scopeFingerprint(this.env) === APPROVED_SCOPE_FINGERPRINT ? APPROVED_SCOPE_FINGERPRINT : undefined);
  private mutation: Promise<void> = Promise.resolve();
  private imageLease(): string | null {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_bot_image_lease (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT)');
    return this.ctx.storage.sql.exec<{ session_id: string | null }>('SELECT session_id FROM voice_bot_image_lease WHERE id=1').toArray()[0]?.session_id ?? null;
  }
  private imageScope(sessionId: string): SessionScope | undefined {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_bot_image_scope (id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL, scope TEXT NOT NULL)');
    const row = this.ctx.storage.sql.exec<{ scope: string }>('SELECT scope FROM voice_bot_image_scope WHERE id=1 AND session_id=?', sessionId).toArray()[0];
    return row ? JSON.parse(row.scope) as SessionScope : undefined;
  }
  private pinnedScope(): SessionScope {
    return { applicationId: this.env.DISCORD_APPLICATION_ID, guildId: this.env.DISCORD_GUILD_ID,
      channelId: this.env.DISCORD_TEXT_CHANNEL_ID, userId: this.env.DISCORD_OWNER_ID };
  }
  private setImageLease(sessionId: string | null, scope?: SessionScope): void {
    void this.imageLease();
    void this.imageScope(sessionId ?? '');
    if (sessionId && scope) this.ctx.storage.sql.exec('INSERT INTO voice_bot_image_scope(id, session_id, scope) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, scope=excluded.scope', sessionId, JSON.stringify(scope));
    else if (!sessionId) this.ctx.storage.sql.exec('DELETE FROM voice_bot_image_scope WHERE id=1');
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
      const valid = () => commandRuntimeActive(this.env) && this.commandLedger.session()?.id === session.id && this.commandLedger.session()?.status !== 'stopped' && session.deadline > Date.now() && this.commands.admitted(session);
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
      const scope = installedScope(this.env) ? session.scope! : this.pinnedScope();
      this.setImageLease(session.id, scope);
      await this.ctx.storage.sync();
      signal.throwIfAborted();
      if (!valid()) throw new Error('SESSION_STOPPED');
      try { await this.startAndWaitForPorts({ ports: 8080, cancellationOptions: { abort: signal, instanceGetTimeoutMS: 20_000, portReadyTimeoutMS: 25_000 },
        startOptions: { envVars: {
          BOT_ENABLED: 'true', DISCORD_COMMAND_TRANSPORT: 'http', VOICE_SESSION_ID: session.id,
          DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID: this.env.DISCORD_APPLICATION_ID,
          DISCORD_SCOPE_MODE: this.env.DISCORD_SCOPE_MODE || 'pinned',
          DISCORD_GUILD_ID: scope.guildId, DISCORD_TEXT_CHANNEL_ID: scope.channelId,
          DISCORD_OWNER_ID: this.env.DISCORD_OWNER_ID, TTS_URL: 'http://tts.internal/v1/speech',
          VOICE_DEADLINE: new Date(session.deadline).toISOString(), VOICE_IDLE_SECONDS: this.env.VOICE_IDLE_SECONDS,
          VOICE_USAGE_MODE: this.env.VOICE_USAGE_MODE || 'trial',
          VOICE_SESSION_STARTED_AT: new Date(String(this.env.VOICE_USAGE_MODE) === 'daily' ? this.commandLedger.usage.reservation()!.started_at : session.createdAt).toISOString(),
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
    if (!this.ctx.container?.running || this.commandLedger.session()?.id !== command.sessionId ||
        (installedScope(this.env) && !sameSessionScope(this.imageScope(command.sessionId), command))) throw new Error('SESSION_STOPPED');
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
    if (snapshot.ready !== true) return 'Gateway接続を確認できません';
    const queued = typeof snapshot.queued === 'number' && Number.isSafeInteger(snapshot.queued) && snapshot.queued >= 0 ? snapshot.queued : 0;
    const phase = snapshot.speechPhase;
    if (typeof phase === 'string' && Object.hasOwn(SPEECH_PHASE_LABELS, phase)) {
      return `${SPEECH_PHASE_LABELS[phase as keyof typeof SPEECH_PHASE_LABELS]} / 待機: ${queued}件`;
    }
    // Old images omit speechPhase. Keep their connection-only status available.
    return `音声接続: ${snapshot.voice === 'ready' ? '接続中' : '未接続'} / 待機: ${queued}`;
  }
  private async destroySession(sessionId: string): Promise<void> {
    let predecessor: string | null = null;
    let reclaimed = false;
    await this.serialize(async () => {
      const owner = this.imageLease();
      const current = this.commandLedger.session();
      // An old callback cannot kill a newer image. The latest terminal session
      // may also clean up its still-running predecessor after admission fails.
      if (!owner) {
        if (current?.id === sessionId && current.status === 'stopped') { await this.destroy(); reclaimed = true; }
        return;
      }
      if (owner !== sessionId && !(current?.id === sessionId && current.status === 'stopped')) return;
      const snapshot = await this.snapshot().catch(() => null);
      if (!snapshot || snapshot.sessionId === owner) {
        if (this.ctx.container?.running) try {
          const response = await this.ctx.container.getTcpPort(8080).fetch('http://bot.internal/v1/shutdown', {
            method:'POST',redirect:'manual',signal:AbortSignal.timeout(1000),headers:{'content-type':'application/json'},
            body:JSON.stringify({sessionId:owner,...(this.imageScope(owner) ?? this.pinnedScope())}),
          });await response.body?.cancel();
        } catch { /* A bounded graceful leave is followed by hard destruction. */ }
        // container.running describes the process, not whether a placement
        // remains. Retain generation ownership until resource cleanup succeeds.
        await this.destroy();
        predecessor = owner;
        reclaimed = true;
      }
    });
    await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(sessionId);
    if (predecessor && predecessor !== sessionId) await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(predecessor);
    if (reclaimed) {
      this.commandLedger.usage.settle(sessionId, Date.now());
      await this.ctx.storage.sync();
    }
  }
  override async onActivityExpired(): Promise<void> {
    const session = this.commandLedger.session();
    if (!session) { await this.destroy(); return; }
    try {
      const snapshot = await this.snapshot();
      if (this.commands.speechLease(session.id) && snapshot?.sessionId === session.id && snapshot.ready === true && snapshot.voice === 'ready' &&
          snapshot.deadline === session.deadline && typeof snapshot.idleAt === 'number' && Number.isFinite(snapshot.idleAt) &&
          snapshot.idleAt > Date.now() && snapshot.idleAt <= session.deadline) { this.renewActivityTimeout(); return; }
    } catch { /* Fail closed without raw exception data. */ }
    await this.commands.stopped(session.id);
    await this.destroySession(session.id);
  }
  override async onStop(): Promise<void> {
    if (this.ctx.container?.running) return;
    const sessionId = this.imageLease();
    if (!sessionId) return;
    // onStop can run inside startSession's mutation queue when SDK reconciles
    // an old stop event. Queue cleanup rather than awaiting that same queue.
    await this.schedule(1, 'cleanupStoppedImage', { sessionId });
    if (sessionId) { await this.commands.stopped(sessionId); await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(sessionId); }
  }
  async cleanupStoppedImage(payload: { sessionId: string | null }): Promise<void> {
    let reclaimed = false;
    try {
      if (payload.sessionId && !this.imageLease() && this.commandLedger.session()?.id === payload.sessionId && this.commandLedger.session()?.status === 'stopped') {
        await this.destroySession(payload.sessionId); return;
      }
      await this.serialize(async () => {
        if (this.imageLease() !== payload.sessionId || this.ctx.container?.running) return;
        const session = this.commandLedger.session();
        if (!payload.sessionId && session?.status !== 'stopped' && session && commandRuntimeActive(this.env) && session.deadline > Date.now()) return;
        await this.destroy();
        if (this.imageLease() === payload.sessionId && !this.ctx.container?.running) {
          this.setImageLease(null);
          reclaimed = true;
          await this.ctx.storage.sync();
        }
      });
      if (reclaimed && payload.sessionId) {
        await this.commands.stopped(payload.sessionId);
        await this.env.VOICEVOX.getByName('shared-voicevox').stopSession(payload.sessionId);
        this.commandLedger.usage.settle(payload.sessionId, Date.now());
        await this.ctx.storage.sync();
      }
    } catch { await this.schedule(15, 'cleanupStoppedImage', payload); throw new Error('VOICE_CLEANUP_UNAVAILABLE'); }
  }
  override onError(): void { console.warn(JSON.stringify({ event: 'bot_container_unavailable' })); }
  async enqueueInteraction(command: InteractionCommand): Promise<void> { await this.commands.enqueue(command); }
  async runCommandJob(payload: { id: string }): Promise<void> { try { await this.commands.run(payload.id); } catch { console.warn(JSON.stringify({ event: 'discord_command_unavailable' })); } }
  async expireCommandSession(payload: { sessionId: string }): Promise<void> {
    try { await this.commands.expire(payload.sessionId); }
    catch { await this.schedule(15, 'expireCommandSession', payload); throw new Error('VOICE_CLEANUP_UNAVAILABLE'); }
  }
  async stopStoppedSession(payload: { sessionId: string }): Promise<void> {
    if (this.commandLedger.session()?.id !== payload.sessionId || this.commandLedger.session()?.status !== 'stopped') return;
    try { await this.destroySession(payload.sessionId); }
    catch { await this.schedule(15, 'stopStoppedSession', payload); throw new Error('VOICE_CLEANUP_UNAVAILABLE'); }
  }
  async sweepCommandJobs(): Promise<void> {
    await this.commands.sweep();
    await this.serialize(async () => {
      const session = this.commandLedger.session();
      if (session && session.status !== 'stopped' && session.deadline > Date.now() && commandRuntimeActive(this.env) && this.commands.admitted(session)) return;
      if (session) await this.commands.stopped(session.id);
      const owner = this.imageLease();
      // Housekeeping never starts either image. It reclaims expired/unleased
      // resources even if the process exit already cleared container.running.
      await this.destroy();
      if (this.imageLease() === owner) { this.setImageLease(null); await this.ctx.storage.sync(); }
    });
    await this.env.VOICEVOX.getByName('shared-voicevox').reconcileExpiredLease();
  }
  async getSpeechLease(sessionId: string): Promise<VoiceSpeechLease | null> { return this.commands.speechLease(sessionId); }
  async getSpeechModel(sessionId: string, authorId: string): Promise<number | undefined> {
    if (!this.commands.speechLease(sessionId) || authorId !== this.env.DISCORD_OWNER_ID) return undefined;
    return this.ownerModel.get();
  }
  private async modelCommand(command: InteractionCommand, signal: AbortSignal): Promise<string> {
    if (!modelMetadataActive(this.env) || !commandScopeAllowed(command, this.env)) throw new Error('MODEL_SCOPE_MISMATCH');
    signal.throwIfAborted();
    const catalog = await this.env.VOICEVOX.getByName('shared-voicevox').getModelCatalog();
    signal.throwIfAborted();
    return this.ownerModel.command(catalog, command, signal);
  }
  async setupGlobalCommands() {
    // No inherited fetch or lifecycle call; undefined metadata fails closed.
    return runGlobalCommandSetup(this.env, new SqlGlobalSetupLedger(this.ctx.storage), () => this.ctx.container?.running);
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
  if (sessionId ? !commandRuntimeActive(env) : !trialActive(env)) return Response.json({ error: 'VOICE_INACTIVE' }, { status: 503 });
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
    const globalSetupRequested = Boolean(env.DISCORD_GLOBAL_SETUP_ACTION);
    if (globalSetupRequested) {
      // A forgotten/failed setup flag must never suppress lifetime cleanup.
      // The RPC also checks actual runtime state; rejection falls through.
      if (env.BOT_ENABLED === 'false' && env.VOICE_DEADLINE === '') {
        try {
          const receipt = await env.BOT.getByName('discord-singleton').setupGlobalCommands();
          console.log(JSON.stringify({ event: 'discord_global_setup_result', receipt }));
          if (receipt.state === 'complete') return;
        } catch { console.warn(JSON.stringify({ event: 'discord_global_setup_guard_rejected' })); }
      } else console.warn(JSON.stringify({ event: 'discord_global_setup_guard_rejected' }));
    }
    // A private RPC performs setup without inherited Container fetch/start. The
    // RPC independently verifies all guards, including actual container.running.
    if (!globalSetupRequested && String(env.CONFIRM_DISCORD_SETUP) === SETUP_CONFIRMATION) {
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
