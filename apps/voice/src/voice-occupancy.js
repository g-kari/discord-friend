const snowflake = value => typeof value === 'string' && /^\d{17,20}$/u.test(value);

function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Cache supplies scoped candidates only. Only a fresh REST witness may renew idle. */
export function createVoiceOccupancy({ usageMode = 'trial', sessionId, guildId, deadline, state, candidates,
  fetchVoiceState, touch, now = Date.now, timeoutMs = 5000 }) {
  let closed = usageMode !== 'daily', epoch = 0, pending = null, checkedIdleAt = null, nextProbeAt = 0;
  const active = value => !closed && value.sessionId === sessionId && value.guildId === guildId &&
    value.gatewayReady === true && value.voiceReady === true && value.connection &&
    snowflake(value.channelId) && snowflake(value.selfId) && Number.isFinite(value.idleAt) &&
    now() < Math.min(value.idleAt, deadline);
  const invalidate = () => {
    epoch++; checkedIdleAt = null;
    pending?.controller.abort(new Error('OCCUPANCY_CANCELLED'));
  };
  const matches = (value, userId, channelId) => value && value.user_id === userId &&
    value.channel_id === channelId && (value.guild_id === undefined || value.guild_id === guildId) &&
    (value.member?.user?.id === undefined || value.member.user.id === userId);

  function probe() {
    if (closed || pending) return Promise.resolve(false);
    const initial = state();
    if (!active(initial) || now() < initial.idleAt - 15_000 || now() < nextProbeAt || checkedIdleAt === initial.idleAt) return Promise.resolve(false);
    checkedIdleAt = initial.idleAt;
    nextProbeAt = now() + 5000; // Even membership churn cannot start an unbounded burst.
    const witnesses = [...new Set(candidates().filter(member => member.guildId === guildId &&
      member.channelId === initial.channelId && member.bot === false && member.id !== initial.selfId &&
      snowflake(member.id)).map(member => member.id))].slice(0, 3);
    if (!witnesses.length) return Promise.resolve(false);
    const attempt = { controller: new AbortController(), epoch, connection: initial.connection };
    pending = attempt;
    const { signal } = attempt.controller;
    const timer = setTimeout(() => attempt.controller.abort(new Error('OCCUPANCY_TIMEOUT')),
      Math.max(1, Math.min(5000, timeoutMs, deadline - now(), initial.idleAt - now())));
    timer.unref?.();
    const current = () => {
      const latest = state();
      return !signal.aborted && pending === attempt && attempt.epoch === epoch && active(latest) &&
        latest.connection === attempt.connection && latest.channelId === initial.channelId &&
        latest.selfId === initial.selfId && now() < initial.idleAt;
    };
    return (async () => {
      // Raw REST reads must not insert responses into discord.js's Gateway cache.
      const me = await abortable(() => fetchVoiceState(initial.selfId, signal), signal);
      if (!current() || !matches(me, initial.selfId, initial.channelId)) return false;
      for (const userId of witnesses) {
        if (!current()) return false;
        let member;
        try { member = await abortable(() => fetchVoiceState(userId, signal), signal); }
        catch (error) { if (error?.status === 404 && current()) continue; throw error; }
        if (!current()) return false;
        if (!matches(member, userId, initial.channelId) || member.member?.user?.bot === true) continue;
        touch(); // The command service independently clamps this to the fixed deadline.
        return true;
      }
      return false;
    })().catch(() => false).finally(() => {
      clearTimeout(timer);
      if (pending === attempt) pending = null;
    });
  }
  return {
    tick() { try { return probe(); } catch { return Promise.resolve(false); } },
    invalidate, close() { closed = true; invalidate(); },
  };
}
