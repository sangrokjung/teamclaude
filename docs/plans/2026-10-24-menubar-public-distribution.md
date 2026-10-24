# Plan: 메뉴바 외부 배포 Phase 1
- Spec: docs/specs/2026-10-24-menubar-public-distribution.md
- STATUS: APPROVED (대표 2026-10-24 "gogo", 대화에서 요지 5항과 진행 순서를 승인)

범위: spec R1–R4, R6–R9. R5(번역)와 디자인 이식은 Phase 2.

## Task 1: 공통 미설치 상태 (R1)
- 각 카드 로더(AgyUsage, GrokUsage, HiggsfieldCredits, ccusage 로더, CodexStatusParsing의 codex-call, TeamClaude/TeamCodex status, AccountSubscription)의 "도구 없음/데이터 없음" 결과를 하나의 상태 값으로 모은다.
- 그리기 지점마다 그 상태를 렌더한다(메모리 `deliver-state-to-every-consumer`: 소비 지점별 테스트).
- 테스트: 빈 HOME 스냅샷(A1).

## Task 2: CLI 탐색 일반화 (R2)
- 공용 `ToolLocator`: env 재정의 → 로그인 셸 `command -v`(2초 제한, 프로세스 수명 동안 캐시) → 기존 후보 + npm prefix·nvm·Volta. 기존 개별 탐색 함수는 이 locator를 호출한다. 후보 목록은 지금 것을 모두 포함한다.
- 테스트: env 재정의, 후보 순서, 시간 제한 대체.

## Task 3: launchd 라벨 일반화 (R3)
- 라벨은 env > UserDefaults > 기본값 `com.qjc.teamclaude`. 미등록이면 `teamclaude server`를 분리 실행해 시작만 한다. PR #64의 불변식(살아 있는 프록시에 -k 금지)과 기존 테스트를 유지한다.
- 테스트: A4.

## Task 4: 구독 수집기 미설치 표시 (R4)

## Task 5: 유니버설 .app 번들 (R6)
- `menubar/build.sh`는 기존 동작(단일 arm64 → `.build/cc-menubar`, install.py 호환)을 유지한다. 새 `menubar/package-app.sh`는 arm64·x86_64를 컴파일하고 `lipo`로 합친 뒤 `.build/CC Menubar.app`을 만들고(Info.plist, `LSUIElement`), ad-hoc 서명과 zip, sha256까지 한다.
- 무거운 컴파일은 로컬에서 qgate를 거친다.

## Task 6: Release 워크플로 (R7)
- `.github/workflows/menubar-release.yml`: `push: tags: ['menubar-v*']`와 `workflow_dispatch`. 테스트 → package-app → 아티팩트 업로드. 태그일 때만 draft Release를 만든다.

## Task 7: 설치 안내와 스윕 (R8, R9)
- `menubar/README.md`에 "외부 사용자 설치" 절을 추가한다(Phase 2에서 영문·한국어로 분리).
- 로그인 시 자동 시작: 앱 메뉴 항목으로 사용자 LaunchAgent(`~/Library/LaunchAgents/dev.teamclaude.cc-menubar.plist`)를 등록·해제한다. 내부 `com.qjc.cc-menubar` 설치는 건드리지 않는다.
- R9 grep 스윕.

## 완료 조건
spec A1–A4, A6, A7. PR → CI(menubar-tests) → Codex astra receipt → 머지. Release 공개는 대표 확인 후.
