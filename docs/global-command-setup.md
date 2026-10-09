# Global command setup: reviewed preparation, disabled by default

This adds a private, one-shot helper for six global slash commands in **guild installs and guild interactions only**. It does not deploy anything, register commands merely by being present, open a new endpoint, add a Cron, start a Container, alter an existing guild command, enable voice runtime, enable user installs/DMs, or change command permissions.

The six names are `join`, `leave`, `stop`, `voice-status`, `say`, `model`. Their exact definitions are in `deploy/cloudflare/src/global-command-setup.ts`; `integration_types: [0]` and `contexts: [0]` are required on writes and readback. `/join` describes the invocation text channel. Existing guild registrations and the original guild setup code are unchanged. Guild definitions can shadow same-name global definitions in their guild; this helper deliberately does not delete them.

## Approval and integration gates

Production registration/configuration/deployment still requires explicit approval. A completed local test is not approval or evidence of live registration. This patch must be integrated with the separately reviewed installed-guild routing implementation before activation: owner-only control, invocation text-channel and current caller VC binding, and one paid voice session across all guilds. Registration does not implement or authorize those runtime changes itself.

Before either helper action, an operator must use the supported authenticated Cloudflare inspection API to independently verify **both actual Container application `max_instances` values are 0**, and verify runtime stopped. Keep the Bot disabled and voice deadline empty throughout. Record when the capacity check happened. The helper's two capacity fields are **operator attestations, not a platform observation**. A Worker cannot independently read platform caps and this code never receives a Cloudflare management credential. The helper checks actual Bot `ctx.container.running === false`; missing metadata fails closed. Its own code never probes or starts either Container.

The approved application and direct owner are pinned by a SHA-256 principal fingerprint. The retained receiver URL is separately fingerprint-pinned; the application public key is compared with the existing `DISCORD_PUBLIC_KEY` binding. Production IDs, key material and tokens are not in this patch. Keep the existing Bot token as an internal Worker secret binding. Never copy it into a shell, prompt, receipt, test fixture or settings plaintext.

## Normal inspection and registration

All new fields default to empty strings. Use the existing `*/5 * * * *` Cron, which invokes `DiscordBot.setupGlobalCommands()` on `discord-singleton`. There is no new HTTP setup path or schedule. A setup action is attempted only with explicitly stopped flags, and its private RPC also requires actual stopped runtime metadata. Successful completed setup returns without lifecycle calls. Any rejected/failed/pending/uncertain setup falls through to ordinary no-start lifetime housekeeping; stale setup flags cannot suppress cleanup. Any nonempty global setup flag skips the old guild-setup branch, so failure cannot accidentally run guild registration.

1. Deploy the reviewed integrated code with all helper fields empty and runtime still stopped/caps 0. Verify the deployed code identity, retained receiver and default-off state. Do not rebuild/start paid Container images merely for this helper.
2. After independently checking actual caps 0, arm **inspection only**:
   - `BOT_ENABLED = false`, `VOICE_DEADLINE = ""`
   - `DISCORD_HTTP_ENABLED = true`, retained `DISCORD_PUBLIC_KEY` and existing internal Bot-token binding
   - `CONFIRM_DISCORD_SETUP = ""`
   - `DISCORD_GLOBAL_SETUP_ACTION = inspect-global-commands-v1`
   - `DISCORD_GLOBAL_SETUP_OPERATION_ID =` a fresh UUIDv4
   - `DISCORD_GLOBAL_SETUP_DEADLINE =` an explicit UTC deadline in the next 10 minutes
   - `DISCORD_GLOBAL_SETUP_INSPECTION_ID = ""` (unused by inspection)
   - `DISCORD_GLOBAL_SETUP_BOT_CAP_ATTESTATION = 0`
   - `DISCORD_GLOBAL_SETUP_TTS_CAP_ATTESTATION = 0`
   - `DISCORD_GLOBAL_SETUP_CAPS_CHECKED_AT =` actual UTC timestamp of the independent caps read, at most 10 minutes old
