import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createAudioResource, StreamType } from '@discordjs/voice';
import { wavPcm } from '../src/policy.js';
import { discordPcmFromWav, DISCORD_FRAME_BYTES } from '../src/audio.js';

const require = createRequire(import.meta.url);
// Exercise the exact codec resolved by the locked Discord dependency.
const voiceRequire = createRequire(require.resolve('@discordjs/voice'));
const prism = voiceRequire('prism-media');

function chunk(id, data) {
  const header = Buffer.alloc(8);
  header.write(id); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}
function format() {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt16LE(1); bytes.writeUInt16LE(2, 2);
  bytes.writeUInt32LE(48000, 4); bytes.writeUInt32LE(192000, 8);
  bytes.writeUInt16LE(4, 12); bytes.writeUInt16LE(16, 14);
  return bytes;
}
function riff(chunks) {
  const header = Buffer.alloc(12); header.write('RIFF'); header.write('WAVE', 8);
  const bytes = Buffer.concat([header, ...chunks]); bytes.writeUInt32LE(bytes.length - 8, 4);
  return bytes;
}
function wav(pcm, extras = []) { return riff([chunk('fmt ', format()), ...extras, chunk('data', pcm)]); }
function sine(frames) {
  const bytes = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const sample = Math.round(10000 * Math.sin(2 * Math.PI * 1000 * i / 48000));
    bytes.writeInt16LE(sample, i * 4); bytes.writeInt16LE(sample, i * 4 + 2);
  }
  return bytes;
}
async function roundtrip(pcm) {
  const resource = createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw });
  assert.deepEqual(resource.edges.map(edge => edge.type), ['opus encoder']);
  assert.equal(resource.volume, undefined); // No gain/mixer/resampler in this path.
  const packets = [];
  for await (const packet of resource.playStream) packets.push(packet);
  const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  Readable.from(packets).pipe(decoder);
  const decoded = [];
  for await (const bytes of decoder) decoded.push(bytes);
  return { packets: packets.length, audio: Buffer.concat(decoded) };
}

test('WAV parsing removes headers and padded metadata, including byte-offset views', () => {
  const pcm = sine(960);
  const audio = wav(pcm, [chunk('JUNK', Buffer.from([123])), chunk('LIST', Buffer.from('metadata'))]);
  const backing = Buffer.concat([Buffer.from('prefix'), audio, Buffer.from('suffix')]);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 6, audio.length);
  assert.deepEqual(Buffer.from(wavPcm(view)), pcm);
  assert.deepEqual(discordPcmFromWav(view), pcm);
});

test('final incomplete PCM frame is preserved and zero-padded without changing sample levels/channels', () => {
  for (const frames of [1, 959, 960, 961, 48000, 48001]) {
    const pcm = sine(frames);
    pcm.writeInt16LE(-32768, 0); pcm.writeInt16LE(32767, 2);
    const output = discordPcmFromWav(wav(pcm));
    assert.equal(output.length, Math.ceil(frames / 960) * DISCORD_FRAME_BYTES);
    assert.deepEqual(output.subarray(0, pcm.length), pcm);
    assert(output.subarray(pcm.length).every(byte => byte === 0));
    assert.equal(output.readInt16LE(0), -32768);
    assert.equal(output.readInt16LE(2), 32767);
  }
});

test('the narrow playback contract rejects ambiguous duplicate and malformed PCM chunks', () => {
  const fmt = chunk('fmt ', format()); const data = chunk('data', sine(960));
  for (const chunks of [[fmt, fmt, data], [fmt, data, data],
    [fmt, chunk('data', Buffer.alloc(3841)), chunk('data', Buffer.alloc(4))],
    [fmt, chunk('data', Buffer.alloc(0))]]) {
    assert.throws(() => discordPcmFromWav(riff(chunks)), { code: 'INVALID_AUDIO' });
  }
  // Mono, another rate, float PCM, bit depth, byte rate and alignment must not
  // be passed to the raw encoder as if they were stereo PCM16 at 48 kHz.
  for (const offset of [0, 2, 4, 8, 12, 14]) {
    const broken = format(); broken[offset] ^= 1;
    assert.throws(() => discordPcmFromWav(riff([chunk('fmt ', broken), data])), { code: 'INVALID_AUDIO' });
  }
});

test('the actual locked PCM-to-Opus path keeps silence silent and encodes the final frame', async () => {
  const silence = await roundtrip(discordPcmFromWav(wav(Buffer.alloc(48000 * 4))));
  assert.equal(silence.packets, 50); assert.equal(silence.audio.length, 192000);
  assert(silence.audio.every(byte => byte === 0));
  for (const frames of [1, 959, 960, 961, 48001]) {
    const result = await roundtrip(discordPcmFromWav(wav(sine(frames))));
    assert.equal(result.packets, Math.ceil(frames / 960));
    assert.equal(result.audio.length, Math.ceil(frames / 960) * DISCORD_FRAME_BYTES);
  }
});

test('lossy Opus sine roundtrip has no clipping, unintended gain or channel mismatch', async () => {
  const result = await roundtrip(discordPcmFromWav(wav(sine(48000))));
  let peak = 0; let squares = 0;
  for (let i = 0; i < result.audio.length; i += 4) {
    const left = result.audio.readInt16LE(i); const right = result.audio.readInt16LE(i + 2);
    assert.equal(left, right);
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    squares += left * left + right * right;
  }
  const rms = Math.sqrt(squares / (result.audio.length / 2));
  assert(peak > 8000 && peak < 15000);
  assert(rms > 6600 && rms < 7500);
});
