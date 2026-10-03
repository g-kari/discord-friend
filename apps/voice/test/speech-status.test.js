import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechStatus, StatusPresence } from '../src/speech-status.js';

function joined(status) { const turn = status.join(); status.completeJoin(turn, true); }
test('cold join stays lazy; only actual playback changes preparing to speaking, then text idle', () => {
  const status = new SpeechStatus();
  assert.equal(status.phase, 'connecting'); joined(status);
  assert.equal(status.phase, 'awaiting-text');
  assert.match(status.label, /投稿時/);
  const turn = status.begin(); assert.equal(status.phase, 'preparing');
  status.waiting(2); assert.match(status.summary, /待機: 2件/);
  status.playback(turn, false); assert.equal(status.phase, 'preparing');
  status.playback(turn, true); assert.equal(status.phase, 'speaking');
  status.finish(turn); assert.equal(status.phase, 'idle');
  assert.equal(status.label, '読み上げ待機中');
  assert.equal(status.label.includes('準備完了'), false);
});
test('failed speech is visible until new work and reconnect overrides an active playback', () => {
  const status = new SpeechStatus(); joined(status);
  const failed = status.begin(); status.finish(failed, true); assert.equal(status.phase, 'failed');
  const next = status.begin(); status.playback(next, true);
  status.transport('reconnecting'); assert.equal(status.phase, 'reconnecting');
  status.playback(next, false); status.transport('ready'); assert.equal(status.phase, 'preparing');
  status.playback(next, true); assert.equal(status.phase, 'speaking');
  status.transport('disconnected'); assert.equal(status.phase, 'disconnected');
});
test('stop, replacement join and end discard late speech and old connection status', () => {
  const status = new SpeechStatus(); joined(status);
  const old = status.begin(); status.stop(); status.waiting(0);
  status.playback(old, true); status.finish(old, true); assert.equal(status.phase, 'stopped');
  const one = status.join(); const two = status.join();
  status.completeJoin(two, true); status.completeJoin(one, false);
  assert.equal(status.phase, 'awaiting-text');
  const speaking = status.begin(); status.end();
  status.finish(speaking); status.transport('ready'); status.completeJoin(two, true);
  status.stop(); status.join(); status.begin(); assert.equal(status.phase, 'ended');
});
function presenceFixture() {
  let now = 0; let timer = null; let available = true;
  const updates = [];
  const presence = new StatusPresence({ publish: value => updates.push(structuredClone(value)), available: () => available,
    now: () => now, schedule: (callback, delay) => { assert.equal(timer, null); timer = { callback, at: now + delay }; return timer; },
    cancel: value => { if (timer === value) timer = null; } });
  const status = new SpeechStatus(value => presence.update(value));
  return { presence, status, updates, setAvailable: value => { available = value; },
    advance(ms) { now += ms; if (timer && timer.at <= now) { const current = timer; timer = null; current.callback(); } },
    timer: () => timer };
}
test('presence deduplicates/coalesces rapid queue activity at 5-second spacing and contains no text/authors', () => {
  const f = presenceFixture(); joined(f.status);
  assert.equal(f.updates.length, 1);
  for (let n = 0; n < 100; n++) { f.status.waiting(n % 10); f.status.begin(); }
  assert.equal(f.updates.length, 1); assert.ok(f.timer());
  f.advance(4999); assert.equal(f.updates.length, 1);
  f.advance(1); assert.equal(f.updates.length, 2);
  assert.equal(f.updates[1].activities[0].state, '音声準備中（初回は起動待ち） / 待機: 9件');
  f.status.emit(); f.advance(5000); assert.equal(f.updates.length, 2);
  for (const update of f.updates) {
    assert.deepEqual(Object.keys(update).sort(), ['activities', 'status']);
    assert.equal(update.activities[0].type, 4);
  }
});
test('unavailable gateway keeps only latest state; stop replaces pending speaking, close removes timers', () => {
  const f = presenceFixture(); f.setAvailable(false); joined(f.status);
  const turn = f.status.begin(); f.status.playback(turn, true);
  assert.equal(f.updates.length, 0); assert.equal(f.timer(), null);
  f.status.stop(); f.setAvailable(true); f.presence.flush();
  assert.match(f.updates[0].activities[0].state, /読み上げ停止/);
  f.status.begin(); assert.ok(f.timer()); f.presence.close(); assert.equal(f.timer(), null);
  f.advance(5000); f.status.end(); assert.equal(f.updates.length, 1);
});
test('presence failure cannot break speech or trigger retry loops', () => {
  let calls = 0;
  const presence = new StatusPresence({ publish: () => { calls++; throw new Error('Gateway unavailable'); }, available: () => true });
  const status = new SpeechStatus(value => presence.update(value));
  status.emit(); status.emit(); assert.equal(calls, 1); presence.close();
});

test('new text queued behind an aborting turn shows preparing rather than a stale stopped label', () => {
  const status = new SpeechStatus(); joined(status);
  const old = status.begin(); status.stop(); status.waiting(1);
  assert.equal(status.phase, 'preparing'); status.finish(old, true);
  assert.equal(status.phase, 'preparing'); assert.equal(status.queued, 1);
});
