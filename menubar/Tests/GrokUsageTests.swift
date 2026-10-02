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

        print("Grok title usage test passed")
    }
}
