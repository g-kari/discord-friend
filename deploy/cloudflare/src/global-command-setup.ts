import { createHash } from 'node:crypto';
import { rateLimitEvidence, type GlobalRateLimitEvidence } from './global-setup-rate-limit.ts';

// Approved application + owner, without publishing either identifier. The RPC
// exposes no way to replace this pin or the retained receiver pin.
export const APPROVED_GLOBAL_PRINCIPAL_FINGERPRINT = '6a7deb114bddfa37839427393cee170500eef10b8100579835edb9b5174eb01a';
export const RETAINED_RECEIVER_FINGERPRINT = 'e2e1b96ea4f564a3e3f261236f03290e78dc09feea8818cd6588f390f624139c';
export const GLOBAL_INSPECT_ACTION = 'inspect-global-commands-v1';
export const GLOBAL_REGISTER_ACTION = 'register-global-commands-v1';
export const GLOBAL_RECOVER_MODEL_ACTION = 'recover-global-model-v1';
// This reviewed recovery is scoped to one incident, not a general reset API.
export const GLOBAL_MODEL_RECOVERY_ORIGINAL_ID = '38efc651-389a-4575-83aa-20a921c7a0cc';
export const GLOBAL_COMMANDS = [
  { type: 1, name: 'join', description: '現在のVCでこのテキストチャンネルの読み上げを開始', integration_types: [0], contexts: [0] },
  { type: 1, name: 'leave', description: 'VCを退出して読み上げを終了', integration_types: [0], contexts: [0] },
  { type: 1, name: 'stop', description: '音声と待ち行列を停止', integration_types: [0], contexts: [0] },
  { type: 1, name: 'voice-status', description: '音声接続と読み上げの状態を表示', integration_types: [0], contexts: [0] },
  { type: 1, name: 'say', description: '選択した声でテキストを読み上げ', integration_types: [0], contexts: [0], options: [
    { type: 3, name: 'text', description: '読み上げる文章', required: true, max_length: 500 },
  ] },
  { type: 1, name: 'model', description: 'VOICEVOXの声を一覧表示・自分の読み上げの声を変更', integration_types: [0], contexts: [0], options: [
    { type: 4, name: 'id', description: '一覧にある声のID（自分の読み上げだけ変更）', required: false, min_value: 0 },
    { type: 4, name: 'page', description: '保存済みの声一覧のページ番号', required: false, min_value: 1 },
  ] },
] as const;
type GlobalCommand = typeof GLOBAL_COMMANDS[number];
type Action = typeof GLOBAL_INSPECT_ACTION | typeof GLOBAL_REGISTER_ACTION | typeof GLOBAL_RECOVER_MODEL_ACTION;
export interface GlobalSetupEnv {
  BOT_ENABLED: string; VOICE_DEADLINE: string; DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string; DISCORD_OWNER_ID: string;
  DISCORD_HTTP_ENABLED: string; DISCORD_PUBLIC_KEY: string; CONFIRM_DISCORD_SETUP: string;
  DISCORD_GLOBAL_SETUP_ACTION: string; DISCORD_GLOBAL_SETUP_OPERATION_ID: string; DISCORD_GLOBAL_SETUP_DEADLINE: string;
  DISCORD_GLOBAL_SETUP_INSPECTION_ID: string;
  // Operator attestations ONLY: Workers cannot observe platform app capacity.
  // Activation requires an independent authenticated read of both real caps.
  DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION: string; DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION: string;
  DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT: string;
}
export interface GlobalSetupReceipt {
  operationId: string; action: Action; state: 'pending' | 'complete' | 'failed' | 'uncertain';
  startedAt: string; updatedAt: string; error: string | null;
  principalFingerprint: string; definitionsFingerprint: string; inspectionId: string | null;
  applicationVerified: boolean; receiverVerified: boolean; publicKeyVerified: boolean;
  observedNames: string[]; verifiedNames: string[]; createdNames: string[]; attemptedName: string | null;
  writeAttempted: boolean;
  recoveryOf?: string; originalReceiptFingerprint?: string;
  rateLimits?: GlobalRateLimitEvidence[]; notBefore?: string;
}
export interface GlobalSetupLedger {
  claim(receipt: GlobalSetupReceipt): Promise<{ claimed: boolean; receipt: GlobalSetupReceipt }>;
  read(operationId: string): Promise<GlobalSetupReceipt | null>;
  readNotBefore(): Promise<string | null>;
  save(receipt: GlobalSetupReceipt): Promise<void>;
}
class GlobalSetupError extends Error {}
const fail = (code: string): never => { throw new GlobalSetupError(code); };
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{17,20}$/.test(v);
const uuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const key = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);
const digest = (v: string): string => createHash('sha256').update(v).digest('hex');
const DEFINITIONS_FINGERPRINT = digest(JSON.stringify(GLOBAL_COMMANDS));
export function globalPrincipalFingerprint(env: Pick<GlobalSetupEnv, 'DISCORD_APPLICATION_ID' | 'DISCORD_OWNER_ID'>): string {
  return digest(`${env.DISCORD_APPLICATION_ID}:${env.DISCORD_OWNER_ID}`);
}
function check(env: GlobalSetupEnv, now: number, running: boolean | undefined, pin: string): Action {
  const action = env.DISCORD_GLOBAL_SETUP_ACTION;
  if (action !== GLOBAL_INSPECT_ACTION && action !== GLOBAL_REGISTER_ACTION && action !== GLOBAL_RECOVER_MODEL_ACTION) fail('GLOBAL_SETUP_DISABLED');
  if (env.BOT_ENABLED !== 'false' || env.VOICE_DEADLINE !== '' || running !== false) fail('BOT_MUST_BE_STOPPED');
  if (env.CONFIRM_DISCORD_SETUP !== '') fail('GUILD_SETUP_MUST_BE_DISABLED');
  if (env.DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION !== '0' || env.DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION !== '0') fail('ZERO_CAPACITY_ATTESTATION_REQUIRED');
  const checkedAge = now - Date.parse(env.DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT);
  if (!(checkedAge >= 0 && checkedAge <= 10 * 60_000)) fail('CAPACITY_ATTESTATION_STALE');
  if (!uuid(env.DISCORD_GLOBAL_SETUP_OPERATION_ID)) fail('INVALID_GLOBAL_SETUP_OPERATION');
  const remaining = Date.parse(env.DISCORD_GLOBAL_SETUP_DEADLINE) - now;
  if (!(remaining > 0 && remaining <= 10 * 60_000)) fail('GLOBAL_SETUP_DEADLINE_INACTIVE');
  if (![env.DISCORD_APPLICATION_ID, env.DISCORD_OWNER_ID].every(snowflake) || globalPrincipalFingerprint(env) !== pin) fail('GLOBAL_PRINCIPAL_MISMATCH');
  if (env.DISCORD_HTTP_ENABLED !== 'true' || !key(env.DISCORD_PUBLIC_KEY)) fail('HTTP_RECEIVER_MUST_BE_RETAINED');
  if (!env.DISCORD_BOT_TOKEN) fail('BOT_TOKEN_MISSING');
  if (action !== GLOBAL_INSPECT_ACTION && (!uuid(env.DISCORD_GLOBAL_SETUP_INSPECTION_ID) ||
      env.DISCORD_GLOBAL_SETUP_INSPECTION_ID.toLowerCase() === env.DISCORD_GLOBAL_SETUP_OPERATION_ID.toLowerCase())) fail('INSPECTION_RECEIPT_REQUIRED');
  return action as Action;
}
function normalizedOptions(value: unknown): unknown {
  if (value == null) return [];
  if (!Array.isArray(value)) return null;
  return value.map(option => {
    if (!object(option)) return null;
    const allowed = ['type', 'name', 'description', 'required', 'max_length', 'min_value', 'max_value', 'name_localizations', 'description_localizations'];
    if (Object.keys(option).some(field => !allowed.includes(field)) || option.name_localizations != null || option.description_localizations != null) return null;
    return { type: option.type, name: option.name, description: option.description, required: option.required ?? false,
      max_length: option.max_length ?? null, min_value: option.min_value ?? null, max_value: option.max_value ?? null };
  });
}
export function matchesGlobalCommand(actual: unknown, desired: GlobalCommand, applicationId: string): boolean {
  if (!object(actual)) return false;
  const allowed = ['id', 'version', 'application_id', 'guild_id', 'type', 'name', 'description', 'options',
    'name_localizations', 'description_localizations', 'default_member_permissions', 'default_permission',
    'dm_permission', 'nsfw', 'integration_types', 'contexts'];
  if (Object.keys(actual).some(field => !allowed.includes(field)) || !snowflake(actual.id) || !snowflake(actual.version) ||
      actual.application_id !== applicationId || actual.guild_id != null || actual.type !== 1 || actual.name !== desired.name ||
      actual.description !== desired.description || actual.name_localizations != null || actual.description_localizations != null ||
      actual.default_member_permissions != null || (actual.default_permission != null && actual.default_permission !== true) ||
      (actual.nsfw !== undefined && actual.nsfw !== false) || (actual.dm_permission !== undefined && typeof actual.dm_permission !== 'boolean') ||
      JSON.stringify(actual.integration_types) !== '[0]' || JSON.stringify(actual.contexts) !== '[0]') return false;
  // Discord's deprecated dm_permission may remain a legacy boolean. The exact
  // authoritative contexts:[0] requirement always excludes DMs/private contexts.
  return JSON.stringify(normalizedOptions(actual.options)) === JSON.stringify(normalizedOptions('options' in desired ? desired.options : []));
}
function knownCommands(value: unknown, applicationId: string): string[] {
  if (!Array.isArray(value)) fail('INVALID_DISCORD_RESPONSE');
  const commands = value as unknown[];
  const seenNames = new Set<string>(); const seenIds = new Set<string>();
  for (const item of commands) {
    if (!object(item)) fail('INVALID_DISCORD_RESPONSE');
    const candidate = item as Record<string, unknown>;
    const desired = GLOBAL_COMMANDS.find(command => command.name === candidate.name);
    if (!desired) fail('UNKNOWN_GLOBAL_COMMAND');
    if (!matchesGlobalCommand(candidate, desired!, applicationId) || seenNames.has(desired!.name) || seenIds.has(String(candidate.id))) fail('GLOBAL_COMMAND_CONFLICT');
    seenNames.add(desired!.name); seenIds.add(String(candidate.id));
  }
  return GLOBAL_COMMANDS.filter(command => seenNames.has(command.name)).map(command => command.name);
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) fail('INVALID_DISCORD_RESPONSE');
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) fail('DISCORD_RESPONSE_TOO_LARGE');
      chunks.push(next.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof GlobalSetupError) throw error;
    fail(signal.aborted ? 'DISCORD_REQUEST_ABORTED' : 'INVALID_DISCORD_RESPONSE');
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

