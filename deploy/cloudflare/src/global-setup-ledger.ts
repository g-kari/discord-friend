import { GLOBAL_REGISTER_ACTION, GLOBAL_RECOVER_MODEL_ACTION, type GlobalSetupLedger, type GlobalSetupReceipt } from './global-command-setup.ts';

// No SDK tables/alarms, secrets, command IDs or raw Discord bodies are stored.
// There is deliberately no deletion/reset/original-receipt rewrite API.
export class SqlGlobalSetupLedger implements GlobalSetupLedger {
  private storage: Pick<DurableObjectStorage, 'sql' | 'sync'>;
  constructor(storage: Pick<DurableObjectStorage, 'sql' | 'sync'>) {
    this.storage = storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_global_setup_receipts (operation_id TEXT PRIMARY KEY, receipt TEXT NOT NULL)');
  }
  async read(operationId: string): Promise<GlobalSetupReceipt | null> {
    const row = this.storage.sql.exec<{ receipt: string }>('SELECT receipt FROM voice_global_setup_receipts WHERE operation_id = ?', operationId).toArray()[0];
    return row ? JSON.parse(row.receipt) as GlobalSetupReceipt : null;
  }
  async readNotBefore(): Promise<string | null> {
    const rows = this.storage.sql.exec<{ receipt: string }>("SELECT receipt FROM voice_global_setup_receipts WHERE json_extract(receipt, '$.notBefore') IS NOT NULL").toArray();
    return rows.reduce<string | null>((latest, row) => {
      const value = (JSON.parse(row.receipt) as GlobalSetupReceipt).notBefore!;
      return !latest || Date.parse(value) > Date.parse(latest) ? value : latest;
    }, null);
  }
  async claim(receipt: GlobalSetupReceipt): Promise<{ claimed: boolean; receipt: GlobalSetupReceipt }> {
    // Keep reads + INSERT synchronous; no event can interleave claim decisions.
    const same = this.storage.sql.exec<{ receipt: string }>('SELECT receipt FROM voice_global_setup_receipts WHERE operation_id = ?', receipt.operationId).toArray()[0];
    if (same) return { claimed: false, receipt: JSON.parse(same.receipt) as GlobalSetupReceipt };
    if (receipt.action === GLOBAL_RECOVER_MODEL_ACTION) {
      // All outcomes consume this one manual recovery. New UUIDs and restarts
      // cannot create another attempt, even after a pre-write failure.
      const prior = this.storage.sql.exec<{ receipt: string }>("SELECT receipt FROM voice_global_setup_receipts WHERE json_extract(receipt, '$.action') = ? AND json_extract(receipt, '$.recoveryOf') = ? LIMIT 1", GLOBAL_RECOVER_MODEL_ACTION, receipt.recoveryOf!).toArray()[0];
      if (prior) return { claimed: false, receipt: JSON.parse(prior.receipt) as GlobalSetupReceipt };
    }
    if (receipt.action === GLOBAL_REGISTER_ACTION) {
      const unresolved = this.storage.sql.exec<{ receipt: string }>("SELECT receipt FROM voice_global_setup_receipts WHERE json_extract(receipt, '$.action') = ? AND json_extract(receipt, '$.state') IN ('pending', 'uncertain') LIMIT 1", GLOBAL_REGISTER_ACTION).toArray()[0];
      if (unresolved) return { claimed: false, receipt: JSON.parse(unresolved.receipt) as GlobalSetupReceipt };
    }
    this.storage.sql.exec('INSERT INTO voice_global_setup_receipts (operation_id, receipt) VALUES (?, ?)', receipt.operationId, JSON.stringify(receipt));
    await this.storage.sync();
    return { claimed: true, receipt };
  }
  async save(receipt: GlobalSetupReceipt): Promise<void> {
    this.storage.sql.exec('UPDATE voice_global_setup_receipts SET receipt = ? WHERE operation_id = ?', JSON.stringify(receipt), receipt.operationId);
    await this.storage.sync();
  }
}
