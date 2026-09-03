# Claude Code post-dispatch 502 대응

## 증상

`teamclaude run`으로 시작한 Claude Code에 다음 오류가 표시됩니다.

```text
API Error: 502 Upstream connection failed after dispatch. Request was not replayed.
This is a server-side issue, usually temporary — try again in a moment.
If it persists, check your inference gateway (localhost:3456).

Send feedback with /feedback or learn more: https://support.claude.com/en/articles/15363606
Request ID: req_...
```

`Request ID`는 upstream 로그 상관관계 확인용 진단 값입니다. `/feedback` 링크와
Request ID 자체는 별도 장애가 아니며, 실제 판정은 Claude transcript의 구조화된
필드와 고정 오류 문구를 함께 사용합니다.

## 의미와 안전 경계

이 오류는 local proxy가 요청을 upstream에 dispatch한 뒤 연결이 끊겼다는
뜻입니다. upstream이 inference를 실행했는지 proxy가 증명할 수 없으므로 같은
POST를 proxy 내부에서 다른 account로 재전송하면 중복 inference·비용이 발생할
수 있습니다.

따라서 다음 경계를 고정합니다.

1. Proxy는 원본 POST를 정확히 한 번만 dispatch하고 완결된 502를 반환합니다.
2. Account를 error로 오염시키거나 자동 회전하지 않습니다.
3. Codex handoff로 바꾸지 않습니다.
4. `teamclaude run` launcher는 동일 session ID를 UI-only로 다시 열며 `continue`를 보내지 않습니다.
5. 같은 502가 반복되면 전용 budget을 소진하고 추가 자동 reopen도 하지 않습니다.

## 자동 처리 조건

다음 조건이 모두 일치할 때만 `ambiguous_dispatch`로 분류합니다.

```text
isApiErrorMessage = true
error = server_error
apiErrorStatus = 502
message = API Error: 502 Upstream connection failed after dispatch. Request was not replayed. ...
```

공백 정규화와 Claude의 알려진 gateway 안내, `/feedback` URL, `Request ID` suffix는
허용합니다. 사용자 prompt, status 500/503/529, 다른 error type, 앞뒤에 임의
문구가 붙은 메시지, `Upstream stream failed`는 이 경로로 처리하지 않습니다.

오류 뒤 정상 user/assistant 대화가 이미 이어졌다면 해결된 것으로 보고 launcher가
중복 resume하지 않습니다. 오류와 정상 기록이 서로 다른 filesystem write로 나뉘는
경우도 처리하도록 `ambiguous_dispatch`만 최대 1초의 bounded settle window를 둔 뒤
다시 확인합니다. 다른 Login/429/ConnectionRefused 복구 경로의 즉시 처리 semantics는
바꾸지 않습니다.

## 설정

```json
{
  "autoResumeClaude": true,
  "claudeAutoResumeBackoffMs": 2000,
  "claudeAmbiguousDispatchMaxResumes": 1
}
```

- `0`: 자동 safe-reopen 비활성화
- `1`: 기본값. 한 번만 같은 session UI를 자동으로 다시 엶
- `2+`: 반복 safe-reopen 허용. 어떤 값에서도 launcher가 `continue`를 자동 전송하지 않음

이 budget은 `claudeAutoResumeMaxRetries`와 분리됩니다. 일반 retry 상한이 `0`이어도
첫 exact 502는 전용 budget으로 한 번 복구할 수 있습니다.

## 확인 및 복구 절차

1. 세션이 일반 `claude`가 아니라 `teamclaude run`으로 시작됐는지 확인합니다.
2. 별도 터미널에서 `teamclaude status`와 listener를 확인합니다.
3. 화면의 Request ID를 보존하고 같은 시각의 proxy/upstream 로그와 대조합니다.
4. 첫 자동 safe-reopen에서도 같은 502가 반복되면 upstream/tunnel 상태를 먼저
   복구합니다. budget을 즉시 늘리지 않습니다.
5. 이미 직접 실행한 legacy 세션은 `teamclaude run -- --resume <session-id>`로
   전환합니다. cmux 자동 adoption은 `cmuxSessionRescue: true`일 때만 동작합니다.

실행 중인 supervised Claude 세션 안에서 `teamclaude stop` 또는 `restart`를 실행하지
마세요. 해당 명령은 거부되며, 의도적인 재시작은 별도 터미널에서 수행합니다.

## 재발 검증

```bash
node --test test/claude-recovery.test.js test/cmux-session-rescue.test.js
node --test test/server-network-failover.test.js test/run-recovery.test.js
npx eslint src/ test/
```

필수 oracle:

- Exact classifier와 near-miss 오탐 방지
- 일반 retry 상한 0에서도 첫 502 동일 session UI-only reopen 1회
- 반복 502에서 전용 budget 초과 reopen 0회
- upstream body 수락 후 RST에도 proxy의 원본 POST hit 1회
- launcher recovery 이후 두 번째 upstream marker 0회
- account rotation·Codex handoff 0회
- 같은 chunk 및 split-write로 해결된 transcript와 stale offset의 중복 resume 0회

## Rollback

Schema나 data migration은 없습니다. 회귀 시
`claudeAmbiguousDispatchMaxResumes: 0`으로 launcher safe-reopen만 즉시 끄고,
classifier·launcher branch·cmux kind·tests·문서 변경을 함께 reverse-revert합니다.
