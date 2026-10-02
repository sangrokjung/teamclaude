# cc-menubar 통합 실행 계획

Spec: [관리 범위 및 인수 기준](../specs/2026-10-02-menubar-integration.md)

- [x] 검증된 메뉴바 파일·동반 수집 스크립트 이관, 출처 고정
- [x] 데스크톱 실행 제거, 루트 명령·설치·CI 연결
- [x] 전체 메뉴바 러너·빌드·스냅샷과 설치 회귀 검사
- [ ] 운영 메뉴 QA·롤백 백업, 독립 Claude 정확성/운영 검토
- [ ] 문서 동기화, PR·CI·머지 및 루트 폴더 반영

## Verification

- qworker `1790916204711271000-49927`, studio3, rc=0 및 pull_rc=0. 메뉴바 러너 `ran=32 failed=0 known_red=1 skipped=4 env-skipped=1`; Swift 네 테스트는 짝 Python 러너에서 실행. 기존 known-red 두 메서드만 유지. 스냅샷 1개 성공, 바이너리 1.9MB.
- 설치 회귀 3개 통과: 경로 공백/앰퍼샌드, 백업 유지, launchctl 실패 시 바이너리·plist 복구, 데스크톱 실행 제거.
- 실제 설치 QA: 후보/설치 파일 SHA-256 `d8cda566ee9ec51eac2ca5e2ad52d18b0ae44f1e6e122119ec0423f7e6cdf395` 일치. LaunchAgent `com.qjc.cc-menubar`, PID 55522, runs=1, state=running.
- 실제 메뉴 접근성: `구독 지출과 한도 소진`, `TeamCodex 온라인`과 신규 계정 표시 유지. 메뉴 목록에서 `cc-visualizer 열기` 제거 확인.
- `npm pack --dry-run` 파일 31개, native payload 제외 유지. 수집기 구문 검사 성공. ESLint 외부 브라우저 주입 함수는 파일 범위에 명시; 수집기 진입점은 Python이 호출하므로 기존 unused 경고 1개.
- Node CI run `36965957689` 성공. 최종 HEAD CI·정확성/운영 독립 리뷰·머지는 후속 확인 대상.
