import { remainingLifetime } from './lifetime.js';
import { createHash } from 'node:crypto';

export const APPROVED_BOT_PRINCIPAL = '6a7deb114bddfa37839427393cee170500eef10b8100579835edb9b5174eb01a';
export const APPROVED_BOT_SCOPE = '5d238599d1632869b4bf3729344b45875f714f0ab286600a64bf8f267767f6f7';

/** Independent image gate: a scheduler must not bypass the Worker's launch decision. */
export function assertBotStartup(env, now = Date.now(), approvedScope = APPROVED_BOT_SCOPE, approvedPrincipal = APPROVED_BOT_PRINCIPAL) {
  if (env.BOT_ENABLED !== 'true') throw new Error('Bot is disabled');
  if (env.DISCORD_COMMAND_TRANSPORT !== 'http') throw new Error('HTTP command transport is required');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(env.VOICE_SESSION_ID ?? '')) throw new Error('Missing voice session');
  if (!Number.isInteger(Number(env.VOICE_IDLE_SECONDS)) || Number(env.VOICE_IDLE_SECONDS) < 30 || Number(env.VOICE_IDLE_SECONDS) > 600) throw new Error('Invalid idle deadline');
  if (env.VOICE_USAGE_MODE === 'daily' && env.VOICE_IDLE_SECONDS !== '300') throw new Error('Invalid daily idle deadline');
  const remaining = remainingLifetime(env.VOICE_DEADLINE, now, env);
  const required = ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'DISCORD_TEXT_CHANNEL_ID', 'DISCORD_OWNER_ID', 'DISCORD_APPLICATION_ID'];
  for (const name of required) {
    if (typeof env[name] !== 'string' || !env[name]) throw new Error(`Missing ${name}`);
  }
  for (const name of required.slice(1)) {
    if (!/^\d{17,20}$/u.test(env[name])) throw new Error(`Invalid ${name}`);
  }
  const actual = createHash('sha256').update([env.DISCORD_APPLICATION_ID, env.DISCORD_GUILD_ID, env.DISCORD_TEXT_CHANNEL_ID, env.DISCORD_OWNER_ID].join(':')).digest('hex');
  if (env.DISCORD_SCOPE_MODE === 'installed-guilds') {
    const principal = createHash('sha256').update([env.DISCORD_APPLICATION_ID, env.DISCORD_OWNER_ID].join(':')).digest('hex');
    if (principal !== approvedPrincipal) throw new Error('Bot principal mismatch');
  } else if ((env.DISCORD_SCOPE_MODE && env.DISCORD_SCOPE_MODE !== 'pinned') || actual !== approvedScope) throw new Error('Bot scope mismatch');
  return remaining;
}
