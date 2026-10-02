// menubar/Tests/SubscriptionBurnLayoutTests.swift
import Foundation

@main
struct SubscriptionBurnLayoutTests {
    static func main() {
        // 금액은 입력됐을 때만 숫자다.
        precondition(burnAmountLabel(nil, accounts: 17) == "미입력")
        precondition(burnAmountLabel(280_000, accounts: 17) == "4,760,000")
        precondition(burnAmountLabel(280_000, accounts: 0) == "0")
        // 통화 기호는 금액 앞에 붙고, 미입력에는 붙지 않는다.
        precondition(burnAmountLabel(200, accounts: 11, currency: "$") == "$2,200")
        precondition(burnAmountLabel(nil, accounts: 11, currency: "$") == "미입력")

        // 전망 표시는 근거를 함께 말한다.
        let extrapolated = BurnProjection(current: 0.82, projected: 1.12, range: nil,
                                          basis: .extrapolation(confidence: .normal))
        precondition(burnProjectionLabel(extrapolated).contains("82%"))
        precondition(burnProjectionLabel(extrapolated).contains("112%"))
        precondition(burnProjectionLabel(extrapolated).contains("추정"))

        let low = BurnProjection(current: 0.05, projected: 0.5, range: nil,
                                 basis: .extrapolation(confidence: .low))
        precondition(burnProjectionLabel(low).contains("신뢰 낮음"))

        let history = BurnProjection(current: 0.4, projected: 0.79, range: 0.61...0.97,
                                     basis: .history(cycles: 4))
        let label = burnProjectionLabel(history)
        precondition(label.contains("4주"), label)
        precondition(label.contains("61") && label.contains("97"), "범위를 함께 보인다: \(label)")

        precondition(burnProjectionLabel(
            BurnProjection(current: nil, projected: nil, range: nil, basis: .collecting)) == "수집 중")
        precondition(burnProjectionLabel(
            BurnProjection(current: 0.9, projected: nil, range: nil, basis: .unmeasured))
            == StatusVocabulary.notMeasured)

        // 판정 문구
        precondition(burnVerdictLabel(.blocked) == "부족")
        precondition(burnVerdictLabel(.onTarget) == "달성")
        precondition(burnVerdictLabel(.unknown) == StatusVocabulary.notMeasured)

        // 권고가 없으면 그 줄만큼 높이가 줄어든다. 할 말이 없을 때 빈 줄을 남기지 않는다.
        func model(_ lines: [String]) -> SubscriptionBurnModel {
            SubscriptionBurnModel(
                usages: [LaneUsage(lane: "claude", paidAccounts: 17, contributingAccounts: 7,
                                   errorAccounts: 6, disabledAccounts: 4,
                                   weekly: extrapolated, session: extrapolated, blockedMoments: 0)],
                rates: [:], recommendations: lines)
        }
        precondition(SubscriptionBurnView.preferredHeight(model([]))
                     < SubscriptionBurnView.preferredHeight(model(["오류 6개 재인증이 먼저"])))

        // 레인이 늘면 높이도 는다.
        let two = SubscriptionBurnModel(
            usages: model([]).usages + model([]).usages, rates: [:], recommendations: [])
        precondition(SubscriptionBurnView.preferredHeight(two)
                     > SubscriptionBurnView.preferredHeight(model([])))

        print("SubscriptionBurnLayoutTests: 통과")
    }
}
