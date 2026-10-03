import { VoiceError, CREDIT } from './policy.js';

// Only the engine's already-installed speakers/styles are eligible. Never proxy
// its model download, dictionary, initialization or mutation endpoints.
const label = value => typeof value === 'string' && value.trim().length > 0 &&
  Array.from(value).length <= 60 && !/[\u0000-\u001f\u007f@`<>]/u.test(value);
export function voiceCatalog(speakers) {
  if (!Array.isArray(speakers) || speakers.length > 512) throw new VoiceError('INVALID_VOICE_CATALOG', 502);
  const catalog = []; const ids = new Set();
  for (const speaker of speakers) {
    if (!speaker || !label(speaker.name) || !Array.isArray(speaker.styles)) throw new VoiceError('INVALID_VOICE_CATALOG', 502);
    for (const style of speaker.styles) {
      if (!style || !label(style.name) || !Number.isSafeInteger(style.id) || style.id < 0 || ids.has(style.id) || catalog.length >= 512) {
        throw new VoiceError('INVALID_VOICE_CATALOG', 502);
      }
      ids.add(style.id);
      catalog.push({ id: style.id, name: speaker.name.trim(), style: style.name.trim() });
    }
  }
  return catalog;
}
export function selectedVoice(catalog, speakerId) {
  if (speakerId !== undefined && (!Number.isSafeInteger(speakerId) || speakerId < 0)) throw new VoiceError('INVALID_SPEAKER');
  const voice = speakerId === undefined
    ? catalog.find(voice => voice.name === '春日部つむぎ' && voice.style === 'ノーマル')
    : catalog.find(voice => voice.id === speakerId);
  if (!voice) throw new VoiceError('VOICE_NOT_AVAILABLE', 503);
  return voice;
}
export function voiceCredit(voice) {
  return voice.name === '春日部つむぎ' && voice.style === 'ノーマル' ? CREDIT : `VOICEVOX:${voice.name}（${voice.style}）`;
}
