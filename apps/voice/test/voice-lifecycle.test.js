import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { VoiceLifecycle } from '../src/voice-lifecycle.js';

const tick = () => delay(1);
function deferred() {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  const candidates = [];
  const lifecycle = new VoiceLifecycle({
    clearSpeech() {}, readyTimeoutMs: 1000, ...options,
    connect(channel) {
      const candidate = new EventEmitter();
      candidate.channel = channel; candidate.state = { status: 'connecting' };
      candidate.ready = deferred();
      candidate.destroy = () => { candidate.state.status = 'destroyed'; };
      candidate.makeReady = () => { candidate.state.status = 'ready'; candidate.ready.resolve(); };
      candidates.push(candidate);
      return candidate;
    },
    waitReady(candidate, signal) {
      return Promise.race([candidate.ready.promise, new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
    },
  });
  return { lifecycle, candidates };
}
async function readyJoin(lifecycle, candidates, channelId) {
  const joining = lifecycle.join(async () => ({ id: channelId }));
  await tick();
  if (lifecycle.pendingLeave) { lifecycle.observeBotChannel(null); await tick(); }
  lifecycle.observeBotChannel(channelId); candidates.at(-1).makeReady();
  assert.equal(await joining, 'joined');
}

test('join locks before member lookup and a second join cannot supersede it', async () => {
  const { lifecycle, candidates } = setup(); const lookup = deferred();
  const first = lifecycle.join(() => lookup.promise);
  assert.equal(await lifecycle.join(async () => ({ id: 'other' })), 'joining');
  lookup.resolve({ id: 'first' }); await tick();
  lifecycle.observeBotChannel('first'); candidates[0].makeReady();
  assert.equal(await first, 'joined'); assert.equal(candidates.length, 1);
  assert.equal(lifecycle.isReady, true); lifecycle.leave();
});
test('leave during member lookup prevents a late voice connection', async () => {
  const { lifecycle, candidates } = setup(); const lookup = deferred();
  const first = lifecycle.join(() => lookup.promise);
  lifecycle.leave();
  assert.equal(await first, 'cancelled');
  lookup.resolve({ id: 'first' }); await tick(); assert.equal(candidates.length, 0);
  assert.equal(lifecycle.connection, null);
});
test('a cancelled join failure cannot destroy a newer connection', async () => {
  const { lifecycle, candidates } = setup(); const lookup = deferred();
  const first = lifecycle.join(() => lookup.promise); lifecycle.leave();
  await readyJoin(lifecycle, candidates, 'new');
  lookup.reject(new Error('old lookup failed'));
  assert.equal(await first, 'cancelled'); assert.equal(lifecycle.connection.state.status, 'ready');
  lifecycle.leave();
});
test('replacement join drains predecessor leave ACK before connecting and requires target ACK', async () => {
  const { lifecycle, candidates } = setup(); await readyJoin(lifecycle, candidates, 'old');
  const second = lifecycle.join(async () => ({ id: 'new' })); await tick();
  assert.equal(candidates[0].state.status, 'destroyed');
  assert.equal(candidates.length, 1, 'new connection must not start before old leave ACK');
  lifecycle.observeBotChannel('old'); await tick(); assert.equal(candidates.length, 1);
  lifecycle.observeBotChannel(null); await tick(); candidates[1].makeReady(); await tick();
  assert.equal(lifecycle.connection, candidates[1]); assert.equal(lifecycle.isReady, false);
  lifecycle.observeBotChannel('new'); assert.equal(await second, 'joined');
  lifecycle.observeBotChannel(null); assert.equal(lifecycle.connection, null);
});
test('leave during voice negotiation cancels its wait and permits the next join', async () => {
  const { lifecycle, candidates } = setup();
  const first = lifecycle.join(async () => ({ id: 'old' })); await tick(); lifecycle.leave();
  assert.equal(await first, 'cancelled');
  await readyJoin(lifecycle, candidates, 'new'); assert.equal(candidates[0].state.status, 'destroyed');
  lifecycle.leave();
});
test('connection creation failure cleans up the join lock without an unhandled confirmation', async () => {
  const lifecycle = new VoiceLifecycle({ clearSpeech() {}, connect() { throw new Error('failed'); }, waitReady() {} });
  await assert.rejects(lifecycle.join(async () => ({ id: 'new' })), /failed/);
  assert.equal(lifecycle.attempt, null); assert.equal(lifecycle.connection, null); await tick();
});

test('leave while draining old ACK cancels that attempt and does not consume the next join', async () => {
  const { lifecycle, candidates } = setup(); await readyJoin(lifecycle, candidates, 'old');
  const cancelled = lifecycle.join(async () => ({ id: 'cancelled' })); await tick();
  lifecycle.leave(); assert.equal(await cancelled, 'cancelled');
  const next = lifecycle.join(async () => ({ id: 'new' })); await tick();
  assert.equal(candidates.length, 1);
  lifecycle.observeBotChannel(null); await tick();
  lifecycle.observeBotChannel('cancelled'); candidates[1].makeReady(); await tick();
  assert.equal(lifecycle.isReady, false);
  lifecycle.observeBotChannel('new'); assert.equal(await next, 'joined'); lifecycle.leave();
});
test('lookup and missing predecessor ACK time out with no leaked join lock or new connection', async () => {
  const hold = setTimeout(() => {}, 1000);
  try {
    const { lifecycle, candidates } = setup({ readyTimeoutMs: 20 });
    await assert.rejects(lifecycle.join(() => new Promise(() => {})), { name: 'TimeoutError' });
    assert.equal(lifecycle.attempt, null); assert.equal(candidates.length, 0);
    await readyJoin(lifecycle, candidates, 'old');
    await assert.rejects(lifecycle.join(async () => ({ id: 'new' })), { name: 'TimeoutError' });
    assert.equal(lifecycle.attempt, null); assert.equal(candidates.length, 1);
    lifecycle.observeBotChannel(null);
    await readyJoin(lifecycle, candidates, 'new'); lifecycle.leave();
  } finally { clearTimeout(hold); }
});
test('player subscription runs under attempt ownership and failures destroy only its own connection', async () => {
  let subscribed;
  const { lifecycle, candidates } = setup({ onReady(candidate) {
    assert.equal(lifecycle.attempt?.expectedChannelId, 'new');
    assert.equal(lifecycle.connection, candidate); subscribed = candidate;
  } });
  await readyJoin(lifecycle, candidates, 'new');
  assert.equal(subscribed, candidates[0]); lifecycle.leave();
  lifecycle.observeBotChannel(null);
  lifecycle.onReady = () => { throw new Error('subscription failed'); };
  const failed = lifecycle.join(async () => ({ id: 'broken' })); await tick();
  lifecycle.observeBotChannel('broken'); candidates[1].makeReady();
  await assert.rejects(failed, /subscription failed/);
  assert.equal(candidates[1].state.status, 'destroyed'); assert.equal(lifecycle.attempt, null);
});

test('kick or move after target ACK cancels negotiation before player subscription', async () => {
  for (const channelId of [null, 'moved']) {
    let subscriptions = 0;
    const { lifecycle, candidates } = setup({ onReady: () => { subscriptions++; } });
    const joining = lifecycle.join(async () => ({ id: 'target' })); await tick();
    lifecycle.observeBotChannel('target'); lifecycle.observeBotChannel(channelId);
    candidates[0].makeReady();
    assert.equal(await joining, 'cancelled'); assert.equal(subscriptions, 0);
    assert.equal(lifecycle.connection, null); assert.equal(lifecycle.attempt, null);
  }
});
