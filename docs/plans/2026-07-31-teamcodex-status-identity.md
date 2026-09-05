# TeamCodex status 계정 정체성 실행 계획

1. `AccountManager.getStatus()`에 nullable account UUID 필드를 추가합니다.
   - 검증: stable identity 노출과 credential 비노출 테스트
2. 메뉴바 status parser가 UUID를 읽고 config와 UUID-first로 결합합니다.
   - 검증: same-name/different-UUID fixture
3. 기존 UUID 없는 server 응답은 이름 fallback으로 호환합니다.
   - 검증: 기존 TeamCodex pool parser 테스트
4. qgate에서 TeamCodex 전체 테스트와 메뉴바 빌드·self-test를 실행합니다.

## Verification

완료 시 실행 결과와 exact review SHA를 기록합니다.
