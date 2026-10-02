# Token Usage Report

Claude Code와 Codex의 로컬 로그를 읽어 작업 유형, 프로젝트, KST 시간대, 최근 30일·1년 추이, API 가격 환산을 보여주는 Claude Code 플러그인 스킬입니다.

## 설치

Claude Code에서 이 저장소를 플러그인 소스로 추가하거나, 스킬 디렉터리를 개인 스킬 폴더에 복사하세요.

```text
/plugin marketplace add sangrokjung/teamclaude
/plugin install teamclaude-token-usage-report@teamclaude
```

Claude Code를 재시작한 뒤 `/teamclaude-token-usage-report:token-usage-report`로 호출합니다. 마켓플레이스 설치는 저장소 기본 브랜치를 사용합니다.

Codex에서는 저장소를 clone한 후 `skills/token-usage-report` 디렉터리를 `${CODEX_HOME:-$HOME/.codex}/skills/token-usage-report`에 복사하고 `$token-usage-report`로 호출하세요. 이미 같은 이름이 있으면 덮어쓰지 말고 먼저 비교하세요.

## 생성

```bash
python3 skills/token-usage-report/scripts/run_report.py --output ./token-report-output --fetch-fx
open ./token-report-output/report.html
```

Python 3.10+ 표준 라이브러리만 사용합니다. 프록시 설치나 실행은 필요하지 않습니다. `--fetch-fx`를 생략하면 네트워크 없이 실행되며 환율을 화면에서 입력할 수 있습니다. `--fx 1400`으로 지정하거나 `--prices custom.json`으로 모델별 가격표를 바꿀 수 있습니다. `--help`에서 로그 경로 옵션을 확인하세요.

리포트의 공유 버튼은 개인 프로젝트·세션 이름을 제외한 요약을 복사하거나 다운로드합니다. 원본 HTML·data.json은 개인 정보가 포함된 로컬 결과이므로 공개하지 마세요. GitHub Star는 수동 링크만 제공합니다.

최근 1시간·24시간·7일·30일·365일, KST 0–23시, 개발·하네스·콘텐츠 등 작업 분류와 API 비교 비용을 제공합니다. 기록 없음은 실제 0 사용을 뜻하지 않으며, API 환산액은 구독 청구액이나 구독 한도 소진율이 아닙니다. 저장된 단가 기준일을 화면에서 확인하고 미등록 모델은 직접 입력하세요.

검증: `python3 skills/token-usage-report/scripts/test_trends.py`와 `node --test skills/token-usage-report/tests/*.test.mjs`.
