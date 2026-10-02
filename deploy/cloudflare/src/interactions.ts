import { scopeFingerprint, APPROVED_SCOPE_FINGERPRINT } from './guild-setup.ts';

export const COMMAND_NAMES = ['join', 'leave', 'stop', 'voice-status', 'say'] as const;
export type CommandName = typeof COMMAND_NAMES[number];
export interface InteractionCommand {
  id: string;
  applicationId: string;
  guildId: string;
  channelId: string;
  userId: string;
  name: CommandName;
  text?: string;
  token: string;
  receivedAt: number;
  bodyHash: string;
}
export interface InteractionEnv {
  DISCORD_HTTP_ENABLED: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_TEXT_CHANNEL_ID: string;
  DISCORD_OWNER_ID: string;
}
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^\d{17,20}$/.test(v);
const hex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], part => Number.parseInt(part, 16));
const headers = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
const reply = (content: string): Response => Response.json({ type: 4, data: { content, flags: 64, allowed_mentions: { parse: [] } } }, { headers });

// No startup or Durable Object I/O occurs before the inline acknowledgement.
// Discord's three-second deadline includes signature and body processing.
export async function receiveInteraction(request: Request, env: InteractionEnv,
  enqueue: (command: InteractionCommand) => Promise<void>, waitUntil: (work: Promise<void>) => void,
  active: () => boolean, now: () => number = Date.now,
  approvedFingerprint: string = APPROVED_SCOPE_FINGERPRINT): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== '/interactions' || url.search) return new Response(null, { status: 404, headers });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, allow: 'POST' } });
  if (env.DISCORD_HTTP_ENABLED !== 'true' || !/^[a-f0-9]{64}$/i.test(env.DISCORD_PUBLIC_KEY)) return new Response(null, { status: 503, headers });
  const signature = request.headers.get('x-signature-ed25519') ?? '';
  const timestamp = request.headers.get('x-signature-timestamp') ?? '';
  // Freshness is an application policy. Durable ID claims add independent deduplication.
  if (!/^[a-f0-9]{128}$/i.test(signature) || !/^\d{10}$/.test(timestamp) ||
      now() - Number(timestamp) * 1000 > 60_000 || Number(timestamp) * 1000 - now() > 10_000) {
    return new Response(null, { status: 401, headers });
  }
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return new Response(null, { status: 415, headers });
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 16_384)) return new Response(null, { status: 413, headers });
  if (!request.body) return new Response(null, { status: 400, headers });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const timeout = AbortSignal.timeout(1000);
  const cancel = () => { void reader.cancel().catch(() => {}); };
  timeout.addEventListener('abort', cancel, { once: true });
  let raw: Uint8Array;
  try {
    for (;;) {
      timeout.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16_384) { await reader.cancel(); return new Response(null, { status: 413, headers }); }
      chunks.push(chunk.value);
    }
    timeout.throwIfAborted();
    raw = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
  } catch { return new Response(null, { status: 400, headers }); }
  finally { timeout.removeEventListener('abort', cancel); reader.releaseLock(); }
  try {
    const prefix = new TextEncoder().encode(timestamp);
    const signed = new Uint8Array(prefix.byteLength + raw.byteLength);
    signed.set(prefix); signed.set(raw, prefix.byteLength);
    const key = await crypto.subtle.importKey('raw', hex(env.DISCORD_PUBLIC_KEY), { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify('Ed25519', key, hex(signature), signed)) return new Response(null, { status: 401, headers });
  } catch { return new Response(null, { status: 401, headers }); }
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)); }
  catch { return new Response(null, { status: 400, headers }); }
  if (!object(payload)) return new Response(null, { status: 400, headers });
  if (payload.type === 1) return Response.json({ type: 1 }, { headers }); // Signed PING never accesses a Container.
  if (payload.type !== 2 || payload.application_id !== env.DISCORD_APPLICATION_ID || !id(payload.id) ||
      !object(payload.data) || payload.data.type !== 1 || !COMMAND_NAMES.includes(payload.data.name as CommandName)) return reply('対応していない操作です');
  const channelId = object(payload.channel) ? payload.channel.id : payload.channel_id;
  if (payload.channel_id !== undefined && payload.channel_id !== channelId) return reply('操作先を確認できません');
  const member = payload.member;
  if (scopeFingerprint(env) !== approvedFingerprint || payload.guild_id !== env.DISCORD_GUILD_ID || channelId !== env.DISCORD_TEXT_CHANNEL_ID ||
      !object(member) || !object(member.user) || member.user.id !== env.DISCORD_OWNER_ID || payload.user !== undefined ||
      (payload.context !== undefined && payload.context !== 0)) return reply('この操作は指定チャンネルの管理者のみ利用できます');
  let text: string | undefined;
  const options = payload.data.options ?? [];
  if (payload.data.name === 'say') {
    if (!Array.isArray(options) || options.length !== 1 || !object(options[0]) || options[0].name !== 'text' || options[0].type !== 3 || typeof options[0].value !== 'string') return reply('読み上げる文章を指定してください');
    text = options[0].value.trim();
    if (!text || Array.from(text).length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return reply('文章は500文字以内で指定してください');
  } else if (!Array.isArray(options) || options.length !== 0) return reply('引数を確認してください');
  if (typeof payload.token !== 'string' || !/^[A-Za-z0-9._-]{16,512}$/.test(payload.token)) return reply('応答情報を確認できません');
  if (!active()) return reply('現在は停止中です');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), b => b.toString(16).padStart(2, '0')).join('');
  const command: InteractionCommand = {
    id: payload.id, applicationId: env.DISCORD_APPLICATION_ID, guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_TEXT_CHANNEL_ID, userId: env.DISCORD_OWNER_ID,
    name: payload.data.name as CommandName, ...(text === undefined ? {} : { text }), token: payload.token, receivedAt: now(), bodyHash: hash,
  };
  // Background work may fail, but it never logs a request/body/token or retries execution.
  waitUntil(enqueue(command).catch(() => {}));
  return Response.json({ type: 5, data: { flags: 64 } }, { headers });
}

export async function completeInteraction(applicationId: string, token: string, content: string,
  request: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await request(`https://discord.com/api/v10/webhooks/${applicationId}/${token}/messages/@original`, {
      method: 'PATCH', redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    await response.body?.cancel();
    return response.ok; // No command retry, redirect, raw exception, or response-body log.
  } catch { return false; }
}
