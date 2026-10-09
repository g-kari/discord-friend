import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandService } from '../src/command-service.js';

const NOW=Date.parse('2026-10-02T12:00:00Z');
const scope={applicationId:'100000000000000001',guildId:'100000000000000002',channelId:'100000000000000003',userId:'100000000000000004'};
const sessionId='10000000-0000-4000-8000-000000000001';
const id=n=>String(100000000000000000n+BigInt(n));
const command=(n,name='say')=>({...scope,sessionId,id:id(n),name,...(name==='say'?{text:'こんにちは'}:{})});
const request=body=>new Request('http://bot.internal/v1/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function fixture(dispatch=async value=>({content:'確認しました',joined:value.name==='join'}), options={}){
  let now=NOW,ends=0,cancels=0;const calls=[];
  const service=createCommandService({scope,sessionId,deadline:NOW+30*60_000,idleSeconds:300,ready:()=>true,voiceStatus:()=> 'ready',queued:()=>0,...options,
    dispatch:async(...args)=>{calls.push(args[0].name);return dispatch(...args);},cancelJoin:()=>{cancels++;},shutdown:()=>{ends++;},now:()=>now});
  return{service,calls,setNow:value=>{now=value;},ends:()=>ends,cancels:()=>cancels};
}
test('private command ingress independently enforces session and all fixed identity fields',async()=>{
  const f=fixture();for(const key of ['sessionId','applicationId','guildId','channelId','userId']){
    const response=await f.service.handler(request({...command(2),[key]:'wrong'}));assert.equal(response.status,403);
  }assert.deepEqual(f.calls,[]);
});
test('concurrent duplicate say invokes speech exactly once and rejects ID/payload changes',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=fixture(async()=>{await pending;return{content:'確認しました',joined:true};});
  const one=f.service.handler(request(command(2)));const two=f.service.handler(request(command(2)));await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.calls,['say']);finish();assert.equal((await one).status,200);assert.equal((await two).status,200);
  assert.equal((await f.service.handler(request({...command(2),text:'違う文章'}))).status,409);
});
test('private stop takes priority at full dedup capacity and rejects any older delayed say',async()=>{
  const f=fixture();for(let n=1;n<=256;n++)assert.equal((await f.service.handler(request(command(n,'voice-status')))).status,200);
  assert.equal((await f.service.handler(request(command(400,'stop')))).status,200);assert.equal(f.calls.at(-1),'stop');
  await f.service.handler(request(command(399)));assert.equal(f.calls.filter(name=>name==='say').length,0);assert.equal(f.cancels(),1);
});
test('leave accepted during delayed join prevents a late joined response',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;});const f=fixture(async value=>{if(value.name==='join')await pending;return{content:'確認しました',joined:value.name==='join'};});
  const join=f.service.handler(request(command(1,'join')));await new Promise(resolve=>setImmediate(resolve));
  await f.service.handler(request(command(2,'leave')));finish();assert.equal((await(await join).json()).joined,false);assert.equal(f.cancels(),1);
});
test('stop/leave/rejoin cancels a say waiting for speaker lookup without refilling the cleared queue',async()=>{
  for (const control of ['stop','leave','join']) {
    let finish;const memberLookup=new Promise(resolve=>{finish=resolve;});const queued=[];let oldSignal;
    const f=fixture(async(value,signal)=>{
      if(value.name==='say'){
        oldSignal=signal;
        await memberLookup;
        signal.throwIfAborted(); // Production checks this directly after member lookup.
        queued.push(value.text);
      }else queued.length=0;
      return{content:'確認しました',joined:true};
    });
    const oldSay=f.service.handler(request(command(1)));
    await new Promise(resolve=>setImmediate(resolve));
    await f.service.handler(request(command(2,control)));
    assert.equal(oldSignal.aborted,true);
    finish();
    assert.equal((await(await oldSay).json()).content,'読み上げを中止しました');
    assert.deepEqual(queued,[]);
    await f.service.handler(request(command(3)));
    assert.deepEqual(queued,['こんにちは']); // New speech is still admitted.
  }
});
test('session end aborts an accepted say still waiting for its speaker lookup',async()=>{
  let finish;const memberLookup=new Promise(resolve=>{finish=resolve;});let queued=0,signal;
  const f=fixture(async(_value,pendingSignal)=>{signal=pendingSignal;await memberLookup;signal.throwIfAborted();queued++;return{content:'確認しました',joined:true};});
  const oldSay=f.service.handler(request(command(1)));
  await new Promise(resolve=>setImmediate(resolve));
  f.service.end();assert.equal(signal.aborted,true);finish();
  await oldSay;assert.equal(queued,0);assert.equal(f.ends(),1);
});
test('idle health checks do not extend inactivity and valid activity cannot extend the absolute cap',async()=>{
  const f=fixture();f.setNow(NOW+299_000);await f.service.handler(new Request('http://bot.internal/health'));assert.equal(f.service.idleAt,NOW+300_000);
  f.setNow(NOW+300_000);assert.equal(f.service.checkIdle(),true);assert.equal(f.ends(),1);f.service.touch();assert.equal(f.service.checkIdle(),true);assert.equal(f.ends(),1);
  const active=fixture();active.setNow(NOW+29*60_000);active.service.touch();assert.equal(active.service.idleAt,NOW+30*60_000);
});
test('invalid say, unknown fields, arbitrary paths and malformed bodies never execute voice operations',async()=>{
  const f=fixture();for(const body of [{...command(2),text:'a'.repeat(501)},{...command(2),token:'must-not-be-forwarded'},{...command(2),name:'status'}]){
    assert.ok((await f.service.handler(request(body))).status>=400);
  }
  assert.equal((await f.service.handler(new Request('http://bot.internal/engine/dictionary'))).status,404);assert.deepEqual(f.calls,[]);
});
test('private shutdown verifies the fixed session then closes it without a new Discord interaction ID',async()=>{
  const f=fixture();
  const shutdown=body=>new Request('http://bot.internal/v1/shutdown',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await f.service.handler(shutdown({...scope,sessionId:'wrong'}))).status,403);assert.equal(f.ends(),0);
  assert.equal((await f.service.handler(shutdown({...scope,sessionId}))).status,200);assert.equal(f.ends(),1);assert.deepEqual(f.calls,[]);
});

