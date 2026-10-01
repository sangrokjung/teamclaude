# 명시적 CLI 재인증으로 기존 비활성 계정 복구

Intent: [accepted intent](../intents/2026-10-01-reauth-reenable.md)
Scope: L (인증 경계). 사용자 재발 방지 위임 범위 안의 복구 변경.

## 계약

- `reauth` 시작 시 비활성/조직 격리 계정도 OAuth를 시작할 수 있다.
- 계정 UUID/이메일, provider, 전체 인증 필드를 검증한 뒤에만 토큰을 저장하고 기존 `enabled:false`, `subscriptionDisabled:true`를 해제한다.
- 로그인 진행 중 새 disable 또는 조직 격리가 추가되면 원자 저장 단계에서 거부한다.
- 취소, 불완전 토큰, 다른 계정 로그인은 설정을 변경하지 않는다.
- priority, maxConcurrent, subscriptionCancellation 및 다른 계정은 유지한다.
- TUI 재인증 노출, login/import 동작, 외부 서비스 권한과 토큰 정책은 범위 밖이다.

## 결정과 한계

인증 전 상태를 스냅샷으로 보관하고 원자 저장 시 대조한다. 상태가 바뀌었다가 원래 값으로 돌아오는 ABA 경합까지 감지하는 새 영구 세대 필드는 도입하지 않는다. 새 조직 거부 응답은 기존 요청 경로가 다시 격리한다. 직접 호출하는 `applyReauthToConfig`는 기준선 없는 비활성 계정을 계속 거부한다.

## 검증

초기 비활성/조직 차단 각각과 동시 상태, 실패 시 무변경, 로그인 도중 플래그 추가, CLI 실제 실행(임시 설정/가짜 OAuth), 기존 reauth/upsert/config/403 테스트. 전체 테스트는 CI에서 직렬 실행. Node 소스 직접 실행이므로 빌드 없음. Claude Opus 두 관점 독립 검토(정확성/보안 및 실행 증거 대조) 후 머지.

## 적용/롤백

검증된 `src/reauth.js`만 실제 설치본의 같은 파일과 대조해 백업 후 교체한다. CLI는 실행마다 파일을 읽으므로 프록시 재시작이 필요 없다. 다른 런타임 파일은 교체하지 않는다. 문제 발생 시 백업 파일 복원 또는 PR revert. 이 변경은 설정 스키마를 바꾸지 않는다.
