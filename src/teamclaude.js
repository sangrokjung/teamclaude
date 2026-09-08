#!/usr/bin/env node

// Anthropic-mode entry point. `src/index.js` picks its provider (and therefore
// its config file and default port) from TEAMCLAUDE_PROVIDER, so the two bins
// differ only in what that variable says when the process starts. Clearing it
// here means an inherited TEAMCLAUDE_PROVIDER=codex — from a parent shell, a
// launchd plist, or a `teamcodex run` child — cannot silently point the
// `teamclaude` command at the Codex pool and its config.
delete process.env.TEAMCLAUDE_PROVIDER;
await import('./index.js');
