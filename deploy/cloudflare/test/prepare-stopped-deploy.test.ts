import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { parseInputs, verifyCheckout, readSourceConfig, createStoppedConfig, writeStoppedConfig } = require('../scripts/prepare-stopped-deploy.cjs');
const source = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const tree = 'a'.repeat(40);
const account = 'b'.repeat(32);
const args = [tree, 'c'.repeat(64), 'd'.repeat(64), '100000000000000001', '100000000000000002', '100000000000000003', '100000000000000004'];
const buildArgs = args.map((value, index) => index === 2 ? 'build' : value);

test('prepares stopped config while preserving resource identity and unrelated settings', () => {
  const original = readSourceConfig(source);
  const output = createStoppedConfig(source, parseInputs(args, account));
  assert.equal(output.workers_dev, true);
  assert.equal(output.preview_urls, false);
  for (const [key, value] of Object.entries({ BOT_ENABLED: 'false', VOICE_DEADLINE: '', VOICE_USAGE_MODE: 'trial', DISCORD_SCOPE_MODE: 'pinned', DISCORD_HTTP_ENABLED: 'true', DISCORD_PUBLIC_KEY: args[1], DISCORD_APPLICATION_ID: args[3], DISCORD_GUILD_ID: args[4], DISCORD_TEXT_CHANNEL_ID: args[5], DISCORD_OWNER_ID: args[6] })) assert.equal(output.vars[key], value);
  const helperKeys = Object.keys(output.vars).filter(key => /^(DISCORD_GLOBAL_SETUP_|DISCORD_SETUP_|CONFIRM_DISCORD_SETUP$)/.test(key));
  assert.equal(helperKeys.length, 10);
  for (const key of helperKeys) assert.equal(output.vars[key], '');
  assert.deepEqual(output.containers.map(c => c.max_instances), [0, 0]);
  assert.equal(output.containers[1].image, `registry.cloudflare.com/${account}/discord-friend-voice-voicevox@sha256:${args[2]}`);
  assert.deepEqual(output.containers[0], original.containers[0]);
  assert.deepEqual({ ...output.containers[1], image: original.containers[1].image }, original.containers[1]);
  assert.equal(output.vars.VOICE_IDLE_SECONDS, '300');
  assert.equal(output.vars.VOICE_SESSION_MINUTES, '30');
  for (const key of ['durable_objects', 'migrations', 'secrets', 'triggers', 'observability', 'main', 'compatibility_date', 'compatibility_flags']) assert.deepEqual(output[key], original[key]);
});

test('explicit build mode prepares stopped eight-hour daily usage and retains both Dockerfiles', () => {
  const original = readSourceConfig(source);
  const output = createStoppedConfig(source, parseInputs(buildArgs, account));
  const pinned = createStoppedConfig(source, parseInputs(args, account));
  assert.equal(output.vars.BOT_ENABLED, 'false');
  assert.equal(output.vars.DISCORD_HTTP_ENABLED, 'true');
  assert.equal(output.vars.VOICE_DEADLINE, '');
  assert.deepEqual(output.containers.map(c => c.max_instances), [0, 0]);
  assert.deepEqual(output.containers.map(c => c.image), ['../../apps/voice/Dockerfile.bot', '../../apps/voice/Dockerfile.tts']);
  assert.deepEqual(output.containers, original.containers);
  assert.deepEqual(output, {
    ...pinned,
    vars: { ...pinned.vars, VOICE_USAGE_MODE: 'daily', DISCORD_SCOPE_MODE: 'installed-guilds', VOICE_IDLE_SECONDS: '300', VOICE_SESSION_MINUTES: '480' },
    containers: original.containers,
  });
  assert.equal(readSourceConfig(source).vars.VOICE_SESSION_MINUTES, '30');
});

test('rejects malformed inputs, account IDs and out-of-range snowflakes', () => {
  for (const index of [0, 1, 2, 3, 4, 5, 6]) {
    const invalid = [...args]; invalid[index] = 'invalid';
    assert.throws(() => parseInputs(invalid, account));
  }
  assert.throws(() => parseInputs(args.slice(1), account));
  assert.throws(() => parseInputs([...args, 'extra'], account));
  assert.throws(() => parseInputs(args, undefined));
  assert.throws(() => parseInputs(args, 'wrong-account'));
  assert.throws(() => parseInputs(buildArgs, undefined));
  assert.throws(() => parseInputs(buildArgs, 'wrong-account'));
  for (const badId of ['0', '-100000000000000001', '0100000000000000001', '18446744073709551616']) {
    const invalid = [...args]; invalid[3] = badId;
    assert.throws(() => parseInputs(invalid, account));
  }
});

test('accepts only an immutable lowercase TTS digest or the exact build literal', () => {
  assert.equal(parseInputs(args, account).ttsDigest, args[2]);
  assert.equal(parseInputs(buildArgs, account).ttsDigest, 'build');
  for (const invalid of ['', 'BUILD', 'Build', ' build', 'build ', 'build-both', 'latest', 'd'.repeat(63), 'd'.repeat(65), 'D'.repeat(64), `sha256:${args[2]}`, '../../apps/voice/Dockerfile.tts', `registry.cloudflare.com/${account}/tts:latest`]) {
    const invalidArgs = [...args]; invalidArgs[2] = invalid;
    assert.throws(() => parseInputs(invalidArgs, account), /TTS digest or literal build/);
  }
});

test('rejects changed source config before generating a deployment', () => {
  for (const changed of [source.replace('"BOT_ENABLED": "false"', '"BOT_ENABLED": "true"'), source.replace('voice-v1', 'voice-v2'), source.replace('"max_instances": 0', '"max_instances": 1'), source + '\n']) {
    for (const modeArgs of [args, buildArgs]) assert.throws(() => createStoppedConfig(changed, parseInputs(modeArgs, account)), /Wrangler config changed/);
  }
});

test('writes exclusively and never overwrites a prepared config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-output-'));
  try {
    const outputPath = path.join(dir, '.stopped.jsonc');
    const config = createStoppedConfig(source, parseInputs(args, account));
    writeStoppedConfig(outputPath, config);
    const before = fs.readFileSync(outputPath, 'utf8');
    assert.deepEqual(JSON.parse(before), config);
    assert.throws(() => writeStoppedConfig(outputPath, config), /EEXIST/);
    assert.equal(fs.readFileSync(outputPath, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('requires exact CI commit, tree and clean tracked/untracked source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stopped-git-'));
  const git = (...command) => execFileSync('git', command, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'tracked'), 'source\n');
    git('add', 'tracked');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
    const commit = git('rev-parse', 'HEAD'), actualTree = git('rev-parse', 'HEAD^{tree}');
    verifyCheckout(dir, actualTree, commit);
    assert.throws(() => verifyCheckout(dir, actualTree, undefined));
    assert.throws(() => verifyCheckout(dir, actualTree, 'a'.repeat(40)), /CI commit/);
    assert.throws(() => verifyCheckout(dir, 'a'.repeat(40), commit), /source tree/);
    fs.writeFileSync(path.join(dir, 'tracked'), 'changed\n');
    assert.throws(() => verifyCheckout(dir, actualTree, commit));
    git('checkout', '--', 'tracked');
    fs.writeFileSync(path.join(dir, 'untracked'), 'unexpected\n');
    assert.throws(() => verifyCheckout(dir, actualTree, commit), /untracked source/);
    fs.unlinkSync(path.join(dir, 'untracked'));
    fs.mkdirSync(path.join(dir, 'deploy/cloudflare'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'deploy/cloudflare/.stopped.jsonc'), '{}');
    verifyCheckout(dir, actualTree, commit);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
