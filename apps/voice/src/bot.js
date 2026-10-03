import { Client, Events, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, entersState,
  VoiceConnectionStatus, NoSubscriberBehavior } from '@discordjs/voice';
import { validateSpeech } from './policy.js';
import { createSpeechPlayback } from './playback.js';
import { SpeechStatus, StatusPresence } from './speech-status.js';
import { SpeechQueue } from './queue.js';
import { messageNarration, narrationText } from './speech-text.js';
import { applyLifetime } from './lifetime.js';
import { assertBotStartup } from './startup-policy.js';
import { VoiceLifecycle } from './voice-lifecycle.js';
import { createCommandService } from './command-service.js';
import { createCommandServer } from './command-http.js';
import { assertChannelAccess, assertVoiceAccess, authorizeSpeechCaller } from './channel-access.js';

assertBotStartup(process.env);
const { DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId, DISCORD_APPLICATION_ID: applicationId,
  DISCORD_TEXT_CHANNEL_ID: textChannelId, DISCORD_OWNER_ID: ownerId, VOICE_SESSION_ID: sessionId } = process.env;
const installed = process.env.DISCORD_SCOPE_MODE === 'installed-guilds';
const ttsUrl = process.env.TTS_URL ?? 'http://tts.internal/v1/speech';
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
let lastError = null;
let commandService;
const presence = new StatusPresence({ publish: value => client.user.setPresence(value), available: () => client.isReady(), generic: installed });
const speechStatus = new SpeechStatus(value => presence.update(value));
client.on(Events.ClientReady, () => speechStatus.emit());
function recordError(error) {
  lastError = error?.code === 'SYNTHESIS_BUSY' ? 'SYNTHESIS_BUSY' : 'VOICE_OPERATION_FAILED';
  console.error(JSON.stringify({ event: 'voice_error', code: lastError }));
}
player.on('error', recordError);

const queue = new SpeechQueue(createSpeechPlayback({
  isReady: () => lifecycle.isReady, touch: () => commandService.touch(),
  status: speechStatus, player, ttsUrl, sessionId,
}), { onError: recordError, onChange: count => speechStatus.waiting(count) });

