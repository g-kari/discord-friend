import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceHandler } from '../src/http.js';
import { VoiceError } from '../src/policy.js';

const req = (body, headers = { 'content-type': 'application/json' }) => new Request('http://voice.internal/v1/speech', { method: 'POST', body, headers });
test('private HTTP adapter accepts bounded JSON and emits noncacheable audio', async () => {
  let received;
  const handle = createVoiceHandler(async input => { received = input; return { audio: new Uint8Array([1, 2]), contentType: 'audio/wav', credit: 'VOICEVOX:春日部つむぎ' }; });
  const response = await handle(req(JSON.stringify({ text: 'こんにちは' })));
  assert.equal(response.status, 200);
  assert.equal(received.text, 'こんにちは');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(decodeURIComponent(response.headers.get('x-voice-credit')), 'VOICEVOX:春日部つむぎ');
});
test('malformed, oversized and wrong media type never invoke synthesis', async () => {
  const handle = createVoiceHandler(async () => { assert.fail('must not synthesize'); });
  assert.equal((await handle(req('{'))).status, 400);
  assert.equal((await handle(req('x'.repeat(8193)))).status, 413);
  assert.equal((await handle(req('{}', { 'content-type': 'text/plain' }))).status, 415);
  assert.equal((await handle(new Request('http://voice.internal/v1/speech'))).status, 405);
  assert.equal((await handle(new Request('http://voice.internal/user_dict', { method: 'POST' }))).status, 404);
});
test('busy and failed synthesis errors are honest and contain no upstream details', async () => {
  const busy = await createVoiceHandler(async () => { throw new VoiceError('SYNTHESIS_BUSY', 429); })(req('{}'));
  assert.equal(busy.status, 429);
  assert.equal(busy.headers.get('retry-after'), '2');
  const failure = await createVoiceHandler(async () => { throw new Error('private text or credential'); })(req('{}'));
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: 'SYNTHESIS_FAILED' });
});
