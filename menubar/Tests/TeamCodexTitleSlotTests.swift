// menubar/Tests/TeamCodexTitleSlotTests.swift
import Foundation

@main
struct TeamCodexTitleSlotTests {
    static func main() throws {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        let seoul = TimeZone(identifier: "Asia/Seoul")!
        func row(_ name: String, usable: Bool, weekly: Double, weeklyResetIn: TimeInterval) -> [String: Any] {
            ["name": name, "enabled": true, "status": "active", "usable": usable,
             "quota": ["unified5h": 0, "unified7d": weekly,
                       "unified7dReset": (now.timeIntervalSince1970 + weeklyResetIn) * 1000],
             "subscription": ["state": "active"]]
        }
        func pool(_ rows: [[String: Any]]) throws -> TeamCodexPoolHealth {
            let data = try JSONSerialization.data(withJSONObject: ["accounts": rows, "switchThreshold": 1])
            return try teamCodexPoolHealth(from: data, port: 3457, serverPid: nil, checkedAt: now)
        }

        let healthy = try pool([row("a0", usable: true, weekly: 0.4, weeklyResetIn: 3600),
                                row("a1", usable: false, weekly: 1, weeklyResetIn: 7200)])
        precondition(!healthy.isExhausted)
        precondition(healthy.statusLabel == "온라인", healthy.statusLabel)
        precondition(healthy.titleSlot(timeZone: seoul) == "Codex 1/2", healthy.titleSlot(timeZone: seoul))

        let exhausted = try pool([row("a0", usable: false, weekly: 1, weeklyResetIn: 3 * 86_400),
                                  row("a1", usable: false, weekly: 1, weeklyResetIn: 86_400)])
        precondition(exhausted.isExhausted)
        precondition(exhausted.statusLabel == "소진", exhausted.statusLabel)
        let soonest = teamCodexShortClock(now.addingTimeInterval(86_400), timeZone: seoul)
        precondition(exhausted.titleSlot(timeZone: seoul) == "Codex 소진 · \(soonest) 복구", exhausted.titleSlot(timeZone: seoul))

        let noReset = try pool([row("a0", usable: false, weekly: 1, weeklyResetIn: -60)])
        precondition(noReset.titleSlot(timeZone: seoul) == "Codex 소진 0/1", noReset.titleSlot(timeZone: seoul))

        let config = try JSONSerialization.data(withJSONObject: ["accounts": [row("a0", usable: true, weekly: 0, weeklyResetIn: 60)]])
        let offline = try teamCodexPoolOfflineHealth(configData: config, port: 3457, serverPid: nil, checkedAt: now)
        precondition(offline.statusLabel == "오프라인", offline.statusLabel)
        precondition(offline.titleSlot(timeZone: seoul) == "Codex 오프라인", offline.titleSlot(timeZone: seoul))

        precondition(exhausted.accessibilitySummary.hasPrefix("TeamCodex 소진, "), exhausted.accessibilitySummary)
        // 복구 시각 규칙: 오류 행은 사유 라벨이 없어도 제외, rateLimitedUntil은 추가 blocker.
        var errorRow = row("e0", usable: false, weekly: 1, weeklyResetIn: 600)
        errorRow["status"] = "error"
        let errorOnly = try pool([errorRow])
        precondition(errorOnly.soonestQuotaRecoveryAt == nil, "error rows must not promise a recovery time")
        precondition(errorOnly.titleSlot(timeZone: seoul) == "Codex 소진 0/1", errorOnly.titleSlot(timeZone: seoul))

        var limitedRow = row("r0", usable: false, weekly: 0.2, weeklyResetIn: -60)
        limitedRow["rateLimitedUntil"] = (now.timeIntervalSince1970 + 900) * 1000
        let limited = try pool([limitedRow])
        let limitedUntil = now.addingTimeInterval(900)
        precondition(limited.soonestQuotaRecoveryAt == limitedUntil, "rate-limit window is the recovery time when quota windows already reset")
        precondition(limited.titleSlot(timeZone: seoul) == "Codex 소진 · \(teamCodexShortClock(limitedUntil, timeZone: seoul)) 복구", limited.titleSlot(timeZone: seoul))

        // 라이브 프록시는 rateLimitedUntil을 ISO8601 문자열로 보낸다 — 숫자(ms)와 문자열 둘 다 같은 결과여야 한다.
        var limitedIsoRow = row("r1", usable: false, weekly: 0.2, weeklyResetIn: -60)
        limitedIsoRow["rateLimitedUntil"] = ISO8601DateFormatter().string(from: limitedUntil)
        let limitedIso = try pool([limitedIsoRow])
        precondition(limitedIso.soonestQuotaRecoveryAt == limitedUntil, "ISO8601 rateLimitedUntil must decode like the epoch-ms form")

        var mixedLimited = row("m0", usable: false, weekly: 1, weeklyResetIn: 1800)
        mixedLimited["rateLimitedUntil"] = (now.timeIntervalSince1970 + 3600) * 1000
        let mixed = try pool([mixedLimited, errorRow, row("m2", usable: false, weekly: 1, weeklyResetIn: 7200)])
        precondition(mixed.soonestQuotaRecoveryAt == now.addingTimeInterval(3600), "a row recovers only when both its quota window and its rate-limit window end; the pool takes the soonest such row")

        print("TeamCodexTitleSlotTests: status label, exhaustion, recovery clock, title slot, recovery-clock rules passed")
    }
}
