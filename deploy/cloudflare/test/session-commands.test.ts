import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scopeFingerprint } from '../src/guild-setup.ts';
import { InteractionLedger, sealCommand, openCommand } from '../src/interaction-ledger.ts';
import { SessionCommands, commandRuntimeActive, modelMetadataActive } from '../src/session-commands.ts';
import type { InteractionCommand } from '../src/interactions.ts';
import { APPROVED_SCOPE_FINGERPRINT } from '../src/guild-setup.ts';
import { createCommandService } from '../../../apps/voice/src/command-service.js';
import { APPROVED_BOT_SCOPE } from '../../../apps/voice/src/startup-policy.js';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const SID = '10000000-0000-4000-8000-000000000001';
const env = { BOT_ENABLED: 'true', DISCORD_HTTP_ENABLED: 'true', VOICE_DEADLINE: new Date(NOW+30*60_000).toISOString(), VOICE_IDLE_SECONDS: '300', VOICE_SESSION_MINUTES: '30',
  DISCORD_BOT_TOKEN: 'synthetic_worker_secret', DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_GUILD_ID: '100000000000000002', DISCORD_TEXT_CHANNEL_ID: '100000000000000003', DISCORD_OWNER_ID: '100000000000000004' };
const snowflake = (n: number) => String(100000000000000000n + BigInt(n));
function command(n: number, name: InteractionCommand['name'] = 'say', now = NOW): InteractionCommand {
  return { id: snowflake(n), applicationId: env.DISCORD_APPLICATION_ID, guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_TEXT_CHANNEL_ID, userId: env.DISCORD_OWNER_ID, name,
    ...(name === 'say' ? { text: 'synthetic_private_speech' } : {}), token: 'synthetic_interaction_reply_token', receivedAt: now, bodyHash: String(n).padStart(64, '0') };
}
function fixture(overrides: Record<string, unknown> = {}, replyStatus = 200, replyRequest?: typeof fetch) {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(sql: string, ...params: (string|number|null)[]) {
    const stmt = db.prepare(sql); const rows = stmt.columns().length ? stmt.all(...params) : (stmt.run(...params), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, sync: async () => {} };
  const ledger = new InteractionLedger(storage); let now = NOW;
  const calls: { name: string; id?: string }[] = []; const jobs: string[] = []; const replyContents: string[] = []; let replies = 0;
  const runtime = {
    start: async (session: {id:string}) => { calls.push({ name: 'start', id: session.id }); },
    invoke: async (value: { name:string; id:string }) => { calls.push({ name: value.name, id: value.id }); return { content: '合成確認用応答', joined: value.name === 'join' }; },
    status: async () => '接続中', destroy: async (id: string) => { calls.push({ name: 'destroy', id }); },
    scheduleJob: async (id: string) => { jobs.push(id); }, scheduleExpiry: async () => {}, scheduleSweep: async () => {}, scheduleStop: async () => {}, ...overrides,
  };
  const request: typeof fetch = async (url, init) => {
    replies++; replyContents.push(JSON.parse(String(init?.body)).content);
    assert.equal(init?.redirect, 'manual');
    assert.equal(init?.method, 'PATCH');
    assert.equal(String(url), `https://discord.com/api/v10/webhooks/${env.DISCORD_APPLICATION_ID}/synthetic_interaction_reply_token/messages/@original`);
    assert.deepEqual(JSON.parse(String(init?.body)).allowed_mentions, { parse: [] });
    return replyRequest ? replyRequest(url, init) : new Response(null, { status: replyStatus });
  };
  const engine = new SessionCommands(env, ledger, runtime, request, () => now, scopeFingerprint(env));
  const ready = () => ledger.setSession({ id: SID, status: 'ready', controlId: snowflake(1), deadline: NOW+30*60_000, createdAt: NOW });
  return { db, storage, runtime, request, ledger, engine, calls, jobs, replyContents, ready, setNow: (value:number) => { now=value; }, replies: () => replies };
}
test('existing secret-derived authenticated encryption protects token/text and binds the command ID', async () => {
  const value = command(2); const cipher = await sealCommand(value, env.DISCORD_BOT_TOKEN);
  assert.doesNotMatch(cipher, /synthetic_/); assert.deepEqual(await openCommand(cipher, value.id, env.DISCORD_BOT_TOKEN), value);
  await assert.rejects(openCommand(cipher, snowflake(3), env.DISCORD_BOT_TOKEN));
  await assert.rejects(openCommand(cipher, value.id, 'synthetic_wrong_key'));
  assert.notEqual(await sealCommand(value, env.DISCORD_BOT_TOKEN), cipher, 'fresh random nonce on every seal');
});
test('concurrent duplicate delivery durably claims one speech operation with no plaintext SQL payload', async () => {
  const f=fixture(); f.ready(); const value=command(2);
  await Promise.all([f.engine.enqueue(value), f.engine.enqueue(value)]);
  assert.deepEqual(f.jobs, [value.id]);
  assert.doesNotMatch(JSON.stringify(f.db.prepare('SELECT * FROM voice_interaction_jobs').all()), /synthetic_private_speech|synthetic_interaction_reply_token|synthetic_worker_secret/);
  await f.engine.run(value.id); await f.engine.run(value.id);
  assert.equal(f.calls.filter(x=>x.name==='say').length, 1);
  assert.equal(f.db.prepare('SELECT cipher FROM voice_interaction_jobs').get()?.cipher, null);
});
test('a queued older say cannot refill the audio queue after stop, including reconstruction', async () => {
  const f=fixture(); f.ready(); await f.engine.enqueue(command(2)); await f.engine.enqueue(command(3,'stop'));
  await f.engine.run(snowflake(2));
  assert.deepEqual(f.calls.map(x=>x.name), ['stop']);
  assert.equal(f.ledger.session()?.controlId, snowflake(3));
  assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'cancelled');
});
test('fresh-state leave and stop durably cancel an older first join across reconstruction and full metadata capacity', async () => {
  for (const control of ['leave', 'stop'] as const) {
    for (const full of [false, true]) {
      const f = fixture();
      if (full) {
        const insert = f.db.prepare('INSERT INTO voice_interaction_jobs(id, body_hash, created_at, payload_expires, dedup_expires, state) VALUES(?, ?, ?, ?, ?, ?)');
        for (let n = 100; n < 356; n++) insert.run(snowflake(n), String(n), NOW, NOW, NOW + 15 * 60_000, 'complete');
      }
      await f.engine.enqueue(command(3, control));
      assert.equal(f.ledger.session(), null);
      assert.equal(f.db.prepare('SELECT control_id FROM voice_command_control WHERE id = 1').get()?.control_id, snowflake(3));
      const reconstructed = new InteractionLedger(f.storage);
      const engine = new SessionCommands(env, reconstructed, f.runtime, f.request, () => NOW, scopeFingerprint(env));
      await engine.enqueue(command(2, 'join'));
      await engine.run(snowflake(2));
      assert.equal(reconstructed.session(), null);
      assert.deepEqual(f.jobs, []);
      assert.equal(f.calls.filter(call => call.name === 'start' || call.name === 'join').length, 0);
      assert.equal(f.db.prepare('SELECT cipher FROM voice_interaction_jobs WHERE id = ?').get(snowflake(2)), undefined);
      if (!full) {
        await engine.enqueue(command(4, 'join'));
        await engine.run(snowflake(4));
        assert.equal(reconstructed.session()?.status, 'ready');
        assert.deepEqual(f.calls.map(call => call.name), ['start', 'join']);
      }
      f.db.close();
    }
  }
});
test('leave remains available after the full per-minute quota and cancels before any encrypted payload', async () => {
  const f=fixture(); f.ready();
  for(let n=2;n<=11;n++){await f.engine.enqueue(command(n,'voice-status'));await f.engine.run(snowflake(n));}
  await f.engine.enqueue(command(12,'leave'));
  assert.equal(f.ledger.session()?.status, 'stopped'); assert.equal(f.ledger.session()?.controlId, snowflake(12));
  assert.equal(f.calls.at(-1)?.name, 'destroy');
  assert.equal(f.db.prepare('SELECT cipher FROM voice_interaction_jobs WHERE id=?').get(snowflake(12))?.cipher, null);
});
test('leave during a blocked cold start aborts it and prevents late join or speech', async () => {
  let entered!:()=>void; const began=new Promise<void>(resolve=>{entered=resolve;});
  const f=fixture({start:async (_session:unknown, signal:AbortSignal)=>{entered();await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('SYNTHETIC_ABORT')),{once:true}));}});
  await f.engine.enqueue(command(2,'join'));const work=f.engine.run(snowflake(2));await began;
  await f.engine.enqueue(command(3,'leave'));await work;
  assert.equal(f.ledger.session()?.status,'stopped');assert.equal(f.calls.filter(x=>x.name==='join').length,0);
  assert.ok(f.calls.some(x=>x.name==='destroy'));
});
const STARTING = 'Botを起動しています。接続の準備中です';
const CONNECTING = 'Botに接続しました。ボイスチャンネルへ接続中です';
test('cold join edits only its original ephemeral reply in stage order and keeps the same operation deadline', async () => {
  const stages: string[] = []; let startSignal: AbortSignal | undefined;
  const f = fixture({
    start: async (_session: unknown, signal: AbortSignal) => { stages.push('start'); startSignal = signal; },
    invoke: async (_command: unknown, signal: AbortSignal) => {
      stages.push('join'); assert.equal(signal, startSignal);
      return { content: '接続しました', joined: true };
    },
  }, 200, async (_url, init) => {
    stages.push(JSON.parse(String(init?.body)).content);
    assert.equal(f.db.prepare('SELECT cipher FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.cipher, null);
    assert.ok(init?.signal);
    return new Response(null, { status: 200 });
  });
  await f.engine.enqueue(command(2, 'join'));
  assert.deepEqual(stages, [], 'admission never waits for progress or starts the image');
  await f.engine.run(snowflake(2)); await f.engine.run(snowflake(2));
  assert.deepEqual(stages, [STARTING, 'start', CONNECTING, 'join', '接続しました']);
  assert.equal(f.ledger.session()?.status, 'ready');
  assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'complete');
});
test('rejected or failed progress delivery is best effort and never repeats a runtime operation', async () => {
  for (const failure of ['http', 'network'] as const) {
    let edits = 0;
    const f = fixture({}, 200, async () => {
      if (++edits <= 2) {
        if (failure === 'network') throw new Error('SYNTHETIC_PROGRESS_FAILURE');
        return new Response(null, { status: 401 });
      }
      return new Response(null, { status: 200 });
    });
    await f.engine.enqueue(command(2, 'join'));
    await f.engine.run(snowflake(2)); await f.engine.run(snowflake(2));
    assert.deepEqual(f.calls.map(call => call.name), ['start', 'join']);
    assert.deepEqual(f.replyContents, [STARTING, CONNECTING, '合成確認用応答']);
    assert.equal(f.ledger.session()?.status, 'ready');
    assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'complete');
  }
});
test('leave or stop interrupts either progress PATCH before any further start or invoke', { timeout: 15000 }, async () => {
  for (const stage of [STARTING, CONNECTING]) {
    for (const control of ['leave', 'stop'] as const) {
      let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
      let progressSignal: AbortSignal | undefined;
      const f = fixture({}, 200, async (_url, init) => {
        if (JSON.parse(String(init?.body)).content === stage) {
          progressSignal = init?.signal ?? undefined; entered();
          await new Promise<void>((_resolve, reject) => progressSignal!.addEventListener('abort', () => reject(new Error('SYNTHETIC_PROGRESS_ABORT')), { once: true }));
        }
        return new Response(null, { status: 200 });
      });
      await f.engine.enqueue(command(2, 'join'));
      const work = f.engine.run(snowflake(2)); await began;
      await f.engine.enqueue(command(3, control)); await work;
      assert.equal(progressSignal?.aborted, true);
      assert.equal(f.calls.filter(call => call.name === 'start').length, stage === STARTING ? 0 : 1);
      assert.equal(f.calls.filter(call => call.name === 'join').length, 0);
      assert.equal(f.ledger.session()?.status, 'stopped');
      assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'cancelled');
      assert.ok(f.replyContents.includes('処理を中止しました'), 'cancellation must still replace the original progress reply');
    }
  }
});
test('late progress cannot start or invoke after generation replacement, job expiry or session expiry', async () => {
  for (const stage of [STARTING, CONNECTING]) {
    for (const race of ['generation', 'job-expiry', 'session-expiry'] as const) {
      let entered!: () => void; const began = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
      const f = fixture({}, 200, async (_url, init) => {
        if (JSON.parse(String(init?.body)).content === stage) { entered(); await blocked; }
        return new Response(null, { status: 200 });
      });
      await f.engine.enqueue(command(2, 'join'));
      const work = f.engine.run(snowflake(2)); await began;
      if (race === 'generation') f.ledger.setSession({ ...f.ledger.session()!, id: SID, controlId: snowflake(3), status: 'ready' });
      else if (race === 'job-expiry') f.setNow(NOW + 90_001);
      else f.ledger.setSession({ ...f.ledger.session()!, deadline: NOW });
      release(); await work;
      assert.equal(f.calls.filter(call => call.name === 'start').length, stage === STARTING ? 0 : 1);
      assert.equal(f.calls.filter(call => call.name === 'join').length, 0);
      assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'cancelled');
      if (race === 'generation') {
        assert.equal(f.ledger.session()?.id, SID); assert.equal(f.ledger.session()?.status, 'ready');
        assert.equal(f.calls.filter(call => call.name === 'destroy').length, 0, 'an older progress reply cannot tear down the replacement');
      }
    }
  }
});
test('startup and voice-connect failures replace progress with the final failure reply', async () => {
  for (const phase of ['start', 'invoke']) {
    const f = fixture({ [phase]: async () => { throw new Error('SYNTHETIC_RUNTIME_FAILURE'); } });
    await f.engine.enqueue(command(2, 'join')); await f.engine.run(snowflake(2));
    assert.deepEqual(f.replyContents, [STARTING, ...(phase === 'invoke' ? [CONNECTING] : []), '接続または処理に失敗しました。もう一度操作してください']);
    assert.equal(f.ledger.session()?.status, 'stopped');
    assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'failed');
  }
});
test('failed final join reply cannot repeat a completed connection or its progress edits', async () => {
  const f = fixture({}, 401);
  await f.engine.enqueue(command(2, 'join')); await f.engine.run(snowflake(2)); await f.engine.run(snowflake(2));
  assert.deepEqual(f.calls.map(call => call.name), ['start', 'join']);
  assert.deepEqual(f.replyContents, [STARTING, CONNECTING, '合成確認用応答']);
  assert.equal(f.ledger.session()?.status, 'ready');
  assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state, 'reply-failed');
});
test('failed ready-stop delivery fails closed and requests termination of that generation', async () => {
  const f=fixture({invoke:async()=>{throw new Error('synthetic_private_failure');}});f.ready();
  await f.engine.enqueue(command(2,'stop'));assert.equal(f.ledger.session()?.status,'stopped');
  assert.ok(f.calls.some(x=>x.name==='destroy'));
});
test('a failed reply cannot reexecute a successfully delivered speech operation', async () => {
  const f=fixture({},401);f.ready();await f.engine.enqueue(command(2));await f.engine.run(snowflake(2));await f.engine.run(snowflake(2));
  assert.equal(f.calls.filter(x=>x.name==='say').length,1);assert.equal(f.replies(),1);
  assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state,'reply-failed');
});
test('quiet expiry purges encrypted payload and a taken executing claim cannot replay after reconstruction', async () => {
  const f=fixture();f.ready();await f.engine.enqueue(command(2));const job=f.ledger.take(snowflake(2),NOW);assert.ok(job);
  assert.equal(f.ledger.take(snowflake(2),NOW),null);
  f.setNow(NOW+90_001);await f.engine.sweep();
  const row=f.db.prepare('SELECT state,cipher FROM voice_interaction_jobs WHERE id=?').get(snowflake(2));
  assert.equal(row?.state,'uncertain');assert.equal(row?.cipher,null);assert.equal(f.ledger.take(snowflake(2),NOW+90_001),null);
  f.setNow(NOW+15*60_000+1);await f.engine.sweep();assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM voice_interaction_jobs').get()?.count,0);
});
test('schedule failure removes payload and cannot leave a new session admitted to runtime', async () => {
  const f=fixture({scheduleJob:async()=>{throw new Error('SYNTHETIC_SCHEDULE_FAILURE');}});
  await f.engine.enqueue(command(2,'join'));assert.equal(f.ledger.session()?.status,'stopped');
  const row=f.db.prepare('SELECT state,cipher FROM voice_interaction_jobs WHERE id=?').get(snowflake(2));assert.equal(row?.state,'failed');assert.equal(row?.cipher,null);
  assert.equal(f.calls.filter(x=>x.name==='start').length,0);
});
test('rejoin gets a new generation without extending the previous active absolute deadline', async () => {
  const f=fixture();f.ready();f.ledger.setSession({...f.ledger.session()!,deadline:NOW+5*60_000});
  f.setNow(NOW+31_000);await f.engine.enqueue(command(2,'join',NOW+31_000));
  assert.notEqual(f.ledger.session()?.id,SID);assert.equal(f.ledger.session()?.deadline,NOW+5*60_000);
});
test('disabled, unbounded, missing credentials or incorrect fixed scope never admit commands',()=>{
  assert.equal(commandRuntimeActive(env,NOW,scopeFingerprint(env)),true);
  for(const override of [{BOT_ENABLED:'false'},{DISCORD_HTTP_ENABLED:'false'},{VOICE_DEADLINE:''},{VOICE_DEADLINE:new Date(NOW+30*60_000+1).toISOString()},{DISCORD_BOT_TOKEN:''},{VOICE_IDLE_SECONDS:'601'},{VOICE_SESSION_MINUTES:'31'},{DISCORD_OWNER_ID:'100000000000000099'}]){
    assert.equal(commandRuntimeActive({...env,...override},NOW,scopeFingerprint(env)),false);
  }
});
test('Worker and independent Bot image pin exactly the same approved scope',()=>{
  assert.equal(APPROVED_BOT_SCOPE,APPROVED_SCOPE_FINGERPRINT);
});
test('encrypted payload cannot be opened when asynchronous key/decryption crosses its access deadline',async()=>{
  const value=command(2);const cipher=await sealCommand(value,env.DISCORD_BOT_TOKEN);
  await assert.rejects(openCommand(cipher,value.id,env.DISCORD_BOT_TOKEN,NOW,()=>NOW),/JOB_EXPIRED/);
  let checks=0;
  await assert.rejects(openCommand(cipher,value.id,env.DISCORD_BOT_TOKEN,NOW+1,()=>++checks>=2?NOW+1:NOW),/JOB_EXPIRED/);
  checks=0;
  await assert.rejects(openCommand(cipher,value.id,env.DISCORD_BOT_TOKEN,NOW+1,()=>++checks>=3?NOW+1:NOW),/JOB_EXPIRED/);
  const f=fixture();await f.engine.enqueue(command(2,'join'));f.setNow(NOW+89_999);
  f.ledger.sync=async()=>{if(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state==='executing')f.setNow(NOW+90_001);};
  await f.engine.run(snowflake(2));
  assert.equal(f.db.prepare('SELECT state FROM voice_interaction_jobs WHERE id=?').get(snowflake(2))?.state,'cancelled');
  assert.equal(f.ledger.session()?.status,'stopped');assert.equal(f.calls.filter(call=>call.name==='start'||call.name==='join').length,0);assert.equal(f.replies(),0);
  const corrupted=fixture();await corrupted.engine.enqueue(command(2,'join'));
  corrupted.db.prepare('UPDATE voice_interaction_jobs SET cipher=? WHERE id=?').run('invalid.cipher',snowflake(2));
  await corrupted.engine.run(snowflake(2));assert.equal(corrupted.ledger.session()?.status,'stopped');
  assert.equal(corrupted.calls.filter(call=>call.name==='start').length,0);
});


