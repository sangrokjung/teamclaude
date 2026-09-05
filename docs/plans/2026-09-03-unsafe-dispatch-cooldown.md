# Unsafe Dispatch Cooldown Plan

1. Capture current focused behavior and add failing regression tests.
2. Add the process-local account cooldown gate and bounded retry-after logic.
3. Mark only unsafe ambiguous dispatch failures; preserve local-limit and
   committed-midstream behavior.
4. Restore the missing launcher/helper sources from SHA-256-verified installed
   artifacts, then run focused tests, lint, pack, and manual CLI smoke checks.
