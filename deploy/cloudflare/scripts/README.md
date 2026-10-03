The stopped-deployment helper prepares `.stopped.jsonc` beside `wrangler.jsonc`.
It does not deploy, use credentials, contact a service or build an image.

After installing the locked dependencies, generating types and checking TypeScript:

```sh
node scripts/prepare-stopped-deploy.cjs EXPECTED_TREE PUBLIC_KEY TTS_SHA256 APPLICATION_ID GUILD_ID TEXT_CHANNEL_ID OWNER_ID
```

To explicitly prepare both checked-in Dockerfiles as build inputs for the
eight-hour daily runtime, use the exact lowercase literal `build` instead of the
TTS digest:

```sh
node scripts/prepare-stopped-deploy.cjs EXPECTED_TREE PUBLIC_KEY build APPLICATION_ID GUILD_ID TEXT_CHANNEL_ID OWNER_ID
```

Only these two forms are accepted: a 64-character lowercase SHA-256 digest or
`build`. Tags, image paths and other spellings are rejected. Preparing either
config does not authorize an image build, deployment, capacity increase or paid
runtime operation. Those actions require separate approval.

The CI command must first require `WORKERS_CI_COMMIT_SHA` to equal the approved
commit. The helper requires that variable to equal local Git HEAD, checks the
explicit expected tree, and rejects changed or untracked source files. Set
`CLOUDFLARE_ACCOUNT_ID` to the approved existing account in either mode; digest
mode uses it to construct the pinned TTS registry image reference. All deployment
values are inputs, not repository defaults. The exact checked-in config hash is
also pinned; changing that config requires reviewing and updating the helper's
expected hash.

Both outputs keep capacities zero, voice disabled, empty deadlines and setup
fields. They enable the HTTP receiver and workers.dev while disabling previews.
They preserve resource names, types, DO bindings, migrations, required secret
names and other settings. Digest mode preserves trial usage, pinned scope and
the 30-minute session setting; only the Bot Dockerfile remains a build input,
and TTS uses the supplied immutable digest. Build mode retains both checked-in
Dockerfiles and their build contexts, sets daily usage and installed-guilds scope,
and explicitly sets idle timeout to 300 seconds and session length to 480 minutes.
The matching reviewed runtime enforces the 480-minute daily ledger limit and
owner-only commands; the helper does not define a separate daily-budget variable.
The checked-in Wrangler defaults remain stopped, trial and 30 minutes. The output
must not already exist. Do not commit the generated file.

Before the separate deploy step, repeat the approved CI SHA equality check and
run `node scripts/prepare-stopped-deploy.cjs --verify EXPECTED_TREE`. Then use
`wrangler deploy --config .stopped.jsonc --keep-vars` with the four fixed Discord
ID overrides. Wrangler inherits existing secrets; this helper never supplies
secret values. Remove the temporary config on exit.

A cap-zero deployment may still update control-plane state before a rollout
fails. Read back Worker version, original namespace associations, unchanged TTS
digest (digest mode) or the newly approved Bot and TTS digests (build mode), and
actual stopped instance states even after failure. Do not raise caps
or automatically retry. Time and spending limits require separate supervision.
