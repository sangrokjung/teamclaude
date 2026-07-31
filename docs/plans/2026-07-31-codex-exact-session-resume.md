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
6. [x] Run independent adversarial review, fix every blocker, and synchronize
   the recovery documents before the merge gate.
   - Verifier: final reviewer PASS is bound to the exact merge-ready commit;
     merge and remote synchronization are recorded by Git rather than this
     pre-merge plan.

## Verification log

- Red: `node --test test/codex-resume.test.js` failed because `resume` was an
  unknown command.
- Targeted: `node --test test/codex-resume.test.js test/codex-run.test.js
  test/codex-session.test.js test/codex.test.js` passed 20/20 after the
  resume-argument ordering, common route guard, and cmux credential-boundary
  fixes.
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
  final review SHA. A later adversarial security pass found that `--remote`
  bypassed provider configuration entirely; route-changing options now fail
  closed before cmux or Codex launch. Re-review then found the same route
  reachable through `codex run -- resume`; the guard now runs at the common
  launcher boundary and rejects route configuration keys as well. Final
  adversarial passes then added quoted, dotted-child, and escaped TOML key
  variants to the same fail-closed boundary.
- Housekeeping scan: `info`, 0 sensitive hits. Existing untracked `.omo/`
  remained untouched.
