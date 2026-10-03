import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { GLOBAL_COMMANDS, GLOBAL_INSPECT_ACTION, GLOBAL_REGISTER_ACTION, GLOBAL_RECOVER_MODEL_ACTION,
  GLOBAL_MODEL_RECOVERY_ORIGINAL_ID, globalPrincipalFingerprint, runGlobalCommandSetup,
  type GlobalSetupEnv, type GlobalSetupReceipt } from '../src/global-command-setup.ts';
import { SqlGlobalSetupLedger } from '../src/global-setup-ledger.ts';

const NOW = Date.parse('2026-10-03T19:10:00Z');
const APP = '100000000000000001'; const OWNER = '100000000000000004'; const KEY = 'a'.repeat(64);
const TOKEN = 'synthetic-recovery-secret'; const RECEIVER = 'https://synthetic-recovery.invalid/interactions';
const FIVE = GLOBAL_COMMANDS.slice(0, 5).map(command => command.name); const SIX = GLOBAL_COMMANDS.map(command => command.name);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function env(action = GLOBAL_RECOVER_MODEL_ACTION, operation = 2): GlobalSetupEnv {
  return { BOT_ENABLED: 'false', VOICE_DEADLINE: '', DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_APPLICATION_ID: APP, DISCORD_OWNER_ID: OWNER, DISCORD_HTTP_ENABLED: 'true', DISCORD_PUBLIC_KEY: KEY,
    CONFIRM_DISCORD_SETUP: '', DISCORD_GLOBAL_SETUP_ACTION: action, DISCORD_GLOBAL_SETUP_OPERATION_ID: id(operation),
    DISCORD_GLOBAL_SETUP_DEADLINE: new Date(NOW + 600_000).toISOString(), DISCORD_GLOBAL_SETUP_INSPECTION_ID: id(1),
    DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION: '0', DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION: '0',
    DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT: new Date(NOW).toISOString() };
}
const command = (index: number) => ({ ...structuredClone(GLOBAL_COMMANDS[index]),
  id: String(100000000000000010n + BigInt(index)), version: '100000000000000099', application_id: APP });
async function fixture(count = 5) {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(query: string, ...params: (string | number | null)[]) {
    const statement = db.prepare(query); const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
    return { toArray: () => rows };
  } }, sync: async () => {} };
  const store = { ledger: new SqlGlobalSetupLedger(storage) };
  const commands: Record<string, unknown>[] = Array.from({ length: count }, (_, index) => command(index));
  const application = { id: APP, owner: { id: OWNER }, team: null, verify_key: KEY, interactions_endpoint_url: RECEIVER };
  const calls: { method: string; body: unknown }[] = [];
  const request: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url)); const method = options?.method ?? 'GET';
    assert.equal(parsed.origin, 'https://discord.com'); assert.equal(options?.redirect, 'manual');
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ method, body });
    if (parsed.pathname.endsWith('/@me')) { assert.equal(method, 'GET'); return Response.json(application); }
    assert.equal(parsed.pathname, `/api/v10/applications/${APP}/commands`);
    if (method === 'GET') return Response.json(commands);
    assert.equal(method, 'POST'); assert.deepEqual(body, GLOBAL_COMMANDS[5]);
    const status = commands.some(item => item.name === 'model') ? 200 : 201;
    commands.push(command(5)); return Response.json(command(5), { status });
  };
  const run = (environment = env(), fetcher = request, now = () => NOW, running = () => false, wait?: (ms: number, signal: AbortSignal) => Promise<void>) =>
    runGlobalCommandSetup(environment, store.ledger, running, fetcher, now, globalPrincipalFingerprint(env()), hash(RECEIVER), wait);
  const inspection = await run(env(GLOBAL_INSPECT_ACTION, 1)); assert.equal(inspection.state, 'complete');
  const original: GlobalSetupReceipt = { ...inspection, operationId: GLOBAL_MODEL_RECOVERY_ORIGINAL_ID,
    action: GLOBAL_REGISTER_ACTION, state: 'uncertain', error: 'DISCORD_RATE_LIMITED',
    startedAt: new Date(NOW - 120_000).toISOString(), updatedAt: new Date(NOW - 60_000).toISOString(),
    inspectionId: id(99), observedNames: [], verifiedNames: [...FIVE], createdNames: [...FIVE], attemptedName: 'model', writeAttempted: true };
  await store.ledger.claim(original); calls.length = 0;
  return { db, storage, store, commands, application, calls, request, run, original, inspection, posts: () => calls.filter(call => call.method === 'POST') };
}

