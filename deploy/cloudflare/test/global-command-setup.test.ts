import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GLOBAL_COMMANDS, GLOBAL_INSPECT_ACTION, GLOBAL_REGISTER_ACTION, globalPrincipalFingerprint,
  matchesGlobalCommand, runGlobalCommandSetup, type GlobalSetupEnv, type GlobalSetupReceipt } from '../src/global-command-setup.ts';
import { SqlGlobalSetupLedger } from '../src/global-setup-ledger.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const APP = '100000000000000001'; const OWNER = '100000000000000004';
const TOKEN = 'synthetic-global-test-secret'; const KEY = 'a'.repeat(64);
const RECEIVER = 'https://synthetic-receiver.invalid/interactions';
const RECEIVER_PIN = createHash('sha256').update(RECEIVER).digest('hex');
const INSPECT_ID = '00000000-0000-4000-8000-000000000001';
const REGISTER_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
function env(action: string = GLOBAL_INSPECT_ACTION): GlobalSetupEnv {
  return { BOT_ENABLED: 'false', VOICE_DEADLINE: '', DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_APPLICATION_ID: APP, DISCORD_OWNER_ID: OWNER, DISCORD_HTTP_ENABLED: 'true', DISCORD_PUBLIC_KEY: KEY,
    CONFIRM_DISCORD_SETUP: '', DISCORD_GLOBAL_SETUP_ACTION: action,
    DISCORD_GLOBAL_SETUP_OPERATION_ID: action === GLOBAL_INSPECT_ACTION ? INSPECT_ID : REGISTER_ID,
    DISCORD_GLOBAL_SETUP_DEADLINE: new Date(NOW + 600_000).toISOString(), DISCORD_GLOBAL_SETUP_INSPECTION_ID: INSPECT_ID,
    DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION: '0', DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION: '0',
    DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT: new Date(NOW).toISOString() };
}
function storage() {
  const db = new DatabaseSync(':memory:'); let syncs = 0;
  const value = {
    sql: { exec(query: string, ...params: (string | number | null)[]) {
      const statement = db.prepare(query);
      const rows = statement.columns().length ? statement.all(...params) : (statement.run(...params), []);
      return { toArray: () => rows };
    } }, sync: async () => { syncs++; },
  };
  return { db, value, syncs: () => syncs, ledger: new SqlGlobalSetupLedger(value) };
}
function command(index: number) {
  return { ...structuredClone(GLOBAL_COMMANDS[index]), id: String(100000000000000010n + BigInt(index)), version: '100000000000000099', application_id: APP };
}
function network(initial: unknown[] = []) {
  const commands = structuredClone(initial); const calls: { path: string; method: string; body: unknown }[] = [];
  const application = { id: APP, owner: { id: OWNER }, team: null, verify_key: KEY, interactions_endpoint_url: RECEIVER, private_field: 'discard-private' };
  const request: typeof fetch = async (url, options) => {
    const parsed = new URL(String(url)); const method = options?.method ?? 'GET';
    assert.equal(parsed.origin, 'https://discord.com'); assert.equal(options?.redirect, 'manual'); assert.ok(options?.signal);
    assert.equal(new Headers(options?.headers).get('authorization'), `Bot ${TOKEN}`);
    const body = options?.body ? JSON.parse(String(options.body)) : null;
    calls.push({ path: parsed.pathname, method, body });
    if (parsed.pathname === '/api/v10/applications/@me') { assert.equal(method, 'GET'); return Response.json(application); }
    assert.equal(parsed.pathname, `/api/v10/applications/${APP}/commands`);
    if (method === 'GET') { assert.equal(parsed.search, '?with_localizations=true'); return Response.json(commands); }
    assert.equal(method, 'POST'); assert.equal(parsed.search, '');
    const index = GLOBAL_COMMANDS.findIndex(item => item.name === body.name); assert.ok(index >= 0);
    assert.deepEqual(body, GLOBAL_COMMANDS[index]);
    const prior = commands.findIndex((item: any) => item.type === body.type && item.name === body.name);
    const created = command(index);
    if (prior < 0) commands.push(created); else commands[prior] = created;
    return Response.json(created, { status: prior < 0 ? 201 : 200 });
  };
  return { commands, calls, application, request, posts: () => calls.filter(call => call.method === 'POST') };
}
function run(environment: GlobalSetupEnv, store: ReturnType<typeof storage>, request: typeof fetch, running: () => boolean | undefined = () => false, now = () => NOW) {
  return runGlobalCommandSetup(environment, store.ledger, running, request, now, globalPrincipalFingerprint(env()), RECEIVER_PIN);
}
async function inspected(initial: unknown[] = []) {
  const store = storage(); const net = network(initial);
  assert.equal((await run(env(), store, net.request)).state, 'complete');
  return { store, net };
}

