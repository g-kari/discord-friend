function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** One generation owns lookup, leave acknowledgement, negotiation and player subscription. */
export class VoiceLifecycle {
  constructor({ connect, waitReady, clearSpeech, onReady = () => {}, readyTimeoutMs = 20000 }) {
    this.connect = connect; this.waitReady = waitReady; this.clearSpeech = clearSpeech;
    this.onReady = onReady; this.readyTimeoutMs = readyTimeoutMs;
    this.connection = null; this.channelId = null; this.attempt = null; this.pendingLeave = null;
  }

  get isReady() { return !this.attempt && this.connection?.state.status === 'ready'; }

  disconnect() {
    this.clearSpeech();
    const previous = this.connection; this.connection = null; this.channelId = null;
    if (previous && previous.state.status !== 'destroyed') {
      // Discord does not tag voice-state ACKs with our generation. Drain the predecessor's
      // leave ACK before a replacement join so it cannot arrive after the new join is ready.
      if (!this.pendingLeave) {
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        this.pendingLeave = { promise, resolve };
      }
      previous.destroy();
    }
  }

  leave() {
    const previousAttempt = this.attempt; this.attempt = null;
    previousAttempt?.controller.abort();
    this.disconnect();
  }

  observeBotChannel(channelId) {
    if (this.pendingLeave) {
      if (channelId === null) {
        const previous = this.pendingLeave; this.pendingLeave = null; previous.resolve();
      }
      return;
    }
    if (this.attempt?.expectedChannelId) {
      if (channelId === this.attempt.expectedChannelId) {
        this.attempt.confirmed = true; this.attempt.confirm();
      } else if (this.attempt.confirmed) {
        // Once Discord acknowledged the target, a later kick/move is current state,
        // not a predecessor ACK, even if transport readiness is still pending.
        this.leave();
      }
      return;
    }
    if (this.channelId && channelId !== this.channelId) this.leave();
  }

  async join(resolveChannel, externalSignal) {
    if (this.attempt) return 'joining';
    const attempt = { controller: new AbortController(), expectedChannelId: null, confirm: null };
    this.attempt = attempt; // Lock before the first asynchronous member lookup.
    const signal = AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(this.readyTimeoutMs), ...(externalSignal ? [externalSignal] : [])]);
    let removeAbortListener = () => {};
    try {
      const channel = await abortable(resolveChannel(signal), signal);
      if (this.attempt !== attempt) return 'cancelled';
      if (!channel) return 'no-channel';
      this.disconnect();
      if (this.pendingLeave) await abortable(this.pendingLeave.promise, signal);
      signal.throwIfAborted();
      if (this.attempt !== attempt) return 'cancelled';
      attempt.expectedChannelId = channel.id;
      const confirmed = new Promise((resolve, reject) => {
        attempt.confirm = resolve;
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', abort);
      });
      // connect() itself can throw before Promise.all attaches its rejection handler.
      void confirmed.catch(() => {});
      const candidate = this.connect(channel);
      this.connection = candidate; this.channelId = channel.id;
      candidate.on('disconnected', () => { if (this.connection === candidate) this.leave(); });
      await Promise.all([confirmed, this.waitReady(candidate, signal)]);
      if (this.attempt !== attempt || this.connection !== candidate) return 'cancelled';
      // Subscribe before relinquishing ownership; callers must not act on a later generation.
      this.onReady(candidate);
      return this.attempt === attempt && this.connection === candidate ? 'joined' : 'cancelled';
    } catch (error) {
      if (this.attempt !== attempt) return 'cancelled';
      this.leave();
      throw error;
    } finally {
      removeAbortListener();
      if (this.attempt === attempt) this.attempt = null;
    }
  }
}