3. Let the next existing Cron run. Read the safe receipt via the authenticated Durable Object SQL API from `voice_global_setup_receipts`. Require the matching operation/action, `state=complete`, all three identity checks true, no error, and the expected `observedNames` (the current approved baseline is empty). Inspect action only makes two GET requests and stores safe metadata. Clear its action/operation/deadline after the receipt; expiration and the durable claim independently prevent a replay.
4. Obtain explicit approval for the six global command registrations and verify no other command writer is active. Refresh the independent caps read. Only then arm **registration** with action `register-global-commands-v1`, a **different fresh UUIDv4**, a new deadline within 10 minutes, and `DISCORD_GLOBAL_SETUP_INSPECTION_ID` referencing that completed inspection. The inspection must be at most 10 minutes old when registration starts. Schedule both phases around the existing Cron; if the inspection becomes stale, run a new read-only inspection, never extend or reuse the old operation ID.
5. Registration durably claims before network I/O, verifies identity/receiver/key again, and requires the initial global command names to match the inspected state. It validates all global definitions before the first write and immediately rereads the entire list before every potential POST. Matching commands are retained. Missing commands are POSTed individually. Only HTTP 201 plus a matching returned command is accepted. HTTP 200 means Discord already upserted a competing command and is treated as uncertain. No retry, bulk PUT, PATCH or DELETE exists. Unknown globals, changed same-name commands, duplicate IDs/names, invalid fields or expanded contexts stop the operation without overwriting them.
6. Require a registration receipt with the expected action/UUID, `state=complete`, no error and exactly the six `verifiedNames`. Completion also requires a fresh application check and exact-six global readback. This does not promise client-side propagation or prove runtime voice connectivity. Verify actual caps remain 0 and runtime stopped, then clear all seven helper fields. Do not enable runtime as a side effect of this operation.

## Failure and concurrency

- There is no atomic create-if-absent endpoint in Discord: POST is an upsert. Exclusive command-writer ownership is an operational prerequisite, and the immediate reread only reduces the race window. Any HTTP 200 is permanently uncertain.
- A persisted `pending` or `uncertain` **registration** blocks every registration operation, including new UUIDs and object reconstruction. Any error after a POST attempt, even a later readback/persistence error after some HTTP 201 successes, is uncertain. No automatic retry/reset/delete/reconcile API exists. The ledger returns the prior unresolved receipt (including its prior operation ID) and inserts no row for the blocked new UUID. The receipt is never replaced by a later operation.
- A new GET-only inspection can help reconcile uncertain outcomes while preserving the write block. Any release/remediation of the block needs separately reviewed, explicitly approved work after reading live Discord state. Do not delete receipt rows, change UUIDs to bypass the block, blindly rerun POSTs or delete guild commands.
- One operation ID is one action. A repeated completed/failed operation returns its original receipt; changing action under an existing UUID is rejected.
- All HTTP requests use `redirect: manual`, enforce 200 GET/201 POST, stop on redirects/rate limits, cap response bodies at 64 KiB, and use a 5-second per-request / 25-second overall bound, also bounded by the operation deadline. No raw response body, credential, public key, application/user/command ID, URL, adapter error message or stack is stored/logged. Receipts contain only operation IDs, reviewed hashes, fixed status/checks, timestamps, known command names and parsed rate-limit timing.

## Manual recovery of the partial `/model` registration

`recover-global-model-v1` is a separate, one-shot private Cron/RPC action for original operation `38efc651-389a-4575-83aa-20a921c7a0cc` only. That operation must remain uncertain with `DISCORD_RATE_LIMITED`, attempted name `model`, and exactly the first five commands created and verified. Its receipt is preserved byte-for-byte, and the new receipt records its ID and SHA-256 snapshot fingerprint. The original pending/uncertain registration block is never released.

This action consumes one durable recovery claim for that original receipt, including on a pre-write failure. Repeated Cron, object reconstruction, or a new UUID returns the first recovery receipt without another request. It cannot be reset or rearmed through this helper. A new failure requires separate review; do not delete, edit, or replace either receipt.

