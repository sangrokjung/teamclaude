# Token Usage Report 스킬·플러그인

Intent: [accepted 요청](../intents/2026-10-02-token-report-plugin.md). 등급 L, 기존 분석기를 범용 패키지로 추출한다.

사용자 승인 범위: 기존 개인용 리포트를 재사용 스킬로 일반화하고 sangrokjung/teamclaude에 공개. 추가 요구는 공유용 요약과 플러그인 설치. 자동 Star 대신 사용자가 누르는 GitHub 링크를 제공한다. 사용자 지시에 따라 기존 리포트 서버는 종료했다.

인수 조건: Python 3.10+ 표준 라이브러리로 Claude/Codex 로그의 5기간·작업유형·KST 24시간·모델별 가격·KRW 리포트를 생성. 경로는 실행 인자로 지정하며 한 벤더 또는 로그 없음도 처리. 결과는 서버 없이 열 수 있는 단일 HTML. 원천 프롬프트·절대경로·개인 집계·실행 로그는 배포 파일에 포함하지 않는다. 공유 버튼은 고정 카테고리 및 숫자만 새로 구성한 요약을 미리 보여준 후 복사/다운로드한다. 자동 업로드·자동 Star·인증 훅 없음.

패키지: 루트 .claude-plugin/plugin.json와 marketplace.json, skills/token-usage-report, 선택적 Codex 수동 설치 설명. 추가 런타임 의존성·프록시 변경 없음.

검증: 합성 로그로 Claude 단독/Codex JSONL/SQLite선택/중복/월경계/빈로그/HTML이스케이프/공유유출 방지 확인. 실제 단일HTML 브라우저의 기간·가격·공유/다운로드/모바일 확인. Claude Opus 조사 및 최종 적대검증 후 PR·필수CI·동일HEAD 머지.

롤백: 해당 PR revert로 스킬·메타데이터만 제거, 원천로그·프록시 미변경.

실행 계획: ① 개인 경로·DB 버전 의존 제거 → ② 단일 HTML·선택 환율·공유 요약 → ③ 스킬/플러그인/설치 문서 → ④ 합성 로그·브라우저 QA → ⑤ 교차 벤더 검증·PR·CI·머지. 공개는 코드와 합성 fixture만 포함하며 실제 결과는 로컬에 둔다.

검증 기록: Python 8 tests PASS (중복·벤더 ID 충돌·counter reset·KST 경계·8차원 합계·빈 로그·환율·HTML escape), Node 3 tests PASS (4성분·시나리오·미등록 가격·KRW·스크립트 파싱). Claude CLI의 plugin/marketplace validate PASS. 플러그인 루트의 기존 CLAUDE.md가 자동 context로 로드되지 않는다는 안내만 있으며 스킬 자체는 SKILL.md로 제공한다. Ego Lite 파일 URL QA 18 checks PASS: 5기간×3벤더, 가격과 KRW, 공유 분류·시간 합산/개인 sentinel 제외, JSON 다운로드, Escape와 focus 복원, 375px 다크·reduced-motion. 최종 교차 벤더 판정과 CI는 PR에서 확인한다.

디자인 출처: 기존 격리 Codex 세션의 Refero 대시보드 검색 화면 및 21st Traffic Range Switcher(ID 29215) 참고 결과를 재사용했다. Refero 상세는 로그인 제한으로 미열람. 글꼴은 설치된 Pretendard 우선, 없으면 시스템 글꼴이며 외부 폰트 요청은 없다.
