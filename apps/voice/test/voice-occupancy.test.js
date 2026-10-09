import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createVoiceOccupancy } from '../src/voice-occupancy.js';
import { createCommandService } from '../src/command-service.js';

const NOW = Date.parse('2026-10-03T12:00:00Z');
const guildId = '100000000000000001', channelId = '100000000000000002';
const selfId = '100000000000000003', humanId = '100000000000000004', otherId = '100000000000000005';
const sessionId = '10000000-0000-4000-8000-000000000001';
const candidate = (id = humanId, extra = {}) => ({ id, guildId, channelId, bot: false, ...extra });
const voice = (id, extra = {}) => ({ user_id: id, guild_id: guildId, channel_id: channelId, ...extra });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function setup({ fetch, timeoutMs = 5000 } = {}) {
  let clock = NOW, touches = 0;
  const status = { sessionId, guildId, selfId, channelId, connection: {}, gatewayReady: true,
    voiceReady: true, idleAt: NOW + 300_000 };
  const members = [candidate()]; const calls = [];
  const monitor = createVoiceOccupancy({ usageMode: 'daily', sessionId, guildId, deadline: NOW + 30 * 60_000,
    state: () => status, candidates: () => members, now: () => clock, timeoutMs,
    fetchVoiceState: (id, signal) => { calls.push({ id, signal }); return fetch ? fetch(id, signal) : voice(id); },
    touch: () => { touches++; status.idleAt = Math.min(NOW + 30 * 60_000, clock + 300_000); },
  });
  return { monitor, status, members, calls, at: value => { clock = NOW + value; }, touches: () => touches };
}

test('quiet occupied VC is renewed near expiry using only bot plus one fresh human', async () => {
  const f = setup();
  assert.equal(await f.monitor.tick(), false); f.at(284_999);
  assert.equal(await f.monitor.tick(), false); assert.equal(f.calls.length, 0);
  f.at(285_000); assert.equal(await f.monitor.tick(), true);
  assert.deepEqual(f.calls.map(call => call.id), [selfId, humanId]);
  assert.equal(f.status.idleAt, NOW + 585_000);
  f.at(400_000); assert.equal(await f.monitor.tick(), false);
  f.at(570_000); assert.equal(await f.monitor.tick(), true); assert.equal(f.touches(), 2);
});

test('no REST probe before join, with disconnected Gateway, after expiry, or after close', async () => {
  for (const change of [state => { state.voiceReady = false; }, state => { state.gatewayReady = false; },
    state => { state.connection = null; }, state => { state.channelId = null; },
    state => { state.sessionId = 'replacement'; }, state => { state.guildId = otherId; }]) {
    const f = setup(); f.at(285_000); change(f.status);
    assert.equal(await f.monitor.tick(), false); assert.equal(f.calls.length, 0);
  }
  const expired = setup(); expired.at(300_000); await expired.monitor.tick(); assert.equal(expired.calls.length, 0);
  const closed = setup(); closed.at(285_000); closed.monitor.close(); await closed.monitor.tick(); assert.equal(closed.calls.length, 0);
});

test('cached other VC/guild, bots, unknown bot flags and self never become witnesses', async () => {
  const f = setup(); f.at(285_000); f.members.splice(0, 1,
    candidate(humanId, { channelId: otherId }), candidate(humanId, { guildId: otherId }),
    candidate(humanId, { bot: true }), candidate(humanId, { bot: undefined }), candidate(selfId));
  assert.equal(await f.monitor.tick(), false); assert.equal(f.calls.length, 0); assert.equal(f.touches(), 0);
});

test('stale membership, wrong identity and bot-only REST evidence never renew', async () => {
  for (const value of [voice(humanId, { channel_id: null }), voice(humanId, { channel_id: otherId }),
    voice(humanId, { guild_id: otherId }), voice(otherId), {}, null,
    voice(humanId, { member: { user: { id: otherId, bot: false } } }),
    voice(humanId, { member: { user: { id: humanId, bot: true } } })]) {
    const f = setup({ fetch: id => id === selfId ? voice(id) : value }); f.at(285_000);
    assert.equal(await f.monitor.tick(), false); assert.equal(f.touches(), 0);
  }
  const movedBot = setup({ fetch: id => voice(id, { channel_id: otherId }) }); movedBot.at(285_000);
  assert.equal(await movedBot.monitor.tick(), false); assert.equal(movedBot.calls.length, 1);
});

test('missing owner can fall back to another current-VC human and calls stay bounded', async () => {
  const f = setup({ fetch: id => { if (id === humanId) throw Object.assign(new Error('gone'), { status: 404 }); return voice(id); } });
  f.at(285_000); f.members.push(candidate(otherId));
  assert.equal(await f.monitor.tick(), true); assert.deepEqual(f.calls.map(call => call.id), [selfId, humanId, otherId]);
  const stale = setup({ fetch: id => voice(id, { channel_id: id === selfId ? channelId : null }) });
  stale.at(285_000); stale.members.push(...Array.from({ length: 20 }, (_, i) => candidate(String(200000000000000000n + BigInt(i)))));
  assert.equal(await stale.monitor.tick(), false); assert.equal(stale.calls.length, 4);
  stale.at(286_000); await stale.monitor.tick(); assert.equal(stale.calls.length, 4, 'failed check is not retried each second');
});

