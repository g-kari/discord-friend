/** Required absolute trial deadline, provided by the Worker rather than reset on every restart. */
export function remainingLifetime(value, now = Date.now()) {
  if (!value) throw new Error('Missing trial deadline');
  const deadline = Date.parse(value);
  if (!Number.isFinite(deadline) || deadline <= now || deadline - now > 30 * 60 * 1000) {
    throw new Error('Invalid or expired trial deadline');
  }
  return deadline - now;
}

export function applyLifetime(shutdown) {
  const remaining = remainingLifetime(process.env.VOICE_DEADLINE);
  setTimeout(() => {
    shutdown();
    // Closing a socket may wait for a peer; enforce the fixed trial end in this process too.
    process.exit(0);
  }, remaining).unref();
}
