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

        // 신뢰 낮은 외삽이 100%를 넘으면 원시 숫자(예: 423%)를 쓰지 않는다(실사용 QA 2026-10-25:
        // "Codex 3% → 423% 추정 · 신뢰 낮음"·"달성"). 계산은 그대로 두고 표시만 바꾼다.
        let wild = BurnProjection(current: 0.03, projected: 4.23, range: nil, basis: .extrapolation(confidence: .low))
        let wildLabel = burnProjectionLabel(wild)
        precondition(!wildLabel.contains("423%"), wildLabel)
        precondition(wildLabel.contains("3%") && wildLabel.contains(L10n.burnOverHundred) && wildLabel.contains(L10n.lowConfidence), wildLabel)
        // 신뢰 높은 외삽은 그대로 숫자를 쓴다(값은 손대지 않는다).
        let sure = BurnProjection(current: 0.6, projected: 1.2, range: nil, basis: .extrapolation(confidence: .normal))
        precondition(burnProjectionLabel(sure).contains("120%"), burnProjectionLabel(sure))
        // 과거 주기 범위의 두 끝이 같은 숫자면 덧붙이지 않는다(실사용 QA 2026-10-26: "평균 100% · 100%~100%").
        let flat = BurnProjection(current: 1, projected: 1, range: 0.999...1.0, basis: .history(cycles: 12))
        precondition(!burnProjectionLabel(flat).contains("~"), burnProjectionLabel(flat))
        let spread = BurnProjection(current: 0.9, projected: 0.9, range: 0.7...1.0, basis: .history(cycles: 12))
        precondition(burnProjectionLabel(spread).contains("70%~100%"), burnProjectionLabel(spread))
        // 100% 이하 신뢰 낮음은 숫자를 쓴다.
        let lowSmall = BurnProjection(current: 0.03, projected: 0.4, range: nil, basis: .extrapolation(confidence: .low))
        precondition(burnProjectionLabel(lowSmall).contains("40%"), burnProjectionLabel(lowSmall))
        // 판정도 같은 말을 한다: 신뢰 낮은 전망은 "달성"이라 단정하지 않고 추정이라 쓴다.
        func lane(_ projection: BurnProjection, blocked: Int = 0) -> LaneUsage {
            LaneUsage(lane: "codex", paidAccounts: 1, contributingAccounts: 1, errorAccounts: 0, disabledAccounts: 0,
                      weekly: projection, session: BurnProjection(current: nil, projected: nil, range: nil, basis: .collecting),
                      blockedMoments: blocked)
        }
        precondition(burnVerdict(lane(wild)) == .onTarget, "the verdict math is unchanged")
        let wildVerdict = burnVerdictDisplay(lane(wild))
        precondition(wildVerdict.label == L10n.verdictTentative(L10n.verdictOnTarget) && wildVerdict.label != L10n.verdictOnTarget,
                     wildVerdict.label)
        precondition(burnVerdictDisplay(lane(sure)).label == L10n.verdictOnTarget)
        // 관측된 부족은 추정이 아니다.
        precondition(burnVerdictDisplay(lane(wild, blocked: 1)).label == L10n.verdictBlocked)
        let previousLanguage = L10n.language
        L10n.language = .en
        for text in [burnProjectionLabel(wild), burnVerdictDisplay(lane(wild)).label] {
            precondition(text.range(of: "[가-힣]", options: .regularExpression) == nil, "Hangul in English: \(text)")
        }
        precondition(burnProjectionLabel(wild).contains("over 100%"), burnProjectionLabel(wild))
        L10n.language = previousLanguage

        print("BurnProjectionTests: 통과")
    }
}
