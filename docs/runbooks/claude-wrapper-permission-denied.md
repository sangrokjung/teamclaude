# 로컬 Claude 래퍼의 `permission denied` 재발 방지

별도로 관리하는 `~/.local/bin/claude` 래퍼가 설치된
`teamcodex/src/index.js`를 직접 `exec`하면, 해당 JavaScript 파일의 실행 권한이
없을 때 Claude가 시작되지 않습니다. 2026-09-05에는 파일 권한이 `0444`인
상태에서 이 오류를 확인했습니다. 권한이 변경된 원인은 확인되지 않았습니다.
`chmod u+x`는 즉시 복구 방법이지만 재설치 시 권한이 다시 바뀔 수 있습니다.

## 수정 방법

로컬 `teamcodex` 런처가 Node로 JavaScript를 실행하는지 먼저 확인합니다.
실행 방식이 `exec "$node_bin" "$legacy_entry" "$@"`인 관리형 런처라면,
Claude 래퍼의 마지막 호출을 다음처럼 변경합니다. 경로는 머신에 맞게 지정합니다.

```sh
# 변경 전: JavaScript 파일 자체에 실행 권한이 필요합니다.
exec '/absolute/path/node_modules/teamcodex/src/index.js' run -- "$@"

# 변경 후: Node로 실행하는 관리형 런처를 사용합니다.
exec '/absolute/path/to/managed/teamcodex' run -- "$@"
```

일반 npm의 `teamcodex` 명령은 JavaScript 파일을 가리키는 symlink일 수 있으므로,
그 명령으로 경로만 바꾸면 같은 문제가 남습니다. 관리형 런처가 없다면 기존
호출 앞에 실행 가능한 Node의 절대 경로를 지정합니다.

```sh
exec '/absolute/path/to/node' '/absolute/path/node_modules/teamcodex/src/index.js' run -- "$@"
```

기존 `TEAMCLAUDE_PROVIDER=anthropic`, native Claude 경로와
`TEAMCLAUDE_SESSION_SUPERVISED` 재귀 방지 분기는 유지합니다. 이 수정은 머신별
래퍼에 적용합니다. 이 문서를 저장소에 추가하는 것만으로 각 머신의 래퍼가
자동 업데이트되지는 않습니다.

## 검증

변경 후 `zsh -n /absolute/path/to/claude`, `claude --version`, `claude --help`로
확인합니다. 이번 로컬 수정에서는 JavaScript 파일의 실행 비트를 임시로 제거한
상태에서도 두 Claude 명령이 exit 0으로 종료했으며, 검증 후 기존 권한을 복원했습니다.
Node나 npm 설치 경로를 변경할 때는 관리형 런처의 경로도 다시 확인합니다.
