# Token Usage Report 스킬·플러그인

사용자 승인 범위: 기존 개인용 리포트를 재사용 스킬로 일반화하고 sangrokjung/teamclaude에 공개. 추가 요구는 공유용 요약과 플러그인 설치. 자동 Star 대신 사용자가 누르는 GitHub 링크를 제공한다. 사용자 지시에 따라 기존 리포트 서버는 종료했다.

인수 조건: Python 3.10+ 표준 라이브러리로 Claude/Codex 로그의 5기간·작업유형·KST 24시간·모델별 가격·KRW 리포트를 생성. 경로는 실행 인자로 지정하며 한 벤더 또는 로그 없음도 처리. 결과는 서버 없이 열 수 있는 단일 HTML. 원천 프롬프트·절대경로·개인 집계·실행 로그는 배포 파일에 포함하지 않는다. 공유 버튼은 고정 카테고리 및 숫자만 새로 구성한 요약을 미리 보여준 후 복사/다운로드한다. 자동 업로드·자동 Star·인증 훅 없음.

패키지: 루트 .claude-plugin/plugin.json와 marketplace.json, skills/token-usage-report, 선택적 Codex 수동 설치 설명. 추가 런타임 의존성·프록시 변경 없음.

검증: 합성 로그로 Claude 단독/Codex JSONL/SQLite선택/중복/월경계/빈로그/HTML이스케이프/공유유출 방지 확인. 실제 단일HTML 브라우저의 기간·가격·공유/다운로드/모바일 확인. Claude Opus 조사 및 최종 적대검증 후 PR·필수CI·동일HEAD 머지.

롤백: 해당 PR revert로 스킬·메타데이터만 제거, 원천로그·프록시 미변경.
