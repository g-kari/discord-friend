// Time admission is intentionally not a currency/billing cap. Charge the whole
// possible lifetime before startup; return unused time only after both owned
// resources have been reclaimed. The UTC day boundary never extends a session.
export const DAILY_LIMIT_MS = 60 * 60_000;
export const SESSION_LIMIT_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
type Sql = Pick<DurableObjectStorage, 'sql'>;
export type UsageReservation = {
  session_id: string;
  day: number;
  started_at: number;
  deadline: number;
  reserved_ms: number;
  state: 'reserved' | 'settled';
};
export class UsageLedger {
  private storage: Sql;
  constructor(storage: Sql) {
    this.storage = storage;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS voice_usage_days (
      day INTEGER PRIMARY KEY, charged_ms INTEGER NOT NULL CHECK(charged_ms >= 0))`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS voice_usage_reservation (
      id INTEGER PRIMARY KEY CHECK(id=1), session_id TEXT NOT NULL, day INTEGER NOT NULL,
      started_at INTEGER NOT NULL, deadline INTEGER NOT NULL, reserved_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('reserved', 'settled')))`);
  }
  reservation(): UsageReservation | null {
    return this.storage.sql.exec<UsageReservation>('SELECT session_id, day, started_at, deadline, reserved_ms, state FROM voice_usage_reservation WHERE id=1').toArray()[0] ?? null;
  }
  remaining(now: number): number {
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    const charged = this.storage.sql.exec<{ charged_ms: number }>('SELECT charged_ms FROM voice_usage_days WHERE day=?', day).toArray()[0]?.charged_ms ?? 0;
    return Math.max(0, DAILY_LIMIT_MS - charged);
  }
  // Called synchronously inside the interaction claim, with no await between
  // budget reads/writes and the session/job claim. DO storage.sync precedes I/O.
  reserve(sessionId: string, now: number, requestedDeadline: number, previousReadyId?: string):
    { deadline: number } | { reason: 'budget' | 'cleanup' } {
    const current = this.reservation();
    if (current?.state === 'reserved') {
      if (current.session_id !== previousReadyId || now < current.started_at || current.deadline <= now) return { reason: 'cleanup' };
      // Explicit rejoin changes process generation, never the prepaid lease.
      this.storage.sql.exec('UPDATE voice_usage_reservation SET session_id=? WHERE id=1', sessionId);
      return { deadline: current.deadline };
    }
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(requestedDeadline) ||
        (current && now < current.started_at)) return { reason: 'cleanup' };
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    const duration = Math.min(SESSION_LIMIT_MS, requestedDeadline - now, day + DAY_MS - now, this.remaining(now));
    if (duration <= 0) return { reason: 'budget' };
    // Write the debit first. Any partial failure can over-reserve, never start
    // without a debit. No destructive reset or rolling in-memory day counter.
    this.storage.sql.exec('INSERT INTO voice_usage_days(day, charged_ms) VALUES(?, ?) ON CONFLICT(day) DO UPDATE SET charged_ms=charged_ms+excluded.charged_ms', day, duration);
    this.storage.sql.exec(`INSERT INTO voice_usage_reservation(id, session_id, day, started_at, deadline, reserved_ms, state)
      VALUES(1, ?, ?, ?, ?, ?, 'reserved') ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id,
      day=excluded.day, started_at=excluded.started_at, deadline=excluded.deadline, reserved_ms=excluded.reserved_ms, state=excluded.state`,
    sessionId, day, now, now + duration, duration);
    return { deadline: now + duration };
  }
  covers(sessionId: string, deadline: number, now: number): boolean {
    const current = this.reservation();
    return current?.state === 'reserved' && current.session_id === sessionId && current.deadline === deadline &&
      current.started_at <= now && now < current.deadline;
  }
  // Caller must prove Bot destruction and TTS stop/revocation completed first.
  // Do not call on process exit, timeout, or a mere request to destroy.
  settle(sessionId: string, now: number): void {
    const current = this.reservation();
    if (!current || current.state !== 'reserved' || current.session_id !== sessionId) return;
    const used = now < current.started_at ? current.reserved_ms : Math.min(current.reserved_ms, now - current.started_at);
    const refund = current.reserved_ms - used;
    // Mark settled before refunding: interrupted settlement may overcharge, but
    // repeated cleanup or reconstruction can never refund the same lease twice.
    this.storage.sql.exec("UPDATE voice_usage_reservation SET state='settled' WHERE id=1");
    this.storage.sql.exec('UPDATE voice_usage_days SET charged_ms=MAX(0, charged_ms-?) WHERE day=?', refund, current.day);
  }
}
