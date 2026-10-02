// menubar/Tests/SubscriptionPolicyTests.swift
import Foundation

@main
struct SubscriptionPolicyTests {
    static func main() {
        func projection(_ value: Double?) -> BurnProjection {
            BurnProjection(current: value, projected: value, range: nil,
                           basis: .extrapolation(confidence: .normal))
        }
        func usage(lane: String = "claude", paid: Int = 17, contributing: Int = 7,
                   error: Int = 6, disabled: Int = 4,
                   weekly: Double? = 0.82, session: Double? = 0.11,
                   blocked: Int = 0) -> LaneUsage {
            LaneUsage(lane: lane, paidAccounts: paid, contributingAccounts: contributing,
                      errorAccounts: error, disabledAccounts: disabled,
                      weekly: projection(weekly), session: projection(session),
                      blockedMoments: blocked)
        }

        // 병목은 높은 쪽이다. 세션 11%로 판정하면 "한참 여유"라는 틀린 답이 나온다.
        precondition(burnBindingProjection(usage()).projected == 0.82)

        // 막힌 적이 있으면 전망과 무관하게 부족이다.
        precondition(burnVerdict(usage(weekly: 0.4, blocked: 2)) == .blocked)

        // 목표는 1.0이다. 넘겼고 막히지 않았으면 달성이다.
        precondition(burnVerdict(usage(weekly: 1.05)) == .onTarget)
        precondition(burnVerdict(usage(weekly: 0.9)) == .near)
        precondition(burnVerdict(usage(weekly: 0.7)) == .slack)
        precondition(burnVerdict(usage(weekly: 0.2)) == .excess)

        // 경계값을 못 박는다.
        precondition(burnVerdict(usage(weekly: 1.0)) == .onTarget)
        precondition(burnVerdict(usage(weekly: 0.85)) == .near)
        precondition(burnVerdict(usage(weekly: 0.6)) == .slack)

        // 기여 계정이 0이면 나눗셈이 터지지 않고 모른다고 말한다.
        let dead = usage(contributing: 0, error: 17, disabled: 0, weekly: nil, session: nil)
        precondition(burnVerdict(dead) == .unknown)
        precondition(burnNeededAccounts(dead) == nil)

        // 필요 계정 = 기여 × 사용률 ÷ 목표. 7 × 0.73 ≈ 5.1 이므로 올려서 6.
        precondition(burnNeededAccounts(usage(lane: "codex", paid: 7, contributing: 7,
                                              error: 0, disabled: 0, weekly: 0.73)) == 6)

        // 권고는 죽은 계정을 먼저 말한다. 순서를 뒤집으면 고칠 수 있는 문제에 돈을 쓰게 된다.
        let lines = burnRecommendations([usage(), usage(lane: "agy", paid: 1, contributing: 1,
                                                        error: 0, disabled: 0, weekly: 0.06)])
        precondition(lines.first?.contains("오류") == true, "\(lines)")
        precondition(lines.contains { $0.contains("agy") }, "\(lines)")

        // 해지된 계정은 "재인증"이 아니라 "정리"다. 살릴 수 없는 계정을 살리라고 하면 안 된다.
        let unsubscribed = LaneUsage(lane: "claude", paidAccounts: 11, contributingAccounts: 7,
                                     errorAccounts: 0, disabledAccounts: 4, unsubscribedAccounts: 6,
                                     weekly: projection(0.82), session: projection(0.11), blockedMoments: 0)
        let unsubLines = burnRecommendations([unsubscribed])
        precondition(unsubLines.contains { $0.contains("해지 6개") }, "\(unsubLines)")
        precondition(!unsubLines.contains { $0.contains("재인증") }, "해지에 재인증을 권하면 안 된다: \(unsubLines)")

        // 모두 정상이면 권고가 없다. 할 말이 없을 때 지어내지 않는다.
        precondition(burnRecommendations([usage(paid: 7, contributing: 7, error: 0, disabled: 0,
                                                weekly: 0.95)]).isEmpty)

        print("SubscriptionPolicyTests: 통과")
    }
}
