# Plan — 401 cascade guard

STATUS: APPROVED (owner directive 2026-09-05, "재발 방지하고 적대적 검증해")
Spec: `docs/specs/2026-09-05-auth-401-cascade-guard.md`

## Steps

1. **RED** — extend `test/server-401.test.js`:
   - all-accounts-401 → no account parked, client 401
   - cascade must not un-park an account already `error`/`refresh-failed`
   - cascade must restore the account parked earlier in the same request
   - keep the existing single-revoked-account test green
2. **GREEN** — `src/server.js`:
   - add `auth401: new Set()` to the request `ctx` (line ~1106)
   - add it to `excludeForSelect` (line ~1846) so a non-parked 401 account is
     not re-selected within the request
   - in the 401 handler (line ~2209): record the account, compute
     `cascade = ctx.auth401.size >= AUTH_401_CASCADE_THRESHOLD`, park only when
     `!cascade`, remember what was parked, and revert those parks (guarded) on
     the transition into cascade
3. **VERIFY** — targeted test → full `node --test` → `npx eslint src/ test/`
4. **REVIEW** — `adversarial-reviewer` (fresh context) + `codex-reviewer`
   (cross-model) in parallel; fix findings; re-run the suite
5. **SHIP** — commit, push, PR into `fork/master`, merge after review APPROVE +
   green tests + sync-docs gate

## Out of scope

- Cross-request 401 streak tracking (if 2+ accounts really are revoked, they are
  now parked one request at a time instead of all at once). Deliberate: keeps
  the change single-file and reversible. Revisit only if the daemon log shows
  repeated cascades on a stable fleet.
- Deployments that pin a frozen snapshot of this package rather than the repo
  checkout do not pick this up by merging alone; the snapshot has to be
  redeployed.
