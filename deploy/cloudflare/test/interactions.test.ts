import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiveInteraction, completeInteraction } from '../src/interactions.ts';
import { scopeFingerprint } from '../src/guild-setup.ts';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const scope = { DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_GUILD_ID: '100000000000000002', DISCORD_TEXT_CHANNEL_ID: '100000000000000003', DISCORD_OWNER_ID: '100000000000000004' };
const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
const env = { ...scope, DISCORD_HTTP_ENABLED: 'true', DISCORD_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') };
function payload(name = 'join') {
  return { type: 2, application_id: scope.DISCORD_APPLICATION_ID, id: '100000000000000011', guild_id: scope.DISCORD_GUILD_ID,
    channel_id: scope.DISCORD_TEXT_CHANNEL_ID, member: { user: { id: scope.DISCORD_OWNER_ID } },
    token: 'synthetic_interaction_reply_token', data: { type: 1, name, ...(name === 'say' ? { options: [{ type: 3, name: 'text', value: 'こんにちは' }] } : {}) } };
}
async function signed(body: unknown, stamp = String(NOW / 1000), raw = JSON.stringify(body)): Promise<Request> {
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(stamp + raw))).toString('hex');
  return new Request('https://worker.invalid/interactions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-timestamp': stamp, 'x-signature-ed25519': signature }, body: raw });
}
async function invoke(request: Request, active = true, override = env) {
  const queued: unknown[] = []; const background: Promise<void>[] = [];
  const response = await receiveInteraction(request, override, async command => { queued.push(command); }, work => background.push(work), () => active, () => NOW, scopeFingerprint(env));
  await Promise.all(background); return { response, queued };
}
test('signed PING is acknowledged without command dispatch or Container access', async () => {
  const result = await invoke(await signed({ type: 1 }), false);
  assert.deepEqual(await result.response.json(), { type: 1 }); assert.deepEqual(result.queued, []);
});
test('actual awaited Ed25519 verification refuses an altered byte, invalid signature and missing headers', async () => {
  const good = await signed(payload()); const bytes = await good.text();
  const altered = new Request(good.url, { method: 'POST', headers: good.headers, body: `${bytes} ` });
  for (const request of [altered, new Request(good.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes })]) {
    const result = await invoke(request); assert.equal(result.response.status, 401); assert.deepEqual(result.queued, []);
  }
});
test('signed stale and future timestamps are independently rejected', async () => {
  for (const stamp of [String((NOW - 60_001) / 1000), String((NOW + 11_000) / 1000)]) {
    const result = await invoke(await signed(payload(), stamp)); assert.equal(result.response.status, 401); assert.equal(result.queued.length, 0);
  }
});
test('all six scoped commands defer ephemerally and keep reply tokens out of the response', async () => {
  for (const name of ['join', 'leave', 'stop', 'voice-status', 'say', 'model']) {
    const result = await invoke(await signed(payload(name))); assert.equal(result.response.status, 200);
    const response = await result.response.text(); assert.deepEqual(JSON.parse(response), { type: 5, data: { flags: 64 } });
    assert.doesNotMatch(response, /synthetic_interaction/); assert.equal(result.queued.length, 1);
  }
});
test('acknowledgement does not wait for a never-finishing startup operation', async () => {
  let called = false;
  const started = performance.now();
  const result = await receiveInteraction(await signed(payload()), env, () => { called = true; return new Promise(() => {}); }, () => {}, () => true, () => NOW, scopeFingerprint(env));
  assert.equal(result.status, 200); assert(called); assert(performance.now() - started < 3000);
});
test('wrong owner, guild, app, channel, DM and conflicting channel fields never dispatch', async () => {
  const bad = [
    { ...payload(), application_id: '100000000000000099' }, { ...payload(), guild_id: '100000000000000099' },
    { ...payload(), channel_id: '100000000000000099' }, { ...payload(), member: { user: { id: '100000000000000099' } } },
    { ...payload(), user: { id: scope.DISCORD_OWNER_ID } }, { ...payload(), context: 1 },
    { ...payload(), channel: { id: '100000000000000099' } }, { ...payload(), data: { type: 1, name: 'status' } },
  ];
  for (const body of bad) { const result = await invoke(await signed(body)); assert.equal(result.queued.length, 0); }
});
test('inactive config, wrong fingerprint and invalid say input do not dispatch', async () => {
  assert.equal((await invoke(await signed(payload()), false)).queued.length, 0);
  assert.equal((await invoke(await signed(payload()), true, { ...env, DISCORD_OWNER_ID: '100000000000000099' })).queued.length, 0);
  for (const value of ['', 'a'.repeat(501), 'bad\u0000text']) {
    const body = payload('say'); body.data.options![0].value = value;
    assert.equal((await invoke(await signed(body))).queued.length, 0);
  }
});
test('oversized raw bodies are refused before signature crypto or dispatch', async () => {
  const result = await invoke(await signed(payload(), String(NOW / 1000), ' '.repeat(16_385)));
  assert.equal(result.response.status, 413); assert.deepEqual(result.queued, []);
});
test('deferred completion refuses redirects and never retries an operation or exposes raw errors', async () => {
  for (const status of [200, 302, 429, 401]) {
    let calls = 0;
    const result = await completeInteraction(scope.DISCORD_APPLICATION_ID, 'synthetic_reply_token', '完了', async (_url, init) => {
      calls++; assert.equal(init?.redirect, 'manual'); assert.equal(init?.method, 'PATCH');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      assert.deepEqual(JSON.parse(String(init?.body)).allowed_mentions, { parse: [] });
      return new Response('discard', { status, headers: { location: 'https://other.invalid/' } });
    });
    assert.equal(result, status === 200); assert.equal(calls, 1);
  }
  assert.equal(await completeInteraction(scope.DISCORD_APPLICATION_ID, 'synthetic_reply_token', '完了', async () => { throw new Error('https://secret.invalid/synthetic_reply_token'); }), false);
});


