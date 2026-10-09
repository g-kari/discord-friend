import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { remainingLifetime } from '../../../apps/voice/src/lifetime.js';
import { SPEECH_LABELS } from '../../../apps/voice/src/speech-status.js';

// This exercises production index.ts and real SQLite. The SDK/container fixture
// models stop-event reconciliation explicitly; it makes no claims about live
// Cloudflare provisioning, SDK lifecycle events, UDP, or Discord connectivity.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('wrangler/package.json'))('esbuild');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = Date.now();
const scope = {
  DISCORD_APPLICATION_ID: '100000000000000001',
  DISCORD_GUILD_ID: '100000000000000002',
  DISCORD_TEXT_CHANNEL_ID: '100000000000000003',
  DISCORD_OWNER_ID: '100000000000000004',
};
const approved = createHash('sha256').update(Object.values(scope).join(':')).digest('hex');
const oldId = '00000000-0000-4000-8000-000000000001';
const newId = '00000000-0000-4000-8000-000000000002';
const revokedTts: string[] = [];
const env = {
  ...scope, BOT_ENABLED: 'true', DISCORD_HTTP_ENABLED: 'true',
  DISCORD_BOT_TOKEN: 'synthetic-adapter-worker-secret',
  VOICE_DEADLINE: new Date(NOW + 300_000).toISOString(),
  VOICE_IDLE_SECONDS: '300', VOICE_SESSION_MINUTES: '5',
  VOICEVOX: { getByName: () => ({ stopSession: async (id: string) => { revokedTts.push(id); }, reconcileExpiredLease: async () => {} }) },
};
const sdk = `
  export class Container {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    async startAndWaitForPorts(options) {
      if (this.ctx.pendingStop) { this.ctx.pendingStop = false; await this.onStop(); }
      this.ctx.starts++;
      this.ctx.startedEnv = options.startOptions.envVars;
      this.ctx.container.running = true;
      this.ctx.actualSession = options.startOptions.envVars.VOICE_SESSION_ID;
      this.ctx.startedScope = { guildId: options.startOptions.envVars.DISCORD_GUILD_ID,
        channelId: options.startOptions.envVars.DISCORD_TEXT_CHANNEL_ID, mode: options.startOptions.envVars.DISCORD_SCOPE_MODE };
    }
    async destroy() { this.ctx.destroys++; this.ctx.container.running = false; }
    async stop() {
      this.ctx.stops++;
      if (this.ctx.pendingStop) { this.ctx.pendingStop = false; await this.onStop(); }
    }
    renewActivityTimeout() { this.ctx.renews++; }
    async schedule(time, callback, payload) { this.ctx.schedules.push({ time, callback, payload }); return {}; }
    async fetch() { this.ctx.starts++; this.ctx.container.running = true; return new Response('inherited start'); }
  }
  export class ContainerProxy {}
`;
const built = await build({
  entryPoints: [`${ROOT}src/index.ts`], bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{
    name: 'synthetic-container-adapter',
    setup(builder: any) {
      builder.onResolve({ filter: /^@cloudflare\/containers$/ }, () => ({ path: 'sdk', namespace: 'fixture' }));
      builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'workers', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, (args: { path: string }) => ({
        contents: args.path === 'sdk' ? sdk : 'export class WorkerEntrypoint {}', loader: 'js',
      }));
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
    },
  }],
});
const { DiscordBot, Voicevox } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

function context() {
  const db = new DatabaseSync(':memory:');
  const ctx = {
    startedEnv: {} as Record<string, string>, starts: 0, destroys: 0, stops: 0, renews: 0, schedules: [] as any[], healthStatus: 200,
    pendingStop: false, actualSession: null as string | null, failHealth: false, health: {} as Record<string, unknown>,
    storage: {
      sql: {
        exec(query: string, ...args: (string | number | null)[]) {
          const statement = db.prepare(query);
          const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
          return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
        },
      },
      sync: async () => {},
    },
    container: {
      running: false,
      getTcpPort() {
        return {
          fetch: async () => {
            if (ctx.failHealth) throw new Error('SYNTHETIC_UNAVAILABLE');
            return Response.json({ sessionId: ctx.actualSession, ready: true, voice: 'ready',
              queued: 0, idleAt: Date.now() + 60_000, ...ctx.health }, { status: ctx.healthStatus });
          },
        };
      },
    },
  };
  return { ctx, db };
}
const session = () => ({ id: newId, status: 'starting', controlId: '100000000000000020',
  deadline: NOW + 240_000, createdAt: NOW });
const speech = () => new Request('http://tts.internal/v1/speech', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"text":"synthetic"}',
});

