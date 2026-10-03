export class VoiceError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const CREDIT = 'VOICEVOX:春日部つむぎ';

// A bounded synthesis unit, not the total article length. Clients enqueue chunks.
export function validateSpeech(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new VoiceError('INVALID_REQUEST');
  if (Object.keys(input).some(key => !['text', 'speed'].includes(key))) throw new VoiceError('UNKNOWN_FIELD');
  if (typeof input.text !== 'string') throw new VoiceError('INVALID_TEXT');
  const text = input.text.trim();
  if (!text || Array.from(text).length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new VoiceError('INVALID_TEXT');
  }
  const speed = input.speed ?? 1;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.7 || speed > 1.5) {
    throw new VoiceError('INVALID_SPEED');
  }
  return { text, speed };
}

export async function boundedBytes(response, limit) {
  if (!response.body) throw new VoiceError('EMPTY_UPSTREAM', 502);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel();
    throw new VoiceError('UPSTREAM_TOO_LARGE', 502);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new VoiceError('UPSTREAM_TOO_LARGE', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function wavPcm(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 44) throw new VoiceError('INVALID_AUDIO', 502);
  const decode = (start, end) => new TextDecoder().decode(bytes.subarray(start, end));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (decode(0, 4) !== 'RIFF' || decode(8, 12) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) {
    throw new VoiceError('INVALID_AUDIO', 502);
  }
  let fmt = false;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length;
    if (end > bytes.length) throw new VoiceError('INVALID_AUDIO', 502);
    const id = decode(offset, offset + 4);
    if (id === 'fmt ') {
      if (fmt || length < 16 || view.getUint16(offset + 8, true) !== 1 ||
          view.getUint16(offset + 10, true) !== 2 || view.getUint32(offset + 12, true) !== 48000 ||
          view.getUint16(offset + 22, true) !== 16 || view.getUint16(offset + 20, true) !== 4 ||
          view.getUint32(offset + 16, true) !== 192000) throw new VoiceError('INVALID_AUDIO', 502);
      fmt = true;
    }
    if (id === 'data') {
      if (data || length === 0 || length % 4 !== 0) throw new VoiceError('INVALID_AUDIO', 502);
      data = bytes.subarray(offset + 8, end);
    }
    offset = end + (length % 2);
  }
  if (!fmt || !data || offset !== bytes.length) throw new VoiceError('INVALID_AUDIO', 502);
  return data;
}

export function assertWav(bytes) { wavPcm(bytes); }
