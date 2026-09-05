#!/usr/bin/env node

delete process.env.TEAMCLAUDE_PROVIDER;
await import('./index.js');
