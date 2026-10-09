export async function privateJson(response: Response, limit = 8192, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error('PRIVATE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('PRIVATE_RESPONSE_INVALID'); }
      chunks.push(chunk.value);
    }
    signal?.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PRIVATE_RESPONSE_INVALID');
    return value as Record<string, unknown>;
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
}