test('Bot idle renewal requires ready Gateway health and the active bounded session deadline', async () => {
  for (const health of [
    { ready: true, deadline: session().deadline, idleAt: NOW + 120_000 },
    { ready: false, deadline: session().deadline, idleAt: NOW + 120_000 },
    { ready: true, deadline: session().deadline + 1, idleAt: NOW + 120_000 },
    { ready: true, deadline: session().deadline, idleAt: session().deadline + 1 },
    { ready: true, deadline: session().deadline, idleAt: NOW - 1 },
    { ready: true, deadline: session().deadline, idleAt: Infinity },
    { ready: true, deadline: session().deadline, idleAt: 'future' },
  ]) {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession({ ...session(), status: 'ready' }); bot.setImageLease(newId);
      f.ctx.actualSession = newId; f.ctx.container.running = true; f.ctx.health = health;
      f.ctx.healthStatus = health.ready ? 200 : 503;
      await bot.onActivityExpired();
      const valid = health.ready && health.deadline === session().deadline &&
        typeof health.idleAt === 'number' && health.idleAt > NOW && health.idleAt <= session().deadline;
      assert.equal(f.ctx.renews, valid ? 1 : 0);
      assert.equal(f.ctx.destroys, valid ? 0 : 1);
      assert.equal(bot.commandLedger.session().status, valid ? 'ready' : 'stopped');
      assert.equal(f.ctx.starts, 0);
    } finally { f.db.close(); }
  }
});

test('installed adapter binds startup, private invocation and shutdown to the image generation scope', async () => {
  const f = context(); const scopeA = { applicationId: scope.DISCORD_APPLICATION_ID, userId: scope.DISCORD_OWNER_ID,
    guildId: '100000000000000012', channelId: '100000000000000013' };
  const calls: Record<string, unknown>[] = [];
  f.ctx.container.getTcpPort = () => ({ fetch: async (input: any, init: any) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === '/health') return Response.json({ sessionId: f.ctx.actualSession, ready: true, voice: 'ready' });
    calls.push(await request.json() as Record<string, unknown>);
    return Response.json({ content: 'ok', joined: true });
  } }) as any;
  try {
    const bot = new DiscordBot(f.ctx, { ...env, DISCORD_SCOPE_MODE: 'installed-guilds' });
    const active = { ...session(), id: oldId, scope: scopeA }; bot.commandLedger.setSession(active);
    await bot.startSession(active, new AbortController().signal);
    assert.deepEqual((f.ctx as any).startedScope, { guildId: scopeA.guildId, channelId: scopeA.channelId, mode: 'installed-guilds' });
    assert.deepEqual(bot.imageScope(oldId), scopeA);
    await assert.rejects(bot.invokeCommand({ ...scopeA, channelId: scope.DISCORD_TEXT_CHANNEL_ID, sessionId: oldId, name: 'stop', id: active.controlId }, new AbortController().signal), /SESSION_STOPPED/);
    assert.deepEqual(calls, []);
    bot.commandLedger.setSession({ ...active, id: newId, status: 'stopped', scope: { ...scopeA, guildId: '100000000000000022', channelId: '100000000000000023' } });
    await bot.destroySession(newId);
    assert.deepEqual(calls, [{ sessionId: oldId, ...scopeA }]);
    assert.equal(f.ctx.starts, 1); assert.equal(f.ctx.destroys, 1);
  } finally { f.db.close(); }
});

test('installed owner voice choice never applies to another author or expired session', async () => {
  const f = context();
  try {
    const bot = new DiscordBot(f.ctx, { ...env, DISCORD_SCOPE_MODE: 'installed-guilds' });
    bot.commandLedger.setSession({ ...session(), status: 'ready', scope: {
      applicationId: scope.DISCORD_APPLICATION_ID, userId: scope.DISCORD_OWNER_ID,
      guildId: '100000000000000012', channelId: '100000000000000013',
    } });
    await bot.ownerModel.command([{ id: 8, name: '声', style: 'ノーマル' }], { id: '100000000000000030', speakerId: 8 }, new AbortController().signal);
    assert.equal(await bot.getSpeechModel(newId, scope.DISCORD_OWNER_ID), 8);
    assert.equal(await bot.getSpeechModel(newId, '100000000000000099'), undefined);
    assert.equal(await bot.getSpeechModel(oldId, scope.DISCORD_OWNER_ID), undefined);
  } finally { f.db.close(); }
});

test('installed-mode housekeeping reclaims an unscoped legacy generation without startup', async () => {
  const f = context();
  try {
    const bot = new DiscordBot(f.ctx, { ...env, DISCORD_SCOPE_MODE: 'installed-guilds' });
    bot.commandLedger.setSession({ ...session(), status: 'ready' });
    bot.setImageLease(newId); f.ctx.actualSession = newId; f.ctx.container.running = true;
    await bot.sweepCommandJobs();
    assert.equal(bot.commandLedger.session().status, 'stopped'); assert.equal(f.ctx.starts, 0);
    assert.ok(f.ctx.destroys > 0); assert.equal(bot.imageLease(), null);
  } finally { f.db.close(); }
});

