import type { InteractionCommand } from './interactions';
import { Buffer } from 'node:buffer';

export interface VoiceSession {
  id: string;
  status: 'starting' | 'ready' | 'stopped';
  controlId: string;
  deadline: number;
  createdAt: number;
}
export interface StoredJob {
  id: string;
  sessionId: string | null;
  expiresAt: number;
  cipher: string;
}
type SqlStorage = Pick<DurableObjectStorage, 'sql' | 'sync'>;

// Only ciphertext temporarily contains the reply token and /say text. Neither
// the Container nor the SDK schedule payload receives an interaction token.
async function key(secret: string): Promise<CryptoKey> {
  const bytes = new TextEncoder().encode(`discord-friend/interaction-job/v1:${secret}`);
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', bytes), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealCommand(command: InteractionCommand, secret: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(command.id) },
    await key(secret), new TextEncoder().encode(JSON.stringify(command)));
  return `${Buffer.from(nonce).toString('base64')}.${Buffer.from(ciphertext).toString('base64')}`;
}
export async function openCommand(cipher: string, id: string, secret: string,
  expiresAt: number = Number.POSITIVE_INFINITY, now: () => number = Date.now): Promise<InteractionCommand> {
  if (now() >= expiresAt) throw new Error('JOB_EXPIRED');
  const [nonce, ciphertext, extra] = cipher.split('.');
  if (!nonce || !ciphertext || extra !== undefined) throw new Error('INVALID_JOB');
  const decryptionKey = await key(secret);
  if (now() >= expiresAt) throw new Error('JOB_EXPIRED');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(nonce, 'base64'), additionalData: new TextEncoder().encode(id) },
    decryptionKey, Buffer.from(ciphertext, 'base64'));
  if (now() >= expiresAt) { new Uint8Array(plaintext).fill(0); throw new Error('JOB_EXPIRED'); }
  const command = JSON.parse(new TextDecoder().decode(plaintext)) as InteractionCommand;
  if (command.id !== id) throw new Error('INVALID_JOB');
  return command;
}

