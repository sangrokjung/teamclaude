#!/usr/bin/env node

import { fork, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { assertSafeProxyConfig, loadOrCreateConfig, loadConfig, atomicConfigUpdate, getConfigPath, getServerStatePath, writeServerState, readServerState, clearServerState, readQuotaCache, writeQuotaCacheSync, normalizeTokenRefreshIntervalMs } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { importCredentials, loginOAuth, fetchProfile, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import {
  assertSafeCodexArgs,
  buildCodexProxyArgs,
  codexCliNotFoundMessage,
  importCodexCredentials,
  loginCodexCredentials,
  parseCodexCredentialsJson,
  refreshCodexAccessToken,
  resolveCodexCliBin,
} from './codex.js';
import {
  currentCmuxCodexBaseline,
  currentCmuxCodexSessionId,
  isCodexSessionId,
} from './codex-session.js';
import {
  CODEX_INVOCATION_HEADER,
  CODEX_RECOVERY_CONSUME_PATH,
  CODEX_RECOVERY_SESSION_HEADER,
  codexRecoveryIdentity,
  isCodexInvocationId,
  isCodexResponsesPath,
} from './codex-recovery.js';
import { TUI, applyTuiAccountMutation } from './tui.js';
import { formatBytes } from './system-metrics.js';
import { SseFramer, sseErrorEvent, isEventStream } from './sse.js';
import { runClaudeWithRecovery } from './claude-recovery.js';
import { reauthenticateAccount } from './reauth.js';
import {
  applySubscriptionCancellation,
  cancellationEndsAt,
  clearSubscriptionCancellation,
  findSubscriptionTarget,
  normalizeSubscriptionCancellation,
  subscriptionSnapshot,
} from './subscription.js';
import {
  buildClaudeRecoveryEnv,
  hasClaudeRecoveryMarker,
  parseClaudeRecoveryAccount,
} from './claude-auth.js';
import {
  createCmuxSessionRescuer,
  defaultCmuxRescuePaths,
} from './cmux-session-rescue.js';
import {
  PROBE_BROKEN,
  createLoopStallMeter,
  healthProbeVerdict,
  unhealthyWorkerAction,
} from './worker-health.js';
import { installClaudeWrapper, uninstallClaudeWrapper } from './claude-wrapper.js';

const SUPERVISED_WORKER_ENV = 'TEAMCLAUDE_SUPERVISED_WORKER';
const SUPERVISOR_PID_ENV = 'TEAMCLAUDE_SUPERVISOR_PID';
const LIFECYCLE_ID_ENV = 'TEAMCLAUDE_LIFECYCLE_ID';
const DEPLOYMENT_DRAIN_PATH = '/teamclaude/deployment/drain';
const LIFECYCLE_ID_HEADER = 'x-teamcodex-lifecycle-id';
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 256 * 1024 * 1024;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MANAGED_CLAUDE_MODEL = 'claude-sonnet-5';
function runtimeSourceHash(entryPath) {
  const sourceDir = dirname(realpathSync(entryPath));
  const digest = createHash('sha256');
  const files = readdirSync(sourceDir).filter(name => name.endsWith('.js')).sort();
  for (const name of files) {
    digest.update(name);
    digest.update('\0');
    digest.update(readFileSync(join(sourceDir, name)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

const RUNTIME_SOURCE_HASH = runtimeSourceHash(process.argv[1]);
const RUNTIME_ENTRY_PATH = realpathSync(process.argv[1]);
const SUPERVISOR_HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

// Korean labels for WHY an account is parked as 'error' (status payload
// errorReason). Unknown/legacy reasons render as plain `error` with no tag.
// MUST stay above the top-level command dispatch below: `const` in the module
// scope is in its temporal dead zone until evaluation reaches this line, and
// the dispatch `await`s command functions mid-module — a declaration placed
// after it throws ReferenceError the moment statusCommand touches it.
const ERROR_REASON_LABELS = {
  'subscription-disabled': '조직의 Claude Code 접근 차단',
  'subscription-ended': '구독 종료',
  'auth-revoked': '인증무효 — 재로그인 필요',
  'refresh-failed': 'refresh 실패',
  'auth-rejected': '인증거부',
  'send-failed': '송신실패',
};

/**
 * Did the worker's listener actively fail, or did we merely run out of patience?
 * A refused/reset connection is something the listener DID; a timeout is only
 * the absence of an answer, which a stalled supervisor produces on its own.
 */
function probeFailureKind(err) {
  const code = err?.code;
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE'
      || code === 'ERR_SOCKET_CLOSED' || code === 'EHOSTUNREACH') {
    return PROBE_BROKEN;
  }
  return undefined;
}

function connectionHeaderNames(value) {
  return new Set(
    String(value || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean),
  );
}

function subscriptionDisplay(subscription) {
  if (!subscription || subscription.state === 'active') return null;
  if (subscription.state === 'ended') return '구독 종료';
  if (subscription.state === 'end-date-reached') return '종료일 경과 — 연결 상태 확인 중';
  if (!subscription.endsAt) return '해지 예정 — 종료일 미확인';
  const inclusive = new Date(Date.parse(subscription.endsAt) - 1);
  const date = `${inclusive.getFullYear()}-${String(inclusive.getMonth() + 1).padStart(2, '0')}-${String(inclusive.getDate()).padStart(2, '0')}`;
  return `해지 예정 — ${date}까지 사용`;
}

function publicRequestCapacity(config, accounts = config.accounts || []) {
  const defaultConcurrent = Number.isFinite(config.maxConcurrentPerAccount)
    ? Math.max(1, config.maxConcurrentPerAccount)
    : 3;
  const accountCapacity = accounts.reduce((sum, account) => {
    if (account.enabled === false) return sum;
    return sum + (Number.isFinite(account.maxConcurrent)
      ? Math.max(1, account.maxConcurrent)
      : defaultConcurrent);
  }, 0);
  const queueCapacity = Number.isFinite(config.overflowQueueMaxDepth)
    ? Math.max(0, config.overflowQueueMaxDepth)
    : 256;
  return accountCapacity + queueCapacity;
}

const args = process.argv.slice(2);
const cliProvider = args[0] === 'codex' ? 'codex' : 'anthropic';
if (cliProvider === 'codex') {
  args.shift();
  process.env.TEAMCLAUDE_PROVIDER = 'codex';
}
const command = args[0];

switch (command) {
  case 'server':
    await serverCommand();
    break;
  case 'stop':
    await stopCommand();
    process.exit(0);
    break;
  case 'restart':
    await restartCommand();
    break;
  case 'run':
    await runCommand();
    break;
  case 'resume':
    if (cliProvider !== 'codex') {
      console.error('Unknown command: resume\n');
      showHelp();
      process.exit(1);
    }
    await codexResumeCommand();
    break;
  case 'import':
    await importCommand();
    process.exit(0);
    break;
  case 'login':
    await loginCommand();
    process.exit(0);
    break;
  case 'reauth':
    await reauthenticateCommand();
    process.exit(0);
    break;
  case 'env':
    await envCommand();
    process.exit(0);
    break;
  case 'status':
    await statusCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'remove':
    await removeCommand();
    process.exit(0);
    break;
  case 'disable':
    await setEnabledCommand(false);
    process.exit(0);
    break;
  case 'enable':
    await setEnabledCommand(true);
    process.exit(0);
    break;
  case 'priority':
    await setPriorityCommand();
    process.exit(0);
    break;
  case 'subscription':
    await subscriptionCommand();
    process.exit(0);
    break;
  case 'api':
    await apiCommand();
    process.exit(0);
    break;
  case 'install-claude-wrapper':
    await installClaudeWrapperCommand();
    process.exit(0);
    break;
  case 'uninstall-claude-wrapper':
    await uninstallClaudeWrapperCommand();
    process.exit(0);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    // No command or unknown command → start server
    if (command && !command.startsWith('-')) {
      console.error(`Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
    }
    await serverCommand();
    break;
}

// ── server ──────────────────────────────────────────────────

async function serverCommand() {
  if (process.env[SUPERVISED_WORKER_ENV] === '1') {
    await proxyWorkerCommand();
    return;
  }
  await superviseServerCommand();
}

async function superviseServerCommand() {
  const config = await loadOrCreateConfig();
  assertSafeProxyConfig(config);
  const port = config?.proxy?.port;
  const proxyApiKey = config?.proxy?.apiKey;
  const existing = await findRunningServer(config);
  if (existing && existing.port === port) {
    console.error(`[TeamClaude] A server is already running on port ${port}${existing.pid ? ` (pid ${existing.pid})` : ''}.`);
    console.error('  See it:      teamcodex status');
    console.error('  Stop it:     teamcodex stop');
    console.error('  Restart it:  teamcodex restart');
    process.exitCode = 1;
    return;
  }

  let maxPublicRequests = publicRequestCapacity(config);
  const maxRequestBytes = Number.isFinite(config.maxRequestBytes) && config.maxRequestBytes > 0
    ? config.maxRequestBytes
    : 32 * 1024 * 1024;
  const maxBufferedRequestBytes = Number.isFinite(config.maxBufferedRequestBytes)
      && config.maxBufferedRequestBytes > 0
    ? config.maxBufferedRequestBytes
    : DEFAULT_MAX_BUFFERED_REQUEST_BYTES;
  const requestBodyTimeoutMs = Number.isFinite(config.requestBodyTimeoutMs)
      && config.requestBodyTimeoutMs > 0
    ? Math.max(1, Math.floor(config.requestBodyTimeoutMs))
    : 30_000;
  // Mirror of the worker's streamRecovery gate (see server.js): SSE relays are
  // framed to whole events so a worker crash mid-response can be converted into
  // a clean, client-retryable `overloaded_error` SSE event instead of a
  // destroyed client socket ("Connection closed mid-response" in Claude Code,
  // which does NOT auto-retry a raw connection loss).
  const streamRecovery = !isCodexMode(config) && config.streamRecovery !== false;
  const streamIdleTimeoutMs = Number.isFinite(config.streamIdleTimeoutMs)
      && config.streamIdleTimeoutMs > 0
    ? Math.floor(config.streamIdleTimeoutMs)
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const workerHealthIntervalMs = Number.isFinite(config.workerHealthIntervalMs)
    ? Math.max(50, config.workerHealthIntervalMs)
    : 5_000;
  // Measured on the live daemon (2026-08-07, host load1 25-35): the probe path
  // runs p50 8ms but p99 1.44s / max 1.64s. A 2s budget left no headroom, so
  // ordinary host contention convicted a healthy worker every few minutes.
  const workerHealthTimeoutMs = Number.isFinite(config.workerHealthTimeoutMs)
    ? Math.max(1, config.workerHealthTimeoutMs)
    : 5_000;
  const workerReadyTimeoutMs = Number.isFinite(config.workerReadyTimeoutMs)
      && config.workerReadyTimeoutMs > 0
    ? Math.max(1, Math.floor(config.workerReadyTimeoutMs))
    : 30_000;
  const workerHealthFailureThreshold = Number.isFinite(config.workerHealthFailureThreshold)
    ? Math.max(1, Math.floor(config.workerHealthFailureThreshold))
    : 3;
  // A worker whose event loop still answers IPC can drain its in-flight work on
  // SIGTERM; only a worker that ignores that grace gets SIGKILLed.
  const workerRecycleGraceMs = Number.isFinite(config.workerRecycleGraceMs)
    ? Math.max(0, Math.floor(config.workerRecycleGraceMs))
    : 5_000;
  const deploymentDrainLeaseMs = Number.isFinite(config.deploymentDrainLeaseMs)
    ? Math.max(100, Math.floor(config.deploymentDrainLeaseMs))
    : 15_000;
  // Deliberately NOT the HTTP budget: an IPC round trip on a live loop is
  // sub-millisecond, so a floor keeps a deliberately tiny health timeout from
  // making every worker look wedged.
  const workerPingTimeoutMs = Math.max(500, workerHealthTimeoutMs);
  const workerWaiters = new Set();
  const clientAgents = new WeakMap();
  const statePath = getServerStatePath();
  const lifecycleId = randomUUID();
  let worker = null;
  let workerReady = false;
  let workerPort = null;
  let hasBeenReady = false;
  let stopping = false;
  let deploymentDraining = false;
  let deploymentDrainTimer = null;
  let activePublicRequests = 0;
  let activeBufferedRequestBytes = 0;
  let restartCount = 0;
  let restartTimer = null;
  let stableTimer = null;
  let healthTimer = null;
  let healthInFlight = false;
  let healthFailures = 0;
  let recycleInFlight = false;
  let contentionNoticeAt = 0;
  let pingSeq = 0;
  const pongWaiters = new Map();
  // Watches OUR own event loop, the one that relays every SSE byte and holds
  // the probe's timeout timer. A probe that raced a stall of ours proves
  // nothing about the worker (see worker-health.js).
  const loopStall = createLoopStallMeter();
  let forceTimer = null;
  let sessionRescuer = null;
  const codexRecoveryReceipts = new Map();
  let finish;

  function storeCodexRecoveryReceipt(identity) {
    if (!identity) return;
    const now = Date.now();
    for (const [id, receipt] of codexRecoveryReceipts) {
      if (receipt.expiresAt <= now) codexRecoveryReceipts.delete(id);
    }
    if (codexRecoveryReceipts.size >= 1024) {
      codexRecoveryReceipts.delete(codexRecoveryReceipts.keys().next().value);
    }
    codexRecoveryReceipts.set(identity.invocationId, {
      sessionId: identity.sessionId,
      expiresAt: now + 30_000,
    });
  }

  function consumeCodexRecoveryReceipt(req, res, isLocal) {
    if (req.url !== CODEX_RECOVERY_CONSUME_PATH) return false;
    if (!isLocal || req.method !== 'POST') {
      rejectPublicRequest(req, res, isLocal ? 405 : 403, {
        'content-type': 'application/json',
      }, {
        error: { type: 'permission_error', message: 'Codex recovery receipts are local-only POST resources.' },
      });
      return true;
    }
    const invocationId = req.headers[CODEX_INVOCATION_HEADER];
    const receipt = isCodexInvocationId(invocationId)
      ? codexRecoveryReceipts.get(invocationId)
      : null;
    if (!receipt || receipt.expiresAt <= Date.now()) {
      if (receipt) codexRecoveryReceipts.delete(invocationId);
      rejectPublicRequest(req, res, 404, { 'content-type': 'application/json' }, {
        error: { type: 'not_found', message: 'No recoverable Codex failure was recorded for this invocation.' },
      });
      return true;
    }
    codexRecoveryReceipts.delete(invocationId);
    rejectPublicRequest(req, res, 200, { 'content-type': 'application/json' }, {
      sessionId: receipt.sessionId,
    });
    return true;
  }

  function rejectPublicRequest(req, res, statusCode, headers, payload) {
    req.pause();
    res.shouldKeepAlive = false;
    res.once('finish', () => req.destroy());
    res.writeHead(statusCode, { ...headers, connection: 'close' });
    res.end(JSON.stringify(payload));
  }

  function consumeDeploymentDrain(req, res, isLocal) {
    if (req.url !== DEPLOYMENT_DRAIN_PATH) return false;
    if (!isLocal
        || !proxyApiKey
        || req.headers['x-api-key'] !== proxyApiKey
        || req.headers[LIFECYCLE_ID_HEADER] !== lifecycleId) {
      rejectPublicRequest(req, res, 403, { 'content-type': 'application/json' }, {
        error: { type: 'permission_error', message: 'Deployment control requires the live local lifecycle identity.' },
      });
      return true;
    }
    if ((req.method !== 'POST' && req.method !== 'DELETE')
        || (req.headers['content-length'] != null && req.headers['content-length'] !== '0')
        || req.headers['transfer-encoding'] != null) {
      rejectPublicRequest(req, res, 405, { 'content-type': 'application/json' }, {
        error: { type: 'invalid_request_error', message: 'Deployment control accepts empty POST or DELETE requests.' },
      });
      return true;
    }
    clearTimeout(deploymentDrainTimer);
    deploymentDrainTimer = null;
    deploymentDraining = req.method === 'POST';
    if (deploymentDraining) {
      deploymentDrainTimer = setTimeout(() => {
        deploymentDraining = false;
        deploymentDrainTimer = null;
      }, deploymentDrainLeaseMs);
      deploymentDrainTimer.unref?.();
    }
    rejectPublicRequest(req, res, 200, { 'content-type': 'application/json' }, {
      draining: deploymentDraining,
      activeRequests: activePublicRequests,
    });
    return true;
  }

  const listener = http.createServer((req, res) => {
    const clientKey = req.headers['x-api-key'];
    const authorization = req.headers.authorization;
    const hasRecoveryMarker = hasClaudeRecoveryMarker(authorization);
    const recoveryAccountUuid = parseClaudeRecoveryAccount(authorization);
    const bearerKey = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : null;
    const remoteAddr = req.socket.remoteAddress;
    const isLocal = remoteAddr === '127.0.0.1'
      || remoteAddr === '::1'
      || remoteAddr === '::ffff:127.0.0.1';
    if (!isLocal) delete req.headers['x-teamcodex-status-identity'];
    if (consumeDeploymentDrain(req, res, isLocal)) return;
    if (consumeCodexRecoveryReceipt(req, res, isLocal)) return;
    if (hasRecoveryMarker && recoveryAccountUuid == null) {
      rejectPublicRequest(req, res, 403, { 'content-type': 'application/json' }, {
        type: 'error',
        error: { type: 'permission_error', message: 'Invalid Claude recovery routing marker.' },
      });
      return;
    }
    if (hasRecoveryMarker && !isLocal) {
      rejectPublicRequest(req, res, 403, { 'content-type': 'application/json' }, {
        type: 'error',
        error: { type: 'permission_error', message: 'Claude recovery routing is local-only.' },
      });
      return;
    }
    if (req.url === '/teamclaude/rotate' && !isLocal) {
      rejectPublicRequest(req, res, 403, { 'content-type': 'application/json' }, {
        type: 'error',
        error: { type: 'permission_error', message: 'Account rotation is local-only.' },
      });
      return;
    }
    // The worker only ever sees loopback (this supervisor forwards to it), so
    // the operator-only reset-credit route must be fenced HERE, like rotate.
    if (req.url.split('?', 1)[0] === '/teamclaude/codex/reset-credit' && !isLocal) {
      rejectPublicRequest(req, res, 403, { 'content-type': 'application/json' }, {
        type: 'error',
        error: { type: 'permission_error', message: 'Reset credit redemption is local-only.' },
      });
      return;
    }
    if (config.proxy?.apiKey && clientKey !== config.proxy.apiKey
      && bearerKey !== config.proxy.apiKey && !isLocal) {
      rejectPublicRequest(req, res, 401, { 'content-type': 'application/json' }, {
        type: 'error',
        error: { type: 'authentication_error', message: 'Invalid proxy API key' },
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/teamclaude/status') {
      res.setHeader('x-teamcodex-active-requests', String(activePublicRequests));
      res.setHeader('x-teamcodex-source-hash', RUNTIME_SOURCE_HASH);
      res.setHeader('x-teamcodex-deployment-draining', deploymentDraining ? '1' : '0');
    }
    const contentLength = req.headers['content-length'];
    const bypassAdmission = req.method === 'GET'
      && req.url === '/teamclaude/status'
      && (contentLength == null || contentLength === '0')
      && req.headers['transfer-encoding'] == null;
    if (deploymentDraining && !bypassAdmission) {
      rejectPublicRequest(
        req,
        res,
        503,
        { 'content-type': 'application/json', 'retry-after': '1' },
        { error: { type: 'overloaded_error', message: 'Proxy is draining for a verified deployment' } },
      );
      return;
    }
    if (!bypassAdmission && activePublicRequests >= maxPublicRequests) {
      rejectPublicRequest(
        req,
        res,
        429,
        { 'content-type': 'application/json', 'retry-after': '1' },
        { error: { type: 'overloaded_error', message: 'Proxy supervisor queue is full' } },
      );
      return;
    }
    if (!bypassAdmission) activePublicRequests += 1;
    let requestBufferedBytes = 0;
    let released = bypassAdmission;
    const reserveRequestBytes = bytes => {
      const bufferedBytes = bytes * 2;
      if (bufferedBytes > maxBufferedRequestBytes - activeBufferedRequestBytes) return false;
      activeBufferedRequestBytes += bufferedBytes;
      requestBufferedBytes += bufferedBytes;
      return true;
    };
    const release = () => {
      if (released) return;
      released = true;
      activePublicRequests -= 1;
      activeBufferedRequestBytes -= requestBufferedBytes;
      requestBufferedBytes = 0;
    };
    res.once('finish', release);
    res.once('close', release);
    handlePublicRequest(req, res, reserveRequestBytes).catch(err => {
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'proxy_error', message: err.message } }));
      } else if (!res.destroyed) {
        res.destroy(err);
      }
    });
  });
  // Only the process that actually claimed the state file may remove it. A start
  // that loses the port race (EADDRINUSE against an already-running server) exits
  // through this handler too, and deleting the LIVE server's state file there
  // would strip findRunningServer of its recorded-port leg — the very thing that
  // keeps a server discoverable after its config port was edited.
  let ownsStateFile = false;
  process.once('exit', () => {
    if (ownsStateFile) {
      try { unlinkSync(statePath); } catch {}
    }
    // `worker?.exitCode == null` is true when worker is null (undefined == null),
    // so the optional chain alone would send us into kill() on a null worker.
    if (worker && worker.exitCode == null) {
      try { worker.kill('SIGKILL'); } catch {}
    }
  });

  function bufferRequest(req, reserveRequestBytes) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      let timer = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('aborted', onAborted);
      };
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };
      const onData = chunk => {
        size += chunk.length;
        if (size > maxRequestBytes) {
          chunks.length = 0;
          req.pause();
          const err = new Error('Request body too large');
          err.statusCode = 413;
          err.closeConnection = true;
          settle(reject, err);
          return;
        }
        if (!reserveRequestBytes(chunk.length)) {
          chunks.length = 0;
          req.pause();
          const err = new Error('Proxy supervisor queue is full');
          err.statusCode = 429;
          err.errorType = 'overloaded_error';
          err.closeConnection = true;
          settle(reject, err);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => settle(resolve, Buffer.concat(chunks));
      const onError = err => settle(reject, err);
      const onAborted = () => settle(reject, new Error('Client disconnected'));
      const onTimeout = () => {
        chunks.length = 0;
        req.pause();
        const err = new Error('Request body timed out');
        err.statusCode = 408;
        err.closeConnection = true;
        settle(reject, err);
      };
      req.on('data', onData);
      req.once('end', onEnd);
      req.once('error', onError);
      req.once('aborted', onAborted);
      timer = setTimeout(onTimeout, requestBodyTimeoutMs);
      timer.unref();
    });
  }

  function waitForWorker(res) {
    if (workerReady && workerPort && worker) {
      return Promise.resolve({ worker, port: workerPort });
    }
    return new Promise(resolve => {
      let timer = null;
      const settle = target => {
        if (!workerWaiters.delete(waiter)) return;
        if (timer !== null) clearTimeout(timer);
        res.removeListener('close', onClose);
        resolve(target);
      };
      const onClose = () => settle(null);
      const waiter = { resolve: settle, res };
      workerWaiters.add(waiter);
      res.once('close', onClose);
      timer = setTimeout(() => settle(null), workerReadyTimeoutMs);
      timer.unref?.();
    });
  }

  function clientAgent(req) {
    let agent = clientAgents.get(req.socket);
    if (agent) return agent;
    agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    clientAgents.set(req.socket, agent);
    req.socket.once('close', () => agent.destroy());
    return agent;
  }

  function resetClientAgent(req) {
    const agent = clientAgents.get(req.socket);
    if (agent) agent.destroy();
    clientAgents.delete(req.socket);
  }

  function wakeWorkerWaiters() {
    const target = workerReady && workerPort && worker
      ? { worker, port: workerPort }
      : null;
    for (const waiter of workerWaiters) {
      waiter.resolve(target);
    }
  }

  function closePublicListener(force = false) {
    try { listener.close(); } catch {}
    workerReady = false;
    workerPort = null;
    wakeWorkerWaiters();
    if (force) listener.closeAllConnections?.();
  }

  async function handlePublicRequest(req, res, reserveRequestBytes) {
    let body;
    try {
      body = await bufferRequest(req, reserveRequestBytes);
    } catch (err) {
      if (!res.headersSent && !res.destroyed) {
        const headers = { 'content-type': 'application/json' };
        if (err.statusCode === 429) headers['retry-after'] = '1';
        if (err.closeConnection) {
          headers.connection = 'close';
          res.shouldKeepAlive = false;
          res.once('finish', () => req.destroy());
        }
        res.writeHead(err.statusCode || 400, headers);
        res.end(JSON.stringify({
          error: { type: err.errorType || 'invalid_request_error', message: err.message },
        }));
      }
      return;
    }
    await forwardToWorker(req, res, body, 0);
  }

  async function forwardToWorker(req, res, body, attempt) {
    const target = await waitForWorker(res);
    if (!target) {
      // Woken with no worker (shutdown cleared readiness, or the client left).
      // Never leave a live client hanging with no response — it would sit
      // through the whole shutdown grace period.
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Proxy is restarting; retry shortly.' },
        }));
      } else if (!res.destroyed) {
        res.destroy();
      }
      return;
    }
    if (res.destroyed) return;

    await new Promise(resolve => {
      let responseStarted = false;
      let settled = false;
      let clientGone = false; // the CLIENT aborted — any upstream error is self-inflicted
      let sseFramer = null; // set when relaying an SSE response with streamRecovery on
      let recoverySseTracker = null; // tracks Codex terminal events without changing raw relay bytes
      let streamIdleTimer = null;
      let drainCleanup = null;
      const replaySafe = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
      const recoveryIdentity = req.method === 'POST' && isCodexResponsesPath(req.url)
        ? codexRecoveryIdentity(req.headers, body)
        : null;
      let workerConnectionEstablished = false;
      const connectionHeaders = connectionHeaderNames(req.headers.connection);
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (SUPERVISOR_HOP_BY_HOP_HEADERS.has(lowerKey) || connectionHeaders.has(lowerKey)) continue;
        headers[key] = value;
      }
      headers.host = `127.0.0.1:${target.port}`;
      headers.connection = 'keep-alive';
      headers['content-length'] = String(body.length);
      const upstreamReq = http.request({
        host: '127.0.0.1',
        port: target.port,
        path: req.url,
        method: req.method,
        headers,
        agent: clientAgent(req),
      });

      const clearRelayTimers = () => {
        if (streamIdleTimer !== null) {
          clearTimeout(streamIdleTimer);
          streamIdleTimer = null;
        }
        drainCleanup?.();
      };

      const armStreamIdle = upstreamRes => {
        if (streamIdleTimer !== null) clearTimeout(streamIdleTimer);
        streamIdleTimer = setTimeout(() => {
          streamIdleTimer = null;
          const err = new Error(`Proxy worker SSE idle timeout after ${streamIdleTimeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          upstreamRes.destroy(err);
        }, streamIdleTimeoutMs);
        streamIdleTimer.unref?.();
      };

      const waitForPublicDrain = upstreamRes => {
        if (drainCleanup) return;
        if (streamIdleTimer !== null) {
          clearTimeout(streamIdleTimer);
          streamIdleTimer = null;
        }
        let timer = null;
        const cleanup = () => {
          res.removeListener('drain', onDrain);
          res.removeListener('close', onClose);
          if (timer !== null) clearTimeout(timer);
          if (drainCleanup === cleanup) drainCleanup = null;
        };
        const onDrain = () => {
          cleanup();
          armStreamIdle(upstreamRes);
          upstreamRes.resume();
        };
        const onClose = () => cleanup();
        drainCleanup = cleanup;
        res.once('drain', onDrain);
        res.once('close', onClose);
        timer = setTimeout(() => {
          cleanup();
          const err = new Error(`Public SSE drain timeout after ${streamIdleTimeoutMs}ms`);
          err.code = 'ETIMEDOUT';
          upstreamRes.destroy(err);
          if (!res.destroyed) res.destroy(err);
        }, streamIdleTimeoutMs);
        timer.unref?.();
      };

      const retryOrFail = err => {
        if (settled) return;
        clearRelayTimers();
        settled = true;
        if (!clientGone && responseStarted && recoveryIdentity
            && !recoverySseTracker?.sawTerminal) {
          storeCodexRecoveryReceipt(recoveryIdentity);
        }
        // The client went away: OUR close handler destroyed the upstream leg,
        // so this error is self-inflicted. The worker is healthy — recycling
        // it here would let one aborted terminal (a single Esc during the
        // seconds-long first-byte wait) SIGKILL the shared worker and cut
        // every other terminal's in-flight stream.
        if (clientGone || res.destroyed) {
          resolve();
          return;
        }
        if (responseStarted) {
          // The worker died mid-response. A framed SSE relay only ever forwarded
          // whole events, so the client's response can still be ENDED with a
          // well-formed retryable `overloaded_error` event — Claude Code retries
          // that by itself, where a destroyed socket fails the whole turn.
          // Non-SSE (or terminal already delivered / opt-out) keeps the honest
          // legacy destroy.
          if (sseFramer && !sseFramer.passthrough && !res.destroyed && !res.writableEnded) {
            console.error('[TeamClaude] Proxy worker died mid-stream; ending client response with a retryable error event.');
            res.end(sseFramer.sawTerminal
              ? undefined
              : sseErrorEvent('TeamClaude: proxy worker restarted mid-response; the response is incomplete — please retry.'));
          } else if (!res.destroyed) {
            // Non-SSE, opt-out, or framing degraded to passthrough (an
            // injection could land mid-event): the honest legacy destroy.
            res.destroy(err);
          }
          resolve();
          return;
        }
        if (target.worker === worker) {
          resetClientAgent(req);
          // One relay socket failed; that is evidence about this connection,
          // not the shared worker process. Its exit event or the independent
          // HTTP+IPC health path owns global replacement decisions.
          if (target.worker.exitCode != null || !target.worker.connected) {
            workerReady = false;
            workerPort = null;
          }
        }
        if (!stopping && !res.destroyed
            && (replaySafe || !workerConnectionEstablished)
            && attempt < 3) {
          // A rejection here (bad forwarded header, synchronous http.request
          // option error) must still settle the outer promise. Without the
          // rejection arm the awaiting frame never returns, the client hangs,
          // and the unhandled rejection takes down the supervisor that owns
          // the public port and every in-flight stream.
          forwardToWorker(req, res, body, attempt + 1).then(resolve, retryErr => {
            if (!res.headersSent && !res.destroyed) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                error: { type: 'proxy_error', message: retryErr?.message || 'Proxy worker unavailable' },
              }));
            } else if (!res.destroyed) {
              res.destroy(retryErr);
            }
            resolve();
          });
          return;
        }
        if (!res.headersSent && !res.destroyed) {
          if (workerConnectionEstablished) storeCodexRecoveryReceipt(recoveryIdentity);
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            error: {
              type: 'proxy_error',
              message: attempt > 0
                ? `Proxy worker died on ${attempt + 1} consecutive attempts; the request was replayed and still failed`
                : (!replaySafe && workerConnectionEstablished
                  ? 'Proxy worker failed after dispatch; request was not replayed'
                  : 'Proxy worker unavailable'),
            },
          }));
        }
        resolve();
      };

      upstreamReq.once('socket', socket => {
        if (!socket.connecting) {
          workerConnectionEstablished = true;
          return;
        }
        socket.once('connect', () => { workerConnectionEstablished = true; });
      });
      upstreamReq.once('response', upstreamRes => {
        responseStarted = true;
        if (res.destroyed) {
          upstreamRes.destroy();
          resolve();
          return;
        }
        const responseConnectionHeaders = connectionHeaderNames(upstreamRes.headers.connection);
        const responseHeaders = {};
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          const lowerKey = key.toLowerCase();
          if (lowerKey === CODEX_RECOVERY_SESSION_HEADER) {
            const invocationId = req.headers[CODEX_INVOCATION_HEADER];
            if (req.method === 'POST' && isCodexResponsesPath(req.url)
                && isCodexInvocationId(invocationId) && isCodexSessionId(value)) {
              storeCodexRecoveryReceipt({ invocationId, sessionId: value });
            }
            continue;
          }
          if (SUPERVISOR_HOP_BY_HOP_HEADERS.has(lowerKey)
              || responseConnectionHeaders.has(lowerKey)) continue;
          responseHeaders[key] = value;
        }
        res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
        if (isEventStream(upstreamRes.headers['content-type'])) {
          const encoded = String(upstreamRes.headers['content-encoding'] || '')
            .split(',')
            .some(encoding => encoding.trim() && encoding.trim().toLowerCase() !== 'identity');
          const framer = streamRecovery && !encoded ? new SseFramer() : null;
          sseFramer = framer;
          recoverySseTracker = recoveryIdentity && !encoded ? (framer || new SseFramer()) : null;
          armStreamIdle(upstreamRes);
          upstreamRes.on('data', chunk => {
            armStreamIdle(upstreamRes);
            if (recoverySseTracker && recoverySseTracker !== framer) {
              recoverySseTracker.push(chunk);
            }
            const bytes = framer ? framer.push(chunk) : chunk;
            // writableEnded guard: retryOrFail may have already ENDED this
            // response (graceful injection); a straggler chunk must not
            // write-after-end (uncaught ERR_STREAM_WRITE_AFTER_END).
            if (!bytes || bytes.length === 0 || res.destroyed || res.writableEnded) return;
            if (!res.write(bytes)) {
              upstreamRes.pause();
              waitForPublicDrain(upstreamRes);
            }
          });
          upstreamRes.once('end', () => {
            if (settled) return;
            clearRelayTimers();
            settled = true;
            if (recoveryIdentity && recoverySseTracker && !recoverySseTracker.sawTerminal) {
              storeCodexRecoveryReceipt(recoveryIdentity);
            }
            if (!res.destroyed && !res.writableEnded) {
              // Clean worker end. The worker's own recovery already injects on
              // truncation, so relay as-is; flush any un-framed tail (possible
              // only when the worker ran with recovery off) for byte fidelity.
              res.end(framer?.pending.length ? framer.pending : undefined);
            }
            resolve();
          });
        } else {
          upstreamRes.pipe(res);
          upstreamRes.once('end', () => {
            if (settled) return;
            settled = true;
            resolve();
          });
        }
        upstreamRes.once('error', retryOrFail);
        upstreamRes.once('aborted', () => retryOrFail(new Error('Proxy worker response aborted')));
      });
      upstreamReq.once('error', retryOrFail);
      res.once('close', () => {
        clearRelayTimers();
        if (!res.writableEnded) {
          clientGone = true; // must be set BEFORE the destroy surfaces as an 'error'
          upstreamReq.destroy();
        }
      });
      upstreamReq.end(body);
    });
  }

  function launchWorker() {
    if (stopping) return;
    workerReady = false;
    workerPort = null;
    const childEnv = {
      ...process.env,
      [SUPERVISED_WORKER_ENV]: '1',
      [SUPERVISOR_PID_ENV]: String(process.pid),
      [LIFECYCLE_ID_ENV]: lifecycleId,
    };
    const child = fork(process.argv[1], ['server'], {
      env: childEnv,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    worker = child;
    let becameReady = false;

    child.on('message', message => {
      if (message?.type === 'teamcodex:pong') {
        // Resolved even for a worker we have since replaced: pingWorker's own
        // waiter map is the authority, and a stale id simply has no waiter.
        pongWaiters.get(message.id)?.();
        return;
      }
      if (child !== worker) return;
      if (message?.type === 'teamcodex:shutdown') {
        requestShutdown({ workerWillExit: true });
        return;
      }
      if (message?.type === 'teamcodex:capacity'
          && Number.isFinite(message.maxPublicRequests)) {
        maxPublicRequests = Math.max(0, Math.floor(message.maxPublicRequests));
        return;
      }
      if (message?.type !== 'teamcodex:ready' || !message.internalPort) return;
      if (Number.isFinite(message.maxPublicRequests)) {
        maxPublicRequests = Math.max(0, Math.floor(message.maxPublicRequests));
      }
      becameReady = true;
      workerReady = true;
      workerPort = message.internalPort;
      hasBeenReady = true;
      healthFailures = 0;
      writeServerState({
        pid: process.pid,
        workerPid: child.pid,
        port,
        startedAt: new Date().toISOString(),
        config: getConfigPath(),
        lifecycle: {
          version: 1,
          id: lifecycleId,
          supervisor: readProcessIdentity(process.pid),
          worker: readProcessIdentity(child.pid),
        },
      }).then(() => { ownsStateFile = true; }, () => {});
      clearTimeout(stableTimer);
      stableTimer = setTimeout(() => { restartCount = 0; }, 5_000);
      stableTimer.unref?.();
      if (!sessionRescuer && !isCodexMode(config) && config.cmuxSessionRescue === true) {
        sessionRescuer = createCmuxSessionRescuer({
          enabled: true,
          ready: () => workerReady && !stopping,
          intervalMs: config.cmuxSessionRescueIntervalMs,
          ...defaultCmuxRescuePaths(),
          nodePath: process.execPath,
          scriptPath: process.argv[1],
          configPath: getConfigPath(),
        });
        sessionRescuer.start();
      }
      wakeWorkerWaiters();
    });

    child.once('error', err => {
      console.error(`[TeamClaude] Failed to start proxy worker: ${err.message}`);
    });

    child.once('exit', (code, signal) => {
      if (child === worker) {
        worker = null;
        workerReady = false;
        workerPort = null;
      }
      clearTimeout(stableTimer);
      if (stopping) {
        // Give in-flight SSE relays a beat to finish their graceful
        // mid-stream error injection (retryOrFail ends those responses off the
        // worker socket's error event), then force-close any lingering idle
        // keep-alive client connections — otherwise a gracefully ENDED (not
        // destroyed) response leaves its socket idling and holds the
        // supervisor's event loop open well past the shutdown grace period.
        // unref'd: if nothing lingers, the process exits without waiting.
        const lingerSweep = setTimeout(() => closePublicListener(true), 150);
        lingerSweep.unref?.();
        finish(0);
        return;
      }
      if (!hasBeenReady && !becameReady) {
        closePublicListener(true);
        finish(code ?? 1);
        return;
      }

      restartCount += 1;
      const backoffMs = Math.min(100 * (2 ** (restartCount - 1)), 2_000);
      console.error(
        `[TeamClaude] Proxy worker stopped (${signal || `exit ${code}`}); restarting in ${backoffMs}ms.`,
      );
      restartTimer = setTimeout(launchWorker, backoffMs);
    });
  }

  /**
   * IPC round trip to the worker. A pong proves the worker's event loop is
   * RUNNING, which an HTTP probe cannot distinguish from "the loop is fine but
   * the host is starved" — and it never touches the busy listener.
   */
  function pingWorker(child, timeoutMs) {
    return new Promise(resolve => {
      if (!child || child.exitCode != null || !child.connected) {
        resolve(false);
        return;
      }
      const id = ++pingSeq;
      let done = false;
      const settle = alive => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pongWaiters.delete(id);
        resolve(alive);
      };
      const timer = setTimeout(() => settle(false), timeoutMs);
      timer.unref?.();
      pongWaiters.set(id, () => settle(true));
      try {
        child.send({ type: 'teamcodex:ping', id }, err => {
          if (err) settle(false);
        });
      } catch {
        settle(false);
      }
    });
  }

  async function recycleUnhealthyWorker(checkedWorker, broken) {
    if (recycleInFlight || stopping || checkedWorker !== worker) return;
    recycleInFlight = true;
    try {
      const stallAtPing = loopStall.read();
      const ipcAlive = await pingWorker(checkedWorker, workerPingTimeoutMs);
      if (stopping || checkedWorker !== worker) return;
      const action = unhealthyWorkerAction({
        broken,
        ipcAlive,
        selfStallMs: loopStall.read() - stallAtPing,
        timeoutMs: workerPingTimeoutMs,
        tickMs: loopStall.tickMs,
      });
      if (action === 'keep') {
        // Killing here would destroy every in-flight turn to fix nothing: the
        // loop answers, and the replacement inherits the same starved host.
        if (Date.now() - contentionNoticeAt >= 60_000) {
          contentionNoticeAt = Date.now();
          console.error('[TeamClaude] Proxy worker death is uncorroborated under host contention; keeping it.');
        }
        return;
      }
      workerReady = false;
      workerPort = null;
      if (action === 'drain') {
        console.error(`[TeamClaude] Proxy worker listener is broken while its event loop runs; draining it (${workerRecycleGraceMs}ms grace).`);
        checkedWorker.kill('SIGTERM');
        const escalate = setTimeout(() => {
          if (checkedWorker.exitCode == null) checkedWorker.kill('SIGKILL');
        }, workerRecycleGraceMs);
        escalate.unref?.();
        return;
      }
      console.error(`[TeamClaude] Proxy worker failed ${workerHealthFailureThreshold} health checks and does not answer IPC; restarting it.`);
      if (checkedWorker.exitCode == null) checkedWorker.kill('SIGKILL');
    } finally {
      recycleInFlight = false;
    }
  }

  function checkWorkerHealth() {
    if (stopping || healthInFlight || recycleInFlight
        || !workerReady || !workerPort || !worker) return;
    const checkedWorker = worker;
    const checkedPort = workerPort;
    const stallAtStart = loopStall.read();
    healthInFlight = true;
    let settled = false;
    const finishCheck = (healthy, failure) => {
      if (settled) return;
      settled = true;
      healthInFlight = false;
      if (checkedWorker !== worker || stopping) return;
      const verdict = healthProbeVerdict({
        ok: healthy,
        failure,
        selfStallMs: loopStall.read() - stallAtStart,
        timeoutMs: workerHealthTimeoutMs,
        tickMs: loopStall.tickMs,
      });
      if (verdict === 'healthy') {
        healthFailures = 0;
        return;
      }
      // 'inconclusive': we were frozen ourselves. Neither a strike nor a reset —
      // the probe simply carries no information about the worker.
      if (verdict === 'inconclusive') return;
      if (verdict === 'broken') {
        healthFailures = 0;
        void recycleUnhealthyWorker(checkedWorker, true);
        return;
      }
      healthFailures += 1;
      if (healthFailures < workerHealthFailureThreshold) return;
      healthFailures = 0;
      void recycleUnhealthyWorker(checkedWorker, false);
    };
    const healthReq = http.get({
      host: '127.0.0.1',
      port: checkedPort,
      path: '/teamclaude/status',
      agent: false,
    }, healthRes => {
      healthRes.resume();
      // A non-200 answer is the listener actively saying something wrong; a
      // stalled supervisor cannot fabricate that, so it is never discounted.
      healthRes.once('end', () => finishCheck(
        healthRes.statusCode === 200,
        healthRes.statusCode === 200 ? undefined : PROBE_BROKEN,
      ));
      healthRes.once('error', () => finishCheck(false));
      healthRes.once('aborted', () => finishCheck(false));
    });
    healthReq.setTimeout(workerHealthTimeoutMs, () => {
      const err = new Error('Proxy worker health check timed out');
      err.code = 'ETIMEDOUT';
      healthReq.destroy(err);
    });
    healthReq.once('error', err => finishCheck(false, probeFailureKind(err)));
  }

  function requestShutdown({ workerWillExit = false } = {}) {
    if (stopping) return;
    stopping = true;
    workerReady = false;
    workerPort = null;
    clearTimeout(restartTimer);
    clearTimeout(stableTimer);
    clearInterval(healthTimer);
    clearTimeout(deploymentDrainTimer);
    sessionRescuer?.stop();
    closePublicListener();
    if (!worker) {
      finish(0);
      return;
    }
    if (!workerWillExit) worker.kill('SIGTERM');
    forceTimer = setTimeout(() => {
      if (worker) worker.kill('SIGKILL');
    }, 6_000);
    forceTimer.unref?.();
  }

  const exitCode = await new Promise(resolve => {
    finish = code => {
      clearTimeout(restartTimer);
      clearTimeout(stableTimer);
      clearInterval(healthTimer);
      clearTimeout(forceTimer);
      clearTimeout(deploymentDrainTimer);
      loopStall.stop();
      sessionRescuer?.stop();
      resolve(code);
    };
    // Drop the bind-time diagnosis once we own the port. Left attached, any
    // later server error (EMFILE, ENOBUFS under load) would be reported as
    // "port already in use" and exit the supervisor mid-stream.
    const onListenError = err => {
      handleServerListenError(err, port);
    };
    listener.once('error', onListenError);
    listener.listen(port, () => {
      listener.removeListener('error', onListenError);
      listener.on('error', err => {
        console.error(
          `[TeamClaude] Public listener runtime error${err.code ? ` (${err.code})` : ''}: ${err.message}`,
        );
      });
      launchWorker();
      healthTimer = setInterval(checkWorkerHealth, workerHealthIntervalMs);
      healthTimer.unref?.();
    });
    process.once('SIGINT', () => requestShutdown());
    process.once('SIGTERM', () => requestShutdown());
  });

  await clearServerState();
  process.exitCode = exitCode;
}

