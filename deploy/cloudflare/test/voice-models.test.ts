import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { VoiceCatalogStore, OwnerVoiceSelection, validateCatalog } from '../src/voice-models.ts';
const catalog = [{ id: 999, name: '春日部つむぎ', style: 'ノーマル' }, { id: 8, name: 'ずんだもん', style: 'あまあま' }];
const signal = () => new AbortController().signal;
const id = (n: number) => String(100000000000000000n + BigInt(n));
function fixture() {
  const db = new DatabaseSync(':memory:'); let syncs = 0;
  const storage = { sql: { exec(query: string, ...args: any[]) {
    const stmt = db.prepare(query); const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return { toArray: () => rows };
  } }, sync: async () => { syncs++; } };
  return { db, storage, syncs: () => syncs };
}
test('catalog cache and owner selection persist across reconstruction without text or credentials', async () => {
  const f = fixture(); const store = new VoiceCatalogStore(f.storage); const owner = new OwnerVoiceSelection(f.storage, 'approved-scope');
  assert.equal(store.get(), null);
  assert.match(await owner.command(store.get(), { id: id(1) }, signal()), /停止中の音声エンジンは起動しません/);
  await store.save(catalog); await owner.command(store.get(), { id: id(2), speakerId: 8 }, signal());
  assert.equal(new OwnerVoiceSelection(f.storage, 'approved-scope').get(), 8);
  assert.equal(new OwnerVoiceSelection(f.storage, 'different-scope').get(), undefined);
  assert.deepEqual(new VoiceCatalogStore(f.storage).get(), catalog); assert.equal(f.syncs(), 2);
  assert.match(await owner.command(catalog, { id: id(3) }, signal()), /8: ずんだもん（あまあま） \[選択中\]/);
  f.db.close();
});
test('invalid, absent, stale and cancelled selections never mutate the chosen ID', async () => {
  const f = fixture(); const owner = new OwnerVoiceSelection(f.storage, 'approved-scope');
  await owner.command(catalog, { id: id(3), speakerId: 8 }, signal());
  for (const speakerId of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, 1234]) {
    assert.match(await owner.command(catalog, { id: id(4), speakerId }, signal()), /確認/); assert.equal(owner.get(), 8);
  }
  assert.match(await owner.command(catalog, { id: id(2), speakerId: 999 }, signal()), /古い/);
  assert.match(await owner.command(null, { id: id(5), speakerId: 999 }, signal()), /まだありません/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(owner.command(catalog, { id: id(5), speakerId: 999 }, controller.signal)); assert.equal(owner.get(), 8);
  f.db.close();
});
test('pages are bounded and malformed or unsafe catalog metadata fails closed', async () => {
  const f = fixture(); const owner = new OwnerVoiceSelection(f.storage, 'approved-scope');
  const many = Array.from({ length: 8 }, (_, id) => ({ id, name: '声', style: 'スタイル' }));
  assert.match(await owner.command(many, { id: id(1), page: 2 }, signal()), /6: 声/);
  for (const page of [0, -1, 3, 0.5]) assert.match(await owner.command(many, { id: id(2), page }, signal()), /ページ/);
  for (const value of [[], {}, [catalog[0], catalog[0]], [{ ...catalog[0], id: -1 }], [{ ...catalog[0], name: '@everyone' }], [{ ...catalog[0], style: 'x'.repeat(61) }]]) assert.throws(() => validateCatalog(value));
  const store = new VoiceCatalogStore(f.storage); await store.save(catalog);
  f.db.prepare('UPDATE voice_model_catalog SET catalog=?').run('{invalid'); assert.equal(store.get(), null);
  f.db.close();
});
test('explicit same-owner legacy fallback migrates selection and command ordering without deleting old data', async () => {
  const f = fixture(); const legacy = new OwnerVoiceSelection(f.storage, 'synthetic-legacy');
  await legacy.command(catalog, { id: id(5), speakerId: 8 }, signal());
  const migrated = new OwnerVoiceSelection(f.storage, 'synthetic-principal', 'synthetic-legacy');
  assert.equal(migrated.get(), 8); assert.equal(legacy.get(), 8);
  assert.match(await migrated.command(catalog, { id: id(4), speakerId: 999 }, signal()), /古い/);
  await migrated.command(catalog, { id: id(6), speakerId: 999 }, signal());
  assert.equal(migrated.get(), 999); assert.equal(legacy.get(), 8);
  assert.equal(new OwnerVoiceSelection(f.storage, 'synthetic-other-principal').get(), undefined);
  f.db.close();
});
