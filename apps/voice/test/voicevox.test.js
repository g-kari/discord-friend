import test from 'node:test';
import assert from 'node:assert/strict';
import { createSynthesizer } from '../src/voicevox.js';
import { assertWav, boundedBytes, validateSpeech } from '../src/policy.js';

function wav() {
  const b = Buffer.alloc(48);
  b.write('RIFF'); b.writeUInt32LE(40, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(4, 40); return b;
}
function fakeEngine(overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (overrides[url.pathname]) return overrides[url.pathname](url, init);
    if (url.pathname === '/speakers') return Response.json([{ name: '春日部つむぎ', styles: [{ name: 'ノーマル', id: 999 }] }]);
    if (url.pathname === '/audio_query') return Response.json({ accent_phrases: [], speedScale: 1 });
    if (url.pathname === '/synthesis') return new Response(wav(), { headers: { 'content-type': 'audio/wav' } });
    throw new Error('unexpected network path');
  } };
}
test('shared synthesis chooses named style, preserves text and requests Discord-compatible WAV', async () => {
  const engine = fakeEngine();
  const result = await createSynthesizer(engine)({ text: '11.5万人 & つむぎ！', speed: 1.2 });
  assert.equal(result.credit, 'VOICEVOX:春日部つむぎ');
  assert.equal(result.contentType, 'audio/wav');
  assert.deepEqual(Buffer.from(result.audio), wav());
  assert.equal(engine.calls[1].url.searchParams.get('text'), '11.5万人 & つむぎ！');
  assert.equal(engine.calls[1].url.searchParams.get('speaker'), '999');
  const query = JSON.parse(engine.calls[2].init.body);
  assert.equal(query.speedScale, 1.2);
  assert.equal(query.outputSamplingRate, 48000);
  assert.equal(query.outputStereo, true);
  assert(engine.calls.every(c => c.init.redirect === 'error'));
});
test('input bounds reject unknown controls, missing/oversized text and unsafe speeds', () => {
  for (const input of [null, [], {}, { text: '' }, { text: 'あ'.repeat(501) }, { text: '\0' },
    { text: 'x', speed: NaN }, { text: 'x', speed: 0.6 }, { text: 'x', speed: 1.6 },
    { text: 'x', url: 'https://untrusted.invalid' }, { text: 'x', speaker: 1 }]) {
    assert.throws(() => validateSpeech(input));
  }
  assert.equal(validateSpeech({ text: '😀'.repeat(500) }).text.length, 1000);
});
test('all upstream failures fail visibly instead of beep or silent WAV', async () => {
  for (const stage of ['/speakers', '/audio_query', '/synthesis']) {
    const engine = fakeEngine({ [stage]: () => new Response('private upstream detail', { status: 500 }) });
    await assert.rejects(createSynthesizer(engine)({ text: 'hello' }), { code: 'VOICEVOX_UNAVAILABLE' });
  }
});
test('missing selected voice is an actionable error, not another voice', async () => {
  const engine = fakeEngine({ '/speakers': () => Response.json([{ name: '別の声', styles: [{ id: 8 }] }]) });
  await assert.rejects(createSynthesizer(engine)({ text: 'hello' }), { code: 'VOICE_NOT_AVAILABLE' });
  assert.equal(engine.calls.length, 1);
});
test('invalid query and invalid audio are rejected', async () => {
  await assert.rejects(createSynthesizer(fakeEngine({ '/audio_query': () => Response.json({}) }))({ text: 'hello' }), { code: 'INVALID_QUERY' });
  await assert.rejects(createSynthesizer(fakeEngine({ '/synthesis': () => new Response('<html>error</html>') }))({ text: 'hello' }), { code: 'INVALID_AUDIO' });
});
test('a busy engine does not queue unbounded text and releases on error', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  const engine = fakeEngine({ '/speakers': async () => {
    count++;
    if (count === 1) await gate;
    return new Response('', { status: 503 });
  } });
  const synth = createSynthesizer(engine);
  const first = synth({ text: 'first' });
  await assert.rejects(synth({ text: 'second' }), { code: 'SYNTHESIS_BUSY' });
  release();
  await assert.rejects(first, { code: 'VOICEVOX_UNAVAILABLE' });
  await assert.rejects(synth({ text: 'third' }), { code: 'VOICEVOX_UNAVAILABLE' });
  assert.equal(count, 2);
});
test('caller cancellation propagates and releases the slot', async () => {
  const engine = fakeEngine({ '/speakers': (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }) });
  const controller = new AbortController();
  const running = createSynthesizer(engine)({ text: 'cancel me' }, controller.signal);
  controller.abort();
  await assert.rejects(running, { code: 'SYNTHESIS_CANCELLED_OR_TIMED_OUT' });
});
test('streaming and declared size bounds cancel upstream', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(6)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedBytes(new Response(stream), 5), { code: 'UPSTREAM_TOO_LARGE' });
  assert.equal(cancelled, true);
  await assert.rejects(boundedBytes(new Response('x', { headers: { 'content-length': '100' } }), 5), { code: 'UPSTREAM_TOO_LARGE' });
});
test('WAV validates sizes, PCM format, sample rate, stereo and data', () => {
  assert.doesNotThrow(() => assertWav(wav()));
  for (const offset of [0, 4, 8, 20, 22, 24, 28, 32, 34, 40]) {
    const broken = wav(); broken[offset] ^= 1;
    assert.throws(() => assertWav(broken), { code: 'INVALID_AUDIO' });
  }
});
test('service URL cannot contain credentials or use another protocol', () => {
  for (const baseUrl of ['file:///tmp/audio', 'https://user:password@example.invalid', 'https://example.invalid/?token=secret']) {
    assert.throws(() => createSynthesizer({ baseUrl }));
  }
});