test('voice status renders fixed speech phases without starting or touching either runtime', async () => {
  const f = context();
  try {
    const bot = new DiscordBot(f.ctx, env);
    bot.commandLedger.setSession({ ...session(), status: 'ready' });
    bot.setImageLease(newId); f.ctx.actualSession = newId; f.ctx.container.running = true;
    const before = bot.commandLedger.session();
    for (const [phase, label] of Object.entries(SPEECH_LABELS)) {
      f.ctx.health = { speechPhase: phase, queued: 3 };
      assert.equal(await bot.sessionStatus(newId), `${label} / 待機: 3件`);
    }
    assert.equal(f.ctx.starts, 0); assert.deepEqual(f.ctx.schedules, []);
    assert.deepEqual(bot.commandLedger.session(), before);
  } finally { f.db.close(); }
});
test('voice status falls back for old or invalid health and never relays arbitrary status text', async () => {
  const f = context();
  try {
    const bot = new DiscordBot(f.ctx, env);
    f.ctx.actualSession = newId; f.ctx.container.running = true;
    for (const phase of [undefined, null, '', 'toString', '__proto__', 'unknown', 'synthetic_private_status', {}, 'x'.repeat(1000)]) {
      f.ctx.health = { speechPhase: phase, queued: 2 };
      assert.equal(await bot.sessionStatus(newId), '音声接続: 接続中 / 待機: 2');
    }
    for (const queued of [-1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1, null]) {
      f.ctx.health = { speechPhase: 'idle', queued };
      assert.equal(await bot.sessionStatus(newId), '読み上げ待機中 / 待機: 0件');
    }
    f.ctx.health = { ready: false, speechPhase: 'speaking' };
    assert.equal(await bot.sessionStatus(newId), 'Gateway接続を確認できません');
    f.ctx.health = { sessionId: oldId, speechPhase: 'speaking' };
    assert.equal(await bot.sessionStatus(newId), '現在は未接続です');
    f.ctx.health = { speechPhase: 'speaking' }; f.ctx.container.running = false;
    assert.equal(await bot.sessionStatus(newId), '現在は未接続です');
    assert.equal(f.ctx.starts, 0); assert.deepEqual(f.ctx.schedules, []);
  } finally { f.db.close(); }
});

