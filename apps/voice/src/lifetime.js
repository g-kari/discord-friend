const TRIAL_LIMIT_MS = 30 * 60_000;
const DAILY_SESSION_LIMIT_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Absolute Worker-issued deadline; only explicit daily mode permits a longer session. */
export function remainingLifetime(value, now = Date.now(), env = {}) {
  const mode = env.VOICE_USAGE_MODE || 'trial';
  if (!['trial', 'daily'].includes(mode)) throw new Error('Invalid usage mode');
  if (!value) throw new Error(`Missing ${mode} deadline`);
  const deadline = Date.parse(value);
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || deadline <= now ||
      deadline - now > (mode === 'daily' ? DAILY_SESSION_LIMIT_MS : TRIAL_LIMIT_MS)) {
    throw new Error(`Invalid or expired ${mode} deadline`);
  }
  if (mode === 'daily') {
    const startedAt = Date.parse(env.VOICE_SESSION_STARTED_AT);
    if (!Number.isSafeInteger(startedAt) || startedAt > now || deadline - startedAt > DAILY_SESSION_LIMIT_MS ||
        deadline > (Math.floor(startedAt / DAY_MS) + 1) * DAY_MS) throw new Error('Invalid daily session bounds');
  }
  return deadline - now;
}

export function applyLifetime(shutdown) {
  const remaining = remainingLifetime(process.env.VOICE_DEADLINE, Date.now(), process.env);
  setTimeout(() => {
    shutdown();
    // Closing a socket may wait for a peer; enforce the fixed session end in this process too.
    process.exit(0);
  }, remaining).unref();
}
