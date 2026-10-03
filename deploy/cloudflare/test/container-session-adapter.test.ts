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
