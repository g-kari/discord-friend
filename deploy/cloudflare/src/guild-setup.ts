import { createHash } from 'node:crypto';
// Bind setup to the approved nonsecret scope without publishing raw user/channel
// identifiers. IDs stay in Worker settings; changing scope requires code review.
export const APPROVED_SCOPE_FINGERPRINT = '5d238599d1632869b4bf3729344b45875f714f0ab286600a64bf8f267767f6f7';
export const SETUP_CONFIRMATION = 'register-guild-commands-v1';
export const COMMANDS = [
  { type: 1, name: 'join', description: '現在のVCで指定テキストチャンネルの読み上げを開始' },
  { type: 1, name: 'leave', description: 'VCを退出して読み上げを終了' },
  { type: 1, name: 'stop', description: '音声と待ち行列を停止' },
  { type: 1, name: 'voice-status', description: '音声接続と読み上げの状態を表示' },
  { type: 1, name: 'say', description: 'つむぎでテキストを読み上げ', options: [
    { type: 3, name: 'text', description: '読み上げる文章', required: true, max_length: 500 },
  ] },
] as const;

export interface SetupEnv {
  BOT_ENABLED: string;
  VOICE_DEADLINE: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_TEXT_CHANNEL_ID: string;
  DISCORD_OWNER_ID: string;
  CONFIRM_DISCORD_SETUP: string;
  DISCORD_SETUP_OPERATION_ID: string;
  DISCORD_SETUP_DEADLINE: string;
}
export interface SetupReceipt {
  operationId: string;
  applicationId: string;
  guildId: string;
  state: 'pending' | 'complete' | 'failed' | 'uncertain';
  startedAt: string;
  updatedAt: string;
  verifiedNames: string[];
  attemptedName: string | null;
  error: string | null;
}
export interface SetupLedger {
  claim(receipt: SetupReceipt): Promise<{ claimed: boolean; receipt: SetupReceipt }>;
  save(receipt: SetupReceipt): Promise<void>;
}
class SetupError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function scopeFingerprint(env: Pick<SetupEnv, 'DISCORD_APPLICATION_ID' | 'DISCORD_GUILD_ID' | 'DISCORD_TEXT_CHANNEL_ID' | 'DISCORD_OWNER_ID'>): string {
  return createHash('sha256').update([env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID, env.DISCORD_TEXT_CHANNEL_ID, env.DISCORD_OWNER_ID].join(':')).digest('hex');
}
function check(env: SetupEnv, now: number, running: boolean, approvedFingerprint: string): void {
  if (env.CONFIRM_DISCORD_SETUP !== SETUP_CONFIRMATION) throw new SetupError('SETUP_DISABLED');
  if (env.BOT_ENABLED !== 'false' || env.VOICE_DEADLINE !== '' || running) throw new SetupError('BOT_MUST_BE_STOPPED');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.DISCORD_SETUP_OPERATION_ID)) throw new SetupError('INVALID_SETUP_OPERATION');
  const remaining = Date.parse(env.DISCORD_SETUP_DEADLINE) - now;
  if (!(remaining > 0 && remaining <= 10 * 60 * 1000)) throw new SetupError('SETUP_DEADLINE_INACTIVE');
  if (![env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID, env.DISCORD_TEXT_CHANNEL_ID, env.DISCORD_OWNER_ID].every(id => /^\d{17,20}$/.test(id)) ||
      scopeFingerprint(env) !== approvedFingerprint) throw new SetupError('SETUP_TARGET_MISMATCH');
  if (!env.DISCORD_BOT_TOKEN) throw new SetupError('BOT_TOKEN_MISSING');
}
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new SetupError(`DISCORD_HTTP_${response.status}`); }
  if (!response.body) throw new SetupError('INVALID_DISCORD_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 64 * 1024) throw new SetupError('DISCORD_RESPONSE_TOO_LARGE');
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SetupError) throw error;
    if (signal.aborted) throw new SetupError('DISCORD_REQUEST_ABORTED');
    throw new SetupError('INVALID_DISCORD_RESPONSE');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function normalizedOptions(value: unknown): unknown {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  return value.map(option => {
    if (!object(option)) return null;
    // Reject extra behaviors/localizations rather than overwrite them silently.
    const allowed = ['type', 'name', 'description', 'required', 'max_length', 'name_localizations', 'description_localizations'];
    if (Object.keys(option).some(key => !allowed.includes(key)) || option.name_localizations || option.description_localizations) return null;
    return { type: option.type, name: option.name, description: option.description, required: option.required ?? false, max_length: option.max_length ?? null };
  });
}
export function matchesCommand(actual: unknown, desired: typeof COMMANDS[number]): boolean {
  if (!object(actual) || actual.type !== 1 || actual.name !== desired.name || actual.description !== desired.description ||
      actual.default_member_permissions != null || actual.nsfw === true || actual.name_localizations || actual.description_localizations) return false;
  return JSON.stringify(normalizedOptions(actual.options)) === JSON.stringify(normalizedOptions('options' in desired ? desired.options : []));
}