// Private, one-shot Cron/RPC only. No SDK fetch/start, TTS, Gateway, interaction
// tokens, public endpoint, new schedule, guild API writes, bulk PUT or deletes.
export async function runGlobalCommandSetup(env: GlobalSetupEnv, ledger: GlobalSetupLedger, running: () => boolean | undefined,
  request: typeof fetch = fetch, now: () => number = Date.now,
  principalPin = APPROVED_GLOBAL_PRINCIPAL_FINGERPRINT, receiverPin = RETAINED_RECEIVER_FINGERPRINT,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = pause): Promise<GlobalSetupReceipt> {
  const action = check(env, now(), running(), principalPin);
  const initial: GlobalSetupReceipt = {
    operationId: env.DISCORD_GLOBAL_SETUP_OPERATION_ID.toLowerCase(), action, state: 'pending',
    startedAt: new Date(now()).toISOString(), updatedAt: new Date(now()).toISOString(), error: null,
    principalFingerprint: principalPin, definitionsFingerprint: DEFINITIONS_FINGERPRINT,
    inspectionId: action !== GLOBAL_INSPECT_ACTION ? env.DISCORD_GLOBAL_SETUP_INSPECTION_ID.toLowerCase() : null,
    applicationVerified: false, receiverVerified: false, publicKeyVerified: false,
    observedNames: [], verifiedNames: [], createdNames: [], attemptedName: null, writeAttempted: false,
    ...(action === GLOBAL_RECOVER_MODEL_ACTION ? { recoveryOf: GLOBAL_MODEL_RECOVERY_ORIGINAL_ID } : {}),
  };
  const claim = await ledger.claim(initial); // Durable sync before all network I/O.
  if (claim.receipt.action !== action || claim.receipt.principalFingerprint !== principalPin ||
      claim.receipt.definitionsFingerprint !== DEFINITIONS_FINGERPRINT) fail('GLOBAL_SETUP_RECEIPT_MISMATCH');
  if (!claim.claimed) return claim.receipt; // No replay; even pending survives reconstruction.
  const receipt = claim.receipt; const overall = AbortSignal.timeout(25_000);
  const overallDeadline = now() + 25_000; let paced = false;
  let inspection: GlobalSetupReceipt | null = null;
  const path = `/applications/${env.DISCORD_APPLICATION_ID}/commands`;
  const listPath = `${path}?with_localizations=true`;
  async function save(): Promise<void> { receipt.updatedAt = new Date(now()).toISOString(); await ledger.save(receipt); }
  function guard(): void {
    check(env, now(), running(), principalPin);
    if (action === GLOBAL_RECOVER_MODEL_ACTION) {
      const inspectionAge = now() - Date.parse(inspection?.updatedAt ?? '');
      if (!(inspectionAge >= 0 && inspectionAge <= 10 * 60_000)) fail('INSPECTION_RECEIPT_REQUIRED');
    }
    overall.throwIfAborted();
  }
  async function call(target: string, body?: GlobalCommand): Promise<unknown> {
    guard();
    let notBefore = await ledger.readNotBefore();
    if (notBefore && now() < Date.parse(notBefore)) {
      const delay = Math.ceil(Date.parse(notBefore) - now());
      // Pace one UNSENT request, never retry a response. Reserve a full request
      // budget and fail closed if timing changes or another pause is needed.
      const budget = Math.min(overallDeadline, Date.parse(env.DISCORD_GLOBAL_SETUP_DEADLINE)) - now();
      if (paced || delay + 5000 >= budget) fail('DISCORD_RATE_LIMIT_NOT_BEFORE');
      paced = true;
      try { await wait(delay, overall); } catch { fail('DISCORD_REQUEST_ABORTED'); }
      guard();
      notBefore = await ledger.readNotBefore();
      if (notBefore && now() < Date.parse(notBefore)) fail('DISCORD_RATE_LIMIT_NOT_BEFORE');
    }
    guard();
    const signal = AbortSignal.any([overall, AbortSignal.timeout(Math.max(1, Math.min(5000, Date.parse(env.DISCORD_GLOBAL_SETUP_DEADLINE) - now())))]);
    try {
      const response = await request(`https://discord.com/api/v10${target}`, {
        method: body ? 'POST' : 'GET', redirect: 'manual', signal,
        headers: { authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // On 429, parse a bounded body only for its retry timing; discard everything else.
      let rateBody: unknown = null;
      if (response.status === 429) { try { rateBody = await readJson(response, signal); } catch { /* Headers still provide safe evidence. */ } }
      const evidence = rateLimitEvidence(response, rateBody, now(), target === '/applications/@me' ? 'application' : 'commands', body ? 'POST' : 'GET');
      if (evidence) {
        (receipt.rateLimits ??= []).push(evidence);
        if (evidence.notBefore && (!receipt.notBefore || Date.parse(evidence.notBefore) > Date.parse(receipt.notBefore))) receipt.notBefore = evidence.notBefore;
        await save(); // Make known cooldowns durable before any subsequent request.
      }
      if (response.status === 429) fail('DISCORD_RATE_LIMITED');
      if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); fail('DISCORD_REDIRECT_REFUSED'); }
      if (body && response.status === 200) { await response.body?.cancel(); fail('GLOBAL_COMMAND_UPSERT_RACE'); }
      if (response.status !== (body ? 201 : 200)) { await response.body?.cancel(); fail('DISCORD_UNEXPECTED_STATUS'); }
      if (evidence?.invalid) { await response.body?.cancel(); fail('DISCORD_RATE_LIMIT_UNVERIFIED'); }
      const value = await readJson(response, signal);
      guard();
      return value;
    } catch (error) {
      if (error instanceof GlobalSetupError) throw error;
      fail(signal.aborted ? 'DISCORD_REQUEST_ABORTED' : 'DISCORD_REQUEST_FAILED');
    }
  }
  async function verifyApplication(): Promise<void> {
    const value = await call('/applications/@me');
    if (!object(value) || value.id !== env.DISCORD_APPLICATION_ID || !object(value.owner) ||
        value.owner.id !== env.DISCORD_OWNER_ID || !Object.hasOwn(value, 'team') || value.team !== null) fail('APPLICATION_OWNER_MISMATCH');
    const app = value as Record<string, unknown>;
    receipt.applicationVerified = true;
    if (typeof app.interactions_endpoint_url !== 'string' || digest(app.interactions_endpoint_url) !== receiverPin) fail('RETAINED_RECEIVER_MISMATCH');
    receipt.receiverVerified = true;
    if (!key(app.verify_key) || app.verify_key.toLowerCase() !== env.DISCORD_PUBLIC_KEY.toLowerCase()) fail('APPLICATION_PUBLIC_KEY_MISMATCH');
    receipt.publicKeyVerified = true;
  }
  try {
    if (action !== GLOBAL_INSPECT_ACTION) {
      inspection = await ledger.read(receipt.inspectionId!);
      const age = now() - Date.parse(inspection?.updatedAt ?? '');
      if (!inspection || inspection.action !== GLOBAL_INSPECT_ACTION || inspection.state !== 'complete' ||
          inspection.principalFingerprint !== principalPin || inspection.definitionsFingerprint !== DEFINITIONS_FINGERPRINT ||
          !inspection.applicationVerified || !inspection.receiverVerified || !inspection.publicKeyVerified ||
          !(age >= 0 && age <= 10 * 60_000)) fail('INSPECTION_RECEIPT_REQUIRED');
    }
    const five = GLOBAL_COMMANDS.filter(command => command.name !== 'model').map(command => command.name);
    const six = GLOBAL_COMMANDS.map(command => command.name);
    const exact = (actual: string[], expected: string[]) => JSON.stringify(actual) === JSON.stringify(expected);
    const recoveryNames = (names: string[]) => exact(names, five) || exact(names, six);
    if (action === GLOBAL_RECOVER_MODEL_ACTION) {
      const original = await ledger.read(GLOBAL_MODEL_RECOVERY_ORIGINAL_ID);
      if (!original || original.operationId !== GLOBAL_MODEL_RECOVERY_ORIGINAL_ID || original.action !== GLOBAL_REGISTER_ACTION ||
          original.state !== 'uncertain' || original.error !== 'DISCORD_RATE_LIMITED' || !original.writeAttempted || original.attemptedName !== 'model' ||
          original.principalFingerprint !== principalPin || original.definitionsFingerprint !== DEFINITIONS_FINGERPRINT ||
          !original.applicationVerified || !original.receiverVerified || !original.publicKeyVerified ||
          !exact(original.observedNames, []) || !exact(original.createdNames, five) || !exact(original.verifiedNames, five)) fail('MODEL_RECOVERY_ORIGINAL_REQUIRED');
      // The original receipt is never saved or changed. Record its exact snapshot hash.
      receipt.originalReceiptFingerprint = digest(JSON.stringify(original));
      if (!inspection || inspection.error !== null || inspection.writeAttempted || inspection.createdNames.length !== 0 || inspection.attemptedName !== null ||
          !recoveryNames(inspection.observedNames) || !exact(inspection.observedNames, inspection.verifiedNames) ||
          !(Date.parse(inspection.startedAt) > Date.parse(original!.updatedAt))) fail('MODEL_RECOVERY_INSPECTION_REQUIRED');
      await save();
    }
    await verifyApplication();
    receipt.observedNames = knownCommands(await call(listPath), env.DISCORD_APPLICATION_ID);
    await save();
    if (action === GLOBAL_RECOVER_MODEL_ACTION) {
      if (!recoveryNames(receipt.observedNames) || !exact(receipt.observedNames, inspection!.observedNames)) fail('INSPECTION_STATE_CHANGED');
      const latest = knownCommands(await call(listPath), env.DISCORD_APPLICATION_ID);
      if (!recoveryNames(latest)) fail('MODEL_RECOVERY_STATE_CHANGED');
      // If /model appeared with exactly the approved definition, finish read-only.
      // Losing an already inspected /model is drift and must not trigger recreation.
      if (receipt.observedNames.includes('model') && !latest.includes('model')) fail('MODEL_RECOVERY_STATE_CHANGED');
      if (!latest.includes('model')) {
        const model = GLOBAL_COMMANDS.find(command => command.name === 'model')!;
        receipt.attemptedName = 'model'; receipt.writeAttempted = true;
        await save();
        const created = await call(path, model);
        if (!matchesGlobalCommand(created, model, env.DISCORD_APPLICATION_ID)) fail('GLOBAL_COMMAND_WRITE_UNVERIFIED');
        receipt.createdNames = ['model']; receipt.attemptedName = null;
        await save();
      }
      await verifyApplication();
      receipt.verifiedNames = knownCommands(await call(listPath), env.DISCORD_APPLICATION_ID);
      if (!exact(receipt.verifiedNames, six)) fail('GLOBAL_COMMAND_READBACK_FAILED');
    } else if (action === GLOBAL_REGISTER_ACTION) {
      if (JSON.stringify(receipt.observedNames) !== JSON.stringify(inspection!.observedNames)) fail('INSPECTION_STATE_CHANGED');
      for (const command of GLOBAL_COMMANDS) {
        // Full-list validation immediately before each possible upsert also stops
        // on unrelated/unknown additions rather than overwrite anyone's work.
        const latest = knownCommands(await call(listPath), env.DISCORD_APPLICATION_ID);
        if (!latest.includes(command.name)) {
          receipt.attemptedName = command.name; receipt.writeAttempted = true;
          await save(); // Persist uncertainty BEFORE POST. Never retry any POST.
          const created = await call(path, command);
          if (!matchesGlobalCommand(created, command, env.DISCORD_APPLICATION_ID)) fail('GLOBAL_COMMAND_WRITE_UNVERIFIED');
          receipt.createdNames.push(command.name);
        }
        receipt.verifiedNames.push(command.name); receipt.attemptedName = null;
        await save();
      }
      await verifyApplication();
      const readback = knownCommands(await call(listPath), env.DISCORD_APPLICATION_ID);
      if (readback.length !== GLOBAL_COMMANDS.length) fail('GLOBAL_COMMAND_READBACK_FAILED');
      receipt.verifiedNames = readback;
    } else receipt.verifiedNames = [...receipt.observedNames];
    receipt.state = 'complete';
  } catch (error) {
    // Any failure after a write attempt, including partial success/readback or
    // persistence loss, requires human reconciliation. No new UUID bypasses it.
    receipt.state = receipt.writeAttempted ? 'uncertain' : 'failed';
    receipt.error = error instanceof GlobalSetupError ? error.message : 'GLOBAL_SETUP_INTERNAL_ERROR';
  }
  await save();
  return receipt;
}