test('production adapters reclaim ended resources without implicit starts', async t => {
  await t.test('an owned process exit still destroys the owned resource', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession({ ...session(), status: 'stopped' });
      bot.setImageLease(newId);
      f.ctx.container.running = false;
      await bot.destroySession(newId);
      assert.equal(f.ctx.destroys, 1);
      assert.equal(f.ctx.starts, 0);
    } finally { f.db.close(); }
  });

  await t.test('Container fetch cannot implicitly start either application', async () => {
    for (const Adapter of [DiscordBot, Voicevox]) {
      const f = context();
      try {
        const adapter = new Adapter(f.ctx, env);
        assert.equal((await adapter.fetch(new Request('http://private.invalid/health'))).status, 404);
        assert.equal(f.ctx.starts, 0);
      } finally { f.db.close(); }
    }
  });

  await t.test('onStop keeps ownership until cleanup and a delayed cleanup cannot kill a new image', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession({ ...session(), id: oldId });
      bot.setImageLease(oldId);
      await bot.onStop();
      assert.equal(bot.imageLease(), oldId);
      const cleanup = f.ctx.schedules.find(row => row.callback === 'cleanupStoppedImage');
      assert.ok(cleanup);
      bot.commandLedger.setSession(session());
      bot.setImageLease(newId);
      await bot.cleanupStoppedImage(cleanup.payload);
      assert.equal(bot.imageLease(), newId);
      assert.equal(f.ctx.destroys, 0);
    } finally { f.db.close(); }
  });

  await t.test('cleanup of the ended image discards its resource even after process exit', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession({ ...session(), status: 'stopped' });
      bot.setImageLease(newId);
      await bot.cleanupStoppedImage({ sessionId: newId });
      assert.equal(f.ctx.destroys, 1);
      assert.equal(bot.imageLease(), null);
      assert.equal(f.ctx.starts, 0);
    } finally { f.db.close(); }
  });

  await t.test('TTS expiry is independently durable and a stale callback preserves an RSS lease', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const expired = Date.now() - 1;
      tts.setLease(newId, expired);
      const lease = tts.leaseState;
      await tts.expireSpeechLease({ ...lease, sessionId: oldId });
      assert.equal(f.ctx.destroys, 0);
      await tts.expireSpeechLease(lease);
      assert.equal(f.ctx.destroys, 1);
      assert.equal(tts.lease, null);
      assert.equal(tts.revoked(newId), false);
      tts.setLease('rss-service-binding', Date.now() + 30_000);
      await tts.reconcileExpiredLease();
      assert.equal(tts.lease, 'rss-service-binding');
      assert.equal(f.ctx.destroys, 1);
      assert.equal(f.ctx.starts, 0);
    } finally { f.db.close(); }
  });

  await t.test('the TTS deadline is saved and scheduled before any engine startup', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const deadline = Date.now() + 60_000;
      tts.startAndWaitForPorts = async () => {
        const expiry = f.ctx.schedules.find(row => row.callback === 'expireSpeechLease');
        assert.equal(expiry.payload.sessionId, newId);
        assert.equal(expiry.payload.deadline, deadline);
        assert.equal(f.db.prepare('SELECT deadline FROM voice_tts_lease').get()?.deadline, deadline);
        f.ctx.container.running = true;
      };
      assert.equal((await tts.scopedSpeech(speech(), newId, deadline)).status, 200);
    } finally { f.db.close(); }
  });

  await t.test('expiry preserves a renewed RSS lease for the same reusable identity', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const oldDeadline = Date.now() - 1;
      const newDeadline = Date.now() + 30_000;
      tts.setLease('rss-service-binding', newDeadline);
      await tts.expireSpeechLease({ ...tts.leaseState, deadline: oldDeadline });
      assert.equal(f.ctx.destroys, 0);
      assert.equal(tts.lease, 'rss-service-binding');
      assert.equal(tts.revoked('rss-service-binding'), false);
    } finally { f.db.close(); }
  });

  await t.test('failed TTS destruction preserves ownership and re-arms a durable deadline', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const deadline = Date.now() - 1;
      tts.setLease(newId, deadline);
      const lease = tts.leaseState;
      tts.destroy = async () => { throw new Error('SYNTHETIC_DESTROY_REJECTED'); };
      await assert.rejects(tts.expireSpeechLease(lease), /VOICE_CLEANUP_UNAVAILABLE/);
      assert.equal(tts.lease, newId);
      assert.equal(tts.speechAbort, null);
      assert.ok(f.ctx.schedules.some(row => row.callback === 'expireSpeechLease' && row.payload.deadline === deadline));
      tts.destroy = async () => { f.ctx.destroys++; f.ctx.container.running = false; };
      await tts.expireSpeechLease(lease);
      assert.equal(tts.lease, null);
      assert.equal(f.ctx.destroys, 1);
    } finally { f.db.close(); }
  });

  await t.test('housekeeping reclaims unleased resources without starting them', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      await bot.sweepCommandJobs();
      assert.equal(f.ctx.destroys, 1);
      assert.equal(f.ctx.starts, 0);
      const tts = new Voicevox(f.ctx, env);
      await tts.reconcileExpiredLease();
      assert.equal(f.ctx.destroys, 2);
      assert.equal(f.ctx.starts, 0);
    } finally { f.db.close(); }
  });

  await t.test('new speech cannot enter while old lease destruction is awaiting completion', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const expired = Date.now() - 1;
      tts.setLease(oldId, expired);
      const lease = tts.leaseState;
      let finishDestroy!: () => void;
      let entered!: () => void;
      const destroyEntered = new Promise<void>(resolve => { entered = resolve; });
      tts.destroy = async () => { await new Promise<void>(resolve => { finishDestroy = resolve; entered(); }); f.ctx.destroys++; };
      const ending = tts.expireSpeechLease(lease);
      await destroyEntered;
      assert.equal((await tts.scopedSpeech(speech(), newId, Date.now() + 30_000)).status, 429);
      assert.equal(f.ctx.starts, 0);
      assert.equal(tts.lease, oldId);
      finishDestroy();
      await ending;
      assert.equal(tts.lease, null);
      assert.equal((await tts.scopedSpeech(speech(), newId, Date.now() + 30_000)).status, 200);
      assert.equal(tts.lease, newId);
      assert.equal(f.ctx.starts, 1);
    } finally { f.db.close(); }
  });

  await t.test('TTS predecessor stop is reconciled before the next lease is published', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      tts.setLease(oldId, Date.now() - 1);
      let observedLease: string | null = null;
      tts.stop = async () => { observedLease = tts.lease; await tts.onStop(); };
      assert.equal((await tts.scopedSpeech(speech(), newId, Date.now() + 30_000)).status, 200);
      assert.equal(observedLease, oldId);
      const cleanup = f.ctx.schedules.find(row => row.callback === 'cleanupStoppedLease');
      assert.equal(cleanup.payload.sessionId, oldId);
      f.ctx.container.running = false;
      await tts.cleanupStoppedLease(cleanup.payload);
      assert.equal(tts.lease, newId);
      assert.equal(f.ctx.destroys, 1, 'only predecessor resource was destroyed');
    } finally { f.db.close(); }
  });

  await t.test('a transient failed RSS attempt does not revoke the reusable service identity', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const deadline = Date.now() + 30_000;
      f.ctx.failHealth = true;
      assert.equal((await tts.scopedSpeech(speech(), 'rss-service-binding', deadline)).status, 503);
      assert.equal(tts.revoked('rss-service-binding'), false);
      f.ctx.failHealth = false;
      assert.equal((await tts.scopedSpeech(speech(), 'rss-service-binding', deadline)).status, 200);
      assert.equal(tts.lease, 'rss-service-binding');
    } finally { f.db.close(); }
  });

  await t.test('failed cleanup cannot destroy a later RSS attempt with the same identity and deadline', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      const deadline = Date.now() + 30_000;
      f.ctx.failHealth = true;
      tts.destroy = async () => { throw new Error('SYNTHETIC_DESTROY_REJECTED'); };
      assert.equal((await tts.scopedSpeech(speech(), 'rss-service-binding', deadline)).status, 503);
      const retry = f.ctx.schedules.find(row => row.callback === 'retryFailedLease');
      assert.ok(retry);
      f.ctx.failHealth = false;
      tts.destroy = async () => { f.ctx.destroys++; f.ctx.container.running = false; };
      assert.equal((await tts.scopedSpeech(speech(), 'rss-service-binding', deadline)).status, 200);
      const successor = tts.leaseState;
      assert.notEqual(successor.generation, retry.payload.generation);
      await tts.retryFailedLease(retry.payload);
      assert.equal(f.ctx.destroys, 0);
      assert.equal(f.ctx.container.running, true);
      assert.deepEqual(tts.leaseState, successor);
    } finally { f.db.close(); }
  });

  await t.test('overlapping expiry and stop serialize destruction and hold admission until every cleanup settles', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      tts.setLease(oldId, Date.now() - 1);
      const lease = tts.leaseState;
      let entered!: () => void, finishDestroy!: () => void;
      const enteredDestroy = new Promise<void>(resolve => { entered = resolve; });
      let rawDestroys = 0;
      tts.destroy = async () => { rawDestroys++; await new Promise<void>(resolve => { finishDestroy = resolve; entered(); }); f.ctx.destroys++; };
      const expiry = tts.expireSpeechLease(lease);
      await enteredDestroy;
      const stopping = tts.stopSession(oldId);
      assert.equal((await tts.scopedSpeech(speech(), newId, Date.now() + 30_000)).status, 429);
      finishDestroy();
      await Promise.all([expiry, stopping]);
      assert.equal(rawDestroys, 1, 'a second destroy cannot resolve first and reopen admission');
      assert.equal(tts.pendingCleanup, 0);
      assert.equal(tts.lease, null);
      assert.equal((await tts.scopedSpeech(speech(), newId, Date.now() + 30_000)).status, 200);
      assert.equal(tts.lease, newId);
    } finally { f.db.close(); }
  });
});

