# cc-menubar 통합

Intent: [사용자 확정 범위](../intents/2026-10-02-menubar-integration.md)

## Goal / Requirements

서버·TUI·macOS 메뉴바를 teamclaude 한 저장소에서 관리한다. 기존 검증된 메뉴바 소스·테스트·독립 빌드를 이관하고 데스크톱 앱 실행 항목을 제거한다. Swift/AppKit와 기존 외부 CLI 사용을 유지하며 Node 런타임 의존성은 추가하지 않는다.

## Non-goals

데스크톱 앱 코드/React/Tauri/Electron 이관, UI 재설계, 계정 자동 동기화 개선, 기존 저장소/사용자 데이터 삭제, 프록시 운영 바이너리 교체.

## Acceptance criteria

1. `menubar/` 소스와 테스트가 다른 저장소 없이 빌드된다.
2. 메뉴의 계정·사용량·구독·소진 화면을 유지하며 데스크톱 앱 열기는 사라진다.
3. 루트 npm 명령으로 메뉴바 테스트·빌드·설치가 가능하다. 프록시 npm 배포는 기존 files 범위를 유지한다.
4. 운영 LaunchAgent는 `~/Applications/cc-menubar/cc-menubar`를 실행한다. 개발 빌드는 운영 앱을 교체하지 않는다.
5. 실제 메뉴 QA와 교차 벤더 리뷰, CI 및 PR 머지를 확인한다.

## Decision / Migration

규모 L: 다수 파일을 기존 최신 검증 구현에서 이관한다. 사용자 요청이 관리 범위·이관 승인이며 별도 동작 확장은 하지 않는다. 이관 기준은 cc-visualizer PR #24의 머지 내용이다. 메뉴바와 연결된 구독 상태 수집 스크립트 두 개만 함께 유지한다.

## Risks / Concerns

기존 메뉴바 러너의 known-red 2개 메서드와 외부 메일함 opt-in 검사를 명시적으로 유지한다. 허용 목록을 넓히거나 기존 assertion을 약화하지 않는다. 기존 루트 작업 폴더는 dirty이므로 격리 worktree에서 구현하고 현재 변경과 겹치지 않는 이관 파일만 루트에도 반영한다. source Claude 설정은 수정하지 않는다.

## Rollout / Rollback / Observability

테스트와 빌드 후 별도 운영 경로에 후보 파일을 원자 교체한다. 기존 바이너리·plist는 백업하고 메뉴바 LaunchAgent만 재등록한다. 메뉴 접근성 트리·프로세스 경로·해시·계정 수를 확인한다. 실패하면 백업 바이너리·plist로 복원하고 같은 LaunchAgent를 재등록한다.

## Verification

아직 실행 전. 실제 결과는 연결된 plan에 기록한다.
