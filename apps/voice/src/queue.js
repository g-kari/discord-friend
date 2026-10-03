export class SpeechQueue {
  constructor(play, { limit = 10, onError = () => {}, onChange = () => {} } = {}) {
    this.play = play; this.limit = limit; this.onError = onError; this.onChange = onChange;
    this.items = []; this.current = null; this.running = false;
  }
  enqueue(item) {
    if (this.items.length + Number(this.running) >= this.limit) return false;
    this.items.push(item);
    void this.drain();
    this.onChange(this.items.length);
    return true;
  }
  clear() { this.items = []; this.current?.abort(); this.onChange(0); }
  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.items.length) {
        const item = this.items.shift();
        this.onChange(this.items.length);
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
    .replace(/https?:\/\/\S+/giu, 'リンク').replace(/<[^>]*>/gu, '')
    .replace(/[*_~#]/gu, '').trim();
}
