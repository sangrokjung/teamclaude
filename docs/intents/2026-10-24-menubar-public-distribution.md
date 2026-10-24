# 메뉴바 외부 배포

- Status: accepted (대표 2026-10-24 "gogo")
- 발의: 대표가 2026-10-24에 메뉴바를 GitHub로 공개해 다른 사람도 쓸 수 있게 하라고 했다. Agy(안티그래비티)·Grok·Higgsfield를 포함한 현재 기능은 하나도 빼지 않는다.
- 문제: `menubar/` 소스는 공개 저장소 기본 브랜치 `qjc/resilient-routing`에 있지만(PR #49·#64) 외부 사용자를 위한 배포물이 없다. 빌드한 앱 파일이 없어 사용자가 직접 swiftc로 빌드해야 하고, Apple Silicon 전용이다. 사내 환경을 전제로 한 부분도 남아 있다(재시작 버튼의 `com.qjc.teamclaude`, fnm 전용 탐색 경로, 사내 Codex 호출 기록 `~/.claude/cache/codex-call`, qgate·사내 브라우저 도구가 필요한 구독 수집기). 화면은 한국어만 지원한다.
- 제안 결과:
  1. 모든 카드(TeamClaude·TeamCodex·Agy·Grok·Higgsfield·ccusage)를 그대로 둔다. 해당 도구가 없는 맥에서는 오류 대신 "미설치" 안내 상태를 보여 준다.
  2. CLI 탐색 경로를 넓힌다(Homebrew·`/usr/local`·npm 전역·fnm·nvm·PATH). 재시작 버튼은 우리 launchd 서비스가 있을 때만 kickstart를 쓰고, 없으면 `teamclaude restart`로 대체한다.
  3. 구독 확인 수집기는 우리 맥에서만 켠다. 외부 사용자 화면에는 "수집기 미설치"로 표시한다(대표 결정).
  4. 화면과 README를 한국어·영어 두 언어로 만들고, 맥 언어 설정에 따라 자동으로 바꾼다(대표 결정).
  5. arm64+x86_64 유니버설 바이너리를 `.app` 번들로 묶는다. GitHub Release에 서명 없이 zip으로 올리고, 처음 여는 방법(우클릭→열기, `xattr`)을 안내한다(대표 결정: 애플 개발자 등록 안 함).
- 영향: 내부 운영 설치 경로(`~/Applications/cc-menubar`, `com.qjc.cc-menubar`)는 유지한다. 공개 저장소에 들어가므로 게시 전 사내 경로·기기 이름·계정 식별자 grep 스윕을 한다.
- 제약: 계정·인증·사용량 데이터 보존, 프록시 재시작 없음, 런타임 의존성 추가 없음, 공유 체크아웃의 남의 미커밋 작업 보존.
- 순서: 웹랩 디자인 시안(261024-menubar-a·b)에서 안을 고른 뒤 화면 이식과 번역을 함께 한다. 화면과 무관한 일반화(1·2·3·5)는 시안을 고르기 전에 먼저 진행할 수 있다.
- 열린 질문: 없음. README의 원 개발자 표기는 MIT 표기와 맞춰 유지한다(대표 무응답, 추천안 채택).

Related:
- Spec: docs/specs/2026-10-24-menubar-public-distribution.md
