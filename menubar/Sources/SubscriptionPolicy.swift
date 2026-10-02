import Foundation

// 목표 사용률은 1.0이다. 주간 한도를 남기지 않고 다 쓰는 것이 이 풀의 운영 목표다.
// 그래서 100% 도달은 실패가 아니라 달성이고, 진짜 부족은 한도 때문에 실제로 막힌 것이다.
let burnTargetUtilization: Double = 1.0

enum BurnVerdict: Equatable {
    case blocked    // 가용 0이 관측됨
    case onTarget   // 목표 달성
    case near       // 근접
    case slack      // 여유
    case excess     // 과다
    case unknown    // 잴 수 없음
}

struct LaneUsage: Equatable {
    let lane: String
    /// 돈이 나가는 계정 수. 해지된 계정은 뺀다 — 넣으면 지출이 실제보다 크게 잡히고,
    /// 그 숫자로 "줄이자"는 결정을 하게 된다(2026-09-27 실측: 17계정 중 6개가 해지 상태였다).
    let paidAccounts: Int
    let contributingAccounts: Int
    /// 재인증·복구로 살아날 수 있는 오류. 해지는 여기 넣지 않는다.
    let errorAccounts: Int
    let disabledAccounts: Int
    /// 구독이 끝난 계정. 돈도 안 나가고 살릴 수도 없다. 정리 대상이다.
    let unsubscribedAccounts: Int
    let weekly: BurnProjection
    let session: BurnProjection
    let blockedMoments: Int

    init(lane: String, paidAccounts: Int, contributingAccounts: Int, errorAccounts: Int,
         disabledAccounts: Int, unsubscribedAccounts: Int = 0,
         weekly: BurnProjection, session: BurnProjection, blockedMoments: Int) {
        self.lane = lane
        self.paidAccounts = paidAccounts
        self.contributingAccounts = contributingAccounts
        self.errorAccounts = errorAccounts
        self.disabledAccounts = disabledAccounts
        self.unsubscribedAccounts = unsubscribedAccounts
        self.weekly = weekly
        self.session = session
        self.blockedMoments = blockedMoments
    }
}

/// 주간과 세션 중 사용률이 높은 쪽이 병목이고, 병목이 판정을 지배해야 한다.
func burnBindingProjection(_ usage: LaneUsage) -> BurnProjection {
    let weekly = usage.weekly.projected ?? -1
    let session = usage.session.projected ?? -1
    return session > weekly ? usage.session : usage.weekly
}

func burnVerdict(_ usage: LaneUsage) -> BurnVerdict {
    if usage.blockedMoments > 0 { return .blocked }
    guard let projected = burnBindingProjection(usage).projected else { return .unknown }
    if projected >= burnTargetUtilization { return .onTarget }
    if projected >= 0.85 { return .near }
    if projected >= 0.60 { return .slack }
    return .excess
}

/// 필요 계정 = 기여 계정 × 사용률 ÷ 목표 사용률. 소수는 올린다.
/// 내리면 목표에 못 미치는데, 이 화면의 목표는 다 쓰는 것이지 모자라는 것이 아니다.
func burnNeededAccounts(_ usage: LaneUsage) -> Int? {
    guard usage.contributingAccounts > 0,
          let projected = burnBindingProjection(usage).projected,
          burnTargetUtilization > 0 else {
        return nil
    }
    return max(1, Int(ceil(Double(usage.contributingAccounts) * projected / burnTargetUtilization)))
}

/// 권고는 순서를 지킨다. 기여하지 않는 계정을 먼저 말하고 계정 수 조정은 그다음이다.
/// 죽은 계정을 살리면 분모가 커져 사용률이 떨어지므로, 순서를 뒤집으면
/// 고칠 수 있는 문제에 돈을 쓰게 된다.
func burnRecommendations(_ usages: [LaneUsage]) -> [String] {
    var lines: [String] = []
    let errors = usages.reduce(0) { $0 + $1.errorAccounts }
    if errors > 0 { lines.append("오류 \(errors)개 재인증이 먼저") }
    // 해지된 계정은 살릴 수 없다. "재인증"이라고 하면 없는 계정을 살리려 든다.
    let unsubscribed = usages.reduce(0) { $0 + $1.unsubscribedAccounts }
    if unsubscribed > 0 { lines.append("해지 \(unsubscribed)개 풀에서 정리") }
    let disabled = usages.reduce(0) { $0 + $1.disabledAccounts }
    if disabled > 0 { lines.append("꺼 둔 \(disabled)개 유지 여부 결정") }
    for usage in usages where burnVerdict(usage) == .excess {
        if usage.paidAccounts > 1, let needed = burnNeededAccounts(usage),
           needed < usage.contributingAccounts {
            lines.append("\(usage.lane) \(usage.contributingAccounts - needed)개 줄일 여지")
        } else if usage.paidAccounts == 1 {
            lines.append("\(usage.lane) 다운그레이드 검토")
        }
    }
    return lines
}
