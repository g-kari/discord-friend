import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSpeechPlayback } from '../src/playback.js';
import { SpeechStatus } from '../src/speech-status.js';
import { SpeechQueue } from '../src/queue.js';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function wav() {
  const data = Buffer.alloc(44 + 3840); data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22);
  data.writeUInt32LE(48000, 24); data.writeUInt32LE(192000, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(3840, 40); return data;
}
function fixture(requestOverride) {
  const synthesis = deferred(), playing = deferred(), idle = deferred();
  const status = new SpeechStatus(); const join = status.join(); status.completeJoin(join, true);
  const player = new EventEmitter(); player.state = { status: 'idle' }; let plays = 0, requests = 0, touches = 0;
  player.play = () => { plays++; player.state = { status: 'buffering' }; };
  player.stop = () => { player.state = { status: 'idle' }; };
  const play = createSpeechPlayback({ isReady: () => true, touch: () => { touches++; }, status, player,
    ttsUrl: 'http://tts.internal/v1/speech', sessionId: 'test-session',
    request: async (...args) => { requests++; return requestOverride ? requestOverride(...args) : synthesis.promise; },
    resourceFromPcm: pcm => { assert.equal(pcm.length, 3840); return {}; },
    waitForState: (_player, state) => state === 'playing' ? playing.promise : idle.promise });
  return { status, player, play, synthesis, playing, idle, requests: () => requests, plays: () => plays, touches: () => touches,
    startPlaying() { const previous = player.state; player.state = { status: 'playing' }; player.emit('stateChange', previous, player.state); playing.resolve(); } };
}
test('cold speech displays preparing across lazy TTS response, WAV validation and player buffering; no readiness timer', async () => {
  const f = fixture(); assert.equal(f.requests(), 0); assert.equal(f.status.phase, 'awaiting-text');
  const work = f.play({ text: '名前：こんにちは', authorId: 'test-author' }, new AbortController().signal);
  assert.equal(f.requests(), 1); assert.equal(f.touches(), 1); assert.equal(f.status.phase, 'preparing');
  await tick(); assert.equal(f.status.phase, 'preparing'); assert.equal(f.plays(), 0);
  f.synthesis.resolve(new Response(wav())); await tick(); assert.equal(f.plays(), 1); assert.equal(f.status.phase, 'preparing');
  f.startPlaying(); await tick(); assert.equal(f.status.phase, 'speaking');
  f.player.state = { status: 'idle' }; f.player.emit('stateChange', { status: 'playing' }, f.player.state);
  assert.equal(f.status.phase, 'speaking', 'terminal Idle must not briefly publish preparing');
  f.idle.resolve(); await work; assert.equal(f.status.phase, 'idle'); assert.equal(f.player.listenerCount('stateChange'), 0);
});
test('TTS failure and malformed audio are failed, never ready, and future work remains accepted', async () => {
  for (const response of [new Response(null, { status: 503 }), new Response('not a WAV')]) {
    const f = fixture(async () => response);
    await assert.rejects(f.play({ text: 'hello', authorId: 'author' }, new AbortController().signal));
    assert.equal(f.status.phase, 'failed'); assert.equal(f.plays(), 0);
    assert.equal(f.status.begin() !== null, true); assert.equal(f.status.phase, 'preparing');
  }
});
test('normal-message queue exposes pending count and a stop during cold start never publishes late ready', async () => {
  const f = fixture(); const errors = [];
  const queue = new SpeechQueue(f.play, { onChange: count => f.status.waiting(count), onError: error => errors.push(error) });
  queue.enqueue({ text: 'first', authorId: 'first-author' }); queue.enqueue({ text: 'second', authorId: 'second-author' });
  assert.equal(f.status.phase, 'preparing'); assert.equal(f.status.queued, 1); assert.equal(f.requests(), 1);
  f.status.stop(); queue.clear(); assert.equal(f.status.phase, 'stopped'); assert.equal(f.status.queued, 0);
  f.synthesis.resolve(new Response(wav())); await tick();
  assert.equal(f.plays(), 0); assert.equal(f.requests(), 1); assert.equal(f.status.phase, 'stopped');
  assert.equal(queue.running, false); assert.deepEqual(errors, []);
});
