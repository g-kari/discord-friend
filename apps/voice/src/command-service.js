import { remainingLifetime } from './lifetime.js';
import { boundedBytes, validateSpeech } from './policy.js';

// /model is a DO-only metadata operation and is never forwarded to this process.
const commands = ['join', 'leave', 'stop', 'voice-status', 'say'];
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/u.test(value);
const DEDUP_MS = 15 * 60_000;
const DEDUP_CAPACITY = 256; // Covers the Worker's 10/minute admission across its 15-minute replay window.
const headers = { 'cache-control': 'no-store', 'content-type': 'application/json' };

/** Private token-free command ingress. HTTP interactions are acknowledged by the Worker. */
export function createCommandService({ scope, sessionId, deadline, idleSeconds = 300, usageMode = 'trial', startedAt,
  ready, voiceStatus, queued, speechPhase = () => 'disconnected', dispatch, cancelJoin, shutdown, now = Date.now }) {
  if (!uuid(sessionId) || !Number.isSafeInteger(deadline) ||
      !Number.isInteger(idleSeconds) || idleSeconds < 30 || idleSeconds > 600 ||
      !['applicationId', 'guildId', 'channelId', 'userId'].every(key => snowflake(scope[key]))) throw new Error('INVALID_COMMAND_SESSION');
  try {
    remainingLifetime(new Date(deadline).toISOString(), now(), { VOICE_USAGE_MODE: usageMode,
      VOICE_SESSION_STARTED_AT: Number.isSafeInteger(startedAt) ? new Date(startedAt).toISOString() : '' });
    if (usageMode === 'daily' && idleSeconds !== 300) throw new Error('Invalid daily idle deadline');
  } catch { throw new Error('INVALID_COMMAND_SESSION'); }
  const seen = new Map();
  const pendingSpeech = new Map();
  let controlId = 0n;
  let retiredId = 0n;
  const retireCompleted = () => {
    const current = now();
    for (const [id, entry] of seen) {
      // Keep pending work in the bounded cache even if dispatch ignores abort.
      if (!entry.settled || entry.expiresAt > current) continue;
      retiredId = BigInt(id) > retiredId ? BigInt(id) : retiredId;
      seen.delete(id);
    }
  };
  let idleAt = Math.min(deadline, now() + idleSeconds * 1000);
  let ended = false;
  const touch = () => { if (!ended) idleAt = Math.min(deadline, now() + idleSeconds * 1000); };
  const cancelSpeech = before => {
    for (const [id, controller] of pendingSpeech) {
      if (before === undefined || BigInt(id) <= before) controller.abort();
    }
  };
  const end = () => { if (!ended) { ended = true; cancelSpeech(); cancelJoin(); shutdown(); } };
  const checkIdle = () => { if (now() >= Math.min(idleAt, deadline)) end(); return ended; };
  async function handler(request) {
    const url = new URL(request.url);
    if (url.search) return new Response(null, { status: 404, headers });
    if (request.method === 'GET' && url.pathname === '/health') {
      const unavailable = checkIdle() || !ready();
      return Response.json({ ready: !unavailable, sessionId, deadline, idleAt, voice: voiceStatus(), queued: queued(), speechPhase: speechPhase() }, { status: unavailable ? 503 : 200, headers });
    }
    if (request.method !== 'POST' || !['/v1/command','/v1/shutdown'].includes(url.pathname)) return new Response(null, { status: 404, headers });
    if (checkIdle()) return Response.json({ error: 'SESSION_STOPPED' }, { status: 503, headers });
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return new Response(null, { status: 415, headers });
    let command;
    try { command = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBytes(request, 8192))); }
    catch { return Response.json({ error: 'INVALID_COMMAND' }, { status: 400, headers }); }
    if (url.pathname === '/v1/shutdown') {
      if (!command || typeof command !== 'object' || Array.isArray(command) ||
          Object.keys(command).some(key=>!['sessionId','applicationId','guildId','channelId','userId'].includes(key)) ||
          command.sessionId !== sessionId || Object.entries(scope).some(([key,value])=>command[key]!==value)) return Response.json({error:'COMMAND_SCOPE_MISMATCH'},{status:403,headers});
      end();return Response.json({stopped:true},{headers});
    }
    if (!command || typeof command !== 'object' || Array.isArray(command) ||
        Object.keys(command).some(key => !['id', 'sessionId', 'applicationId', 'guildId', 'channelId', 'userId', 'name', 'text'].includes(key)) ||
        !snowflake(command.id) || command.sessionId !== sessionId || !commands.includes(command.name) ||
        Object.entries(scope).some(([key, value]) => command[key] !== value)) return Response.json({ error: 'COMMAND_SCOPE_MISMATCH' }, { status: 403, headers });
    if (command.name === 'say') {
      try { command.text = validateSpeech({ text: command.text }).text; }
      catch { return Response.json({ error: 'INVALID_TEXT' }, { status: 400, headers }); }
    } else if (command.text !== undefined) return Response.json({ error: 'INVALID_COMMAND' }, { status: 400, headers });
    retireCompleted();
    const fingerprint = JSON.stringify(command);
    const previous = seen.get(command.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Response.json({ error: 'COMMAND_ID_CONFLICT' }, { status: 409, headers });
      return Response.json(await previous.result, { headers });
    }
    // Expired entries never become executable again, including out-of-order
    // requests below the retired high-water mark. Cached duplicates keep their original result.
    if (BigInt(command.id) <= retiredId) return Response.json({ content: '操作の有効期限が切れました。もう一度操作してください', joined: false }, { headers });
    if (command.name === 'say' && BigInt(command.id) <= controlId) return Response.json({ content: '読み上げを中止しました', joined: false }, { headers });
    if (seen.size >= DEDUP_CAPACITY && !['leave', 'stop'].includes(command.name)) return Response.json({ content: '操作が混み合っています。少し待って再試行してください', joined: false }, { headers });
    if (['join', 'leave', 'stop'].includes(command.name)) {
      if (BigInt(command.id) <= controlId) return Response.json({ content: '操作を中止しました', joined: false }, { headers });
      controlId = BigInt(command.id);
      // A /say may be awaiting the speaker's member/display-name lookup.
      // Clear its admission as well as the already-enqueued player items.
      cancelSpeech(controlId);
      if (command.name !== 'join') cancelJoin(); // Cancellation precedes asynchronous dispatch.
    }
    if (command.name !== 'voice-status') touch();
    const acceptedControl = controlId;
    const speechAbort = new AbortController();
    if (command.name === 'say') pendingSpeech.set(command.id, speechAbort);
    const signal = AbortSignal.any([request.signal, speechAbort.signal,
      AbortSignal.timeout(Math.max(1, Math.min(25_000, deadline - now())))]);
    // Put the promise in the map before the first asynchronous operation.
    const entry = { fingerprint, expiresAt: now() + DEDUP_MS, settled: false, result: null };
    const result = Promise.resolve().then(async () => {
      if (ended || (command.name === 'join' && acceptedControl !== controlId)) return { content: '接続を中止しました', joined: false };
      if (command.name === 'say' && BigInt(command.id) <= controlId) return { content: '読み上げを中止しました', joined: false };
      try {
        signal.throwIfAborted();
        const value = await dispatch(command, signal);
        if (command.name === 'join' && (ended || acceptedControl !== controlId)) return { content: '接続を中止しました', joined: false };
        if (!value || typeof value.content !== 'string' || value.content.length > 500 || typeof value.joined !== 'boolean') throw new Error('INVALID_COMMAND_RESULT');
        return value;
      } catch (error) { return { content: signal.aborted && command.name === 'say' ? '読み上げを中止しました' :
        error?.code === 'TEXT_PERMISSION_REQUIRED' ? 'このチャンネルの閲覧・コマンド利用権限、またはBotのスレッド参加状態を確認してください' :
        error?.code === 'VOICE_PERMISSION_REQUIRED' ? 'ボイスチャンネルの閲覧・接続権限とBotの発言権限を確認してください' :
        '処理に失敗しました。接続状態を確認してください', joined: false }; }
    }).finally(() => { entry.settled = true; if (pendingSpeech.get(command.id) === speechAbort) pendingSpeech.delete(command.id); });
    entry.result = result;
    if (seen.size < DEDUP_CAPACITY) seen.set(command.id, entry); // Control-ID watermark protects priority stops when full.
    return Response.json(await result, { headers });
  }
  return { handler, touch, checkIdle, end, get idleAt() { return idleAt; } };
}