async function proxyWorkerCommand() {
  const config = await loadOrCreateConfig();
  config.lifecycleId = process.env[LIFECYCLE_ID_ENV] || null;
  // Normalize by the FULL codex-mode signal (subcommand OR inherited env, see
  // isCodexMode): createProxyServer keys on config.provider, and a supervised
  // worker only carries the env var.
  if (!config.provider && isCodexMode(config)) config.provider = 'codex';
  const codexMode = isCodexMode(config);

  // --log-to <dir>
  const logTo = argValue('--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error('No accounts configured.\n');
    console.error('Add an account first:');
    if (codexMode) {
      console.error('  teamcodex codex login      Isolated Codex OAuth login');
      console.error('  teamcodex codex import     Import the current Codex login');
    } else {
      console.error('  teamcodex import           Import from Claude Code');
      console.error('  teamcodex login            OAuth login via browser');
      console.error('  teamcodex login --api      Add an API key');
    }
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error('No valid accounts after initialization');
    process.exit(1);
  }

  const threshold = config.switchThreshold || 0.98;
  // An explicit numeric `reevalIntervalMs: 0` (or any number <= 0) disables the
  // 5-minute periodic account re-switching. Require a finite number so a
  // malformed value (false, "", "abc", null, ...) falls back to the default
  // rather than silently disabling switching.
  const reevalIntervalMs = Number.isFinite(config.reevalIntervalMs)
    ? config.reevalIntervalMs
    : 5 * 60 * 1000;
  // Default per-account concurrency cap (max simultaneous in-flight requests an
  // account handles before load spreads to the next account). A per-account
  // `maxConcurrent` overrides this. Must be a positive number, else default 3.
  const maxConcurrentDefault = Number.isFinite(config.maxConcurrentPerAccount) && config.maxConcurrentPerAccount >= 1
    ? config.maxConcurrentPerAccount
    : 3;
  // Hard cap on the overflow wait-queue (requests waiting for a free slot when
  // every account is at its cap). Bounds memory/FDs under a request flood.
  const overflowQueueMaxDepth = Number.isFinite(config.overflowQueueMaxDepth) && config.overflowQueueMaxDepth >= 0
    ? config.overflowQueueMaxDepth
    : 256;
  const accountManager = new AccountManager(accounts, threshold, reevalIntervalMs, maxConcurrentDefault, overflowQueueMaxDepth);

  // Restore the last run's quota snapshot so a restart doesn't blank the
  // dashboard (quota otherwise lives only in memory and is re-learned from
  // traffic). Stale-safe: the proxy takes no traffic while down, expired
  // windows are lazily swept, and a still-future throttle is re-applied.
  const quotaCache = await readQuotaCache();
  if (quotaCache?.accounts) {
    accountManager.importQuotaState(quotaCache.accounts);
    // Restore the active-account marker too (identity by name) so the sticky
    // primary — and its warm prompt cache — carries across the restart.
    const cur = quotaCache.currentAccount
      && accountManager.accounts.find(a => a.name === quotaCache.currentAccount);
    if (cur) accountManager.currentIndex = cur.index;
    console.log(`[TeamClaude] Restored quota snapshot for ${quotaCache.accounts.length} account(s)`);
  }
  const saveQuotaSnapshot = () => writeQuotaCacheSync({
    savedAt: new Date().toISOString(),
    currentAccount: accountManager.accounts[accountManager.currentIndex]?.name || null,
    accounts: accountManager.exportQuotaState(),
    // The committed warm-up probe template — persisting it lets forced
    // re-measure (TUI R) and warm-up probes work immediately after a restart,
    // before any traffic re-seeds a known-accepted request shape. (`server` is
    // initialized before this ever runs: the snapshot writers are registered
    // inside the listen callback.)
    probeTemplate: server.exportProbeTemplate?.() ?? null,
  });

  // Persist refreshed tokens back to config (re-read from disk to avoid clobbering
  // accounts added externally, e.g. by `teamcodex import` while server is running)
  accountManager.onTokenRefresh((idx, newTokens, previousTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    let conflict = false;
    return atomicConfigUpdate(diskConfig => {
      // Persist ONLY the refreshed account's tokens. We deliberately do NOT ingest
      // disk-only accounts here: that loop existed to keep the old INDEX-based
      // matching aligned, but matching is identity-based now (findConfigAccount),
      // so it's unnecessary — and re-adding every disk account would resurrect one
      // the TUI just deleted (whose save may not have committed yet). External
      // account discovery stays in syncAccountsFromDisk (TUI R / restart).
      // Match by UUID first, then by name — index may have shifted.
      const cfgIdx = findConfigAccount(diskConfig, account);
      if (cfgIdx >= 0) {
        const diskAccount = diskConfig.accounts[cfgIdx];
        // OAuth refresh tokens rotate. If another process already replaced the
        // credential we started from, this late refresh result is stale and must
        // not overwrite the newer disk state.
        if (!storedCredentialMatches(diskAccount, previousTokens)) {
          conflict = true;
          return;
        }
        applyOAuthTokens(diskAccount, newTokens);
      }
    }).then(diskConfig => {
      const diskIdx = findConfigAccount(diskConfig, account);
      if (diskIdx < 0) return;
      const diskAccount = diskConfig.accounts[diskIdx];

      // The just-serialized disk value is authoritative for both the long-lived
      // config copy and, on a CAS conflict, the live account manager.
      const memIdx = findConfigAccount(config, account);
      if (memIdx >= 0) applyOAuthTokens(config.accounts[memIdx], diskAccount);
      if (conflict && diskAccount.accessToken) {
        accountManager.updateAccountTokens(account, diskAccount, false);
        console.log(`[TeamClaude] Kept newer disk credential for account "${account.name}"`);
      }
    }).catch(err => console.error(`[TeamClaude] Failed to save refreshed token: ${err.message}`));
  });

  // Persist the subscription-lapse flag the moment the request path flips it
  // (a subscription 403 sets it; a later 2xx on the account clears it), so a
  // restart restores the lapsed state instead of showing the account active
  // until the next failure. Same discipline as onTokenRefresh: re-read disk
  // (atomicConfigUpdate), match by identity (findConfigAccount), then mirror
  // the result into the long-lived in-memory config copy so a later TUI save
  // cannot resurrect the pre-change value.
  accountManager.onAccountFlag((account, disabled) => atomicConfigUpdate(diskConfig => {
    const cfgIdx = findConfigAccount(diskConfig, account);
    if (cfgIdx < 0) return;
    if (disabled) diskConfig.accounts[cfgIdx].subscriptionDisabled = true;
    else delete diskConfig.accounts[cfgIdx].subscriptionDisabled;
  }).then(() => {
    const memIdx = findConfigAccount(config, account);
    if (memIdx < 0) return;
    if (disabled) config.accounts[memIdx].subscriptionDisabled = true;
    else delete config.accounts[memIdx].subscriptionDisabled;
  }).catch(err => {
    console.error(`[TeamClaude] Failed to persist subscription flag for "${account.name}": ${err.message}`);
    throw err;
  }));
  accountManager.onAccountMetadata((account, metadata) => atomicConfigUpdate(diskConfig => {
    const cfgIdx = findConfigAccount(diskConfig, account);
    if (cfgIdx < 0) return;
    if (metadata) diskConfig.accounts[cfgIdx].subscriptionCancellation = metadata;
    else delete diskConfig.accounts[cfgIdx].subscriptionCancellation;
  }).then(() => {
    const memIdx = findConfigAccount(config, account);
    if (memIdx < 0) return;
    if (metadata) config.accounts[memIdx].subscriptionCancellation = metadata;
    else delete config.accounts[memIdx].subscriptionCancellation;
  }).catch(err => {
    console.error(`[TeamClaude] Failed to persist subscription metadata for "${account.name}": ${err.message}`);
    throw err;
  }));
  const port = config.proxy.port;
  const useTUI = process.stdout.isTTY && process.stdin.isTTY;

  let tui = null;
  let hooks = {};

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: (snapshot, mutation) => atomicConfigUpdate(diskConfig => {
        applyTuiAccountMutation(diskConfig, snapshot, accountManager, mutation);
      }),
      syncAccounts: async () => {
        const diskConfig = await accountManager.readAfterAccountFlagWrites(() => loadConfig());
        if (!diskConfig) return 0;
        return syncAccountsFromDisk(diskConfig, config, accountManager);
      },
      // R also forces a fleet-wide quota re-measure. `server` is assigned below
      // (before listen), and the TUI only starts inside the listen callback, so
      // this closure never runs before the binding is initialized.
      refreshQuota: () => server.refreshQuotaAll(),
      reauthenticate: async account => {
        if (account.provider === 'codex' || config.provider === 'codex') {
          const credentials = await loginCodexCredentials();
          return {
            credentials,
            profile: {
              accountUuid: credentials.accountUuid || credentials.accountId,
              email: credentials.email,
            },
          };
        }
        const credentials = await loginOAuth();
        const profile = await fetchProfile(credentials.accessToken);
        return { credentials, profile };
      },
      onQuit: () => {
        const closeWorker = () => server.close(() => process.exit(0));
        if (!process.connected) {
          closeWorker();
          return;
        }
        try {
          process.send({ type: 'teamcodex:shutdown' }, closeWorker);
        } catch {
          closeWorker();
        }
      },
    });
    hooks = {
      onRequestStart: (id, info) => tui.onRequestStart(id, info),
      onRequestRouted: (id, info) => tui.onRequestRouted(id, info),
      onRequestEnd: (id, info) => tui.onRequestEnd(id, info),
    };
  }

  // Existing configs predate continuityMode; treat it as enabled unless the
  // operator explicitly opts out.
  config.continuityMode = config.continuityMode !== false;
  // Reset-credit ledger writes (pending intent before the consume POST and
  // the outcome right after) are persisted immediately: the periodic snapshot
  // is 60 s apart and the exit handler never runs on SIGKILL, so without this
  // a crash right after the backend consumed a credit would forget the
  // cooldown and let a restart redeem the same account again.
  hooks.onResetCreditLedger = () => {
    try {
      saveQuotaSnapshot();
    } catch (err) {
      console.error(`[TeamCodex] Reset credit ledger snapshot failed: ${err.message}`);
    }
  };
  const server = createProxyServer(accountManager, config, hooks);
  let liveSyncChain = Promise.resolve();
  process.on('SIGHUP', () => {
    // Account-only reload: keep the worker, sockets, affinity map, prompt caches,
    // and every in-flight response alive. Serializing signals avoids overlapping
    // remove/add passes when several CLI changes land together.
    liveSyncChain = liveSyncChain.then(async () => {
      const diskConfig = await accountManager.readAfterAccountFlagWrites(() => loadConfig());
      if (!diskConfig) return;
      await syncAccountsFromDisk(diskConfig, config, accountManager);
      if (codexMode) await server.refreshQuotaAll();
      if (process.connected) {
        process.send({
          type: 'teamcodex:capacity',
          maxPublicRequests: publicRequestCapacity(config, accountManager.accounts),
        });
      }
      console.log('[TeamClaude] Applied account config without restarting the worker');
    }).catch(err => {
      console.error(`[TeamClaude] Account config reload failed: ${err.message}`);
    });
  });
  // Restore the last run's committed probe template alongside the quota
  // snapshot, so forced re-measure (TUI R) and warm-up probes work on a
  // freshly restarted idle proxy — without this the template is memory-only
  // and R reports "no request has flowed" until real traffic re-seeds it.
  if (quotaCache?.probeTemplate && server.importProbeTemplate?.(quotaCache.probeTemplate)) {
    console.log('[TeamClaude] Restored warm-up probe template');
  }
  // Catch bind-time errors (e.g. EADDRINUSE) only. Once the socket is bound we
  // remove this handler so a later runtime 'error' isn't misreported as a
  // listen failure and exit the whole proxy.
  const onListenError = err => handleServerListenError(err, port);
  server.once('error', onListenError);

  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', onListenError);
    const address = server.address();
    if (process.connected && typeof address === 'object') {
      process.send({
        type: 'teamcodex:ready',
        port,
        internalPort: address.port,
        maxPublicRequests: publicRequestCapacity(config, accountManager.accounts),
      });
    }
    // Persist the quota snapshot on every exit path (TUI quit, SIGINT/SIGTERM
    // → server.close → process.exit) and every minute as a crash backstop
    // (a SIGKILL loses at most the last interval). The 'exit' write is sync.
    process.on('exit', saveQuotaSnapshot);
    setInterval(saveQuotaSnapshot, 60_000).unref();
    // Keep idle OAuth refresh chains rotating and retry refresh-caused errors.
    // A numeric 0 disables the sweep; malformed values use the 5-minute default.
    const tokenRefreshIntervalMs = normalizeTokenRefreshIntervalMs(config.tokenRefreshIntervalMs);
    if (tokenRefreshIntervalMs > 0) {
      setImmediate(() => accountManager.refreshLapsedTokens());
      setInterval(() => accountManager.refreshLapsedTokens(), tokenRefreshIntervalMs).unref();
    }
    if (tui) {
      tui.start();
      console.log(`Listening on port ${port} with ${accounts.length} account(s)`);
      console.log(`[TeamClaude] Continuity mode: ${config.continuityMode ? 'on' : 'OFF — fleet-wide exhaustion surfaces 429s to clients'}`);
    } else {
      const sep = '='.repeat(60);
      console.log('');
      console.log(sep);
      console.log(codexMode ? '  TeamCodex Proxy' : '  TeamClaude Proxy');
      console.log(sep);
      console.log(`  Port:       ${port}`);
      console.log(`  Accounts:   ${accounts.length}`);
      console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
      console.log(`  Continuity: ${config.continuityMode ? 'on' : 'OFF — fleet-wide exhaustion surfaces 429s to clients'}`);
      console.log(`  Upstream:   ${config.upstream || (codexMode ? 'https://chatgpt.com/backend-api/codex' : 'https://api.anthropic.com')}`);
      console.log('');
      accounts.forEach((a, i) => {
        console.log(`  [${i + 1}] ${a.name} (${a.type})`);
      });
      console.log('');
      console.log(codexMode
        ? '  Run Codex through proxy:   teamcodex codex run'
        : '  Run Claude through proxy:  teamcodex run');
      console.log(codexMode
        ? '  Show env vars:             teamcodex codex env'
        : '  Show env vars:             teamcodex env');
      console.log(sep);
      console.log('');
    }
  });

  if (!tui) {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log('\n[TeamClaude] Shutting down...');
      const forceExit = setTimeout(() => {
        console.error('[TeamClaude] Graceful shutdown timed out; forcing exit.');
        server.closeAllConnections?.();
        process.exit(0);
      }, 5_000);
      server.close(() => {
        clearTimeout(forceExit);
        process.exit(0);
      });
      server.closeIdleConnections?.();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }
  // Liveness corroboration for the supervisor. Answering proves this worker's
  // event loop is running, which its HTTP probe cannot tell apart from a
  // starved host — and it costs no listener, no request path, no allocation.
  process.on('message', message => {
    if (message?.type !== 'teamcodex:ping' || !process.connected) return;
    try {
      process.send({ type: 'teamcodex:pong', id: message.id });
    } catch { /* the channel closed mid-answer; the supervisor times out */ }
  });
  process.once('disconnect', () => process.kill(process.pid, 'SIGTERM'));
}

