import { createHash } from 'node:crypto';
import { APPROVED_SCOPE_FINGERPRINT, scopeFingerprint } from './guild-setup.ts';

export const APPROVED_PRINCIPAL = '6a7deb114bddfa37839427393cee170500eef10b8100579835edb9b5174eb01a';
export interface ScopeEnv {
  DISCORD_SCOPE_MODE?: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_OWNER_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_TEXT_CHANNEL_ID: string;
}
export interface SessionScope {
  applicationId: string; guildId: string; channelId: string; userId: string;
}
export interface CommandScope extends SessionScope {
  guildInstallId?: string; channelType?: number; memberPermissions?: string; appPermissions?: string;
}
export const snowflake = (value: unknown): value is string => typeof value === 'string' && /^\d{17,20}$/.test(value);
export const installedScope = (env: Pick<ScopeEnv, 'DISCORD_SCOPE_MODE'>): boolean => env.DISCORD_SCOPE_MODE === 'installed-guilds';
export function principalFingerprint(env: Pick<ScopeEnv, 'DISCORD_APPLICATION_ID' | 'DISCORD_OWNER_ID'>): string {
  return createHash('sha256').update([env.DISCORD_APPLICATION_ID, env.DISCORD_OWNER_ID].join(':')).digest('hex');
}
export function scopePolicyActive(env: ScopeEnv, approved = APPROVED_SCOPE_FINGERPRINT, principal = APPROVED_PRINCIPAL): boolean {
  if (!snowflake(env.DISCORD_APPLICATION_ID) || !snowflake(env.DISCORD_OWNER_ID)) return false;
  if (installedScope(env)) return principalFingerprint(env) === principal;
  return (!env.DISCORD_SCOPE_MODE || env.DISCORD_SCOPE_MODE === 'pinned') &&
    snowflake(env.DISCORD_GUILD_ID) && snowflake(env.DISCORD_TEXT_CHANNEL_ID) && scopeFingerprint(env) === approved;
}
export function hasPermissions(value: unknown, required: bigint): boolean {
  if (typeof value !== 'string' || !/^\d{1,24}$/.test(value)) return false;
  const actual = BigInt(value);
  return (actual & 8n) !== 0n || (actual & required) === required;
}
export const VIEW_CHANNEL = 1n << 10n;
export const USE_COMMANDS = 1n << 31n;
// A forum/media parent is not a message stream. A post is its own thread.
// Only already-accessible threads are usable; never join a thread for the user.
export const TEXT_CHANNEL_TYPES = [0, 2, 5, 10, 11, 12] as const;
export function commandScopeAllowed(command: CommandScope, env: ScopeEnv): boolean {
  if (command.applicationId !== env.DISCORD_APPLICATION_ID || command.userId !== env.DISCORD_OWNER_ID ||
      !snowflake(command.guildId) || !snowflake(command.channelId)) return false;
  if (!installedScope(env)) return command.guildId === env.DISCORD_GUILD_ID && command.channelId === env.DISCORD_TEXT_CHANNEL_ID;
  return command.guildInstallId === command.guildId && TEXT_CHANNEL_TYPES.includes(command.channelType as typeof TEXT_CHANNEL_TYPES[number]) &&
    hasPermissions(command.memberPermissions, VIEW_CHANNEL | USE_COMMANDS) && hasPermissions(command.appPermissions, VIEW_CHANNEL);
}
export function commandSessionScope(command: SessionScope): SessionScope {
  return { applicationId: command.applicationId, guildId: command.guildId, channelId: command.channelId, userId: command.userId };
}
export function sameSessionScope(left: SessionScope | undefined, right: SessionScope): boolean {
  return Boolean(left) && ['applicationId', 'guildId', 'channelId', 'userId'].every(key => left![key as keyof SessionScope] === right[key as keyof SessionScope]);
}
export function scopeKey(scope: SessionScope): string {
  return [scope.applicationId, scope.guildId, scope.channelId, scope.userId].join(':');
}
