# Spec: 메뉴바 외부 배포
- Intent: docs/intents/2026-10-24-menubar-public-distribution.md
- Status: draft
- Grade: L

## Problem

`menubar/`(CC Menubar, Swift/AppKit) 소스는 공개 저장소 기본 브랜치에 있지만, 외부 사용자가 받아서 쓸 배포물이 없다. 빌드는 `swiftc -target arm64-apple-macosx13.0` 단일 바이너리라서 Apple Silicon 전용이고 `.app` 번들도 없다. 사내 환경을 전제로 한 곳도 있다.

- `teamClaudeLaunchdLabel = "com.qjc.teamclaude"` 고정 (`main.swift`, `TeamClaudeServerControl.swift`)
- CLI 탐색이 fnm·Homebrew 고정 경로 중심 (`HiggsfieldCredits.swift`, `main.swift`의 node/teamclaude 탐색)
- 사내 Codex 호출 기록 `~/.claude/cache/codex-call/calls.jsonl` 읽기 (`CodexStatusParsing.swift`)
- 구독 수집기(`scripts/subscription-monitor*.{py,js}`)가 qgate와 사내 브라우저 도구에 의존
- 화면 문구가 한국어뿐

## Goal

외부 macOS 사용자가 GitHub Release에서 zip을 받아 열면, 우리와 같은 기능 전체(TeamClaude·TeamCodex 풀, Agy, Grok, Higgsfield, ccusage, 소진 전망, 구독 카드)를 쓸 수 있다. 해당 도구가 없는 맥에서는 그 카드가 오류 대신 "미설치" 안내 상태로 보인다. 내부 운영 설치와 동작은 바뀌지 않는다.

## Non-goals

- 애플 개발자 서명·공증 (대표 결정: 서명 없이 배포)
- 외부용 구독 수집기 새로 만들기 (대표 결정: 우리 맥에서만 켬)
- 카드·기능 삭제
- 프록시(Node) 동작 변경, 프록시 재시작
- 웹랩 시안(261024-menubar-a·b)의 디자인 결정 자체. 이식은 대표가 안을 고른 뒤 Phase 2에서 한다

## Requirements

R1. 도구별 카드(Agy·Grok·Higgsfield·ccusage·TeamClaude·TeamCodex·Codex 호출 기록·구독)는 도구나 데이터가 없을 때 하나의 공통 "미설치/데이터 없음" 상태를 그린다. 크래시, 빈 카드, 원시 오류 문자열을 보여 주지 않는다.
R2. CLI 탐색 순서를 일반화한다. 환경변수 재정의(`CC_MENUBAR_<TOOL>_BIN`) → 기존 경로 후보(내부 설치 결과 불변) → 로그인 셸 PATH(`/bin/zsh -lc 'command -v <tool>'`, 2초 제한, 기존 후보가 하나도 없을 때만) → Homebrew(`/opt/homebrew`, `/usr/local`) → npm 전역 prefix → fnm·nvm·Volta 기본 별칭 → `~/.local/bin`. 기존 경로 후보는 모두 유지한다. (구현 중 조정: 기존 후보를 로그인 셸보다 앞에 둔다. 내부 맥의 탐색 결과를 그대로 두고, launchd 아래 zsh 정지 위험을 줄이기 위해서다.)
R3. launchd 라벨은 `CC_MENUBAR_TEAMCLAUDE_LABEL` 환경변수 또는 UserDefaults로 바꿀 수 있고, 기본값은 `com.qjc.teamclaude`로 둔다. 라벨이 launchd에 등록돼 있지 않으면 kickstart 대신 `teamclaude server`를 분리 실행해 시작만 한다. 살아 있는 프록시를 강제로 재시작하지 않는다는 PR #64의 불변식은 유지한다.
R4. 구독 수집기 상태 파일(`~/.local/state/cc-menubar/subscription-monitor.json`)이 없으면 구독 영역에 "수집기 미설치(선택 기능)"를 표시한다.
R5. 화면 문구를 한국어·영어로 제공하고 시스템 선호 언어로 고른다(`Locale.preferredLanguages`의 첫 항목이 `ko`로 시작하면 한국어, 아니면 영어). 사용자 노출 문자열은 하나의 테이블에서 관리한다. README는 영문 `menubar/README.md`와 한국어 `menubar/README.ko.md`를 둔다. **Phase 2**에서 디자인 이식과 함께 한다.
R6. 빌드 스크립트가 arm64·x86_64를 각각 컴파일하고 `lipo`로 유니버설 바이너리를 만든다. 이를 `CC Menubar.app`(Info.plist의 `LSUIElement=true`, 최소 macOS 13) 번들로 묶는다. 서명 없이 ad-hoc(`codesign -s -`)만 한다.
R7. GitHub Actions 워크플로가 태그 `menubar-v*`에서 테스트, 유니버설 빌드, zip, SHA256을 만들고 Release 초안(draft)에 첨부한다.
R8. 외부 사용자용 설치 안내: zip 다운로드 → Applications로 이동 → 첫 실행 우클릭→열기, 또는 `xattr -dr com.apple.quarantine`. 로그인 시 자동 시작(LaunchAgent 등록 스크립트 또는 앱 메뉴의 "로그인 시 열기"). 기존 `install.py`의 내부 설치 경로는 유지한다.
R9. 공개 게시 전 스윕: 사내 경로(`/Users/<이름>`), 기기 이름, 계정 이메일·UUID, 내부 IP가 diff와 Release 산출물에 없어야 한다.

