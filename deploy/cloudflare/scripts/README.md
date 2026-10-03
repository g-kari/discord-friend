The stopped-deployment helper prepares `.stopped.jsonc` beside `wrangler.jsonc`.
It does not deploy, use credentials, contact a service or build an image.

After installing the locked dependencies, generating types and checking TypeScript:

```sh
node scripts/prepare-stopped-deploy.cjs EXPECTED_TREE PUBLIC_KEY TTS_SHA256 APPLICATION_ID GUILD_ID TEXT_CHANNEL_ID OWNER_ID
```

The CI command must first require `WORKERS_CI_COMMIT_SHA` to equal the approved
commit. The helper requires that variable to equal local Git HEAD, checks the
explicit expected tree, and rejects changed or untracked source files. Set
`CLOUDFLARE_ACCOUNT_ID` to the approved existing account; it is used only to
construct the pinned TTS registry image reference. All deployment values are
inputs, not repository defaults. The exact checked-in config hash is also pinned;
changing that config requires reviewing and updating the helper's expected hash.

The output keeps both capacities zero, voice disabled, empty deadlines and setup
fields, trial usage and pinned scope. It enables the HTTP receiver and workers.dev
while disabling previews. It preserves resource names, types, DO bindings,
migrations, required secret names and other settings. Only the Bot Dockerfile
remains a build input; TTS uses the supplied immutable digest. The output must not
already exist. Do not commit the generated file.

Before the separate deploy step, repeat the approved CI SHA equality check and
run `node scripts/prepare-stopped-deploy.cjs --verify EXPECTED_TREE`. Then use
`wrangler deploy --config .stopped.jsonc --keep-vars` with the four fixed Discord
ID overrides. Wrangler inherits existing secrets; this helper never supplies
secret values. Remove the temporary config on exit.

A cap-zero deployment may still update control-plane state before a rollout
fails. Read back Worker version, original namespace associations, unchanged TTS
digest and actual stopped instance states even after failure. Do not raise caps
or automatically retry. Time and spending limits require separate supervision.
