import { Container, getContainer } from '@cloudflare/containers';
import { WorkerEntrypoint } from 'cloudflare:workers';
export { ContainerProxy } from '@cloudflare/containers';

export class Voicevox extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
}

export class DiscordBot extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';
  // Discord's voice WebSocket and UDP are originated by the container.
  // Actual cloud DAVE/UDP connectivity is an explicit launch gate, not a unit-test claim.
  enableInternet = true;
  envVars = {
    DISCORD_BOT_TOKEN: this.env.DISCORD_BOT_TOKEN,
    DISCORD_GUILD_ID: this.env.DISCORD_GUILD_ID,
    DISCORD_TEXT_CHANNEL_ID: this.env.DISCORD_TEXT_CHANNEL_ID,
    DISCORD_OWNER_ID: this.env.DISCORD_OWNER_ID,
    TTS_URL: 'http://tts.internal/v1/speech',
  };
  override async onActivityExpired(): Promise<void> {
    if (String(this.env.BOT_ENABLED) !== 'true') await this.stop();
    // An enabled Gateway client must stay awake even when its HTTP endpoint is idle.
    // Container runtime charges continue while it is awake.
  }
}

async function speech(request: Request, env: Env): Promise<Response> {
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
    if (String(env.BOT_ENABLED) !== 'true') return;
    if (!env.DISCORD_BOT_TOKEN || ![env.DISCORD_GUILD_ID, env.DISCORD_TEXT_CHANNEL_ID, env.DISCORD_OWNER_ID].every(id => /^\d{17,20}$/.test(id))) {
      console.error(JSON.stringify({ event: 'bot_configuration_missing' }));
      return;
    }
    const response = await getContainer(env.BOT, 'discord-singleton').fetch(new Request('http://bot.internal/health'));
    if (!response.ok) console.warn(JSON.stringify({ event: 'bot_not_ready' }));
    await response.body?.cancel();
  },
} satisfies ExportedHandler<Env>;
