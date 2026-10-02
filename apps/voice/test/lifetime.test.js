import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingLifetime } from '../src/lifetime.js';
test('trial expiration is absolute across process restarts, bounded and fail closed', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  assert.equal(remainingLifetime('2026-10-02T00:30:00Z', now), 1800000);
  assert.equal(remainingLifetime('2026-10-02T00:30:00Z', now + 1200000), 600000);
  for (const value of ['bad', '2026-10-01T23:59:00Z', '2026-10-02T00:30:01Z']) {
    assert.throws(() => remainingLifetime(value, now));
  }
  for (const value of ['', undefined, null]) assert.throws(() => remainingLifetime(value, now), /Missing trial deadline/);
});
