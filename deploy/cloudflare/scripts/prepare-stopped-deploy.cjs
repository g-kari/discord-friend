'use strict';

// Deployment preparation only: no credentials, network access, Docker or runtime.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const SOURCE_CONFIG_SHA256 = 'b60d174e9423b894f1ef00b3e1da1105bd33f8e7978e859ba0c114a1b2de915d';
const CONFIG_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(CONFIG_DIR, '../..');
const OUTPUT_NAME = '.stopped.jsonc';

function hex(value, length, label) {
  assert.equal(typeof value, 'string', `${label} is required`);
  assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`), `${label} must be ${length} lowercase hex characters`);
  return value;
}

function parseInputs(args, accountId) {
  assert.equal(args.length, 7, 'Expected: TREE PUBLIC_KEY TTS_DIGEST APPLICATION_ID GUILD_ID TEXT_CHANNEL_ID OWNER_ID');
  const [tree, publicKey, ttsDigest, ...ids] = args;
  hex(tree, 40, 'Expected tree');
  hex(publicKey, 64, 'Discord public key');
  hex(ttsDigest, 64, 'TTS digest');
  hex(accountId, 32, 'Cloudflare account ID');
  for (const id of ids) {
    assert.match(id, /^[1-9]\d{16,19}$/, 'Discord IDs must be decimal snowflakes');
    assert.ok(BigInt(id) <= 18446744073709551615n, 'Discord ID exceeds unsigned 64-bit range');
  }
  return { tree, publicKey, ttsDigest, ids, accountId };
}

function verifyCheckout(repoRoot, expectedTree, ciCommit) {
  hex(expectedTree, 40, 'Expected tree');
  hex(ciCommit, 40, 'WORKERS_CI_COMMIT_SHA');
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git('rev-parse', 'HEAD'), ciCommit, 'CI commit must equal git HEAD');
  assert.equal(git('rev-parse', 'HEAD^{tree}'), expectedTree, 'Unexpected source tree');
  git('diff', '--quiet', 'HEAD', '--');
  const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
  assert.ok(untracked.every(name => name === `deploy/cloudflare/${OUTPUT_NAME}`), 'Unexpected untracked source files');
}

function readSourceConfig(sourceText) {
  assert.equal(createHash('sha256').update(sourceText).digest('hex'), SOURCE_CONFIG_SHA256, 'Checked-in Wrangler config changed; review the source config before updating its expected hash');
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', sourceText);
  assert.equal(parsed.error, undefined, 'Invalid source JSONC');
  return parsed.config;
}

function createStoppedConfig(sourceText, inputs) {
  const config = readSourceConfig(sourceText);
  config.workers_dev = true;
  config.preview_urls = false;
  Object.assign(config.vars, {
    BOT_ENABLED: 'false', VOICE_DEADLINE: '', VOICE_USAGE_MODE: 'trial',
    DISCORD_SCOPE_MODE: 'pinned', DISCORD_HTTP_ENABLED: 'true',
    DISCORD_PUBLIC_KEY: inputs.publicKey,
    DISCORD_APPLICATION_ID: inputs.ids[0], DISCORD_GUILD_ID: inputs.ids[1],
    DISCORD_TEXT_CHANNEL_ID: inputs.ids[2], DISCORD_OWNER_ID: inputs.ids[3],
  });
  for (const key of Object.keys(config.vars)) {
    if (key.startsWith('DISCORD_GLOBAL_SETUP_') || key.startsWith('DISCORD_SETUP_') || key === 'CONFIRM_DISCORD_SETUP') config.vars[key] = '';
  }
  for (const container of config.containers) container.max_instances = 0;
  const tts = config.containers.find(container => container.class_name === 'Voicevox');
  tts.image = `registry.cloudflare.com/${inputs.accountId}/${tts.name}@sha256:${inputs.ttsDigest}`;
  // Wrangler accepts the existing image_build_context and ignores it for a
  // registry image. Preserve it, names, bindings, migrations and secret names.
  return config;
}

function writeStoppedConfig(outputPath, config) {
  fs.writeFileSync(outputPath, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' });
}

function main(args = process.argv.slice(2), env = process.env) {
  if (args[0] === '--verify') {
    assert.equal(args.length, 2, 'Expected: --verify TREE');
    verifyCheckout(REPO_ROOT, args[1], env.WORKERS_CI_COMMIT_SHA);
    readSourceConfig(fs.readFileSync(path.join(CONFIG_DIR, 'wrangler.jsonc'), 'utf8'));
    return;
  }
  const inputs = parseInputs(args, env.CLOUDFLARE_ACCOUNT_ID);
  verifyCheckout(REPO_ROOT, inputs.tree, env.WORKERS_CI_COMMIT_SHA);
  const config = createStoppedConfig(fs.readFileSync(path.join(CONFIG_DIR, 'wrangler.jsonc'), 'utf8'), inputs);
  writeStoppedConfig(path.join(CONFIG_DIR, OUTPUT_NAME), config);
  console.log(`Prepared ${OUTPUT_NAME}; both container capacities remain zero.`);
}

module.exports = { parseInputs, verifyCheckout, readSourceConfig, createStoppedConfig, writeStoppedConfig, main };
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(`Stopped deploy preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
