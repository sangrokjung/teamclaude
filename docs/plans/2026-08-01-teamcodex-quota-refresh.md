# TeamCodex 계정별 사용량 자동 갱신 실행 계획

1. Codex rate-limit header를 window 길이 기준으로 5시간·7일에 분류합니다.
   - 검증: primary 10080분과 300분 fixture
2. 공식 WHAM usage JSON을 기존 quota 모델로 변환합니다.
   - 검증: base limit과 additional limit 중 `codex` window 선택
3. Codex provider에서 시작 직후·주기·수동·live config-sync refresh를 single-flight로 실행합니다.
   - 검증: 계정별 인증 header, 추가·삭제 반영, 실패 격리, timer close
4. 전체 테스트 후 실행 중 proxy를 정상 재시작하고 status·메뉴바를 실제 확인합니다.
   - 검증: 5개 계정 측정, PID 교체 1회, native snapshot
5. 독립 reviewer가 spec·diff·실행 증거를 대조합니다.

## Verification

- RED: duration fixture는 5h expected `0.17`, actual `0.41`; WHAM startup fan-out은 0회로 timeout했습니다.
- GREEN: targeted quota/Codex 테스트 50/50, 부하 게이트 전체 테스트 416/416, `npx eslint src/ test/`, `git diff --check`가 통과했습니다.
- Live: launchd supervisor PID `25844 → 56612`; `/teamclaude/status`에서 5/5 계정이 최소 한 개의 공식 usage window를 측정했습니다. 3개 계정은 5시간·7일, 해당 플랜이 7일 창만 제공한 2개 계정은 7일만 표시합니다.
- 메뉴바: 실제 PNG snapshot에서 5/5 row와 각 7일 값, 3개 5시간 값을 확인했습니다.
- Adversarial lane: 최초 BLOCK(non-Codex additional limit 오분류) → Sora 91% RED fixture 추가 → `limit_name === 'codex'` 필터 후 재검토 PASS. 최종 CRITICAL/HIGH 0건입니다.