test('status command and speech-phase health observation do not extend the idle deadline', async () => {
  const f = fixture(); f.setNow(NOW + 299_000);
  await f.service.handler(request(command(1, 'voice-status')));
  assert.equal(f.service.idleAt, NOW + 300_000);
  const body = await (await f.service.handler(new Request('http://bot.internal/health'))).json();
  assert.equal(body.speechPhase, 'disconnected');
  assert.equal(f.service.idleAt, NOW + 300_000);
  f.setNow(NOW + 300_000); assert.equal(f.service.checkIdle(), true);
});

test('daily private commands enforce eight-hour absolute expiry without changing five-minute idle semantics', async () => {
  let now = NOW, ended = 0;
  const options = { scope, sessionId, deadline: NOW + 8 * 60 * 60_000, usageMode: 'daily', startedAt: NOW,
    idleSeconds: 300, ready: () => true, voiceStatus: () => 'ready', queued: () => 0,
    dispatch: async () => ({ content: 'ok', joined: true }), cancelJoin: () => {}, shutdown: () => { ended++; }, now: () => now };
  const service = createCommandService(options);
  for (let elapsed = 4 * 60_000; elapsed < 8 * 60 * 60_000; elapsed += 4 * 60_000) {
    now = NOW + elapsed; assert.equal(service.checkIdle(), false); service.touch();
  }
  assert.equal(service.idleAt, options.deadline);
  now = options.deadline;
  assert.equal((await service.handler(request(command(1)))).status, 503);
  assert.equal(ended, 1); service.touch(); assert.equal(service.checkIdle(), true); assert.equal(ended, 1);
  now = NOW;
  const idle = createCommandService(options);
  now += 299_000;
  await idle.handler(request(command(2, 'voice-status')));
  await idle.handler(new Request('http://bot.internal/health'));
  assert.equal(idle.idleAt, NOW + 300_000);
  now++; assert.equal(idle.checkIdle(), false);
  now = NOW + 300_000; assert.equal(idle.checkIdle(), true);
  now = NOW;
  for (const patch of [{ usageMode: 'trial' }, { usageMode: 'unknown' }, { startedAt: undefined },
    { startedAt: NOW + 1 }, { deadline: options.deadline + 1 }, { idleSeconds: 301 }]) {
    assert.throws(() => createCommandService({ ...options, ...patch }), /INVALID_COMMAND_SESSION/);
  }
});

