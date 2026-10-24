import Foundation

// 값이 없는 칸을 화면이 저마다 다른 말로 채우고 있었다. "확인 필요"와 "확인필요"가 같은 뜻으로
// 섞이고, 같은 빈 값이 어떤 열에선 "측정전" 어떤 열에선 "-"였다. 읽는 사람은 그 차이가
// 의미인지 실수인지 구분할 수 없다(2026-09-24 실측).
//
// 값이 없는 이유는 네 가지뿐이고, 그 넷을 서로 다른 말로 고정한다.
enum StatusVocabulary {
    /// 아직 물어보는 중. 곧 값이 온다.
    static var checking: String { L10n.vocabChecking }
    /// 물어봤지만 답을 못 받았다. 사람이 손을 써야 한다.
    static var needsCheck: String { L10n.vocabNeedsCheck }
    /// 값을 받아오는 중. "확인 중"과 띄어쓰기를 맞춘다 — 같은 화면에서 한쪽만 붙여 쓰면 실수로 읽힌다.
    static var syncing: String { L10n.vocabSyncing }
    /// 잴 수 있는데 아직 재지 않았다.
    static var notMeasured: String { L10n.vocabNotMeasured }
    /// 값이 없는 것이 정상인 칸(측정 시각이 없는 계정 등).
    static let none = "—"
    /// 이 맥에 해당 도구가 없다. 오류가 아니라 안내다(외부 배포 R1).
    static var notInstalled: String { L10n.notInstalled }
    /// 도구는 있을 수 있지만 읽을 기록이 아직 없다.
    static var noData: String { L10n.vocabNoData }

    /// 마지막 성공이 오래된 레인에 붙는 꼬리말. 값 자체는 남기고 낡았다는 사실만 덧붙인다 —
    /// 지우면 무엇이 얼마나 낡았는지 알 수 없고, 그대로 두면 최신값으로 읽힌다.
    static func staleSuffix(minutes: Int) -> String {
        L10n.staleSuffix(max(minutes, 1))
    }
}