For a reviewed Worker-only integration, preserve the deployed Bot and TTS image digests, existing Durable Object namespace associations, bindings, receiver, secrets and Cron. Upload only the Worker module changes. Keep `BOT_ENABLED=false`, `VOICE_DEADLINE=""`, both actual capacities zero, and all seven helper fields empty during upload. This source change needs no Container build, runtime start, new route, secret, grant, binding or migration.

After the Worker-only upload and stopped-state readback:

1. Independently read both actual capacities as zero and verify the Bot is stopped. Confirm exclusive command-writer ownership. Read the original receipt and any stored `notBefore` values; do not arm a helper before a known cooldown has expired.
2. Run a new `inspect-global-commands-v1` operation using the existing seven fields. Require completion, all identity/receiver/key checks, no writes/error, and exactly `join, leave, stop, voice-status, say` or those five plus `model`, with all definitions checked. The inspection must start after the original receipt and remain no more than ten minutes old throughout recovery. Clear the inspection activation fields after its receipt.
3. Obtain the separately reviewed explicit activation decision. Set `DISCORD_GLOBAL_SETUP_ACTION=recover-global-model-v1`, `DISCORD_GLOBAL_SETUP_OPERATION_ID` to a fresh UUIDv4, `DISCORD_GLOBAL_SETUP_INSPECTION_ID` to that fresh inspection, a deadline within ten minutes, both cap attestations to `0`, and `CAPS_CHECKED_AT` to the actual independent capacity-read timestamp. Use the existing Cron/private RPC. No new flag carries the original ID: it is pinned in the reviewed source.
4. Recovery rechecks application, owner, retained receiver/key and the complete command list. Only a missing `model` may receive one POST, accepted only as HTTP 201 with the exact definition. Six already matching commands complete with GETs only. A matching `model` appearing during the immediate pre-write read also completes read-only; missing/changing baseline commands or disappearance of an inspected `model` stops. HTTP 200, 429, malformed consumed rate-limit timing, lost responses or bad readback fail closed. There is no retry loop.
5. Read the recovery receipt. Require `state=complete`, no error, the original ID/fingerprint, exactly six verified names, and either `createdNames=["model"]` or an entirely read-only completion. Re-read original and inspection receipts to confirm preservation. Verify actual capacities/stopped state and unchanged image digests, then clear all seven helper fields regardless of outcome. Runtime activation and the remaining live trial are separate decisions.

Discord's [rate-limit documentation](https://docs.discord.com/developers/topics/rate-limits) says limits are dynamic and headers are optional. Successful responses without rate headers are accepted, and unknown/unused headers are ignored. Supplied retry/reset timing is parsed into safe numeric/ISO evidence, and exhausted-bucket/429 timing establishes the conservative latest `notBefore`. Every subsequent helper request checks known cooldowns across all durable receipts, including fresh operation UUIDs. One short cooldown may pace an unsent request within the existing deadline/25-second total budget while reserving five seconds for the next request. Timing is rechecked afterward; a second, extended, or oversized cooldown stops. This never retries a POST or a 429. A new 429 stops and retains available `Retry-After`, body `retry_after`, reset and reset-after timing; raw headers/bodies are discarded. Missing timing remains unknown and does not authorize an automatic retry. The original 2026-10-03 18:55 UTC failure discarded its body and headers, so its exact cooldown was **not measured**. Do not infer a quota or cooldown from elapsed time or the successful five-command GET inspection.

## Offline verification

Run the focused Node/SQLite suite, then the real-workerd Cron/private-RPC harness, and the complete existing Worker suite serially. These use synthetic identifiers/keys/tokens and intercepted outbound requests only. They do not log in, extract credentials, deploy, call real Discord APIs, start a Gateway/voice engine, or build/run Container images. The workerd harness uses the production Cron and RPC with a no-start Container test double; it does not claim live Cloudflare resource provisioning was tested.

- `node --test test/global-command-setup.test.ts`
- `node --test test/global-model-recovery.test.ts`
- `node --test test/workerd-global-command-setup.test.ts`
- `npm run types && npm run check`
- `node --test --test-concurrency=1 test/*.test.ts`

Official API references: [Discord application commands](https://docs.discord.com/developers/interactions/application-commands), [application identity](https://docs.discord.com/developers/resources/application), [Cloudflare Workers practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/).
