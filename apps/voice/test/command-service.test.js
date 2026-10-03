import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandService } from '../src/command-service.js';

const NOW=Date.parse('2026-10-02T12:00:00Z');
const scope={applicationId:'100000000000000001',guildId:'100000000000000002',channelId:'100000000000000003',userId:'100000000000000004'};
const sessionId='10000000-0000-4000-8000-000000000001';
const id=n=>String(100000000000000000n+BigInt(n));
const command=(n,name='say')=>({...scope,sessionId,id:id(n),name,...(name==='say'?{text:'こんにちは'}:{})});
const request=body=>new Request('http://bot.internal/v1/command',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
function fixture(dispatch=async value=>({content:'確認しました',joined:value.name==='join'})){
  let now=NOW,ends=0,cancels=0;const calls=[];
  const service=createCommandService({scope,sessionId,deadline:NOW+30*60_000,idleSeconds:300,ready:()=>true,voiceStatus:()=> 'ready',queued:()=>0,
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
  const f=fixture();for(let n=1;n<=128;n++)assert.equal((await f.service.handler(request(command(n,'voice-status')))).status,200);
  assert.equal((await f.service.handler(request(command(200,'stop')))).status,200);assert.equal(f.calls.at(-1),'stop');
  await f.service.handler(request(command(199)));assert.equal(f.calls.filter(name=>name==='say').length,0);assert.equal(f.cancels(),1);
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
