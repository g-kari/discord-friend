import { APPROVED_SCOPE_FINGERPRINT, scopeFingerprint } from './guild-setup.ts';
import { completeInteraction, type InteractionCommand, type CommandName } from './interactions.ts';
import { InteractionLedger, openCommand, sealCommand, type VoiceSession } from './interaction-ledger.ts';
import { commandScopeAllowed, installedScope, scopePolicyActive, sameSessionScope, APPROVED_PRINCIPAL, snowflake } from './scope-policy.ts';
import { SESSION_LIMIT_MS } from './usage-ledger.ts';
import { runtimeActive, type RuntimeEnv } from './readiness.ts';

export interface CommandEnv extends RuntimeEnv {
  DISCORD_HTTP_ENABLED: string;
  DISCORD_APPLICATION_ID: string;
  VOICE_IDLE_SECONDS: string;
  VOICE_SESSION_MINUTES: string;
}
export interface ContainerCommand {
  id: string; sessionId: string; applicationId: string; guildId: string;
  channelId: string; userId: string; name: CommandName; text?: string;
}
export interface VoiceSpeechLease { deadline: number; startedAt: number }
export interface CommandResult { content: string; joined: boolean }
export interface CommandRuntime {
  start(session: VoiceSession, signal: AbortSignal): Promise<void>;
  invoke(command: ContainerCommand, signal: AbortSignal): Promise<CommandResult>;
  status(sessionId: string): Promise<string>;
  model?(command: InteractionCommand, signal: AbortSignal): Promise<string>;
  destroy(sessionId: string): Promise<void>;
  scheduleJob(id: string): Promise<void>;
  scheduleExpiry(session: VoiceSession): Promise<void>;
  scheduleSweep(): Promise<void>;
  scheduleStop(sessionId: string): Promise<void>;
}
// Model metadata is independent of voice startup/fees/deadlines. The HTTP
// endpoint and immutable scope stay authorized; the existing secret only seals
// short-lived interaction jobs and is never sent to the model catalog.
export function modelMetadataActive(env: CommandEnv, approved = APPROVED_SCOPE_FINGERPRINT, principal = APPROVED_PRINCIPAL): boolean {
  return env.DISCORD_HTTP_ENABLED === 'true' && Boolean(env.DISCORD_BOT_TOKEN) &&
    scopePolicyActive(env, approved, principal);
}
export function commandRuntimeActive(env: CommandEnv, now: number = Date.now(), approved = APPROVED_SCOPE_FINGERPRINT, principal = APPROVED_PRINCIPAL): boolean {
  const idle = Number(env.VOICE_IDLE_SECONDS), minutes = Number(env.VOICE_SESSION_MINUTES);
  return env.DISCORD_HTTP_ENABLED === 'true' && runtimeActive(env, now) && scopePolicyActive(env, approved, principal) &&
    Number.isInteger(idle) && idle >= 30 && idle <= 600 && Number.isInteger(minutes) &&
    (env.VOICE_USAGE_MODE === 'daily' ? idle === 300 && minutes === SESSION_LIMIT_MS / 60_000 : minutes >= 1 && minutes <= 30);
}

