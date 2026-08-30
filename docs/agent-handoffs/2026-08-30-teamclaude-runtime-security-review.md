# TeamClaude 계정 상태 검토 — runtime security 기준

## Goal

가져온 Claude 세션의 진단을 현재 TeamClaude 실표면과 대조하고, 자격 증명이나 운영 설정을 변경하지 않은 채 계정 상태를 정확히 보고합니다.

## Security constraints

- 검증 대상은 localhost의 읽기 전용 `GET /teamclaude/status`입니다.
- redirect를 허용하지 않고 최종 응답 URL이 요청 URL과 정확히 같은지 확인합니다.
- 응답에서 자격 증명·token·API key를 출력하거나 evidence에 기록하지 않습니다.
- 응답 트리 전체에 credential/token/API key/authorization 필드가 없는지 확인합니다.
- OAuth 재로그인, 계정 enable/disable, priority 변경, config 저장은 이 검토 범위 밖입니다.
- `error` 계정은 상태와 개수만 검증하며 사용자 식별 정보는 산출물에 추가하지 않습니다.

## Acceptance

- 세션 `3cd98898-9177-450e-a2f9-6c42422e07d5`의 handoff가 존재합니다.
- `http://127.0.0.1:3456/teamclaude/status`가 HTTP 200을 반환합니다.
- 최종 실표면은 전체 16계정, `active` 16계정, `error` 0계정을 반환하며 verifier가 이 정확한 집계를 assertion으로 고정합니다.
- 검증 전후 TeamClaude 운영 config와 로컬 OAuth import source에는 변경이 없습니다.
