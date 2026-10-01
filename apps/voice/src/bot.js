import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Client, Events, GatewayIntentBits, MessageFlags, ChannelType } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType, NoSubscriberBehavior } from '@discordjs/voice';
import { assertWav, boundedBytes, validateSpeech } from './policy.js';
import { SpeechQueue, readableMessage } from './queue.js';

const required = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_TEXT_CHANNEL_ID', 'DISCORD_OWNER_ID'];
for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name}`);
for (const name of required.slice(1)) if (!/^\d{17,20}$/u.test(process.env[name])) throw new Error(`Invalid ${name}`);
const { DISCORD_BOT_TOKEN: token, DISCORD_GUILD_ID: guildId,
  DISCORD_TEXT_CHANNEL_ID: textChannelId, DISCORD_OWNER_ID: ownerId } = process.env;
const ttsUrl = process.env.TTS_URL ?? 'http://tts.internal/v1/speech';
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent] });
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
let connection = null;
let voiceChannelId = null;
let joining = false;
let lastError = null;
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
  if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Voice not ready');
  const response = await fetch(ttsUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
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

function leave() {
  queue.clear(); player.stop(true);
  const previous = connection; connection = null; voiceChannelId = null;
  if (previous && previous.state.status !== VoiceConnectionStatus.Destroyed) previous.destroy();
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || !['join', 'leave', 'stop', 'say', 'voice-status'].includes(interaction.commandName)) return;
  if (interaction.guildId !== guildId || interaction.channelId !== textChannelId || interaction.user.id !== ownerId) {
    await interaction.reply({ content: 'この操作は指定チャンネルの管理者のみ利用できます', flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    switch (interaction.commandName) {
      case 'join': {
        if (joining) { await interaction.editReply('接続中です'); return; }
        const member = await interaction.guild.members.fetch(ownerId);
        const channel = member.voice.channel;
        if (!channel || channel.type !== ChannelType.GuildVoice) { await interaction.editReply('先に通常のボイスチャンネルへ入ってください'); return; }
        joining = true;
        try {
          leave();
          const candidate = joinVoiceChannel({ channelId: channel.id, guildId,
            adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
          connection = candidate; voiceChannelId = channel.id;
          candidate.on('error', recordError);
          candidate.on(VoiceConnectionStatus.Disconnected, () => {
            if (connection === candidate) leave();
          });
          await entersState(candidate, VoiceConnectionStatus.Ready, 20000);
          if (connection !== candidate) throw new Error('Connection superseded');
          candidate.subscribe(player);
          await interaction.editReply('読み上げを開始します（VOICEVOX:春日部つむぎ）。録音はしません');
        } finally { joining = false; }
        break;
      }
      case 'leave': leave(); await interaction.editReply('退出しました'); break;
      case 'stop': queue.clear(); player.stop(true); await interaction.editReply('読み上げと待ち行列を停止しました'); break;
      case 'say': {
        if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) throw new Error('Not connected');
        const { text } = validateSpeech({ text: interaction.options.getString('text', true) });
        await interaction.editReply(queue.enqueue(text) ? '読み上げを受け付けました' : '待ち行列が満杯です。少し待ってから再試行してください');
        break;
      }
      case 'voice-status':
        await interaction.editReply(`音声接続: ${connection?.state.status ?? '未接続'} / 待機: ${queue.items.length} / 直近エラー: ${lastError ?? 'なし'}`);
    }
  } catch (error) {
    recordError(error);
    if (interaction.commandName === 'join') leave();
    await interaction.editReply('処理に失敗しました。音声エンジンと接続状態を確認してください');
  }
}
client.on(Events.InteractionCreate, interaction => { void handleInteraction(interaction).catch(recordError); });
client.on(Events.MessageCreate, message => {
  if (message.guildId !== guildId || message.channelId !== textChannelId || message.author.bot || !voiceChannelId ||
      connection?.state.status !== VoiceConnectionStatus.Ready || message.member?.voice.channelId !== voiceChannelId) return;
  const text = readableMessage(message.content);
  if (!text) return;
  try {
    validateSpeech({ text });
    if (!queue.enqueue(text)) lastError = 'QUEUE_FULL';
  } catch { lastError = 'MESSAGE_TOO_LONG'; }
});
client.on(Events.VoiceStateUpdate, (_oldState, state) => {
  if (state.guild.id !== guildId || !voiceChannelId) return;
  if (state.id === client.user?.id && state.channelId !== voiceChannelId) { leave(); return; }
  const channel = state.guild.channels.cache.get(voiceChannelId);
  if (channel?.isVoiceBased() && !channel.members.some(member => !member.user.bot)) leave();
});
client.on(Events.Error, recordError);
const server = createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/health') { res.writeHead(404).end(); return; }
  res.writeHead(client.isReady() ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ready: client.isReady(), voice: connection?.state.status ?? 'disconnected', lastError }));
});
server.listen(8080, '0.0.0.0');
process.once('SIGTERM', () => { leave(); client.destroy(); server.close(); });
// No automatic command registration: the explicit, separately authorized setup step owns that write.
await client.login(token);
