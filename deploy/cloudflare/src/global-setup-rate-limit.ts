// Keep only parsed timing/status data. Never retain Discord bodies or raw headers.
export interface GlobalRateLimitEvidence {
  observedAt: string; status: number; route: 'application' | 'commands'; method: 'GET' | 'POST';
  retryAfterSeconds: number | null; retryAfterAt: string | null; bodyRetryAfterSeconds: number | null;
  resetAt: string | null; resetAfterSeconds: number | null; remaining: number | null;
  scope: 'user' | 'global' | 'shared' | null; global: boolean | null;
  invalid: boolean; notBefore: string | null;
}
export function rateLimitEvidence(response: Response, body: unknown, now: number,
  route: GlobalRateLimitEvidence['route'], method: GlobalRateLimitEvidence['method']): GlobalRateLimitEvidence | null {
  const h = response.headers;
  const recognized = ['retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset',
    'x-ratelimit-reset-after', 'x-ratelimit-global', 'x-ratelimit-scope'];
  const present = [...h.keys()].filter(name => recognized.includes(name));
  if (!present.length && response.status !== 429) return null; // Discord's headers are optional.
  const result: GlobalRateLimitEvidence = { observedAt: new Date(now).toISOString(), status: response.status, route, method,
    retryAfterSeconds: null, retryAfterAt: null, bodyRetryAfterSeconds: null, resetAt: null,
    resetAfterSeconds: null, remaining: null, scope: null, global: null,
    invalid: false, notBefore: null };
  function numeric(value: unknown): number | null {
    const text = String(value);
    const parsed = Number(text);
    if ((typeof value !== 'string' && typeof value !== 'number') || text.length > 40 ||
        !/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(parsed) || parsed < 0) { result.invalid = true; return null; }
    return parsed;
  }
  function time(value: number): string | null {
    if (!Number.isFinite(value) || value < 0 || value > 8.64e15) { result.invalid = true; return null; }
    return new Date(Math.ceil(value)).toISOString();
  }
  function numberHeader(name: string): number | null { const value = h.get(name); return value === null ? null : numeric(value); }
  result.remaining = numberHeader('x-ratelimit-remaining');
  if (result.remaining !== null && !Number.isSafeInteger(result.remaining)) result.invalid = true;
  const reset = numberHeader('x-ratelimit-reset');
  if (reset !== null) result.resetAt = time(reset * 1000);
  result.resetAfterSeconds = numberHeader('x-ratelimit-reset-after');
  const retry = h.get('retry-after');
  if (retry !== null) {
    if (/^\d+(?:\.\d+)?$/.test(retry)) result.retryAfterSeconds = numeric(retry);
    else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry) && Number.isFinite(Date.parse(retry))) result.retryAfterAt = time(Date.parse(retry));
    else result.invalid = true;
  }
  const scope = h.get('x-ratelimit-scope');
  if (scope !== null) { if (scope === 'user' || scope === 'global' || scope === 'shared') result.scope = scope; }
  const global = h.get('x-ratelimit-global');
  if (global !== null) { if (global === 'true' || global === 'false') result.global = global === 'true'; }
  if (response.status === 429 && typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const value = body as Record<string, unknown>;
    if (Object.hasOwn(value, 'retry_after')) result.bodyRetryAfterSeconds = numeric(value.retry_after);
    if (Object.hasOwn(value, 'global')) { if (typeof value.global === 'boolean') result.global = value.global; }
  }
  const bounds: string[] = [];
  for (const seconds of [result.retryAfterSeconds, result.bodyRetryAfterSeconds]) {
    if (seconds !== null) { const bound = time(now + seconds * 1000); if (bound) bounds.push(bound); }
  }
  if (result.retryAfterAt) bounds.push(result.retryAfterAt);
  if (response.status === 429 || result.remaining === 0) {
    if (result.resetAt) bounds.push(result.resetAt);
    if (result.resetAfterSeconds !== null) { const bound = time(now + result.resetAfterSeconds * 1000); if (bound) bounds.push(bound); }
  }
  // A known exhausted bucket without usable timing cannot justify another call.
  if (result.remaining === 0 && !bounds.length) result.invalid = true;
  if (bounds.length) result.notBefore = bounds.reduce((a, b) => Date.parse(a) >= Date.parse(b) ? a : b);
  return result;
}
