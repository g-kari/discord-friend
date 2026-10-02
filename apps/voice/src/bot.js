import { Readable } from 'node:stream';
import { Client, Events, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType, NoSubscriberBehavior } from '@discordjs/voice';
import { assertWav, boundedBytes, validateSpeech } from './policy.js';
import { SpeechQueue, readableMessage } from './queue.js';
import { applyLifetime } from './lifetime.js';
import { assertBotStartup } from './startup-policy.js';
import { VoiceLifecycle } from './voice-lifecycle.js';
import { createCommandService } from './command-service.js';
import { createCommandServer } from './command-http.js';

assertBotStartup(process.env);
const { DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId, DISCORD_APPLICATION_ID: applicationId,
  DISCORD_TEXT_CHANNEL_ID: textChannelId, DISCORD_OWNER_ID: ownerId, VOICE_SESSION_ID: sessionId } = process.env;
const ttsUrl = process.env.TTS_URL ?? 'http://tts.internal/v1/speech';
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
let lastError = null;
let commandService;
function recordError(error) {
  lastError = error?.code === 'SYNTHESIS_BUSY' ? 'SYNTHESIS_BUSY' : 'VOICE_OPERATION_FAILED';
  console.error(JSON.stringify({ event: 'voice_error', code: lastError }));
}
player.on('error', recordError);

function pcmFromWav(audio) {
  assertWav(audio);
  const bytes = Buffer.from(audio);
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + size % 2;
  }
  throw new Error('Missing PCM');
}
const queue = new SpeechQueue(async (text, signal) => {
  if (!lifecycle.isReady) throw new Error('Voice not ready');
  commandService.touch();
  const response = await fetch(ttsUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-voice-session-id': sessionId },
    body: JSON.stringify(validateSpeech({ text })), signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Synthesis failed'); }
  const audio = await boundedBytes(response, 24 * 1024 * 1024);
  signal.throwIfAborted();
  const resource = createAudioResource(Readable.from([pcmFromWav(audio)]), { inputType: StreamType.Raw });
  const abort = () => player.stop(true);
  signal.addEventListener('abort', abort, { once: true });
  try {
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
    await entersState(player, AudioPlayerStatus.Idle, AbortSignal.any([signal, AbortSignal.timeout(150000)]));
    signal.throwIfAborted();
  } finally { signal.removeEventListener('abort', abort); player.stop(true); }
}, { onError: recordError });

const lifecycle = new VoiceLifecycle({
  clearSpeech: () => { queue.clear(); player.stop(true); },
  onReady: candidate => candidate.subscribe(player),
  connect: channel => {
    const candidate = joinVoiceChannel({ channelId: channel.id, guildId,
      adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    candidate.on('error', recordError);
    return candidate;
  },
  waitReady: (candidate, signal) => entersState(candidate, VoiceConnectionStatus.Ready, signal),
});
const leave = () => lifecycle.leave();

async function dispatchCommand(command, signal) {
    switch (command.name) {
      case 'join': {
        const result = await lifecycle.join(async () => {
          const guild = await client.guilds.fetch(guildId);
          await guild.members.fetch(ownerId);
          let state;
          try { state = await guild.voiceStates.fetch(ownerId, { force: true }); }
          catch (error) { if (error?.status === 404) return null; throw error; }
          signal.throwIfAborted();
          const channel = state?.channel;
          if (channel?.type !== ChannelType.GuildVoice) return null;
          const me = await guild.members.fetchMe();
          const permission = channel.permissionsFor(me);
          if (!permission?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])) throw new Error('VOICE_PERMISSION_REQUIRED');
          signal.throwIfAborted();
          return channel;
        }, signal);
        return { content: {
          joining: '接続中です', cancelled: '接続を中止しました',
          'no-channel': '先に通常のボイスチャンネルへ入ってください',
          joined: '読み上げを開始します（VOICEVOX:春日部つむぎ）。録音はしません',
        }[result], joined: result === 'joined' };
      }
      case 'leave': leave(); return { content: '退出しました', joined: false };
      case 'stop': queue.clear(); player.stop(true); return { content: '読み上げと待ち行列を停止しました', joined: lifecycle.isReady };
      case 'say': {
        if (!lifecycle.isReady) throw new Error('Not connected');
        const { text } = validateSpeech({ text: command.text });
        return { content: queue.enqueue(text) ? '読み上げを受け付けました' : '待ち行列が満杯です。少し待ってから再試行してください', joined: true };
      }
      case 'voice-status':
        return { content: `音声接続: ${lifecycle.connection?.state.status ?? '未接続'} / 待機: ${queue.items.length} / 直近エラー: ${lastError ?? 'なし'}`, joined: lifecycle.isReady };
    }
    throw new Error('UNKNOWN_COMMAND');
}
// All five application commands use the Worker's HTTP interaction route. Never
// install a Gateway interaction listener or acknowledge the same command twice.
client.on(Events.MessageCreate, message => {
  if (message.guildId !== guildId || message.channelId !== textChannelId || message.author.bot || !lifecycle.channelId ||
      !lifecycle.isReady || message.member?.voice.channelId !== lifecycle.channelId) return;
  const text = readableMessage(message.content);
  if (!text) return;
  try {
    validateSpeech({ text });
    if (!queue.enqueue(text)) lastError = 'QUEUE_FULL';
    else commandService.touch();
  } catch { lastError = 'MESSAGE_TOO_LONG'; }
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
const shutdown = () => { leave(); client.destroy(); server.close(); setTimeout(() => process.exit(0), 500); };
commandService = createCommandService({
  scope: { applicationId, guildId, channelId: textChannelId, userId: ownerId }, sessionId,
  deadline: Date.parse(process.env.VOICE_DEADLINE), idleSeconds: Number(process.env.VOICE_IDLE_SECONDS),
  ready: () => client.isReady(), voiceStatus: () => lifecycle.connection?.state.status ?? 'disconnected', queued: () => queue.items.length,
  dispatch: dispatchCommand, cancelJoin: () => { if (lifecycle.attempt) leave(); }, shutdown,
});
setInterval(() => commandService.checkIdle(), 1000).unref();
client.on(Events.ShardDisconnect, () => commandService.end());
server.listen(8080, '0.0.0.0');
process.once('SIGTERM', () => commandService.end());
applyLifetime(() => commandService.end());
// No automatic command registration: the explicit, separately authorized setup step owns that write.
try { await client.login(token); } catch { recordError(); commandService.end(); }
