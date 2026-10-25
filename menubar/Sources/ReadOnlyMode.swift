import Foundation

/// 읽기 전용 실행(`--live-snapshot`). 실행 중인 앱과 같은 로더로 실제 데이터를 읽어 그리기만 하고,
/// 아무것도 바꾸지 않는다: 프록시 자동 동기화·재시작 없음, 구독 프로필 조회(네트워크·UserDefaults 쓰기) 없음,
/// 쿼터 이력·Codex 세션 통계 캐시 파일 쓰기 없음. 운영 앱은 이 값을 켜지 않는다.
enum MenubarRunMode {
    static var readOnly = false
}
