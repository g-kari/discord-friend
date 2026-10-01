import { boundedBytes, VoiceError, CREDIT } from './policy.js';

// This handler is private: the Worker exposes it only over an approved service binding.
// Never proxy arbitrary paths to the engine (including its dictionary/model mutation API).
export function createVoiceHandler(synthesize) {
  return async request => {
    const url = new URL(request.url);
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    if (request.method === 'GET' && url.pathname === '/health') return Response.json({ status: 'up', credit: CREDIT }, { headers });
    if (url.pathname !== '/v1/speech') return new Response(null, { status: 404, headers });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
      return Response.json({ error: 'JSON_REQUIRED' }, { status: 415, headers });
    }
    try {
      let input;
      try {
        input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(request, 8192)));
      } catch (error) {
        throw new VoiceError(error?.code === 'UPSTREAM_TOO_LARGE' ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON', error?.code === 'UPSTREAM_TOO_LARGE' ? 413 : 400);
      }
      const result = await synthesize(input, request.signal);
      return new Response(result.audio, { headers: {
        ...headers, 'content-type': result.contentType,
        // HTTP headers are byte strings: return the Unicode attribution in metadata instead.
        'x-voice-credit': encodeURIComponent(result.credit),
      } });
    } catch (error) {
      const known = error instanceof VoiceError;
      return Response.json({ error: known ? error.code : 'SYNTHESIS_FAILED' }, {
        status: known ? error.status : 502,
        headers: { ...headers, ...(error?.status === 429 ? { 'retry-after': '2' } : {}) },
      });
    }
  };
}
