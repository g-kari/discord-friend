import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Only pinned Wrangler's declared tooling is used. Crypto, Durable Object RPC,
// SQLite, response timing, and global fetch run in real workerd. The Container
// SDK/image is an explicit offline double; every outbound URL is intercepted.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response: OutboundResponse, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = Date.parse('2026-10-02T12:00:00Z');
const SID = '10000000-0000-4000-8000-000000000001';
const TOKEN = 'synthetic_workerd_interaction_reply_token';
const TEXT = 'synthetic_private_workerd_speech_こんにちは_é';
const SECRET = 'synthetic-workerd-worker-secret';
const scope = {
  DISCORD_APPLICATION_ID: '100000000000000001',
  DISCORD_GUILD_ID: '100000000000000002',
  DISCORD_TEXT_CHANNEL_ID: '100000000000000003',
  DISCORD_OWNER_ID: '100000000000000004',
};
const approved = createHash('sha256').update(Object.values(scope).join(':')).digest('hex');
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const BINDINGS = {
  ...scope, BOT_ENABLED: 'true', DISCORD_HTTP_ENABLED: 'true',
  DISCORD_BOT_TOKEN: SECRET,
  DISCORD_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'),
  VOICE_DEADLINE: new Date(NOW + 30 * 60_000).toISOString(),
  VOICE_IDLE_SECONDS: '300', VOICE_SESSION_MINUTES: '30',
};
const snowflake = (n: number) => String(100000000000000000n + BigInt(n));
function payload(n: number, name = 'say') {
  return {
    type: 2, id: snowflake(n), application_id: scope.DISCORD_APPLICATION_ID,
    guild_id: scope.DISCORD_GUILD_ID, channel_id: scope.DISCORD_TEXT_CHANNEL_ID,
    member: { user: { id: scope.DISCORD_OWNER_ID } }, token: TOKEN,
    data: { type: 1, name, ...(name === 'say' ? { options: [{ type: 3, name: 'text', value: TEXT }] } : {}) },
  };
}
async function signed(body: unknown, stamp = String(NOW / 1000), raw = JSON.stringify(body)) {
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey,
    new TextEncoder().encode(stamp + raw))).toString('hex');
  return { method: 'POST', headers: { 'content-type': 'application/json',
    'x-signature-timestamp': stamp, 'x-signature-ed25519': signature }, body: raw };
}