test('eight hours of admitted commands remain usable beyond the old process-lifetime capacity', async () => {
  const f = fixture(undefined, { deadline: NOW + 8 * 60 * 60_000, usageMode: 'daily', startedAt: NOW });
  let n = 0;
  for (let minute = 0; minute < 480; minute++) {
    f.setNow(NOW + minute * 60_000);
    for (let inMinute = 0; inMinute < 10; inMinute++) {
      const response = await f.service.handler(request(command(++n)));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).content, '確認しました');
    }
  }
  assert.equal(f.calls.length, 4800); assert.equal(f.ends(), 0);
  assert.equal((await (await f.service.handler(new Request('http://bot.internal/health'))).json()).ready, true);
  f.setNow(NOW + 8 * 60 * 60_000);
  assert.equal((await f.service.handler(request(command(++n)))).status, 503);
  assert.equal(f.calls.length, 4800); assert.equal(f.ends(), 1);
});
test('retirement rejects expired and out-of-order old IDs while preserving current duplicate results', async () => {
  const f = fixture();
  await f.service.handler(request(command(10)));
  f.setNow(NOW + 60_000); await f.service.handler(request(command(9)));
  // Occupancy or another valid activity can keep the original session alive.
  f.setNow(NOW + 15 * 60_000); f.service.touch();
  await f.service.handler(request(command(20)));
  assert.equal(f.calls.length, 3);
  assert.equal((await (await f.service.handler(request(command(9)))).json()).content, '確認しました');
  for (const value of [command(10), { ...command(10), text: '変更された本文' }, command(8)]) {
    const response = await f.service.handler(request(value));
    assert.equal(response.status, 200); assert.match((await response.json()).content, /有効期限/);
  }
  assert.equal(f.calls.length, 3);
  f.setNow(NOW + 16 * 60_000); f.service.touch();
  assert.match((await (await f.service.handler(request(command(9)))).json()).content, /有効期限/);
  assert.equal((await f.service.handler(request({ ...command(20), text: '変更された本文' }))).status, 409);
  await f.service.handler(request(command(21)));
  assert.equal(f.calls.length, 4); assert.equal(f.ends(), 0);
});
test('full cache replies busy without ending the session or spending an execution, and capacity returns after expiry', async () => {
  const f = fixture();
  for (let n = 1; n <= 256; n++) await f.service.handler(request(command(n)));
  const busy = await f.service.handler(request(command(300)));
  assert.equal(busy.status, 200);
  assert.deepEqual(await busy.json(), { content: '操作が混み合っています。少し待って再試行してください', joined: false });
  assert.equal(f.calls.length, 256); assert.equal(f.ends(), 0);
  assert.equal((await (await f.service.handler(request(command(256)))).json()).content, '確認しました');
  f.setNow(NOW + 15 * 60_000); f.service.touch();
  assert.equal((await (await f.service.handler(request(command(300)))).json()).content, '確認しました');
  assert.equal(f.calls.length, 257); assert.equal(f.ends(), 0);
});
test('in-flight entries retain bounded slots beyond expiry and duplicates never dispatch twice', async () => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture(async value => { if (value.name === 'say') await pending; return { content: '確認しました', joined: true }; });
  const original = f.service.handler(request(command(1)));
  await new Promise(resolve => setImmediate(resolve));
  for (let n = 2; n <= 256; n++) await f.service.handler(request(command(n, 'voice-status')));
  f.setNow(NOW + 15 * 60_000); f.service.touch();
  // Completed entries retire, but the original pending promise remains reusable.
  const duplicate = f.service.handler(request(command(1)));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.filter(name => name === 'say').length, 1);
  for (let n = 300; n < 555; n++) await f.service.handler(request(command(n, 'voice-status')));
  assert.match((await (await f.service.handler(request(command(600, 'voice-status')))).json()).content, /混み合/);
  finish();
  assert.equal((await original).status, 200); assert.equal((await duplicate).status, 200);
  assert.match((await (await f.service.handler(request(command(1)))).json()).content, /有効期限/);
  assert.equal(f.calls.filter(name => name === 'say').length, 1);
});
test('priority stop and leave remain at-most-once when capacity is full and after retirement', async () => {
  const f = fixture();
  for (let n = 1; n <= 256; n++) await f.service.handler(request(command(n, 'voice-status')));
  for (const [n, name] of [[400, 'stop'], [500, 'leave']]) {
    await f.service.handler(request(command(n, name)));
    await f.service.handler(request(command(n, name)));
    assert.equal(f.calls.filter(value => value === name).length, 1);
  }
  f.setNow(NOW + 15 * 60_000); f.service.touch();
  await f.service.handler(request(command(400, 'stop')));
  await f.service.handler(request(command(500, 'leave')));
  assert.equal(f.calls.filter(value => value === 'stop').length, 1);
  assert.equal(f.calls.filter(value => value === 'leave').length, 1);
  await f.service.handler(request(command(600, 'stop')));
  assert.equal(f.calls.filter(value => value === 'stop').length, 2);
});
