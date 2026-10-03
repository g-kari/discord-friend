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

const DAILY_MS = 8 * 60 * 60_000;
const DAY_START = Date.parse('2026-10-02T00:00:00Z');
const daily = { VOICE_USAGE_MODE: 'daily', VOICE_SESSION_STARTED_AT: new Date(DAY_START).toISOString() };
test('explicit daily mode permits eight hours while every restart keeps the original bounds', () => {
  const deadline = new Date(DAY_START + DAILY_MS).toISOString();
  assert.equal(remainingLifetime(deadline, DAY_START, daily), DAILY_MS);
  assert.equal(remainingLifetime(deadline, DAY_START + 7 * 60 * 60_000, daily), 60 * 60_000);
  assert.throws(() => remainingLifetime(deadline, DAY_START + DAILY_MS, daily), /expired daily deadline/);
  for (const mode of [undefined, '', 'trial', 'DAILY', 'other']) {
    assert.throws(() => remainingLifetime(deadline, DAY_START, { ...daily, VOICE_USAGE_MODE: mode }));
  }
});
test('daily images require bounded persisted start and refuse renewal, rollback, or crossing UTC midnight', () => {
  const deadline = new Date(DAY_START + DAILY_MS).toISOString();
  for (const startedAt of [undefined, '', 'bad', new Date(DAY_START + 1).toISOString(), new Date(DAY_START - 1).toISOString()]) {
    assert.throws(() => remainingLifetime(deadline, DAY_START, { ...daily, VOICE_SESSION_STARTED_AT: startedAt }), /daily session bounds/);
  }
  // An overlong lease remains invalid even once its remaining time is below eight hours.
  assert.throws(() => remainingLifetime(new Date(DAY_START + DAILY_MS + 1).toISOString(), DAY_START + 60_000, daily), /daily session bounds/);
  const midnight = DAY_START + 24 * 60 * 60_000;
  const late = { ...daily, VOICE_SESSION_STARTED_AT: new Date(midnight - 60_000).toISOString() };
  assert.equal(remainingLifetime(new Date(midnight).toISOString(), midnight - 60_000, late), 60_000);
  assert.throws(() => remainingLifetime(new Date(midnight + 1).toISOString(), midnight - 60_000, late), /daily session bounds/);
});
