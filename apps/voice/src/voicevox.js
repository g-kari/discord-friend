import { boundedBytes, assertWav, validateSpeech, VoiceError, CREDIT } from './policy.js';

/** Shared by the HTTP/RSS adapter and Discord playback. No files, text logging or silent fallback. */
export function createSynthesizer({ baseUrl = 'http://127.0.0.1:50021', fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid VOICEVOX service URL');
  }
  let active = false;
  // Resolve the named voice instead of assuming an AivisSpeech style ID is a VOICEVOX ID.
  async function request(path, init, signal, limit) {
    const response = await fetchImpl(new URL(path, base), { ...init, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new VoiceError('VOICEVOX_UNAVAILABLE', 502);
    }
    return boundedBytes(response, limit);
  }
  return async function synthesize(input, callerSignal) {
    const { text, speed } = validateSpeech(input);
    if (active) throw new VoiceError('SYNTHESIS_BUSY', 429);
    const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    signal.throwIfAborted();
    active = true;
    try {
      const speakers = JSON.parse(new TextDecoder().decode(await request('/speakers', {}, signal, 1024 * 1024)));
      const speaker = Array.isArray(speakers) && speakers.find(s => s.name === '春日部つむぎ');
      const style = speaker && Array.isArray(speaker.styles) && speaker.styles.find(s => s.name === 'ノーマル');
      if (!style || !Number.isSafeInteger(style.id) || style.id < 0) throw new VoiceError('VOICE_NOT_AVAILABLE', 503);
      const params = new URLSearchParams({ text, speaker: String(style.id) });
      const query = JSON.parse(new TextDecoder().decode(await request(`/audio_query?${params}`, { method: 'POST' }, signal, 2 * 1024 * 1024)));
      if (!query || typeof query !== 'object' || !Array.isArray(query.accent_phrases)) throw new VoiceError('INVALID_QUERY', 502);
      query.speedScale = speed;
      query.outputSamplingRate = 48000;
      query.outputStereo = true;
      const audio = await request(`/synthesis?speaker=${style.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
      }, signal, 24 * 1024 * 1024);
      assertWav(audio);
      return { audio, contentType: 'audio/wav', credit: CREDIT };
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      if (signal.aborted) throw new VoiceError('SYNTHESIS_CANCELLED_OR_TIMED_OUT', 504);
      throw new VoiceError('VOICEVOX_UNAVAILABLE', 502);
    } finally {
      active = false;
    }
  };
}