// ── server lifecycle: discover / stop / restart ─────────────

// Function declaration (not a const arrow) so it is hoisted — these helpers run
// from the top-level command switch, which executes before later `const` lines
// in this module are initialized (temporal dead zone).
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Is a pid alive? EPERM = alive but not ours; ESRCH = gone. */
function isPidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  try {
    const result = spawnSync(
      'ps',
      ['-o', 'ppid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
      { encoding: 'utf8' },
    );
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    const line = result.stdout.trim();
    const match = line.match(/^(\d+)\s+(.{24})\s+([\s\S]+)$/);
    if (!match) return null;
    return {
      pid,
      ppid: Number(match[1]),
      startedAt: match[2].trim(),
      command: match[3].trim(),
    };
  } catch {
    return null;
  }
}

function sameProcessIdentity(recorded, current) {
  return Boolean(recorded && current
    && recorded.pid === current.pid
    && recorded.ppid === current.ppid
    && recorded.startedAt === current.startedAt
    && recorded.command === current.command);
}

function commandReferencesRuntime(command) {
  if (typeof command !== 'string') return false;
  return command.split(/\s+/).some(token => {
    const candidate = token.replace(/^['"]|['"]$/g, '');
    try { return realpathSync(candidate) === RUNTIME_ENTRY_PATH; }
    catch { return candidate === process.argv[1] || candidate === RUNTIME_ENTRY_PATH; }
  });
}

function isExpectedServerIdentity(identity, { worker = false, supervisorPid = null } = {}) {
  if (!identity || typeof identity.command !== 'string') return false;
  if (!commandReferencesRuntime(identity.command) || !identity.command.includes('server')) return false;
  if (worker) {
    return identity.ppid === supervisorPid
      && commandReferencesRuntime(identity.command);
  }
  return identity.ppid > 0;
}

function verifyLifecycleState(state, ownerPid, port) {
  if (!state?.lifecycle || state.lifecycle.version !== 1
      || typeof state.lifecycle.id !== 'string' || state.lifecycle.id.length < 16) {
    return { ok: false, reason: 'unverified-lifecycle' };
  }
  if (state.pid !== ownerPid || state.port !== port || state.config !== getConfigPath()) {
    return { ok: false, reason: 'unverified-lifecycle' };
  }
  const supervisor = readProcessIdentity(state.pid);
  if (!sameProcessIdentity(state.lifecycle.supervisor, supervisor)
      || !isExpectedServerIdentity(supervisor)) {
    return { ok: false, reason: 'unverified-lifecycle' };
  }
  return { ok: true, supervisor };
}

function verifyWorkerIdentity(state, supervisor) {
  const worker = readProcessIdentity(state?.workerPid);
  return sameProcessIdentity(state?.lifecycle?.worker, worker)
    && isExpectedServerIdentity(worker, { worker: true, supervisorPid: supervisor.pid });
}

async function waitForExit(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sameProcessIdentity(identity, readProcessIdentity(identity.pid))) return true;
    await delay(150);
  }
  return !sameProcessIdentity(identity, readProcessIdentity(identity.pid));
}

