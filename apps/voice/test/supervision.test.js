import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const shell = await readFile(new URL('../start-tts.sh', import.meta.url), 'utf8');
const deadlineFile = fileURLToPath(new URL('../src/deadline.js', import.meta.url));
const synthesizerUrl = new URL('../src/voicevox.js', import.meta.url).href;
const idleEngine = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);';

test('PID1 rejects missing or invalid deadlines before starting the engine or adapter', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voice-startup-'));
  const engineFile = join(directory, 'engine-started');
  const apiFile = join(directory, 'api-started');
  const script = shell
    .replace('/opt/voicevox_engine/run --host 127.0.0.1 --disable_mutable_api', '"$NODE" --input-type=module -e "$MOCK_ENGINE"')
    .replace('node /app/src/server.js', '"$NODE" --input-type=module -e "$MOCK_API"')
    .replaceAll('node /app/src/deadline.js', `"$NODE" ${JSON.stringify(deadlineFile)}`);
  try {
    for (const value of [undefined, '', 'bad', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 31 * 60000).toISOString()]) {
      const env = {
        PATH: process.env.PATH, NODE: process.execPath,
        MOCK_ENGINE: `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(engineFile)}, "started"); setInterval(() => {}, 100);`,
        MOCK_API: `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(apiFile)}, "started"); setTimeout(() => process.exit(1), 100);`,
      };
      if (value !== undefined) env.VOICE_DEADLINE = value;
      const child = spawnSync('bash', ['-c', script], { env, encoding: 'utf8', timeout: 3000 });
      assert.equal(child.status, 1, child.stderr);
      assert(child.stderr.includes('trial deadline'), child.stderr);
      assert.equal(await readFile(engineFile, 'utf8').catch(() => null), null, 'engine must never start');
      assert.equal(await readFile(apiFile, 'utf8').catch(() => null), null, 'adapter must never start');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function supervisedRun(apiSource, extraEnv = {}, { engineSource = idleEngine, verifyDeadline = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'voice-supervision-'));
  const pidFile = join(directory, 'engine-pid');
  const readyFile = join(directory, 'api-ready');
  // Replace executable entrypoints only; production PID1 wait/traps and watchdog run unchanged.
  const script = shell
    .replace('/opt/voicevox_engine/run --host 127.0.0.1 --disable_mutable_api', '"$NODE" --input-type=module -e "$MOCK_ENGINE"')
    .replace('node /app/src/server.js', '"$NODE" --input-type=module -e "$MOCK_API"')
    .replaceAll('node /app/src/deadline.js', `"$NODE" ${JSON.stringify(deadlineFile)}`);
  const child = spawn('bash', ['-c', script], { env: {
    PATH: process.env.PATH, NODE: process.execPath, PID_FILE: pidFile, READY_FILE: readyFile,
    MOCK_ENGINE: `import {writeFileSync} from "node:fs"; writeFileSync(process.env.PID_FILE, String(process.pid)); ${engineSource}`,
    MOCK_API: `import {writeFileSync} from "node:fs"; writeFileSync(process.env.READY_FILE, String(process.pid)); ${apiSource}`,
    VOICE_DEADLINE: new Date(Date.now() + 2000).toISOString(), ...extraEnv,
  }, stdio: 'ignore' });
  const startedAt = Date.now();
  let enginePid; let exited = false;
  const outcome = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('supervisor failed to stop within 3 seconds')), 3000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { exited = true; clearTimeout(timeout); resolve({ code, signal, stoppedAt: Date.now() }); });
  });
  void outcome.catch(() => {});
  try {
    while (!(await readFile(pidFile, 'utf8').catch(() => null)) || !(await readFile(readyFile, 'utf8').catch(() => null))) {
      assert.equal(exited, false, 'both services must start rather than fail immediately');
      assert(Date.now() - startedAt < 1000, 'services did not become ready');
      await delay(5);
    }
    enginePid = Number(await readFile(pidFile, 'utf8'));
    if (verifyDeadline) {
      const deadline = Date.parse(extraEnv.VOICE_DEADLINE);
      assert(Date.now() < deadline - 100, 'test needs a future deadline after startup');
      await delay(deadline - Date.now() - 100);
      assert.equal(exited, false, 'supervisor must remain alive until just before the absolute deadline');
      process.kill(enginePid, 0);
    }
    const result = await outcome;
    assert.throws(() => process.kill(enginePid, 0), { code: 'ESRCH' });
    if (verifyDeadline) {
      const deadline = Date.parse(extraEnv.VOICE_DEADLINE);
      assert(result.stoppedAt >= deadline - 50, 'supervisor exited before the absolute deadline');
      assert(result.stoppedAt <= deadline + 750, 'supervisor exceeded the absolute deadline tolerance');
    }
    return { ...result, elapsed: result.stoppedAt - startedAt };
  } finally {
    child.kill('SIGKILL');
    const apiPid = Number(await readFile(readyFile, 'utf8').catch(() => '0'));
    if (apiPid) { try { process.kill(apiPid, 'SIGKILL'); } catch {} }
    if (!enginePid) enginePid = Number(await readFile(pidFile, 'utf8').catch(() => '0'));
    if (enginePid) { try { process.kill(enginePid, 'SIGKILL'); } catch {} }
    await rm(directory, { recursive: true, force: true });
  }
}

test('adapter failure hard-stops an engine that ignores graceful SIGTERM', async () => {
  const result = await supervisedRun('setTimeout(() => process.exit(1), 200);');
  assert.equal(result.code, 1);
  assert(result.elapsed >= 200, 'an early startup error must not satisfy the adapter-failure test');
});

test('synthesis timeout hard-stops actual CPU work even when upstream ignores abort', async () => {
  const result = await supervisedRun(`
    import {createSynthesizer} from ${JSON.stringify(synthesizerUrl)};
    const synth = createSynthesizer({ timeoutMs: 150, fetchImpl: () => new Promise(() => {}), onRecycle: () => process.exit(1) });
    void synth({text:"synthetic timeout"}); setInterval(() => {}, 100);
  `, {}, { engineSource: 'process.on("SIGTERM", () => {}); while (true) {}' });
  assert.equal(result.code, 1);
  assert(result.elapsed >= 150, 'an early startup error must not satisfy the synthesis-timeout test');
});

test('independent absolute deadline kills a wedged API and CPU-busy engine', async () => {
  const deadline = new Date(Date.now() + 1000).toISOString();
  const result = await supervisedRun('while (true) {}', { VOICE_DEADLINE: deadline }, {
    engineSource: 'process.on("SIGTERM", () => {}); while (true) {}', verifyDeadline: true,
  });
  assert.equal(result.code, 1);
});

test('restart preserves the original absolute deadline rather than granting another trial', async () => {
  const deadline = new Date(Date.now() + 1300).toISOString();
  assert.equal((await supervisedRun('setTimeout(() => process.exit(1), 200);', { VOICE_DEADLINE: deadline })).code, 1);
  const result = await supervisedRun('setInterval(() => {}, 100);', { VOICE_DEADLINE: deadline }, { verifyDeadline: true });
  assert.equal(result.code, 1);
});
