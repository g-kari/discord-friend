import { Readable } from 'node:stream';
import { createAudioResource, entersState, AudioPlayerStatus, StreamType } from '@discordjs/voice';
import { boundedBytes, validateSpeech } from './policy.js';
import { discordPcmFromWav } from './audio.js';

// Called only by the speech queue. Joining or reading status never wakes TTS.
export function createSpeechPlayback({ isReady, touch, status, player, ttsUrl, sessionId,
  request = fetch, resourceFromPcm = pcm => createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }),
  waitForState = entersState }) {
  return async ({ text, authorId }, signal) => {
    const turn = status.begin();
    const abort = () => player.stop(true);
    const playbackChanged = (_previous, next) => {
      // Idle is terminal; finish() publishes idle/failure once, without a false
      // preparing transition that the presence throttle could leave on screen.
      if (next.status !== AudioPlayerStatus.Idle) status.playback(turn, next.status === AudioPlayerStatus.Playing);
    };
    let failed = false;
    try {
      if (!isReady()) throw new Error('Voice not ready');
      touch();
      const response = await request(ttsUrl, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voice-session-id': sessionId, 'x-voice-author-id': authorId },
        body: JSON.stringify(validateSpeech({ text })), signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]), redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Synthesis failed'); }
      const audio = await boundedBytes(response, 24 * 1024 * 1024);
      signal.throwIfAborted();
      const resource = resourceFromPcm(discordPcmFromWav(audio));
      signal.addEventListener('abort', abort, { once: true });
      player.on('stateChange', playbackChanged);
      player.play(resource);
      await waitForState(player, AudioPlayerStatus.Playing, AbortSignal.any([signal, AbortSignal.timeout(10000)]));
      signal.throwIfAborted();
      // Resource receipt / queue acceptance is not playback readiness.
      status.playback(turn, player.state.status === AudioPlayerStatus.Playing);
      await waitForState(player, AudioPlayerStatus.Idle, AbortSignal.any([signal, AbortSignal.timeout(150000)]));
      signal.throwIfAborted();
    } catch (error) {
      failed = !signal.aborted;
      throw error;
    } finally {
      signal.removeEventListener('abort', abort); player.off('stateChange', playbackChanged);
      player.stop(true);
      if (!signal.aborted) status.finish(turn, failed);
    }
  };
}