const sdk = `
  import { DurableObject } from 'cloudflare:workers';
  export class Container extends DurableObject {
    constructor(ctx, env) {
      super(ctx, env);
      this.fixture = { starts: 0, destroys: 0, stops: 0, aborts: 0, portCalls: [],
        schedules: [], commands: [], holdStart: false, runOnSchedule: false, actualSession: null };
      this.ctx = { storage: ctx.storage, container: {
        running: false,
        getTcpPort: () => ({ fetch: async (input, init) => {
          const request = new Request(input, init);
          this.fixture.portCalls.push({ url: request.url, method: request.method });
          if (request.url === 'http://bot.internal/health') return Response.json({
            sessionId: this.fixture.actualSession, ready: true, voice: 'ready', queued: 0,
            idleAt: Date.now() + 60000,
          });
          if (request.url === 'http://bot.internal/v1/command') {
            const command = await request.json();
            this.fixture.commands.push(command);
            return Response.json({ content: '合成確認用応答', joined: command.name === 'join' });
          }
          return new Response(null, { status: 418 });
        } }),
      } };
    }
    async startAndWaitForPorts(options) {
      this.fixture.starts++;
      this.ctx.container.running = true;
      this.fixture.actualSession = options.startOptions.envVars.VOICE_SESSION_ID;
      const signal = options.cancellationOptions.abort;
      signal.throwIfAborted();
      if (this.fixture.holdStart) await new Promise((resolve, reject) => {
        this.releaseStart = resolve;
        signal.addEventListener('abort', () => {
          this.fixture.aborts++;
          reject(new Error('SYNTHETIC_START_ABORTED'));
        }, { once: true });
      });
      signal.throwIfAborted();
    }
    async destroy() { this.fixture.destroys++; this.ctx.container.running = false; }
    async stop() { this.fixture.stops++; }
    renewActivityTimeout() {}
    async schedule(when, method, payload) {
      this.fixture.schedules.push({ when: when instanceof Date ? when.toISOString() : when, method, payload });
      if (this.fixture.runOnSchedule && method === 'runCommandJob') await this.runCommandJob(payload);
      return {};
    }
  }
  export class ContainerProxy {}
`;
const harness = `
  import worker, { DiscordBot, Voicevox } from './src/index.ts';
  import { InteractionLedger } from './src/interaction-ledger.ts';
  let clock = ${NOW};
  Date.now = () => clock;
  let ingressLookups = 0;
  export class TestDiscordBot extends DiscordBot {
    inspect() {
      const tables = {};
      for (const { name } of this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'voice_%'").toArray()) {
        tables[name] = this.ctx.storage.sql.exec('SELECT * FROM ' + name).toArray();
      }
      return { tables, session: this.commandLedger.session(), running: this.ctx.container.running, fixture: this.fixture };
    }
    ready() {
      this.commandLedger.setSession({ id: '${SID}', status: 'ready', controlId: '${snowflake(1)}',
        deadline: ${NOW + 30 * 60_000}, createdAt: ${NOW} });
      this.setImageLease('${SID}');
      this.ctx.container.running = true;
      this.fixture.actualSession = '${SID}';
    }
    configure(value) { Object.assign(this.fixture, value); }
    clock(value) { clock = value; }
    reconstructedTake(id) { return new InteractionLedger(this.ctx.storage).take(id, Date.now()); }
  }
  export class TestVoicevox extends Voicevox {}
  export default {
    async fetch(request, env, ctx) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/test/')) {
        const bot = env.BOT.getByName('discord-singleton');
        const value = request.method === 'POST' ? await request.json() : {};
        if (path === '/test/inspect') return Response.json({ ingressLookups, ...await bot.inspect() });
        if (path === '/test/ready') await bot.ready();
        else if (path === '/test/configure') await bot.configure(value);
        else if (path === '/test/clock') { clock = value.now; await bot.clock(value.now); }
        else if (path === '/test/run') await bot.runCommandJob(value);
        else if (path === '/test/sweep') await bot.sweepCommandJobs();
        else if (path === '/test/take') return Response.json(await bot.reconstructedTake(value.id));
        else if (path === '/test/expire') await bot.expireCommandSession(value);
        return Response.json({ completed: true });
      }
      // Count even namespace lookup separately from SDK starts/port calls.
      return worker.fetch(request, { ...env, BOT: {
        getByName(name) { ingressLookups++; return env.BOT.getByName(name); },
      } }, ctx);
    },
  };
`;

