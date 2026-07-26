## What this changes

<!-- The failure mode or the capability, in one or two sentences. -->

## Why

<!-- What breaks without it, or what it makes possible. -->

## Checks

- [ ] `npx eslint .` is clean
- [ ] `npm test` passes
- [ ] No new runtime dependency
- [ ] Behavior change is covered by a test

## Touched anything sensitive?

Tick if this PR goes near one of these, so it gets a closer read.

- [ ] Config read/write path (three writers touch the config concurrently)
- [ ] Token refresh or `expiresAt` handling (seconds vs milliseconds)
- [ ] Account selection or quota parsing
- [ ] The `/v1/oauth/token` relay
- [ ] Internal names kept on purpose (`/teamclaude/status`, `teamclaude.json`)
