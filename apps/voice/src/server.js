import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createVoiceHandler } from './http.js';
import { createSynthesizer } from './voicevox.js';
import { applyLifetime } from './lifetime.js';

// A socket timeout does not stop VOICEVOX CPU work. Exit and let PID1 hard-kill both children.
const handler = createVoiceHandler(createSynthesizer({ onRecycle: () => process.exit(1) }));
const server = createServer(async (req, res) => {
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  try {
    const request = new Request(`http://voice.internal${req.url}`, {
      method: req.method, headers: req.headers,
      ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      signal: controller.signal,
    });
    const result = await handler(request);
    res.writeHead(result.status, Object.fromEntries(result.headers));
    res.end(Buffer.from(await result.arrayBuffer()));
  } catch {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end('{"error":"REQUEST_FAILED"}');
  }
});
server.requestTimeout = 35000;
server.headersTimeout = 10000;
server.maxHeadersCount = 32;
// Inside the Container only. Cloudflare binding is the trust boundary; no public route is configured.
server.listen(8080, '0.0.0.0');
process.once('SIGTERM', () => { server.close(); server.closeIdleConnections(); });
applyLifetime(() => { server.close(); server.closeAllConnections(); });
