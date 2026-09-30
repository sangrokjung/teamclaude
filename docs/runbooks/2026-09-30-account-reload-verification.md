# 계정 재적용 검증 기록

- 목표: 같은 설치의 두 공식 CLI 진입점 사이에서 계정 변경이 서버 재시작 없이 반영된다.
- 범위 제외: 다른 설치 디렉터리 허용, lifecycle 인증 완화, quota 판정 변경.
- 원인: `process.argv[1]`만 비교해 `teamclaude.js`와 `index.js`를 다른 런타임으로 처리했다. 높은 호스트 부하에서는 프로세스 조회가 기본 전체 1.5초 예산을 소진했다.
- 변경: 같은 source 디렉터리의 두 entry 실경로만 인정하고, 계정 변경 명령의 전체 발견 예산을 30초로 설정한다. 기존 프로세스·리스너·config·lifecycle 검증은 유지한다.
- 정리: 변경 범위를 entry 비교, 계정 변경 대기, 해당 회귀 테스트로 제한했다. 기존 로그인 재활성화 구현은 그대로 사용한다.
- 테스트: `node --test test/account-upsert.test.js test/account-upsert-cli.test.js test/server-state-ownership.test.js` 최종 16/16 PASS, 11624ms. 두 변경 코드/테스트 파일 ESLint와 `git diff --check` PASS. 별도 build step 없음.
- 실표면: 설치본의 동일 두 지점 수정 후 일반 `teamclaude enable` 명령이 환경변수 override 없이 재적용 성공을 출력했다. supervisor/worker PID는 유지됐다. 대상 계정은 `enabled:true`, `status:active`, `errorReason:null`이며 요청·토큰 기록이 증가했다. 이후 `usable:false`는 live 5h quota rejected 때문이다.
- 추가 검토: Claude Opus 조사 호출은 429 `All 17 accounts exhausted`, 검증 호출은 120초 timeout으로 실패했다. Codex metis 보조 검토에서 발견한 Node 18 ESM fixture 누락을 수정했다. 이 보조 검토는 교차 벤더 승인이 아니다.
- 상태: UNVERIFIED. Claude의 최신 변경 검토가 성공하기 전 PR 머지/완료 선언을 하지 않는다.
- 복구: CLI 변경 두 지점만 되돌릴 수 있다. 서버 재시작은 하지 않았고 config/schema migration은 없다.
