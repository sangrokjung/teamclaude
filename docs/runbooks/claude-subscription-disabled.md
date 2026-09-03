# Claude Code 조직 구독 접근 비활성화 대응

> 정상 구독 계정의 quota·동시성 상태를 연체로 오판하지 않는 절차와 qjc-agent
> 세션 상한 복구는
> [통합 재발 방지 runbook](subscription-and-agent-session-recovery.md)을 함께 따른다.

## 증상

`teamclaude run`으로 시작한 Claude Code가 다음 사용자 메시지와 HTTP 403으로 종료됩니다.

```text
Your organization has disabled Claude subscription access for Claude Code
```

실제 upstream 판정 값은 자연어 문구가 아니라 다음 구조화된 오류입니다.

```text
error.type=permission_error
error.details.error_code=oauth_not_allowed_for_organization
```

## 자동 처리

TeamClaude는 이 exact error code를 반환한 OAuth account만 `error`로 격리하고 다른 사용 가능한 account로 요청을 재전송합니다. 완결된 403 거부이므로 upstream 작업이 실행되지 않았다는 근거가 있으며, 이 경우에만 POST 내부 재전송을 허용합니다.

일반 permission 403, 자연어 문구만 비슷한 403, malformed JSON은 원본 그대로 전달하고 account 상태를 변경하지 않습니다.

## 확인 절차

1. Claude Code를 일반 `claude`가 아니라 `teamclaude run`으로 시작했는지 확인합니다.
2. `teamclaude status`에서 문제 account가 `error`로 바뀌고 다른 active account가 선택됐는지 확인합니다.
3. 수정 배포 직후라면 별도 터미널에서 `teamclaude restart`하고 listener와 status를 다시 확인합니다. 실행 중인 Claude 세션 내부에서 proxy를 중지하지 않습니다.
4. 모든 account가 `error`면 각 조직 관리 설정에서 Claude Code subscription access 허용 여부를 확인합니다.

## 복구

- 조직 정책이 수정된 뒤 해당 account를 `teamclaude import` 또는 `teamclaude login`으로 다시 검증합니다.
- 즉시 우회가 필요하면 `teamclaude disable <name>`으로 문제 account를 제외합니다.
- API key 자동 전환이나 source Claude config 수정은 하지 않습니다.

## 재발 확인

```bash
node --test test/server-403.test.js test/server-401.test.js
npx eslint src/ test/
```

전체 regression은 시스템 부하 게이트를 거쳐 실행합니다.

```bash
python3 ~/.claude/scripts/qgate.py run --slot heavy -- npm test
```

검증해야 할 세 경계는 exact error code failover, 모든 account 거부 시 마지막 원본 403 보존, error code가 없는 403의 무변경 pass-through입니다.

## Rollback

Config/schema/data migration은 없습니다. 회귀 시 문제 account를 disable해 운영 우회하고, 403 classifier·분기·test·문서 변경을 reverse-revert합니다.
