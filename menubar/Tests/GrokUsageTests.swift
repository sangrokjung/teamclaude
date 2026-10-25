import Foundation

@main
struct GrokUsageTests {
    static func main() {
        let billing = """
        {"config":{"creditUsagePercent":9,"productUsage":[{"product":"GrokBuild","usagePercent":2.0}]}}
        """.data(using: .utf8)!
        precondition(grokUsagePercent(fromBilling: billing) == 2, "GrokBuild percent wins over the account total")
        precondition(grokPercentSlot(2) == "Grok 2%")
        precondition(grokPercentSlot(0) == "Grok 0%", "a real zero stays visible")
        precondition(grokPercentSlot(2.05) == "Grok 2.1%")

        let creditOnly = #"{"config":{"creditUsagePercent":0}}"#.data(using: .utf8)!
        precondition(grokUsagePercent(fromBilling: creditOnly) == 0)
        precondition(grokPercentSlot(grokUsagePercent(fromBilling: creditOnly)!) == "Grok 0%")

        let unknown = #"{"contextWindowUsage":53,"contextWindowTokens":500000}"#.data(using: .utf8)!
        precondition(grokUsagePercent(fromBilling: unknown) == nil, "context window is not plan usage")
        precondition(grokPercentSlot(250) == nil, "out of range must not render as a percent")
        precondition(grokUsagePercent(fromBilling: #"{"config":{"creditUsagePercent":250}}"#.data(using: .utf8)!) == nil)

        let now = ISO8601DateFormatter().date(from: "2026-09-22T05:23:23Z")!
        // 만료된 자격은 절대 쓰지 않는다. 다만 "쓸 수 없다"와 "로그인해야 한다"는 다른 말이다 —
        // 만료는 grok을 한 번 부르면 갱신되므로 재로그인을 시키면 안 된다(2026-09-24).
        let expired = #"{"acct":{"key":"test-token","expires_at":"2020-01-01T00:00:00Z"}}"#.data(using: .utf8)!
        precondition(grokCredential(from: expired, now: now) == .expired,
                     "expired Grok auth must ask for a refresh, not a fresh login")
        let missingExpiry = #"{"acct":{"key":"test-token","expires_at":"not-a-date"}}"#.data(using: .utf8)!
        if case .login = grokCredential(from: missingExpiry, now: now) {} else {
            preconditionFailure("unreadable expiry must not be treated as usable")
        }
        let live = #"{"acct":{"key":"test-token","expires_at":"2026-09-22T11:00:11.164109Z"}}"#.data(using: .utf8)!
        if case .usable = grokCredential(from: live, now: now) {} else {
            preconditionFailure("future expiry must stay usable")
        }
        let absent = Data("{}".utf8)
        if case .login = grokCredential(from: absent, now: now) {} else {
            preconditionFailure("missing credential must ask for login")
        }


        // 같은 자격도 기한 안이면 그대로 쓴다.
        let beforeExpiry = ISO8601DateFormatter().date(from: "2019-01-01T00:00:00Z")!
        if case .usable = grokCredential(from: expired, now: beforeExpiry) {} else {
            preconditionFailure("기한 안이면 usable이어야 한다")
        }

        // 자격이 아예 없으면 여전히 로그인이다.
        precondition(grokCredential(from: Data("{}".utf8), now: now) == .login,
                     "자격이 없으면 login이어야 한다")

        // 갱신 필요(실사용 QA 2026-10-25): 제목 슬롯과 카드가 한 판정에서 나오고, 레인에는 할 일을 짧게 말한다.
        // 예전엔 제목이 "Grok 갱신 필요"인데 개요 레인은 보조 줄 없는 "확인 필요"였다.
        let checking = GrokCardModel(headline: L10n.grokChecking, detail: nil)
        let refresh = grokPresentation(.expired, previousSlot: nil, previousCard: checking)
        precondition(refresh.slot == L10n.grokRefreshNeeded && refresh.card.headline == refresh.slot,
                     "title slot and card must share the refresh-needed wording: \(String(describing: refresh.slot)) / \(refresh.card.headline)")
        precondition(refresh.card.detail == L10n.grokRefreshDetail)
        precondition(refresh.card.laneNote == L10n.grokRefreshLaneNote && !(refresh.card.laneNote ?? "").isEmpty,
                     "the lane must say what to do")
        // 토큰이 기한 안인데 청구 API가 401·403이면 서버가 토큰을 거절한 것이다. "확인 필요"가 아니라 갱신 필요다.
        precondition(grokMenuOutcome(billing: nil, statusCode: 401) == .expired)
        precondition(grokMenuOutcome(billing: nil, statusCode: 403) == .expired)
        precondition(grokMenuOutcome(billing: nil, statusCode: 500) == .unavailable)
        precondition(grokMenuOutcome(billing: nil, statusCode: nil) == .unavailable)
        if case .percent(let outcome) = grokMenuOutcome(billing: billing, statusCode: 200) {
            precondition(outcome.slot == "Grok 2%")
        } else { preconditionFailure("200 with billing must be a percent") }
        // 갱신 필요 뒤의 실패는 토큰이 아니라 네트워크·서버 쪽이다(401·403은 .expired로 온다). 제목과 카드가 함께 확인 필요가 된다.
        let afterRefresh = grokPresentation(.unavailable, previousSlot: refresh.slot, previousCard: refresh.card)
        precondition(afterRefresh.slot == L10n.grokNeedsCheck && afterRefresh.card.headline == afterRefresh.slot,
                     "title and card move together")
        // 처음부터 실패면 확인 필요. 제목과 카드가 같은 말이다.
        let failed = grokPresentation(.unavailable, previousSlot: nil, previousCard: checking)
        precondition(failed.slot == L10n.grokNeedsCheck && failed.card.headline == L10n.grokNeedsCheck)
        // 앞서 값이 있었으면 그 값을 지킨다.
        let percent = grokPresentation(.percent(GrokPercentOutcome(slot: "Grok 24%", productPercent: 24, creditPercent: nil)),
                                       previousSlot: nil, previousCard: checking)
        precondition(percent.slot == "Grok 24%" && percent.card.headline == "Grok 24%")
        let kept = grokPresentation(.unavailable, previousSlot: percent.slot, previousCard: percent.card)
        precondition(kept.slot == "Grok 24%" && kept.card == percent.card)
        let login = grokPresentation(.login, previousSlot: percent.slot, previousCard: percent.card)
        precondition(login.slot == L10n.grokLogin && login.card.headline == L10n.grokLogin)
        // 영어 화면에는 한글이 없다.
        let previousLanguage = L10n.language
        L10n.language = .en
        let english = grokPresentation(.expired, previousSlot: nil, previousCard: checking)
        for text in [english.slot ?? "", english.card.headline, english.card.detail ?? "", english.card.laneNote ?? ""] {
            precondition(!text.isEmpty && text.range(of: "[가-힣]", options: .regularExpression) == nil, "Hangul in English: \(text)")
        }
        precondition(english.slot == "Grok refresh needed")
        L10n.language = previousLanguage

        print("Grok title usage test passed")
    }
}
