import { ChannelType, PermissionsBitField } from 'discord.js';
const flags = PermissionsBitField.Flags;
const textTypes = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement,
  ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread];
function denied(code) { return Object.assign(new Error(code), { code }); }
export function assertChannelAccess(channel, caller, bot, guildId, command = true) {
  if (!channel || channel.guildId !== guildId || !textTypes.includes(channel.type) || !caller || !bot ||
      caller.guild.id !== guildId || bot.guild.id !== guildId ||
      !channel.permissionsFor(caller)?.has([flags.ViewChannel, ...(command ? [flags.UseApplicationCommands] : [])]) ||
      !channel.permissionsFor(bot)?.has(flags.ViewChannel) ||
      (channel.isThread?.() && channel.archived) ||
      (channel.type === ChannelType.PrivateThread && !channel.joined && !channel.permissionsFor(bot)?.has(flags.ManageThreads))) throw denied('TEXT_PERMISSION_REQUIRED');
}
export function assertVoiceAccess(channel, caller, bot, guildId) {
  if (!channel || channel.type !== ChannelType.GuildVoice || channel.guildId !== guildId || !caller || !bot ||
      caller.guild.id !== guildId || bot.guild.id !== guildId ||
      !channel.permissionsFor(caller)?.has([flags.ViewChannel, flags.Connect]) ||
      !channel.permissionsFor(bot)?.has([flags.ViewChannel, flags.Connect, flags.Speak])) throw denied('VOICE_PERMISSION_REQUIRED');
}

// Used by /say before narration or queue admission. A fresh targeted voice-state
// lookup is required; a guild cache or the invoking text channel is not a VC proof.
export async function authorizeSpeechCaller(guild, userId, textChannelId, voiceChannelId, signal) {
  signal.throwIfAborted();
  const voiceState = async () => {
    try { return await guild.voiceStates.fetch(userId, { force: true }); }
    catch (error) { if (error?.status === 404) return null; throw error; }
  };
  const [member, textChannel, me, state] = await Promise.all([
    guild.members.fetch({ user: userId, force: true }), guild.channels.fetch(textChannelId, { force: true }), guild.members.fetchMe({ force: true }),
    voiceState(),
  ]);
  signal.throwIfAborted();
  assertChannelAccess(textChannel, member, me, guild.id);
  if (!voiceChannelId || state?.channelId !== voiceChannelId) return null;
  const channel = await guild.channels.fetch(voiceChannelId, { force: true });
  signal.throwIfAborted();
  assertVoiceAccess(channel, member, me, guild.id);
  const latest = await voiceState();
  signal.throwIfAborted();
  return latest?.channelId === voiceChannelId ? member : null;
}
