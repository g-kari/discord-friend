import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { COMMANDS, SETUP_CONFIRMATION, runGuildSetup as runWithApprovedScope, matchesCommand, scopeFingerprint } from '../src/guild-setup.ts';
import type { SetupEnv } from '../src/guild-setup.ts';
import { SqlSetupLedger, saveReadiness } from '../src/setup-ledger.ts';

const NOW = Date.parse('2026-10-02T12:00:00Z');
// Wholly synthetic fixture IDs. The deployed RPC uses its reviewed default
// fingerprint and exposes no argument with which a caller can replace it.
const SETUP_TARGET = { applicationId: '100000000000000001', guildId: '100000000000000002', textChannelId: '100000000000000003', ownerId: '100000000000000004' };
function runGuildSetup(...args: Parameters<typeof runWithApprovedScope>) {
  args[5] = scopeFingerprint(environment());
  return runWithApprovedScope(...args);
}
function environment(): SetupEnv {
  return { BOT_ENABLED: 'false', VOICE_DEADLINE: '', DISCORD_BOT_TOKEN: 'synthetic-test-secret',
    DISCORD_APPLICATION_ID: SETUP_TARGET.applicationId, DISCORD_GUILD_ID: SETUP_TARGET.guildId,
    DISCORD_TEXT_CHANNEL_ID: SETUP_TARGET.textChannelId, DISCORD_OWNER_ID: SETUP_TARGET.ownerId,
    CONFIRM_DISCORD_SETUP: SETUP_CONFIRMATION, DISCORD_SETUP_OPERATION_ID: '4f267a00-71ce-4a70-9b85-2b4fbc096a6e',
    DISCORD_SETUP_DEADLINE: new Date(NOW + 10 * 60 * 1000).toISOString() };
}
function storage() {
  const db = new DatabaseSync(':memory:');
  let syncs = 0;
  const value = {
    sql: { exec(query: string, ...params: (string | number | null)[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...params) : (stmt.run(...params), []);
      return { toArray: () => rows };
    } },
    sync: async () => { syncs++; },
  };
  return { value, db, syncs: () => syncs, ledger: new SqlSetupLedger(value) };
}
function discord(initial: unknown[] = []) {
  const existing = structuredClone(initial);
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    const method = options?.method ?? 'GET';
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path, method, body });
    assert.equal(options?.redirect, 'manual'); assert.ok(options?.signal);
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bot synthetic-test-secret');
    if (path === '/api/v10/applications/@me') return Response.json({ id: SETUP_TARGET.applicationId, private_field: 'discard-me' });
    if (path === `/api/v10/channels/${SETUP_TARGET.textChannelId}`) return Response.json({ id: SETUP_TARGET.textChannelId, guild_id: SETUP_TARGET.guildId, type: 0 });
    assert.equal(path, `/api/v10/applications/${SETUP_TARGET.applicationId}/guilds/${SETUP_TARGET.guildId}/commands`);
    if (method === 'POST') {
      assert.ok(COMMANDS.some(command => command.name === body.name));
      const created = { ...body, id: `10000000000000000${existing.length}`, application_id: SETUP_TARGET.applicationId, guild_id: SETUP_TARGET.guildId };
      const position = existing.findIndex(item => typeof item === 'object' && item !== null && (item as { name?: string }).name === body.name && (item as { type?: number }).type === body.type);
      if (position === -1) existing.push(created); else existing[position] = created;
      return Response.json(created, { status: position === -1 ? 201 : 200 });
    }
    assert.equal(method, 'GET'); assert.equal(new URL(String(url)).searchParams.get('with_localizations'), 'true');
    return Response.json(existing);
  };
  return { request, calls, existing };
}

