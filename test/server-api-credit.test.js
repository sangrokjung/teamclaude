// 서버 경로의 API 키 크레딧 처리: 지출 원장(B4), 크레딧 거절 감지와 재시도(B7),
// OAuth 전용 beta 토큰 제거(B8), /byok 요청의 API 키 우선(B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const HOUR = 3600_000;
const BYOK_KEY = 'byok-test-secret-0123456789';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

const apiKey = (name, extra = {}) => ({ name, type: 'apikey', apiKey: `test-key-${name}`, ...extra });
const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: `tok-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + HOUR, ...extra,
});

// 구독 계정을 쿼터 소진으로 측정해 둔다(API 키 계층이 열리게).
function exhaust(a) {
  a.quota.unified5h = 0.99;
  a.quota.unified5hReset = Date.now() + HOUR;
  a.quota.unified7d = 0.5;
  a.quota.unified7dReset = Date.now() + 48 * HOUR;
}
function healthy(a) {
  a.quota.unified5h = 0.1;
  a.quota.unified5hReset = Date.now() + HOUR;
  a.quota.unified7d = 0.2;
  a.quota.unified7dReset = Date.now() + 48 * HOUR;
}

function who(req) {
  if (req.headers['x-api-key']) return req.headers['x-api-key'].replace('test-key-', '');
  return (req.headers.authorization || '').replace('Bearer tok-', '');
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString();
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const CREDIT_LOW = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
const OK = (account, model = 'claude-haiku-4-5-20251001', usage = { input_tokens: 1_000_000, output_tokens: 0 }) =>
  ({ id: 'msg', type: 'message', model, account, usage, content: [] });

async function setup(t, accounts, respond, overrides = {}) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const entry = { who: who(req), url: req.url, headers: { ...req.headers }, body };
    seen.push(entry);
    respond(entry, res);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.98, 0, 3);
  for (const a of am.accounts) {
    if (a.type === 'apikey') { a.quota.tokensLimit = 1000; a.quota.tokensRemaining = 900; }
  }
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'k' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    activeWarmup: false,
    ...overrides,
  });
  const port = await listen(proxy);
  t.after(() => close(proxy));
  t.after(() => close(upstream));
  return { am, port, seen };
}

function post(port, { path = '/v1/messages', headers = {}, body = { model: 'claude-haiku-4-5', messages: [] } } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('B7: 400 credit balance is too low → 키를 영속 소진으로 빼고 다음 키로 재시도', async t => {
  const { am, port, seen } = await setup(t, [oauth('sub-1'), apiKey('api-1'), apiKey('api-2')], (e, res) => {
    if (e.who === 'api-1') return json(res, 400, CREDIT_LOW);
    return json(res, 200, OK(e.who));
  });
  exhaust(am.accounts[0]);
  const flags = [];
  am.onAccountCreditFlag((account, value) => flags.push([account.name, value?.reason ?? null]));
  const res = await post(port);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).account, 'api-2');
  assert.deepEqual(seen.map(e => e.who), ['api-1', 'api-2'], '같은 키로 재시도하지 않는다');
  const a1 = am.accounts[1];
  assert.equal(a1.creditExhausted.reason, 'credit-exhausted');
  assert.equal(a1.errorReason, 'credit-exhausted');
  assert.deepEqual(flags, [['api-1', 'credit-exhausted']]);

  // 다음 요청은 소진된 키로 가지 않는다.
  const again = await post(port);
  assert.equal(again.status, 200);
  assert.deepEqual(seen.map(e => e.who), ['api-1', 'api-2', 'api-2']);
});

for (const [label, status, body, reason] of [
  ['400 usage limits', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.' } }, 'usage-limit'],
  ['429 enforced_spend_limit_reached', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Spend limit reached', details: { error_code: 'enforced_spend_limit_reached' } } }, 'spend-limit'],
  ['402 billing_error', 402, { type: 'error', error: { type: 'billing_error', message: 'Payment required' } }, 'billing'],
]) {
  test(`B7: ${label} → ${reason}로 소진, 클라이언트는 오류를 보지 않는다`, async t => {
    const { am, port, seen } = await setup(t, [apiKey('api-1'), apiKey('api-2')], (e, res) => {
      if (e.who === 'api-1') return json(res, status, body);
      return json(res, 200, OK(e.who));
    });
    const res = await post(port);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).account, 'api-2');
    assert.equal(am.accounts[0].creditExhausted.reason, reason);
    assert.deepEqual(seen.map(e => e.who), ['api-1', 'api-2']);
  });
}

test('B7: 대안이 없으면 크레딧 오류 대신 기존 429 경로로 간다', async t => {
  const { am, port } = await setup(t, [apiKey('api-1')], (e, res) => json(res, 400, CREDIT_LOW));
  const res = await post(port);
  assert.equal(res.status, 429);
  const text = await res.text();
  assert.equal(text.includes('credit balance'), false, '상류 크레딧 문구를 그대로 넘기지 않는다');
  assert.equal(am.accounts[0].creditExhausted.reason, 'credit-exhausted');
  const status = am.getStatus();
  assert.equal(status.accounts[0].credit.exhausted, true);
});

test('B7: 프롬프트 문구가 섞여 돌아온 400은 키를 빼지 않고 그대로 전달한다', async t => {
  const echoed = { type: 'error', error: { type: 'invalid_request_error',
    message: "messages.0.content: 'Your credit balance is too low to access the Anthropic API' is not allowed here" } };
  const { am, port, seen } = await setup(t, [apiKey('api-1'), apiKey('api-2')], (e, res) => json(res, 400, echoed));
  const res = await post(port);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), echoed);
  assert.deepEqual(seen.map(e => e.who), ['api-1']);
  assert.equal(am.accounts[0].creditExhausted, undefined);
  assert.equal(am.accounts[0].status, 'active');
});

test('B7: 한 요청이 메시지 기반 400으로 영속 소진할 수 있는 키는 1개다(연쇄 400은 원래 오류로)', async t => {
  const { am, port, seen } = await setup(t, [apiKey('api-1'), apiKey('api-2'), apiKey('api-3')], (e, res) => json(res, 400, CREDIT_LOW));
  const flags = [];
  am.onAccountCreditFlag((account, value) => flags.push([account.name, value?.reason ?? null]));
  const res = await post(port);
  assert.equal(res.status, 400, '두 번째 키의 같은 400은 그 요청에만 그대로 돌려준다');
  assert.deepEqual(await res.json(), CREDIT_LOW);
  assert.deepEqual(seen.map(e => e.who), ['api-1', 'api-2']);
  assert.equal(am.accounts[0].creditExhausted.reason, 'credit-exhausted');
  assert.equal(am.accounts[1].creditExhausted, undefined, '두 번째 키는 영속 처리하지 않는다');
  assert.equal(am.accounts[1].status, 'active');
  assert.equal(am.accounts[2].creditExhausted, undefined);
  assert.deepEqual(flags, [['api-1', 'credit-exhausted']]);
});

test('B7: 구조화 신호(402 billing_error)는 요청당 제한 없이 영속 처리한다', async t => {
  const billing = { type: 'error', error: { type: 'billing_error', message: 'Payment required' } };
  const { am, port, seen } = await setup(t, [apiKey('api-1'), apiKey('api-2'), apiKey('api-3')], (e, res) => {
    if (e.who === 'api-3') return json(res, 200, OK(e.who));
    return json(res, 402, billing);
  });
  const res = await post(port);
  assert.equal(res.status, 200);
  assert.deepEqual(seen.map(e => e.who), ['api-1', 'api-2', 'api-3']);
  assert.equal(am.accounts[0].creditExhausted.reason, 'billing');
  assert.equal(am.accounts[1].creditExhausted.reason, 'billing');
});

test('B7: 크레딧과 무관한 400은 그대로 전달하고 계정을 건드리지 않는다', async t => {
  const plain = { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: field required' } };
  const { am, port } = await setup(t, [apiKey('api-1'), apiKey('api-2')], (e, res) => json(res, 400, plain));
  const res = await post(port);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), plain);
  assert.equal(am.accounts[0].creditExhausted, undefined);
  assert.equal(am.accounts[0].status, 'active');
});

test('B7: 구독(OAuth) 계정의 같은 문구 400은 크레딧 거절로 보지 않는다', async t => {
  const { am, port } = await setup(t, [oauth('sub-1')], (e, res) => json(res, 400, CREDIT_LOW));
  healthy(am.accounts[0]);
  const res = await post(port);
  assert.equal(res.status, 400);
  assert.equal(am.accounts[0].status, 'active');
});

test('B7: 일반 429는 지금처럼 처리하고 소진 플래그를 세우지 않는다', async t => {
  const { am, port } = await setup(t, [apiKey('api-1')], (e, res) =>
    json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'per-minute rate limit' } }, { 'retry-after': '1' }));
  const res = await post(port);
  assert.equal(res.status, 429);
  assert.equal(am.accounts[0].creditExhausted, undefined);
});

test('B4: 비스트리밍 성공 응답의 usage가 응답 모델 단가로 원장에 쌓인다', async t => {
  const { am, port } = await setup(t, [apiKey('api-1', { creditUsd: 50 })], (e, res) =>
    json(res, 200, OK(e.who, 'claude-haiku-4-5-20251001', { input_tokens: 1_000_000, output_tokens: 200_000, cache_read_input_tokens: 0 })));
  const res = await post(port);
  assert.equal(res.status, 200);
  await res.json();
  // 1M × $1 + 0.2M × $5 = $2
  assert.ok(Math.abs(am.accounts[0].quota.apiSpendUsd - 2) < 1e-9, String(am.accounts[0].quota.apiSpendUsd));
  assert.equal(am.getStatus().accounts[0].credit.remainingUsd, 48);
});

test('B4: 스트리밍 응답도 message_start 모델로 입력·출력 비용이 쌓인다', async t => {
  const { am, port } = await setup(t, [apiKey('api-1')], (e, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    res.write(ev('message_start', { message: { id: 'm', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1 } } }));
    res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
    res.write(ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200_000 } }));
    res.end(ev('message_stop', {}));
  });
  const res = await post(port, { body: { model: 'claude-haiku-4-5', stream: true, messages: [] } });
  assert.equal(res.status, 200);
  await res.text();
  // 입력 1M × $1 + 캐시 읽기 1M × $0.10 + 출력 0.2M × $5 = $2.10
  assert.ok(Math.abs(am.accounts[0].quota.apiSpendUsd - 2.1) < 1e-9, String(am.accounts[0].quota.apiSpendUsd));
});

test('B4: 단가 없는 모델은 unpriced 토큰으로 센다, 구독 계정 응답은 원장에 넣지 않는다', async t => {
  const { am, port } = await setup(t, [oauth('sub-1'), apiKey('api-1')], (e, res) =>
    json(res, 200, OK(e.who, 'claude-future-9', { input_tokens: 100, output_tokens: 20 })));
  healthy(am.accounts[0]);
  await (await post(port)).json();
  assert.equal(am.accounts[0].quota.apiSpendUsd, 0);
  assert.equal(am.accounts[0].quota.apiUnpricedTokens, 0);
  exhaust(am.accounts[0]);
  await (await post(port)).json();
  assert.equal(am.accounts[1].quota.apiUnpricedTokens, 120);
});

test('B8: API 키 요청에서만 anthropic-beta의 oauth- 토큰을 뺀다', async t => {
  const { am, port, seen } = await setup(t, [oauth('sub-1'), apiKey('api-1')], (e, res) => json(res, 200, OK(e.who)));
  healthy(am.accounts[0]);
  const beta = 'oauth-2025-04-20,prompt-caching-2024-07-31, claude-code-20250219';
  await (await post(port, { headers: { 'anthropic-beta': beta } })).json();
  assert.equal(seen[0].who, 'sub-1');
  assert.equal(seen[0].headers['anthropic-beta'], beta, 'OAuth 요청은 그대로');

  exhaust(am.accounts[0]);
  await (await post(port, { headers: { 'anthropic-beta': beta } })).json();
  assert.equal(seen[1].who, 'api-1');
  assert.equal(seen[1].headers['anthropic-beta'], 'prompt-caching-2024-07-31,claude-code-20250219');

  await (await post(port, { headers: { 'anthropic-beta': 'oauth-2025-04-20' } })).json();
  assert.equal('anthropic-beta' in seen[2].headers, false, '남는 토큰이 없으면 헤더째 뺀다');
});

test('B3: /byok 요청은 API 키를 먼저, /v1 요청은 구독을 먼저 쓴다', async t => {
  const { am, port, seen } = await setup(t, [oauth('sub-1'), apiKey('api-1')], (e, res) => json(res, 200, OK(e.who)),
    { byok: { enabled: true, apiKey: BYOK_KEY, minUsableAccounts: 0 } });
  healthy(am.accounts[0]);
  const viaByok = await post(port, { path: '/byok/v1/messages', headers: { 'x-api-key': BYOK_KEY } });
  assert.equal(viaByok.status, 200);
  await viaByok.json();
  const viaV1 = await post(port);
  await viaV1.json();
  assert.deepEqual(seen.map(e => e.who), ['api-1', 'sub-1']);
});

test('B3: /byok 요청은 API 키가 소진이면 구독으로 간다', async t => {
  const { am, port, seen } = await setup(t, [oauth('sub-1'), apiKey('api-1', { creditExhausted: { reason: 'billing', at: 1 } })],
    (e, res) => json(res, 200, OK(e.who)),
    { byok: { enabled: true, apiKey: BYOK_KEY, minUsableAccounts: 0 } });
  healthy(am.accounts[0]);
  const res = await post(port, { path: '/byok/v1/messages', headers: { 'x-api-key': BYOK_KEY } });
  assert.equal(res.status, 200);
  await res.json();
  assert.deepEqual(seen.map(e => e.who), ['sub-1']);
});

test('B3: 구독이 서빙 가능하면 /v1 요청은 API 키로 가지 않는다', async t => {
  const { am, port, seen } = await setup(t, [apiKey('api-1', { priority: 0 }), oauth('sub-1')], (e, res) => json(res, 200, OK(e.who)));
  healthy(am.accounts[1]);
  for (let i = 0; i < 3; i++) await (await post(port)).json();
  assert.deepEqual(seen.map(e => e.who), ['sub-1', 'sub-1', 'sub-1']);
});

test('config.apiPricing가 서버 원장에 적용된다', async t => {
  const { am, port } = await setup(t, [apiKey('api-1')], (e, res) =>
    json(res, 200, OK(e.who, 'claude-fable-5', { input_tokens: 1_000_000, output_tokens: 0 })),
  { apiPricing: { 'claude-fable-5': { input: 10, output: 50 } } });
  await (await post(port)).json();
  assert.equal(am.accounts[0].quota.apiSpendUsd, 10);
});
