// Real-image CI gate, intentionally separate from the credential-free Node unit tests.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
const name = 'voice-tts-deadline-test';
const deadline = Date.now() + 45000;
const docker = args => exec('docker', args, { timeout: 55000, maxBuffer: 1024 * 1024 });
const state = async () => JSON.parse((await docker(['inspect', '-f', '{{json .State}}', name])).stdout);
const probe = `
  import assert from 'node:assert/strict';
  import {setTimeout as delay} from 'node:timers/promises';
  const deadline = Date.parse(process.env.VOICE_DEADLINE);
  let speakers;
  while (Date.now() < deadline - 3000) {
    try {
      const response = await fetch('http://127.0.0.1:50021/speakers', {signal:AbortSignal.timeout(1000)});
      if (response.ok) { speakers = await response.json(); break; }
    } catch {}
    await delay(100);
  }
  const style = speakers?.find(s => s.name === '春日部つむぎ')?.styles.find(s => s.name === 'ノーマル');
  assert(style, 'real engine must start before the deadline');
  const health = await fetch('http://127.0.0.1:8080/health'); assert(health.ok, 'adapter must start');
  const params = new URLSearchParams({text:'こんにちは。音声の停止期限を検証します。'.repeat(25).slice(0,500), speaker:String(style.id)});
  const response = await fetch('http://127.0.0.1:50021/audio_query?' + params, {method:'POST'});
  assert(response.ok, 'real audio query must succeed');
  const query = await response.json(); query.outputSamplingRate = 48000; query.outputStereo = true;
  assert(Date.now() < deadline - 2000, 'startup must leave time to test expiry');
  await delay(deadline - Date.now() - 250);
  let settled = false;
  void fetch('http://127.0.0.1:50021/synthesis?speaker=' + style.id, {
    method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(query),
  }).then(async result => { try { await result.arrayBuffer(); } finally { settled = true; } }, () => { settled = true; }).catch(() => {});
  await delay(deadline - Date.now() - 50);
  assert.equal(settled, false, 'real synthesis must still be in flight just before expiry');
  console.log(JSON.stringify({event:'real_synthesis_in_flight', at:Date.now()}));
  await delay(10000); throw new Error('container survived the deadline');
`;

try {
  await docker(['run', '-d', '--name', name, '--network', 'none', '-e', `VOICE_DEADLINE=${new Date(deadline).toISOString()}`, 'voice-tts-test']);
  const runningProbe = docker(['exec', name, 'node', '--input-type=module', '-e', probe])
    .then(result => result.stdout, error => error.stdout ?? '');
  let stopped;
  while (Date.now() < deadline + 8000) {
    const current = await state();
    if (!current.Running) { stopped = current; break; }
    await delay(100);
  }
  assert(stopped, 'real container exceeded its absolute trial deadline');
  const finishedAt = Date.parse(stopped.FinishedAt);
  assert(finishedAt >= deadline - 100, 'startup failure or early exit cannot pass this gate');
  assert(finishedAt <= deadline + 8000, 'real container exceeded deadline tolerance');
  assert.equal(stopped.ExitCode, 1, 'PID1 must stop after its deadline child exits');
  const events = (await runningProbe).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const evidence = events.find(event => event.event === 'real_synthesis_in_flight');
  assert(evidence && evidence.at >= deadline - 150 && evidence.at < deadline, 'missing in-flight synthesis evidence immediately before expiry');
  console.log('Real synthesis was in flight and the container stopped at its original absolute deadline');
} finally {
  await docker(['rm', '-f', name]).catch(() => {});
}
