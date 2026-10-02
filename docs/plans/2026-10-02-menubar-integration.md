# cc-menubar 통합 실행 계획

Spec: [관리 범위 및 인수 기준](../specs/2026-10-02-menubar-integration.md)

- [x] 검증된 메뉴바 파일·동반 수집 스크립트 이관, 출처 고정
- [x] 데스크톱 실행 제거, 루트 명령·설치·CI 연결
- [x] 전체 메뉴바 러너·빌드·스냅샷과 설치 회귀 검사
- [x] 운영 메뉴 QA·롤백 백업, 독립 Claude 정확성/운영 검토
- [x] 문서 동기화 및 루트 폴더 반영
- PR·최종 HEAD CI·머지 상태: [PR #49](https://github.com/sangrokjung/teamclaude/pull/49)의 checks와 merge commit을 정본으로 확인한다.

## Verification

- qworker `1790916204711271000-49927`, macOS 워커, rc=0 및 pull_rc=0. 메뉴바 러너 `ran=32 failed=0 known_red=1 skipped=4 env-skipped=1`; Swift 네 테스트는 짝 Python 러너에서 실행. 기존 known-red 두 메서드만 유지. 스냅샷 1개 성공, 바이너리 1.9MB.
- 설치 회귀 3개 통과: 경로 공백/앰퍼샌드, 백업 유지, launchctl 실패 시 바이너리·plist 복구, 데스크톱 실행 제거.
- 실제 설치 QA: 후보/설치 파일 SHA-256 `d8cda566ee9ec51eac2ca5e2ad52d18b0ae44f1e6e122119ec0423f7e6cdf395` 일치. LaunchAgent `com.qjc.cc-menubar`, PID 55522, runs=1, state=running.
- 실제 메뉴 접근성: `구독 지출과 한도 소진`, `TeamCodex 온라인`과 신규 계정 표시 유지. 메뉴 목록에서 `cc-visualizer 열기` 제거 확인.
- `npm pack --dry-run` 파일 31개, native payload 제외 유지. 수집기 구문 검사 성공. ESLint 외부 브라우저 주입 함수는 파일 범위에 명시; 수집기 진입점은 Python이 호출하므로 기존 unused 경고 1개.
- Node CI run `36965957689` 성공. 최종 HEAD CI·머지는 위 PR에서 확인한다.
- Claude Opus 추가 조사 1회, 독립 정확성/운영 리뷰 각 1회 실행. 코드 HEAD `819eac4`에 양쪽 APPROVE, CRITICAL/HIGH 없음. 실제 qworker 로그와 설치 테스트 로그를 검토했다. CLI 의견은 gate-owned receipt가 아니다.
- 구독 수집기 `com.qjc.cc-subscription-monitor`의 기존 plist를 백업한 뒤 ProgramArguments의 스크립트와 WorkingDirectory만 루트 teamclaude로 변경했다. plutil OK, bootstrap 성공, launchctl의 새 스크립트·작업 폴더·running 상태 확인. 외부 메일 수집 성공 여부는 이관 검증과 별도다.
- 기존 수동 QA 해시 검사는 과거 전용 plan을 이관하지 않아 현재 FileNotFoundError로 known-red 처리된다. 해당 assertion·예외 목록을 약화하지 않았다. 과거 수동 QA의 성공을 주장하지 않는다.
