// menubar/Tests/BurnProjectionTests.swift
import Foundation

@main
struct BurnProjectionTests {
    static func main() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let week: Double = 7 * 86_400

        // 절반 지났으면 경과율 0.5다.
        let half = burnElapsedRatio(windowSeconds: week, resetAt: now.addingTimeInterval(week / 2), now: now)
        precondition(half != nil && abs(half! - 0.5) < 0.001, "\(String(describing: half))")

        // 리셋이 이미 지났으면 경과율을 내지 않는다.
        precondition(burnElapsedRatio(windowSeconds: week, resetAt: now.addingTimeInterval(-60), now: now) == nil)
        precondition(burnElapsedRatio(windowSeconds: week, resetAt: nil, now: now) == nil)
        // 리셋이 창 길이보다 멀면(서버 오류) 경과율을 내지 않는다.
        precondition(burnElapsedRatio(windowSeconds: week, resetAt: now.addingTimeInterval(week * 2), now: now) == nil)

        // 이력이 없으면 외삽한다: 0.41 ÷ 0.5 = 0.82
        let extrapolated = burnProject(current: 0.41, windowSeconds: week,
                                       resetAt: now.addingTimeInterval(week / 2), history: [], now: now)
        precondition(abs((extrapolated.projected ?? 0) - 0.82) < 0.001, "\(String(describing: extrapolated.projected))")
        precondition(extrapolated.basis == .extrapolation(confidence: .normal))

        // 주기 초반이면 신뢰가 낮다고 말한다.
        let early = burnProject(current: 0.05, windowSeconds: week,
                                resetAt: now.addingTimeInterval(week * 0.8), history: [], now: now)
        precondition(early.basis == .extrapolation(confidence: .low))

        // 리셋이 지났으면 전망을 내지 않는다(0으로 나누지 않는다).
        let stale = burnProject(current: 0.9, windowSeconds: week,
                                resetAt: now.addingTimeInterval(-60), history: [], now: now)
        precondition(stale.projected == nil && stale.basis == .unmeasured)

        // 완료 주기 2개 이상이면 과거 평균을 쓰고 범위를 함께 낸다.
        func cycle(_ mean: Double, complete: Bool = true, day: Double) -> QuotaCycle {
            QuotaCycle(lane: "claude", window: "7d", endedAt: now.addingTimeInterval(-day * 86_400),
                       contributing: 7, paid: 17, meanUtilization: mean, maxUtilization: mean,
                       exhaustedAccounts: 0, blockedMoments: 0, complete: complete)
        }
        let withHistory = burnProject(current: 0.4, windowSeconds: week,
                                      resetAt: now.addingTimeInterval(week / 2),
                                      history: [cycle(0.61, day: 14), cycle(0.97, day: 7)], now: now)
        precondition(abs((withHistory.projected ?? 0) - 0.79) < 0.001, "\(String(describing: withHistory.projected))")
        precondition(withHistory.range?.lowerBound == 0.61 && withHistory.range?.upperBound == 0.97)
        precondition(withHistory.basis == .history(cycles: 2))

        // 불완전 주기는 평균에서 뺀다. 둘 중 하나가 불완전하면 이력이 모자라 외삽으로 돌아간다.
        let partial = burnProject(current: 0.41, windowSeconds: week,
                                  resetAt: now.addingTimeInterval(week / 2),
                                  history: [cycle(0.61, complete: false, day: 14), cycle(0.97, day: 7)], now: now)
        precondition(partial.basis == .extrapolation(confidence: .normal), "\(partial.basis)")

        // 현재 값이 없으면 수집 중이다(Grok처럼 창을 모르는 레인).
        let none = burnProject(current: nil, windowSeconds: week, resetAt: nil, history: [], now: now)
        precondition(none.basis == .collecting)

        print("BurnProjectionTests: 통과")
    }
}