export class InteractionLedger {
  private storage: SqlStorage;
  constructor(storage: SqlStorage) {
    this.storage = storage;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS voice_interaction_jobs (
      id TEXT PRIMARY KEY, body_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      payload_expires INTEGER NOT NULL, dedup_expires INTEGER NOT NULL,
      state TEXT NOT NULL, cipher TEXT, session_id TEXT, result TEXT)`);
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_command_session (id INTEGER PRIMARY KEY CHECK(id = 1), session TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_command_control (id INTEGER PRIMARY KEY CHECK(id = 1), control_id TEXT NOT NULL)');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_command_limit (id INTEGER PRIMARY KEY CHECK(id = 1), window_ms INTEGER NOT NULL, count INTEGER NOT NULL, last_join INTEGER NOT NULL)');
  }
  sync(): Promise<void> { return this.storage.sync(); }
  session(): VoiceSession | null {
    const row = this.storage.sql.exec<{ session: string }>('SELECT session FROM voice_command_session WHERE id = 1').toArray()[0];
    return row ? JSON.parse(row.session) as VoiceSession : null;
  }
  setSession(session: VoiceSession): void {
    this.storage.sql.exec('INSERT INTO voice_command_session(id, session) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET session = excluded.session', JSON.stringify(session));
  }
  private controlId(): string | null {
    const stored = this.storage.sql.exec<{ control_id: string }>('SELECT control_id FROM voice_command_control WHERE id = 1').toArray()[0]?.control_id;
    const session = this.session()?.controlId;
    return !stored ? session ?? null : session && BigInt(session) > BigInt(stored) ? session : stored;
  }
  private setControlId(id: string): void {
    this.storage.sql.exec('INSERT INTO voice_command_control(id, control_id) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET control_id = excluded.control_id', id);
  }
  claimControl(command: InteractionCommand, now: number): { accepted: boolean; session: VoiceSession | null } {
    this.sweep(now);
    const same = this.storage.sql.exec<{ id: string }>('SELECT id FROM voice_interaction_jobs WHERE id = ?', command.id).toArray()[0];
    let session = this.session();
    const controlId = this.controlId();
    if (same || (controlId && BigInt(command.id) <= BigInt(controlId))) return { accepted: false, session };
    // Persist priority cancellation even before the first session exists or
    // when bounded dedup metadata is full. Delayed older joins remain cancelled.
    this.setControlId(command.id);
    if (session) {
      session = { ...session, controlId: command.id,
        status: command.name === 'leave' || session.status === 'starting' ? 'stopped' : session.status };
      this.setSession(session); // Synchronous priority cancellation before encryption or other I/O.
    }
    // Cancellation remains available even at queue/rate capacity. The monotonic
    // session control ID protects replay if the bounded metadata table is full.
    this.storage.sql.exec("DELETE FROM voice_interaction_jobs WHERE id IN (SELECT id FROM voice_interaction_jobs WHERE created_at < ? AND state NOT IN ('accepted', 'executing') ORDER BY created_at LIMIT 1) AND (SELECT COUNT(*) FROM voice_interaction_jobs) >= 256", now - 60_000);
    if (this.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM voice_interaction_jobs').one().count < 256) {
      this.storage.sql.exec('INSERT INTO voice_interaction_jobs(id, body_hash, created_at, payload_expires, dedup_expires, state, cipher, session_id, result) VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?)',
        command.id, command.bodyHash, now, now, now + 15 * 60_000, 'cancelled', session?.id ?? null, 'cancelled');
    }
    return { accepted: true, session };
  }
  // All related reads/writes are synchronous, before the first await. Replays
  // return the original claim and never create another schedule or speech job.
  accept(command: InteractionCommand, cipher: string, now: number, deadline: number):
    { accepted: boolean; reason: 'duplicate' | 'conflict' | 'rate' | 'busy' | 'expired' | 'cancelled' | null; session: VoiceSession | null } {
    this.sweep(now);
    const same = this.storage.sql.exec<{ body_hash: string }>('SELECT body_hash FROM voice_interaction_jobs WHERE id = ?', command.id).toArray()[0];
    if (same) return { accepted: false, reason: same.body_hash === command.bodyHash ? 'duplicate' : 'conflict', session: this.session() };
    const controlId = this.controlId();
    const ordered = !controlId || BigInt(command.id) > BigInt(controlId);
    if (command.name === 'join' && !ordered) return { accepted: false, reason: 'cancelled', session: this.session() };
    if (now - command.receivedAt > 60_000 || command.receivedAt > now + 10_000 || deadline <= now) return { accepted: false, reason: 'expired', session: this.session() };
    const window = Math.floor(now / 60_000) * 60_000;
    const previous = this.storage.sql.exec<{ window_ms: number; count: number; last_join: number }>('SELECT window_ms, count, last_join FROM voice_command_limit WHERE id = 1').toArray()[0];
    const count = previous?.window_ms === window ? previous.count : 0;
    const pending = this.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM voice_interaction_jobs WHERE state = 'accepted'").one().count;
    if (count >= 10 || (command.name === 'join' && previous && now - previous.last_join < 30_000)) return { accepted: false, reason: 'rate', session: this.session() };
    if (pending >= 8 || this.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM voice_interaction_jobs').one().count >= 256) return { accepted: false, reason: 'busy', session: this.session() };
    let session = this.session();
    if (command.name === 'join' && ordered) {
      if (session?.status === 'starting' && session.deadline > now) return { accepted: false, reason: 'busy', session };
      // Every explicit join owns a new process generation. A rejoin within an
      // active session keeps its original absolute cap instead of extending it.
      const cappedDeadline = session?.status === 'ready' ? Math.min(deadline, session.deadline) : deadline;
      session = { id: crypto.randomUUID(), status: 'starting', controlId: command.id, deadline: cappedDeadline, createdAt: now };
      this.setSession(session);
      this.setControlId(command.id);
    } else if ((command.name === 'leave' || (command.name === 'stop' && session?.status === 'starting')) && session && ordered) {
      session = { ...session, status: 'stopped', controlId: command.id };
      this.setSession(session);
    }
    this.storage.sql.exec('INSERT INTO voice_interaction_jobs(id, body_hash, created_at, payload_expires, dedup_expires, state, cipher, session_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
      command.id, command.bodyHash, now, now + 90_000, now + 15 * 60_000, 'accepted', cipher, session?.id ?? null);
    this.storage.sql.exec('INSERT INTO voice_command_limit(id, window_ms, count, last_join) VALUES(1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET window_ms = excluded.window_ms, count = excluded.count, last_join = excluded.last_join',
      window, count + 1, command.name === 'join' ? now : previous?.last_join ?? 0);
    return { accepted: true, reason: null, session };
  }
  take(id: string, now: number): StoredJob | null {
    this.sweep(now);
    const job = this.storage.sql.exec<{ id: string; session_id: string | null; payload_expires: number; cipher: string | null; state: string }>(
      'SELECT id, session_id, payload_expires, cipher, state FROM voice_interaction_jobs WHERE id = ?', id).toArray()[0];
    if (!job || job.state !== 'accepted' || !job.cipher || job.payload_expires <= now) return null;
    // Drop the persisted encrypted payload before I/O. A restarted executing job
    // cannot recover its token or execute again; the owner must issue a new command.
    this.storage.sql.exec("UPDATE voice_interaction_jobs SET state = 'executing', cipher = NULL WHERE id = ? AND state = 'accepted'", id);
    return { id: job.id, sessionId: job.session_id, expiresAt: job.payload_expires, cipher: job.cipher };
  }
  finish(id: string, result: 'complete' | 'failed' | 'cancelled' | 'uncertain' | 'reply-failed'): void {
    this.storage.sql.exec('UPDATE voice_interaction_jobs SET state = ?, result = ?, cipher = NULL WHERE id = ?', result, result, id);
  }
  sweep(now: number): void {
    this.storage.sql.exec("UPDATE voice_interaction_jobs SET state = 'expired', cipher = NULL WHERE payload_expires <= ? AND state = 'accepted'", now);
    this.storage.sql.exec("UPDATE voice_interaction_jobs SET state = 'uncertain', cipher = NULL WHERE payload_expires <= ? AND state = 'executing'", now);
    this.storage.sql.exec('DELETE FROM voice_interaction_jobs WHERE dedup_expires <= ?', now);
  }
}