async function bundle(mutation?: 'unawaited-signature' | 'missing-replay-claim') {
  let mutations = 0;
  const bundled = await build({
    stdin: { contents: harness, resolveDir: ROOT, sourcefile: 'workerd-interactions-harness.ts', loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['cloudflare:workers', 'node:*'],
    plugins: [{
      name: 'explicit-offline-container-and-synthetic-scope',
      setup(builder: any) {
        builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: sdk, loader: 'js' }));
        builder.onLoad({ filter: /guild-setup\.ts$/ }, (args: { path: string }) => {
          const source = readFileSync(args.path, 'utf8');
          assert.match(source, /APPROVED_SCOPE_FINGERPRINT = '[a-f0-9]+'/);
          return { contents: source.replace(/(APPROVED_SCOPE_FINGERPRINT = ')[a-f0-9]+(')/,
            (_: string, prefix: string, suffix: string) => prefix + approved + suffix), loader: 'ts' };
        });
        builder.onLoad({ filter: /scope-policy\.ts$/ }, (args: { path: string }) => ({
          contents: readFileSync(args.path, 'utf8').replace(/(APPROVED_PRINCIPAL = ')[a-f0-9]+(')/,
            '$1' + createHash('sha256').update([scope.DISCORD_APPLICATION_ID, scope.DISCORD_OWNER_ID].join(':')).digest('hex') + '$2'), loader: 'ts',
        }));
        if (mutation === 'unawaited-signature') builder.onLoad({ filter: /interactions\.ts$/ }, (args: { path: string }) => {
          const source = readFileSync(args.path, 'utf8');
          assert.ok(source.includes('!await crypto.subtle.verify'));
          mutations++;
          return { contents: source.replace('!await crypto.subtle.verify', '!crypto.subtle.verify'), loader: 'ts' };
        });
        if (mutation === 'missing-replay-claim') builder.onLoad({ filter: /interaction-ledger\.ts$/ }, (args: { path: string }) => {
          const source = readFileSync(args.path, 'utf8');
          const claim = `this.storage.sql.exec("UPDATE voice_interaction_jobs SET state = 'executing', cipher = NULL WHERE id = ? AND state = 'accepted'", id);`;
          assert.ok(source.includes(claim));
          mutations++;
          return { contents: source.replace(claim, '/* negative control: execution claim omitted */'), loader: 'ts' };
        });
      },
    }],
  });
  if (mutation) assert.equal(mutations, 1, 'negative control must change exactly its intended production module');
  return bundled.outputFiles[0].text;
}

