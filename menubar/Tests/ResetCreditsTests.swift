import Foundation

@main
struct ResetCreditsTests {
    static func main() throws {
        let now = Date(timeIntervalSince1970: 1800000000)
        let stamp = now.timeIntervalSince1970 * 1000
        func row(_ name: String, count: Any?, age: Double = 0, enabled: Bool = true, state: String = "active") -> [String: Any] {
            var quota: [String: Any] = ["codexResetCreditsAt": stamp - age * 1000]
            if let count { quota["codexResetCredits"] = count }
            return ["name": name, "enabled": enabled, "status": "active", "quota": quota, "subscription": ["state": state]]
        }
        let rows = [row("fresh", count: 3), row("empty", count: 0), row("unknown", count: nil),
                    row("disabled", count: 8, enabled: false), row("ended", count: 9, state: "ended"),
                    row("stale", count: 4, age: 600), row("future", count: 4, age: -1),
                    row("negative", count: -1), row("fraction", count: 1.5), row("bool", count: true),
                    row("text", count: "3")]
        let fixture: [String: Any] = ["accounts": rows, "resetCredits": ["enabled": true, "policy": "account"]]
        let data = try JSONSerialization.data(withJSONObject: fixture)
        let pool = try teamCodexPoolHealth(from: data, port: 3457, serverPid: nil, checkedAt: now)
        precondition(pool.accounts[0].resetCreditLabel(at: now, online: true) == "3장")
        precondition(pool.accounts[1].resetCreditLabel(at: now, online: true) == "0장")
        for index in [2, 5, 6, 7, 8, 9, 10] {
            precondition(pool.accounts[index].resetCreditLabel(at: now, online: true) == "미확인")
        }
        precondition(pool.resetCreditSummary == "활성 풀 리셋권 3장 · 미확인 7계정")
        precondition(pool.resetCreditPolicyLabel == "계정별 한도 소진 시 자동 리셋")
        precondition(pool.resetCreditAccessibilitySummary.contains("empty 리셋권 0장"))
        precondition(pool.accounts[0].resetCreditLabel(at: now, online: false) == "미확인")
        let offline = try teamCodexPoolOfflineHealth(configData: data, port: 3457, serverPid: nil, checkedAt: now)
        precondition(offline.accounts.allSatisfy { $0.resetCreditCount(at: now, online: false) == nil })
        precondition(offline.resetCreditPolicyLabel == "자동 리셋 상태 미확인")
        var changed = pool
        changed.resetCreditsEnabled = false
        precondition(changed.resetCreditPolicyLabel == "자동 리셋 꺼짐")
        changed.resetCreditsEnabled = true
        changed.resetCreditsPolicy = "fleet"
        precondition(changed.resetCreditPolicyLabel == "전체 풀 소진 시 자동 리셋")
        print("ResetCreditsTests: parsing, freshness, offline, totals, policy and accessibility passed")
    }
}
