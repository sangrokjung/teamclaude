import Foundation

@main
struct CodexTitleQuotaTests {
    static func main() {
        for tokens in [123456, 0] {
            let health = CodexHealth(
                checkedAt: Date(), overallStatus: "ok", configPresent: true,
                authPresent: true, authMode: "chatgpt", authLabel: "ChatGPT",
                hasApiKey: false, hasTokens: true, lastRefresh: nil,
                model: "gpt-6", reasoningEffort: "high", serviceTier: nil, contextWindow: nil,
                todayCalls: 10, weekCalls: 10, totalCalls: 10,
                todayTokens: tokens, weekTokens: tokens, totalTokens: tokens,
                quotaEvents: 5, errorEvents: 0, lastCallAt: Date(), planType: "pro",
                scannedLogFiles: 1, scannedLogBytes: 100, profiles: [], hints: []
            )
            precondition(health.titleSlot == (tokens == 0 ? "Codex 0/d" : "Codex 123.5K/d"), "The token title must retain both positive and real zero usage")
        }
        print("Codex title token usage test passed")
    }
}
