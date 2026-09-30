# 웹에서 리셋했지만 All accounts exhausted가 남는 경우

## 원인 구분

웹 리셋은 프록시에 알림을 보내지 않습니다. 프록시는 마지막 응답의 사용량을 기억하므로, 리셋된 계정을 다시 측정해야 합니다. `Server is temporarily limiting requests (not your usage limit)` 문구만으로 실제 한도 여부를 판단하지 않습니다.

`teamclaude status`에서 계정의 enabled, error, throttle, 5h·7d·모델별 사용량을 확인합니다. 인증·조직 구독 오류는 [구독 접근 runbook](claude-subscription-disabled.md)으로 구분합니다. snapshot이나 인증 파일을 삭제하거나 사용량을 임의로 0으로 바꾸지 않습니다.

## 자동 재발 방지

- 저장된 정상 요청 template을 복원하면 차단 계정을 즉시 재측정합니다.
- 실행 중 웹 리셋은 `activeWarmup: true`, `warmupIntervalMs: 300000` 기본 설정에서 주기적으로 확인합니다. 계정별 재시도는 최소 1분, 기본 5분 간격입니다.
- 모델 전용 제한은 해당 모델의 정상 template으로 확인합니다. 하위 모델 요청이 들어와도 이 template을 유지하고 snapshot에 함께 저장합니다.
- 실제 429 제한은 유지하며, disabled/error/요청 처리 중/만료 임박 토큰/미래 throttle은 자동 probe에서 제외합니다.

5분은 보장된 복구 완료 시간이 아니라 측정 주기입니다. 토큰 갱신, 처리 중 요청, throttle, 상류 오류 또는 template 부재로 더 지연될 수 있습니다. `activeWarmup: false`는 자동 측정을 끄며 `warmupIntervalMs: 0`은 시작 시에만 측정합니다. 재시작 없이 계속 복구하려면 주기를 양수로 유지합니다.

## 복구 확인

1. 다음 warm-up 주기 이후 `teamclaude status`에서 웹에서 리셋한 계정의 사용량과 가용 상태가 갱신되는지 확인합니다.
2. 즉시 재측정이 필요하면 실행 중 TUI에서 `R`을 사용합니다. `R`은 실제 상류 요청을 사용하며 busy/error 계정은 건너뜁니다. template이 없으면 먼저 정상 요청 한 건이 필요합니다.
3. 상태만 확인하고 끝내지 말고 Claude에서 짧은 요청이 성공하는지도 확인합니다. 이미 긴 재개 대기에 들어간 클라이언트는 서버 복구와 별개이므로, 복구 후 해당 세션을 명시적으로 재개합니다.
4. 계속 차단되면 최신 실제 quota 응답과 상태를 대조합니다. 다른 계정의 웹 화면이나 다른 모델의 잔여 한도를 근거로 모든 제한을 해제하지 않습니다.

## 다음 업데이트에서 수정 유지

배포 후보에 `test/web-quota-reset.test.js`가 포함되어 있고 아래 검사가 통과해야 합니다.

```bash
node --test --test-concurrency=1 test/web-quota-reset.test.js
```

기본 브랜치의 `.github/workflows/tests.yml`은 `npm test -- --test-concurrency=1`로 이 테스트를 전체 회귀와 함께 실행합니다. PR의 같은 HEAD에서 CI와 독립 검토가 통과한 소스만 설치합니다. 이전 운영 패치 파일을 새 패키지 설치로 덮어쓰는 것만으로 업데이트 완료를 판단하지 않습니다.

설치 후 실행 파일과 새 프로세스가 같은 후보인지 확인하고 status와 실제 요청으로 검증합니다. 활성 요청은 drain한 뒤 재시작하며 실패하면 직전 검증된 runtime으로 롤백합니다. 인증·quota 파일을 다른 머신에서 덮어쓰지 않습니다.
