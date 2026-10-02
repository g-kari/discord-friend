import { createServer } from 'node:http';
import { Readable } from 'node:stream';

// Private Container ingress only. The ordinary Worker never proxies arbitrary
// public requests to this server and never passes a Discord interaction token.
export function createCommandServer(handler) {
  return createServer(async (req, res) => {
    const controller = new AbortController();
    req.on('aborted', () => controller.abort());
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const request = new Request(`http://bot.internal${req.url}`, { method: req.method, headers: req.headers,
        ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body: Readable.toWeb(req), duplex: 'half' }), signal: controller.signal });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(400, { 'cache-control': 'no-store' }).end(); }
  });
}