type OutboundCall = { url: string; method: string; authorization: string | null; body: unknown };
async function runtime(script: string, overrides: Record<string, string> = {}) {
  const config = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const compatibilityDate = config.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  const flags = config.match(/"compatibility_flags"\s*:\s*(\[[^\]]*\])/)?.[1];
  assert.ok(compatibilityDate);
  assert.ok(flags);
  const outbound: OutboundCall[] = [];
  let replyStatus = 200;
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script, compatibilityDate, compatibilityFlags: JSON.parse(flags), bindings: { ...BINDINGS, ...overrides },
    durableObjects: {
      BOT: { className: 'TestDiscordBot', useSQLite: true },
      VOICEVOX: { className: 'TestVoicevox', useSQLite: true },
    },
    outboundService: async (request: Request) => {
      const body = await request.text();
      outbound.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'),
        body: body ? JSON.parse(body) : null });
      const expected = `https://discord.com/api/v10/webhooks/${scope.DISCORD_APPLICATION_ID}/${TOKEN}/messages/@original`;
      if (request.url !== expected || request.method !== 'PATCH') return new OutboundResponse(null, { status: 418 });
      return new OutboundResponse(null, { status: replyStatus });
    },
  }));
  async function admin(path: string, body?: unknown) {
    const response = await mf.dispatchFetch(`https://offline.test/test/${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  return { mf, outbound, admin, inspect: () => admin('inspect'), replyStatus: (status: number) => { replyStatus = status; } };
}
async function until(read: () => Promise<any>, predicate: (value: any) => boolean) {
  const deadline = performance.now() + 5000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(performance.now() < deadline, `workerd fixture did not reach its expected state: ${JSON.stringify(value)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const rows = (state: any) => (state.tables.voice_interaction_jobs ?? [])
  .toSorted((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id));
const jobs = (state: any) => state.fixture.schedules.filter((item: any) => item.method === 'runCommandJob');

test('installed-guild workerd routing keeps signed guild scopes and global daily usage isolated', async () => {
  const f = await runtime(await bundle(), { DISCORD_SCOPE_MODE: 'installed-guilds', VOICE_USAGE_MODE: 'daily', VOICE_DEADLINE: '' });
  const dynamic = (n: number, name: string, guild = '100000000000000012', channel = '100000000000000013') => ({
    ...payload(n, name), guild_id: guild, channel_id: channel, channel: { id: channel, type: 0 }, context: 0,
    member: { user: { id: scope.DISCORD_OWNER_ID }, permissions: String((1n << 10n) | (1n << 31n)) },
    app_permissions: String(1n << 10n), authorizing_integration_owners: { '0': guild },
  });
  try {
    const response = await f.mf.dispatchFetch('https://offline.test/interactions', await signed(dynamic(2, 'join')));
    assert.equal((await response.json() as any).type, 5);
    await until(f.inspect, state => jobs(state).length === 1);
    await f.admin('run', { id: snowflake(2) });
    const active = await f.inspect();
    assert.equal(active.session.status, 'ready'); assert.equal(active.fixture.starts, 1);
    assert.deepEqual(active.session.scope, { applicationId: scope.DISCORD_APPLICATION_ID, userId: scope.DISCORD_OWNER_ID,
      guildId: '100000000000000012', channelId: '100000000000000013' });
    const initialReplies = f.outbound.length;
    for (const [i, name] of ['join', 'stop', 'leave', 'say', 'voice-status'].entries()) {
      const reply = await f.mf.dispatchFetch('https://offline.test/interactions', await signed(dynamic(10 + i, name, '100000000000000022', '100000000000000023')));
      assert.equal((await reply.json() as any).type, 5);
    }
    await until(async () => f.outbound.length, count => count === initialReplies + 5);
    const after = await f.inspect();
    assert.deepEqual(after.session, active.session);
    assert.deepEqual(after.tables.voice_usage_days, active.tables.voice_usage_days);
    assert.deepEqual(after.tables.voice_usage_reservation, active.tables.voice_usage_reservation);
    assert.deepEqual(after.tables.voice_scope_control, active.tables.voice_scope_control);
    assert.equal(after.fixture.starts, 1); assert.equal(after.fixture.destroys, active.fixture.destroys);
    assert.deepEqual(after.fixture.commands, active.fixture.commands);
    assert.ok(f.outbound.slice(initialReplies).every(call => (call.body as any).content.includes('別のチャンネル')));
    const forbidden = { ...dynamic(30, 'join'), authorizing_integration_owners: { '1': scope.DISCORD_OWNER_ID } };
    assert.equal((await (await f.mf.dispatchFetch('https://offline.test/interactions', await signed(forbidden))).json() as any).type, 4);
    assert.equal((await f.inspect()).ingressLookups, after.ingressLookups);
  } finally { await f.mf.dispose(); }
});

test('production interactions use real workerd Ed25519, SQLite and intercepted outbound fetch', async t => {
  const script = await bundle();

  await t.test('exact raw UTF-8 bytes are signed, awaited and hashed; invalid and stale signed PING never access BOT', async () => {
    const f = await runtime(script);
    try {
      const raw = JSON.stringify(payload(2), null, 2) + '\n';
      const good = await signed(payload(2), undefined, raw);
      const ping = await signed({ type: 1 });
      assert.deepEqual(await (await f.mf.dispatchFetch('https://offline.test/interactions', ping)).json(), { type: 1 });
      for (const bad of [
        { ...ping, body: ping.body + ' ' },
        { ...ping, headers: { ...ping.headers, 'x-signature-ed25519': '00'.repeat(64) } },
        await signed({ type: 1 }, String((NOW - 61_000) / 1000)),
        await signed({ type: 1 }, String((NOW + 11_000) / 1000)),
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: ping.body },
      ]) assert.equal((await f.mf.dispatchFetch('https://offline.test/interactions', bad)).status, 401);
      const idle = await f.inspect();
      assert.equal(idle.ingressLookups, 0);
      assert.equal(idle.fixture.starts, 0);
      assert.deepEqual(idle.fixture.portCalls, []);
      assert.deepEqual(idle.fixture.schedules, []);
      assert.deepEqual(f.outbound, []);
      const altered = await f.mf.dispatchFetch('https://offline.test/interactions', { ...good, body: raw + ' ' });
      assert.equal(altered.status, 401, 'a JSON-equivalent change to the signed bytes must fail');
      const valid = await f.mf.dispatchFetch('https://offline.test/interactions', good);
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { type: 5, data: { flags: 64 } });
      const accepted = await until(f.inspect, state => jobs(state).length === 1);
      assert.equal(rows(accepted)[0].body_hash, createHash('sha256').update(raw).digest('hex'));
      assert.equal(accepted.fixture.starts, 0, 'admission schedules an ID, never starts the image inline');
    } finally { await f.mf.dispose(); }
  });

  await t.test('concurrent duplicate signed delivery and job execution each have exactly one durable SQL claim', async () => {
    const f = await runtime(script);
    try {
      await f.admin('ready');
      const request = await signed(payload(2));
      const responses = await Promise.all(Array.from({ length: 6 }, () => f.mf.dispatchFetch('https://offline.test/interactions', request)));
      for (const response of responses) assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      const accepted = await until(f.inspect, state => state.ingressLookups === 6 && jobs(state).length === 1);
      assert.equal(rows(accepted).length, 1);
      assert.equal(rows(accepted)[0].state, 'accepted');
      assert.equal(typeof rows(accepted)[0].cipher, 'string');
      assert.doesNotMatch(JSON.stringify(accepted.tables), new RegExp(`${TOKEN}|${TEXT}|${SECRET}`));
      assert.deepEqual(jobs(accepted).map((item: any) => item.payload), [{ id: snowflake(2) }]);
      assert.doesNotMatch(JSON.stringify(accepted.fixture.schedules), new RegExp(`${TOKEN}|${TEXT}|${SECRET}`));
      await Promise.all([f.admin('run', { id: snowflake(2) }), f.admin('run', { id: snowflake(2) })]);
      const complete = await f.inspect();
      assert.equal(complete.fixture.commands.filter((item: any) => item.name === 'say').length, 1);
      assert.equal(rows(complete)[0].cipher, null);
      assert.equal(rows(complete)[0].state, 'complete');
      assert.equal(f.outbound.length, 1);
      assert.equal(f.outbound[0].authorization, null);
      assert.deepEqual((f.outbound[0].body as any).allowed_mentions, { parse: [] });
      assert.equal('token' in complete.fixture.commands[0], false);
      assert.equal(await f.admin('take', { id: snowflake(2) }), null, 'a fresh ledger cannot reclaim executed SQL metadata');
    } finally { await f.mf.dispose(); }
  });

  await t.test('cold join progress edits the same ephemeral original reply without changing admission or durable payloads', async () => {
    const f = await runtime(script);
    try {
      const response = await f.mf.dispatchFetch('https://offline.test/interactions', await signed(payload(2, 'join')));
      assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      const accepted = await until(f.inspect, state => jobs(state).length === 1);
      assert.equal(accepted.fixture.starts, 0); assert.deepEqual(f.outbound, []);
      await f.admin('run', { id: snowflake(2) });
      await f.admin('run', { id: snowflake(2) });
      const complete = await f.inspect();
      assert.equal(complete.fixture.starts, 1);
      assert.deepEqual(complete.fixture.commands.map((command: any) => command.name), ['join']);
      assert.equal(complete.session.status, 'ready');
      assert.equal(rows(complete)[0].state, 'complete'); assert.equal(rows(complete)[0].cipher, null);
      assert.doesNotMatch(JSON.stringify(complete.tables), new RegExp(`${TOKEN}|${SECRET}`));
      assert.deepEqual(f.outbound.map(call => (call.body as any).content), [
        'Botを起動しています。接続の準備中です',
        'Botに接続しました。ボイスチャンネルへ接続中です',
        '合成確認用応答',
      ]);
      for (const call of f.outbound) {
        assert.equal(call.url, `https://discord.com/api/v10/webhooks/${scope.DISCORD_APPLICATION_ID}/${TOKEN}/messages/@original`);
        assert.equal(call.method, 'PATCH'); assert.equal(call.authorization, null);
        assert.deepEqual((call.body as any).allowed_mentions, { parse: [] });
      }
    } finally { await f.mf.dispose(); }
  });

  await t.test('deferred acknowledgement stays below three seconds while startup stalls and newer leave cancels it', async () => {
    const f = await runtime(script);
    try {
      await f.admin('configure', { holdStart: true, runOnSchedule: true });
      const request = await signed(payload(2, 'join'));
      const started = performance.now();
      const response = await f.mf.dispatchFetch('https://offline.test/interactions', request);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      assert.ok(performance.now() - started < 3000, 'the response must not await the blocked production startup/enqueue promise');
      const blocked = await until(f.inspect, state => state.fixture.starts === 1);
      assert.equal(blocked.session.status, 'starting');
      assert.equal(rows(blocked)[0].state, 'executing');
      assert.equal(rows(blocked)[0].cipher, null, 'encrypted material is removed before Container I/O');
      assert.deepEqual(blocked.fixture.commands, []);
      const leave = await f.mf.dispatchFetch('https://offline.test/interactions', await signed(payload(3, 'leave')));
      assert.deepEqual(await leave.json(), { type: 5, data: { flags: 64 } });
      const stopped = await until(f.inspect, state => state.session?.status === 'stopped' &&
        rows(state).some((row: any) => row.id === snowflake(2) && row.state === 'cancelled'));
      assert.equal(stopped.fixture.aborts, 1);
      assert.equal(stopped.running, false);
      assert.ok(stopped.fixture.destroys >= 1);
      assert.deepEqual(stopped.fixture.commands, [], 'neither delayed join nor speech may run after leave');
      assert.ok(rows(stopped).every((row: any) => row.cipher === null));
      await f.admin('run', { id: snowflake(2) });
      assert.deepEqual((await f.inspect()).fixture.commands, []);
    } finally { await f.mf.dispose(); }
  });

  await t.test('short-lived payload expires, executing work becomes uncertain, and bounded replay metadata is purged', async () => {
    const f = await runtime(script);
    try {
      await f.admin('ready');
      for (const n of [2, 3]) await f.mf.dispatchFetch('https://offline.test/interactions', await signed(payload(n)));
      await until(f.inspect, state => rows(state).length === 2);
      assert.ok(await f.admin('take', { id: snowflake(3) }));
      assert.equal(await f.admin('take', { id: snowflake(3) }), null);
      await f.admin('clock', { now: NOW + 90_001 });
      await f.admin('sweep');
      const expired = await f.inspect();
      assert.deepEqual(rows(expired).map((row: any) => [row.id, row.state, row.cipher]), [
        [snowflake(2), 'expired', null], [snowflake(3), 'uncertain', null],
      ]);
      await Promise.all([f.admin('run', { id: snowflake(2) }), f.admin('run', { id: snowflake(3) })]);
      assert.deepEqual((await f.inspect()).fixture.commands, []);
      await f.admin('clock', { now: NOW + 15 * 60_000 + 1 });
      await f.admin('sweep');
      assert.deepEqual(rows(await f.inspect()), []);
      assert.deepEqual(f.outbound, []);
    } finally { await f.mf.dispose(); }
  });

  await t.test('failed deferred reply cannot replay an already delivered command', async () => {
    const f = await runtime(script);
    try {
      f.replyStatus(401);
      await f.admin('ready');
      const request = await signed(payload(2));
      await f.mf.dispatchFetch('https://offline.test/interactions', request);
      await until(f.inspect, state => jobs(state).length === 1);
      await f.admin('run', { id: snowflake(2) });
      await f.admin('run', { id: snowflake(2) });
      await f.mf.dispatchFetch('https://offline.test/interactions', request);
      const failed = await until(f.inspect, state => state.ingressLookups === 2);
      assert.equal(rows(failed)[0].state, 'reply-failed');
      assert.equal(rows(failed)[0].cipher, null);
      assert.equal(failed.fixture.commands.length, 1);
      assert.equal(jobs(failed).length, 1);
      assert.equal(f.outbound.length, 1);
      assert.equal(await f.admin('take', { id: snowflake(2) }), null);
    } finally { await f.mf.dispose(); }
  });

  await t.test('absolute session deadline terminates an otherwise active ready image independently of its idle health', async () => {
    const f = await runtime(script);
    try {
      await f.admin('ready');
      await f.admin('clock', { now: NOW + 30 * 60_000 });
      await f.admin('expire', { sessionId: SID });
      const expired = await f.inspect();
      assert.equal(expired.session.status, 'stopped');
      assert.equal(expired.running, false);
      assert.equal(expired.fixture.destroys, 1);
      assert.equal(expired.fixture.starts, 0);
      assert.deepEqual(f.outbound, []);
    } finally { await f.mf.dispose(); }
  });

  await t.test('signature negative control demonstrates that omitting await accepts an invalid signature', async () => {
    const f = await runtime(await bundle('unawaited-signature'));
    try {
      const request = await signed({ type: 1 });
      request.headers['x-signature-ed25519'] = '00'.repeat(64);
      const response = await f.mf.dispatchFetch('https://offline.test/interactions', request);
      assert.equal(response.status, 200, 'the invalid-signature 401 assertion above must kill this intentional mutation');
      assert.deepEqual(await response.json(), { type: 1 });
    } finally { await f.mf.dispose(); }
  });

  await t.test('execution-claim negative control demonstrates that a missing durable take permits replay', async () => {
    const f = await runtime(await bundle('missing-replay-claim'));
    try {
      await f.admin('ready');
      await f.mf.dispatchFetch('https://offline.test/interactions', await signed(payload(2)));
      await until(f.inspect, state => jobs(state).length === 1);
      const first = await f.admin('take', { id: snowflake(2) });
      const replay = await f.admin('take', { id: snowflake(2) });
      assert.ok(first);
      assert.ok(replay, 'the reconstructed take=null assertion above must kill this intentional mutation');
      assert.equal(first.id, replay.id);
      assert.equal(first.cipher, replay.cipher);
    } finally { await f.mf.dispose(); }
  });
});

test('daily admission cumulatively caps repeated explicit sessions using real workerd SQLite', async () => {
  const f = await runtime(await bundle(), { VOICE_USAGE_MODE: 'daily', VOICE_DEADLINE: '' });
  try {
    for (const [n, elapsed] of [[2, 0], [3, 30 * 60_000], [4, 60 * 60_000]]) {
      const now = NOW + elapsed;
      await f.admin('clock', { now });
      const request = await signed(payload(n, 'join'), String(now / 1000));
      const responses = await Promise.all([f.mf.dispatchFetch('https://offline.test/interactions', request),
        f.mf.dispatchFetch('https://offline.test/interactions', request)]);
      for (const response of responses) assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      await until(f.inspect, state => state.ingressLookups === (n - 1) * 2);
      if (n < 4) {
        const state = await until(f.inspect, state => jobs(state).length === n - 1);
        assert.equal(state.tables.voice_usage_days[0].charged_ms, (n - 1) * 30 * 60_000);
        assert.equal(state.fixture.starts, n - 2, 'budget debit exists before external startup');
        await f.admin('run', { id: snowflake(n) });
        assert.equal((await f.inspect()).session.status, 'ready');
        await f.admin('clock', { now: now + 30 * 60_000 });
        await f.admin('expire', { sessionId: state.session.id });
        assert.equal((await f.inspect()).tables.voice_usage_reservation[0].state, 'settled');
      } else {
        await until(f.inspect, state => state.ingressLookups === 6 && f.outbound.length >= 4);
        const state = await f.inspect();
        assert.equal(state.fixture.starts, 2); assert.equal(state.running, false);
        assert.equal(state.tables.voice_usage_days[0].charged_ms, 60 * 60_000);
        assert.equal(jobs(state).length, 2);
        assert.match(JSON.stringify(f.outbound.at(-1)?.body), /60分/);
      }
    }
  } finally { await f.mf.dispose(); }
});