test('creates exactly five known guild commands, preserves unrelated commands, and persists a secret-free receipt', async () => {
  const store = storage(); const network = discord([{ type: 1, name: 'unrelated', description: 'Leave this alone' }]);
  const receipt = await runGuildSetup(environment(), store.ledger, () => false, network.request, () => NOW);
  assert.equal(receipt.state, 'complete');
  assert.deepEqual(receipt.verifiedNames, COMMANDS.map(command => command.name));
  assert.deepEqual(network.calls.filter(call => call.method === 'POST').map(call => (call.body as { name: string }).name), COMMANDS.map(command => command.name));
  assert.equal(network.existing.length, 6); assert.ok(store.syncs() >= 12);
  assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM voice_setup_receipts').all()), /synthetic-test-secret|discard-me/);
});
test('matching existing commands are verified without POST', async () => {
  const network = discord([...COMMANDS]);
  assert.equal((await runGuildSetup(environment(), storage().ledger, () => false, network.request, () => NOW)).state, 'complete');
  assert.equal(network.calls.filter(call => call.method === 'POST').length, 0);
});
test('a same-name changed command aborts all writes before the first POST', async () => {
  const network = discord([{ ...COMMANDS[4], description: 'Other behavior' }]);
  const result = await runGuildSetup(environment(), storage().ledger, () => false, network.request, () => NOW);
  assert.equal(result.error, 'COMMAND_NAME_CONFLICT'); assert.equal(network.calls.filter(call => call.method === 'POST').length, 0);
});
test('context-menu commands with matching names remain untouched', async () => {
  const network = discord([{ type: 2, name: 'join' }]);
  assert.equal((await runGuildSetup(environment(), storage().ledger, () => false, network.request, () => NOW)).state, 'complete');
  assert.ok(network.existing.some(command => (command as { type: number }).type === 2));
});
test('permissions, localizations, and extra option behaviors are treated as conflicts', () => {
  assert.equal(matchesCommand({ ...COMMANDS[0], default_member_permissions: '0' }, COMMANDS[0]), false);
  assert.equal(matchesCommand({ ...COMMANDS[0], name_localizations: { ja: '別名' } }, COMMANDS[0]), false);
  assert.equal(matchesCommand({ ...COMMANDS[4], options: [{ ...COMMANDS[4].options[0], autocomplete: true }] }, COMMANDS[4]), false);
});
for (const [field, value, code] of [
  ['CONFIRM_DISCORD_SETUP', '', 'SETUP_DISABLED'], ['BOT_ENABLED', 'true', 'BOT_MUST_BE_STOPPED'],
  ['VOICE_DEADLINE', new Date(NOW + 60_000).toISOString(), 'BOT_MUST_BE_STOPPED'],
  ['DISCORD_SETUP_OPERATION_ID', 'invalid', 'INVALID_SETUP_OPERATION'],
  ['DISCORD_SETUP_DEADLINE', '', 'SETUP_DEADLINE_INACTIVE'],
  ['DISCORD_SETUP_DEADLINE', new Date(NOW).toISOString(), 'SETUP_DEADLINE_INACTIVE'],
  ['DISCORD_SETUP_DEADLINE', new Date(NOW + 600_001).toISOString(), 'SETUP_DEADLINE_INACTIVE'],
  ['DISCORD_APPLICATION_ID', '111111111111111111', 'SETUP_TARGET_MISMATCH'],
  ['DISCORD_GUILD_ID', '111111111111111111', 'SETUP_TARGET_MISMATCH'],
  ['DISCORD_OWNER_ID', '111111111111111111', 'SETUP_TARGET_MISMATCH'],
  ['DISCORD_TEXT_CHANNEL_ID', '111111111111111111', 'SETUP_TARGET_MISMATCH'],
  ['DISCORD_BOT_TOKEN', '', 'BOT_TOKEN_MISSING'],
] as const) {
  test(`${field}=${value || '(empty)'} prevents all Discord requests`, async () => {
    const env = environment(); env[field] = value; let requested = false;
    await assert.rejects(runGuildSetup(env, storage().ledger, () => false, async () => { requested = true; throw new Error('Unexpected fetch'); }, () => NOW), { message: code });
    assert.equal(requested, false);
  });
}
test('a running VM prevents setup even when the Worker flag is false', async () => {
  await assert.rejects(runGuildSetup(environment(), storage().ledger, () => true, async () => { throw new Error('Unexpected fetch'); }, () => NOW), { message: 'BOT_MUST_BE_STOPPED' });
});
test('the deployed default fingerprint refuses any other scope before network I/O', async () => {
  await assert.rejects(runWithApprovedScope(environment(), storage().ledger, () => false, async () => { throw new Error('Unexpected fetch'); }, () => NOW), { message: 'SETUP_TARGET_MISMATCH' });
});
test('mismatched current application or channel results in zero POSTs', async () => {
  for (const target of ['application', 'channel']) {
    const network = discord();
    const request: typeof fetch = async (url, options) => {
      if (target === 'application' && String(url).endsWith('/applications/@me')) return Response.json({ id: '111111111111111111' });
      if (target === 'channel' && String(url).includes('/channels/')) return Response.json({ id: SETUP_TARGET.textChannelId, guild_id: '111111111111111111', type: 0 });
      return network.request(url, options);
    };
    assert.equal((await runGuildSetup(environment(), storage().ledger, () => false, request, () => NOW)).state, 'failed');
    assert.equal(network.calls.filter(call => call.method === 'POST').length, 0);
  }
});
test('same operation cannot replay, even after restart or simultaneous invocation', async () => {
  const store = storage(); const network = discord();
  const results = await Promise.all([1, 2].map(() => runGuildSetup(environment(), store.ledger, () => false, network.request, () => NOW)));
  assert.ok(results.some(result => result.state === 'complete'));
  await runGuildSetup(environment(), new SqlSetupLedger(store.value), () => false, network.request, () => NOW);
  assert.equal(network.calls.filter(call => call.method === 'POST').length, 5);
});
test('lost POST response is uncertain and blocks both replay and a new operation', async () => {
  const store = storage(); const network = discord();
  const request: typeof fetch = async (url, options) => {
    const result = await network.request(url, options);
    if (options?.method === 'POST') throw new Error('Synthetic lost response with secret text'); return result;
  };
  const result = await runGuildSetup(environment(), store.ledger, () => false, request, () => NOW);
  assert.equal(result.state, 'uncertain'); assert.equal(result.attemptedName, 'join'); assert.equal(result.error, 'DISCORD_REQUEST_FAILED');
  const env = environment(); env.DISCORD_SETUP_OPERATION_ID = '14ae0ef1-7a9f-46a8-a73f-e1ad3a924c01';
  assert.equal((await runGuildSetup(env, store.ledger, () => false, request, () => NOW)).operationId, result.operationId);
  assert.equal(network.calls.filter(call => call.method === 'POST').length, 1);
});
test('deadline expiration during preflight prevents every POST', async () => {
  let now = NOW; const network = discord();
  const request: typeof fetch = async (url, options) => {
    const result = await network.request(url, options); if (String(url).includes('/commands?')) now += 600_000; return result;
  };
  assert.equal((await runGuildSetup(environment(), storage().ledger, () => false, request, () => now)).error, 'SETUP_DEADLINE_INACTIVE');
  assert.equal(network.calls.filter(call => call.method === 'POST').length, 0);
});
test('unbounded/malformed API responses and failed final readback never report success', async () => {
  for (const mode of ['oversize', 'malformed', 'readback']) {
    const network = discord(); let lists = 0;
    const request: typeof fetch = async (url, options) => {
      if (mode === 'oversize') return new Response('a'.repeat(65_537)); if (mode === 'malformed') return new Response('{');
      if (mode === 'readback' && String(url).includes('/commands?') && options?.method === 'GET' && ++lists === 7) return Response.json([]);
      return network.request(url, options);
    };
    assert.notEqual((await runGuildSetup(environment(), storage().ledger, () => false, request, () => NOW)).state, 'complete');
  }
});
test('a concurrent name collision detected by the immediate prewrite read stops the POST', async () => {
  const network = discord(); let lists = 0;
  const request: typeof fetch = async (url, options) => {
    if (String(url).includes('/commands?') && ++lists === 2) network.existing.push({ ...COMMANDS[0], description: 'Created by another writer' });
    return network.request(url, options);
  };
  assert.equal((await runGuildSetup(environment(), storage().ledger, () => false, request, () => NOW)).error, 'COMMAND_NAME_CONFLICT');
  assert.equal(network.calls.filter(call => call.method === 'POST').length, 0);
});
test('a POST upsert race is uncertain and prevents all later writes', async () => {
  const network = discord();
  const request: typeof fetch = async (url, options) => {
    if (options?.method === 'POST') network.existing.push({ ...COMMANDS[0], description: 'Concurrent writer after final GET' });
    return network.request(url, options);
  };
  const result = await runGuildSetup(environment(), storage().ledger, () => false, request, () => NOW);
  assert.equal(result.state, 'uncertain'); assert.equal(result.error, 'COMMAND_UPSERT_RACE');
  assert.equal(result.attemptedName, 'join'); assert.equal(network.calls.filter(call => call.method === 'POST').length, 1);
});
test('a stalled response body is cancelled at the request bound', async () => {
  let cancelled = false;
  const request: typeof fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  const started = Date.now();
  const result = await runGuildSetup(environment(), storage().ledger, () => false, request, () => NOW);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'DISCORD_REQUEST_ABORTED'); assert.equal(cancelled, true);
  assert.ok(Date.now() - started < 7000);
});
test('redirects are refused before reading the body and never followed', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    let requested = 0; let pulled = false; let cancelled = false;
    const response = new Response(new ReadableStream({ pull() { pulled = true; }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { status, headers: { location: 'https://other.invalid/private?credential=synthetic' } });
    const result = await runGuildSetup(environment(), storage().ledger, () => false, async () => { requested++; return response; }, () => NOW);
    assert.equal(result.state, 'failed'); assert.equal(result.error, 'DISCORD_REDIRECT_REFUSED');
    assert.equal(requested, 1); assert.equal(pulled, false); assert.equal(cancelled, true);
    assert.doesNotMatch(JSON.stringify(result), /other.invalid|credential=synthetic/);
  }
});
test('adapter errors persist only safe fixed codes, without messages or URLs', async () => {
  for (const [error, code] of [[new TypeError('secret synthetic-test-secret at https://private.invalid'), 'DISCORD_FETCH_REJECTED'], [new Error('secret synthetic-test-secret at https://private.invalid'), 'DISCORD_REQUEST_FAILED']] as const) {
    const result = await runGuildSetup(environment(), storage().ledger, () => false, async () => { throw error; }, () => NOW);
    assert.equal(result.error, code); assert.doesNotMatch(JSON.stringify(result), /synthetic-test-secret|private.invalid/);
  }
});
test('claim persistence failure prevents remote writes', async () => {
  const store = storage(); store.value.sync = async () => { throw new Error('Disk unavailable'); }; const network = discord();
  await assert.rejects(runGuildSetup(environment(), new SqlSetupLedger(store.value), () => false, network.request, () => NOW)); assert.equal(network.calls.length, 0);
});
test('readiness metadata uses its own table and never edits SDK tables or alarms', () => {
  const store = storage(); store.db.exec("CREATE TABLE container_schedules (id TEXT); INSERT INTO container_schedules VALUES ('untouched')");
  saveReadiness(store.value, { state: 'inactive' }); saveReadiness(store.value, { state: 'gateway-ready' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM voice_readiness_snapshot').get()?.n, 1);
  assert.equal(store.db.prepare('SELECT id FROM container_schedules').get()?.id, 'untouched');
});