test('production Container adapter reconciles ownership and persistent TTS revocation offline', async t => {
  await t.test('reconciles the predecessor stop before publishing the new image lease', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession(session());
      bot.setImageLease(oldId);
      f.ctx.pendingStop = true;
      await bot.startSession(session(), new AbortController().signal);
      assert.equal(bot.commandLedger.session().status, 'starting');
      assert.equal(bot.imageLease(), newId);
      assert.equal(f.ctx.starts, 1);
      assert.equal(f.ctx.stops, 1);
      assert.equal(f.ctx.pendingStop, false);
    } finally { f.db.close(); }
  });

  await t.test('a reconstructed Bot retains durable ownership of the running image', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession(session());
      await bot.startSession(session(), new AbortController().signal);
      const reconstructed = new DiscordBot(f.ctx, env);
      assert.equal(reconstructed.imageLease(), newId);
      assert.equal(f.db.prepare('SELECT session_id FROM voice_bot_image_lease').get()?.session_id, newId);
    } finally { f.db.close(); }
  });

  await t.test('an old stop with unavailable health preserves the current generation', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession(session());
      await bot.startSession(session(), new AbortController().signal);
      const reconstructed = new DiscordBot(f.ctx, env);
      f.ctx.failHealth = true;
      await reconstructed.destroySession(oldId);
      assert.equal(f.ctx.container.running, true);
      assert.equal(f.ctx.destroys, 0);
      assert.equal(reconstructed.imageLease(), newId);
    } finally { f.db.close(); }
  });

  await t.test('a current stop with unavailable health destroys the owned generation', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession(session());
      await bot.startSession(session(), new AbortController().signal);
      const reconstructed = new DiscordBot(f.ctx, env);
      f.ctx.failHealth = true;
      const priorRevocations = revokedTts.length;
      await reconstructed.destroySession(newId);
      assert.equal(f.ctx.container.running, false);
      assert.equal(f.ctx.destroys, 1);
      assert.deepEqual(revokedTts.slice(priorRevocations), [newId]);
    } finally { f.db.close(); }
  });

  await t.test('persistent TTS revocation rejects a delayed request after reconstruction', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      await tts.stopSession(newId);
      const reconstructed = new Voicevox(f.ctx, env);
      assert.equal((await reconstructed.scopedSpeech(speech(), newId, NOW + 240_000)).status, 503);
      assert.equal(f.ctx.starts, 0);
      assert.equal(f.db.prepare('SELECT session_id FROM voice_tts_revoked').get()?.session_id, newId);
    } finally { f.db.close(); }
  });
  await t.test('the current stopped successor cleans up a predecessor after admission fails', async () => {
    const f = context();
    try {
      const bot = new DiscordBot(f.ctx, env);
      bot.commandLedger.setSession({ ...session(), status: 'stopped' });
      bot.setImageLease(oldId);
      f.ctx.container.running = true;
      f.ctx.failHealth = true;
      const priorRevocations = revokedTts.length;
      await bot.destroySession(newId);
      assert.equal(f.ctx.container.running, false);
      assert.equal(f.ctx.destroys, 1);
      assert.deepEqual(revokedTts.slice(priorRevocations), [newId, oldId]);
    } finally { f.db.close(); }
  });

  await t.test('a prestart destroy failure clears speech admission for the next request', async () => {
    const f = context();
    try {
      const tts = new Voicevox(f.ctx, env);
      f.ctx.container.running = true;
      tts.setLease(oldId);
      tts.destroy = async () => { throw new Error('SYNTHETIC_DESTROY_REJECTED'); };
      assert.equal((await tts.scopedSpeech(speech(), newId, NOW + 240_000)).status, 503);
      assert.equal(tts.speechAbort, null);
      assert.equal(f.ctx.starts, 0);
      assert.equal(tts.lease, oldId);
      assert.equal((await tts.scopedSpeech(speech(), newId, NOW + 240_000)).status, 503,
        'a failed admission must not leave the subsequent request permanently busy');
    } finally { f.db.close(); }
  });
});

