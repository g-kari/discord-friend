import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { InteractionLedger } from '../src/interaction-ledger.ts';
import { SessionCommands, commandRuntimeActive } from '../src/session-commands.ts';
import { scopeFingerprint } from '../src/guild-setup.ts';
import { principalFingerprint, commandScopeAllowed, scopePolicyActive, VIEW_CHANNEL, USE_COMMANDS } from '../src/scope-policy.ts';
import { receiveInteraction } from '../src/interactions.ts';
import type { InteractionCommand } from '../src/interactions.ts';

const NOW = Date.parse('2026-10-02T12:00:00Z');
const env = { BOT_ENABLED: 'true', DISCORD_HTTP_ENABLED: 'true', VOICE_USAGE_MODE: 'daily', VOICE_DEADLINE: '',
  VOICE_IDLE_SECONDS: '300', VOICE_SESSION_MINUTES: '30', DISCORD_SCOPE_MODE: 'installed-guilds',
  DISCORD_BOT_TOKEN: 'synthetic_test_secret', DISCORD_APPLICATION_ID: '100000000000000001',
  DISCORD_GUILD_ID: '100000000000000002', DISCORD_TEXT_CHANNEL_ID: '100000000000000003', DISCORD_OWNER_ID: '100000000000000004' };
const principal = principalFingerprint(env);
function command(n: number, name: InteractionCommand['name'] = 'join', guild = '100000000000000012', channel = '100000000000000013'): InteractionCommand {
  return { id: String(100000000000000000n + BigInt(n)), applicationId: env.DISCORD_APPLICATION_ID, guildId: guild, channelId: channel,
    userId: env.DISCORD_OWNER_ID, guildInstallId: guild, channelType: 0,
    memberPermissions: String(VIEW_CHANNEL | USE_COMMANDS), appPermissions: String(VIEW_CHANNEL), name,
    receivedAt: NOW, bodyHash: String(n).padStart(64, '0'), token: 'synthetic_reply_token' };
}
function fixture() {
  const db = new DatabaseSync(':memory:'); let now = NOW;
  const storage = { sql: { exec(sql: string, ...params: (string | number | null)[]) {
    const stmt = db.prepare(sql); const rows = stmt.columns().length ? stmt.all(...params) : (stmt.run(...params), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } }, sync: async () => {} };
  const ledger = new InteractionLedger(storage);
  const calls: string[] = []; const replies: string[] = []; const jobs: string[] = [];
  const runtime = {
    start: async () => { calls.push('start'); }, invoke: async (c: { name: string }) => { calls.push(c.name); return { content: 'ok', joined: true }; },
    status: async () => { calls.push('status'); return 'ready'; }, destroy: async () => { calls.push('destroy'); },
    model: async () => 'model', scheduleJob: async (id: string) => { jobs.push(id); }, scheduleExpiry: async () => {}, scheduleSweep: async () => {}, scheduleStop: async () => {},
  };
  const request: typeof fetch = async (_url, init) => { replies.push(JSON.parse(String(init?.body)).content); return new Response(null); };
  const engine = new SessionCommands(env, ledger, runtime, request, () => now, scopeFingerprint(env), principal);
  return { db, storage, ledger, engine, runtime, calls, replies, jobs, setNow: (value: number) => { now = value; } };
}
test('installed mode is opt-in and principal pinned; signed scope requires installation and caller/Bot permissions', () => {
  assert.equal(scopePolicyActive(env, scopeFingerprint(env)), false, 'synthetic identity never matches production');
  assert.equal(commandRuntimeActive(env, NOW, scopeFingerprint(env), principal), true);
  assert.equal(scopePolicyActive({ ...env, DISCORD_SCOPE_MODE: 'unknown' }, scopeFingerprint(env), principal), false);
  assert.equal(scopePolicyActive({ ...env, DISCORD_OWNER_ID: '100000000000000099' }, scopeFingerprint(env), principal), false);
  assert.equal(commandScopeAllowed(command(1), env), true);
  for (const patch of [{ guildInstallId: undefined }, { guildInstallId: env.DISCORD_GUILD_ID }, { userId: '100000000000000099' },
    { channelId: 'bad' }, { memberPermissions: '0' }, { appPermissions: '0' }, { channelType: 15 }, { channelType: 1 }]) {
    assert.equal(commandScopeAllowed({ ...command(1), ...patch }, env), false);
  }
});
test('ready and starting sessions reject foreign commands before control, budget, abort or runtime mutation', async () => {
  for (const ready of [false, true]) {
    const f = fixture(); const join = command(2);
    await f.engine.enqueue(join); if (ready) await f.engine.run(join.id);
    const session = f.ledger.session(); const budget = f.ledger.usage.reservation(); const calls = [...f.calls];
    const control = f.db.prepare('SELECT * FROM voice_scope_control').all();
    for (const name of ['join', 'stop', 'leave', 'say', 'voice-status'] as const) {
      await f.engine.enqueue(command(10, name, '100000000000000022', '100000000000000023'));
      await f.engine.enqueue(command(11, name, join.guildId, '100000000000000024'));
      assert.deepEqual(f.ledger.session(), session); assert.deepEqual(f.ledger.usage.reservation(), budget);
      assert.deepEqual(f.calls, calls); assert.deepEqual(f.db.prepare('SELECT * FROM voice_scope_control').all(), control);
    }
    assert.ok(f.replies.some(text => text.includes('別のチャンネル'))); f.db.close();
  }
});
test('simultaneous guild joins reserve/start only one owner session and invalid replay cannot spend again', async () => {
  const f = fixture(); const a = command(2); const b = command(3, 'join', '100000000000000022', '100000000000000023');
  await Promise.all([f.engine.enqueue(a), f.engine.enqueue(b)]);
  assert.equal(f.jobs.length, 1); await f.engine.run(f.jobs[0]);
  assert.deepEqual(f.calls, ['start', 'join']); assert.equal(f.ledger.usage.remaining(NOW), 30 * 60_000);
  await f.engine.enqueue(a); assert.equal(f.jobs.length, 1);
  f.db.close();
});
test('fresh foreign stop cannot cancel a delayed join in another scope; same-scope stop still can', () => {
  for (const same of [false, true]) {
    const f = fixture(); const older = command(2); const stop = same ? command(3, 'stop') : command(3, 'stop', '100000000000000022', '100000000000000023');
    f.ledger.claimControl(stop, NOW, true);
    const claim = f.ledger.accept(older, 'synthetic_cipher', NOW, NOW + 30 * 60_000, true, true);
    assert.equal(claim.accepted, !same); f.db.close();
  }
});
test('stopped foreign controls receive a final reply without changing predecessor scope or usage', async () => {
  const f = fixture(); const a = command(2); await f.engine.enqueue(a); await f.engine.run(a.id);
  await f.engine.enqueue(command(3, 'leave'));
  const before = { session: f.ledger.session(), usage: f.ledger.usage.reservation(), calls: [...f.calls], control: f.db.prepare('SELECT * FROM voice_scope_control').all() };
  for (const name of ['leave', 'stop'] as const) await f.engine.enqueue(command(4, name, '100000000000000022', '100000000000000023'));
  assert.deepEqual(f.replies.slice(-2), ['このチャンネルでは未接続です', 'このチャンネルでは未接続です']);
  assert.deepEqual({ session: f.ledger.session(), usage: f.ledger.usage.reservation(), calls: f.calls, control: f.db.prepare('SELECT * FROM voice_scope_control').all() }, before);
  f.db.close();
});
test('scope watermark metadata expires but a live session keeps its last control ordering', () => {
  const f = fixture(); const c = command(10);
  f.ledger.accept(c, 'cipher', NOW, NOW + 30 * 60_000, true, true);
  f.ledger.sweep(NOW + 16 * 60_000);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM voice_scope_control').get()?.n, 0);
  assert.equal(f.ledger.claimControl(command(9, 'stop'), NOW + 16 * 60_000, true).accepted, false);
  f.db.close();
});
test('usage remains aggregate across guilds and reconstruction; cleanup must settle before a new guild', async () => {
  const f = fixture(); const a = command(2); await f.engine.enqueue(a); await f.engine.run(a.id);
  const session = f.ledger.session()!; await f.engine.enqueue(command(3, 'leave'));
  f.setNow(NOW + 60_000);
  const b = { ...command(4, 'join', '100000000000000022', '100000000000000023'), receivedAt: NOW + 60_000 };
  await f.engine.enqueue(b); assert.equal(f.jobs.length, 1, 'unsettled reservation blocks replacement');
  f.ledger.usage.settle(session.id, NOW + 60_000);
  const reconstructed = new InteractionLedger(f.storage);
  assert.equal(reconstructed.usage.remaining(NOW + 60_000), 59 * 60_000);
  await f.engine.enqueue({ ...b, id: command(5).id }); assert.equal(f.jobs.length, 2);
  assert.equal(f.ledger.usage.remaining(NOW + 60_000), 29 * 60_000); f.db.close();
});
test('installed mode never admits a legacy unscoped session or extends it across modes', () => {
  const f = fixture(); const legacy = { id: '10000000-0000-4000-8000-000000000001', status: 'ready' as const, controlId: command(1).id, createdAt: NOW, deadline: NOW + 60000 };
  f.ledger.setSession(legacy); assert.equal(f.engine.admitted(legacy), false);
  assert.equal(f.ledger.accept(command(2), 'cipher', NOW, NOW + 60000, true, true).reason, 'scope'); f.db.close();
});
test('real signed HTTP ingress accepts installed guild only and rejects unauthorized payloads without lookup', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const httpEnv = { ...env, DISCORD_PUBLIC_KEY: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex') };
  const c = command(2); let calls = 0;
  const base = { type: 2, id: c.id, application_id: c.applicationId, guild_id: c.guildId, channel_id: c.channelId,
    channel: { id: c.channelId, type: 0 }, context: 0, authorizing_integration_owners: { '0': c.guildId },
    member: { user: { id: c.userId }, permissions: c.memberPermissions }, app_permissions: c.appPermissions,
    token: c.token, data: { type: 1, name: 'join' } };
  for (const [patch, ok] of [[{}, true], [{ context: 1 }, false], [{ authorizing_integration_owners: { '1': c.userId } }, false],
    [{ authorizing_integration_owners: { '0': c.guildId, '1': c.userId } }, false], [{ app_permissions: '0' }, false], [{ channel_id: env.DISCORD_TEXT_CHANNEL_ID }, false],
    [{ member: { user: { id: '100000000000000099' }, permissions: c.memberPermissions } }, false]] as const) {
    const raw = JSON.stringify({ ...base, ...patch }); const timestamp = String(NOW / 1000);
    const signature = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + raw))).toString('hex');
    const request = new Request('https://test.invalid/interactions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp, 'x-signature-ed25519': signature }, body: raw });
    const response = await receiveInteraction(request, httpEnv, async accepted => { calls++; assert.equal(accepted.guildId, c.guildId); }, () => {}, () => true, () => NOW, scopeFingerprint(env), principal);
    assert.equal((await response.json() as { type: number }).type, ok ? 5 : 4);
  }
  assert.equal(calls, 1);
});
