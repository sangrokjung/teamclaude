# Contributing

Thanks for taking a look. This is a small project with a small surface, so contributing is simple.

## Before you start

There are three hard constraints. A change that breaks any of them will not be merged, no matter how
good it otherwise is.

1. **Zero runtime dependencies.** Node built-in modules only. Nothing goes into `dependencies`.
   This is an advertised property of the project: the proxy handles your credentials, so the supply
   chain surface is kept at zero on purpose.
2. **ES modules, Node 18+.** The package is `"type": "module"`.
3. **ESLint globals are explicitly enumerated** in `eslint.config.js`. If you use a global that is not
   listed there (a timer, `crypto`, `TextEncoder`, …), add it to the `globals` map or `no-undef` fails.

## Running it

There is no build step.

```bash
node src/index.js <command>   # run any CLI command from source
npm test                      # node --test, tests live in test/
npx eslint .                  # lint
```

To exercise the proxy end to end, start `node src/index.js server` in one terminal and
`node src/index.js run` in another. Use `TEAMCLAUDE_CONFIG=./config.json` to keep a throwaway config
instead of touching `~/.config/teamclaude.json`.

## What makes a good PR

- **Tests.** Every behavior change needs a test. The suite is fast (under 10 seconds) and runs on
  Node's built-in runner, so there is no excuse to skip it.
- **Lint and tests green before you open the PR.** `npx eslint . && npm test`.
- **One concern per PR.** A rotation fix and a TUI tweak are two PRs.
- **Explain the failure mode.** "Fixes X" is less useful than "when account A is throttled mid-stream
  and B has no measured quota, the request used to hang because …".

## Things that need care

Some parts of this codebase look simple and are not. If you are touching one of these, say so in the
PR description so it gets a closer read.

- **Config synchronization.** Three writers touch the config file concurrently (the running server
  persisting refreshed tokens, the TUI, and external CLI invocations). Always re-read from disk before
  writing (`atomicConfigUpdate`), match accounts by `accountUuid` first and `name` second, and never
  overwrite a fresher token with a staler one.
- **`expiresAt` units.** OAuth endpoints return seconds, Claude Code credentials use milliseconds.
  Everything goes through `normalizeExpiresAt`. Assuming one unit has been a recurring bug.
- **`POST /v1/oauth/token` is relayed untouched.** The client manages its own token lifecycle. Do not
  intercept or rewrite it.
- **Internal names that look stale but are not.** The HTTP endpoint `/teamclaude/status` and the config
  filename `teamclaude.json` keep their original names even though the package is published as
  `teamcodex`. Renaming them breaks running servers and existing user configs.

## Reporting a bug

Include the command you ran, what you expected, what happened, and the output of `teamcodex status`
with account names redacted. Never paste tokens, refresh tokens, or the contents of your config file.

## Scope

This project routes **your own** accounts from **one machine**. Features that help several people share
a single subscription seat are out of scope and will be declined.
