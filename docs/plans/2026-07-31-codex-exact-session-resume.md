# Codex exact-session resume implementation plan

## Tasks

1. [x] Add failing tests for explicit-ID resume, current-cmux-surface resume, and
   fail-closed behavior when no trustworthy binding exists.
   - Verifier: targeted `node --test test/codex-resume.test.js` fails for the
     missing command/behavior.
2. [x] Add a zero-dependency Codex session boundary that parses the public
   `cmux surface resume get --json` response.
   - Verifier: parser tests accept only a Codex UUID checkpoint.
3. [x] Route `teamcodex codex resume` through the existing Codex run launcher.
   - Verifier: fake Codex receives exactly one provider-configured
     `resume SESSION_ID` invocation.
4. [x] Document the incident, process-scoped provider behavior, exact recovery
   command, missing-binding fallback, and rollback.
   - Verifier: public help, English/Korean README, architecture notes, and the
     runbook agree on command syntax and fail-closed semantics.
5. [x] Run targeted tests, the complete test suite, ESLint, and a real cmux
   surface smoke test.
   - Verifier: all commands exit 0 and the surface binding contains the exact
     checkpoint plus TeamCodex provider override.
6. [ ] Run independent adversarial review, synchronize task documents, then
   commit, push, open a PR, wait for CI, and merge to `master`.
   - Verifier: reviewer PASS is bound to the reviewed commit; GitHub reports
     the PR merged and local `master` matches `origin/master`.

## Verification log

- Red: `node --test test/codex-resume.test.js` failed because `resume` was an
  unknown command.
- Targeted: `node --test test/codex-resume.test.js test/codex-run.test.js
  test/codex-session.test.js test/codex.test.js` passed 12/12 after the
  resume-argument ordering and cmux credential-boundary fixes.
- Full: `qgate.py run --slot heavy -- npm test` passed 413/413.
- Lint: `npx --yes eslint .` exited 0. (`npm run lint` could not locate a local
  ESLint binary; no dependency was added.)
- Package surface: `npm pack --dry-run --json` included
  `src/codex-session.js`.
- Manual cmux QA: a temporary surface supplied a synthetic checkpoint; the cmux
  wrapper captured `resume SESSION_ID` followed by
  `model_provider="teamcodex_proxy"`. A live agent-hook binding with that same
  ordering preserved the TeamCodex provider in its public restore command.
- Independent review at `75b7fb1` found that forwarded options could replace
  the provider and that the cmux lookup inherited direct Codex credentials.
  Both were fixed and locked by CLI/subprocess regression tests before the
  final review SHA.
- Housekeeping scan: `info`, 0 sensitive hits. Existing untracked `.omo/`
  remained untouched.
