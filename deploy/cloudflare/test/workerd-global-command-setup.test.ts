import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { GLOBAL_COMMANDS, GLOBAL_INSPECT_ACTION, GLOBAL_REGISTER_ACTION, GLOBAL_RECOVER_MODEL_ACTION, GLOBAL_MODEL_RECOVERY_ORIGINAL_ID, globalPrincipalFingerprint } from '../src/global-command-setup.ts';

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response: OutboundResponse, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const APP = '100000000000000001'; const OWNER = '100000000000000004';
const TOKEN = 'synthetic-workerd-global-token'; const KEY = 'a'.repeat(64);
const RECEIVER = 'https://synthetic-receiver.invalid/interactions';
const principalPin = globalPrincipalFingerprint({ DISCORD_APPLICATION_ID: APP, DISCORD_OWNER_ID: OWNER });
const receiverPin = createHash('sha256').update(RECEIVER).digest('hex');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const bindings = (action: string, n: number, extra: Record<string, string> = {}) => ({
  BOT_ENABLED: 'false', VOICE_DEADLINE: '', DISCORD_BOT_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: APP, DISCORD_OWNER_ID: OWNER,
  DISCORD_GUILD_ID: '100000000000000002', DISCORD_TEXT_CHANNEL_ID: '100000000000000003',
  DISCORD_HTTP_ENABLED: 'true', DISCORD_PUBLIC_KEY: KEY, CONFIRM_DISCORD_SETUP: '',
  DISCORD_GLOBAL_SETUP_ACTION: action, DISCORD_GLOBAL_SETUP_OPERATION_ID: id(n),
  DISCORD_GLOBAL_SETUP_DEADLINE: new Date(Date.now() + 599_000).toISOString(),
  DISCORD_GLOBAL_SETUP_INSPECTION_ID: id(n - 1),
  DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION: '0', DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION: '0',
  DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT: new Date(Date.now() - 1_000).toISOString(),
  TEST_RUNNING: 'false', ...extra,
});
const COMMAND_PATH = `/api/v10/applications/${APP}/commands`;
function discord() {
  const commands: Record<string, unknown>[] = [];
  const calls: { path: string; method: string; body: unknown }[] = [];
  let upsert = false; let limitModel = false;
  const respond = async (request: Request) => {
    const url = new URL(request.url);
    assert.equal(url.origin, 'https://discord.com');
    assert.equal(request.headers.get('authorization'), `Bot ${TOKEN}`);
    const body = request.method === 'POST' ? JSON.parse(await request.text()) : null;
    calls.push({ path: url.pathname, method: request.method, body });
    if (url.pathname === '/api/v10/applications/@me') return OutboundResponse.json({ id: APP, owner: { id: OWNER }, team: null,
      verify_key: KEY, interactions_endpoint_url: RECEIVER, raw_private: 'never-store-this' });
    assert.equal(url.pathname, COMMAND_PATH);
    if (request.method === 'GET') return OutboundResponse.json(commands);
    assert.equal(request.method, 'POST');
    if (limitModel && body.name === 'model') return OutboundResponse.json({ message: 'synthetic rate limit' }, { status: 429 });
    const index = GLOBAL_COMMANDS.findIndex(item => item.name === body.name); assert.ok(index >= 0);
    assert.deepEqual(body, GLOBAL_COMMANDS[index]);
    const created = { ...body, id: String(100000000000000010n + BigInt(index)), version: '100000000000000099', application_id: APP };
    commands.push(created);
    return OutboundResponse.json(created, { status: upsert ? 200 : 201 });
  };
  return { commands, calls, respond, race: () => { upsert = true; }, rateLimitModel: (enabled: boolean) => { limitModel = enabled; }, posts: () => calls.filter(call => call.method === 'POST') };
}

