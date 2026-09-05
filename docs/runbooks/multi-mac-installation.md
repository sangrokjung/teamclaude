# TeamClaude / TeamCodex 다중 Mac 설치

## 운영 모델

MacBook과 Mac Studio마다 독립된 로컬 프록시를 실행합니다. 각 프록시는 자신의
`127.0.0.1` listener, config, OAuth refresh chain, quota snapshot, state file을
소유합니다. 한 머신의 프록시를 다른 머신이 중앙 서버처럼 공유하는 구성은 이
runbook의 범위가 아닙니다.

## 사전 확인

각 Mac에서 다음을 실행합니다.

```bash
TARBALL_PATH=/absolute/path/teamcodex-<version>.tgz
tar -xOf "$TARBALL_PATH" package/scripts/install-macos.sh | bash -s -- --check-only
```

PASS 기준은 macOS(Darwin), Node.js 18 이상, npm이 확인되고
`credentials/config: untouched`가 출력되는 것입니다.

## 같은 버전 설치

배포할 source checkout에서 tarball을 한 번 만듭니다.

```bash
TARBALL=$(npm pack --silent)
TARBALL_PATH="$PWD/$TARBALL"
shasum -a 256 "$TARBALL_PATH"
```

같은 tarball을 각 Mac에 안전한 방법으로 전달한 뒤 설치합니다.

```bash
TARBALL_PATH=/absolute/path/teamcodex-<version>.tgz
tar -xOf "$TARBALL_PATH" package/scripts/install-macos.sh |
  bash -s -- --source "$TARBALL_PATH"
command -v teamclaude
command -v teamcodex
teamclaude help
teamclaude codex help
```

설치 스크립트는 실행 중인 프록시를 stop/restart하지 않습니다. 업데이트 적용이
필요하면 해당 머신의 진행 중 요청을 종료한 뒤 그 머신에서만 `teamclaude restart`
또는 `teamclaude codex restart`를 실행합니다.

## 머신별 로그인

두 Mac에서 각각 실행합니다.

```bash
teamclaude login
teamclaude codex login --name <account-name>
```

이미 해당 Mac의 공식 CLI로 로그인했다면 `teamclaude import` 또는
`teamclaude codex import`를 사용할 수 있습니다.

다음 파일을 Mac 사이에 복사·동기화하지 않습니다.

- `~/.config/teamclaude.json`
- `~/.config/teamcodex.json`
- `~/.claude/.credentials.json`
- `~/.codex/auth.json`
- `*.quota.json`, `*.server.json`

OAuth refresh token은 갱신 과정에서 교체될 수 있습니다. 같은 refresh chain을 두
프록시가 사용하면 한 머신의 갱신이 다른 머신의 저장값을 폐기할 수 있습니다.

## 기동과 확인

각 Mac에서 독립적으로 확인합니다.

```bash
teamclaude server
teamclaude status
teamclaude codex server
teamclaude codex status
```

기본 경로는 Claude `~/.config/teamclaude.json`/port `3456`, Codex
`~/.config/teamcodex.json`/port `3457`입니다. 두 머신의 동일 port는 서로 다른
localhost이므로 충돌하지 않습니다.

## 업데이트와 롤백

1. 새 tarball의 SHA-256을 두 Mac에서 대조합니다.
2. installer로 같은 tarball을 설치합니다.
3. 진행 중 요청이 없는 머신부터 해당 provider만 재시작합니다.
4. `status`와 실제 `run`을 확인한 뒤 다음 머신으로 이동합니다.
5. 문제가 생기면 직전 tarball을 다시 installer에 전달하고 해당 머신의 provider만
   재시작합니다. config와 OAuth 파일은 롤백 대상이 아닙니다.