/**
 * Does a *TeamClaude* proxy answer on this port? Verifies the status endpoint
 * returns our JSON shape, not just any 200 — so a foreign process occupying the
 * port is NOT mistaken for our server (it falls through to the EADDRINUSE path).
 */
async function probeServer(
  port,
  timeoutMs = 1500,
  expectedLifecycleId = null,
  proxyApiKey = null,
) {
  if (!port) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = expectedLifecycleId != null && proxyApiKey
      ? {
          'x-api-key': proxyApiKey,
          'x-teamcodex-status-identity': '1',
        }
      : undefined;
    const res = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const data = await res.json();
    const validShape = Array.isArray(data?.accounts) && typeof data?.switchThreshold === 'number';
    if (!validShape) return false;
    if (expectedLifecycleId != null && data.lifecycleId !== expectedLifecycleId) return false;
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

function configuredStatusProbeTimeoutMs(fallbackMs = 1500) {
  const configured = Number(process.env.TEAMCLAUDE_STATUS_PROBE_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return fallbackMs;
  return Math.min(30_000, Math.max(250, Math.floor(configured)));
}

/** Best-effort: the pid listening on a TCP port (macOS/Linux via lsof). */
function lsofPid(port) {
  if (process.platform === 'win32') return null;
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pid = parseInt((r.stdout || '').trim().split('\n')[0], 10);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}

/**
 * Locate a running TeamClaude server for this config's port, returning the pid
 * that ACTUALLY owns the listening socket — never a pid taken on faith from the
 * state file. That matters because a state file can be stale (the recorded pid
 * died and the OS recycled it for an unrelated process) or hand-written; trusting
 * it would let `stop` signal the wrong pid. So: confirm a TeamClaude-shaped server
 * answers on the port, then resolve the owner via `lsof`. The state file is only a
 * fallback for the pid when lsof can't determine it (and only if it's alive and
 * for this same port). Returns { pid, port } (pid may be null if undeterminable),
 * or null when nothing is listening.
 */
async function findRunningServer(
  config,
  maxProbeWaitMs = configuredStatusProbeTimeoutMs(),
) {
  const configPort = config?.proxy?.port;
  const state = await readServerState();
  const probeDeadline = Date.now() + (Number.isFinite(maxProbeWaitMs)
    ? Math.max(0, Math.floor(maxProbeWaitMs))
    : 1500);

  // Try the port the server ACTUALLY bound (recorded in the state file) first —
  // it may differ from the current config port after the config was edited, and
  // probing only the config port would miss (and then orphan) the live server.
  const candidates = [];
  if (state?.port) candidates.push(state.port);
  if (configPort && configPort !== state?.port) candidates.push(configPort);

  for (const port of candidates) {
    const remainingMs = probeDeadline - Date.now();
    if (remainingMs <= 0) break;
    if (!(await probeServer(
      port,
      Math.min(configuredStatusProbeTimeoutMs(), remainingMs),
    ))) continue;
    const lsofOwnerPid = lsofPid(port);
    const ownerPid = lsofOwnerPid || (
      state?.port === port && state.pid && isPidAlive(state.pid) ? state.pid : null
    );
    if (!ownerPid) return { pid: null, port, lifecycleVerified: false, reason: 'no-pid' };
    const verified = verifyLifecycleState(state, ownerPid, port);
    const lifecycleRemainingMs = probeDeadline - Date.now();
    const lifecycleMatches = verified.ok && lifecycleRemainingMs > 0
      && await probeServer(
        port,
        Math.min(configuredStatusProbeTimeoutMs(), lifecycleRemainingMs),
        state.lifecycle.id,
        config?.proxy?.apiKey,
      );
    return {
      pid: ownerPid,
      port,
      lifecycleVerified: lifecycleMatches,
      identity: lifecycleMatches ? verified.supervisor : null,
      reason: lifecycleMatches ? null : 'unverified-lifecycle',
    };
  }

  // Nothing TeamClaude-shaped answers on any candidate port. Only drop the state
  // file if its recorded pid is also gone — don't delete the discovery record for
  // a server that's merely unreachable for a moment.
  if (state && !(state.pid && isPidAlive(state.pid))) await clearServerState();
  return null;
}

async function ensureProxyRunning(config, maxWaitMs = 15_000) {
  const running = await findRunningServer(config);
  if (running) return running;

  console.error('[TeamClaude] Proxy is not running; starting it automatically.');
  const daemonEnv = { ...process.env };
  delete daemonEnv[SUPERVISED_WORKER_ENV];
  delete daemonEnv[SUPERVISOR_PID_ENV];
  let launchError = null;
  const daemon = spawn(process.execPath, [process.argv[1], 'server'], {
    detached: true,
    env: daemonEnv,
    stdio: 'ignore',
  });
  daemon.once('error', err => { launchError = err; });
  daemon.unref();

  const boundedWaitMs = Number.isFinite(maxWaitMs)
    ? Math.max(0, Math.floor(maxWaitMs))
    : 15_000;
  const deadline = Date.now() + boundedWaitMs;
  while (Date.now() < deadline) {
    if (launchError) break;
    const started = await findRunningServer(config);
    if (started) return started;
    if (daemon.exitCode != null) break;
    await delay(100);
  }

  const detail = launchError ? `: ${launchError.message}` : '';
  throw new Error(`Proxy failed to start${detail}. Run "teamcodex server" to inspect the startup error.`);
}

async function waitForClaudeProxyRecovery(config) {
  const pollMs = Number.isFinite(config.claudeAutoResumeBackoffMs)
    ? Math.max(250, Math.floor(config.claudeAutoResumeBackoffMs))
    : 1000;
  const maxWaitMs = Number.isFinite(config.continuityMaxWaitMs)
    ? Math.max(0, Math.floor(config.continuityMaxWaitMs))
    : 15 * 60 * 1000;
  const deadline = Date.now() + maxWaitMs;
  let recoveryConfig = config;
  let nextLocalStartAt = 0;

  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(`Connection recovery timed out after ${maxWaitMs}ms.`);
    }
    const diskConfig = await loadConfig().catch(() => null);
    if (diskConfig?.proxy?.port) {
      recoveryConfig = {
        ...recoveryConfig,
        ...diskConfig,
        proxy: { ...recoveryConfig.proxy, ...diskConfig.proxy },
      };
    }

    const running = await findRunningServer(recoveryConfig);
    if (running) return running;

    const canStartLocalProxy = Array.isArray(recoveryConfig.accounts)
      && recoveryConfig.accounts.length > 0;
    if (canStartLocalProxy && Date.now() >= nextLocalStartAt) {
      nextLocalStartAt = Date.now() + 15_000;
      try {
        return await ensureProxyRunning(
          recoveryConfig,
          Math.max(0, deadline - Date.now()),
        );
      } catch {
        // Keep the CLI parent alive while the exact session is parked.
      }
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Stop the running server: SIGTERM, wait for graceful exit, escalate to SIGKILL.
 * Returns { stopped, reason?, pid?, port? }.
 */
async function stopRunningServer() {
  const config = await loadConfig();
  if (!config) return { stopped: false, reason: 'not-running' };

  const found = await findRunningServer(config);
  if (!found) { await clearServerState(); return { stopped: false, reason: 'not-running' }; }

  const { pid, port } = found;
  if (!pid) return { stopped: false, reason: 'no-pid', port };
  if (!found.lifecycleVerified || !found.identity) {
    return { stopped: false, reason: 'unverified-lifecycle', pid, port };
  }

  if (!sameProcessIdentity(found.identity, readProcessIdentity(pid))) {
    return { stopped: false, reason: 'unverified-lifecycle', pid, port };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') { await clearServerState(); return { stopped: true, pid, port }; }
    if (e.code === 'EPERM') return { stopped: false, reason: 'eperm', pid, port };
    throw e;
  }

  if (!(await waitForExit(found.identity, 6000))) {
    if (!sameProcessIdentity(found.identity, readProcessIdentity(pid))) {
      return { stopped: true, pid, port };
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* may have just exited */ }
    await waitForExit(found.identity, 2000);
  }
  if (sameProcessIdentity(found.identity, readProcessIdentity(pid))) {
    return { stopped: false, reason: 'failed', pid, port };
  }

  await clearServerState();
  return { stopped: true, pid, port };
}

function refuseSelfDisruptiveLifecycleCommand(command) {
  if (process.env.TEAMCLAUDE_SESSION_SUPERVISED !== '1') return false;
  console.error(
    `[TeamClaude] Refusing to ${command} the proxy from a supervised Claude or Codex session. Use a separate terminal.`,
  );
  process.exit(1);
}

async function stopCommand() {
  if (refuseSelfDisruptiveLifecycleCommand('stop')) return;
  const r = await stopRunningServer();
  if (r.stopped) {
    console.log(`Stopped TeamClaude server (pid ${r.pid}, port ${r.port}).`);
    return;
  }
  switch (r.reason) {
    case 'not-running':
      console.log('No TeamClaude server is running.');
      return;
    case 'no-pid':
      console.error(`A server is responding on port ${r.port} but its PID is unknown (lsof unavailable).`);
      console.error(`Stop it once with:  kill $(lsof -nP -iTCP:${r.port} -sTCP:LISTEN -t)`);
      process.exit(1);
      break;
    case 'eperm':
      console.error(`No permission to signal pid ${r.pid}.`);
      process.exit(1);
      break;
    case 'unverified-lifecycle':
      console.error(`Refusing to signal pid ${r.pid}: lifecycle identity could not be verified.`);
      process.exit(1);
      break;
    default:
      console.error(`Failed to stop pid ${r.pid} on port ${r.port}.`);
      process.exit(1);
  }
}

async function restartCommand() {
  if (refuseSelfDisruptiveLifecycleCommand('restart')) return;
  const r = await stopRunningServer();
  if (r.stopped) {
    console.log(`Stopped previous server (pid ${r.pid}).`);
  } else if (r.reason !== 'not-running') {
    const reason = r.reason === 'unverified-lifecycle'
      ? 'lifecycle identity unverified'
      : r.reason;
    console.error(`Could not stop the existing server (${reason}); aborting restart.`);
    if (r.reason === 'no-pid') {
      console.error(`Stop it manually first:  kill $(lsof -nP -iTCP:${r.port} -sTCP:LISTEN -t)`);
    }
    process.exit(1);
  }
  // Wait for the port to be released before re-binding.
  const port = (await loadConfig())?.proxy?.port;
  for (let i = 0; i < 20 && await probeServer(port, 500); i++) await delay(150);
  await serverCommand();
}

// ── import ──────────────────────────────────────────────────

async function importCommand() {
  const config = await loadOrCreateConfig();
  if (!config.provider && cliProvider === 'codex') config.provider = 'codex';
  const codexMode = isCodexMode(config);

  let name = argValue('--name');
  const jsonStr = argValue('--json');

  let creds;
  if (jsonStr) {
    // Accept raw JSON: --json '{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}'
    // or flat: --json '{"accessToken":"...","refreshToken":"...","expiresAt":...}'
    try {
      const raw = JSON.parse(jsonStr);
      if (codexMode) {
        creds = parseCodexCredentialsJson(raw);
      } else {
        const data = raw.claudeAiOauth || raw;
        if (!data.accessToken) {
          console.error('JSON must contain "accessToken" (directly or under "claudeAiOauth")');
          process.exit(1);
        }
        creds = {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresAt: data.expiresAt,
        };
      }
    } catch (err) {
      console.error(`Failed to parse --json: ${err.message}`);
      process.exit(1);
    }
  } else {
    const fromPath = argValue('--from')
      || (codexMode ? '~/.codex/auth.json' : '~/.claude/.credentials.json');
    try {
      creds = codexMode
        ? await importCodexCredentials(fromPath)
        : await importCredentials(fromPath);
    } catch (err) {
      console.error(`Failed to import from ${fromPath}: ${err.message}`);
      process.exit(1);
    }
  }

  if (codexMode) {
    await upsertCodexAccount(name, creds, 'import');
  } else {
    await upsertOAuthAccount(name, creds, 'import');
  }
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  const config = await loadOrCreateConfig();
  if (!config.provider && cliProvider === 'codex') config.provider = 'codex';
  if (isCodexMode(config)) {
    if (args.includes('--api')) {
      console.error('Codex subscription pooling supports ChatGPT OAuth accounts only.');
      process.exit(1);
    }
    await loginCodexCommand();
    return;
  }

  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--oauth')) {
    await loginOAuthCommand();
    return;
  }

  // Default to OAuth if not a TTY
  if (!process.stdout.isTTY) {
    await loginOAuthCommand();
    return;
  }

  // Interactive menu
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.log('Select login method:\n');
  console.log('  1. Claude subscription  (Pro, Max, Team, Enterprise)');
  console.log('  2. Anthropic API key    (Console API billing)');
  console.log('');
  const choice = await new Promise(resolve => rl.question('Choice [1]: ', resolve));
  rl.close();

  switch (choice.trim() || '1') {
    case '1': await loginOAuthCommand(); break;
    case '2': await loginApiCommand(); break;
    default:
      console.error(`Invalid choice: ${choice.trim()}`);
      process.exit(1);
  }
}

async function loginCodexCommand() {
  try {
    console.log('Starting isolated Codex OAuth login...');
    const creds = await loginCodexCredentials({
      deviceAuth: args.includes('--device-auth'),
    });
    await upsertCodexAccount(argValue('--name'), creds, 'login');
  } catch (err) {
    console.error(err.message);
    process.exit(err.exitCode ?? 1);
  }
}

async function loginApiCommand() {
  await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('Anthropic API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  const savedConfig = await atomicConfigUpdate(cfg => {
    if (!name) {
      // Generate against the fresh locked config: another login may have added
      // the apparent next slot while this prompt was open.
      let n = 1;
      do { name = `api-${n++}`; } while (cfg.accounts.some(a => a.name === name));
    }
    if (cfg.accounts.some(a => a.name === name)) {
      throw new Error(`Account "${name}" already exists`);
    }
    cfg.accounts.push({ name, type: 'apikey', apiKey: apiKey.trim() });
  });
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await noteRunningServerReload(savedConfig);
}

async function loginOAuthCommand() {
  let name = argValue('--name');

  console.log('Starting OAuth login...');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  teamcodex import        Import from existing Claude Code credentials');
    console.error('  teamcodex login --api   Add an API key instead');
    process.exit(1);
  }

  await upsertOAuthAccount(name, creds, 'login');
}