test('model metadata jobs work while disconnected without a bot start and remain deduplicated', async () => {
  let models = 0;
  const f = fixture({ model: async () => { models++; return 'VOICEVOX:合成テスト'; } });
  const value = { ...command(2, 'model'), speakerId: 8 };
  await f.engine.enqueue(value); await f.engine.run(value.id); await f.engine.run(value.id);
  assert.equal(models, 1); assert.deepEqual(f.calls, []); assert.equal(f.ledger.session(), null);
});
test('model metadata failure or cancellation preserves an existing voice session', async () => {
  const f = fixture({ model: async () => { throw new Error('SYNTHETIC_CATALOG_UNAVAILABLE'); } }); f.ready();
  await f.engine.enqueue(command(2, 'model')); await f.engine.run(snowflake(2));
  assert.equal(f.ledger.session()?.status, 'ready'); assert.deepEqual(f.calls, []);
});


test('model jobs alone stay available with disabled or expired voice runtime without starting or altering sessions', async () => {
  for (const patch of [{ BOT_ENABLED: 'false', VOICE_DEADLINE: '' }, { VOICE_DEADLINE: new Date(NOW - 1).toISOString() }]) {
    let models = 0; const f = fixture({ model: async () => { models++; return '保存済み一覧'; } });
    const inactive = { ...env, ...patch };
    assert.equal(commandRuntimeActive(inactive, NOW, scopeFingerprint(env)), false);
    assert.equal(modelMetadataActive(inactive, scopeFingerprint(env)), true);
    const engine = new SessionCommands(inactive, f.ledger, f.runtime, f.request, () => NOW, scopeFingerprint(env));
    await engine.enqueue(command(2, 'model')); await engine.run(snowflake(2));
    await engine.enqueue(command(3, 'join')); await engine.run(snowflake(3));
    assert.equal(models, 1); assert.deepEqual(f.calls, []); assert.equal(f.ledger.session(), null);
    f.db.close();
  }
  for (const patch of [{ DISCORD_HTTP_ENABLED: 'false' }, { DISCORD_BOT_TOKEN: '' }, { DISCORD_OWNER_ID: '100000000000000099' }]) {
    assert.equal(modelMetadataActive({ ...env, ...patch }, scopeFingerprint(env)), false);
  }
});

