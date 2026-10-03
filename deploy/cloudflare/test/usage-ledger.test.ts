import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { UsageLedger, DAILY_LIMIT_MS, SESSION_LIMIT_MS } from '../src/usage-ledger.ts';
import { InteractionLedger } from '../src/interaction-ledger.ts';
import { SessionCommands, commandRuntimeActive } from '../src/session-commands.ts';
import { scopeFingerprint } from '../src/guild-setup.ts';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const env = { BOT_ENABLED: 'true', DISCORD_HTTP_ENABLED: 'true', VOICE_USAGE_MODE: 'daily', VOICE_DEADLINE: '',
  VOICE_IDLE_SECONDS: '300', VOICE_SESSION_MINUTES: '480', DISCORD_BOT_TOKEN: 'synthetic',
  DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_GUILD_ID: '100000000000000002',
  DISCORD_TEXT_CHANNEL_ID: '100000000000000003', DISCORD_OWNER_ID: '100000000000000004' };
const command = (n: number, receivedAt = NOW, name: 'join' | 'leave' | 'voice-status' = 'join') => ({
  id: String(100000000000000000n + BigInt(n)), applicationId: env.DISCORD_APPLICATION_ID,
  guildId: env.DISCORD_GUILD_ID, channelId: env.DISCORD_TEXT_CHANNEL_ID, userId: env.DISCORD_OWNER_ID,
  name, receivedAt, token: 'synthetic_reply_token', bodyHash: String(n).padStart(64, '0'),
});
function fixture() {
  const db = new DatabaseSync(':memory:');
  const storage = { sql: { exec(query: string, ...args: (string | number | null)[]) {
    const stmt = db.prepare(query); const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, sync: async () => {} };
  return { db, storage, usage: new UsageLedger(storage) };
}
test('daily mode is explicitly enabled with exact 5-minute idle/8-hour session guards, while trial remains fail closed', () => {
  assert.equal(commandRuntimeActive(env, NOW, scopeFingerprint(env)), true);
  for (const patch of [{ VOICE_USAGE_MODE: 'trial' }, { VOICE_USAGE_MODE: undefined }, { VOICE_USAGE_MODE: 'other' },
    { VOICE_IDLE_SECONDS: '301' }, { VOICE_IDLE_SECONDS: '30' }, { VOICE_SESSION_MINUTES: '30' }, { VOICE_SESSION_MINUTES: '479' }, { VOICE_SESSION_MINUTES: '481' },
    { VOICE_DEADLINE: new Date(NOW + 60_000).toISOString() }, { BOT_ENABLED: 'false' }, { DISCORD_HTTP_ENABLED: 'false' },
    { DISCORD_OWNER_ID: '100000000000000099' }]) {
    assert.equal(commandRuntimeActive({ ...env, ...patch }, NOW, scopeFingerprint(env)), false);
  }
});
test('two four-hour reservations cumulatively exhaust eight hours across reconstruction', () => {
  const f = fixture(); const half = 4 * 60 * 60_000;
  assert.deepEqual(f.usage.reserve('first', NOW, NOW + half), { deadline: NOW + half });
  assert.equal(f.usage.remaining(NOW), half);
  f.usage.settle('first', NOW + half);
  const restart = new UsageLedger(f.storage);
  assert.deepEqual(restart.reserve('second', NOW + half, NOW + 2 * SESSION_LIMIT_MS), { deadline: NOW + DAILY_LIMIT_MS });
  restart.settle('second', NOW + DAILY_LIMIT_MS);
  assert.equal(new UsageLedger(f.storage).remaining(NOW + DAILY_LIMIT_MS), 0);
  assert.deepEqual(restart.reserve('third', NOW + DAILY_LIMIT_MS, NOW + DAILY_LIMIT_MS + SESSION_LIMIT_MS), { reason: 'budget' });
  f.db.close();
});
test('one reservation is at most eight hours and remains charged after reconstruction', () => {
  const f = fixture();
  assert.deepEqual(f.usage.reserve('first', NOW, NOW + 12 * 60 * 60_000), { deadline: NOW + SESSION_LIMIT_MS });
  const restart = new UsageLedger(f.storage);
  assert.equal(restart.remaining(NOW), 0);
  assert.equal(restart.covers('first', NOW + SESSION_LIMIT_MS, NOW + 31 * 60_000), true);
  assert.equal(restart.covers('first', NOW + SESSION_LIMIT_MS, NOW + SESSION_LIMIT_MS), false);
  f.db.close();
});
test('confirmed early cleanup refunds only unused time once; stale cleanup cannot refund a successor', () => {
  const f = fixture(); f.usage.reserve('first', NOW, NOW + SESSION_LIMIT_MS);
  f.usage.settle('first', NOW + 5 * 60_000); f.usage.settle('first', NOW + 1);
  assert.equal(f.usage.remaining(NOW), 475 * 60_000);
  f.usage.reserve('second', NOW + 5 * 60_000, NOW + 35 * 60_000); f.usage.settle('first', NOW + 1);
  assert.equal(f.usage.remaining(NOW), 445 * 60_000);
  f.usage.settle('second', NOW + 35 * 60_000);
  assert.deepEqual(f.usage.reserve('third', NOW + 35 * 60_000, NOW + 35 * 60_000 + SESSION_LIMIT_MS), { deadline: NOW + DAILY_LIMIT_MS });
  assert.equal(f.usage.remaining(NOW), 0); f.db.close();
});
test('uncertain cleanup retains the reservation and blocks admission even after expiry or midnight', () => {
  const f = fixture(); f.usage.reserve('first', NOW, NOW + SESSION_LIMIT_MS);
  for (const time of [NOW + 1000, NOW + SESSION_LIMIT_MS, NOW + 24 * 60 * 60_000]) {
    assert.deepEqual(new UsageLedger(f.storage).reserve('next', time, time + SESSION_LIMIT_MS), { reason: 'cleanup' });
  }
  assert.equal(f.usage.remaining(NOW), 0);
  f.usage.settle('first', NOW + 24 * 60 * 60_000);
  assert.equal(f.usage.remaining(NOW), 0, 'late cleanup gives no refund');
  assert.deepEqual(f.usage.reserve('next', NOW + 24 * 60 * 60_000, NOW + 24 * 60 * 60_000 + SESSION_LIMIT_MS),
    { deadline: NOW + 24 * 60 * 60_000 + SESSION_LIMIT_MS }); f.db.close();
});
test('rejoin preserves deadline and debit; obsolete generations cannot use or refund the reservation', () => {
  const f = fixture(); f.usage.reserve('first', NOW, NOW + SESSION_LIMIT_MS);
  assert.deepEqual(f.usage.reserve('second', NOW + 60_000, NOW + SESSION_LIMIT_MS, 'first'), { deadline: NOW + SESSION_LIMIT_MS });
  assert.equal(f.usage.remaining(NOW), 0);
  assert.equal(f.usage.covers('first', NOW + SESSION_LIMIT_MS, NOW + 60_000), false);
  assert.equal(f.usage.covers('second', NOW + SESSION_LIMIT_MS, NOW + 60_000), true);
  f.usage.settle('first', NOW + 60_000); assert.equal(f.usage.reservation()?.state, 'reserved'); f.db.close();
});
test('UTC midnight ends the current session; only a later explicit join gets the next day allowance', () => {
  const f = fixture(); const start = Date.parse('2026-10-03T23:59:00Z'), midnight = start + 60_000;
  assert.deepEqual(f.usage.reserve('first', start, start + SESSION_LIMIT_MS), { deadline: midnight });
  assert.equal(f.usage.remaining(start), DAILY_LIMIT_MS - 60_000);
  assert.equal(f.usage.covers('first', midnight, midnight), false);
  assert.deepEqual(f.usage.reserve('second', midnight, midnight + SESSION_LIMIT_MS), { reason: 'cleanup' });
  f.usage.settle('first', midnight);
  assert.deepEqual(f.usage.reserve('second', midnight, midnight + SESSION_LIMIT_MS), { deadline: midnight + SESSION_LIMIT_MS });
  assert.equal(f.usage.remaining(start), DAILY_LIMIT_MS - 60_000);
  assert.equal(f.usage.remaining(midnight), 0); f.db.close();
});
test('clock rollback cannot authorize an unstarted reservation or refund it', () => {
  const f = fixture(); f.usage.reserve('first', NOW, NOW + SESSION_LIMIT_MS);
  assert.equal(f.usage.covers('first', NOW + SESSION_LIMIT_MS, NOW - 1), false);
  f.usage.settle('first', NOW - 1); assert.equal(f.usage.remaining(NOW), 0);
  assert.deepEqual(f.usage.reserve('second', NOW - 1, NOW + SESSION_LIMIT_MS), { reason: 'cleanup' }); f.db.close();
});
test('parallel duplicate and distinct joins claim one reservation; reconstruction cannot double-start', async () => {
  const f = fixture(); const ledger = new InteractionLedger(f.storage); const jobs: string[] = []; let starts = 0;
  const runtime = { start: async () => { starts++; }, invoke: async () => ({ content: 'joined', joined: true }), status: async () => 'ready',
    destroy: async () => {}, scheduleJob: async (id: string) => { jobs.push(id); }, scheduleExpiry: async () => {}, scheduleSweep: async () => {}, scheduleStop: async () => {} };
  const engine = new SessionCommands(env, ledger, runtime, async () => new Response(), () => NOW, scopeFingerprint(env));
  await Promise.all([engine.enqueue(command(2)), engine.enqueue(command(2)), engine.enqueue(command(3))]);
  assert.equal(jobs.length, 1); assert.equal(ledger.usage.remaining(NOW), 0); assert.equal(starts, 0);
  const restored = new SessionCommands(env, new InteractionLedger(f.storage), runtime, async () => new Response(), () => NOW, scopeFingerprint(env));
  await Promise.all([restored.run(jobs[0]), engine.run(jobs[0])]);
  assert.equal(starts, 1); assert.equal(ledger.usage.remaining(NOW), 0); f.db.close();
});
test('durability failure never starts or schedules a reserved session', async () => {
  const f = fixture(); const ledger = new InteractionLedger(f.storage); let starts = 0, jobs = 0;
  const runtime = { start: async () => { starts++; }, invoke: async () => ({ content: 'joined', joined: true }), status: async () => 'ready',
    destroy: async () => {}, scheduleJob: async () => { jobs++; }, scheduleExpiry: async () => {}, scheduleSweep: async () => {}, scheduleStop: async () => {} };
  f.storage.sync = async () => { throw new Error('SYNTHETIC_SYNC_FAILURE'); };
  const engine = new SessionCommands(env, ledger, runtime, async () => new Response(), () => NOW, scopeFingerprint(env));
  await assert.rejects(engine.enqueue(command(2)), /SYNTHETIC_SYNC_FAILURE/);
  assert.equal(starts, 0); assert.equal(jobs, 0); assert.equal(ledger.usage.remaining(NOW), 0); f.db.close();
});

test('daily controls stay owner-only and a disconnected status check reports quota without starting', async () => {
  const f = fixture(); const ledger = new InteractionLedger(f.storage); let starts = 0; const replies: string[] = [];
  const runtime = { start: async () => { starts++; }, invoke: async () => ({ content: 'joined', joined: true }), status: async () => 'ready',
    destroy: async () => {}, scheduleJob: async () => {}, scheduleExpiry: async () => {}, scheduleSweep: async () => {}, scheduleStop: async () => {} };
  const request: typeof fetch = async (_url, init) => { replies.push(JSON.parse(String(init?.body)).content); return new Response(); };
  const engine = new SessionCommands(env, ledger, runtime, request, () => NOW, scopeFingerprint(env));
  await engine.enqueue({ ...command(2), userId: '100000000000000099' }); await engine.run(command(2).id);
  assert.equal(ledger.session(), null); assert.equal(ledger.usage.remaining(NOW), DAILY_LIMIT_MS);
  await engine.enqueue(command(3, NOW, 'voice-status')); await engine.run(command(3).id);
  assert.match(replies.at(-1)!, /未予約枠: 480分/); assert.equal(starts, 0);
  f.db.close();
});

test('malformed or overlong durable bounds cannot authorize a start or rejoin', () => {
  for (const change of ["deadline=deadline+1", "reserved_ms=reserved_ms-1", "day=day-86400000", "started_at=started_at-1"]) {
    const f = fixture(); f.usage.reserve('first', NOW, NOW + SESSION_LIMIT_MS);
    f.storage.sql.exec('UPDATE voice_usage_reservation SET ' + change);
    const current = f.usage.reservation()!;
    assert.equal(f.usage.covers('first', current.deadline, NOW), false);
    assert.deepEqual(f.usage.reserve('next', NOW, NOW + SESSION_LIMIT_MS, 'first'), { reason: 'cleanup' });
    f.db.close();
  }
});
test('previous daily usage remains debited when reopening the ledger under the eight-hour limit', () => {
  const f = fixture(); f.storage.sql.exec('INSERT INTO voice_usage_days(day, charged_ms) VALUES(?, ?)',
    Date.parse('2026-10-03T00:00:00Z'), 60 * 60_000);
  assert.equal(new UsageLedger(f.storage).remaining(NOW), 7 * 60 * 60_000);
  assert.deepEqual(f.usage.reserve('next', NOW, NOW + SESSION_LIMIT_MS), { deadline: NOW + 7 * 60 * 60_000 });
  f.db.close();
});
