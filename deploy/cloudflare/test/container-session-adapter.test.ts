import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

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
  VOICEVOX: { getByName: () => ({ stopSession: async (id: string) => { revokedTts.push(id); } }) },
};
const sdk = `
  export class Container {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
    async startAndWaitForPorts(options) {
      if (this.ctx.pendingStop) { this.ctx.pendingStop = false; await this.onStop(); }
      this.ctx.starts++;
      this.ctx.container.running = true;
      this.ctx.actualSession = options.startOptions.envVars.VOICE_SESSION_ID;
    }
    async destroy() { this.ctx.destroys++; this.ctx.container.running = false; }
    async stop() {
      this.ctx.stops++;
      if (this.ctx.pendingStop) { this.ctx.pendingStop = false; await this.onStop(); }
    }
    renewActivityTimeout() {}
    async schedule() { return {}; }
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
    },
  }],
});
const { DiscordBot, Voicevox } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

function context() {
  const db = new DatabaseSync(':memory:');
  const ctx = {
    starts: 0, destroys: 0, stops: 0,
    pendingStop: false, actualSession: null as string | null, failHealth: false,
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
              queued: 0, idleAt: Date.now() + 60_000 });
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
