import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertBotStartup } from '../src/startup-policy.js';

const now = Date.parse('2026-10-02T00:00:00Z');
const valid = {
  BOT_ENABLED: 'true', VOICE_DEADLINE: '2026-10-02T00:30:00Z',
  DISCORD_BOT_TOKEN: 'synthetic-unit-test-token', DISCORD_GUILD_ID: '12345678901234567',
  DISCORD_TEXT_CHANNEL_ID: '123456789012345678', DISCORD_OWNER_ID: '1234567890123456789',
};

test('Bot image requires an explicit enabled string independently of Worker dispatch', () => {
  for (const value of [undefined, '', 'false', 'TRUE', true, 1]) {
    assert.throws(() => assertBotStartup({ ...valid, BOT_ENABLED: value }, now), /Bot is disabled/);
  }
  assert.equal(assertBotStartup(valid, now), 1800000);
});

test('Bot image fails closed for missing, malformed, expired or over-budget deadlines', () => {
  for (const value of [undefined, '', 'bad', '2026-10-02T00:00:00Z', '2026-10-01T23:59:00Z', '2026-10-02T00:30:01Z']) {
    assert.throws(() => assertBotStartup({ ...valid, VOICE_DEADLINE: value }, now), /trial deadline/);
  }
  assert.equal(assertBotStartup(valid, now + 1200000), 600000, 'restart keeps the original deadline');
});

test('Bot image rejects missing credentials and invalid scoped IDs without exposing their values', () => {
  for (const name of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_TEXT_CHANNEL_ID', 'DISCORD_OWNER_ID']) {
    assert.throws(() => assertBotStartup({ ...valid, [name]: '' }, now), new RegExp(`Missing ${name}`));
  }
  for (const name of ['DISCORD_GUILD_ID', 'DISCORD_TEXT_CHANNEL_ID', 'DISCORD_OWNER_ID']) {
    for (const value of ['short', '1234567890123456', '123456789012345678901']) {
      assert.throws(() => assertBotStartup({ ...valid, [name]: value }, now), new RegExp(`Invalid ${name}`));
    }
  }
});

test('actual Bot entrypoint stops before client creation for disabled or unbounded startup', () => {
  const entrypoint = fileURLToPath(new URL('../src/bot.js', import.meta.url));
  for (const [override, message] of [
    [{ BOT_ENABLED: 'false' }, 'Bot is disabled'],
    [{ VOICE_DEADLINE: '' }, 'Missing trial deadline'],
  ]) {
    const child = spawnSync(process.execPath, [entrypoint], {
      env: { PATH: process.env.PATH, ...valid, ...override }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(child.status, 1, child.stderr);
    assert(child.stderr.includes(message), child.stderr);
    assert(!child.stderr.includes(valid.DISCORD_BOT_TOKEN), 'startup errors must not print credentials');
  }
});