export class SessionCommands {
  private starts = new Map<string, AbortController>();
  private env: CommandEnv;
  private ledger: InteractionLedger;
  private runtime: CommandRuntime;
  private request: typeof fetch;
  private now: () => number;
  private approved: string;
  private principal: string;
  constructor(env: CommandEnv, ledger: InteractionLedger, runtime: CommandRuntime,
    request: typeof fetch = fetch, now: () => number = Date.now, approved = APPROVED_SCOPE_FINGERPRINT, principal = APPROVED_PRINCIPAL) {
    this.env = env; this.ledger = ledger; this.runtime = runtime; this.request = request; this.now = now; this.approved = approved; this.principal = principal;
  }
  private valid(command: InteractionCommand): boolean {
    return (command.name === 'model' ? modelMetadataActive(this.env, this.approved, this.principal) : commandRuntimeActive(this.env, this.now(), this.approved, this.principal)) && commandScopeAllowed(command, this.env);
  }
  async enqueue(command: InteractionCommand): Promise<void> {
    if (!this.valid(command)) { await this.reply(command, '現在は停止中です'); return; }
    const active = this.ledger.session();
    if (installedScope(this.env) && command.name !== 'model' && active && (active.status !== 'stopped' || command.name !== 'join') &&
        !sameSessionScope(active.scope, command)) {
      await this.reply(command, active.status === 'stopped' ? 'このチャンネルでは未接続です' :
        '別のチャンネルで使用中です。使用中のチャンネルで /leave を実行してから呼び出してください'); return;
    }
    if (command.name === 'leave' || command.name === 'stop') {
      const claim = this.ledger.claimControl(command, this.now(), installedScope(this.env));
      if (!claim.accepted) return;
      if (claim.session?.status === 'stopped') for (const controller of this.starts.values()) controller.abort();
      await this.ledger.sync();
      // Stop controls need no persisted token/text and bypass command queue limits.
      let content = command.name === 'leave' ? '退出して停止しました' : '読み上げと待ち行列を停止しました';
      try {
        await this.runtime.scheduleSweep();
        if (claim.session?.status === 'stopped') {
          await this.runtime.scheduleStop(claim.session.id);
          await this.runtime.destroy(claim.session.id);
        } else if (claim.session) {
          content = (await this.runtime.invoke(this.dto(command, claim.session.id), AbortSignal.timeout(5000))).content;
        }
      } catch {
        if (claim.session && this.ledger.session()?.id === claim.session.id) {
          await this.stopped(claim.session.id);
          await this.runtime.scheduleStop(claim.session.id).catch(() => {});
          await this.runtime.destroy(claim.session.id).catch(() => {});
        }
        content = '停止処理を要求しました。接続状態を確認してください';
      }
      await this.reply(command, content);
      return;
    }
    // Establish cleanup before storing any encrypted payload. The 90s decrypt
    // deadline is fail closed; scheduled/Cron housekeeping physically removes it.
    await this.runtime.scheduleSweep();
    const cipher = await sealCommand(command, this.env.DISCORD_BOT_TOKEN);
    const now = this.now();
    const deadline = command.name === 'model' ? now + 90_000 : Math.min(this.env.VOICE_USAGE_MODE === 'daily' ? Number.POSITIVE_INFINITY : Date.parse(this.env.VOICE_DEADLINE), now + Number(this.env.VOICE_SESSION_MINUTES) * 60_000);
    const claim = this.ledger.accept(command, cipher, now, deadline, this.env.VOICE_USAGE_MODE === 'daily', installedScope(this.env));
    await this.ledger.sync();
    if (!claim.accepted) {
      if (claim.reason === 'duplicate' || claim.reason === 'conflict') return;
      await this.reply(command, claim.reason === 'scope' ? '別のチャンネルで使用中です。先にその接続を退出してください' : claim.reason === 'budget' ? '本日の利用枠（合計8時間、UTC 0時更新）を使い切りました' : claim.reason === 'cleanup' ? '前の接続の停止を確認中です。少し待ってください' : claim.reason === 'cancelled' ? '接続を中止しました' : claim.reason === 'rate' ? '操作が多いため、少し待って再試行してください' : '操作を受け付けられません。少し待って再試行してください');
      return;
    }
    // A newer leave/stop cancels a cold start immediately, before its alarm job.
    if (claim.session?.status === 'stopped') for (const controller of this.starts.values()) controller.abort();
    try {
      if (claim.session && command.name === 'join') await this.runtime.scheduleExpiry(claim.session);
      await this.runtime.scheduleJob(command.id); // The durable schedule contains the ID only.
    } catch {
      this.ledger.finish(command.id, 'failed');
      await this.ledger.sync();
      if (claim.session?.controlId === command.id) { await this.stopped(claim.session.id); await this.runtime.destroy(claim.session.id).catch(() => {}); }
      await this.reply(command, '準備を開始できませんでした。もう一度操作してください');
    }
  }
  private async reply(command: InteractionCommand, content: string, signal?: AbortSignal): Promise<boolean> {
    // Progress edits share the existing bounded @original PATCH, but a newer
    // stop/leave can also interrupt their network wait. Final replies are not
    // tied to the cancelled operation so they can still report its outcome.
    const send = this.request; // Native workerd fetch must be invoked without our class as its receiver.
    const request: typeof fetch = signal ? (input, init) => {
      signal.throwIfAborted();
      return send(input, { ...init, signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]) });
    } : send;
    return completeInteraction(command.applicationId, command.token, content, request);
  }
  private current(sessionId: string | null): VoiceSession | null {
    const session = this.ledger.session();
    return session && session.id === sessionId && session.deadline > this.now() ? session : null;
  }
  async expire(sessionId: string): Promise<void> {
    const session = this.ledger.session();
    if (!session || session.id !== sessionId || session.deadline > this.now()) return;
    this.ledger.setSession({ ...session, status: 'stopped' });
    await this.ledger.sync();
    for (const controller of this.starts.values()) controller.abort();
    await this.runtime.destroy(sessionId);
  }
  async stopped(sessionId: string): Promise<void> {
    const session = this.ledger.session();
    if (session?.id === sessionId) { this.ledger.setSession({ ...session, status: 'stopped' }); await this.ledger.sync(); }
  }
  async sweep(): Promise<void> {
    this.ledger.sweep(this.now());
    const session = this.ledger.session();
    if (session && session.deadline <= this.now()) await this.expire(session.id);
    else if (session?.status === 'stopped') await this.runtime.destroy(session.id);
    await this.ledger.sync();
  }
  speechLease(sessionId: string): VoiceSpeechLease | null {
    const session = this.current(sessionId);
    if (!commandRuntimeActive(this.env, this.now(), this.approved, this.principal) || session?.status !== 'ready' || !this.admitted(session)) return null;
    return { deadline: session.deadline, startedAt: this.env.VOICE_USAGE_MODE === 'daily' ? this.ledger.usage.reservation()!.started_at : session.createdAt };
  }
  admitted(session: VoiceSession): boolean {
    if (installedScope(this.env) && (!session.scope || session.scope.applicationId !== this.env.DISCORD_APPLICATION_ID || session.scope.userId !== this.env.DISCORD_OWNER_ID || !snowflake(session.scope.guildId) || !snowflake(session.scope.channelId))) return false;
    return this.env.VOICE_USAGE_MODE !== 'daily' || this.ledger.usage.covers(session.id, session.deadline, this.now());
  }
  private usageStatus(): string {
    return this.env.VOICE_USAGE_MODE === 'daily' ? ` / 本日の未予約枠: ${Math.floor(this.ledger.usage.remaining(this.now()) / 60_000)}分（UTC 0時更新、接続分は先に確保）` : '';
  }
  async run(id: string): Promise<void> {
    const job = this.ledger.take(id, this.now());
    if (!job) return;
    await this.ledger.sync();
    if (job.expiresAt <= this.now()) {
      this.ledger.finish(id, 'cancelled');
      const session = this.ledger.session();
      if (session?.id === job.sessionId && session.controlId === id) {
        await this.stopped(session.id); await this.runtime.destroy(session.id).catch(() => {});
      }
      await this.ledger.sync(); return;
    }
    let command: InteractionCommand;
    try { command = await openCommand(job.cipher, id, this.env.DISCORD_BOT_TOKEN, job.expiresAt, this.now); }
    catch {
      this.ledger.finish(id, 'failed');
      const session = this.ledger.session();
      if (session?.id === job.sessionId && session.controlId === id) {
        await this.stopped(session.id); await this.runtime.destroy(session.id).catch(() => {});
      }
      await this.ledger.sync(); return;
    }
    let content = '処理に失敗しました。もう一度操作してください';
    let outcome: 'complete' | 'failed' | 'cancelled' = 'complete';
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(70_000, job.expiresAt - this.now())))]);
    try {
      if (!this.valid(command) || job.expiresAt <= this.now()) { content = '現在は停止中です'; outcome = 'cancelled'; }
      else {
        let session = this.current(job.sessionId);
        if (installedScope(this.env) && command.name !== 'model' && session && !sameSessionScope(session.scope, command)) {
          this.ledger.finish(id, 'cancelled'); await this.ledger.sync();
          await this.reply(command, 'このチャンネルでは未接続です'); return;
        }
        if (command.name === 'model') {
          content = this.runtime.model ? await this.runtime.model(command, signal) : '声の変更は利用できません';
        } else if (command.name === 'join') {
          if (!session || !this.admitted(session) || session.status === 'stopped' || session.controlId !== command.id) { content = '接続を中止しました'; outcome = 'cancelled'; }
          else {
            this.starts.set(id, controller);
            const activeJoin = (): VoiceSession => {
              signal.throwIfAborted();
              const active = this.current(job.sessionId);
              if (!this.valid(command) || job.expiresAt <= this.now() || !active || !this.admitted(active) || active.status === 'stopped' || active.controlId !== command.id) {
                controller.abort();
                throw new Error('JOIN_CANCELLED');
              }
              return active;
            };
            // Best-effort edits only: neither a rejected PATCH nor a delivery
            // failure retries startup, creates a post, or persists the token.
            await this.reply(command, 'Botを起動しています。接続の準備中です', signal);
            await this.runtime.start(activeJoin(), signal);
            activeJoin();
            await this.reply(command, 'Botに接続しました。ボイスチャンネルへ接続中です', signal);
            const result = await this.runtime.invoke(this.dto(command, activeJoin().id), signal);
            session = activeJoin();
            content = result.content;
            if (result.joined) { this.ledger.setSession({ ...session, status: 'ready' }); await this.ledger.sync(); }
            else { await this.stopped(session.id); await this.runtime.destroy(session.id); }
          }
        } else if (command.name === 'leave' || (command.name === 'stop' && session?.status === 'stopped')) {
          if (session && BigInt(session.controlId) <= BigInt(command.id)) { await this.stopped(session.id); await this.runtime.destroy(session.id); }
          content = command.name === 'leave' ? '退出して停止しました' : '接続準備を中止しました';
        } else if (!session || session.status === 'stopped') content = '現在は未接続です' + (command.name === 'voice-status' ? this.usageStatus() : '');
        else if (session.status === 'starting') content = '接続準備中です。少し待ってください';
        else if (command.name === 'voice-status') content = await this.runtime.status(session.id) + this.usageStatus();
        else if (command.name === 'say' && BigInt(command.id) <= BigInt(session.controlId)) { content = '読み上げを中止しました'; outcome = 'cancelled'; }
        else content = (await this.runtime.invoke(this.dto(command, session.id), signal)).content;
      }
    } catch {
      outcome = signal.aborted ? 'cancelled' : 'failed';
      const session = this.current(job.sessionId);
      // An older failing join must not tear down a newer join/voice session.
      if (session && command.name !== 'model' && (command.name !== 'join' || session.controlId === command.id)) {
        await this.stopped(session.id);
        await this.runtime.destroy(session.id).catch(() => {});
      }
      content = signal.aborted ? '処理を中止しました' : '接続または処理に失敗しました。もう一度操作してください';
    } finally { this.starts.delete(id); }
    const replied = await this.reply(command, content);
    this.ledger.finish(id, replied ? outcome : 'reply-failed');
    await this.ledger.sync();
  }
  private dto(command: InteractionCommand, sessionId: string): ContainerCommand {
    return { id: command.id, sessionId, applicationId: command.applicationId, guildId: command.guildId,
      channelId: command.channelId, userId: command.userId, name: command.name, ...(command.text === undefined ? {} : { text: command.text }) };
  }
}
