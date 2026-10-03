import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { COMMANDS, SETUP_CONFIRMATION } from '../src/guild-setup.ts';

// Use only the dependencies declared by the repository's pinned Wrangler. No
// extra test packages, account credentials, Wrangler login, or deployment.
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare, Response: OutboundResponse, convertV4MiniflareOptions } = wranglerRequire('miniflare');
const { build } = wranglerRequire('esbuild');
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const NOW = Date.parse('2026-10-02T12:00:00Z');
const TOKEN = 'synthetic-workerd-test-token';
const TARGET = {
  applicationId: '100000000000000001', guildId: '100000000000000002',
  textChannelId: '100000000000000003', ownerId: '100000000000000004',
};
const BINDINGS = {
  BOT_ENABLED: 'false', VOICE_DEADLINE: '', DISCORD_BOT_TOKEN: TOKEN,
  DISCORD_APPLICATION_ID: TARGET.applicationId, DISCORD_GUILD_ID: TARGET.guildId,
  DISCORD_TEXT_CHANNEL_ID: TARGET.textChannelId, DISCORD_OWNER_ID: TARGET.ownerId,
  CONFIRM_DISCORD_SETUP: SETUP_CONFIRMATION,
  DISCORD_SETUP_OPERATION_ID: '4f267a00-71ce-4a70-9b85-2b4fbc096a6e',
  DISCORD_SETUP_DEADLINE: new Date(NOW + 10 * 60 * 1000).toISOString(),
};
const COMMAND_PATH = `/api/v10/applications/${TARGET.applicationId}/guilds/${TARGET.guildId}/commands`;
const UNRELATED = { type: 1, name: 'unrelated', description: 'Preserve this command' };

type Call = { url: string; method: string; authorization: string | null; body: unknown };
type Redirect = { status: number; location: string; method: 'GET' | 'POST' };

function discord(redirect?: Redirect) {
  const existing: Record<string, unknown>[] = [structuredClone(UNRELATED)];
  const calls: Call[] = [];
  const respond = async (request: Request) => {
    const body = request.method === 'POST' ? JSON.parse(await request.text()) : null;
    calls.push({ url: request.url, method: request.method, authorization: request.headers.get('authorization'), body });
    if (redirect && request.method === redirect.method) {
      return new OutboundResponse('Synthetic redirect response', {
        status: redirect.status, headers: { location: redirect.location },
      });
    }
    const url = new URL(request.url);
    // This is the Worker's only outbound service, including unexpected hosts.
    // Never delegate to Node fetch or a network service, even for a bad URL.
    if (url.origin !== 'https://discord.com') return OutboundResponse.json({ error: 'Unexpected host' }, { status: 418 });
    if (url.pathname === '/api/v10/applications/@me') return OutboundResponse.json({ id: TARGET.applicationId });
    if (url.pathname === `/api/v10/channels/${TARGET.textChannelId}`) {
      return OutboundResponse.json({ id: TARGET.textChannelId, guild_id: TARGET.guildId, type: 0 });
    }
    if (url.pathname !== COMMAND_PATH) return OutboundResponse.json({ error: 'Unexpected path' }, { status: 418 });
    if (request.method === 'POST') {
      const created = { ...body, id: `10000000000000000${existing.length}`, application_id: TARGET.applicationId, guild_id: TARGET.guildId };
      existing.push(created);
      return OutboundResponse.json(created, { status: 201 });
    }
    return OutboundResponse.json(existing);
  };
  return { existing, calls, respond };
}

