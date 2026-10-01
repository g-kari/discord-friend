import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechQueue, readableMessage } from '../src/queue.js';
import { setTimeout } from 'node:timers/promises';

test('queue is bounded and stops old speech without playing pending items', async () => {
  const started = [];
  const queue = new SpeechQueue(async (item, signal) => {
    started.push(item);
    await setTimeout(1000, null, { signal });
  }, { limit: 2 });
  assert.equal(queue.enqueue('first'), true);
  assert.equal(queue.enqueue('second'), true);
  assert.equal(queue.enqueue('overflow'), false);
  queue.clear();
  await setTimeout(5);
  assert.deepEqual(started, ['first']);
  assert.equal(queue.running, false);
  assert.equal(queue.current, null);
});
test('failure advances to the next item, reported once without replaying', async () => {
  const played = []; const errors = [];
  const queue = new SpeechQueue(async item => { played.push(item); if (item === 'bad') throw new Error('failed'); }, { onError: e => errors.push(e) });
  queue.enqueue('bad'); queue.enqueue('good');
  await setTimeout(5);
  assert.deepEqual(played, ['bad', 'good']);
  assert.equal(errors.length, 1);
});
test('hidden messages, code and raw mention IDs are not read aloud', () => {
  assert.equal(readableMessage('こんにちは ||秘密|| ```code``` `var` <@123> https://example.invalid/x'), 'こんにちは     リンク');
  assert.equal(readableMessage('||hidden||'), '');
});