test('one missing /model is created once; original and inspection bytes/fingerprints are preserved', async () => {
  const f = await fixture(); const before = JSON.stringify(await f.store.ledger.read(GLOBAL_MODEL_RECOVERY_ORIGINAL_ID));
  const inspection = JSON.stringify(await f.store.ledger.read(id(1)));
  const result = await f.run(); assert.equal(result.state, 'complete'); assert.equal(result.error, null);
  assert.deepEqual(result.createdNames, ['model']); assert.deepEqual(result.verifiedNames, SIX);
  assert.equal(result.recoveryOf, GLOBAL_MODEL_RECOVERY_ORIGINAL_ID); assert.equal(result.originalReceiptFingerprint, hash(before));
  assert.equal(f.posts().length, 1); assert.equal(JSON.stringify(await f.store.ledger.read(GLOBAL_MODEL_RECOVERY_ORIGINAL_ID)), before);
  assert.equal(JSON.stringify(await f.store.ledger.read(id(1))), inspection);
  const count = f.calls.length;
  assert.equal((await f.run(env(GLOBAL_REGISTER_ACTION, 8))).operationId, GLOBAL_MODEL_RECOVERY_ORIGINAL_ID);
  assert.equal(f.calls.length, count); // Ordinary registration stays permanently blocked.
});
test('six matching commands complete entirely read-only', async () => {
  const f = await fixture(6); const result = await f.run(); assert.equal(result.state, 'complete');
  assert.deepEqual(result.createdNames, []); assert.deepEqual(result.verifiedNames, SIX); assert.equal(result.writeAttempted, false); assert.equal(f.posts().length, 0);
});
test('matching /model appearing during immediate recheck completes read-only, but disappearance stops', async () => {
  for (const startingCount of [5, 6]) {
    const f = await fixture(startingCount); let lists = 0;
    const result = await f.run(env(), (url, options) => {
      if (String(url).includes('/commands?') && ++lists === 2) { if (startingCount === 5) f.commands.push(command(5)); else f.commands.pop(); }
      return f.request(url, options);
    });
    assert.equal(result.state, startingCount === 5 ? 'complete' : 'failed'); assert.equal(f.posts().length, 0);
  }
});
test('stale, mismatched, incomplete, write-bearing or pre-original inspections cannot recover', async () => {
  for (const patch of [{ updatedAt: new Date(NOW - 600_001).toISOString() }, { state: 'pending' }, { principalFingerprint: 'wrong' },
    { definitionsFingerprint: 'wrong' }, { applicationVerified: false }, { receiverVerified: false }, { publicKeyVerified: false },
    { writeAttempted: true }, { createdNames: ['model'] }, { observedNames: ['join'], verifiedNames: ['join'] },
    { startedAt: new Date(NOW - 120_000).toISOString() }, { error: 'unexpected' }]) {
    const f = await fixture(); await f.store.ledger.save({ ...f.inspection, ...patch } as GlobalSetupReceipt);
    assert.equal((await f.run()).state, 'failed'); assert.equal(f.calls.length, 0);
  }
});
test('only the reviewed partial-429 original shape is eligible', async () => {
  for (const patch of [{ state: 'pending' }, { error: 'GLOBAL_COMMAND_UPSERT_RACE' }, { attemptedName: 'say' },
    { createdNames: ['join'] }, { verifiedNames: SIX }, { observedNames: ['join'] }, { writeAttempted: false },
    { principalFingerprint: 'other' }, { definitionsFingerprint: 'other' }, { receiverVerified: false }]) {
    const f = await fixture(); await f.store.ledger.save({ ...f.original, ...patch } as GlobalSetupReceipt);
    assert.equal((await f.run()).error, 'MODEL_RECOVERY_ORIGINAL_REQUIRED'); assert.equal(f.calls.length, 0);
  }
});
test('missing baseline command, unrelated command, changed definition and changed identity stop without POST', async () => {
  for (const mode of ['missing', 'unknown', 'definition', 'application', 'owner', 'receiver', 'key']) {
    const f = await fixture();
    if (mode === 'missing') f.commands.pop();
    if (mode === 'unknown') f.commands.push({ ...command(5), name: 'unrelated' });
    if (mode === 'definition') f.commands[0].description = 'changed';
    if (mode === 'application') f.application.id = OWNER;
    if (mode === 'owner') f.application.owner.id = APP;
    if (mode === 'receiver') f.application.interactions_endpoint_url += '/changed';
    if (mode === 'key') f.application.verify_key = 'b'.repeat(64);
    assert.equal((await f.run()).state, 'failed'); assert.equal(f.posts().length, 0);
  }
});
test('simultaneous distinct UUIDs, repeated Cron and reconstructed ledger share one consumed recovery', async () => {
  const f = await fixture();
  const results = await Promise.all([f.run(), f.run(env(GLOBAL_RECOVER_MODEL_ACTION, 3))]);
  assert.ok(results.some(result => result.state === 'complete')); assert.equal(f.posts().length, 1);
  f.store.ledger = new SqlGlobalSetupLedger(f.storage); const count = f.calls.length;
  assert.equal((await f.run(env(GLOBAL_RECOVER_MODEL_ACTION, 4))).operationId, id(2));
  assert.equal(f.calls.length, count); assert.equal(await f.store.ledger.read(id(3)), null); assert.equal(await f.store.ledger.read(id(4)), null);
});
test('pending durable claim survives restart without any request', async () => {
  const f = await fixture(); await f.store.ledger.claim({ ...f.original, operationId: id(2), action: GLOBAL_RECOVER_MODEL_ACTION,
    recoveryOf: GLOBAL_MODEL_RECOVERY_ORIGINAL_ID, state: 'pending', error: null, writeAttempted: false });
  f.store.ledger = new SqlGlobalSetupLedger(f.storage);
  assert.equal((await f.run(env(GLOBAL_RECOVER_MODEL_ACTION, 3))).state, 'pending'); assert.equal(f.calls.length, 0);
});
test('200 race, response loss, bad definition and 429 each consume recovery with no replay', async () => {
  for (const mode of ['race', 'lost', 'definition', '429']) {
    const f = await fixture();
    const request: typeof fetch = async (url, options) => {
      if (options?.method !== 'POST') return f.request(url, options);
      f.calls.push({ method: 'POST', body: JSON.parse(String(options.body)) });
      if (mode === 'lost') throw new Error(TOKEN);
      if (mode === '429') return Response.json({ message: TOKEN, retry_after: 17.5, global: false }, { status: 429,
        headers: { 'retry-after': '20', 'x-ratelimit-reset': String((NOW + 25_000) / 1000), 'x-ratelimit-reset-after': '22', 'x-ratelimit-remaining': '0' } });
      return Response.json({ ...command(5), ...(mode === 'definition' ? { description: 'wrong' } : {}) }, { status: mode === 'race' ? 200 : 201 });
    };
    const result = await f.run(env(), request); assert.equal(result.state, 'uncertain'); assert.equal(result.attemptedName, 'model');
    const count = f.calls.length; f.store.ledger = new SqlGlobalSetupLedger(f.storage);
    assert.equal((await f.run(env(GLOBAL_RECOVER_MODEL_ACTION, 7), request)).operationId, id(2)); assert.equal(f.calls.length, count); assert.equal(f.posts().length, 1);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
    if (mode === '429') { assert.equal(result.notBefore, new Date(NOW + 25_000).toISOString()); assert.equal(result.rateLimits?.[0].bodyRetryAfterSeconds, 17.5); }
  }
});
test('new read-only inspections and recovery honor durable known cooldowns without a request', async () => {
  const f = await fixture(); const notBefore = new Date(NOW + 20_000).toISOString();
  await f.store.ledger.save({ ...f.original, notBefore });
  assert.equal((await f.run()).error, 'DISCORD_RATE_LIMIT_NOT_BEFORE'); assert.equal(f.calls.length, 0);
  assert.equal((await f.run(env(GLOBAL_INSPECT_ACTION, 4))).error, 'DISCORD_RATE_LIMIT_NOT_BEFORE'); assert.equal(f.calls.length, 0);
  assert.equal((await f.run(env(GLOBAL_INSPECT_ACTION, 5), f.request, () => NOW + 20_001)).state, 'complete');
});
test('optional absent headers allow success; malformed consumed timing stops before POST', async () => {
  for (const headers of [{ 'x-ratelimit-reset-after': 'secret' },
    { 'x-ratelimit-remaining': '0' }, { 'retry-after': '-1' }]) {
    const f = await fixture();
    const result = await f.run(env(), async (url, options) => {
      const response = await f.request(url, options); return new Response(response.body, { headers });
    });
    assert.equal(result.error, 'DISCORD_RATE_LIMIT_UNVERIFIED'); assert.equal(f.posts().length, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
  }
});
test('unused unknown rate headers are ignored without persisting their values', async () => {
  const f = await fixture();
  const result = await f.run(env(), async (url, options) => {
    const response = await f.request(url, options);
    return new Response(response.body, { status: response.status, headers: { 'x-ratelimit-mystery': TOKEN, 'x-ratelimit-limit': 'unused' } });
  });
  assert.equal(result.state, 'complete'); assert.equal(f.posts().length, 1); assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});
test('one successful exhausted bucket is durably paced before an unsent verification GET', async () => {
  const f = await fixture(); let current = NOW; const waits: number[] = [];
  const result = await f.run(env(), async (url, options) => {
    const response = await f.request(url, options);
    return new Response(response.body, { status: response.status, headers: options?.method === 'POST' ? {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '3.25' } : {} });
  }, () => current, () => false, async ms => {
    assert.equal((await f.store.ledger.read(id(2)))?.notBefore, new Date(NOW + 3250).toISOString());
    assert.equal(f.posts().length, 1); waits.push(ms); current += ms;
  });
  assert.equal(result.state, 'complete'); assert.deepEqual(waits, [3250]); assert.equal(f.posts().length, 1);
});
test('pacing is bounded and never loops for a second, extended, aborted or oversized cooldown', async () => {
  for (const mode of ['second', 'extended', 'aborted', 'oversized']) {
    const f = await fixture(); let current = NOW; let waits = 0;
    const result = await f.run(env(), async (url, options) => {
      const response = await f.request(url, options);
      return new Response(response.body, { status: response.status, headers: {
        'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': mode === 'oversized' ? '21' : '1' } });
    }, () => current, () => false, async ms => {
      waits++; current += ms;
      if (mode === 'aborted') throw new Error('cancelled');
      if (mode === 'extended') await f.store.ledger.save({ ...f.original, notBefore: new Date(current + 1000).toISOString() });
    });
    assert.equal(result.state, 'failed'); assert.equal(result.error, mode === 'aborted' ? 'DISCORD_REQUEST_ABORTED' : 'DISCORD_RATE_LIMIT_NOT_BEFORE');
    assert.equal(waits, mode === 'oversized' ? 0 : 1); assert.equal(f.posts().length, 0);
  }
});
test('stopped state, capacity, deadline and inspection freshness are rechecked before writing', async () => {
  for (const mode of ['running', 'inspection', 'deadline', 'capacity']) {
    const f = await fixture(); let current = NOW; let running = false; const settings = env();
    const result = await f.run(settings, async (url, options) => {
      const response = await f.request(url, options);
      if (String(url).includes('/commands?')) {
        if (mode === 'running') running = true;
        if (mode === 'deadline') current += 600_001;
        if (mode === 'inspection') { current += 600_001; settings.DISCORD_GLOBAL_SETUP_DEADLINE = new Date(current + 1000).toISOString(); settings.DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT = new Date(current).toISOString(); }
        if (mode === 'capacity') settings.DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION = '1';
      }
      return response;
    }, () => current, () => running);
    assert.equal(result.state, 'failed'); assert.equal(f.posts().length, 0);
  }
});
test('pre-POST durability loss prevents POST and consumes pending recovery after reconstruction', async () => {
  const f = await fixture();
  f.storage.sync = async () => { const saved = await f.store.ledger.read(id(2)); if (saved?.writeAttempted) throw new Error('disk failed'); };
  await assert.rejects(f.run()); assert.equal(f.posts().length, 0);
  f.storage.sync = async () => {}; f.store.ledger = new SqlGlobalSetupLedger(f.storage);
  const result = await f.run(env(GLOBAL_RECOVER_MODEL_ACTION, 8)); assert.equal(result.operationId, id(2)); assert.equal(f.posts().length, 0);
});
test('after pacing, inspection age, stopped state, cap age and deadline are revalidated before the unsent request', async () => {
  for (const mode of ['inspection', 'running', 'capacity', 'deadline']) {
    const f = await fixture(); let current = NOW; let running = false; const settings = env();
    if (mode === 'inspection') {
      await f.store.ledger.save({ ...f.original, startedAt: new Date(NOW - 800_000).toISOString(), updatedAt: new Date(NOW - 700_000).toISOString() });
      await f.store.ledger.save({ ...f.inspection, startedAt: new Date(NOW - 600_000).toISOString(), updatedAt: new Date(NOW - 599_500).toISOString() });
    }
    const result = await f.run(settings, async (url, options) => {
      const response = await f.request(url, options);
      return new Response(response.body, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '1' } });
    }, () => current, () => running, async ms => {
      current += ms;
      if (mode === 'running') running = true;
      if (mode === 'capacity') settings.DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT = new Date(current - 600_001).toISOString();
      if (mode === 'deadline') settings.DISCORD_GLOBAL_SETUP_DEADLINE = new Date(current - 1).toISOString();
    });
    assert.equal(result.state, 'failed'); assert.equal(result.error, {
      inspection: 'INSPECTION_RECEIPT_REQUIRED', running: 'BOT_MUST_BE_STOPPED',
      capacity: 'CAPACITY_ATTESTATION_STALE', deadline: 'GLOBAL_SETUP_DEADLINE_INACTIVE',
    }[mode]);
    assert.equal(f.calls.length, 1); assert.equal(f.posts().length, 0);
  }
});
