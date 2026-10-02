import type { SetupLedger, SetupReceipt } from './guild-setup';

// Separate tables keep the Container SDK's state, SQL schedules and alarms intact.
// These tables contain only safe operation/status metadata and can be inspected
// with SELECT through Cloudflare's authenticated Durable Object SQL API.
export class SqlSetupLedger implements SetupLedger {
  private storage: Pick<DurableObjectStorage, 'sql' | 'sync'>;
  constructor(storage: Pick<DurableObjectStorage, 'sql' | 'sync'>) {
    this.storage = storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_setup_receipts (operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
  }
  async claim(receipt: SetupReceipt): Promise<{ claimed: boolean; receipt: SetupReceipt }> {
    const same = this.storage.sql.exec<{ receipt: string }>('SELECT receipt FROM voice_setup_receipts WHERE operation_id = ?', receipt.operationId).toArray()[0];
    if (same) return { claimed: false, receipt: JSON.parse(same.receipt) as SetupReceipt };
    // Do not start a new operation while an earlier remote write is unresolved.
    const unresolved = this.storage.sql.exec<{ receipt: string }>("SELECT receipt FROM voice_setup_receipts WHERE json_extract(receipt, '$.state') IN ('pending', 'uncertain') LIMIT 1").toArray()[0];
    if (unresolved) return { claimed: false, receipt: JSON.parse(unresolved.receipt) as SetupReceipt };
    // SQL is synchronous; no await can interleave the claim's reads and insertion.
    this.storage.sql.exec('INSERT INTO voice_setup_receipts (operation_id, receipt) VALUES (?, ?)', receipt.operationId, JSON.stringify(receipt));
    await this.storage.sync();
    return { claimed: true, receipt };
  }
  async save(receipt: SetupReceipt): Promise<void> {
    this.storage.sql.exec('UPDATE voice_setup_receipts SET receipt = ? WHERE operation_id = ?', JSON.stringify(receipt), receipt.operationId);
    await this.storage.sync();
  }
}

export function saveReadiness(storage: Pick<DurableObjectStorage, 'sql'>, snapshot: unknown): void {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_readiness_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), snapshot TEXT NOT NULL)');
  storage.sql.exec('INSERT INTO voice_readiness_snapshot (id, snapshot) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot', JSON.stringify(snapshot));
}
