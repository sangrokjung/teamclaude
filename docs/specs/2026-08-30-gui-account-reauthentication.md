# GUI 계정 재인증

## 목표

TeamClaude macOS 그래픽 대시보드에서 인증 오류가 난 Anthropic OAuth 계정 옆에 `재인증 필요` 버튼을 표시하고, 선택한 계정과 새 OAuth profile의 동일성을 검증한 뒤에만 자격증명을 갱신합니다.

## 인수 조건

- `enabled=true`, `status=error`, `type=oauth`, Anthropic 계정에만 버튼이 표시됩니다.
- `subscription-disabled`, 비활성, API key, 다른 provider 계정에는 버튼이 표시되지 않거나 CLI에서 거부됩니다.
- 새 profile의 UUID가 기존 UUID와 일치해야 합니다. 기존 UUID가 없을 때만 계정 이름과 profile email의 일치를 허용합니다.
- OAuth 취소·오류·profile 불일치·동시 계정 교체 시 config는 변경되지 않습니다.
- 성공 시 기존 `enabled`, `priority`, `maxConcurrent`를 보존하고 실행 중 서버에 account-only reload를 요청합니다.

## 범위 밖

- 조직의 Claude Code 접근이 차단된 계정 복구
- API key 교체 및 Codex/Grok/Agy 재인증
- OAuth 공급자나 scope 변경
- 기존 TUI 재인증 흐름의 리팩터링

## 보안·데이터 계약

- OAuth token은 로그, 테스트 증거, UI에 출력하지 않습니다.
- config 갱신은 `atomicConfigUpdate`로 fresh disk snapshot 안에서 실행합니다.
- 대상은 최초 선택 시의 UUID와 이름으로 고정하며, 로그인 중 대상이 제거되거나 UUID가 바뀌면 fail closed 합니다.
- 새 credential은 profile 검증이 끝난 뒤 한 번만 config에 반영합니다.

## 검증

- Swift gating test: 표시/미표시 경계 RED→GREEN
- Node isolated integration: 일치 성공과 불일치·취소·동시 변경 rollback RED→GREEN
- Swift 전체 test/build와 Node targeted test/lint
- 실제 메뉴바 앱 재시작 후 접근성 버튼·스크린샷 확인, 운영 config hash 불변 확인

## 배포·롤백

- TeamClaude 전역 설치본의 변경 파일을 백업한 뒤 검증된 `src/index.js`와 필요한 모듈만 교체합니다.
- `cc-menubar`를 빌드한 뒤 현재 LaunchAgent 프로세스만 재기동합니다.
- 실패 시 백업 파일 복원 후 같은 프로세스 재기동으로 롤백합니다. config schema 변경은 없습니다.

## 승인 게이트

사용자가 2026-08-30에 그래픽 앱의 계정 옆 `재인증 필요` 버튼 구현을 명시적으로 지시했습니다. 실제 계정 OAuth 완료는 검증에서 수행하지 않습니다.

## 완료 검증 (2026-08-30)

- Swift: TeamClaude 73, Codex loader 16, TeamCodex pool 70, dashboard source 8개 모두 통과했습니다. 증거: `.omo/evidence/teamclaude-gui-reauth-swift-suite-final.txt`.
- Node: `test/reauth.test.js` 6개와 reviewer의 reauth/status/config 19개가 모두 통과했고, `ESLint`도 통과했습니다. 증거: `.omo/evidence/teamclaude-gui-reauth-node-final.txt`.
- GUI: 격리 메뉴 창에서 오류 OAuth 행에만 `재인증 필요` 버튼이 표시됐습니다. AX tree, 실제 클릭, UUID 불일치 fail-closed, 운영 config 해시 불변을 확인했습니다. 증거: `artifacts/ulw-re-auth/gui-qa/reauth-menu-window.png`와 같은 디렉터리의 `manual-qa-result.txt`.
- 배포: 전역 `teamclaude reauth` 명령이 사용법을 반환하고, 설치된 `reauth.js`는 공백을 제외하면 검증 소스와 동일합니다. 운영 `cc-menubar` LaunchAgent는 PID 98071로 실행 중이며 신규 crash report는 없습니다.
- cleanup: 격리 `cc-menubar-qa`, fake status server 39001, 임시 Swift 바이너리와 reviewer 스크립트를 모두 종료·제거했습니다.
- 독립 검토: CRITICAL/HIGH 없음, APPROVED. 보고서: `.omo/evidence/teamclaude-gui-reauth-independent-review.md`.
- 전체 Node 601개 중 변경과 무관한 기존 서버 연속성 테스트 2개(`server-429`, `server-model-fallback`)는 429 대신 502를 받아 실패했습니다. 재인증 관련 테스트는 모두 통과했습니다.