test('inspect is GET-only and writes only fixed safe metadata, even with raw private fields in response', async () => {
  const { store, net } = await inspected();
  assert.equal(net.calls.length, 2); assert.equal(net.posts().length, 0);
  const receipt = await store.ledger.read(INSPECT_ID);
  assert.deepEqual(receipt?.observedNames, []); assert.equal(receipt?.applicationVerified, true);
  const saved = JSON.stringify(store.db.prepare('SELECT * FROM voice_global_setup_receipts').all());
  for (const forbidden of [TOKEN, KEY, APP, OWNER, RECEIVER, 'discard-private', 'verify_key', 'authorization']) assert.ok(!saved.includes(forbidden));
});
test('register requires a different explicit action, operation and completed inspection before network', async () => {
  const store = storage(); const net = network();
  assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, net.request)).error, 'INSPECTION_RECEIPT_REQUIRED');
  assert.equal(net.calls.length, 0);
  await assert.rejects(run({ ...env(GLOBAL_REGISTER_ACTION), DISCORD_GLOBAL_SETUP_OPERATION_ID: INSPECT_ID }, storage(), net.request), /INSPECTION_RECEIPT_REQUIRED/);
});
test('creates exactly the six guild-only globals individually and readbacks exactly six', async () => {
  const { store, net } = await inspected();
  const result = await run(env(GLOBAL_REGISTER_ACTION), store, net.request);
  assert.equal(result.state, 'complete'); assert.equal(result.error, null);
  assert.deepEqual(result.createdNames, GLOBAL_COMMANDS.map(command => command.name));
  assert.deepEqual(result.verifiedNames, result.createdNames); assert.equal(net.commands.length, 6);
  assert.deepEqual(net.posts().map(call => call.body), GLOBAL_COMMANDS);
  assert.ok(net.calls.every(call => ['GET', 'POST'].includes(call.method) && !call.path.includes('/guilds/')));
  assert.equal(net.calls.at(-1)?.method, 'GET'); assert.ok(store.syncs() >= 18);
});
test('matching existing globals are retained without POST; only missing commands are created', async () => {
  for (const count of [1, 3, 6]) {
    const { store, net } = await inspected(Array.from({ length: count }, (_, index) => command(index)));
    const result = await run(env(GLOBAL_REGISTER_ACTION), store, net.request);
    assert.equal(result.state, 'complete'); assert.equal(net.posts().length, 6 - count);
  }
});
test('unknown globals, same-name context commands, duplicates, foreign and changed definitions stop before writing', async () => {
  for (const commands of [
    [{ ...command(0), name: 'unrelated' }], [{ ...command(0), type: 2 }], [command(0), command(0)],
    [{ ...command(0), application_id: OWNER }], [{ ...command(0), description: 'Changed behavior' }],
    [{ ...command(0), guild_id: OWNER }], [{ ...command(0), contexts: [0, 1] }],
  ]) {
    const store = storage(); const net = network(commands);
    assert.equal((await run(env(), store, net.request)).state, 'failed'); assert.equal(net.posts().length, 0);
    assert.deepEqual(net.commands, commands);
  }
});
test('strict matching rejects unknown behavior, permission, option and metadata fields', () => {
  for (const patch of [
    { contexts: undefined }, { contexts: [1] }, { contexts: [0, 0] }, { integration_types: [0, 1] },
    { default_member_permissions: '0' }, { default_permission: false }, { nsfw: true },
    { name_localizations: {} }, { description_localizations: { ja: 'other' } }, { handler: 1 },
    { id: 'bad' }, { version: undefined },
  ]) assert.equal(matchesGlobalCommand({ ...command(0), ...patch }, GLOBAL_COMMANDS[0], APP), false);
  assert.equal(matchesGlobalCommand({ ...command(4), options: [{ ...GLOBAL_COMMANDS[4].options[0], autocomplete: true }] }, GLOBAL_COMMANDS[4], APP), false);
  assert.equal(matchesGlobalCommand({ ...command(4), options: [] }, GLOBAL_COMMANDS[4], APP), false);
  assert.equal(matchesGlobalCommand({ ...command(4), options: null }, GLOBAL_COMMANDS[4], APP), false);
  assert.equal(matchesGlobalCommand({ ...command(0), dm_permission: true }, GLOBAL_COMMANDS[0], APP), true);
});
for (const [field, value, error] of [
  ['DISCORD_GLOBAL_SETUP_ACTION', '', 'GLOBAL_SETUP_DISABLED'], ['DISCORD_GLOBAL_SETUP_ACTION', 'register', 'GLOBAL_SETUP_DISABLED'],
  ['BOT_ENABLED', 'true', 'BOT_MUST_BE_STOPPED'], ['VOICE_DEADLINE', new Date(NOW + 1000).toISOString(), 'BOT_MUST_BE_STOPPED'],
  ['CONFIRM_DISCORD_SETUP', 'register-guild-commands-v1', 'GUILD_SETUP_MUST_BE_DISABLED'],
  ['DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION', '1', 'ZERO_CAPACITY_ATTESTATION_REQUIRED'],
  ['DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION', '', 'ZERO_CAPACITY_ATTESTATION_REQUIRED'],
  ['DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT', '', 'CAPACITY_ATTESTATION_STALE'],
  ['DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT', new Date(NOW - 600_001).toISOString(), 'CAPACITY_ATTESTATION_STALE'],
  ['DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT', new Date(NOW + 1).toISOString(), 'CAPACITY_ATTESTATION_STALE'],
  ['DISCORD_GLOBAL_SETUP_OPERATION_ID', 'bad', 'INVALID_GLOBAL_SETUP_OPERATION'],
  ['DISCORD_GLOBAL_SETUP_DEADLINE', '', 'GLOBAL_SETUP_DEADLINE_INACTIVE'],
  ['DISCORD_GLOBAL_SETUP_DEADLINE', new Date(NOW).toISOString(), 'GLOBAL_SETUP_DEADLINE_INACTIVE'],
  ['DISCORD_GLOBAL_SETUP_DEADLINE', new Date(NOW + 600_001).toISOString(), 'GLOBAL_SETUP_DEADLINE_INACTIVE'],
  ['DISCORD_APPLICATION_ID', OWNER, 'GLOBAL_PRINCIPAL_MISMATCH'], ['DISCORD_OWNER_ID', APP, 'GLOBAL_PRINCIPAL_MISMATCH'],
  ['DISCORD_HTTP_ENABLED', 'false', 'HTTP_RECEIVER_MUST_BE_RETAINED'], ['DISCORD_PUBLIC_KEY', '', 'HTTP_RECEIVER_MUST_BE_RETAINED'],
  ['DISCORD_BOT_TOKEN', '', 'BOT_TOKEN_MISSING'],
] as const) test(`guard ${field}/${error} rejects before any network`, async () => {
  const net = network(); await assert.rejects(run({ ...env(), [field]: value }, storage(), net.request), { message: error });
  assert.equal(net.calls.length, 0);
});
test('running true and missing runtime metadata both fail closed before network', async () => {
  for (const running of [true, undefined]) { const net = network(); await assert.rejects(run(env(), storage(), net.request, () => running), /BOT_MUST_BE_STOPPED/); assert.equal(net.calls.length, 0); }
});
test('production principal and receiver pins cannot accept a synthetic target', async () => {
  const store = storage(); const net = network();
  await assert.rejects(runGlobalCommandSetup(env(), store.ledger, () => false, net.request, () => NOW), /GLOBAL_PRINCIPAL_MISMATCH/);
  assert.equal(net.calls.length, 0);
  const receipt = await runGlobalCommandSetup(env(), store.ledger, () => false, net.request, () => NOW, globalPrincipalFingerprint(env()));
  assert.equal(receipt.error, 'RETAINED_RECEIVER_MISMATCH');
});
test('application identity, direct owner, retained endpoint and public key are checked', async () => {
  for (const patch of [{ id: OWNER }, { owner: { id: APP } }, { team: {} }, { team: undefined },
    { interactions_endpoint_url: '' }, { interactions_endpoint_url: `${RECEIVER}?changed=1` }, { verify_key: 'b'.repeat(64) }]) {
    const store = storage(); const net = network(); Object.assign(net.application, patch);
    assert.equal((await run(env(), store, net.request)).state, 'failed'); assert.equal(net.posts().length, 0);
  }
});
test('changed globals after inspection block registration, preserving unrelated commands', async () => {
  for (const next of [command(0), { ...command(0), name: 'unrelated' }, { ...command(0), description: 'changed' }]) {
    const { store, net } = await inspected(); net.commands.push(next);
    assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, net.request)).state, 'failed'); assert.equal(net.posts().length, 0);
    assert.deepEqual(net.commands, [next]);
  }
});
test('immediate prewrite read stops a concurrent unknown or conflicting command before first POST', async () => {
  for (const entry of [{ ...command(0), name: 'unrelated' }, { ...command(0), description: 'concurrent' }]) {
    const { store, net } = await inspected(); let reads = 0;
    const request: typeof fetch = (url, options) => {
      if (String(url).includes('/commands?') && ++reads === 2) net.commands.push(entry);
      return net.request(url, options);
    };
    assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, request)).state, 'failed'); assert.equal(net.posts().length, 0);
  }
});
test('same operation and simultaneous/reconstructed calls never replay', async () => {
  const { store, net } = await inspected();
  const results = await Promise.all([1, 2].map(() => run(env(GLOBAL_REGISTER_ACTION), store, net.request)));
  assert.ok(results.some(result => result.state === 'complete'));
  store.ledger = new SqlGlobalSetupLedger(store.value);
  assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, net.request)).state, 'complete'); assert.equal(net.posts().length, 6);
});
test('HTTP 200 upsert race stops with permanent uncertainty even with a fresh operation ID', async () => {
  const { store, net } = await inspected();
  const request: typeof fetch = (url, options) => {
    if (options?.method === 'POST') net.commands.push({ ...command(0), description: 'raced after GET' });
    return net.request(url, options);
  };
  const result = await run(env(GLOBAL_REGISTER_ACTION), store, request);
  assert.equal(result.state, 'uncertain'); assert.equal(result.error, 'GLOBAL_COMMAND_UPSERT_RACE'); assert.equal(result.attemptedName, 'join');
  store.ledger = new SqlGlobalSetupLedger(store.value);
  const again = await run({ ...env(GLOBAL_REGISTER_ACTION), DISCORD_GLOBAL_SETUP_OPERATION_ID: OTHER_ID }, store, request);
  assert.equal(again.operationId, REGISTER_ID); assert.equal(net.posts().length, 1);
});
test('lost response, malformed POST response and unexpected 2xx all block subsequent writes permanently', async () => {
  for (const mode of ['lost', 'malformed', '202', '204', '429']) {
    const { store, net } = await inspected();
    const request: typeof fetch = async (url, options) => {
      const response = await net.request(url, options);
      if (options?.method !== 'POST') return response;
      if (mode === 'lost') throw new Error(`private ${TOKEN}`);
      if (mode === 'malformed') return new Response('{', { status: 201 });
      return new Response(null, { status: Number(mode) });
    };
    assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, request)).state, 'uncertain');
    assert.equal((await run({ ...env(GLOBAL_REGISTER_ACTION), DISCORD_GLOBAL_SETUP_OPERATION_ID: OTHER_ID }, store, request)).state, 'uncertain');
    assert.equal(net.posts().length, 1);
  }
});
test('final missing/unknown readback and post-write identity drift are uncertain despite successful POSTs', async () => {
  for (const mode of ['missing', 'unknown', 'identity']) {
    const { store, net } = await inspected(); let reads = 0; let applications = 0;
    const request: typeof fetch = async (url, options) => {
      if (String(url).includes('/commands?') && ++reads === 8) return Response.json(mode === 'unknown' ? [...net.commands, { ...command(0), name: 'unknown' }] : []);
      if (mode === 'identity' && String(url).endsWith('/applications/@me') && ++applications === 2) net.application.owner.id = APP;
      return net.request(url, options);
    };
    const result = await run(env(GLOBAL_REGISTER_ACTION), store, request);
    assert.equal(result.state, 'uncertain'); assert.equal(net.posts().length, 6);
  }
});
test('fresh GET-only inspection can observe uncertain state without clearing the write block', async () => {
  const { store, net } = await inspected();
  const failPost: typeof fetch = async (url, options) => { const response = await net.request(url, options); if (options?.method === 'POST') throw new Error('lost'); return response; };
  assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, failPost)).state, 'uncertain');
  assert.equal((await run({ ...env(), DISCORD_GLOBAL_SETUP_OPERATION_ID: OTHER_ID }, store, net.request)).state, 'complete');
  assert.equal(net.posts().length, 1);
  assert.equal((await store.ledger.read(REGISTER_ID))?.state, 'uncertain');
});
test('expired inspection, changing running state and deadline stop writes', async () => {
  { const { store, net } = await inspected(); const receipt = (await store.ledger.read(INSPECT_ID))!; receipt.updatedAt = new Date(NOW - 600_001).toISOString(); await store.ledger.save(receipt);
    assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, net.request)).error, 'INSPECTION_RECEIPT_REQUIRED'); assert.equal(net.posts().length, 0); }
  for (const mode of ['running', 'deadline']) {
    const { store, net } = await inspected(); let current = NOW; let running = false;
    const request: typeof fetch = async (url, options) => { const response = await net.request(url, options); if (String(url).includes('/commands?')) { if (mode === 'deadline') current += 600_001; else running = true; } return response; };
    assert.equal((await run(env(GLOBAL_REGISTER_ACTION), store, request, () => running, () => current)).state, 'failed'); assert.equal(net.posts().length, 0);
  }
});
test('redirects are manual/refused on GET and POST and never followed', async () => {
  for (const status of [301, 302, 303, 307, 308]) for (const method of ['GET', 'POST']) {
    const { store, net } = await inspected(); let requests = 0;
    const request: typeof fetch = async (url, options) => {
      requests++;
      if (options?.method === method) return new Response('private', { status, headers: { location: 'https://steal.invalid/secret' } });
      return net.request(url, options);
    };
    const result = await run(env(GLOBAL_REGISTER_ACTION), store, request);
    assert.equal(result.error, 'DISCORD_REDIRECT_REFUSED'); assert.equal(result.state, method === 'POST' ? 'uncertain' : 'failed');
    assert.equal(requests, method === 'POST' ? 4 : 1); assert.doesNotMatch(JSON.stringify(result), /steal|secret/);
  }
});
test('oversized, invalid UTF-8, malformed, non-200 and empty GETs fail with safe fixed errors', async () => {
  for (const response of [new Response('a'.repeat(65_537)), new Response(new Uint8Array([0xff])), new Response('{'), new Response(null, { status: 204 }), Response.json({}, { status: 429 })]) {
    const result = await run(env(), storage(), async () => response);
    assert.equal(result.state, 'failed'); assert.equal(result.writeAttempted, false);
  }
});
test('stalled response body is cancelled within five-second request bound', async () => {
  let cancelled = false;
  const keepalive = setTimeout(() => {}, 7000);
  try {
    const result = await run(env(), storage(), async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    assert.equal(result.error, 'DISCORD_REQUEST_ABORTED'); assert.equal(cancelled, true);
  } finally { clearTimeout(keepalive); }
});
test('claim durability failure prevents all requests, while pre-POST sync failure cannot write', async () => {
  { const store = storage(); const net = network(); store.value.sync = async () => { throw new Error('disk'); };
    await assert.rejects(run(env(), store, net.request)); assert.equal(net.calls.length, 0); }
  { const { store, net } = await inspected(); const original = store.ledger.save.bind(store.ledger);
    store.ledger.save = async receipt => { if (receipt.writeAttempted) throw new Error('disk'); await original(receipt); };
    await assert.rejects(run(env(GLOBAL_REGISTER_ACTION), store, net.request)); assert.equal(net.posts().length, 0);
    assert.equal((await store.ledger.read(REGISTER_ID))?.state, 'pending'); }
});
test('ledger never changes SDK schedules, existing guild setup receipts, or alarms', async () => {
  const store = storage(); store.db.exec("CREATE TABLE container_schedules (id TEXT); INSERT INTO container_schedules VALUES ('preserved'); CREATE TABLE voice_setup_receipts (receipt TEXT); INSERT INTO voice_setup_receipts VALUES ('preserved')");
  const net = network(); await run(env(), store, net.request);
  assert.equal(store.db.prepare('SELECT id FROM container_schedules').get()?.id, 'preserved');
  assert.equal(store.db.prepare('SELECT receipt FROM voice_setup_receipts').get()?.receipt, 'preserved');
});
test('default config is off, both capacities remain zero and existing Cron is unchanged', () => {
  const configuration = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  for (const setting of ['ACTION', 'OPERATION_ID', 'DEADLINE', 'INSPECTION_ID', 'BOT_CAP_ATTESTATION', 'TTS_CAP_ATTESTATION', 'CAPS_CHECKED_AT']) assert.ok(configuration.includes(`"DISCORD_GLOBAL_SETUP_${setting}": ""`));
  assert.equal((configuration.match(/"max_instances": 0/g) ?? []).length, 2);
  assert.ok(configuration.includes('"crons": ["*/5 * * * *"]'));
});