// No Container fetch/start, Gateway client, alarm edits, or public endpoint here.
export async function runGuildSetup(env: SetupEnv, ledger: SetupLedger, running: () => boolean,
  request: typeof fetch = fetch, now: () => number = Date.now,
  approvedFingerprint: string = APPROVED_SCOPE_FINGERPRINT): Promise<SetupReceipt> {
  check(env, now(), running(), approvedFingerprint);
  const initial: SetupReceipt = {
    operationId: env.DISCORD_SETUP_OPERATION_ID, applicationId: env.DISCORD_APPLICATION_ID, guildId: env.DISCORD_GUILD_ID,
    state: 'pending', startedAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(),
    verifiedNames: [], attemptedName: null, error: null,
  };
  const claim = await ledger.claim(initial); // Durable claim is committed before any network I/O.
  if (!claim.claimed) return claim.receipt; // Pending/uncertain never automatically replay.
  const receipt = claim.receipt;
  const overall = AbortSignal.timeout(25_000);
  async function call(path: string, body?: typeof COMMANDS[number]): Promise<unknown> {
    check(env, now(), running(), approvedFingerprint); // Recheck before every request, particularly each write.
    const remaining = Date.parse(env.DISCORD_SETUP_DEADLINE) - now();
    const signal = AbortSignal.any([overall, AbortSignal.timeout(Math.max(1, Math.min(5000, remaining)))]);
    try {
      const response = await request(`https://discord.com/api/v10${path}`, {
        // Workers only implements manual/follow. Inspect 3xx ourselves so the
        // existing Bot credential can never follow a Location to another host.
        method: body ? 'POST' : 'GET', redirect: 'manual', signal,
        headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new SetupError('DISCORD_REDIRECT_REFUSED');
      }
      // A missing command should be created, not overwrite a competing writer.
      // Discord has already applied an upsert when it returns 200, so preserve
      // uncertainty and stop rather than continue or silently call it success.
      if (body && response.status === 200) { await response.body?.cancel(); throw new SetupError('COMMAND_UPSERT_RACE'); }
      return await json(response, signal);
    } catch (error) {
      if (error instanceof SetupError) throw error;
      // Persist only fixed classifications, never adapter messages, URLs,
      // headers, credential contents, response bodies or exception stacks.
      if (signal.aborted) throw new SetupError('DISCORD_REQUEST_ABORTED');
      if (error instanceof TypeError) throw new SetupError('DISCORD_FETCH_REJECTED');
      throw new SetupError('DISCORD_REQUEST_FAILED');
    }
  }
  try {
    const application = await call('/applications/@me');
    if (!object(application) || application.id !== env.DISCORD_APPLICATION_ID) throw new SetupError('APPLICATION_ID_MISMATCH');
    const channel = await call(`/channels/${env.DISCORD_TEXT_CHANNEL_ID}`);
    if (!object(channel) || channel.id !== env.DISCORD_TEXT_CHANNEL_ID || channel.guild_id !== env.DISCORD_GUILD_ID || ![0, 5].includes(Number(channel.type))) throw new SetupError('TEXT_CHANNEL_MISMATCH');
    const path = `/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`;
    const listPath = `${path}?with_localizations=true`;
    const existing = await call(listPath);
    if (!Array.isArray(existing)) throw new SetupError('INVALID_DISCORD_RESPONSE');
    // Preflight all collisions before creating even the first command.
    for (const command of COMMANDS) {
      const collisions = existing.filter(item => object(item) && item.name === command.name && item.type === 1);
      if (collisions.length > 1 || (collisions.length === 1 && !matchesCommand(collisions[0], command))) throw new SetupError('COMMAND_NAME_CONFLICT');
    }
    for (const command of COMMANDS) {
      if (!existing.some(item => matchesCommand(item, command))) {
        // Discord POST is an upsert, not atomic create-if-absent. Recheck just
        // before each write; setup must have exclusive command-writer ownership.
        const latest = await call(listPath);
        if (!Array.isArray(latest)) throw new SetupError('INVALID_DISCORD_RESPONSE');
        const collision = latest.filter(item => object(item) && item.name === command.name && item.type === 1);
        if (collision.length > 1 || (collision.length === 1 && !matchesCommand(collision[0], command))) throw new SetupError('COMMAND_NAME_CONFLICT');
        if (collision.length === 1) {
          receipt.verifiedNames.push(command.name);
          receipt.updatedAt = new Date(now()).toISOString();
          await ledger.save(receipt);
          continue;
        }
        receipt.attemptedName = command.name;
        receipt.updatedAt = new Date(now()).toISOString();
        await ledger.save(receipt); // Persist the attempt before POST; a timeout is uncertain.
        const created = await call(path, command);
        if (!matchesCommand(created, command) || !object(created) || created.application_id !== env.DISCORD_APPLICATION_ID || created.guild_id !== env.DISCORD_GUILD_ID) throw new SetupError('COMMAND_WRITE_UNVERIFIED');
      }
      receipt.verifiedNames.push(command.name);
      receipt.attemptedName = null;
      receipt.updatedAt = new Date(now()).toISOString();
      await ledger.save(receipt);
    }
    const readback = await call(listPath);
    if (!Array.isArray(readback) || !COMMANDS.every(command => readback.some(item => matchesCommand(item, command)))) throw new SetupError('COMMAND_READBACK_FAILED');
    receipt.state = 'complete';
  } catch (error) {
    receipt.state = receipt.attemptedName ? 'uncertain' : 'failed';
    receipt.error = error instanceof SetupError ? error.code : 'SETUP_INTERNAL_ERROR';
  }
  receipt.updatedAt = new Date(now()).toISOString();
  await ledger.save(receipt);
  return receipt;
}