async function reauthenticateCommand() {
  const name = args[1];
  const uuidFlagIndex = args.indexOf('--account-uuid');
  const uuidEqualsArg = args.find(value => value.startsWith('--account-uuid='));
  const expectedAccountUuid = uuidEqualsArg
    ? uuidEqualsArg.slice('--account-uuid='.length) || null
    : argValue('--account-uuid');
  if (!name || name.startsWith('--')) {
    console.error('Usage: teamclaude reauth <account-name> [--account-uuid UUID]');
    process.exit(1);
  }
  if ((uuidFlagIndex >= 0
      && (!args[uuidFlagIndex + 1] || args[uuidFlagIndex + 1].startsWith('--')))
      || (uuidEqualsArg && !expectedAccountUuid)) {
    console.error('--account-uuid requires a value');
    process.exit(1);
  }

  console.log(`Starting OAuth re-authentication for "${name}"...`);
  let result;
  try {
    const provider = isCodexMode(await loadConfig()) ? 'codex' : null;
    result = await reauthenticateAccount({
      name,
      expectedAccountUuid,
      provider,
      loadConfig,
      login: provider === 'codex'
        ? () => loginCodexCredentials({ deviceAuth: args.includes('--device-auth') })
        : loginOAuth,
      fetchProfile,
      atomicUpdate: atomicConfigUpdate,
    });
  } catch (err) {
    console.error(`OAuth re-authentication rejected: ${err.message}`);
    process.exit(1);
  }
  console.log(`Re-authenticated account "${result.updated.name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await noteRunningServerReload(result.savedConfig);
}

async function codexSubscriptionCommand() {
  const action = args[1];
  const selector = args[2];
  const uuidFlagIndex = args.indexOf('--account-uuid');
  const endsFlagIndex = args.indexOf('--ends-on');
  const uuidEqualsArg = args.find(value => value.startsWith('--account-uuid='));
  const endsEqualsArg = args.find(value => value.startsWith('--ends-on='));
  const expectedAccountUuid = uuidEqualsArg
    ? uuidEqualsArg.slice('--account-uuid='.length) || null
    : argValue('--account-uuid');
  const endsOn = endsEqualsArg
    ? endsEqualsArg.slice('--ends-on='.length) || null
    : argValue('--ends-on');
  const missingUuid = uuidFlagIndex >= 0
    && (!args[uuidFlagIndex + 1] || args[uuidFlagIndex + 1].startsWith('--'))
    || Boolean(uuidEqualsArg && !expectedAccountUuid);
  const missingEndsOn = endsFlagIndex >= 0
    && (!args[endsFlagIndex + 1] || args[endsFlagIndex + 1].startsWith('--'))
    || Boolean(endsEqualsArg && !endsOn);
  if (!['cancel', 'clear'].includes(action) || !selector || missingUuid || missingEndsOn
      || (action === 'clear' && (endsFlagIndex >= 0 || endsEqualsArg))) {
    console.error('Usage: teamcodex codex subscription cancel <account> [--ends-on YYYY-MM-DD] [--account-uuid UUID]');
    console.error('       teamcodex codex subscription clear <account> [--account-uuid UUID]');
    process.exit(1);
  }

  let selectedName;
  try {
    const config = await atomicConfigUpdate(cfg => {
      const { account } = findSubscriptionTarget(cfg, { selector, expectedAccountUuid });
      selectedName = account.name;
      if (action === 'cancel') {
        applySubscriptionCancellation(account, {
          endsAt: endsOn ? cancellationEndsAt(endsOn, 9 * 60) : null,
        });
      } else {
        clearSubscriptionCancellation(account);
      }
    });
    console.log(action === 'cancel'
      ? `Tracking cancelled subscription for "${selectedName}"${endsOn ? ` (usable through ${endsOn})` : ''}`
      : `Cleared subscription cancellation for "${selectedName}"`);
    await noteRunningServerReload(config);
  } catch (err) {
    console.error(`Subscription tracking rejected: ${err.message}`);
    process.exit(1);
  }
}
// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  if (isCodexMode(config)) {
    console.log('teamcodex codex run');
    return;
  }
  const running = await findRunningServer(config);
  const port = running?.port || config.proxy.port;
  console.log(`export ANTHROPIC_BASE_URL=http://localhost:${port}`);
  console.log(`export ANTHROPIC_API_KEY=${config.proxy.apiKey}`);
}

// ── run ─────────────────────────────────────────────────────

function stripContextSuffix(model) {
  return typeof model === 'string' ? model.replace(/\[[^\]]*\]$/, '') : model;
}

function modelArgValue(claudeArgs) {
  for (let i = claudeArgs.length - 1; i >= 0; i--) {
    if (claudeArgs[i] === '--model') return claudeArgs[i + 1] || null;
    if (claudeArgs[i].startsWith('--model=')) return claudeArgs[i].slice('--model='.length) || null;
  }
  return null;
}

function setModelArg(claudeArgs, model) {
  for (let i = claudeArgs.length - 1; i >= 0; i--) {
    if (claudeArgs[i] === '--model') {
      if (i + 1 < claudeArgs.length) claudeArgs[i + 1] = model;
      else claudeArgs.push(model);
      return;
    }
    if (claudeArgs[i].startsWith('--model=')) {
      claudeArgs[i] = `--model=${model}`;
      return;
    }
  }
  claudeArgs.push('--model', model);
}

function fallbackChainFor(modelFallbacks, model) {
  if (!modelFallbacks || typeof modelFallbacks !== 'object' || !model) return null;
  const plain = stripContextSuffix(model);
  let chain = modelFallbacks[plain];
  if (!Array.isArray(chain) && /(^|[-_.])fable($|[-_.\d])/i.test(plain)) {
    const key = Object.keys(modelFallbacks).find(k => /(^|[-_.])fable($|[-_.\d])/i.test(k));
    if (key) chain = modelFallbacks[key];
  }
  if (!Array.isArray(chain) && /(^|[-_.])mythos($|[-_.\d])/i.test(plain)) {
    const key = Object.keys(modelFallbacks).find(k => /(^|[-_.])mythos($|[-_.\d])/i.test(k));
    if (key) chain = modelFallbacks[key];
  }
  return Array.isArray(chain) && chain.length ? chain : null;
}

