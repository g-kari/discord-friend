import test from 'node:test';
import assert from 'node:assert/strict';
import { privateJson } from '../src/private-http.ts';
test('catalog JSON uses an explicit byte limit and cancels an oversized stream', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(6)); }, cancel() { cancelled = true; } }));
  await assert.rejects(privateJson(response, 5), /PRIVATE_RESPONSE_INVALID/); assert.equal(cancelled, true);
  await assert.rejects(privateJson(new Response('{"catalog":' + ' '.repeat(256 * 1024) + '[] }'), 256 * 1024), /PRIVATE_RESPONSE_INVALID/);
});
test('catalog JSON body deadline aborts a stalled read and leaves no uncancelled reader', async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ pull() {}, cancel() { cancelled = true; } }));
  const work = privateJson(response, 256 * 1024, controller.signal); controller.abort();
  await assert.rejects(work); assert.equal(cancelled, true); assert.equal(response.body?.locked, false);
});
