import { remainingLifetime } from './lifetime.js';

/** Independent image gate: a scheduler must not bypass the Worker's launch decision. */
export function assertBotStartup(env, now = Date.now()) {
  if (env.BOT_ENABLED !== 'true') throw new Error('Bot is disabled');
  const remaining = remainingLifetime(env.VOICE_DEADLINE, now);
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_TEXT_CHANNEL_ID', 'DISCORD_OWNER_ID'];
  for (const name of required) {
    if (typeof env[name] !== 'string' || !env[name]) throw new Error(`Missing ${name}`);
  }
  for (const name of required.slice(1)) {
    if (!/^\d{17,20}$/u.test(env[name])) throw new Error(`Invalid ${name}`);
  }
  return remaining;
}