## Acceptance criteria

- A1. 도구가 하나도 없는 빈 HOME(`HOME=$(mktemp -d)`)에서 앱이 크래시 없이 뜨고, 스냅샷 렌더에 카드마다 미설치 상태가 그려진다(스냅샷 테스트 추가).
- A2. 기존 Swift/Python 테스트 전부 통과(`bash menubar/run-tests.sh`), `known-red.sh` 분류 외 신규 실패 0.
- A3. `lipo -archs` 결과가 `x86_64 arm64`이고, `.app`의 `Info.plist`에 `LSUIElement`가 있다.
- A4. 라벨 미등록 환경에서 재시작 버튼이 kickstart를 호출하지 않는다(단위 테스트).
- A5. (Phase 2) 영어 로케일에서 스냅샷에 한글이 0자이고, 한국어 로케일에서는 A안 문구가 그려진다(A안에 없는 화면은 기존 문구 그대로). (Phase 2 구현 중 조정: 처음 문구 "한국어 로케일에서는 기존 문구와 같다"는 승인된 A안 계획의 "한국어는 A안 문구"와 충돌해 고쳤다.)
- A6. Release 워크플로가 태그 없이 `workflow_dispatch` 시험 실행으로 zip 산출물을 만든다(Release 게시는 하지 않음).
- A7. R9 스윕 grep 결과 0건.

## Alternatives

- 서명·공증: 대표가 거절(비용·등록 부담).
- Homebrew cask: 서명 없는 앱은 cask 정책상 불리하다. 후속 과제로 미룬다.
- SwiftPM/Xcode 프로젝트 전환: 현재 swiftc 단일 스크립트와 테스트 체계를 깨므로 하지 않는다.

## Decision

swiftc 스크립트를 유지하고 아키텍처별 2회 컴파일, `lipo`, 수동 번들 조립 방식으로 간다. 기능은 삭제 없이 상태 처리로 일반화한다.

## Migration

내부 운영 설치는 `install.py`가 계속 단일 바이너리를 `~/Applications/cc-menubar/`에 둔다. `.app`은 외부 배포 전용 추가 산출물이다. 사용자 설정·키체인·캐시 경로는 그대로 둔다.

## Rollout

1. Phase 1(R1–R4, R6–R9): PR, CI, 독립 검토, 머지. 내부 설치 교체는 하지 않는다(대표 요청 시).
2. Phase 2(R5 + 웹랩 디자인 이식): 대표가 시안을 고른 뒤 진행한다.
3. 첫 Release 게시(태그 push와 draft 공개 전환)는 외부 발행이므로 대표 확인 후 한다.

## Rollback

PR revert. Release는 draft로 만들어지므로 공개 전 삭제할 수 있다. 공개 후 문제가 생기면 Release 삭제와 태그 삭제로 되돌린다.

## Observability

기존 `~/.claude/cache/cc-menubar*.log`·crash 로그를 유지한다. 도구 탐색 결과(찾은 경로·미설치)를 시작 로그에 한 줄씩 남긴다.

## Runbook

외부 사용자가 "앱이 손상됐다"는 경고를 보면 `xattr -dr com.apple.quarantine "/Applications/CC Menubar.app"`로 해결한다. 카드가 미설치로 뜨는데 도구가 있다면 `CC_MENUBAR_<TOOL>_BIN`으로 경로를 지정하게 안내한다.

## Risks

- 로그인 셸 PATH 조회가 느린 셸 설정 때문에 멈출 수 있다. 시간 제한(2초)과 결과 캐시로 막는다.
- Intel 컴파일에서 아키텍처 의존 코드가 깨질 수 있다. CI(macos-14)에서 두 타깃을 모두 컴파일한다.
- 서명 없는 앱은 macOS 업데이트에 따라 차단이 더 엄격해질 수 있다(받아들인 위험).

## Concerns

1. 외부 발행(공개 Release)은 `work-agreements.md` §3·`golden-principles.md` #17의 비가역·외부 행동이다. 머지는 자율 위임 범위지만 Release 공개는 대표 확인이 필요하다. 해소: Rollout 3으로 분리.
2. 공개 저장소 게시 경계(메모리 `public-repo-publication-boundary`): R9 스윕으로 해소.
3. 화면 UI 변경은 `web-design-cycle.md`·`anti-slop-design.md` 대상이다. Phase 1은 상태 문구 추가 수준이고, 디자인 사이클은 Phase 2에서 적용한다. 보류(Phase 2).
4. 구독 수집기를 외부에서 끄는 결정은 "모든 기능"과 일부 상충한다. 대표가 명시적으로 결정(우리 맥에서만)했으므로 해소.

## Verification

Phase 1: `bash menubar/run-tests.sh`, 신규 빈 HOME 스냅샷 테스트, `lipo -archs`, 라벨 미등록 단위 테스트, workflow_dispatch 시험 실행, R9 grep, Codex astra gate receipt.

Phase 2: `bash menubar/run-tests.sh`(qgate), 빈 HOME 스냅샷의 탭별 미설치 그리기(`TAB-DRAWN`), `Tests/snapshot_test_locale.py`(영어 한글 0자·한국어 A안 문구, 그려진 글자 기록으로 판정), A안 시안과 나란히 둔 실제 패널 PNG(`menubar/.build/`), Codex astra gate receipt.

## Open questions

없음. 원 개발자 표기는 유지한다(intent 참고).