const lifecycle = new VoiceLifecycle({
  clearSpeech: () => { speechStatus.stop(); queue.clear(); player.stop(true); },
  onReady: candidate => candidate.subscribe(player),
  connect: channel => {
    const candidate = joinVoiceChannel({ channelId: channel.id, guildId,
      adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    candidate.on('error', recordError);
    candidate.on('stateChange', (_previous, next) => {
      if (lifecycle.connection !== candidate || lifecycle.attempt) return;
      speechStatus.transport(next.status === VoiceConnectionStatus.Ready ? 'ready' :
        [VoiceConnectionStatus.Disconnected, VoiceConnectionStatus.Destroyed].includes(next.status) ? 'disconnected' : 'reconnecting');
    });
    return candidate;
  },
  waitReady: (candidate, signal) => entersState(candidate, VoiceConnectionStatus.Ready, signal),
});
const leave = () => { lifecycle.leave(); speechStatus.transport('disconnected'); };

async function dispatchCommand(command, signal) {
    switch (command.name) {
      case 'join': {
        const statusJoin = lifecycle.attempt ? null : speechStatus.join();
        let result;
        try { result = await lifecycle.join(async () => {
          const guild = await client.guilds.fetch(guildId);
          const owner = await guild.members.fetch(installed ? { user: ownerId, force: true } : ownerId);
          let state;
          try { state = await guild.voiceStates.fetch(ownerId, { force: true }); }
          catch (error) { if (error?.status === 404) return null; throw error; }
          signal.throwIfAborted();
          const channel = installed && state?.channelId ? await guild.channels.fetch(state.channelId, { force: true }) : state?.channel;
          if (channel?.type !== ChannelType.GuildVoice) return null;
          const me = await guild.members.fetchMe(installed ? { force: true } : undefined);
          if (installed) {
            const textChannel = await guild.channels.fetch(textChannelId, { force: true });
            assertChannelAccess(textChannel, owner, me, guildId);
            assertVoiceAccess(channel, owner, me, guildId);
          }
          const permission = channel.permissionsFor(me);
          if (!permission?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) throw new Error('VOICE_PERMISSION_REQUIRED');
          signal.throwIfAborted();
          if (installed) {
            const latest = await guild.voiceStates.fetch(ownerId, { force: true });
            signal.throwIfAborted();
            if (latest?.channelId !== channel.id) return null;
          }
          return channel;
        }, signal); }
        catch (error) { speechStatus.completeJoin(statusJoin, false); throw error; }
        if (result !== 'joining') speechStatus.completeJoin(statusJoin, result === 'joined');
        return { content: {
          joining: '接続中です', cancelled: '接続を中止しました',
          'no-channel': '先に通常のボイスチャンネルへ入ってください',
          joined: installed ? 'VCに接続しました。このチャンネルの投稿だけを読み上げます。最初の投稿で音声を準備します（初回は起動待ちがあります）。既定:VOICEVOX:春日部つむぎ。声は /model、詳細は /voice-status。録音はしません' : 'VCに接続しました。最初の投稿で音声を準備します（初回は起動待ちがあります）。Botのステータスで準備状況を確認できます。既定:VOICEVOX:春日部つむぎ。声は /model、詳細は /voice-status。録音はしません',
        }[result], joined: result === 'joined' };
      }
      case 'leave': leave(); return { content: '退出しました', joined: false };
      case 'stop': speechStatus.stop(); queue.clear(); player.stop(true); return { content: '読み上げと待ち行列を停止しました', joined: lifecycle.isReady };
      case 'say': {
        if (!lifecycle.isReady) throw new Error('Not connected');
        const { text } = validateSpeech({ text: command.text });
        const guild = await client.guilds.fetch(guildId);
        const member = installed ? await authorizeSpeechCaller(guild, command.userId, textChannelId, lifecycle.channelId, signal) : await guild.members.fetch(command.userId);
        if (!member) return { content: '接続中のボイスチャンネルに参加してください', joined: true };
        signal.throwIfAborted();
        let narration;
        try { narration = narrationText(text, { member, user: member.user }); }
        catch { return { content: '話者名を含めて500文字以内にしてください', joined: true }; }
        return { content: queue.enqueue({ text: narration, authorId: command.userId }) ? `読み上げを受け付けました。${speechStatus.summary}。${installed ? '/voice-status で確認できます' : 'Botのステータスで確認できます'}` : '待ち行列が満杯です。少し待ってから再試行してください', joined: true };
      }
      case 'voice-status':
        return { content: `音声接続: ${lifecycle.connection?.state.status ?? '未接続'} / ${speechStatus.summary} / 直近エラー: ${lastError ?? 'なし'}`, joined: lifecycle.isReady };
    }
    throw new Error('UNKNOWN_COMMAND');
}
// All six application commands use the Worker's HTTP interaction route. Never
// install a Gateway interaction listener or acknowledge the same command twice.
client.on(Events.MessageCreate, message => {
  try {
    if (installed) {
      if (message.guildId !== guildId || message.channelId !== textChannelId || message.author?.bot || !lifecycle.isReady || message.member?.voice?.channelId !== lifecycle.channelId) return;
      const me = message.guild.members.me;
      assertChannelAccess(message.channel, message.member, me, guildId, false);
      assertVoiceAccess(message.member.voice.channel, message.member, me, guildId);
    }
    const text = messageNarration(message, { guildId, textChannelId,
      channelId: lifecycle.channelId, ready: lifecycle.isReady });
    if (!text) return;
    if (!queue.enqueue({ text, authorId: message.author.id })) lastError = 'QUEUE_FULL';
    else commandService.touch();
  } catch (error) { lastError = ['TEXT_PERMISSION_REQUIRED', 'VOICE_PERMISSION_REQUIRED'].includes(error?.code) ? error.code : 'MESSAGE_TOO_LONG'; }
});
client.on(Events.VoiceStateUpdate, (_oldState, state) => {
  if (state.guild.id !== guildId) return;
  if (state.id === client.user?.id) {
    const hadChannel = Boolean(lifecycle.channelId);
    lifecycle.observeBotChannel(state.channelId);
    if (hadChannel && !lifecycle.channelId) commandService.end();
  }
  if (!lifecycle.channelId) return;
  const channel = state.guild.channels.cache.get(lifecycle.channelId);
  if (channel?.isVoiceBased() && !channel.members.some(member => !member.user.bot)) commandService.end();
});
client.on(Events.Error, recordError);
const server = createCommandServer(request => commandService.handler(request));
const shutdown = () => { speechStatus.end(); leave(); presence.close(); client.destroy(); server.close(); setTimeout(() => process.exit(0), 500); };
commandService = createCommandService({
  scope: { applicationId, guildId, channelId: textChannelId, userId: ownerId }, sessionId,
  deadline: Date.parse(process.env.VOICE_DEADLINE), idleSeconds: Number(process.env.VOICE_IDLE_SECONDS),
  ready: () => client.isReady(), voiceStatus: () => lifecycle.connection?.state.status ?? 'disconnected', queued: () => queue.items.length, speechPhase: () => speechStatus.phase,
  dispatch: dispatchCommand, cancelJoin: () => { if (lifecycle.attempt) leave(); }, shutdown,
});
setInterval(() => commandService.checkIdle(), 1000).unref();
client.on(Events.ShardReconnecting, () => speechStatus.transport('reconnecting'));
client.on(Events.ShardResume, () => { if (!lifecycle.attempt) speechStatus.transport(lifecycle.isReady ? 'ready' : 'disconnected'); });
client.on(Events.ShardDisconnect, () => commandService.end());
server.listen(8080, '0.0.0.0');
process.once('SIGTERM', () => commandService.end());
applyLifetime(() => commandService.end());
// No automatic command registration: the explicit, separately authorized setup step owns that write.
try { await client.login(token); } catch { recordError(); commandService.end(); }