function isGeneralQuotaBlocked(account, threshold) {
  const q = account.quota || {};
  const isBlocked = (utilization, reset) => {
    if (utilization == null || utilization < threshold) return false;
    const resetAt = reset == null ? null : new Date(reset).getTime();
    return resetAt == null || resetAt > Date.now();
  };
  if (isBlocked(q.unified5h, q.unified5hReset)) return true;
  if (isBlocked(q.unified7d, q.unified7dReset)) return true;
  if (q.tokensLimit && q.tokensRemaining != null
      && isBlocked(1 - q.tokensRemaining / q.tokensLimit, q.tokensReset || q.resetsAt)) return true;
  if (q.requestsLimit && q.requestsRemaining != null
      && isBlocked(1 - q.requestsRemaining / q.requestsLimit, q.requestsReset || q.resetsAt)) return true;
  return false;
}

function topTierUnavailable(status, threshold, requestedModel) {
  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const candidates = accounts.filter(a =>
    a.enabled !== false && !['disabled', 'error', 'exhausted', 'throttled'].includes(a.status));
  const available = candidates.filter(a => !isGeneralQuotaBlocked(a, threshold));
  if (!available.length) return true;
  const plainModel = stripContextSuffix(requestedModel);
  if (!/(^|[-_.])(fable|mythos)($|[-_.\d])/i.test(plainModel)) return false;

  const now = Date.now();
  return available.every(account => {
    const win = account.quota?.modelWeekly?.['7d_oi'];
    const reset = win?.reset == null ? null : new Date(win.reset).getTime();
    return Number.isFinite(win?.utilization)
      && Number.isFinite(reset)
      && reset > now
      && win.utilization >= threshold;
  });
}

function displayModel(model) {
  const plain = stripContextSuffix(model);
  return plain === 'claude-opus-4-8' ? `${plain}[1m]` : model;
}

async function syncLaunchModel(config, claudeArgs, childEnv) {
  const explicitModel = modelArgValue(claudeArgs) || childEnv.ANTHROPIC_MODEL || null;
  const configuredModel = typeof config.launchModel === 'string'
      && config.launchModel.length > 0
    ? config.launchModel
    : DEFAULT_MANAGED_CLAUDE_MODEL;
  const requestedModel = explicitModel || configuredModel;
  const chain = fallbackChainFor(config.modelFallbacks, requestedModel);
  if (!chain) {
    if (!explicitModel) setModelArg(claudeArgs, configuredModel);
    return;
  }

  const port = Number(config.proxy?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;

  let status;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      headers: {
        'x-api-key': config.proxy.apiKey,
        'x-teamcodex-status-identity': '1',
      },
      signal: AbortSignal.timeout(1500),
    });
    if (response.ok) status = await response.json();
  } catch {}

  if (status && topTierUnavailable(status, config.switchThreshold ?? 0.98, requestedModel)) {
    const fallback = displayModel(chain[0]);
    setModelArg(claudeArgs, fallback);
    console.error(`[TeamClaude] ${requestedModel} quota unavailable; launching Claude Code as ${fallback}.`);
  } else if (!modelArgValue(claudeArgs) && !childEnv.ANTHROPIC_MODEL) {
    setModelArg(claudeArgs, configuredModel);
  }
}

async function seedClaudeRecoveryAccount(config, childEnv) {
  // Preserve any inherited credential; it may be a real external OAuth token.
  if (Object.hasOwn(childEnv, 'CLAUDE_CODE_OAUTH_TOKEN')) return;

  const port = Number(config.proxy?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/teamclaude/status`, {
      headers: {
        'x-api-key': config.proxy.apiKey,
        'x-teamcodex-status-identity': '1',
      },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return;
    const status = await response.json();
    if (typeof status?.currentAccountUuid !== 'string'
        || status.currentAccountUuid.length === 0) return;
    childEnv.CLAUDE_CODE_OAUTH_TOKEN = buildClaudeRecoveryEnv(
      childEnv,
      status.currentAccountUuid,
    ).CLAUDE_CODE_OAUTH_TOKEN;
  } catch {}
}

async function recoverExpiredClaudeLogin(config, childEnv) {
  const recoveryToken = childEnv?.CLAUDE_CODE_OAUTH_TOKEN;
  const failedAccountUuid = parseClaudeRecoveryAccount(
    typeof recoveryToken === 'string' ? `Bearer ${recoveryToken}` : null,
  );
  const headers = {};
  if (config.proxy.apiKey) headers['x-api-key'] = config.proxy.apiKey;
  if (failedAccountUuid) headers.authorization = `Bearer ${recoveryToken}`;
  const response = await fetch(
    `http://127.0.0.1:${config.proxy.port}/teamclaude/rotate`,
    {
      method: 'POST',
      headers: Object.keys(headers).length ? headers : undefined,
      signal: AbortSignal.timeout(1500),
    },
  );
  const result = await response.json().catch(() => null);
  if (response.status === 409
      && result?.error?.type === 'no_alternative_account') {
    return { rotated: false, reason: 'no-alternative-account' };
  }
  if (!response.ok) return { rotated: false, reason: 'rotation-unavailable' };
  if (result?.rotated !== true
      || typeof result.previousAccount !== 'string'
      || typeof result.previousAccountUuid !== 'string'
      || typeof result.currentAccount !== 'string'
      || typeof result.currentAccountUuid !== 'string'
      || result.previousAccount === result.currentAccount
      || result.previousAccountUuid === result.currentAccountUuid
      || (failedAccountUuid && result.previousAccountUuid !== failedAccountUuid)) {
    return { rotated: false, reason: 'rotation-unavailable' };
  }
  return {
    rotated: true,
    previousAccount: result.previousAccount,
    previousAccountUuid: result.previousAccountUuid,
    currentAccount: result.currentAccount,
    currentAccountUuid: result.currentAccountUuid,
    childEnv: buildClaudeRecoveryEnv(childEnv, result.currentAccountUuid),
  };
}

function propagateChildExit(result) {
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return;
  }
  process.exit(result.status ?? 1);
}

function codexChildFailedUnexpectedly(result) {
  return !result.error && !result.signal && result.status != null
    && result.status !== 0 && result.status !== 130;
}

async function currentCodexRecoverySession(
  initialArgs,
  baselineSessionId,
  receiptSessionId,
  timeoutMs = 3000,
) {
  if (!isCodexSessionId(receiptSessionId)) return null;
  if (initialArgs[0] === 'resume' && isCodexSessionId(initialArgs[1])) {
    return initialArgs[1] === receiptSessionId ? initialArgs[1] : null;
  }
  if (!process.env.CMUX_SURFACE_ID) return null;
  const sessionId = await currentCmuxCodexSessionId(timeoutMs).catch(() => null);
  return sessionId && sessionId !== baselineSessionId && sessionId === receiptSessionId
    ? sessionId
    : null;
}

function codexRecoveryArgs(initialArgs, sessionId) {
  if (initialArgs[0] !== 'resume' || initialArgs[1] !== sessionId) {
    return ['resume', sessionId];
  }
  const optionsWithValues = new Set([
    '-a', '--add-dir', '--ask-for-approval', '-C', '--cd', '-c', '--config',
    '--disable', '--enable', '-i', '--image', '-m', '--model', '-p', '--profile',
    '--remote', '--remote-auth-token-env', '-s', '--sandbox',
  ]);
  const recovery = ['resume', sessionId];
  for (let index = 2; index < initialArgs.length; index++) {
    const arg = initialArgs[index];
    if (arg === '--' || !arg.startsWith('-')) break;
    recovery.push(arg);
    const option = arg.split('=', 1)[0];
    if (optionsWithValues.has(option) && !arg.includes('=')) {
      if (index + 1 >= initialArgs.length) break;
      recovery.push(initialArgs[++index]);
    }
  }
  return recovery;
}

