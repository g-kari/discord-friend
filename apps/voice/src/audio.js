import { wavPcm } from './policy.js';

// @discordjs/voice's raw encoder consumes 960 stereo PCM16 samples per 20 ms
// frame and drops an incomplete final frame. Keep every source sample by
// padding that final frame with silence, never WAV headers or repeated audio.
export const DISCORD_FRAME_BYTES = 960 * 2 * 2;

export function discordPcmFromWav(audio) {
  const pcm = wavPcm(audio);
  const length = Math.ceil(pcm.length / DISCORD_FRAME_BYTES) * DISCORD_FRAME_BYTES;
  if (length === pcm.length) return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const result = Buffer.alloc(length);
  result.set(pcm);
  return result;
}