test('single flight and total timeout abort a hanging REST operation without late renewal', async () => {
  const wait = deferred(); const f = setup({ timeoutMs: 15, fetch: () => wait.promise }); f.at(285_000);
  const checking = f.monitor.tick(); await delay(1);
  assert.equal(await f.monitor.tick(), false); assert.equal(f.calls.length, 1);
  const hold = delay(25); assert.equal(await checking, false); await hold;
  assert.equal(f.calls[0].signal.aborted, true);
  wait.resolve(voice(selfId)); await delay(1); assert.equal(f.calls.length, 1); assert.equal(f.touches(), 0);
});

test('permission and rate-limit failures never touch idle or produce retry storms', async () => {
  for (const status of [403, 429, 500]) {
    const f = setup({ fetch: () => { throw Object.assign(new Error('unavailable'), { status }); } }); f.at(285_000);
    assert.equal(await f.monitor.tick(), false); f.at(290_000); await f.monitor.tick();
    assert.equal(f.calls.length, 1); assert.equal(f.touches(), 0);
  }
});

test('leave, membership update, Gateway interruption and rejoin fence pending evidence', async () => {
  for (const transition of [f => f.monitor.close(), f => f.monitor.invalidate(),
    f => { f.status.gatewayReady = false; }, f => { f.status.connection = {}; },
    f => { f.status.channelId = otherId; }, f => { f.status.voiceReady = false; },
    f => { f.status.sessionId = 'replacement'; }, f => f.at(300_000), f => f.at(30 * 60_000)]) {
    const wait = deferred(); const f = setup({ fetch: id => id === selfId ? voice(id) : wait.promise }); f.at(285_000);
    const checking = f.monitor.tick(); await delay(1); transition(f); wait.resolve(voice(humanId));
    assert.equal(await checking, false); assert.equal(f.touches(), 0);
  }
});

test('a cancelled lookup cannot overwrite cache, overlap a replacement, or renew later', async () => {
  const wait = deferred(); const f = setup({ fetch: id => id === selfId ? wait.promise : voice(id) }); f.at(285_000);
  const first = f.monitor.tick(); await delay(1); f.monitor.invalidate();
  assert.equal(await first, false); assert.equal(f.calls[0].signal.aborted, true);
  f.at(286_000); await f.monitor.tick(); assert.equal(f.calls.length, 1, 'membership churn respects retry spacing');
  wait.resolve(voice(selfId)); await delay(1); assert.equal(f.touches(), 0);
  f.at(290_000); assert.equal(await f.monitor.tick(), true);
});

test('real command service renews only from proof and still expires at its original absolute cap', async () => {
  let clock = NOW, ended = 0; let monitor;
  const deadline = NOW + 30 * 60_000;
  const service = createCommandService({ sessionId, deadline, idleSeconds: 300,
    scope: { applicationId: otherId, guildId, channelId, userId: humanId }, ready: () => true,
    voiceStatus: () => 'ready', queued: () => 0, dispatch: async () => ({ content: 'ok', joined: true }),
    cancelJoin() {}, shutdown() { ended++; monitor.close(); }, now: () => clock });
  const connection = {};
  monitor = createVoiceOccupancy({ usageMode: 'daily', sessionId, guildId, deadline, now: () => clock,
    state: () => ({ sessionId, guildId, selfId, channelId, connection, gatewayReady: true, voiceReady: true, idleAt: service.idleAt }),
    candidates: () => [candidate()], fetchVoiceState: async id => voice(id), touch: () => service.touch() });
  for (let round = 0; round < 6; round++) {
    clock = service.idleAt - 15_000; assert.equal(service.checkIdle(), false);
    assert.equal(await monitor.tick(), true);
    const before = service.idleAt;
    await service.handler(new Request('http://bot.internal/health'));
    assert.equal(service.idleAt, before, 'health does not extend occupancy');
  }
  assert.equal(service.idleAt, deadline); clock = deadline;
  assert.equal(service.checkIdle(), true); assert.equal(ended, 1); assert.equal(await monitor.tick(), false);
});

test('trial and invalid modes never inspect membership or renew their five-minute idle window', async () => {
  for (const usageMode of [undefined, 'trial', 'DAILY', 'unknown']) {
    const monitor = createVoiceOccupancy({ usageMode, sessionId, guildId, deadline: NOW + 30 * 60_000,
      state() { assert.fail('disabled mode must not inspect state'); }, candidates() { assert.fail('must not inspect members'); },
      fetchVoiceState() { assert.fail('must not make REST calls'); }, touch() { assert.fail('must not renew'); } });
    assert.equal(await monitor.tick(), false);
  }
});

test('malformed or throwing state and candidate sources fail closed without escaping tick', async () => {
  for (const state of [() => null, () => undefined, () => ({}), () => { throw new Error('unavailable'); }]) {
    const monitor = createVoiceOccupancy({ usageMode: 'daily', sessionId, guildId, deadline: NOW + 30 * 60_000,
      state, candidates() { assert.fail('no valid state'); }, fetchVoiceState() { assert.fail('no valid state'); }, touch() { assert.fail('no proof'); } });
    assert.equal(await monitor.tick(), false);
  }
  for (const candidates of [() => null, () => ({}), () => { throw new Error('unavailable'); }]) {
    const monitor = createVoiceOccupancy({ usageMode: 'daily', sessionId, guildId, deadline: NOW + 30 * 60_000, now: () => NOW,
      state: () => ({ sessionId, guildId, selfId, channelId, connection: {}, gatewayReady: true, voiceReady: true, idleAt: NOW + 10_000 }),
      candidates, fetchVoiceState() { assert.fail('no valid candidates'); }, touch() { assert.fail('no proof'); } });
    assert.equal(await monitor.tick(), false);
  }
});
