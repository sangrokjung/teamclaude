# GUI 계정 재인증 실행 계획

1. `cc-visualizer/menubar`의 status model에 provider를 전달하고 재인증 노출 조건을 순수 함수로 고정합니다.
2. `TeamClaudeTableView`에 계정별 `NSButton`과 callback을 추가하고 AppDelegate에서 대상 이름을 고정한 CLI command를 엽니다.
3. TeamClaude CLI에 `reauth <name>`을 추가해 OAuth profile 동일성 검증 후 `atomicConfigUpdate`로 대상 credential만 교체합니다.
4. Swift/Node 격리 테스트에서 happy path, 잘못된 profile, disabled/subscription-disabled, 동시 target 변경을 검증합니다.
5. 두 프로젝트의 targeted test, build, lint를 통과시킵니다.
6. 전역 TeamClaude 설치본과 LaunchAgent 앱을 백업·배포하고 실제 macOS 메뉴에서 접근성 버튼과 화면을 확인합니다.
7. 독립 적대 리뷰 후 기준 위반이 없으면 증거와 rollback 위치를 기록합니다.

## 완료 상태 (2026-08-30)

1. 완료 — provider·UUID·오류 사유를 표시 모델에 전달하고 순수 gating을 고정했습니다.
2. 완료 — 계정 행 `NSButton`, 접근성 children, callback을 연결했습니다.
3. 완료 — `teamclaude reauth`와 UUID/profile fail-closed 원자 갱신을 구현했습니다.
4. 완료 — 성공·취소·불일치·disabled·subscription-disabled·동시 UUID 교체를 격리 검증했습니다.
5. 완료 — Swift 73/16/70/8, Node targeted 6, ESLint와 menubar build가 통과했습니다.
6. 완료 — 전역 CLI와 LaunchAgent 앱을 배포하고 실제 격리 메뉴 창·AX·클릭·운영 config 불변을 확인했습니다.
7. 완료 — 독립 reviewer가 CRITICAL/HIGH 없음으로 승인했습니다.