const models = [{ id: 999, name: '春日部つむぎ', style: 'ノーマル' }, { id: 8, name: 'ずんだもん', style: 'あまあま' }];
const modelCommand = (n: number, speakerId?: number) => ({ id: String(100000000000000000n + BigInt(n)),
  applicationId: scope.DISCORD_APPLICATION_ID, guildId: scope.DISCORD_GUILD_ID,
  channelId: scope.DISCORD_TEXT_CHANNEL_ID, userId: scope.DISCORD_OWNER_ID, name: 'model',
  ...(speakerId === undefined ? {} : { speakerId }) });

test('production model command stays offline, validates owner scope and persists the owner choice across restarts', async () => {
  const f = context(); const tts = new Voicevox(f.ctx, env);
  const modelEnv = { ...env, BOT_ENABLED: 'false', VOICE_DEADLINE: '', VOICEVOX: { getByName: () => tts } };
  try {
    const bot = new DiscordBot(f.ctx, modelEnv);
    assert.match(await bot.modelCommand(modelCommand(30), new AbortController().signal), /一覧はまだありません/);
    assert.equal(f.ctx.starts, 0); assert.equal(f.ctx.destroys, 0);
    await tts.modelCatalog.save(models);
    assert.match(await bot.modelCommand(modelCommand(31, 8), new AbortController().signal), /ずんだもん/);
    assert.equal(f.ctx.starts, 0);
    const resumed = new DiscordBot(f.ctx, { ...modelEnv, BOT_ENABLED: env.BOT_ENABLED, VOICE_DEADLINE: env.VOICE_DEADLINE }); resumed.commandLedger.setSession({ ...session(), status: 'ready' });
    assert.equal(await resumed.getSpeechModel(newId, scope.DISCORD_OWNER_ID), 8);
    assert.equal(await resumed.getSpeechModel(newId, '100000000000000099'), undefined);
    assert.equal(await resumed.getSpeechModel(oldId, scope.DISCORD_OWNER_ID), undefined);
    assert.match(await resumed.modelCommand(modelCommand(32, 1234), new AbortController().signal), /一覧にありません/);
    assert.equal(await resumed.getSpeechModel(newId, scope.DISCORD_OWNER_ID), 8);
    await assert.rejects(resumed.modelCommand({ ...modelCommand(33, 999), userId: '100000000000000099' }, new AbortController().signal), /MODEL_SCOPE_MISMATCH/);
    assert.equal(f.ctx.starts, 0);
  } finally { f.db.close(); }
});
test('catalog is learned from an authorized speech attempt and remains available after the TTS image stops', async () => {
  const f = context(); let fetches = 0;
  f.ctx.container.getTcpPort = () => ({ fetch: async (input: any) => {
    fetches++; const path = new URL(typeof input === 'string' ? input : input.url).pathname;
    if (path === '/v1/models') return Response.json({ catalog: models });
    assert.equal(path, '/v1/speech'); return new Response('synthetic-audio');
  } });
  try {
    const tts = new Voicevox(f.ctx, env); assert.equal(await tts.getModelCatalog(), null); assert.equal(fetches, 0);
    assert.equal((await tts.scopedSpeech(speech(), newId, NOW + 240_000)).status, 200);
    assert.equal(fetches, 2); assert.equal(f.ctx.starts, 1);
    f.ctx.container.running = false;
    const restored = new Voicevox(f.ctx, env); assert.deepEqual(await restored.getModelCatalog(), models);
    assert.equal(f.ctx.starts, 1); assert.equal(fetches, 2);
  } finally { f.db.close(); }
});
test('cancelled model metadata lookup cannot persist a new selection or stop a voice session', async () => {
  const f = context(); let release: any;
  const catalog = new Promise(resolve => { release = resolve; });
  const modelEnv = { ...env, VOICEVOX: { getByName: () => ({ getModelCatalog: () => catalog }) } };
  try {
    const bot = new DiscordBot(f.ctx, modelEnv); bot.commandLedger.setSession({ ...session(), status: 'ready' });
    const controller = new AbortController(); const work = bot.modelCommand(modelCommand(31, 8), controller.signal);
    controller.abort(); release(models); await assert.rejects(work);
    assert.equal(bot.ownerModel.get(), undefined); assert.equal(bot.commandLedger.session().status, 'ready');
    assert.equal(f.ctx.starts, 0); assert.equal(f.ctx.destroys, 0);
  } finally { f.db.close(); }
});
test('production outbound speech applies the saved voice to owner messages only and strips forged style headers', async () => {
  const f = context(); const forwarded: Request[] = [];
  try {
    const bot = new DiscordBot(f.ctx, env); bot.commandLedger.setSession({ ...session(), status: 'ready' });
    await bot.ownerModel.command(models, modelCommand(31, 8), new AbortController().signal);
    const routedEnv = { ...env,
      BOT: { idFromName: () => ({ toString: () => 'synthetic-bot-id' }), getByName: () => bot },
      VOICEVOX: { getByName: () => ({ scopedSpeech: async (request: Request) => { forwarded.push(request); return new Response('audio'); } }) },
    };
    for (const authorId of [scope.DISCORD_OWNER_ID, '100000000000000099']) {
      const request = new Request('http://tts.internal/v1/speech', { method: 'POST', body: '{"text":"synthetic"}',
        headers: { 'content-type': 'application/json', 'x-voice-session-id': newId, 'x-voice-author-id': authorId, 'x-voice-speaker-id': '111' } });
      assert.equal((await DiscordBot.outboundByHost['tts.internal'](request, routedEnv, { className: 'DiscordBot', containerId: 'synthetic-bot-id' })).status, 200);
    }
    assert.equal(forwarded[0].headers.get('x-voice-speaker-id'), '8'); assert.equal(forwarded[1].headers.get('x-voice-speaker-id'), null);
    assert.equal(forwarded[0].headers.get('x-voice-author-id'), null); assert.equal(await forwarded[0].text(), '{"text":"synthetic"}');
  } finally { f.db.close(); }
});

