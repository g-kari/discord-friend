import test from 'node:test';
import assert from 'node:assert/strict';
import { speakerName, narrationText, messageNarration } from '../src/speech-text.js';

const scope = { guildId: 'guild', textChannelId: 'text', channelId: 'voice', ready: true };
const message = (changes = {}) => ({ guildId: 'guild', channelId: 'text', content: 'こんにちは',
  author: { bot: false, username: 'g_kari', globalName: '別の名前' },
  member: { displayName: 'g_kari', voice: { channelId: 'voice' } }, ...changes });

test('normal channel messages narrate actual display name and sanitized text', () => {
  assert.equal(messageNarration(message(), scope), 'g_kari：こんにちは');
  assert.equal(messageNarration(message({ content: 'こんにちは ||秘密|| ```code``` `var` <@123> https://example.invalid/x' }), scope),
    'g_kari：こんにちは     リンク');
  assert.equal(messageNarration(message({ content: 'HttpS://example.invalid/x' }), scope), 'g_kari：リンク');
  for (const content of ['||秘密||', '```code```', '<@123>', '']) {
    assert.equal(messageNarration(message({ content }), scope), null);
  }
});

test('normal narration preserves the existing guild/channel/VC and bot gates', () => {
  for (const changes of [{ guildId: 'other' }, { channelId: 'other' },
    { author: { bot: true } }, { member: null }, { member: { voice: { channelId: 'other' } } }]) {
    assert.equal(messageNarration(message(changes), scope), null);
  }
  assert.equal(messageNarration(message(), { ...scope, channelId: null }), null);
  assert.equal(messageNarration(message(), { ...scope, ready: false }), null);
});

test('say narration uses the same label without changing explicit text semantics', () => {
  assert.equal(narrationText('こんにちは', { member: { displayName: 'g_kari' } }), 'g_kari：こんにちは');
  assert.equal(narrationText('  x_y & 11.5万人  ', { user: { username: 'g_kari' } }), 'g_kari：x_y & 11.5万人');
});

test('speaker fallback handles missing or unsafe names without speaking raw IDs', () => {
  assert.equal(speakerName({ member: { displayName: 'ニックネーム' }, user: { globalName: '表示名', username: 'username' } }), 'ニックネーム');
  assert.equal(speakerName({ user: { globalName: '表示名', username: 'g_kari' } }), '表示名');
  assert.equal(speakerName({ user: { username: 'g_kari' } }), 'g_kari');
  assert.equal(speakerName({ member: { displayName: '||秘密||' }, user: { globalName: '```code```', username: 'g_kari' } }), 'g_kari');
  assert.equal(speakerName({ member: { displayName: 'https://example.invalid <@123>' } }), '話者');
  assert.equal(speakerName({ member: { displayName: 'HTTPS://x.invalid/me' }, user: { username: 'g_kari' } }), 'g_kari');
  assert.equal(speakerName({ member: { displayName: 'あ'.repeat(33) }, user: { username: 'g_kari' } }), 'g_kari');
  assert.equal(speakerName({ user: { id: '123456789012345678' } }), '話者');
  assert.equal(speakerName({ member: { displayName: ' g_kari\n\u202e test ' } }), 'g_kari test');
});

test('full narration stays within 500 code points and never silently truncates', () => {
  assert.equal(Array.from(narrationText('あ'.repeat(493), { user: { username: 'g_kari' } })).length, 500);
  assert.throws(() => narrationText('あ'.repeat(494), { user: { username: 'g_kari' } }), { code: 'INVALID_TEXT' });
  assert.equal(Array.from(narrationText('😀'.repeat(497), { member: { displayName: 'あ' } })).length, 499);
  assert.throws(() => narrationText('hello\0', { user: { username: 'g_kari' } }), { code: 'INVALID_TEXT' });
});
