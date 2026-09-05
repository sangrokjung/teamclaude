# 실행 계획 — Grok·Agy 구독 OAuth

1. `provider-config.js`에서 Grok/Agy를 OAuth provider로 정의하고 API-key shape를 fail-closed 검증한다.
2. `provider-oauth.js`에 Grok auth.json/Agy Keychain envelope import, Grok discovery refresh, Agy 명시적 refresh를 추가한다.
3. `account-manager.js`, `index.js`, `server.js`의 token refresh/import/login/env/run/api 경로를 provider OAuth contract에 연결한다.
4. OAuth fixture 테스트와 fake discovery/upstream capture를 RED→GREEN으로 실행한다.
5. README와 config examples를 subscription auth 기준으로 갱신한다.
6. targeted/full test·ESLint·CLI surface QA를 실행하고 모든 임시 프로세스/파일을 정리한다.
7. 독립 reviewer 2개 lane에서 보안·정확성·회귀를 검토하고 지적을 반영한다.

## Rollback

새 provider config/account 파일만 제거하고 기존 Claude/Codex 설정은 건드리지 않는다.