const dailyEnv = { ...env, VOICE_USAGE_MODE: 'daily', VOICE_DEADLINE: '', VOICE_SESSION_MINUTES: '480' };
test('daily Bot startup requires a persisted reservation, not just a fabricated session', async () => {
  const f = context();
  try {
    const bot = new DiscordBot(f.ctx, dailyEnv); bot.commandLedger.setSession(session());
    await assert.rejects(bot.startSession(session(), new AbortController().signal), /SESSION_STOPPED/);
    assert.equal(f.ctx.starts, 0);
    bot.commandLedger.usage.reserve(newId, Date.now(), session().deadline);
    await bot.startSession(session(), new AbortController().signal);
    assert.equal(f.ctx.starts, 1);
  } finally { f.db.close(); }
});
test('daily usage is refunded only after both Bot and TTS resource cleanup, never on process exit or failed destroy', async () => {
  const f = context(); let ttsFailure = false;
  const guardedEnv = { ...dailyEnv, VOICEVOX: { getByName: () => ({ stopSession: async () => {
    if (ttsFailure) throw new Error('SYNTHETIC_TTS_CLEANUP_FAILED');
  } }) } };
  try {
    const bot = new DiscordBot(f.ctx, guardedEnv);
    const admittedAt = Date.now() - 60_000;
    bot.commandLedger.usage.reserve(newId, admittedAt, session().deadline);
    bot.commandLedger.setSession({ ...session(), status: 'stopped' }); bot.setImageLease(newId);
    const before = bot.commandLedger.usage.remaining(admittedAt);
    await bot.onStop();
    assert.equal(bot.commandLedger.usage.remaining(admittedAt), before, 'process exit is not resource reclamation');
    bot.destroy = async () => { throw new Error('SYNTHETIC_DESTROY_FAILED'); };
    await assert.rejects(bot.destroySession(newId), /SYNTHETIC_DESTROY_FAILED/);
    assert.equal(bot.commandLedger.usage.reservation().state, 'reserved');
    bot.destroy = async () => { f.ctx.container.running = false; }; ttsFailure = true;
    await assert.rejects(bot.destroySession(newId), /SYNTHETIC_TTS_CLEANUP_FAILED/);
    assert.equal(bot.commandLedger.usage.remaining(admittedAt), before);
    const restart = new DiscordBot(f.ctx, guardedEnv);
    ttsFailure = false; await restart.destroySession(newId);
    assert.equal(restart.commandLedger.usage.reservation().state, 'settled');
    const remaining = restart.commandLedger.usage.remaining(admittedAt);
    assert.ok(remaining > before && remaining <= 479 * 60_000);
    await restart.destroySession(newId);
    assert.equal(restart.commandLedger.usage.remaining(admittedAt), remaining, 'cleanup retries cannot refund twice');
    assert.equal(f.ctx.starts, 0);
  } finally { f.db.close(); }
});
test('daily TTS rejects RSS and unreserved Discord requests while retaining independently bounded valid leases', async () => {
  const f = context(); let admitted = false; const deadline = Date.now() + 60_000;
  const guardedEnv = { ...dailyEnv, BOT: { getByName: () => ({ getSpeechLease: async () => admitted ? { deadline, startedAt: NOW } : null }) } };
  try {
    const tts = new Voicevox(f.ctx, guardedEnv);
    assert.equal((await tts.scopedSpeech(speech(), 'rss-service-binding', deadline)).status, 503);
    assert.equal((await tts.scopedSpeech(speech(), newId, deadline)).status, 503);
    assert.equal(f.ctx.starts, 0);
    admitted = true;
    assert.equal((await tts.scopedSpeech(speech(), newId, deadline)).status, 200);
    await tts.reconcileExpiredLease();
    assert.equal(tts.lease, newId);
    assert.equal(f.ctx.starts, 1);
    await tts.stopSession(newId);
    assert.equal((await tts.scopedSpeech(speech(), newId, deadline)).status, 503);
    assert.equal(f.ctx.starts, 1);
  } finally { f.db.close(); }
});

