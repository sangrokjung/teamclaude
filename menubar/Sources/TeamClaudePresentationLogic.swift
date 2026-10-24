import Foundation

struct TeamClaudeOverallStatusInput: Equatable {
    let serverReachable: Bool
    let configPresent: Bool
    let allAccountsError: Bool
    let quotaLimitedCount: Int
    let hasOtherWarning: Bool
}

func teamClaudeOverallStatus(_ input: TeamClaudeOverallStatusInput) -> String {
    if !input.serverReachable || input.allAccountsError { return "error" }
    if !input.configPresent || input.quotaLimitedCount > 0 || input.hasOtherWarning {
        return "warning"
    }
    return "ok"
}

struct TeamClaudeHeadlineInput: Equatable {
    let serverReachable: Bool
    let accountConfigDrift: Int
    let measurementPendingCount: Int
    let quotaLimitedCount: Int
    let fableKnown: Int
    let fableOver: Int
    let totalAccounts: Int
    let accountUsable: Int
    let accountActive: Int
}

func teamClaudeTitleSlot(_ input: TeamClaudeHeadlineInput) -> String {
    if !input.serverReachable { return L10n.titleClaudeOffline }
    if input.accountConfigDrift > 0 { return L10n.titleClaudeDrift(input.accountConfigDrift) }
    if input.measurementPendingCount > 0 { return L10n.titleClaudeMeasure(input.measurementPendingCount) }
    if input.fableKnown > 0,
       input.fableOver == input.fableKnown,
       input.fableKnown >= input.totalAccounts {
        return L10n.titleClaudeFableLimit(input.fableOver, input.fableKnown)
    }
    if input.quotaLimitedCount > 0 {
        return L10n.titleClaudeRouting(input.accountUsable, input.totalAccounts)
    }
    return L10n.titleClaudeOK(input.accountActive, input.totalAccounts)
}

/// 프록시 status의 `runtime` 블록을 한 줄로. TeamClaude 표와 TeamCodex 카드가 같은 문구를 쓴다.
/// `short`는 카드 헤더용(빌드 + 재시작 수만).
func teamRuntimeSummary(_ raw: Any?, short: Bool = false, timeZone: TimeZone = .current) -> String? {
    guard let runtime = raw as? [String: Any] else { return nil }
    let build: String
    if let artifact = runtime["artifact"] as? String, !artifact.isEmpty {
        build = L10n.runtimeBuild(artifact)
    } else if let version = runtime["version"] as? String, !version.isEmpty {
        build = "v\(version)"
    } else {
        build = L10n.runtimeBuildUnknown
    }
    var parts = [build]
    if !short, let uptime = (runtime["uptimeMs"] as? NSNumber)?.doubleValue {
        parts.append(L10n.runtimeUptime(teamRuntimeUptimeText(uptime)))
    }
    if let restarts = (runtime["workerRestarts"] as? NSNumber)?.intValue {
        if short {
            parts.append(L10n.runtimeRestarts(restarts))
        } else {
            var text = L10n.runtimeWorkerRestarts(restarts)
            if let iso = runtime["lastWorkerRestartAt"] as? String, let date = teamRuntimeDate(iso) {
                text += L10n.runtimeLast(teamRuntimeClock(date, timeZone: timeZone))
            }
            parts.append(text)
        }
    }
    return parts.joined(separator: " · ")
}

/// port/pid 줄에 runtime 문구를 붙일 때 폭 초과를 막는다. 전문 → 축약 → 생략 순.
/// `measure`는 렌더 폰트 기준 폭(pt)을 돌려준다. 테스트는 가짜 measurer를 넣는다.
func teamServerLine(base: String, full: String?, short: String?, maxWidth: CGFloat, measure: (String) -> CGFloat) -> String {
    for suffix in [full, short].compactMap({ $0 }) {
        let candidate = "\(base)  ·  \(suffix)"
        if measure(candidate) <= maxWidth { return candidate }
    }
    return base
}

func teamRuntimeUptimeText(_ milliseconds: Double) -> String {
    guard milliseconds.isFinite else { return L10n.durationMinutes(0) }
    let minutes = max(0, Int(min(milliseconds, 1e15) / 60_000))
    let days = minutes / 1440
    let hours = (minutes % 1440) / 60
    let remainder = minutes % 60
    if days > 0 { return L10n.durationDaysHours(days, hours) }
    if hours > 0 { return L10n.durationHoursMinutes(hours, remainder) }
    return L10n.durationMinutes(remainder)
}

func teamRuntimeDate(_ iso: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: iso) { return date }
    return ISO8601DateFormatter().date(from: iso)
}

func teamRuntimeClock(_ date: Date, timeZone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = "M/d HH:mm"
    return formatter.string(from: date)
}
