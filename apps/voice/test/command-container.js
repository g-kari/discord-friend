import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// CI mounts this script read-only beside the image's actual private modules.
const source=process.env.VOICE_TEST_SOURCE ?? resolve(import.meta.dirname,'../src');
const {createCommandService}=await import(pathToFileURL(resolve(source,'command-service.js')));
const {createCommandServer}=await import(pathToFileURL(resolve(source,'command-http.js')));
const scope={applicationId:'100000000000000001',guildId:'100000000000000002',channelId:'100000000000000003',userId:'100000000000000004'};
const sessionId='10000000-0000-4000-8000-000000000001';let now=Date.now(),stops=0;const calls=[];
const service=createCommandService({scope,sessionId,deadline:now+30*60_000,idleSeconds:30,ready:()=>true,voiceStatus:()=> 'ready',queued:()=>0,
  dispatch:async command=>{calls.push(command.name);return{content:'確認しました',joined:command.name==='join'};},cancelJoin:()=>{},shutdown:()=>{stops++;},now:()=>now});
const server=createCommandServer(request=>service.handler(request));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status,200);
  for(const [index,name] of ['join','say','voice-status','stop','leave'].entries()){
    const body={...scope,sessionId,id:String(100000000000000011n+BigInt(index)),name,...(name==='say'?{text:'合成データのみ'}:{})};
    const response=await fetch(`${base}/v1/command`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    assert.equal(response.status,200);assert.equal(typeof(await response.json()).content,'string');
    if(name==='say')await fetch(`${base}/v1/command`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  }
  assert.deepEqual(calls,['join','say','voice-status','stop','leave']);
  now+=30_001;assert.equal((await fetch(`${base}/health`)).status,503);assert.equal(stops,1);
  console.log(JSON.stringify({privateCommands:5,duplicateSayExecutions:1,idleStopped:true,externalNetwork:false,accountCredentials:false}));
}finally{await new Promise(resolve=>server.close(resolve));}