async function consumeCodexRecoveryReceipt(port, invocationId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}${CODEX_RECOVERY_CONSUME_PATH}`,
        {
          method: 'POST',
          headers: { [CODEX_INVOCATION_HEADER]: invocationId },
          signal: AbortSignal.timeout(Math.min(1000, remainingMs)),
        },
      );
      if (response.status === 404) return null;
      if (response.ok) {
        const value = await response.json().catch(() => null);
        return isCodexSessionId(value?.sessionId) ? value.sessionId : null;
      }
    } catch {}
    const delayMs = Math.min(200, deadline - Date.now());
    if (delayMs > 0) await delay(delayMs);
  }
  return null;
}

async function codexResumeCommand() {
  const candidate = args[1];
  let sessionId;
  let resumeArgs;
  if (!candidate || candidate === '--' || candidate.startsWith('-')) {
    try {
      sessionId = await currentCmuxCodexSessionId();
    } catch (err) {
      console.error(`[TeamCodex] ${err.message}`);
      process.exit(1);
    }
    resumeArgs = candidate === '--' ? args.slice(2) : args.slice(1);
  } else {
    if (!isCodexSessionId(candidate)) {
      console.error('[TeamCodex] Invalid Codex SESSION_ID.');
      process.exit(1);
    }
    resumeArgs = args.slice(2);
    if (resumeArgs[0] === '--') resumeArgs.shift();
    sessionId = candidate;
  }
  try {
    assertSafeCodexArgs(resumeArgs);
  } catch (err) {
    console.error(`[TeamCodex] ${err.message}`);
    process.exit(1);
  }
  await runCommand(['resume', sessionId, ...resumeArgs]);
}

async function runCommand(clientArgsOverride = null) {
  if (cliProvider !== 'codex' && process.env.TEAMCLAUDE_SESSION_SUPERVISED === '1') {
    console.error(
      '[TeamClaude] Refusing nested supervised Claude launch: TEAMCLAUDE_CLAUDE_BIN must point to the native Claude vendor binary.',
    );
    process.exit(75);
  }
  const config = await loadOrCreateConfig();
  let runtimeConfig = isCodexMode(config)
    ? config
    : { ...config, proxy: { ...config.proxy } };
  if (!isCodexMode(config)) {
    try {
      const canStartLocalProxy = Array.isArray(config.accounts)
        && config.accounts.length > 0;
      if (!canStartLocalProxy) {
        console.error('[TeamClaude] No local accounts; waiting for the configured proxy or SSH tunnel.');
      }
      const running = canStartLocalProxy
        ? await ensureProxyRunning(config)
        : await waitForClaudeProxyRecovery(config);
      if (running.port !== config.proxy.port) runtimeConfig.proxy.port = running.port;
    } catch (err) {
      console.error(`[TeamClaude] ${err.message}`);
      process.exit(1);
    }
  }

  // Everything after 'run' (skip -- separator if present)
  const clientArgs = clientArgsOverride == null
    ? args.slice(1)
    : [...clientArgsOverride];
  if (clientArgs[0] === '--') clientArgs.shift();

  const childEnv = { ...process.env };
  const claudeBin = typeof childEnv.TEAMCLAUDE_CLAUDE_BIN === 'string'
    && childEnv.TEAMCLAUDE_CLAUDE_BIN.length > 0
    ? childEnv.TEAMCLAUDE_CLAUDE_BIN
    : 'claude';
  childEnv.TEAMCLAUDE_SESSION_SUPERVISED = '1';
  if (isCodexMode(config)) {
    delete childEnv.OPENAI_API_KEY;
    delete childEnv.CODEX_API_KEY;
    delete childEnv.CODEX_ACCESS_TOKEN;
    delete childEnv.TEAMCLAUDE_CODEX_PROXY_TOKEN;
    try {
      assertSafeCodexArgs(clientArgs);
    } catch (err) {
      console.error(`[TeamCodex] ${err.message}`);
      process.exit(1);
    }
    const codexBin = resolveCodexCliBin();
    const invocationId = randomUUID();
    childEnv.TEAMCODEX_INVOCATION_ID = invocationId;
    const explicitSessionId = clientArgs[0] === 'resume' && isCodexSessionId(clientArgs[1])
      ? clientArgs[1]
      : null;
    const hasCmuxSurface = Boolean(process.env.CMUX_SURFACE_ID);
    let baselineSessionId = null;
    let baselineTrusted = Boolean(explicitSessionId) || !hasCmuxSurface;
    if (!explicitSessionId && hasCmuxSurface) {
      try {
        const baseline = await currentCmuxCodexBaseline();
        baselineSessionId = baseline.sessionId;
        baselineTrusted = baseline.trusted;
      } catch {
        baselineTrusted = false;
      }
    }
    const launchCodex = launchArgs => spawnSync(
      codexBin,
      buildCodexProxyArgs(config.proxy.port, launchArgs),
      { stdio: 'inherit', env: childEnv },
    );
    let result = launchCodex(clientArgs);
    if (result.error) {
      if (result.error.code === 'ENOENT') {
        console.error(codexCliNotFoundMessage(codexBin));
      } else {
        console.error(`Failed to start codex: ${result.error.message}`);
      }
      process.exit(1);
    }
    if (codexChildFailedUnexpectedly(result)) {
      const recoveryDeadline = Date.now() + 5000;
      const receiptSessionId = await consumeCodexRecoveryReceipt(
        config.proxy.port,
        invocationId,
        Math.max(1, recoveryDeadline - Date.now()),
      );
      const sessionId = baselineTrusted && Date.now() < recoveryDeadline
        ? await currentCodexRecoverySession(
          clientArgs,
          baselineSessionId,
          receiptSessionId,
          Math.max(1, recoveryDeadline - Date.now()),
        )
        : null;
      if (sessionId) {
        console.error('[TeamCodex] Codex exited unexpectedly; resuming its trusted exact session once.');
        result = launchCodex(codexRecoveryArgs(clientArgs, sessionId));
        if (result.error) {
          if (result.error.code === 'ENOENT') {
            console.error(codexCliNotFoundMessage(codexBin));
          } else {
            console.error(`Failed to restart codex: ${result.error.message}`);
          }
          process.exit(1);
        }
      }
    }
    return propagateChildExit(result);
  }

  const proxyAuthEnv = ['ANTHROPIC', 'API', 'KEY'].join('_');
  const oauthEnv = ['ANTHROPIC', 'AUTH', 'TOKEN'].join('_');
  const preserveProxyAuth = typeof config.proxy.apiKey === 'string'
    && config.proxy.apiKey.length > 0
    && childEnv[proxyAuthEnv] === config.proxy.apiKey;
  delete childEnv[proxyAuthEnv];
  delete childEnv[oauthEnv];
  childEnv.ANTHROPIC_BASE_URL = `http://localhost:${runtimeConfig.proxy.port}`;
  if (preserveProxyAuth) childEnv[proxyAuthEnv] = config.proxy.apiKey;
  delete childEnv.DISABLE_GROWTHBOOK;
  await syncLaunchModel(runtimeConfig, clientArgs, childEnv);
  await seedClaudeRecoveryAccount(runtimeConfig, childEnv);

  // Clear higher-precedence API credentials so Claude Code keeps its OAuth
  // subscription while routing through the proxy.
  if (config.autoResumeClaude === true || config.codexFallbackOnExhaustion === true) {
    const result = await runClaudeWithRecovery({
      claudeArgs: clientArgs,
      childEnv,
      config: runtimeConfig,
      fetchStatus: async () => {
        const response = await fetch(`http://127.0.0.1:${runtimeConfig.proxy.port}/teamclaude/status`, {
          headers: {
            'x-api-key': config.proxy.apiKey,
            'x-teamcodex-status-identity': '1',
          },
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) throw new Error(`TeamClaude status failed (${response.status})`);
        return response.json();
      },
      recoverLoginExpired: ({ childEnv: recoveryEnv }) =>
        recoverExpiredClaudeLogin(runtimeConfig, recoveryEnv),
      recoverLimit: ({ childEnv: recoveryEnv }) =>
        recoverExpiredClaudeLogin(runtimeConfig, recoveryEnv),
      waitForConnectionRecovery: async ({ childEnv: recoveryEnv }) => {
        const recovered = await waitForClaudeProxyRecovery(runtimeConfig);
        runtimeConfig.proxy.port = recovered.port;
        return {
          childEnv: {
            ...recoveryEnv,
            ANTHROPIC_BASE_URL: `http://localhost:${recovered.port}`,
          },
        };
      },
      spawnClaude: (recoveryArgs, recoveryEnv) => spawn(claudeBin, recoveryArgs, {
        stdio: 'inherit',
        env: recoveryEnv,
      }),
      launchCodex: handoff => {
        const codexEnv = { ...childEnv, TEAMCLAUDE_PROVIDER: 'codex' };
        delete codexEnv.TEAMCLAUDE_CONFIG;
        return spawnSync(
          process.execPath,
          [process.argv[1], 'codex', 'run', '--', handoff.prompt],
          { stdio: 'inherit', env: codexEnv },
        );
      },
    });
    if (result?.error) {
      if (result.error.code === 'ENOENT') {
        console.error('Claude Code or Codex CLI not found in PATH.');
      } else {
        console.error(`Failed to recover CLI session: ${result.error.message}`);
      }
      process.exit(1);
    }
    return propagateChildExit(result);
  }

  const result = spawnSync(claudeBin, clientArgs, {
    stdio: 'inherit',
    env: childEnv,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  return propagateChildExit(result);
}

// ── status ──────────────────────────────────────────────────
// (ERROR_REASON_LABELS lives above the command dispatch — see the note there.)

async function statusCommand() {
  const config = await loadOrCreateConfig();
  // Locate the actual running server (its bound port may differ from the current
  // config port after an edit). findRunningServer handles stale-state cleanup; do
  // NOT clear state here, or a momentary blip would orphan a live server.
  const running = await findRunningServer(config);
  if (!running) {
    console.log(`Server:         not running (no proxy on port ${config.proxy.port})`);
    console.log('Start it with:  teamcodex server');
    process.exit(1);
  }
  const url = `http://127.0.0.1:${running.port}/teamclaude/status`;

  try {
    const res = await fetch(url, {
      headers: {
        'x-api-key': config.proxy.apiKey,
        'x-teamcodex-status-identity': '1',
      },
    });
    const data = await res.json();

    const identity = running.lifecycleVerified
      ? `${running.pid ? `pid ${running.pid}, ` : ''}port ${running.port}`
      : `lifecycle identity unverified, port ${running.port}`;
    console.log(`Server:         running (${identity})`);
    // Host CPU/RAM of the machine the proxy runs on (absent from older servers).
    // CPU% is measured between two status calls, so the very first call shows "-".
    if (data.host?.cpu && data.host?.memory) {
      const h = data.host;
      const cpu = h.cpu.usedPct != null ? `${h.cpu.usedPct}%` : '-';
      const load = Array.isArray(h.cpu.loadavg) ? h.cpu.loadavg[0] : '-';
      const m = h.memory;
      console.log(`Host:           CPU ${cpu} (load ${load} / ${h.cpu.cores} cores)   RAM ${formatBytes(m.usedBytes)}/${formatBytes(m.totalBytes)} (${m.usedPct}%)`);
    }
    console.log(`Active account: ${data.currentAccount}`);
    // Absent from older running servers — only print when the payload has it.
    if (data.usableCount != null && data.totalCount != null) {
      console.log(`Usable now:     ${data.usableCount}/${data.totalCount} accounts`);
    }
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';

      const disabledTag = acct.enabled === false ? ' [disabled]' : '';
      console.log(`  ${acct.name} (${acct.type})${current}${disabledTag}`);
      const reasonTag = acct.status === 'error' && ERROR_REASON_LABELS[acct.errorReason]
        ? ` [${ERROR_REASON_LABELS[acct.errorReason]}]` : '';
      console.log(`    Status:   ${acct.status}${reasonTag}${acct.enabled === false ? ' (disabled — out of rotation)' : ''}`);
      const subscriptionTag = subscriptionDisplay(acct.subscription);
      if (subscriptionTag) console.log(`    Subscription: ${subscriptionTag}`);
      if (acct.priority != null) console.log(`    Priority: ${acct.priority} (lower = preferred)`);
      if (acct.maxConcurrent != null) {
        console.log(`    In flight: ${acct.inflight ?? 0}/${acct.maxConcurrent} concurrent`);
      }

      if (q.unified5h != null || q.unified7d != null || Object.keys(q.modelWeekly ?? {}).length > 0) {
        const ses = q.unified5h != null ? (q.unified5h * 100).toFixed(1) + '%' : '-';
        const wk = q.unified7d != null ? (q.unified7d * 100).toFixed(1) + '%' : '-';
        let line = `    Session:  ${ses} used    Weekly: ${wk} used`;
        // Model-scoped weekly windows (7d_oi = the Fable weekly limit). Guarded
        // with ?. so a status from an older running server (no modelWeekly
        // field) still prints. Unknown labels print as-is.
        for (const [label, w] of Object.entries(q.modelWeekly ?? {})) {
          if (w?.utilization == null) continue;
          const name = label === '7d_oi' ? 'Fable wk' : label;
          line += `    ${name}: ${(w.utilization * 100).toFixed(1)}% used`;
        }
        console.log(line);
        // Codex reset credits ("Full reset" grants). Guarded with != null so a
        // status from an older server (no field) prints nothing extra.
        if (q.codexResetCredits != null) {
          const consumed = q.codexResetCreditsConsumed ? `, ${q.codexResetCreditsConsumed} redeemed` : '';
          const last = q.codexResetCreditLastOutcome ? ` (last: ${q.codexResetCreditLastOutcome})` : '';
          console.log(`    Reset credits: ${q.codexResetCredits} available${consumed}${last}`);
        } else if (data.resetCredits?.enabled) {
          console.log('    Reset credits: unknown (no wham/usage poll has reported a count yet)');
        }
      } else {
        const tok = q.tokensLimit ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1) + '%' : '-';
        const req = q.requestsLimit ? ((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1) + '%' : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }
  } catch {
    // findRunningServer just confirmed a server answered; a failure here is a
    // transient blip, not a reason to delete the discovery record.
    console.log(`Server:         unreachable (port ${running.port}) — try again`);
    process.exit(1);
  }
}

// ── accounts ────────────────────────────────────────────────

async function accountsCommand() {
  let config = await loadOrCreateConfig();
  const verbose = args.includes('-v') || args.includes('--verbose');

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: teamcodex import, teamcodex login, or teamcodex login --api');
    return;
  }

  const running = await findRunningServer(config).catch(() => null);
  if (!running) {
    // With no live proxy there is a single refresh owner: hold the cross-process
    // config lock for the read→refresh→write cycle so two CLI commands cannot
    // rotate the same refresh token concurrently.
    config = await atomicConfigUpdate(async cfg => {
      await Promise.all(cfg.accounts.map(async account => {
        if (account.type !== 'oauth' || !account.refreshToken
          || !isTokenExpiringSoon(account.expiresAt)) return;
        try {
          const newTokens = account.provider === 'codex'
            ? await refreshCodexAccessToken(account.refreshToken)
            : await refreshAccessToken(account.refreshToken);
          applyOAuthTokens(account, newTokens);
        } catch {}
      }));
    });
  }

  // Fetch profiles in parallel for all OAuth accounts
  const profiles = await Promise.all(
    config.accounts.map(a => {
      if (a.type !== 'oauth' || !a.accessToken) return null;
      if (a.provider === 'codex') {
        return {
          accountUuid: a.accountId || a.accountUuid,
          email: a.email || null,
          planType: a.planType || null,
          provider: 'codex',
        };
      }
      // The running worker owns token rotation. Sending an already-expired token
      // directly here is both useless and misleading; status remains visible via
      // `teamcodex status` while the worker refreshes on real traffic.
      if (running && isTokenExpiringSoon(a.expiresAt)) {
        return { error: 'token refresh managed by running proxy' };
      }
      return fetchProfile(a.accessToken);
    })
  );
  const profileUpdates = config.accounts.flatMap((account, i) => {
    const profile = profiles[i];
    if (!profile || profile.error || !profile.accountUuid) return [];
    return [{
      previousUuid: account.accountUuid || null,
      previousName: account.name,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      accountUuid: profile.accountUuid,
      name: account.provider !== 'codex' && profile.email ? profile.email : account.name,
    }];
  });

  // Deduplicate by accountUuid — keep the last (most recently added) entry
  const seen = new Map();
  let removed = 0;
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    const uuid = profiles[i]?.accountUuid || a.accountUuid;
    if (uuid) {
      if (seen.has(uuid)) {
        config.accounts.splice(i, 1);
        profiles.splice(i, 1);
        removed++;
      } else {
        seen.set(uuid, i);
        // Update stored UUID and name from profile
        if (profiles[i] && !profiles[i].error) {
          a.accountUuid = profiles[i].accountUuid;
          if (a.provider !== 'codex' && profiles[i].email) a.name = profiles[i].email;
        }
      }
    }
  }
  if (profileUpdates.length > 0 || removed > 0) {
    const updatedConfig = await atomicConfigUpdate(cfg => {
      for (const update of profileUpdates) {
        const account = (update.previousUuid
          && cfg.accounts.find(a => a.accountUuid === update.previousUuid))
          || cfg.accounts.find(a => a.name === update.previousName);
        // The profile request ran without holding the config lock. A concurrent
        // import may have installed a different credential under the same name;
        // never attach the old token's UUID/email to that replacement account.
        if (!account || !storedCredentialMatches(account, update)) continue;
        account.accountUuid = update.accountUuid;
        account.name = update.name;
      }
      const deduped = [];
      const uuids = new Set();
      for (let i = cfg.accounts.length - 1; i >= 0; i--) {
        const account = cfg.accounts[i];
        if (account.accountUuid && uuids.has(account.accountUuid)) continue;
        if (account.accountUuid) uuids.add(account.accountUuid);
        deduped.push(account);
      }
      cfg.accounts = deduped.reverse();
    });
    if (running) await noteRunningServerReload(updatedConfig);
  }
  if (removed > 0) {
    console.log(`Removed ${removed} duplicate account(s)\n`);
  }

  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];

    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 15)}...`);
      continue;
    }

    // OAuth account
    const hasProfile = p && !p.error;
    if (a.provider === 'codex') {
      const plan = p?.planType || a.planType || 'subscription';
      const src = a.source ? `, ${a.source}` : '';
      console.log(`  [${i + 1}] ${a.name} (Codex ${plan}${src})`);
      if (p?.email && p.email !== a.name) console.log(`       Email: ${p.email}`);
      const subscriptionTag = subscriptionDisplay(subscriptionSnapshot({
        subscriptionCancellation: normalizeSubscriptionCancellation(a.subscriptionCancellation),
      }));
      if (subscriptionTag) console.log(`       Subscription: ${subscriptionTag}`);
      if (verbose && a.expiresAt) printTokenExpiry(a.expiresAt);
      continue;
    }
    const tier = hasProfile ? (p.hasClaudeMax ? 'Max' : p.hasClaudePro ? 'Pro' : 'subscription') : null;
    const status = hasProfile ? `Claude ${tier}` : `unknown (${p?.error || 'no token'})`;
    const src = a.source ? `, ${a.source}` : '';
    console.log(`  [${i + 1}] ${a.name} (${status}${src})`);
    if (hasProfile && p.email && p.email !== a.name) console.log(`       Email: ${p.email}`);
    if (hasProfile && p.orgName) console.log(`       Org:   ${p.orgName}`);
    if (verbose && a.expiresAt) printTokenExpiry(a.expiresAt);
  }
}

function printTokenExpiry(expiresAt) {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    console.log('       Token: expired');
    return;
  }
  const mins = Math.floor(remaining / 60000);
  const hrs = Math.floor(mins / 60);
  const expiry = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
  console.log(`       Token: expires in ${expiry}`);
}

// ── api ─────────────────────────────────────────────────────

async function apiCommand() {
  let config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: teamcodex api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: teamcodex api /api/oauth/claude_cli/roles');
    process.exit(1);
  }
  if (!path.startsWith('/') || path.startsWith('//')) {
    console.error('The api command requires a relative API path beginning with a single /.');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue('--account');
  const method = (argValue('--method') || 'GET').toUpperCase();
  const data = argValue('--data');
  const running = await findRunningServer(config).catch(() => null);
  const useRunningProxy = !accountName && running;

  let url;
  let headers;
  if (useRunningProxy) {
    url = `http://127.0.0.1:${running.port}${path}`;
    headers = { 'x-api-key': config.proxy.apiKey };
    if (path === '/teamclaude/status') {
      headers['x-teamcodex-status-identity'] = '1';
    }
  } else {
    const accounts = await resolveAccounts(config);
    let account;
    if (accountName) {
      account = accounts.find(a => a.name === accountName);
      if (!account) { console.error(`Account "${accountName}" not found`); process.exit(1); }
    } else {
      account = accounts.find(a => a.type === 'oauth') || accounts[0];
      if (!account) { console.error('No accounts configured'); process.exit(1); }
    }

    if (account.type === 'oauth' && isTokenExpiringSoon(account.expiresAt)) {
      if (running) {
        console.error('The running proxy owns OAuth token refresh for this config.');
        console.error('Use a relative path without --account, or stop the proxy before a direct account call.');
        process.exit(1);
      }

      let refreshed = null;
      config = await atomicConfigUpdate(async cfg => {
        const stored = (account.accountUuid
          && cfg.accounts.find(a => a.accountUuid === account.accountUuid))
          || cfg.accounts.find(a => a.name === account.name);
        if (!stored) throw new Error(`Account "${account.name}" was removed during refresh`);
        const refreshToken = stored.refreshToken || account.refreshToken;
        if (!refreshToken) throw new Error(`Account "${account.name}" has no refresh token`);
        const newTokens = (stored.provider || account.provider) === 'codex'
          ? await refreshCodexAccessToken(refreshToken)
          : await refreshAccessToken(refreshToken);
        applyOAuthTokens(stored, newTokens);
        refreshed = { ...account, ...stored };
      });
      account = refreshed;
    }

    const credential = account.accessToken || account.apiKey;
    const isOAuth = account.type === 'oauth';
    const codexMode = isCodexMode(config);
    const upstream = config.upstream || (codexMode
      ? 'https://chatgpt.com/backend-api/codex'
      : 'https://api.anthropic.com');
    url = `${upstream}${path}`;
    headers = isOAuth
      ? { 'Authorization': `Bearer ${credential}` }
      : { 'x-api-key': credential };
    if (codexMode && account.accountId) {
      headers['ChatGPT-Account-ID'] = account.accountId;
    }
  }

  const fetchOpts = { method, headers, redirect: 'manual' };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await fetch(url, fetchOpts);

  // Print response headers to stderr
  console.error(`${res.status} ${res.statusText}`);
  for (const [k, v] of res.headers.entries()) {
    console.error(`  ${k}: ${v}`);
  }
  console.error('');

  // Print body to stdout
  const body = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
}

// ── remove ──────────────────────────────────────────────────

async function removeCommand() {
  const name = args[1];

  if (!name) {
    console.error('Usage: teamcodex remove <account-name>');
    process.exit(1);
  }

  let found = false;
  const config = await atomicConfigUpdate(cfg => {
    const idx = cfg.accounts.findIndex(a => a.name === name);
    if (idx < 0) return;
    cfg.accounts.splice(idx, 1);
    found = true;
  });
  if (!found) { console.error(`Account "${name}" not found`); process.exit(1); }
  console.log(`Removed account "${name}"`);
  await noteRunningServerReload(config);
}

// ── enable / disable / priority ─────────────────────────────

/** Ask the supervised worker to live-sync account changes without a restart. */
async function noteRunningServerReload(config) {
  try {
    const running = await findRunningServer(config);
    if (!running) return false;
    const state = await readServerState();
    const workerPid = running.lifecycleVerified && running.identity
      && verifyWorkerIdentity(state, running.identity)
      ? state.workerPid
      : null;
    if (!workerPid) {
      console.error('The running server does not support account-only live reload.');
      console.error('Apply the change with: teamcodex restart');
      return false;
    }
    process.kill(workerPid, 'SIGHUP');
    console.log('Applied to the running server without restarting active connections.');
    return true;
  } catch (err) {
    console.error(`Could not reload the running server automatically: ${err.message}`);
    console.error('Apply the change with: teamcodex restart');
    return false;
  }
}

async function setEnabledCommand(enabled) {
  const name = args[1];
  if (!name) {
    console.error(`Usage: teamcodex ${enabled ? 'enable' : 'disable'} <account-name>`);
    process.exit(1);
  }
  // atomicConfigUpdate re-reads disk before writing, so a concurrent token
  // refresh from the running server (or another CLI edit) isn't clobbered by a
  // stale snapshot. Match by name (what the user typed) within the fresh copy.
  let found = false;
  const config = await atomicConfigUpdate(cfg => {
    const acct = cfg.accounts.find(a => a.name === name);
    if (acct) { acct.enabled = enabled; found = true; }
  });
  if (!found) { console.error(`Account "${name}" not found`); process.exit(1); }
  console.log(`${enabled ? 'Enabled' : 'Disabled'} account "${name}"`);
  if (!enabled) console.log('  (excluded from active rotation; in-flight requests still finish)');
  await noteRunningServerReload(config);
}

async function setPriorityCommand() {
  const name = args[1];
  const raw = args[2];
  if (!name || raw === undefined) {
    console.error('Usage: teamcodex priority <account-name> <number|auto>');
    console.error('  Lower number = preferred first. Use "auto" (or "clear") to return the');
    console.error('  account to automatic ordering: weekly reset soonest is drained first.');
    process.exit(1);
  }
  const clearing = raw === 'auto' || raw === 'clear' || raw === 'none' || raw === 'null';
  let value = null;
  if (!clearing) {
    const n = Number(raw);
    if (!Number.isFinite(n)) { console.error(`Invalid priority "${raw}" — expected a number or "auto"`); process.exit(1); }
    value = Math.floor(n);
  }
  let found = false;
  const config = await atomicConfigUpdate(cfg => {
    const acct = cfg.accounts.find(a => a.name === name);
    if (acct) { found = true; if (clearing) delete acct.priority; else acct.priority = value; }
  });
  if (!found) { console.error(`Account "${name}" not found`); process.exit(1); }
  console.log(clearing
    ? `Set "${name}" to auto (use-or-lose ordering: weekly reset soonest first)`
    : `Set priority of "${name}" to ${value} (lower = preferred first)`);
  await noteRunningServerReload(config);
}

