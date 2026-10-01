# 재인증 복구 재발 방지 작업

Spec: [reauth contract](../specs/2026-10-01-reauth-reenable.md)

- [x] 설치본/작업 트리/머지된 login 수정 비교 및 Claude 추가 조사
- [x] reauth 초기 상태 기준선과 원자 저장 경합 방어 구현
- [x] 성공·실패·동시 변경·실제 CLI 테스트
- [x] 문서 동기화

출하 조건: Claude 두 관점 검증, 최종 HEAD의 CI와 PR 머지, 검증된 CLI 모듈 설치본 반영 및 임시 설정 QA. 최종 결과는 해당 PR의 checks/리뷰 증거와 작업 완료 보고에서 추적한다.

Verification: 대상 35/35 및 qgate 연관 111/111 테스트 통과(ticket 1790841789346494000-40168). 변경 파일 ESLint 및 node --check 통과. Anthropic CLI 콜백/토큰 교환/프로필 검사 정상 및 다른 계정 로그인 거부 QA 포함. 실제 외부 인증 서버 대신 격리된 fixture를 사용했다. 독립 검토 및 전체 테스트는 출하 조건으로 별도 확인한다.
