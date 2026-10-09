import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectReadiness } from '../src/readiness.ts';
const NOW = Date.parse('2026-10-02T12:00:00Z');
const env = () => ({ BOT_ENABLED: 'true', VOICE_DEADLINE: new Date(NOW + 600_000).toISOString(), DISCORD_BOT_TOKEN: 'synthetic',
  DISCORD_GUILD_ID: '100000000000000002', DISCORD_TEXT_CHANNEL_ID: '100000000000000003', DISCORD_OWNER_ID: '100000000000000004' });
test('stopped, expired, unbounded and incomplete configs never fetch the Container', async () => {
  for (const changes of [{ BOT_ENABLED: 'false' }, { VOICE_DEADLINE: '' }, { VOICE_DEADLINE: new Date(NOW).toISOString() },
    { VOICE_DEADLINE: new Date(NOW + 1_800_001).toISOString() }, { DISCORD_BOT_TOKEN: '' }, { DISCORD_OWNER_ID: '' }]) {
    const snapshot = await inspectReadiness({ ...env(), ...changes }, async () => { throw new Error('Unexpected Container fetch'); }, () => NOW);
    assert.equal(snapshot.state, 'inactive'); assert.equal(snapshot.httpStatus, null);
  }
});
test('HTTP port availability is not Gateway readiness', async () => {
  for (const [ready, status, state] of [[true, 200, 'gateway-ready'], [false, 503, 'gateway-not-ready'], [false, 200, 'unavailable'], [true, 503, 'unavailable']] as const) {
    const snapshot = await inspectReadiness(env(), async request => { assert.equal(request.url, 'http://bot.internal/health'); assert.ok(request.signal); return Response.json({ ready, voice: 'disconnected', lastError: 'unsafe text' }, { status }); }, () => NOW);
    assert.equal(snapshot.state, state); assert.equal(snapshot.voice, 'disconnected'); assert.doesNotMatch(JSON.stringify(snapshot), /unsafe text/);
  }
});
test('network/malformed/oversize health data is unavailable, without raw errors', async () => {
  for (const response of [null, new Response('{'), new Response('a'.repeat(4097)), Response.json({ ready: 'yes', voice: 'arbitrary private text' })]) {
    const snapshot = await inspectReadiness(env(), async () => { if (!response) throw new Error('sensitive failure'); return response; }, () => NOW);
    assert.equal(snapshot.state, 'unavailable'); assert.doesNotMatch(JSON.stringify(snapshot), /sensitive failure|arbitrary private text/);
  }
});
test('a probe completing after the original deadline does not report ready', async () => {
  let now = NOW;
  const snapshot = await inspectReadiness(env(), async () => { now += 600_000; return Response.json({ ready: true }); }, () => now);
  assert.equal(snapshot.state, 'inactive');
});

test('daily readiness only observes a live bounded session and never creates one', async () => {
  const daily = { ...env(), VOICE_USAGE_MODE: 'daily', VOICE_DEADLINE: '' };
  for (const deadline of [undefined, NOW - 1, NOW + 8 * 60 * 60_000 + 1]) {
    const snapshot = await inspectReadiness(daily, async () => Response.json({ ready: true, deadline }), () => NOW);
    assert.equal(snapshot.state, 'unavailable');
  }
  const snapshot = await inspectReadiness(daily, async () => Response.json({ ready: true, deadline: NOW + 8 * 60 * 60_000 }), () => NOW);
  assert.equal(snapshot.state, 'gateway-ready'); assert.equal(snapshot.deadline, new Date(NOW + 8 * 60 * 60_000).toISOString());
});
