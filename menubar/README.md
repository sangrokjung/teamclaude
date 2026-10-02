# CC Menubar

TeamClaude·TeamCodex의 macOS 메뉴바와 클릭 사용량 대시보드입니다.
서버·TUI와 함께 이 저장소에서 관리합니다. 별도 데스크톱 앱은 필요하지 않습니다.
Swift/AppKit 네이티브 실행 파일이며 Electron, Tauri, React, npm 런타임 패키지를 사용하지 않습니다.

## 개발과 설치

Apple Silicon macOS 13+, Xcode Command Line Tools(Swift), Python 3가 필요합니다.
저장소 루트에서 실행합니다.

```sh
npm run menubar:test
npm run menubar:build
npm run menubar:install
# 이미 검증한 빌드를 설치할 때
npm run menubar:install -- --binary "$PWD/menubar/.build/cc-menubar"
```

`menubar:build`는 테스트와 스냅샷을 통과한 후보만 `menubar/.build/cc-menubar`로 저장합니다.
운영 앱은 바꾸지 않습니다. 설치는 기본 `~/Applications/cc-menubar/cc-menubar`에
백업 후 원자 교체하고 `com.qjc.cc-menubar` LaunchAgent를 등록합니다.
이 경로는 개발 checkout과 독립적이므로 과거 브랜치를 빌드해도 운영 화면이 바뀌지 않습니다.
기존 계정 설정·키체인·사용량 캐시·UserDefaults는 유지합니다.

호스트 부하가 높은 환경에서는 테스트/빌드를 조직의 qgate 또는 격리된 macOS 워커에서 실행하세요.
메뉴바 설치는 GUI 로그인 중인 해당 Mac에서 실행합니다. 프록시는 재시작하지 않습니다.

## 관리 범위

- `Sources/`: 메뉴바·계정 풀·사용량·구독·소진 전망
- `Tests/`, `run-tests.sh`: 기존 Swift/Python 회귀 검사
- `../scripts/subscription-monitor.py`, `subscription-monitor-browser.js`: 선택적인 구독 확인 수집기
- `build.sh`, `install.sh`: 독립 빌드와 설치

계정 데이터는 기존 `~/.config/teamclaude.json`, `~/.config/teamcodex.json`과 로컬 서버 상태를 읽습니다.
외부 CLI(Grok, Agy, Higgsfield, ccusage)는 해당 기능에만 사용되며 데스크톱 앱과 무관합니다.
구독 수집기는 기존 브라우저 도구와 qgate를 필요로 하는 선택 기능이며 메뉴바 설치가 자동 실행하지 않습니다.
기존 수집기 LaunchAgent가 옛 저장소를 가리킨다면 그 `ProgramArguments`의 스크립트 경로와
`WorkingDirectory`를 이 저장소로 함께 옮겨야 합니다. 사용자 메일함 라이브 검사는 기본 실행하지 않습니다.

## 이관 출처와 검증 한계

`sangrokjung/cc-visualizer` 커밋 `ff70e27742208d4eea0900e98945abcc9810d9fa`의
`menubar/` 및 두 구독 수집 스크립트에서 이관했습니다. 원 개발자: Sangrok Jung.
현재부터 메뉴바 변경의 정본은 이 저장소입니다. 원 저장소의 데스크톱 앱은 이 프로젝트의 빌드·배포 대상이 아닙니다.

기존 러너는 availability의 초/일 경계 검사와 과거 로컬 QA 해시 검사 두 메서드를
known-red로 별도 집계합니다. 외부 메일함 검사는 opt-in입니다. 이관하면서 예외 목록이나 assertion을 넓히지 않습니다.