async function anthropicSubscriptionCommand() {
  const name = args[1];
  const state = args[2];
  if (!name || (state !== 'disabled' && state !== 'ok')) {
    console.error('Usage: teamcodex subscription <account-name> <disabled|ok>');
    console.error('  "disabled" records a confirmed organization access denial and keeps the');
    console.error('  account out of rotation while TeamClaude rechecks it. "ok" clears it now.');
    process.exit(1);
  }
  // The flag models a Claude Code organization-access denial (Anthropic OAuth 403);
  // the Codex pool has no equivalent signal, so refuse rather than write a
  // flag nothing would ever read or clear.
  if (isCodexMode(await loadConfig())) {
    console.error('subscription <disabled|ok> applies to Claude (Anthropic) accounts only, not the Codex pool.');
    process.exit(1);
  }
  const disabled = state === 'disabled';
  let found = false;
  const config = await atomicConfigUpdate(cfg => {
    const acct = cfg.accounts.find(a => a.name === name);
    if (!acct) return;
    found = true;
    if (disabled) acct.subscriptionDisabled = true;
    else delete acct.subscriptionDisabled;
  });
  if (!found) { console.error(`Account "${name}" not found`); process.exit(1); }
  console.log(disabled
    ? `Marked "${name}" subscription-disabled (organization access denied; auto-rechecked)`
    : `Cleared the subscription flag for "${name}" (back into rotation)`);
  await noteRunningServerReload(config);
}

async function subscriptionCommand() {
  return cliProvider === 'codex'
    ? codexSubscriptionCommand()
    : anthropicSubscriptionCommand();
}

async function installClaudeWrapperCommand() {
  const installed = await installClaudeWrapper({
    homeDir: homedir(),
    teamcodexBin: resolve(process.argv[1]),
  });
  console.log(installed.wrapperPath);
  console.log(installed.vendorShimPath);
}

async function uninstallClaudeWrapperCommand() {
  const uninstalled = await uninstallClaudeWrapper({ homeDir: homedir() });
  console.log(uninstalled.wrapperPath);
  console.log(uninstalled.vendorShimPath);
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  if (cliProvider === 'codex') {
    console.log(`TeamCodex - Multi-account Codex subscription proxy

Usage: teamcodex codex [command] [options]

Commands:
  server              Start the Codex proxy server
  stop                Stop the running Codex proxy
  restart             Restart the Codex proxy
  login               Add an account with an isolated official Codex OAuth login
  import              Import the current ~/.codex/auth.json
  run [-- args...]    Run Codex through the multi-account proxy
  resume [ID]         Resume the exact ID, or the current cmux tab checkpoint
  env                 Print an equivalent Codex launch command
  status              Show proxy & account status
  accounts            List configured Codex accounts
  reauth <name>       Re-authenticate one existing OAuth account
  subscription cancel Track a cancelled subscription without disabling it
  subscription clear  Clear cancellation tracking for one account
  remove <name>       Remove an account
  disable <name>      Disable an account
  enable <name>       Re-enable an account
  priority <name> <n> Set selection priority ("auto" clears it)
  api <path>          Call a ChatGPT backend endpoint with one account
  install-claude-wrapper   Install the transparent Claude launcher
  uninstall-claude-wrapper Remove it and restore the prior launchers
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Codex auth path (default: ~/.codex/auth.json)
  --device-auth       Use the Codex device login flow
  --ends-on DATE      Last usable local date for subscription cancel (YYYY-MM-DD)
  --account-uuid UUID Pin a subscription command to the selected account identity
  --log-to DIR        Log full requests/responses to DIR

Config: ${getConfigPath()}
`);
    return;
  }
  console.log(`TeamCodex - one local proxy for Claude Code and Codex accounts

Usage: teamcodex [command] [options]

Commands:
  server              Start the proxy server (default)
  stop                Stop the running proxy server
  restart             Stop the running server (if any) and start a fresh one
  import              Import credentials from Claude Code
  login               OAuth login via browser
  login --api         Add an API key account
  env                 Print env vars to use with Claude
  run [-- args...]    Run Claude Code through the proxy
  status              Show proxy & account status (live)
  accounts            List configured accounts
  reauth <name>       Re-authenticate one existing OAuth account
  remove <name>       Remove an account
  disable <name>      Disable an account (excluded from rotation)
  enable <name>       Re-enable a disabled account
  priority <name> <n> Set selection priority (lower = preferred; "auto" to return
                      to automatic ordering — weekly reset soonest drained first)
  subscription <name> <disabled|ok>
                      Mark an account's Claude subscription lapsed (kept out of
                      rotation, survives restarts) or clear the mark
  api <path>          Call an API endpoint with account credentials
  install-claude-wrapper   Install the transparent Claude launcher
  uninstall-claude-wrapper Remove it and restore the prior launchers
  help                Show this help

Options:
  --name NAME         Set account name (import/login)
  --from PATH         Credentials path (import, default: ~/.claude/.credentials.json)
  --json JSON         Import from inline JSON (import), e.g.:
                      --json '{"accessToken":"...","refreshToken":"...","expiresAt":1234}'
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)

Config: ${getConfigPath()}
`);
}

// ── shared account upsert ────────────────────────────────────

async function upsertOAuthAccount(name, creds, source = 'unknown') {
  // Fetch profile to auto-name and deduplicate by account UUID
  const profile = await fetchProfile(creds.accessToken);
  const profileOk = profile && !profile.error;

  if (!profileOk) {
    console.error(`Warning: could not fetch account profile — ${profile?.error || 'no token'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  let action = 'Added';
  const savedConfig = await atomicConfigUpdate(cfg => {
    if (!name) {
      // First FREE account-N (not `count + 1`, which collides after a delete)
      // against the fresh locked config, not the pre-login snapshot.
      let n = 1;
      do { name = `account-${n++}`; } while (cfg.accounts.some(a => a.name === name));
    }
    const account = {
      name,
      type: 'oauth',
      source,
      accountUuid: profile?.accountUuid || null,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };
    let idx = profile?.accountUuid
      ? cfg.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
      : -1;
    if (idx < 0) idx = cfg.accounts.findIndex(a => a.name === name);
    if (idx >= 0) {
      action = 'Updated';
      const previous = cfg.accounts[idx];
      if (previous.enabled !== undefined) account.enabled = previous.enabled;
      if (previous.priority !== undefined) account.priority = previous.priority;
      if (previous.maxConcurrent !== undefined) account.maxConcurrent = previous.maxConcurrent;
      if (previous.subscriptionCancellation !== undefined) {
        account.subscriptionCancellation = previous.subscriptionCancellation;
      }
      cfg.accounts[idx] = account;
    } else {
      cfg.accounts.push(account);
    }
  });
  console.log(`${action} account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await noteRunningServerReload(savedConfig);
}

async function upsertCodexAccount(name, creds, source = 'unknown') {
  if (!name) name = creds.email;
  let action = 'Added';
  const savedConfig = await atomicConfigUpdate(cfg => {
    if (!name) {
      let n = 1;
      do { name = `codex-account-${n++}`; } while (cfg.accounts.some(a => a.name === name));
    }
    const account = {
      name,
      provider: 'codex',
      type: 'oauth',
      source,
      accountUuid: creds.accountId,
      accountId: creds.accountId,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      idToken: creds.idToken,
      expiresAt: creds.expiresAt,
      email: creds.email,
      planType: creds.planType,
    };
    let idx = cfg.accounts.findIndex(a =>
      a.accountUuid === creds.accountId || a.accountId === creds.accountId);
    if (idx < 0) idx = cfg.accounts.findIndex(a => a.name === name);
    if (idx >= 0) {
      action = 'Updated';
      const previous = cfg.accounts[idx];
      if (previous.enabled !== undefined) account.enabled = previous.enabled;
      if (previous.priority !== undefined) account.priority = previous.priority;
      if (previous.maxConcurrent !== undefined) account.maxConcurrent = previous.maxConcurrent;
      if (previous.subscriptionCancellation !== undefined) {
        account.subscriptionCancellation = previous.subscriptionCancellation;
      }
      cfg.accounts[idx] = account;
    } else {
      cfg.accounts.push(account);
    }
    cfg.provider = 'codex';
  });
  console.log(`${action} Codex account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
  await noteRunningServerReload(savedConfig);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Accounts with two different UUIDs are replacements, even when names match.
 * Name remains the fallback when either side has no stable UUID.
 */
function sameAccountIdentity(a, b) {
  if (a.accountUuid && b.accountUuid) return a.accountUuid === b.accountUuid;
  return a.name === b.name;
}

function findConfigAccount(diskConfig, account) {
  return diskConfig.accounts.findIndex(a => sameAccountIdentity(a, account));
}

function storedCredentialMatches(account, previousTokens) {
  if (!previousTokens) return true;
  return (account.accessToken ?? null) === (previousTokens.accessToken ?? null)
    && (account.refreshToken ?? null) === (previousTokens.refreshToken ?? null);
}

function applyOAuthTokens(account, tokens) {
  account.accessToken = tokens.accessToken;
  account.refreshToken = tokens.refreshToken;
  account.expiresAt = tokens.expiresAt;
  if (tokens.idToken) account.idToken = tokens.idToken;
  if (tokens.accountId) {
    account.accountId = tokens.accountId;
    account.accountUuid = tokens.accountId;
  }
  if (tokens.email) account.email = tokens.email;
  if (tokens.planType) account.planType = tokens.planType;
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;

  // Disk is authoritative for the account set. Without this removal pass, a CLI
  // `remove` changed only the file while the running worker kept routing traffic
  // through the deleted live credential until a full restart.
  for (let i = memConfig.accounts.length - 1; i >= 0; i--) {
    const memAcct = memConfig.accounts[i];
    const stillOnDisk = diskConfig.accounts.some(a => sameAccountIdentity(a, memAcct));
    if (stillOnDisk) continue;

    const mgr = accountManager.accounts.find(a => sameAccountIdentity(a, memAcct));
    if (mgr) accountManager.removeAccount(mgr.index);
    memConfig.accounts.splice(i, 1);
    console.log(`[TeamClaude] Removed account "${memAcct.name}" from live config`);
  }

  for (const diskAcct of diskConfig.accounts) {
    const memIdx = memConfig.accounts.findIndex(a => sameAccountIdentity(a, diskAcct));

    if (memIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      added++;
      console.log(`[TeamClaude] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    const mgr = accountManager.accounts.find(a => sameAccountIdentity(a, diskAcct));

    // Apply enable/disable + priority from disk FIRST — independent of credential
    // re-resolution below. A failed re-import (freshCred null) must NOT strand a
    // `teamcodex disable`/`priority` set while the server runs. setEnabled drains
    // the overflow queue when re-enabling so a freed-up account is used at once.
    if (mgr) {
      const wantEnabled = diskAcct.enabled !== false;
      if (mgr.enabled !== wantEnabled) accountManager.setEnabled(mgr, wantEnabled);
      const diskPriority = Number.isFinite(diskAcct.priority) ? Math.floor(diskAcct.priority) : null;
      if (mgr.priority !== diskPriority) accountManager.setPriority(mgr, diskPriority);
      const diskCancellation = normalizeSubscriptionCancellation(diskAcct.subscriptionCancellation);
      if (JSON.stringify(normalizeSubscriptionCancellation(mgr.subscriptionCancellation))
          !== JSON.stringify(diskCancellation)) {
        accountManager.setSubscriptionCancellation(mgr, diskCancellation, false);
      }
      // Informational plan label (codex usage-limit body); a re-import may have
      // learned it after the live account was constructed.
      if (typeof diskAcct.planType === 'string' && diskAcct.planType && mgr.planType !== diskAcct.planType) {
        mgr.planType = diskAcct.planType;
      }
      // Mirror the applied state into the in-memory config copy too. Otherwise a
      // later TUI saveConfig (for any unrelated op) would spread the pre-sync
      // enabled/priority over the disk value and silently revert a CLI change.
      // Subscription-lapse flag from disk, both directions: a CLI
      // `subscription <name> disabled|ok` while the server runs must park /
      // free the live account on reload. persist=false — the change came FROM
      // disk, so echoing it back would only churn the config.
      const wantLapsed = diskAcct.subscriptionDisabled === true;
      if (mgr.provider === 'anthropic' && (mgr.subscriptionDisabled === true) !== wantLapsed) {
        accountManager.setSubscriptionDisabled(mgr, wantLapsed, false);
      }
      const memAcct = memConfig.accounts[memIdx];
      if (memAcct) {
        if (wantEnabled) delete memAcct.enabled; else memAcct.enabled = false;
        if (diskPriority === null) delete memAcct.priority; else memAcct.priority = diskPriority;
        if (wantLapsed) memAcct.subscriptionDisabled = true; else delete memAcct.subscriptionDisabled;
        if (diskCancellation) memAcct.subscriptionCancellation = diskCancellation;
        else delete memAcct.subscriptionCancellation;
      }
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.importFrom) {
      try {
        const creds = diskAcct.provider === 'codex'
          ? await importCodexCredentials(diskAcct.importFrom)
          : await importCredentials(diskAcct.importFrom);
        freshCred = {
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken,
          expiresAt: creds.expiresAt,
          idToken: creds.idToken,
          accountId: creds.accountId,
          planType: creds.planType,
        };
      } catch (err) {
        console.error(`[TeamClaude] Re-import failed for "${diskAcct.name}": ${err.message}`);
      }
    } else if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = {
        accessToken: diskAcct.accessToken,
        refreshToken: diskAcct.refreshToken,
        expiresAt: diskAcct.expiresAt,
        idToken: diskAcct.idToken,
        accountId: diskAcct.accountId,
        planType: diskAcct.planType,
      };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    }

    if (!freshCred || !mgr) continue;

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken ||
        (freshCred.accountId && mgr.accountId !== freshCred.accountId);
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[TeamClaude] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') {
        mgr.status = 'active';
        delete mgr.errorReason;
      }
      console.log(`[TeamClaude] Updated API key for "${mgr.name}"`);
    }
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

function isCodexMode(config) {
  // The env leg matters for the SUPERVISED WORKER: it is forked with plain
  // ['server'] args (cliProvider = 'anthropic') and only inherits
  // TEAMCLAUDE_PROVIDER. getConfigPath() already picked teamcodex.json off the
  // same env var, so a provider-less config file must not flip the worker into
  // anthropic semantics (stream recovery, auth headers, default upstream).
  return config?.provider === 'codex' || cliProvider === 'codex'
    || process.env.TEAMCLAUDE_PROVIDER === 'codex';
}

async function resolveAccounts(config) {
  const accounts = [];
  for (const acct of config.accounts) {
    if (acct.type === 'oauth') {
      if (acct.importFrom) {
        try {
          const creds = acct.provider === 'codex'
            ? await importCodexCredentials(acct.importFrom)
            : await importCredentials(acct.importFrom);
          // Carry accountUuid through so the live account can be matched UUID-first
          // on sync (otherwise it stays null and a name change misroutes the update).
          accounts.push({
            name: acct.name,
            provider: acct.provider || config.provider || 'anthropic',
            type: 'oauth',
            accountUuid: acct.accountUuid,
            maxConcurrent: acct.maxConcurrent,
            enabled: acct.enabled,
            priority: acct.priority,
            subscriptionDisabled: acct.subscriptionDisabled,
            subscriptionCancellation: acct.subscriptionCancellation,
            ...creds,
          });
          console.log(`Imported "${acct.name}" from ${acct.importFrom}`);
        } catch (err) {
          console.error(`Failed to import "${acct.name}": ${err.message}`);
        }
      } else if (acct.accessToken) {
        accounts.push(acct);
      } else {
        console.error(`No token for "${acct.name}", skipping`);
      }
    } else if (acct.type === 'apikey' && acct.apiKey) {
      accounts.push(acct);
    }
  }
  return accounts;
}

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

function handleServerListenError(err, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[TeamClaude] Port ${port} is already in use.`);
    console.error('Another TeamClaude proxy may already be running.');
    console.error('  See it:     teamcodex status');
    console.error('  Stop it:    teamcodex stop');
    console.error('  Restart it: teamcodex restart');
  } else if (err.code === 'EACCES') {
    console.error(`[TeamClaude] Permission denied while listening on port ${port}.`);
    console.error('Choose a non-privileged port in the TeamClaude config.');
  } else {
    console.error(`[TeamClaude] Failed to listen on port ${port}: ${err.message}`);
  }
  process.exit(1);
}
