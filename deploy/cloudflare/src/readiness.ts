export interface RuntimeEnv {
  BOT_ENABLED: string;
  VOICE_USAGE_MODE?: string;
  DISCORD_SCOPE_MODE?: string;
  VOICE_DEADLINE: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_TEXT_CHANNEL_ID: string;
  DISCORD_OWNER_ID: string;
}
export interface ReadinessSnapshot {
  state: 'inactive' | 'gateway-ready' | 'gateway-not-ready' | 'unavailable';
  checkedAt: string;
  deadline: string;
  httpStatus: number | null;
  voice: string | null;
}
export function runtimeActive(env: RuntimeEnv, now: number = Date.now()): boolean {
  const remaining = Date.parse(env.VOICE_DEADLINE) - now;
  const daily = env.VOICE_USAGE_MODE === 'daily' && env.VOICE_DEADLINE === '';
  const trial = (!env.VOICE_USAGE_MODE || env.VOICE_USAGE_MODE === 'trial') && remaining > 0 && remaining <= 30 * 60 * 1000;
  return env.BOT_ENABLED === 'true' && (daily || trial) && Boolean(env.DISCORD_BOT_TOKEN) &&
    (env.DISCORD_SCOPE_MODE === 'installed-guilds' ? [env.DISCORD_OWNER_ID] : [env.DISCORD_GUILD_ID, env.DISCORD_TEXT_CHANNEL_ID, env.DISCORD_OWNER_ID]).every(id => /^\d{17,20}$/.test(id));
}
export async function inspectReadiness(env: RuntimeEnv, request: (request: Request) => Promise<Response>,
  now: () => number = Date.now): Promise<ReadinessSnapshot> {
  const snapshot: ReadinessSnapshot = { state: 'inactive', checkedAt: new Date(now()).toISOString(), deadline: env.VOICE_DEADLINE, httpStatus: null, voice: null };
  if (!runtimeActive(env, now())) return snapshot; // No Container access on the stopped path.
  const signal = AbortSignal.timeout(Math.max(1, Math.min(25_000, env.VOICE_USAGE_MODE === 'daily' ? 25_000 : Date.parse(env.VOICE_DEADLINE) - now())));
  try {
    const response = await request(new Request('http://bot.internal/health', { signal }));
    snapshot.httpStatus = response.status;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing health response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    let health: unknown;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 4096) throw new Error('Oversize health response');
        chunks.push(chunk.value);
      }
      signal.throwIfAborted();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      health = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    } finally { await reader.cancel().catch(() => {}); signal.removeEventListener('abort', abort); reader.releaseLock(); }
    if (typeof health !== 'object' || health === null || !('ready' in health) || typeof health.ready !== 'boolean') throw new Error('Invalid health response');
    if (env.VOICE_USAGE_MODE === 'daily') {
      if (!('deadline' in health) || typeof health.deadline !== 'number' || health.deadline <= now() || health.deadline > now() + 30 * 60_000) throw new Error('Invalid session deadline');
      snapshot.deadline = new Date(health.deadline).toISOString();
    }
    snapshot.state = response.status === 200 && health.ready ? 'gateway-ready' : response.status === 503 && !health.ready ? 'gateway-not-ready' : 'unavailable';
    if ('voice' in health && typeof health.voice === 'string' && ['signalling', 'connecting', 'ready', 'disconnected', 'destroyed'].includes(health.voice)) snapshot.voice = health.voice;
  } catch { snapshot.state = 'unavailable'; }
  if (!runtimeActive(env, now())) snapshot.state = 'inactive';
  snapshot.checkedAt = new Date(now()).toISOString();
  return snapshot;
}
