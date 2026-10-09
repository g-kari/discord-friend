import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { assertChannelAccess, assertVoiceAccess, authorizeSpeechCaller } from '../src/channel-access.js';
import { StatusPresence } from '../src/speech-status.js';
import { assertBotStartup } from '../src/startup-policy.js';
import { createHash } from 'node:crypto';
const F = PermissionsBitField.Flags;
const guildId = '100000000000000002';
const caller = { id: 'owner', guild: { id: guildId } }; const bot = { id: 'bot', guild: { id: guildId } };
function channel(type = 0, own = [F.ViewChannel, F.Connect, F.UseApplicationCommands], me = [F.ViewChannel, F.Connect, F.Speak]) {
  return { type, guildId, joined: true, archived: false, isThread: () => [10, 11, 12].includes(type),
    permissionsFor: user => new PermissionsBitField(user === bot ? me : own) };
}
test('only accessible text streams and joined threads; caller application permission and bot view required', () => {
  for (const type of [0, 2, 5, 10, 11, 12]) assert.doesNotThrow(() => assertChannelAccess(channel(type), caller, bot, guildId));
  for (const bad of [channel(15), { ...channel(12), joined: false }, { ...channel(11), archived: true },
    { ...channel(), guildId: 'foreign' }, channel(0, [F.ViewChannel]), channel(0, undefined, [])]) {
    assert.throws(() => assertChannelAccess(bad, caller, bot, guildId), /TEXT_PERMISSION_REQUIRED/);
  }
  assert.doesNotThrow(() => assertChannelAccess({ ...channel(11), joined: false }, caller, bot, guildId));
  assert.doesNotThrow(() => assertChannelAccess({ ...channel(12, undefined, [F.ViewChannel, F.ManageThreads]), joined: false }, caller, bot, guildId));
  assert.doesNotThrow(() => assertChannelAccess(channel(0, [F.ViewChannel]), caller, bot, guildId, false), 'ordinary message does not require slash-command permission');
});
test('normal voice requires caller view/connect and bot view/connect/speak; Stage and crossguild rejected', () => {
  assert.doesNotThrow(() => assertVoiceAccess(channel(2), caller, bot, guildId));
  for (const bad of [channel(13), channel(2, [F.ViewChannel]), channel(2, undefined, [F.ViewChannel, F.Connect]), { ...channel(2), guildId: 'foreign' }]) {
    assert.throws(() => assertVoiceAccess(bad, caller, bot, guildId), /VOICE_PERMISSION_REQUIRED/);
  }
});
test('installed global presence exposes only four generic phases, never counts or session labels', () => {
  const sent = []; let now = 0;
  const presence = new StatusPresence({ publish: value => sent.push(value), available: () => true, now: () => now, generic: true });
  for (const phase of ['connecting', 'preparing', 'speaking', 'idle']) { now += 5001; presence.update({ phase, summary: 'private_scope_with_queue_99' }); }
  assert.deepEqual(sent.map(value => value.activities[0].state), ['起動中', '音声準備中', '読み上げ中', '待機中']);
  assert.doesNotMatch(JSON.stringify(sent), /private|99/); presence.close();
});
test('installed image accepts dynamic valid channel IDs only under separately pinned app/owner principal', () => {
  const now = Date.parse('2026-10-02T12:00:00Z');
  const env = { BOT_ENABLED: 'true', DISCORD_SCOPE_MODE: 'installed-guilds', DISCORD_COMMAND_TRANSPORT: 'http',
    DISCORD_BOT_TOKEN: 'synthetic', DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_OWNER_ID: '100000000000000004',
    DISCORD_GUILD_ID: guildId, DISCORD_TEXT_CHANNEL_ID: '100000000000000013', VOICE_IDLE_SECONDS: '300',
    VOICE_SESSION_ID: '10000000-0000-4000-8000-000000000001', VOICE_DEADLINE: new Date(now + 60000).toISOString() };
  const principal = createHash('sha256').update(`${env.DISCORD_APPLICATION_ID}:${env.DISCORD_OWNER_ID}`).digest('hex');
  assert.equal(assertBotStartup(env, now, undefined, principal), 60000);
  assert.throws(() => assertBotStartup(env, now), /principal mismatch/);
  assert.throws(() => assertBotStartup({ ...env, DISCORD_OWNER_ID: '100000000000000099' }, now, undefined, principal), /principal mismatch/);
  assert.throws(() => assertBotStartup({ ...env, DISCORD_SCOPE_MODE: 'unknown' }, now, undefined, principal), /scope mismatch/);
});

