import { boundedBytes, assertWav, validateSpeech, VoiceError } from './policy.js';
import { voiceCatalog, selectedVoice, voiceCredit } from './models.js';

/** Shared by the HTTP/RSS adapter and Discord playback. No files, text logging or silent fallback. */
export function createSynthesizer({ baseUrl = 'http://127.0.0.1:50021', fetchImpl = fetch, timeoutMs = 30000, onRecycle = () => {} } = {}) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid VOICEVOX service URL');
  }
  let active = false;
  let catalog = null;
  async function request(path, init, signal, limit, onResponse = () => {}) {
    const response = await fetchImpl(new URL(path, base), { ...init, signal, redirect: 'error' });
    onResponse();
    if (!response.ok) {
      await response.body?.cancel();
      throw new VoiceError('VOICEVOX_UNAVAILABLE', 502);
    }
    return boundedBytes(response, limit);
  }
  const synthesize = async function(input, callerSignal, { speakerId } = {}) {
    const { text, speed } = validateSpeech(input);
    if (speakerId !== undefined && (!Number.isSafeInteger(speakerId) || speakerId < 0)) throw new VoiceError('INVALID_SPEAKER');
    if (active) throw new VoiceError('SYNTHESIS_BUSY', 429);
    if (callerSignal?.aborted) throw new VoiceError('SYNTHESIS_CANCELLED_OR_TIMED_OUT', 504);
    // Ordinary VOICEVOX /synthesis cannot cancel CPU work when its HTTP client disconnects.
    // Retain admission and the upstream request until it finishes; discard cancelled output.
    const controller = new AbortController();
    let poisoned = false;
    let synthesisUnconfirmed = false;
    let timer;
    active = true;
    const recycle = () => {
      if (poisoned) return;
      poisoned = true;
      // Production exits the adapter; PID1 kills the engine. Without that callback this
      // instance stays closed, because an interrupted socket cannot prove CPU completion.
      onRecycle();
    };
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        recycle();
        reject(new VoiceError('SYNTHESIS_CANCELLED_OR_TIMED_OUT', 504));
      }, timeoutMs).unref();
    });
    const work = async () => {
      const signal = controller.signal;
      const speakers = JSON.parse(new TextDecoder().decode(await request('/speakers', {}, signal, 1024 * 1024)));
      signal.throwIfAborted(); callerSignal?.throwIfAborted();
      catalog = voiceCatalog(speakers);
      const style = selectedVoice(catalog, speakerId);
      const params = new URLSearchParams({ text, speaker: String(style.id) });
      const query = JSON.parse(new TextDecoder().decode(await request(`/audio_query?${params}`, { method: 'POST' }, signal, 2 * 1024 * 1024)));
      signal.throwIfAborted(); callerSignal?.throwIfAborted();
      if (!query || typeof query !== 'object' || !Array.isArray(query.accent_phrases)) throw new VoiceError('INVALID_QUERY', 502);
      query.speedScale = speed;
      query.outputSamplingRate = 48000;
      query.outputStereo = true;
      synthesisUnconfirmed = true;
      const audio = await request(`/synthesis?speaker=${style.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(query),
      }, signal, 24 * 1024 * 1024, () => { synthesisUnconfirmed = false; });
      signal.throwIfAborted(); assertWav(audio);
      callerSignal?.throwIfAborted();
      return { audio, contentType: 'audio/wav', credit: voiceCredit(style) };
    };
    try {
      // Also bound a fetch/body implementation that fails to reject on abort. The engine
      // may still be running; recycling is what enforces the actual CPU deadline.
      return await Promise.race([work(), deadline]);
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceError('SYNTHESIS_CANCELLED_OR_TIMED_OUT', 504);
      if (synthesisUnconfirmed) recycle();
      if (error instanceof VoiceError) throw error;
      if (callerSignal?.aborted) throw new VoiceError('SYNTHESIS_CANCELLED_OR_TIMED_OUT', 504);
      throw new VoiceError('VOICEVOX_UNAVAILABLE', 502);
    } finally {
      clearTimeout(timer);
      if (!poisoned) active = false;
    }
  };
  synthesize.catalog = () => catalog?.map(voice => ({ ...voice })) ?? null;
  return synthesize;
}
