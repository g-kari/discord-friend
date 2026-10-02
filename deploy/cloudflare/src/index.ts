import { Container, getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { runGuildSetup, SETUP_CONFIRMATION } from './guild-setup';
import { SqlSetupLedger, saveReadiness } from './setup-ledger';
import { inspectReadiness, runtimeActive } from './readiness';
export { ContainerProxy } from '@cloudflare/containers';

function trialActive(env: Env): boolean {
  const remaining = Date.parse(env.VOICE_DEADLINE) - Date.now();
  return remaining > 0 && remaining <= 30 * 60 * 1000;
}

export class Voicevox extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  envVars = { VOICE_DEADLINE: this.env.VOICE_DEADLINE };
}

export class DiscordBot extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';
  // Discord's voice WebSocket and UDP are originated by the container.
  // Actual cloud DAVE/UDP connectivity is an explicit launch gate, not a unit-test claim.
  enableInternet = true;
  envVars = {
    BOT_ENABLED: this.env.BOT_ENABLED,
    DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID,
    DISCORD_TEXT_CHANNEL_ID: this.env.DISCORD_TEXT_CHANNEL_ID,
    DISCORD_OWNER_ID: this.env.DISCORD_OWNER_ID,
    TTS_URL: 'http://tts.internal/v1/speech',
    VOICE_DEADLINE: this.env.VOICE_DEADLINE,
  };
  override async onActivityExpired(): Promise<void> {
    if (String(this.env.BOT_ENABLED) !== 'true' || !trialActive(this.env)) await this.stop();
    // An enabled Gateway client must stay awake even when its HTTP endpoint is idle.
    // Container runtime charges continue while it is awake.
  }
  async setupGuildCommands() {
    return runGuildSetup(this.env, new SqlSetupLedger(this.ctx.storage), () => this.ctx.container?.running ?? false);
  }
  async checkReadiness() {
    const snapshot = await inspectReadiness(this.env, request => this.fetch(request));
    saveReadiness(this.ctx.storage, snapshot);
    await this.ctx.storage.sync();
    return snapshot;
  }
}

async function speech(request: Request, env: Env): Promise<Response> {
  if (!trialActive(env)) return Response.json({ error: 'TRIAL_INACTIVE' }, { status: 503 });
  const url = new URL(request.url);
  if (request.method !== 'POST' || url.pathname !== '/v1/speech' || url.search) return new Response(null, { status: 404 });
  try {
    return await getContainer(env.VOICEVOX, 'shared-voicevox').fetch(request);
  } catch {
    return Response.json({ error: 'VOICE_SERVICE_UNAVAILABLE' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
}

DiscordBot.outboundByHost = {
  'tts.internal': (request, env) => speech(request, env),
};

// RSS backend will use this named service binding. Never put a service secret into browser JS.
export class VoiceApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> { return speech(request, this.env); }
}

export default {
  fetch(): Response { return new Response(null, { status: 404 }); },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // A private RPC performs setup without inherited Container fetch/start. The
    // RPC independently verifies all guards, including actual container.running.
    if (String(env.CONFIRM_DISCORD_SETUP) === SETUP_CONFIRMATION) {
      try {
        const receipt = await env.BOT.getByName('discord-singleton').setupGuildCommands();
        console.log(JSON.stringify({ event: 'discord_setup_result', receipt }));
      } catch { console.warn(JSON.stringify({ event: 'discord_setup_guard_rejected' })); }
      return;
    }
    if (!runtimeActive(env)) return;
    try {
      const snapshot = await env.BOT.getByName('discord-singleton').checkReadiness();
      console.log(JSON.stringify({ event: 'discord_gateway_readiness', snapshot }));
    } catch { console.warn(JSON.stringify({ event: 'discord_gateway_readiness_unavailable' })); }
  },
} satisfies ExportedHandler<Env>;