test('guild setup uses the real workerd global fetch without following Discord redirects', async t => {
  // Read these two public JSON fields without introducing a JSONC dependency.
  // A missing or unparseable setting fails the test rather than using defaults.
  const configuration = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const compatibilityDate = configuration.match(/"compatibility_date"\s*:\s*"([^"]+)"/)?.[1];
  const flags = configuration.match(/"compatibility_flags"\s*:\s*(\[[^\]]*\])/)?.[1];
  assert.ok(compatibilityDate, 'wrangler.jsonc must declare compatibility_date');
  assert.ok(flags, 'wrangler.jsonc must declare compatibility_flags');
  const compatibilityFlags = JSON.parse(flags);
  assert.ok(Array.isArray(compatibilityFlags) && compatibilityFlags.every(flag => typeof flag === 'string'));
  // Bundle the production helper itself. The harness supplies only a synthetic
  // scope, fixed clock, and in-memory ledger, never a replacement fetch helper.
  const bundled = await build({
    stdin: {
      contents: `
        import { runGuildSetup, scopeFingerprint } from './src/guild-setup.ts';
        export default {
          async fetch(request, env) {
            if (new URL(request.url).pathname === '/redirect-error-control') {
              try {
                await fetch('https://discord.com/api/v10/applications/@me', {
                  redirect: 'error', headers: { authorization: 'Bot ' + env.DISCORD_BOT_TOKEN },
                });
                return Response.json({ completed: true });
              } catch (error) {
                return Response.json({ name: error.name, message: error.message });
              }
            }
            let claimed;
            const saves = [];
            const ledger = {
              async claim(receipt) {
                if (claimed) return { claimed: false, receipt: structuredClone(claimed) };
                claimed = structuredClone(receipt);
                return { claimed: true, receipt: structuredClone(claimed) };
              },
              async save(receipt) {
                claimed = structuredClone(receipt);
                saves.push(structuredClone(receipt));
              },
            };
            const receipt = await runGuildSetup(env, ledger, () => false, fetch,
              () => ${NOW}, scopeFingerprint(env));
            return Response.json({ receipt, saves });
          },
        };
      `,
      resolveDir: ROOT, sourcefile: 'workerd-guild-setup-harness.ts', loader: 'ts',
    },
    bundle: true, write: false, format: 'esm', platform: 'neutral', target: 'es2022', external: ['node:crypto'],
  });
  let network = discord();
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate, compatibilityFlags,
    bindings: BINDINGS,
    outboundService: (request: Request) => network.respond(request),
  }));
  try {
    await t.test('creates all six missing commands and verifies the final readback', async () => {
      network = discord();
      const response = await runtime.dispatchFetch('https://setup.test/run');
      assert.equal(response.status, 200);
      const { receipt, saves } = await response.json();
      assert.equal(network.calls.length, 2 * COMMANDS.length + 4, 'real workerd fetch must reach the intercepted target reads, command creates, and readback');
      assert.equal(receipt.state, 'complete');
      assert.equal(receipt.error, null);
      assert.deepEqual(receipt.verifiedNames, COMMANDS.map(command => command.name));
      assert.deepEqual(network.calls.filter(call => call.method === 'POST').map(call => call.body), [...COMMANDS]);
      assert.equal(network.calls.filter(call => new URL(call.url).pathname === COMMAND_PATH && call.method === 'GET').length, COMMANDS.length + 2);
      assert.equal(network.calls.at(-1)?.method, 'GET');
      assert.equal(network.calls.at(-1)?.url, `https://discord.com${COMMAND_PATH}?with_localizations=true`);
      assert.deepEqual(network.existing[0], UNRELATED);
      assert.equal(network.existing.length, COMMANDS.length + 1);
      assert.ok(network.calls.every(call => new URL(call.url).origin === 'https://discord.com' && call.authorization === `Bot ${TOKEN}`));
      assert.deepEqual(saves.filter((save: { attemptedName: string | null }) => save.attemptedName).map((save: { attemptedName: string }) => save.attemptedName), COMMANDS.map(command => command.name));
      assert.equal(saves.at(-1).state, 'complete');
      assert.equal(JSON.stringify({ receipt, saves }).includes(TOKEN), false);
    });

    for (const status of [301, 302, 303, 307, 308]) {
      for (const location of ['https://discord.com/redirected', 'https://redirect-target.invalid/steal-token']) {
        for (const method of ['GET', 'POST'] as const) {
          await t.test(`${status} during ${method} refuses a ${new URL(location).hostname} redirect`, async () => {
            network = discord({ status, location, method });
            const response = await runtime.dispatchFetch('https://setup.test/run');
            assert.equal(response.status, 200);
            const { receipt, saves } = await response.json();
            assert.equal(receipt.error, 'DISCORD_REDIRECT_REFUSED');
            assert.equal(receipt.state, method === 'POST' ? 'uncertain' : 'failed');
            assert.equal(receipt.attemptedName, method === 'POST' ? 'join' : null);
            assert.deepEqual(receipt.verifiedNames, []);
            assert.equal(network.calls.length, method === 'POST' ? 5 : 1);
            assert.equal(network.calls.filter(call => call.method === 'POST').length, method === 'POST' ? 1 : 0);
            assert.ok(network.calls.every(call => new URL(call.url).origin === 'https://discord.com' && call.authorization === `Bot ${TOKEN}`));
            assert.ok(network.calls.every(call => call.url !== location));
            assert.deepEqual(network.existing, [UNRELATED]);
            assert.equal(saves.at(-1).error, 'DISCORD_REDIRECT_REFUSED');
            assert.equal(JSON.stringify({ receipt, saves }).includes(TOKEN), false);
          });
        }
      }
    }

    await t.test('redirect:error raises the original workerd TypeError before any outbound request', async () => {
      network = discord();
      const response = await runtime.dispatchFetch('https://setup.test/redirect-error-control');
      assert.equal(response.status, 200);
      const error = await response.json();
      assert.equal(error.name, 'TypeError');
      assert.match(error.message, /Invalid redirect value/);
      assert.deepEqual(network.calls, []);
    });
  } finally {
    await runtime.dispose();
  }
});
