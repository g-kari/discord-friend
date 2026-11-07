# Repository guidance

## Project map

- `apps/voice/`: Node.js Discord Gateway/voice bot and private VOICEVOX HTTP adapter.
- `deploy/cloudflare/`: TypeScript Worker, Durable Objects, interaction verification, session and setup ledgers; `wrangler.jsonc` defines stopped defaults.
- `docs/shared-voice-cloudflare.md`: architecture, deployment gates, historical evidence and outstanding live validation. `docs/global-command-setup.md` describes the separate registration procedure.
- `src/bot-go/`: legacy Go experiment. Do not assume its STT, LLM or screen capture is part of the shared voice service.

## Working practices

- Inspect relevant implementation and tests before changing behavior. Keep documentation aligned with code and distinguish offline tests, historical trials, and current live state; never infer deployment or registration from source alone.
- Preserve authorization, signature verification, scope isolation, durable ledgers, deadlines, cleanup and fail-closed behavior. Do not log tokens, interaction bodies, speech text or private identifiers unnecessarily.
- The checked-in defaults disable the bot and HTTP ingress and set both container caps to zero. Deployments, enabling ingress or paid resources, Discord command registration and live trials require a separate explicit authorization. Do not delete or reset Durable Object data or bypass setup receipts to recover an uncertain operation.
- Do not commit secrets or real IDs. Use synthetic credentials and intercepted requests in tests. Never copy production credentials into prompts, logs or fixtures.
- Follow existing style, minimize unrelated changes, and report checks actually run and any limitations.

## Local checks

Use Node.js 24.19.0 (CI; `apps/voice` requires >=24.17.0). From each directory:

```sh
cd apps/voice
npm ci --ignore-scripts
npm test
npm run check
```

```sh
cd deploy/cloudflare
npm ci --ignore-scripts
npm run types
npm run check
npm test
```

Run relevant focused tests while iterating. `.github/workflows/shared-voice.yml` also builds and tests both images; these offline checks do not prove live Discord voice, Cloudflare provisioning or billing. For legacy Go changes, inspect `src/bot-go/go.mod` and run `go test ./...` there if dependencies are available.