test('model accepts listing, a style ID or a page only within the fixed owner scope', async () => {
  for (const [name, value, key] of [['id', 8, 'speakerId'], ['page', 2, 'page']] as const) {
    const body = { ...payload('model'), data: { type: 1, name: 'model', options: [{ type: 4, name, value }] } };
    const result = await invoke(await signed(body));
    assert.equal(result.queued.length, 1); assert.equal((result.queued[0] as any)[key], value);
    assert.equal((await invoke(await signed({ ...body, member: { user: { id: '100000000000000099' } } }))).queued.length, 0);
  }
  for (const options of [
    [{ type: 4, name: 'id', value: -1 }], [{ type: 4, name: 'id', value: 0.5 }],
    [{ type: 4, name: 'id', value: Number.MAX_SAFE_INTEGER + 1 }], [{ type: 3, name: 'id', value: '8' }],
    [{ type: 4, name: 'page', value: 0 }], [{ type: 4, name: 'url', value: 8 }],
    [{ type: 4, name: 'id', value: 8 }, { type: 4, name: 'page', value: 1 }],
  ]) assert.equal((await invoke(await signed({ ...payload('model'), data: { type: 1, name: 'model', options } }))).queued.length, 0);
});


test('authenticated model metadata is allowed with inactive voice runtime but never with HTTP disabled or a mismatched scope', async () => {
  assert.equal((await invoke(await signed(payload('model')), false)).queued.length, 1);
  assert.equal((await invoke(await signed(payload('join')), false)).queued.length, 0);
  assert.equal((await invoke(await signed(payload('model')), false, { ...env, DISCORD_HTTP_ENABLED: 'false' })).queued.length, 0);
  assert.equal((await invoke(await signed(payload('model')), false, { ...env, DISCORD_OWNER_ID: '100000000000000099' })).queued.length, 0);
});
