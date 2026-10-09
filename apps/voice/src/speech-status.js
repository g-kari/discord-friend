// State is observational only: it never starts TTS, adds work or refreshes idle time.
export const SPEECH_LABELS = Object.freeze({
  connecting: 'Bot接続準備中',
  'awaiting-text': '初回読み上げ待機（投稿時に音声を準備）',
  preparing: '音声準備中（初回は起動待ち）',
  speaking: '読み上げ中',
  idle: '読み上げ待機中',
  stopped: '読み上げ停止（次の投稿で再開）',
  failed: '読み上げ失敗（次の投稿で再試行）',
  reconnecting: '音声接続の復旧待ち',
  disconnected: '未接続',
  ended: 'セッション終了',
});

export class SpeechStatus {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.connection = 'connecting'; this.speech = 'awaiting-text';
    this.active = null; this.joinTurn = null; this.ended = false; this.queued = 0;
  }
  get phase() { return this.ended ? 'ended' : this.connection === 'ready' ? this.speech : this.connection; }
  get label() { return SPEECH_LABELS[this.phase]; }
  get summary() { return `${this.label} / 待機: ${this.queued}件`; }
  emit() { this.onChange(this); }
  transport(connection) {
    if (this.ended) return;
    if (connection === 'disconnected') this.joinTurn = null;
    this.connection = connection; this.emit();
  }
  join() {
    if (this.ended) return;
    const turn = {}; this.joinTurn = turn;
    this.active = null; this.speech = 'awaiting-text'; this.transport('connecting');
    return turn;
  }
  completeJoin(turn, joined) {
    if (this.ended || !turn || this.joinTurn !== turn) return;
    this.joinTurn = null; this.speech = 'awaiting-text'; this.transport(joined ? 'ready' : 'disconnected');
  }
  begin() {
    if (this.ended) return null;
    const turn = {};
    this.active = turn; this.speech = 'preparing'; this.emit(); return turn;
  }
  playback(turn, playing) {
    if (this.ended || !turn || this.active !== turn) return;
    this.speech = playing ? 'speaking' : 'preparing'; this.emit();
  }
  finish(turn, failed = false) {
    if (this.ended || !turn || this.active !== turn) return;
    this.active = null; this.speech = failed ? 'failed' : 'idle'; this.emit();
  }
  waiting(count) {
    this.queued = count;
    // New speech can queue while the cancelled predecessor is still unwinding.
    if (count > 0 && !this.active && !this.ended) this.speech = 'preparing';
    this.emit();
  }
  stop() {
    if (this.ended) return;
    this.active = null; this.speech = 'stopped'; this.emit();
  }
  end() {
    this.active = null; this.joinTurn = null; this.ended = true; this.emit();
  }
}

/** At most one presence update per 5 seconds; only the latest snapshot survives.
 * Discord permits 5 per 20 seconds. No chat posts, unbounded queue or activity touch.
 * A failed update is best effort and never retried automatically.
 */
export class StatusPresence {
  constructor({ publish, available, now = Date.now, schedule = setTimeout, cancel = clearTimeout, generic = false }) {
    this.generic = generic;
    this.publish = publish; this.available = available; this.now = now;
    this.schedule = schedule; this.cancel = cancel;
    this.next = null; this.last = null; this.lastAt = -Infinity; this.timer = null; this.closed = false;
  }
  update(status) {
    if (this.closed) return;
    // Do not expose authors, message text, channel IDs or error details in presence.
    this.next = this.generic ? { status: 'online', activities: [{ name: 'Custom Status', type: 4, state: status.phase === 'connecting' ? '起動中' : status.phase === 'preparing' ? '音声準備中' : status.phase === 'speaking' ? '読み上げ中' : '待機中' }] } : { status: ['speaking', 'idle'].includes(status.phase) ? 'online' : 'idle',
      activities: [{ name: 'Custom Status', type: 4, state: status.summary }] };
    this.flush();
  }
  flush() {
    if (this.closed || !this.next || !this.available()) return;
    if (JSON.stringify(this.next) === this.last) return;
    const delay = Math.max(0, this.lastAt + 5000 - this.now());
    if (delay) {
      if (!this.timer) this.timer = this.schedule(() => { this.timer = null; this.flush(); }, delay);
      this.timer?.unref?.(); return;
    }
    const next = this.next; this.last = JSON.stringify(next); this.lastAt = this.now();
    try { this.publish(next); } catch { /* Presence failure must never fail speech. */ }
  }
  close() {
    this.closed = true; this.next = null;
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
  }
}
