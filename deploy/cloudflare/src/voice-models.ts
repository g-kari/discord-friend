// Durable metadata only. These stores never fetch, start a Container or load a model.
export interface VoiceModel { id: number; name: string; style: string }
type Storage = Pick<DurableObjectStorage, 'sql' | 'sync'>;
const label = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 &&
  Array.from(value).length <= 60 && !/[\u0000-\u001f\u007f@`<>]/u.test(value);
export function validateCatalog(value: unknown): VoiceModel[] {
  if (!Array.isArray(value) || !value.length || value.length > 512) throw new Error('INVALID_VOICE_CATALOG');
  const ids = new Set<number>();
  return value.map(voice => {
    if (!voice || typeof voice !== 'object' || !Number.isSafeInteger(voice.id) || voice.id < 0 || ids.has(voice.id) ||
        !label(voice.name) || !label(voice.style) || Object.keys(voice).some(key => !['id', 'name', 'style'].includes(key))) throw new Error('INVALID_VOICE_CATALOG');
    ids.add(voice.id);
    return { id: voice.id, name: voice.name.trim(), style: voice.style.trim() };
  });
}
export class VoiceCatalogStore {
  private storage: Storage;
  constructor(storage: Storage) {
    this.storage = storage;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_model_catalog (id INTEGER PRIMARY KEY CHECK(id=1), catalog TEXT NOT NULL)');
  }
  get(): VoiceModel[] | null {
    const row = this.storage.sql.exec<{ catalog: string }>('SELECT catalog FROM voice_model_catalog WHERE id=1').toArray()[0];
    if (!row) return null;
    try { return validateCatalog(JSON.parse(row.catalog)); } catch { return null; }
  }
  async save(value: unknown): Promise<void> {
    const catalog = validateCatalog(value);
    this.storage.sql.exec('INSERT INTO voice_model_catalog(id, catalog) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET catalog=excluded.catalog', JSON.stringify(catalog));
    await this.storage.sync();
  }
}
export class OwnerVoiceSelection {
  private storage: Storage;
  private scope: string;
  constructor(storage: Storage, scope: string) {
    this.storage = storage; this.scope = scope;
    storage.sql.exec('CREATE TABLE IF NOT EXISTS voice_owner_model (scope TEXT PRIMARY KEY, speaker_id INTEGER NOT NULL, command_id TEXT NOT NULL)');
  }
  get(): number | undefined {
    const id = this.storage.sql.exec<{ speaker_id: number }>('SELECT speaker_id FROM voice_owner_model WHERE scope=?', this.scope).toArray()[0]?.speaker_id;
    return Number.isSafeInteger(id) && id! >= 0 ? id : undefined;
  }
  async command(catalog: VoiceModel[] | null, command: { id: string; speakerId?: number; page?: number }, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!catalog) return '声の一覧はまだありません。通常の読み上げが一度成功した後に /model を再実行してください（停止中の音声エンジンは起動しません）';
    catalog = validateCatalog(catalog);
    if (command.speakerId !== undefined) {
      if (!Number.isSafeInteger(command.speakerId) || command.speakerId < 0 || command.page !== undefined) return '声のIDを確認してください';
      const voice = catalog.find(voice => voice.id === command.speakerId);
      if (!voice) return 'その声のIDは一覧にありません。/model で確認してください';
      const previous = this.storage.sql.exec<{ command_id: string }>('SELECT command_id FROM voice_owner_model WHERE scope=?', this.scope).toArray()[0]?.command_id;
      if (!/^\d{17,20}$/.test(command.id) || (previous && BigInt(command.id) <= BigInt(previous))) return '古い声の変更操作を中止しました';
      signal.throwIfAborted();
      this.storage.sql.exec('INSERT INTO voice_owner_model(scope, speaker_id, command_id) VALUES(?, ?, ?) ON CONFLICT(scope) DO UPDATE SET speaker_id=excluded.speaker_id, command_id=excluded.command_id', this.scope, voice.id, command.id);
      await this.storage.sync();
      return `あなたの読み上げの声を VOICEVOX:${voice.name}（${voice.style}）に変更しました。他の人の声は既定のままです`;
    }
    const page = command.page ?? 1; const pages = Math.ceil(catalog.length / 5);
    if (!Number.isInteger(page) || page < 1 || page > pages) return `ページは1〜${pages}で指定してください`;
    const selected = this.get();
    const lines = catalog.slice((page - 1) * 5, page * 5).map(voice =>
      `${voice.id}: ${voice.name}（${voice.style}）${voice.id === selected ? ' [選択中]' : selected === undefined && voice.name === '春日部つむぎ' && voice.style === 'ノーマル' ? ' [既定]' : ''}`);
    const voice = catalog.find(voice => voice.id === selected);
    const current = selected === undefined ? 'VOICEVOX:春日部つむぎ（既定）' : voice ? `VOICEVOX:${voice.name}（${voice.style}）` : `ID ${selected}（保存済み一覧にありません。読み上げ前に利用可否を確認します）`;
    return [`現在のあなたの声: ${current}`, `VOICEVOXの声 ${page}/${pages}（保存済み一覧）`, ...lines, '/model id:番号 であなたの声を変更', ...(pages > 1 ? ['/model page:番号 で次の一覧'] : [])].join('\n');
  }
}
