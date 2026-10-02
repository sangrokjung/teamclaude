---
name: token-usage-report
description: Claude Code와 Codex의 로컬 사용 로그를 프로젝트·작업 유형·시간대·1개월·1년 추이와 API 가격(USD/KRW)으로 분석하고, 개인정보를 줄인 공유 요약을 만드는 스킬.
metadata:
  short-description: Claude·Codex 토큰 분석 리포트
---

# Token Usage Report

로컬 Claude Code transcript와 Codex rollout을 읽어 토큰 사용량을 비교 가능한 HTML 리포트로 만듭니다. 사용자의 로그를 외부로 보내지 않고, 생성 결과도 지정한 로컬 출력 폴더에만 저장합니다.

## 실행

```bash
python3 skills/token-usage-report/scripts/run_report.py \
  --output ./token-report-output \
  --home "$HOME" \
  --fetch-fx
open ./token-report-output/report.html
```

리포트는 데이터와 자산을 하나의 `report.html`에 내장하므로 HTTP 서버 없이 열 수 있습니다. 환율을 고정하려면 `--fx 1400`을 사용하세요. 공개 환율 조회는 `--fetch-fx`를 선택했을 때만 실행하며 사용 로그는 전송하지 않습니다.

Python 3.10 이상이 필요합니다. 설치된 스킬에서 실행할 때는 위 명령의 스크립트 경로를 이 SKILL.md와 같은 폴더의 `scripts/run_report.py` 절대 경로로 바꾸세요. macOS는 `open`, Windows는 파일 탐색기, Linux는 브라우저에서 결과 파일을 엽니다.

Claude 또는 Codex 한쪽 기록만 있어도 생성됩니다. 경로가 다른 환경은 `--claude-projects`, `--codex-home`, 선택적인 `--codex-db`로 지정합니다. SQLite 없이도 JSONL을 읽습니다. 분석 대상은 최근 1년이며 1시간·24시간·7일·30일·365일을 제공합니다. 30일은 KST 일별, 1년은 KST 월별입니다. 기존 결과가 있는 폴더는 덮어쓰지 않으므로 새 출력 경로를 사용하세요.

## 결과 해석

- 처리 토큰은 입력·캐시 생성·캐시 읽기·출력의 합입니다. 캐시 제외 지표은 별도 선택값입니다.
- 작업 유형은 첫 요청·제목·프로젝트·브랜치 키워드 기반의 세션 단위 추정입니다. 근거 없는 세션은 `분류 미확정`으로 남깁니다.
- 로그가 보존되지 않은 기간은 실제 사용량 0으로 단정하지 않습니다. 화면의 `기록 없음`과 관측 범위를 확인하세요.
- 가격은 현재 `assets/pricing.json`의 API 정가를 적용한 비교용 추정액입니다. 실제 구독 청구액이 아니며 미등록 모델은 소계에서 제외됩니다.
- 개인 로그·프로젝트명·세션 ID를 외부에 게시하지 마세요.

## 공유와 GitHub

리포트의 `공유용 요약` 버튼은 프로젝트명과 세션 ID를 제거한 기간·벤더·분류·피크 시간 요약을 브라우저에서 다시 만들고, 복사 또는 JSON 다운로드만 제공합니다. 자동 업로드나 자동 GitHub Star는 제공하지 않습니다. `GitHub에서 보기 · Star`는 사용자가 직접 확인하고 선택하는 링크입니다.

## 파일 계약

- `scripts/run_report.py`: 수집, 모델별 성분 검증, 선택적 환율 조회, 단일 HTML 생성.
- `scripts/analyze.py`: Claude/Codex 로그 수집과 5개 기간 집계.
- `scripts/attach_models.py`: 8개 집계 차원에서 모델별 토큰 성분 합계를 검증.
- `assets/`: HTML에 내장되는 정적 대시보드와 가격 스냅샷. 로컬 Pretendard가 없으면 시스템 글꼴을 사용합니다.
- `scripts/test_trends.py`: 개인 로그 없이 실행하는 경계·중복·모델 합계 테스트.

새 모델 가격은 `assets/pricing.json`에 공식 가격 출처와 함께 추가하세요. API 응답·인증정보·원천 대화는 결과 파일이나 공유 요약에 넣지 않습니다.
