import { validateSpeech } from './policy.js';
import { readableMessage } from './queue.js';

function readableSpeaker(value) {
  if (typeof value !== 'string') return '';
  // Display names are text, never Discord markup or a source of links/code.
  // Unlike message decoration, underscores are meaningful in names (g_kari).
  return value.replace(/\|\|[\s\S]*?\|\|/gu, '')
    .replace(/```[\s\S]*?```/gu, '').replace(/`[^`]*`/gu, '')
    .replace(/https?:\/\/\S+/giu, '').replace(/<[^>]*>/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

export function speakerName({ member, user } = {}) {
  for (const candidate of [member?.displayName, user?.globalName, user?.username]) {
    const name = readableSpeaker(candidate);
    if (name && Array.from(name).length <= 32) return name;
  }
  return '話者';
}

export function narrationText(text, speaker) {
  const content = validateSpeech({ text }).text;
  // Keep the shared 500-code-point synthesis bound, including the prefix.
  // Do not silently truncate a person's name or message.
  return validateSpeech({ text: `${speakerName(speaker)}：${content}` }).text;
}

export function messageNarration(message, { guildId, textChannelId, channelId, ready }) {
  if (message.guildId !== guildId || message.channelId !== textChannelId || message.author?.bot ||
      !channelId || !ready || message.member?.voice?.channelId !== channelId) return null;
  const text = readableMessage(message.content);
  if (!text) return null;
  return narrationText(text, { member: message.member, user: message.author });
}