test('say authorization uses only targeted reads and rejects an owner who left/moved VC before queue admission', async () => {
  let state = { channelId: 'vc', channel: channel(2) }; let queueAdmissions = 0; const calls = [];
  const guild = { id: guildId,
    members: { fetch: async id => { calls.push(['member', id]); return caller; }, fetchMe: async () => bot },
    channels: { fetch: async (id, options) => { calls.push(['channel', id, options]); return channel(id === 'vc' ? 2 : 0); } },
    voiceStates: { fetch: async (id, options) => { calls.push(['voice', id, options]); return state; } },
  };
  for (const target of ['elsewhere', null, 'vc']) {
    state = { ...state, channelId: target };
    const member = await authorizeSpeechCaller(guild, caller.id, 'text', 'vc', new AbortController().signal);
    if (member) queueAdmissions++;
    assert.equal(Boolean(member), target === 'vc');
  }
  assert.equal(queueAdmissions, 1);
  assert.equal(calls.filter(call => call[0] === 'voice').length, 4);
  assert.ok(calls.filter(call => call[0] === 'voice').every(call => call[1] === caller.id && call[2].force === true));
  assert.ok(calls.filter(call => call[0] === 'channel').every(call => ['text', 'vc'].includes(call[1]) && call[2].force === true));
  assert.equal(calls.filter(call => call[0] === 'channel' && call[1] === 'vc').length, 1);
  assert.ok(calls.filter(call => call[0] === 'member').every(call => call[1].user === caller.id && call[1].force === true));
  state = { channelId: 'vc', channel: channel(2) };
  guild.channels.fetch = async id => {
    if (id === 'vc') state = { ...state, channelId: 'moved-during-permission-check' };
    return channel(id === 'vc' ? 2 : 0);
  };
  assert.equal(await authorizeSpeechCaller(guild, caller.id, 'text', 'vc', new AbortController().signal), null);
  const aborted = new AbortController(); aborted.abort();
  const beforeAbort = calls.length;
  await assert.rejects(authorizeSpeechCaller(guild, caller.id, 'text', 'vc', aborted.signal));
  assert.equal(calls.length, beforeAbort, 'an already-aborted command performs no REST reads');
});

test('say handles Discord 404 on either voice lookup as left VC, without queue admission; other failures reject', async () => {
  for (const missingAt of [1, 2]) {
    let lookups = 0; let queueAdmissions = 0;
    const guild = { id: guildId,
      members: { fetch: async () => caller, fetchMe: async () => bot },
      channels: { fetch: async id => channel(id === 'vc' ? 2 : 0) },
      voiceStates: { fetch: async () => {
        lookups++;
        if (lookups === missingAt) throw Object.assign(new Error('synthetic_missing_voice_state'), { status: 404 });
        return { channelId: 'vc' };
      } },
    };
    const member = await authorizeSpeechCaller(guild, caller.id, 'text', 'vc', new AbortController().signal);
    if (member) queueAdmissions++;
    assert.equal(member, null); assert.equal(queueAdmissions, 0); assert.equal(lookups, missingAt);
    guild.voiceStates.fetch = async () => { throw Object.assign(new Error('synthetic_transport_failure'), { status: 503 }); };
    await assert.rejects(authorizeSpeechCaller(guild, caller.id, 'text', 'vc', new AbortController().signal), /synthetic_transport_failure/);
  }
});