// A no-start SDK double makes any lifecycle/TCP call fail and records it in
// actual workerd SQLite. Native DurableObject wraps the production adapter so
// Cron -> getByName -> RPC crosses the real workerd RPC boundary. No VM, Gateway,
// Docker build, live account, token retrieval or external network is involved.
const sdk = `
  export class Container {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    forbidden(name) {
      this.ctx.storage.sql.exec('INSERT INTO test_forbidden_calls(name) VALUES (?)', name);
      throw new Error('Container operation forbidden in this test');
    }
    async fetch() { this.forbidden('fetch'); }
    async startAndWaitForPorts() { this.forbidden('start'); }
    async destroy() { this.forbidden('destroy'); }
    async stop() { this.forbidden('stop'); }
    async schedule() { this.forbidden('schedule'); }
  }
  export class ContainerProxy {}
`;

test('real workerd Cron handler and private RPC register without Container lifecycle or public setup routes', async t => {
  const config = JSON.parse(readFileSync(`${ROOT}wrangler.jsonc`, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
  const bundle = await build({ stdin: { contents: `
    import { DurableObject } from 'cloudflare:workers';
    import production, { DiscordBot as ProductionBot } from './src/index.ts';
    export class TestBot extends DurableObject {
      constructor(ctx, env) {
        super(ctx, env);
        ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_forbidden_calls(name TEXT)');
        ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS test_housekeeping(name TEXT)');
        const container = { running: env.TEST_RUNNING === 'true' ? true : env.TEST_RUNNING === 'false' ? false : undefined,
          getTcpPort() { ctx.storage.sql.exec("INSERT INTO test_forbidden_calls(name) VALUES ('tcp')"); throw new Error('TCP forbidden'); } };
        this.adapter = new ProductionBot({ storage: ctx.storage, container }, env);
      }
      async setupGlobalCommands() { return this.adapter.setupGlobalCommands(); }
      async setupGuildCommands() { this.ctx.storage.sql.exec("INSERT INTO test_forbidden_calls(name) VALUES ('guild-setup')"); throw new Error('guild setup forbidden'); }
      async sweepCommandJobs() { this.ctx.storage.sql.exec("INSERT INTO test_housekeeping(name) VALUES ('sweep')"); }
      async safeSnapshot() {
        const rows = this.ctx.storage.sql.exec('SELECT receipt FROM voice_global_setup_receipts ORDER BY operation_id').toArray();
        return { receipts: rows.map(row => JSON.parse(row.receipt)), forbidden: this.ctx.storage.sql.exec('SELECT name FROM test_forbidden_calls').toArray(), housekeeping: this.ctx.storage.sql.exec('SELECT name FROM test_housekeeping').toArray() };
      }
    }
    export default {
      async scheduled(event, env) { await production.scheduled(event, env); },
      async fetch(request, env, ctx) {
        const path = new URL(request.url).pathname;
        // This read-only harness path is absent from production.
        if (path === '/harness/receipt') return Response.json(await env.BOT.getByName('discord-singleton').safeSnapshot());
        return production.fetch(request, env, ctx);
      }
    };
  `, resolveDir: ROOT, sourcefile: 'workerd-global-setup-harness.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'],
    plugins: [{ name: 'synthetic-pins-and-no-start-sdk', setup(builder: any) {
      builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: sdk, loader: 'js' }));
      builder.onLoad({ filter: /global-command-setup\.ts$/ }, (args: { path: string }) => {
        let source = readFileSync(args.path, 'utf8');
        assert.match(source, /APPROVED_GLOBAL_PRINCIPAL_FINGERPRINT = '[a-f0-9]+'/);
        assert.match(source, /RETAINED_RECEIVER_FINGERPRINT = '[a-f0-9]+'/);
        source = source.replace(/(APPROVED_GLOBAL_PRINCIPAL_FINGERPRINT = ')[a-f0-9]+(')/, `$1${principalPin}$2`)
          .replace(/(RETAINED_RECEIVER_FINGERPRINT = ')[a-f0-9]+(')/, `$1${receiverPin}$2`);
        return { contents: source, loader: 'ts' };
      });
    } }],
  });
  let net = discord();
  const options = {
    modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
    durableObjects: { BOT: { className: 'TestBot', useSQLite: true } },
    outboundService: (request: Request) => net.respond(request),
  };
  const runtime = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: bindings(GLOBAL_INSPECT_ACTION, 1) }));
  const configure = async (action: string, operation: number, extra = {}) => {
    await runtime.setOptions(convertV4MiniflareOptions({ ...options, bindings: bindings(action, operation, extra) }));
  };
  const cron = async () => { await (await runtime.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }); };
  const snapshot = async () => {
    const response = await runtime.dispatchFetch('https://harness.invalid/harness/receipt'); assert.equal(response.status, 200);
    const value = await response.json(); assert.deepEqual(value.forbidden, []);
    for (const secret of [TOKEN, KEY, APP, OWNER, RECEIVER, 'never-store-this']) assert.equal(JSON.stringify(value).includes(secret), false);
    return value;
  };
  try {
    await t.test('GET-only inspection crosses real RPC and stores a safe completed receipt', async () => {
      await cron(); const state = await snapshot();
      assert.equal(state.receipts[0].state, 'complete'); assert.equal(state.receipts[0].action, GLOBAL_INSPECT_ACTION);
      assert.equal(net.calls.length, 2); assert.equal(net.posts().length, 0);
    });
    await t.test('registration uses 201-only individual POSTs and readbacks exactly six', async () => {
      await configure(GLOBAL_REGISTER_ACTION, 2); await cron();
      const state = await snapshot(); const receipt = state.receipts.find((row: any) => row.operationId === id(2));
      assert.equal(receipt.state, 'complete'); assert.deepEqual(receipt.verifiedNames, GLOBAL_COMMANDS.map(command => command.name));
      assert.deepEqual(net.posts().map(call => call.body), GLOBAL_COMMANDS); assert.equal(net.commands.length, 6);
      const count = net.calls.length; await cron(); assert.equal(net.calls.length, count);
    });
    await t.test('invalid global action skips guild registration but retains no-start housekeeping', async () => {
      const count = net.calls.length;
      await configure('invalid', 3, { CONFIRM_DISCORD_SETUP: 'register-guild-commands-v1' }); await cron();
      assert.equal(net.calls.length, count); await snapshot();
    });
    await t.test('running or missing runtime metadata stops the production RPC before requests', async () => {
      const count = net.calls.length;
      for (const value of ['true', 'missing']) { await configure(GLOBAL_INSPECT_ACTION, 3, { TEST_RUNNING: value }); await cron(); }
      assert.equal(net.calls.length, count); const state = await snapshot(); assert.equal(state.housekeeping.length, 3);
    });
    await t.test('active flags with stale global/guild setup flags still run housekeeping without setup writes', async () => {
      const count = net.calls.length;
      await configure('stale-invalid', 3, { BOT_ENABLED: 'true', VOICE_DEADLINE: new Date(Date.now() - 60_000).toISOString(), CONFIRM_DISCORD_SETUP: 'register-guild-commands-v1' });
      await cron(); assert.equal(net.calls.length, count); const state = await snapshot(); assert.equal(state.housekeeping.length, 4);
    });
    await t.test('production fetch does not expose setup methods or alternate public endpoints', async () => {
      const count = net.calls.length;
      for (const path of ['/setupGlobalCommands', '/global-command-setup', '/debug']) assert.equal((await runtime.dispatchFetch(`https://harness.invalid${path}`)).status, 404);
      assert.equal(net.calls.length, count); await snapshot();
    });
    await t.test('manual /model recovery uses real Cron/RPC and retains one durable claim across reconstruction', async () => {
      const previousNet = net; net = discord();
      const recovered = new Miniflare(convertV4MiniflareOptions({ ...options, bindings: bindings(GLOBAL_INSPECT_ACTION, 20) }));
      const setup = async (action: string, operation: number, extra = {}) => {
        await recovered.setOptions(convertV4MiniflareOptions({ ...options, bindings: bindings(action, operation, extra) }));
      };
      const tick = async () => { await (await recovered.getWorker()).scheduled({ cron: '*/5 * * * *', scheduledTime: Date.now() }); };
      const read = async () => {
        const value = await (await recovered.dispatchFetch('https://harness.invalid/harness/receipt')).json();
        assert.deepEqual(value.forbidden, []);
        for (const secret of [TOKEN, KEY, APP, OWNER, RECEIVER, 'never-store-this']) assert.equal(JSON.stringify(value).includes(secret), false);
        return value;
      };
      try {
        await tick(); net.rateLimitModel(true);
        await setup(GLOBAL_REGISTER_ACTION, 21, { DISCORD_GLOBAL_SETUP_OPERATION_ID: GLOBAL_MODEL_RECOVERY_ORIGINAL_ID }); await tick();
        let state = await read(); const original = state.receipts.find((row: any) => row.operationId === GLOBAL_MODEL_RECOVERY_ORIGINAL_ID);
        assert.equal(original.state, 'uncertain'); assert.equal(original.error, 'DISCORD_RATE_LIMITED');
        assert.deepEqual(original.createdNames, GLOBAL_COMMANDS.slice(0, 5).map(command => command.name)); assert.equal(net.commands.length, 5);
        net.rateLimitModel(false); await setup(GLOBAL_INSPECT_ACTION, 22); await tick();
        await setup(GLOBAL_RECOVER_MODEL_ACTION, 23); await tick();
        state = await read(); const result = state.receipts.find((row: any) => row.operationId === id(23));
        assert.equal(result.state, 'complete'); assert.deepEqual(result.createdNames, ['model']); assert.deepEqual(result.verifiedNames, GLOBAL_COMMANDS.map(command => command.name));
        assert.equal(result.recoveryOf, GLOBAL_MODEL_RECOVERY_ORIGINAL_ID);
        assert.equal(result.originalReceiptFingerprint, createHash('sha256').update(JSON.stringify(original)).digest('hex'));
        assert.deepEqual(state.receipts.find((row: any) => row.operationId === GLOBAL_MODEL_RECOVERY_ORIGINAL_ID), original);
        const count = net.calls.length;
        await setup(GLOBAL_RECOVER_MODEL_ACTION, 24, { DISCORD_GLOBAL_SETUP_INSPECTION_ID: id(22) }); await tick();
        await setup(GLOBAL_REGISTER_ACTION, 25, { DISCORD_GLOBAL_SETUP_INSPECTION_ID: id(22) }); await tick();
        assert.equal(net.calls.length, count); state = await read();
        assert.equal(state.receipts.some((row: any) => row.operationId === id(24) || row.operationId === id(25)), false);
        assert.equal(net.posts().filter(call => (call.body as any).name === 'model').length, 2); // Original 429 + one recovery.
      } finally { await recovered.dispose(); net = previousNet; }
    });
    await t.test('uncertain upsert blocks a new UUID after isolate reconstruction; read-only inspection cannot clear it', async () => {
      net = discord(); await configure(GLOBAL_INSPECT_ACTION, 3); await cron();
      net.race(); await configure(GLOBAL_REGISTER_ACTION, 4); await cron();
      let state = await snapshot(); let receipt = state.receipts.find((row: any) => row.operationId === id(4));
      assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.error, 'GLOBAL_COMMAND_UPSERT_RACE'); assert.equal(net.posts().length, 1);
      const count = net.calls.length;
      await configure(GLOBAL_REGISTER_ACTION, 5, { DISCORD_GLOBAL_SETUP_INSPECTION_ID: id(3) }); await cron();
      assert.equal(net.calls.length, count); state = await snapshot(); assert.equal(state.receipts.some((row: any) => row.operationId === id(5)), false);
      await configure(GLOBAL_INSPECT_ACTION, 6); await cron(); state = await snapshot();
      assert.equal(state.receipts.find((row: any) => row.operationId === id(6)).state, 'complete');
      receipt = state.receipts.find((row: any) => row.operationId === id(4)); assert.equal(receipt.state, 'uncertain'); assert.equal(net.posts().length, 1);
    });
  } finally { await runtime.dispose(); }
});
