# Unsafe Dispatch Cooldown

## Problem

An unsafe request that times out or loses its upstream transport is returned to
the client without an internal replay, but its account remains selectable. A
client retry can therefore immediately send an ambiguous request through the
same failing route.

## Goal

Keep an account that fails after an unsafe dispatch out of new routing for five
seconds, then make it eligible again without persisting that temporary state.

## Non-goals

- Do not replay unsafe requests inside the proxy.
- Do not change quota persistence, completed-429 continuity, or replay-safe
  request behavior.
- Do not turn an already-committed midstream response into a new HTTP response.

## Requirements and acceptance criteria

1. `dispatchFailureCooldownUntil` is process-local and is excluded from quota
   snapshot export/import.
2. Active cooldown excludes an account from selection, recovery, dashboard
   usability, and retry-after selection; expiry restores normal eligibility.
3. Unsafe timeout, transient transport/body-read failure, and pre-header
   transactional SSE failure return a non-replayed error with `Retry-After: 5`
   and cool the dispatched account.
4. A subsequent client POST selects a healthy secondary account. If every
   account is cooling, the proxy returns a bounded 429 without upstream dispatch
   or model fallback.
5. Local response/buffer ceilings do not cool an account. GET/HEAD retain their
   existing replay-safe failover behavior and all paths release their slot.

## Verification

Focused `node --test` coverage exercises account selection/snapshot behavior,
unsafe timeout and transport failures, all-cooling fallback suppression, local
response limits, and the `teamclaude` launcher. Static syntax, ESLint, and npm
pack contents verify the deliverable surface.