test('a full private command cache reports busy through the Worker without tearing down the ready session', async () => {
  let now = NOW, dispatched = 0;
  const image = createCommandService({
    scope: { applicationId: env.DISCORD_APPLICATION_ID, guildId: env.DISCORD_GUILD_ID,
      channelId: env.DISCORD_TEXT_CHANNEL_ID, userId: env.DISCORD_OWNER_ID },
    sessionId: SID, deadline: NOW + 30 * 60_000, ready: () => true, voiceStatus: () => 'ready', queued: () => 0,
    dispatch: async () => { dispatched++; return { content: 'image response', joined: true }; },
    cancelJoin: () => {}, shutdown: () => {}, now: () => now,
  });
  const invoke = async (value: unknown) => {
    const response = await image.handler(new Request('http://bot.internal/v1/command', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }));
    if (!response.ok) throw new Error('PRIVATE_COMMAND_FAILED');
    return await response.json();
  };
  for (let n = 1; n <= 256; n++) {
    const { token, receivedAt, bodyHash, ...value } = command(n, 'voice-status');
    await invoke({ ...value, sessionId: SID });
  }
  const f = fixture({ invoke }); f.ready();
  try {
    const before = f.ledger.session();
    await f.engine.enqueue(command(300)); await f.engine.run(snowflake(300));
    assert.match(f.replyContents.at(-1)!, /混み合/);
    assert.deepEqual(f.ledger.session(), before); assert.deepEqual(f.calls, []); assert.equal(dispatched, 256);
    now += 15 * 60_000; f.setNow(now); image.touch();
    await f.engine.enqueue(command(301, 'say', now)); await f.engine.run(snowflake(301));
    assert.equal(f.replyContents.at(-1), 'image response');
    assert.deepEqual(f.ledger.session(), before); assert.deepEqual(f.calls, []); assert.equal(dispatched, 257);
  } finally { f.db.close(); }
});