test('daily Bot and TTS receive the original eight-hour reservation across rejoin and reconstruction', async () => {
  const originalClock = Date.now; let now = Date.parse('2026-10-03T08:00:00Z'); Date.now = () => now;
  const startedAt = now, deadline = startedAt + 8 * 60 * 60_000;
  const f = context(), speechContext = context();
  try {
    let bot = new DiscordBot(f.ctx, dailyEnv);
    bot.commandLedger.usage.reserve(newId, now, deadline);
    let active = { ...session(), createdAt: now, deadline, status: 'ready' };
    bot.commandLedger.setSession(active);
    await bot.startSession(active, new AbortController().signal);
    assert.equal(f.ctx.startedEnv.VOICE_USAGE_MODE, 'daily');
    assert.equal(remainingLifetime(f.ctx.startedEnv.VOICE_DEADLINE, now, f.ctx.startedEnv), 8 * 60 * 60_000);
    now += 60 * 60_000;
    const successor = '00000000-0000-4000-8000-000000000003';
    bot.commandLedger.usage.reserve(successor, now, now + 8 * 60 * 60_000, newId);
    active = { ...active, id: successor, createdAt: now };
    bot.commandLedger.setSession(active);
    bot = new DiscordBot(f.ctx, dailyEnv);
    await bot.startSession(active, new AbortController().signal);
    assert.equal(f.ctx.startedEnv.VOICE_SESSION_STARTED_AT, new Date(startedAt).toISOString());
    assert.equal(f.ctx.startedEnv.VOICE_DEADLINE, new Date(deadline).toISOString());
    assert.equal(remainingLifetime(f.ctx.startedEnv.VOICE_DEADLINE, now, f.ctx.startedEnv), 7 * 60 * 60_000);
    const tts = new Voicevox(speechContext.ctx, { ...dailyEnv, BOT: { getByName: () => bot } });
    assert.equal((await tts.scopedSpeech(speech(), successor, deadline)).status, 200);
    assert.equal(speechContext.ctx.startedEnv.VOICE_USAGE_MODE, 'daily');
    assert.equal(speechContext.ctx.startedEnv.VOICE_SESSION_STARTED_AT, new Date(startedAt).toISOString());
    assert.equal(remainingLifetime(speechContext.ctx.startedEnv.VOICE_DEADLINE, now, speechContext.ctx.startedEnv), 7 * 60 * 60_000);
    now = deadline;
    assert.equal(await bot.getSpeechLease(successor), null);
    assert.equal((await tts.scopedSpeech(speech(), successor, deadline)).status, 503);
    await bot.expireCommandSession({ sessionId: successor });
    assert.equal(bot.commandLedger.session().status, 'stopped');
    assert.equal(bot.commandLedger.usage.remaining(now), 0);
  } finally { Date.now = originalClock; f.db.close(); speechContext.db.close(); }
});
test('daily TTS refuses invalid original bounds even when the remaining deadline fits eight hours', async () => {
  const originalClock = Date.now; const now = Date.parse('2026-10-03T12:00:00Z'); Date.now = () => now;
  const deadline = now + 60_000;
  try {
    for (const startedAt of [undefined, now + 1, deadline - 8 * 60 * 60_000 - 1]) {
      const f = context();
      try {
        const tts = new Voicevox(f.ctx, { ...dailyEnv, BOT: { getByName: () => ({ getSpeechLease: async () => ({ deadline, startedAt }) }) } });
        assert.equal((await tts.scopedSpeech(speech(), newId, deadline)).status, 503);
        assert.equal(f.ctx.starts, 0);
      } finally { f.db.close(); }
    }
  } finally { Date.now = originalClock; }
});
test('TTS revocation survives reconstruction past the former thirty-one-minute horizon', async () => {
  const originalClock = Date.now; let now = Date.parse('2026-10-03T08:00:00Z'); Date.now = () => now;
  const start = now, deadline = now + 8 * 60 * 60_000, f = context();
  const guarded = { ...dailyEnv, BOT: { getByName: () => ({ getSpeechLease: async () => ({ deadline, startedAt: start }) }) } };
  try {
    const tts = new Voicevox(f.ctx, guarded); await tts.stopSession(newId);
    const revoked = f.db.prepare('SELECT expires_at FROM voice_tts_revoked WHERE session_id=?').get(newId);
    assert.equal(revoked.expires_at, deadline + 60_000);
    for (const elapsed of [31 * 60_000, 7 * 60 * 60_000, 8 * 60 * 60_000 - 1]) {
      now = start + elapsed;
      const restored = new Voicevox(f.ctx, guarded);
      assert.equal((await restored.scopedSpeech(speech(), newId, deadline)).status, 503);
    }
    assert.equal(f.ctx.starts, 0);
  } finally { Date.now = originalClock; f.db.close(); }
});
