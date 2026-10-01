export class SpeechQueue {
  constructor(play, { limit = 10, onError = () => {} } = {}) {
    this.play = play; this.limit = limit; this.onError = onError;
    this.items = []; this.current = null; this.running = false;
  }
  enqueue(item) {
    if (this.items.length + Number(this.running) >= this.limit) return false;
    this.items.push(item);
    void this.drain();
    return true;
  }
  clear() { this.items = []; this.current?.abort(); }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length) {
        const item = this.items.shift();
        const controller = new AbortController();
        this.current = controller;
        try { await this.play(item, controller.signal); }
        catch (error) { if (!controller.signal.aborted) this.onError(error); }
        finally { if (this.current === controller) this.current = null; }
      }
    } finally { this.running = false; }
  }
}

export function readableMessage(text) {
  // Do not read hidden spoilers, code, mentions or URLs out loud.
  return text.replace(/\|\|[\s\S]*?\|\|/gu, '')
    .replace(/```[\s\S]*?```/gu, '').replace(/`[^`]*`/gu, '')
    .replace(/https?:\/\/\S+/gu, 'リンク').replace(/<[^>]*>/gu, '')
    .replace(/[*_~#]/gu, '').trim();
}
