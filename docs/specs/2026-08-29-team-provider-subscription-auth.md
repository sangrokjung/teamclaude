# Grok·Agy 구독 OAuth 계정 풀

## Problem

현재 Grok·Agy provider는 API key만 저장·전달합니다. 공식 구독 CLI가 발급한 OAuth
credential을 계정별로 가져오거나 갱신할 수 없어 구독 계정 rotation을 사용할 수 없습니다.

## Goal

Grok은 `~/.grok/auth.json`의 OIDC access/refresh token을, Agy는 macOS Keychain의
consumer OAuth token을 TeamClaude의 0600 config에 저장하고 동일한 기존 account-manager
rotation·concurrency·proxy forwarding 경로로 사용합니다. API key는 두 provider에서
거부합니다.

## Non-goals

- 공식 Grok/Agy 서비스의 protobuf 또는 undocumented API를 추측해 재구현하지 않습니다.
- TeamClaude가 Google Keychain에 credential을 쓰거나 삭제하지 않습니다.
- provider 간 계정 혼합, credential 값의 status/log 출력, 외부 production 요청 자동화는 하지 않습니다.

## Requirements

1. Grok account shape: `provider: grok`, `type: oauth`, `accessToken`, `refreshToken`,
   `expiresAt`, `accountUuid`, `oauthIssuer`, `oauthClientId`.
2. Grok default upstream: `https://cli-chat-proxy.grok.com/v1`; request auth is
   `Authorization: Bearer`; refresh uses issuer discovery and public-client
   `grant_type=refresh_token` form request.
3. Agy account shape: `provider: agy`, `type: oauth`, `accessToken`, optional
   `refreshToken` (omitted or `null` when the issuer supplies none; otherwise a
   non-empty string), `expiresAt`, `accountUuid`, `authMethod`, optional
   `oauthTokenEndpoint`/`oauthClientId`, optional `projectId`.
4. Agy credential import accepts only a redacted-testable JSON/keychain envelope with
   `token.access_token`; malformed or API-key input fails closed. File imports require
   a provider-issued account identity. The Antigravity Keychain envelope currently omits
   that field, so Keychain login resolves `sub` through Google's OAuth userinfo endpoint
   with the same Bearer token and fails closed if no identity is returned. Refresh is
   attempted only when endpoint and client id are explicitly available.
5. `login`/`import` for Grok/Agy never accept `--api-key`; Grok login may run the official
   `grok login` in an isolated `GROK_HOME`, while Agy login imports the existing consumer
   Keychain entry and reports a precise setup error when absent.
6. Atomic config writes, UUID/name matching, token freshness and stale-refresh guards
   remain unchanged.

## Alternatives and decision

- Reuse Anthropic `oauth.js`: rejected because its issuer, client id and token endpoint
  are provider-specific.
- Keep API keys: rejected because they bypass the user's subscription entitlement.
- Implement undocumented Agy protobuf: rejected; use the confirmed `/v1internal` base
  and explicit configurable path/metadata, failing closed when required metadata is absent.

## Acceptance criteria

- OAuth-only validation accepts complete Grok/Agy fixtures, accepts Agy's absent or
  explicit-null optional refresh value, and rejects every `apikey` or missing required
  provider-specific auth field.
- Grok fixture import persists no API key, forwards Bearer to `/v1/chat/completions`, and
  refreshes through a captured discovery/token fake without logging token values.
- Agy keychain-envelope fixture imports, forwards Bearer to configured `/v1internal` path,
  rejects malformed envelopes and refuses refresh without explicit client metadata.
- Provider-prefixed CLI help/env/status expose subscription auth only; Claude/Codex tests
  remain green.

## Security and observability

Credentials are read only at import/refresh boundaries, stored in the existing 0600 config,
masked in request logs, excluded from status, and never included in evidence. Discovery and
upstream fetches use `redirect: manual`. Error messages identify missing fields, not values.

## Rollout and rollback

Roll out behind provider-specific config files (`teamgrok.json`, `teamagy.json`). Existing
API-key configs must be re-imported as OAuth and will fail startup until migrated. Rollback
is deleting only the new provider account entries/config files and restoring the prior release;
no Keychain mutation or destructive migration is performed.

## Verification

Targeted RED→GREEN tests, fake HTTP capture with redacted headers/body, CLI import/help/env
smoke, full `npm test`, ESLint, and independent security/accuracy review. Agy production
endpoint is not called by tests.
