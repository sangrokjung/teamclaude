import Cocoa
import Darwin
import Foundation

// MARK: - 크래시 기록

/// 마지막으로 그리기 시작한 구간. 예외 핸들러가 같이 적어 어느 draw 구간에서 죽었는지 남긴다.
var lastDrawBreadcrumb = "startup"

func markDraw(_ label: String) {
    lastDrawBreadcrumb = label
}

/// KeepAlive가 조용히 되살리는 NSException 크래시를 시각·사유·구간과 함께 파일에 남긴다.
/// `~/.claude/cache/cc-menubar-err.log`(launchd stderr)에는 시각이 없어 사고 시각을 알 수 없었다.
func installCrashRecorder() {
    NSSetUncaughtExceptionHandler { exception in
        let stamp = ISO8601DateFormatter().string(from: Date())
        var line = "CRASH \(stamp) \(exception.name.rawValue): \(exception.reason ?? "-") | breadcrumb=\(lastDrawBreadcrumb)\n"
        for symbol in exception.callStackSymbols.prefix(12) {
            line += "  \(symbol)\n"
        }
        let data = Data(line.utf8)
        FileHandle.standardError.write(data)
        let path = "\(NSHomeDirectory())/.claude/cache/cc-menubar-crash.log"
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            handle.closeFile()
        } else {
            FileManager.default.createFile(atPath: path, contents: data, attributes: [.posixPermissions: 0o600])
        }
    }
}

/// "Grok 24%" 형태의 제목 슬롯에서 숫자만 떼어낸다. 상태 문구("Grok 로그인" 등)면 없다.
func burnGrokPercent(_ slot: String) -> Double? {
    guard let range = slot.range(of: #"[0-9]+(\.[0-9]+)?(?=%)"#, options: .regularExpression) else {
        return nil
    }
    return Double(slot[range])
}

/// 스냅샷 픽스처를 구독·소진 모델로 옮긴다. 실패 화면은 실패했을 때만 나타나므로
/// 이 경로가 없으면 눈으로 확인된 적 없는 화면이 된다.
func subscriptionBurnFixture(_ raw: [String: Any]?) -> SubscriptionBurnModel {
    guard let raw else {
        return SubscriptionBurnModel(usages: [], rates: [:], recommendations: [])
    }
    let rows = raw["usages"] as? [[String: Any]] ?? []
    let usages: [LaneUsage] = rows.map { row in
        func projection(_ key: String) -> BurnProjection {
            guard let value = (row[key] as? NSNumber)?.doubleValue else {
                return BurnProjection(current: nil, projected: nil, range: nil, basis: .collecting)
            }
            // 픽스처는 주기 절반을 지난 상태로 고정한다. 렌더 비교가 시각에 흔들리지 않게 한다.
            return BurnProjection(current: value, projected: value / 0.5, range: nil,
                                  basis: .extrapolation(confidence: .normal))
        }
        return LaneUsage(
            lane: row["lane"] as? String ?? "?",
            paidAccounts: (row["paid"] as? NSNumber)?.intValue ?? 0,
            contributingAccounts: (row["contributing"] as? NSNumber)?.intValue ?? 0,
            errorAccounts: (row["error"] as? NSNumber)?.intValue ?? 0,
            disabledAccounts: (row["disabled"] as? NSNumber)?.intValue ?? 0,
            unsubscribedAccounts: (row["unsubscribed"] as? NSNumber)?.intValue ?? 0,
            weekly: projection("weekly"), session: projection("session"),
            blockedMoments: (row["blocked"] as? NSNumber)?.intValue ?? 0)
    }
    return SubscriptionBurnModel(
        usages: usages,
        rates: subscriptionRateParse(["version": 1, "lanes": raw["rates"] as? [String: Any] ?? [:]]),
        recommendations: burnRecommendations(usages),
        currency: subscriptionCurrencySymbol(["currency": raw["currency"] as? String ?? ""]))
}

/// 두 풀(Claude·Codex)의 계정 타입이 달라 판정에 필요한 값만 같은 모양으로 옮겨 담는다.
struct BurnAccountRow {
    let name: String
    let enabled: Bool
    let status: String
    let errorReason: String?
    /// 구독이 끝나 돈이 안 나가는 계정. 두 풀이 표식이 다르다 — Claude는
    /// errorReason=subscription-disabled, Codex는 subscription.state=end-date-reached.
    /// 여기서 하나로 합쳐야 판정 함수가 풀마다 갈라지지 않는다.
    let subscriptionEnded: Bool
    let weeklyPercent: Double?
    let weeklyResetAt: Date?
    let sessionPercent: Double?
    let sessionResetAt: Date?
}

// MARK: - 데이터 모델

struct DailyUsage {
    let period: String
    let totalCost: Double
    let inputTokens: Int
    let cacheCreationTokens: Int
    let cacheReadTokens: Int
    let outputTokens: Int
    let models: [String]
}

// 일별 추이 한 점 (날짜 + 비용 + 토큰)
struct DayPoint {
    let date: String   // "2026-05-22"
    let cost: Double
    let tokens: Int
}

// 모델별 사용량 (codex 추적 — gpt-5.5 등 포함)
struct ModelUsage {
    let model: String     // raw "claude-opus-4-8" / "gpt-5.5"
    let label: String     // 표시명 "Opus4.8" / "GPT-5.5"
    let provider: String  // "Claude" / "Codex" / "Gemini" / ...
    let cost: Double
    let tokens: Int
}

struct UsageData {
    let today: DailyUsage?
    let weeklyTotalCost: Double   // 최근 7일 롤링 (기존 — 스파크라인 호환)
    let thisWeekCost: Double      // 이번 주 (native ccusage weekly, 월요일 시작)
    let thisWeekTokens: Int
    let thisMonthCost: Double     // 이번 달 (native ccusage monthly, YYYY-MM)
    let thisMonthTokens: Int
    let allTimeCost: Double      // 누적 비용 ($ALL)
    let allTimeTokens: Int       // 누적 토큰 (BALL)
    let totalDays: Int           // 활동 일수
    let usdKrwRate: Double        // USD→KRW 환율 (라이브 또는 폴백)
    let modelBreakdown: [ModelUsage]  // 이번 달 모델별 (codex 포함, 비용 내림차순)
    let last7Costs: [Double]     // 최근 7일 일별 비용 (스파크라인용, 과거→오늘 순)
    let last14Costs: [Double]    // 최근 14일 일별 비용 (드롭다운 차트용)
    let recent7Days: [DayPoint]  // 최근 7일 일별 상세 (날짜+비용+토큰, 드롭다운 리스트용)
    let recent14Days: [DayPoint] // 최근 14일 일별 상세 (차트 날짜 라벨용)
}

struct TeamClaudeHostMetrics {
    let cpuPercent: Double?      // 호스트 CPU 사용률 (%) — 서버 첫 호출 직후 nil 가능
    let cores: Int?             // 논리 코어 수
    let loadavg1: Double?       // 1분 load average
    let memUsedPercent: Double? // RAM 사용률 (%)
    let memUsedBytes: Int?      // RAM 사용량 (bytes)
    let memTotalBytes: Int?     // RAM 총량 (bytes)
    let sampledAt: String?      // 샘플 시각 (ISO8601)
}

struct TeamClaudeHealth {
    let checkedAt: Date
    let overallStatus: String
    let configPresent: Bool
    let serverReachable: Bool
    let serverPort: Int?
    let serverPid: Int?
    let accountTotal: Int
    let accountConfigured: Int
    let accountActive: Int
    let accountUsable: Int
    let accountThrottled: Int
    let accountExhausted: Int
    let accountError: Int
    let accountDisabled: Int
    let accountConfigDrift: Int
    let inflight: Int
    let capacity: Int
    let fableKnown: Int
    let fableOver: Int
    let fableMaxPercent: Double?
    let fableAvgPercent: Double?
    let quotaThresholdPercent: Double
    let retryAfterSeconds: Int?
    let accounts: [TeamClaudeAccountHealth]
    let hints: [String]
    let host: TeamClaudeHostMetrics?
    var runtimeSummary: String? = nil
    var runtimeSummaryShort: String? = nil

    // 호스트 CPU/RAM 한 줄 요약 (표시할 값이 없으면 nil → 라인 생략)
    var hostSummaryText: String? {
        guard let host = host else { return nil }
        var parts: [String] = []
        if let cpu = host.cpuPercent, cpu.isFinite { parts.append("CPU \(Int(cpu.rounded()))%") }
        if let mem = host.memUsedPercent, mem.isFinite { parts.append("RAM \(Int(mem.rounded()))%") }
        guard !parts.isEmpty else { return nil }
        var extras: [String] = []
        if let load = host.loadavg1, load.isFinite { extras.append(String(format: "load %.1f", load)) }
        if let cores = host.cores { extras.append("\(cores)코어") }
        let suffix = extras.isEmpty ? "" : " (\(extras.joined(separator: " / ")))"
        return "호스트  " + parts.joined(separator: " · ") + suffix
    }

    // CPU 또는 RAM 사용률이 90% 이상이면 경고 강조
    var hostIsWarning: Bool {
        guard let host = host else { return false }
        return (host.cpuPercent ?? 0) >= 90 || (host.memUsedPercent ?? 0) >= 90
    }

    var isWarning: Bool { overallStatus == "warning" }
    var isError: Bool { overallStatus == "error" }
    var measurementPendingCount: Int {
        zip(accounts, fableAvailability()).filter { row, availability in
            row.measurementIssue?.canMeasureNow == true && availability.subscriptionAppearance != .ended
        }.count
    }
    var measurementUnavailableCount: Int {
        accounts.filter { $0.measurementIssue?.isMeasurementUnavailable == true }.count
    }
    var quotaLimitedCount: Int {
        accounts.filter { $0.measurementIssue?.isQuotaLimited == true }.count
    }

    var titleSlot: String {
        let total = max(accountTotal, accountConfigured)
        if serverReachable && accountConfigDrift == 0 {
            return "Claude Fable 사용 가능 \(fableAvailability().filter { $0.state == .ready }.count)/\(total)"
        }
        return teamClaudeTitleSlot(TeamClaudeHeadlineInput(
            serverReachable: serverReachable,
            accountConfigDrift: accountConfigDrift,
            measurementPendingCount: measurementPendingCount,
            quotaLimitedCount: quotaLimitedCount,
            fableKnown: fableKnown,
            fableOver: fableOver,
            totalAccounts: total,
            accountUsable: accountUsable,
            accountActive: accountActive
        ))
    }

    var statusLabel: String {
        if isError { return "오류" }
        if isWarning { return "주의" }
        return "정상"
    }
}

struct TeamClaudeAccountHealth {
    let name: String
    let isCurrent: Bool
    let enabled: Bool
    let isUsable: Bool
    let status: String
    var errorReason: String? = nil
    var provider: String? = nil
    var accountUuid: String? = nil
    let source: String?
    let totalTokens: Int
    let totalRequests: Int
    let sessionPercent: Double?
    let sessionResetSeconds: Int?
    let weeklyPercent: Double?
    let weeklyResetSeconds: Int?
    let fablePercent: Double?
    let fableResetSeconds: Int?
    let probedAt: Date?
    let measurementIssue: TeamClaudeMeasurementIssue?
    var usableFromProxy: Bool? = nil
    var fableMeasurementCurrent = false
    var inflightCount: Int? = nil
    var concurrentCapacity: Int? = nil
    var subscriptionConfirmation: AccountSubscriptionConfirmation? = nil
    var subscriptionEndReached = false
    var subscriptionEndsAt: Date? = nil
    var sessionResetAt: Date? = nil
    var weeklyResetAt: Date? = nil
    var fableResetAt: Date? = nil
}

private let _teamClaudeISOFormatter = ISO8601DateFormatter()
private let _teamClaudeISOFormatterFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func tcInt(_ value: Any?) -> Int? {
    if let n = value as? Int { return n }
    if let n = value as? NSNumber { return n.intValue }
    if let d = value as? Double { return Int(d) }
    if let s = value as? String { return Int(s) }
    return nil
}

func tcDouble(_ value: Any?) -> Double? {
    if let d = value as? Double { return d }
    if let n = value as? NSNumber { return n.doubleValue }
    if let s = value as? String { return Double(s) }
    return nil
}

func tcBool(_ value: Any?) -> Bool? {
    if let b = value as? Bool { return b }
    if let n = value as? NSNumber { return n.boolValue }
    return nil
}

func tcString(_ value: Any?) -> String? {
    if let s = value as? String { return s }
    if let n = value as? NSNumber { return n.stringValue }
    return nil
}

func tcDict(_ value: Any?) -> [String: Any]? {
    value as? [String: Any]
}

func tcArray(_ value: Any?) -> [[String: Any]]? {
    value as? [[String: Any]]
}

func round1(_ value: Double) -> Double {
    (value * 10).rounded() / 10
}

func trimLogIfNeeded(_ path: String, maxBytes: Int64 = 10 * 1024 * 1024) {
    guard let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value,
          size > maxBytes,
          let handle = FileHandle(forWritingAtPath: path) else {
        return
    }
    handle.truncateFile(atOffset: 0)
    handle.closeFile()
}

func parseTeamClaudeTimeMs(_ value: Any?) -> Int64? {
    if let n = value as? Int64 { return n }
    if let n = value as? Int { return Int64(n) }
    if let n = value as? NSNumber { return teamClaudeSafeInt64(n.doubleValue) }
    if let d = value as? Double { return teamClaudeSafeInt64(d) }
    if let s = value as? String {
        if let d = Double(s) { return teamClaudeSafeInt64(d) }
        if let date = parseTeamClaudeDate(s) {
            return teamClaudeSafeInt64(date.timeIntervalSince1970 * 1000)
        }
    }
    return nil
}

func parseTeamClaudeDate(_ value: String) -> Date? {
    _teamClaudeISOFormatterFractional.date(from: value) ?? _teamClaudeISOFormatter.date(from: value)
}

func secondsUntil(_ value: Any?, nowMs: Int64) -> Int? {
    guard let resetMs = parseTeamClaudeTimeMs(value) else { return nil }
    return max(0, Int(ceil(Double(resetMs - nowMs) / 1000.0)))
}

func readTeamClaudeJSON(_ path: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return obj
}

func teamClaudeConfiguredRows(_ config: [String: Any]?) -> [TeamClaudeAccountHealth] {
    let accounts = tcArray(config?["accounts"]) ?? []
    return accounts.compactMap { account in
        guard let name = tcString(account["name"]), !name.isEmpty else { return nil }
        return TeamClaudeAccountHealth(
            name: name,
            isCurrent: false,
            enabled: tcBool(account["enabled"]) ?? true,
            isUsable: false,
            status: "configured",
            provider: tcString(account["provider"]),
            accountUuid: tcString(account["accountUuid"]),
            source: tcString(account["source"]) ?? tcString(account["type"]),
            totalTokens: 0,
            totalRequests: 0,
            sessionPercent: nil,
            sessionResetSeconds: nil,
            weeklyPercent: nil,
            weeklyResetSeconds: nil,
            fablePercent: nil,
            fableResetSeconds: nil,
            probedAt: nil,
            measurementIssue: tcBool(account["enabled"]) == false ? .disabled : .serverNotSynced
        )
    }
}

func fetchTeamClaudeStatus(port: Int, apiKey: String?) -> [String: Any]? {
    guard let data = teamCodexFetchStatus(port: port, apiKey: apiKey) else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

func triggerTeamClaudeQuotaProbe(port: Int, model: String) -> Int? {
    guard let url = URL(string: "http://127.0.0.1:\(port)/v1/messages") else { return nil }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.timeoutInterval = 45
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")

    let message: [String: Any] = ["role": "user", "content": "ping"]
    let body: [String: Any] = [
        "model": model,
        "max_tokens": 1,
        "messages": [message],
    ]
    guard JSONSerialization.isValidJSONObject(body),
          let bodyData = try? JSONSerialization.data(withJSONObject: body) else {
        return nil
    }
    request.httpBody = bodyData

    let semaphore = DispatchSemaphore(value: 0)
    var statusCode: Int?
    let task = URLSession.shared.dataTask(with: request) { _, response, _ in
        defer { semaphore.signal() }
        statusCode = (response as? HTTPURLResponse)?.statusCode
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 50)
    task.cancel()
    return statusCode
}

func resolveClaudeExecutable() -> String {
    let candidates = [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "\(NSHomeDirectory())/.local/bin/claude",
    ]
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
    }
    return "/usr/bin/env"
}

func runTeamClaudeBareClaudeProbe(port: Int, apiKey: String?, model: String) -> Int32? {
    guard let apiKey, !apiKey.isEmpty else { return nil }
    let process = Process()
    let claude = resolveClaudeExecutable()
    if claude == "/usr/bin/env" {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "claude", "--bare", "-p", "Respond exactly: OK",
            "--model", model,
            "--tools", "",
            "--max-budget-usd", "0.02",
            "--no-session-persistence",
            "--output-format", "json",
        ]
    } else {
        process.executableURL = URL(fileURLWithPath: claude)
        process.arguments = [
            "--bare", "-p", "Respond exactly: OK",
            "--model", model,
            "--tools", "",
            "--max-budget-usd", "0.02",
            "--no-session-persistence",
            "--output-format", "json",
        ]
    }

    var env = ProcessInfo.processInfo.environment
    env["HOME"] = NSHomeDirectory()
    env["ANTHROPIC_BASE_URL"] = "http://localhost:\(port)"
    env["ANTHROPIC_API_KEY"] = apiKey
    env["PATH"] = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    process.environment = env

    let nullOut = FileHandle(forWritingAtPath: "/dev/null")
    process.standardOutput = nullOut
    process.standardError = nullOut

    guard let result = runTrustedProcessInIsolatedGroup(
        process,
        timeoutSeconds: 45,
        terminationGraceMicroseconds: 700_000
    ) else {
        nullOut?.closeFile()
        return nil
    }
    nullOut?.closeFile()
    return result.terminationStatus
}

func stripClaudeModelSuffix(_ model: String) -> String {
    var value = model
    if let r = value.range(of: "\\[[^\\]]+\\]$", options: .regularExpression) {
        value.removeSubrange(r)
    }
    return value
}

func computeTeamClaudeRetryAfterSeconds(accounts: [[String: Any]], threshold: Double, nowMs: Int64) -> Int? {
    let states = accounts.map { account -> TeamClaudeRetryAccountState in
        let quota = tcDict(account["quota"]) ?? [:]
        var windows = [
            TeamClaudeQuotaWindowState(
                utilization: tcDouble(quota["unified5h"]),
                resetAtMs: parseTeamClaudeTimeMs(quota["unified5hReset"])
            ),
            TeamClaudeQuotaWindowState(
                utilization: tcDouble(quota["unified7d"]),
                resetAtMs: parseTeamClaudeTimeMs(quota["unified7dReset"])
            ),
        ]

        let modelWeekly = tcDict(quota["modelWeekly"]) ?? [:]
        windows.append(contentsOf: modelWeekly.values.compactMap { value in
            guard let window = tcDict(value) else { return nil }
            return TeamClaudeQuotaWindowState(
                utilization: tcDouble(window["utilization"]),
                resetAtMs: parseTeamClaudeTimeMs(window["reset"])
            )
        })

        let tokensReset = quota["tokensReset"] ?? quota["resetsAt"]
        if let limit = tcDouble(quota["tokensLimit"]),
           let remaining = tcDouble(quota["tokensRemaining"]),
           limit > 0 {
            windows.append(TeamClaudeQuotaWindowState(
                utilization: 1.0 - remaining / limit,
                resetAtMs: parseTeamClaudeTimeMs(tokensReset)
            ))
        }

        let requestsReset = quota["requestsReset"] ?? quota["resetsAt"]
        if let limit = tcDouble(quota["requestsLimit"]),
           let remaining = tcDouble(quota["requestsRemaining"]),
           limit > 0 {
            windows.append(TeamClaudeQuotaWindowState(
                utilization: 1.0 - remaining / limit,
                resetAtMs: parseTeamClaudeTimeMs(requestsReset)
            ))
        }

        return TeamClaudeRetryAccountState(
            enabled: tcBool(account["enabled"]) ?? true,
            status: tcString(account["status"]) ?? "unknown",
            rateLimitedUntilMs: parseTeamClaudeTimeMs(account["rateLimitedUntil"]),
            windows: windows
        )
    }
    return teamClaudeRetryAfterSeconds(accounts: states, threshold: threshold, nowMs: nowMs)
}

func loadTeamClaudeHealth() -> TeamClaudeHealth {
    let home = NSHomeDirectory()
    let config = readTeamClaudeJSON("\(home)/.config/teamclaude.json")
    let server = readTeamClaudeJSON("\(home)/.config/teamclaude.server.json")
    let port = tcInt(server?["port"])
        ?? tcInt(tcDict(config?["proxy"])?["port"])
        ?? 3456
    let status = fetchTeamClaudeStatus(
        port: port,
        apiKey: tcString(tcDict(config?["proxy"])?["apiKey"])
    )
    return parseTeamClaudeHealth(config: config, server: server, status: status, port: port)
}

func parseTeamClaudeHealth(config: [String: Any]?, server: [String: Any]?,
                          status: [String: Any]?, port: Int, now: Date = Date()) -> TeamClaudeHealth {
    let accounts = tcArray(status?["accounts"]) ?? []
    let currentAccount = tcString(status?["currentAccount"])
    let threshold = teamClaudeQuotaNumber(status?["switchThreshold"]) ?? .nan
    let configuredRows = teamClaudeConfiguredRows(config)
    let configAccounts = configuredRows.count
    let nowMs = Int64(now.timeIntervalSince1970 * 1000)

    var active = 0
    var usable = 0
    var throttled = 0
    var exhausted = 0
    var error = 0
    var disabled = 0
    var inflight = 0
    var capacity = 0
    var fableKnown = 0
    var fableOver = 0
    var fableSum = 0.0
    var fableMax: Double?
    var accountRows: [TeamClaudeAccountHealth] = []

    for account in accounts {
        switch account["status"] as? String {
        case "active": active += 1
        case "throttled": throttled += 1
        case "exhausted": exhausted += 1
        case "error": error += 1
        default: break
        }
        if tcBool(account["enabled"]) == false { disabled += 1 }
        inflight = teamClaudeAddingCounts(
            inflight,
            teamClaudeBoundedCount(tcInt(account["inflight"]), maximum: 1_000_000),
            maximum: 1_000_000
        )
        capacity = teamClaudeAddingCounts(
            capacity,
            teamClaudeBoundedCount(tcInt(account["maxConcurrent"]), maximum: 1_000_000),
            maximum: 1_000_000
        )

        let quota = tcDict(account["quota"])
        let modelWeekly = tcDict(quota?["modelWeekly"])
        let fable = tcDict(modelWeekly?["7d_oi"])
        let fableResetMs = parseTeamClaudeTimeMs(fable?["reset"])
        let fableUtilization = teamClaudeCurrentQuotaUtilization(
            teamClaudeQuotaNumber(fable?["utilization"]),
            resetAtMs: fableResetMs,
            nowMs: nowMs
        )
        if let utilization = fableUtilization {
            fableKnown += 1
            if utilization >= threshold { fableOver += 1 }
            let pct = utilization * 100
            fableSum += pct
            fableMax = max(fableMax ?? pct, pct)
        }
        let name = tcString(account["name"]) ?? "unknown"
        let usage = tcDict(account["usage"])
        let lastUsed = tcString(usage?["lastUsed"]).flatMap(parseTeamClaudeDate)
        let totalTokens = teamClaudeAddingCounts(
            teamClaudeBoundedCount(tcInt(usage?["totalInputTokens"]), maximum: 1_000_000_000_000_000),
            teamClaudeBoundedCount(tcInt(usage?["totalOutputTokens"]), maximum: 1_000_000_000_000_000),
            maximum: 1_000_000_000_000_000
        )
        let enabled = tcBool(account["enabled"]) ?? true
        let status = tcString(account["status"]) ?? "unknown"
        let sessionResetMs = parseTeamClaudeTimeMs(quota?["unified5hReset"])
        let weeklyResetMs = parseTeamClaudeTimeMs(quota?["unified7dReset"])
        let sessionPercent = teamClaudeCurrentQuotaUtilization(
            teamClaudeQuotaNumber(quota?["unified5h"]),
            resetAtMs: sessionResetMs,
            nowMs: nowMs
        ).map { $0 * 100 }
        let weeklyPercent = teamClaudeCurrentQuotaUtilization(
            teamClaudeQuotaNumber(quota?["unified7d"]),
            resetAtMs: weeklyResetMs,
            nowMs: nowMs
        ).map { $0 * 100 }
        let fablePercent = fableUtilization.map { $0 * 100 }
        let measurementIssue = teamClaudeMeasurementIssue(
            enabled: enabled,
            status: status,
            sessionPercent: sessionPercent,
            weeklyPercent: weeklyPercent,
            fablePercent: fablePercent,
            lastUsed: lastUsed,
            thresholdPercent: threshold * 100
        )
        let isUsable = teamClaudeAccountIsUsable(
            enabled: enabled,
            status: status,
            sessionPercent: sessionPercent,
            weeklyPercent: weeklyPercent,
            fablePercent: fablePercent,
            thresholdPercent: threshold * 100
        )
        if isUsable { usable += 1 }
        accountRows.append(TeamClaudeAccountHealth(
            name: name,
            isCurrent: currentAccount == name,
            enabled: enabled,
            isUsable: isUsable,
            status: status,
            errorReason: teamClaudeErrorReason(account["errorReason"]),
            provider: tcString(account["provider"]),
            accountUuid: tcString(account["accountUuid"]),
            source: tcString(account["source"]) ?? tcString(account["type"]),
            totalTokens: totalTokens,
            totalRequests: teamClaudeBoundedCount(
                tcInt(usage?["totalRequests"]),
                maximum: 1_000_000_000_000
            ),
            sessionPercent: sessionPercent,
            sessionResetSeconds: sessionPercent == nil ? nil : secondsUntil(quota?["unified5hReset"], nowMs: nowMs),
            weeklyPercent: weeklyPercent,
            weeklyResetSeconds: weeklyPercent == nil ? nil : secondsUntil(quota?["unified7dReset"], nowMs: nowMs),
            fablePercent: fablePercent,
            fableResetSeconds: fablePercent == nil ? nil : secondsUntil(fable?["reset"], nowMs: nowMs),
            probedAt: lastUsed,
            measurementIssue: measurementIssue,
            usableFromProxy: teamClaudeStatusBool(account["usable"]),
            fableMeasurementCurrent: teamClaudeStatusBool(account["enabled"]) != nil,
            inflightCount: teamClaudeConcurrencyValue(account["inflight"]),
            concurrentCapacity: teamClaudeConcurrencyValue(account["maxConcurrent"], positive: true),
            subscriptionConfirmation: teamClaudeSubscriptionConfirmation(account["subscription"] as? [String: Any], now: Date(timeIntervalSince1970: Double(nowMs) / 1000)),
            subscriptionEndReached: (account["subscription"] as? [String: Any])?["state"] as? String == "end-date-reached",
            subscriptionEndsAt: parseTeamClaudeTimeMs((account["subscription"] as? [String: Any])?["endsAt"]).map { Date(timeIntervalSince1970: Double($0) / 1000) },
            sessionResetAt: sessionResetMs.map { Date(timeIntervalSince1970: Double($0) / 1000) },
            weeklyResetAt: weeklyResetMs.map { Date(timeIntervalSince1970: Double($0) / 1000) },
            fableResetAt: parseTeamClaudeTimeMs(fable?["reset"]).map { Date(timeIntervalSince1970: Double($0) / 1000) }
        ))
    }

    let liveNames = Set(accountRows.map(\.name))
    let accountDrift = config == nil
        ? TeamClaudeAccountDrift(missingFromServer: [], extraOnServer: [], stateMismatch: [])
        : teamClaudeAccountDrift(
            configuredNames: configuredRows.map(\.name),
            serverNames: Array(liveNames),
            configuredEnabled: configuredRows.reduce(into: [String: Bool]()) { $0[$1.name] = $1.enabled },
            serverEnabled: accountRows.reduce(into: [String: Bool]()) { $0[$1.name] = $1.enabled }
        )
    let missingConfiguredRows = configuredRows.filter { accountDrift.missingFromServer.contains($0.name) }
    accountRows.append(contentsOf: missingConfiguredRows)
    disabled += missingConfiguredRows.filter { !$0.enabled }.count
    let measurementPending = accountRows.filter { $0.measurementIssue?.canMeasureNow == true }.count
    let measurementUnavailable = accountRows.filter {
        $0.measurementIssue?.isMeasurementUnavailable == true
    }.count
    let quotaLimited = accountRows.filter {
        $0.measurementIssue?.isQuotaLimited == true
    }.count

    let reachable = status != nil
    let fableAllOver = fableKnown > 0 && fableOver == fableKnown
    let overallStatus = teamClaudeOverallStatus(TeamClaudeOverallStatusInput(
        serverReachable: reachable,
        configPresent: config != nil,
        allAccountsError: !accounts.isEmpty && error == accounts.count,
        quotaLimitedCount: quotaLimited,
        hasOtherWarning: fableOver > 0 || throttled > 0 || exhausted > 0 || disabled > 0
            || measurementPending > 0 || !accountDrift.isEmpty
    ))

    var hints: [String] = []
    if !reachable {
        hints.append("teamclaude 서버 연결 실패")
    }
    if config == nil {
        hints.append("teamclaude 계정 설정 파일 확인 필요")
    }
    if fableAllOver {
        hints.append("Fable 주간 쿼터가 모든 확인 계정에서 임계치 이상")
    } else if fableOver > 0 {
        hints.append("일부 계정의 Fable 주간 쿼터가 임계치 이상")
    }
    if !missingConfiguredRows.isEmpty {
        hints.append("설정 계정 \(missingConfiguredRows.count)개 서버 미반영 · 재시작 필요")
    }
    if !accountDrift.extraOnServer.isEmpty {
        hints.append("제거된 계정 \(accountDrift.extraOnServer.count)개 서버 잔존 · 재시작 필요")
    }
    if !accountDrift.stateMismatch.isEmpty {
        hints.append("계정 활성 상태 \(accountDrift.stateMismatch.count)개 서버 불일치 · 재시작 필요")
    }
    if measurementPending > 0 {
        hints.append("사용량 미측정 계정 \(measurementPending)개 · 지금 측정 가능")
    }
    if measurementUnavailable > 0 {
        hints.append("일시 제한 상태 확인이 필요한 계정 \(measurementUnavailable)개")
    }

    let retryAfter = computeTeamClaudeRetryAfterSeconds(
        accounts: accounts,
        threshold: threshold,
        nowMs: nowMs
    )

    // 프록시가 내보내는 host 메트릭 (구버전 서버는 없을 수 있어 전부 옵셔널 안전 파싱)
    let hostMetrics: TeamClaudeHostMetrics? = tcDict(status?["host"]).map { host in
        let cpu = tcDict(host["cpu"])
        let memory = tcDict(host["memory"])
        let load1 = (cpu?["loadavg"] as? [Any])?.first.flatMap(tcDouble)
        return TeamClaudeHostMetrics(
            cpuPercent: tcDouble(cpu?["usedPct"]),
            cores: tcInt(cpu?["cores"]),
            loadavg1: load1,
            memUsedPercent: tcDouble(memory?["usedPct"]),
            memUsedBytes: tcDouble(memory?["usedBytes"]).flatMap(teamClaudeSafeInt64).map(Int.init),
            memTotalBytes: tcDouble(memory?["totalBytes"]).flatMap(teamClaudeSafeInt64).map(Int.init),
            sampledAt: tcString(host["sampledAt"])
        )
    }

    var health = TeamClaudeHealth(
        checkedAt: now,
        overallStatus: overallStatus,
        configPresent: config != nil,
        serverReachable: reachable,
        serverPort: port,
        serverPid: tcInt(server?["pid"]),
        accountTotal: max(accounts.count, configAccounts),
        accountConfigured: configAccounts,
        accountActive: active,
        accountUsable: usable,
        accountThrottled: throttled,
        accountExhausted: exhausted,
        accountError: error,
        accountDisabled: disabled,
        accountConfigDrift: accountDrift.count,
        inflight: inflight,
        capacity: capacity,
        fableKnown: fableKnown,
        fableOver: fableOver,
        fableMaxPercent: fableMax.map(round1),
        fableAvgPercent: fableKnown > 0 ? round1(fableSum / Double(fableKnown)) : nil,
        quotaThresholdPercent: threshold * 100,
        retryAfterSeconds: retryAfter,
        accounts: accountRows,
        hints: hints,
        host: hostMetrics
    )
    health.runtimeSummary = teamRuntimeSummary(status?["runtime"])
    health.runtimeSummaryShort = teamRuntimeSummary(status?["runtime"], short: true)
    return health
}

func teamClaudeRetainingQuota(
    candidate: TeamClaudeHealth,
    previous: TeamClaudeHealth
) -> TeamClaudeHealth {
    let elapsedSeconds = max(0, Int(candidate.checkedAt.timeIntervalSince(previous.checkedAt)))
    let quotaPendingAccounts = previous.accounts.map { account in
        let sessionResetSeconds = teamClaudeAdjustedResetSeconds(
            account.sessionResetSeconds,
            elapsedSeconds: elapsedSeconds
        )
        return TeamClaudeAccountHealth(
            name: account.name,
            isCurrent: account.isCurrent,
            enabled: account.enabled,
            isUsable: account.isUsable,
            status: account.status,
            errorReason: account.errorReason,
            provider: account.provider,
            accountUuid: account.accountUuid,
            source: account.source,
            totalTokens: account.totalTokens,
            totalRequests: account.totalRequests,
            sessionPercent: sessionResetSeconds == nil ? nil : account.sessionPercent,
            sessionResetSeconds: sessionResetSeconds,
            weeklyPercent: nil,
            weeklyResetSeconds: nil,
            fablePercent: nil,
            fableResetSeconds: nil,
            probedAt: account.probedAt,
            measurementIssue: account.measurementIssue,
            usableFromProxy: account.usableFromProxy,
            fableMeasurementCurrent: false,
            inflightCount: account.inflightCount,
            concurrentCapacity: account.concurrentCapacity,
            subscriptionConfirmation: account.subscriptionConfirmation,
            subscriptionEndReached: account.subscriptionEndReached,
            subscriptionEndsAt: account.subscriptionEndsAt,
            sessionResetAt: account.sessionResetAt, weeklyResetAt: account.weeklyResetAt, fableResetAt: account.fableResetAt
        )
    }
    let quotaPending = TeamClaudeHealth(
        checkedAt: candidate.checkedAt,
        overallStatus: previous.overallStatus,
        configPresent: previous.configPresent,
        serverReachable: previous.serverReachable,
        serverPort: previous.serverPort,
        serverPid: previous.serverPid,
        accountTotal: previous.accountTotal,
        accountConfigured: previous.accountConfigured,
        accountActive: previous.accountActive,
        accountUsable: previous.accountUsable,
        accountThrottled: previous.accountThrottled,
        accountExhausted: previous.accountExhausted,
        accountError: previous.accountError,
        accountDisabled: previous.accountDisabled,
        accountConfigDrift: previous.accountConfigDrift,
        inflight: previous.inflight,
        capacity: previous.capacity,
        fableKnown: previous.fableKnown,
        fableOver: previous.fableOver,
        fableMaxPercent: previous.fableMaxPercent,
        fableAvgPercent: previous.fableAvgPercent,
        quotaThresholdPercent: previous.quotaThresholdPercent,
        retryAfterSeconds: teamClaudeAdjustedResetSeconds(
            previous.retryAfterSeconds,
            elapsedSeconds: elapsedSeconds
        ),
        accounts: quotaPendingAccounts,
        hints: previous.hints,
        host: previous.host
    )
    let adjusted = teamClaudeHealthMergingQuota(candidate: quotaPending, previous: previous)

    var merged = TeamClaudeHealth(
        checkedAt: candidate.checkedAt,
        overallStatus: "error",
        configPresent: candidate.configPresent,
        serverReachable: false,
        serverPort: candidate.serverPort,
        serverPid: candidate.serverPid,
        accountTotal: max(candidate.accountTotal, adjusted.accountTotal),
        accountConfigured: max(candidate.accountConfigured, adjusted.accountConfigured),
        accountActive: adjusted.accountActive,
        accountUsable: adjusted.accountUsable,
        accountThrottled: adjusted.accountThrottled,
        accountExhausted: adjusted.accountExhausted,
        accountError: adjusted.accountError,
        accountDisabled: adjusted.accountDisabled,
        accountConfigDrift: adjusted.accountConfigDrift,
        inflight: adjusted.inflight,
        capacity: adjusted.capacity,
        fableKnown: adjusted.fableKnown,
        fableOver: adjusted.fableOver,
        fableMaxPercent: adjusted.fableMaxPercent,
        fableAvgPercent: adjusted.fableAvgPercent,
        quotaThresholdPercent: adjusted.quotaThresholdPercent,
        retryAfterSeconds: adjusted.retryAfterSeconds,
        accounts: adjusted.accounts,
        hints: candidate.hints + ["서버 재연결 중 · 마지막 정상 주간/Fable 표시"],
        host: candidate.host
    )
    merged.runtimeSummary = candidate.runtimeSummary
    merged.runtimeSummaryShort = candidate.runtimeSummaryShort
    return merged
}

func teamClaudeQuotaPair(for account: TeamClaudeAccountHealth) -> TeamClaudeQuotaPair? {
    teamClaudeQuotaPair(
        weeklyPercent: account.weeklyPercent,
        weeklyResetSeconds: account.weeklyResetSeconds,
        fablePercent: account.fablePercent,
        fableResetSeconds: account.fableResetSeconds
    )
}

func teamClaudeAccountMergingQuota(
    candidate: TeamClaudeAccountHealth,
    previous: TeamClaudeAccountHealth?,
    elapsedSeconds: Int,
    thresholdPercent: Double,
    observedAt: Date
) -> TeamClaudeAccountHealth {
    let candidatePair = teamClaudeQuotaPair(for: candidate)
    let previousPair = teamClaudeAdjustedQuotaPair(
        previous.flatMap(teamClaudeQuotaPair(for:)),
        elapsedSeconds: elapsedSeconds
    )
    let mergedPair = teamClaudeMergedQuotaPair(
        candidate: candidatePair,
        previous: previousPair
    )
    let weeklyPercent = mergedPair?.weeklyPercent ?? candidate.weeklyPercent
    let fablePercent = mergedPair?.fablePercent ?? candidate.fablePercent
    let measurementIssue = teamClaudeMeasurementIssue(
        enabled: candidate.enabled,
        status: candidate.status,
        sessionPercent: candidate.sessionPercent,
        weeklyPercent: weeklyPercent,
        fablePercent: fablePercent,
        lastUsed: candidate.probedAt,
        thresholdPercent: thresholdPercent,
        now: observedAt
    )
    let isUsable = teamClaudeAccountIsUsable(
        enabled: candidate.enabled,
        status: candidate.status,
        sessionPercent: candidate.sessionPercent,
        weeklyPercent: weeklyPercent,
        fablePercent: fablePercent,
        thresholdPercent: thresholdPercent
    )

    return TeamClaudeAccountHealth(
        name: candidate.name,
        isCurrent: candidate.isCurrent,
        enabled: candidate.enabled,
        isUsable: isUsable,
        status: candidate.status,
        errorReason: candidate.errorReason,
        provider: candidate.provider,
        accountUuid: candidate.accountUuid,
        source: candidate.source,
        totalTokens: candidate.totalTokens,
        totalRequests: candidate.totalRequests,
        sessionPercent: candidate.sessionPercent,
        sessionResetSeconds: candidate.sessionResetSeconds,
        weeklyPercent: weeklyPercent,
        weeklyResetSeconds: mergedPair?.weeklyResetSeconds ?? candidate.weeklyResetSeconds,
        fablePercent: fablePercent,
        fableResetSeconds: mergedPair?.fableResetSeconds ?? candidate.fableResetSeconds,
        probedAt: candidate.probedAt,
        measurementIssue: measurementIssue,
        usableFromProxy: candidate.usableFromProxy,
        fableMeasurementCurrent: candidate.fableMeasurementCurrent
            && candidate.sessionPercent != nil && candidate.weeklyPercent != nil && candidate.fablePercent != nil
            && (candidate.sessionResetSeconds ?? 0) > 0 && (candidate.weeklyResetSeconds ?? 0) > 0
            && (candidate.fableResetSeconds ?? 0) > 0,
        inflightCount: candidate.inflightCount,
        concurrentCapacity: candidate.concurrentCapacity,
        subscriptionConfirmation: candidate.subscriptionConfirmation,
        subscriptionEndReached: candidate.subscriptionEndReached,
        subscriptionEndsAt: candidate.subscriptionEndsAt,
        sessionResetAt: candidate.sessionResetAt, weeklyResetAt: candidate.weeklyResetAt, fableResetAt: candidate.fableResetAt
    )
}

func teamClaudeHealthMergingQuota(
    candidate: TeamClaudeHealth,
    previous: TeamClaudeHealth?
) -> TeamClaudeHealth {
    let previousByName = (previous?.accounts ?? []).reduce(into: [String: TeamClaudeAccountHealth]()) {
        $0[$1.name] = $1
    }
    let elapsedSeconds = previous.map {
        max(0, Int(candidate.checkedAt.timeIntervalSince($0.checkedAt)))
    } ?? 0
    let thresholdPercent = candidate.quotaThresholdPercent
    let retainedPreviousQuota = candidate.accounts.contains { account in
        teamClaudeQuotaPair(for: account) == nil
            && teamClaudeAdjustedQuotaPair(
                previousByName[account.name].flatMap(teamClaudeQuotaPair(for:)),
                elapsedSeconds: elapsedSeconds
            ) != nil
    }
    let accounts = candidate.accounts.map {
        teamClaudeAccountMergingQuota(
            candidate: $0,
            previous: previousByName[$0.name],
            elapsedSeconds: elapsedSeconds,
            thresholdPercent: thresholdPercent,
            observedAt: candidate.checkedAt
        )
    }
    let fableValues = accounts.compactMap { teamClaudeQuotaPair(for: $0)?.fablePercent }
    let fableSummary = teamClaudeFableSummary(
        values: fableValues,
        thresholdPercent: thresholdPercent
    )
    let quotaRetryAfter = accounts.compactMap { account -> Int? in
        var resetCandidates: [Int] = []
        if let percent = account.sessionPercent,
           percent >= thresholdPercent,
           let reset = account.sessionResetSeconds {
            resetCandidates.append(reset)
        }
        let displayPair = teamClaudeQuotaPair(for: account)
        if let percent = displayPair?.weeklyPercent,
           percent >= thresholdPercent,
           let reset = displayPair?.weeklyResetSeconds {
            resetCandidates.append(reset)
        }
        if let percent = displayPair?.fablePercent,
           percent >= thresholdPercent,
           let reset = displayPair?.fableResetSeconds {
            resetCandidates.append(reset)
        }
        return resetCandidates.max()
    }.min()
    let retryAfter = quotaRetryAfter ?? candidate.retryAfterSeconds
    let quotaLimited = accounts.filter { $0.measurementIssue?.isQuotaLimited == true }.count
    let measurementPending = accounts.filter { $0.measurementIssue?.canMeasureNow == true }.count
    let overallStatus = teamClaudeOverallStatus(TeamClaudeOverallStatusInput(
        serverReachable: candidate.serverReachable,
        configPresent: candidate.configPresent,
        allAccountsError: !accounts.isEmpty && candidate.accountError == accounts.count,
        quotaLimitedCount: quotaLimited,
        hasOtherWarning: fableSummary.over > 0 || candidate.accountThrottled > 0
            || candidate.accountExhausted > 0 || candidate.accountDisabled > 0
            || measurementPending > 0 || candidate.accountConfigDrift > 0
    ))

    var merged = TeamClaudeHealth(
        checkedAt: candidate.checkedAt,
        overallStatus: overallStatus,
        configPresent: candidate.configPresent,
        serverReachable: candidate.serverReachable,
        serverPort: candidate.serverPort,
        serverPid: candidate.serverPid,
        accountTotal: candidate.accountTotal,
        accountConfigured: candidate.accountConfigured,
        accountActive: candidate.accountActive,
        accountUsable: accounts.filter(\.isUsable).count,
        accountThrottled: candidate.accountThrottled,
        accountExhausted: candidate.accountExhausted,
        accountError: candidate.accountError,
        accountDisabled: candidate.accountDisabled,
        accountConfigDrift: candidate.accountConfigDrift,
        inflight: candidate.inflight,
        capacity: candidate.capacity,
        fableKnown: fableSummary.known,
        fableOver: fableSummary.over,
        fableMaxPercent: fableSummary.maximum,
        fableAvgPercent: fableSummary.average,
        quotaThresholdPercent: thresholdPercent,
        retryAfterSeconds: retryAfter,
        accounts: accounts,
        hints: retainedPreviousQuota
            ? candidate.hints + ["일부 한도 동기화 중 · 계정 상태는 최신"]
            : candidate.hints,
        host: candidate.host
    )
    merged.runtimeSummary = candidate.runtimeSummary
    merged.runtimeSummaryShort = candidate.runtimeSummaryShort
    return merged
}

// MARK: - ccusage 호출

// npx 절대경로 후보 probing — zsh 완전 우회 (launchd 환경에서 .zshrc 초기화가 hang하는 문제 회피).
// 직원 PC마다 Node 설치 방식이 다르다(fnm / Homebrew Apple Silicon / Intel / 공식 installer).
// commands.rs 의 run_tsx_script 다중 fallback 패턴과 동일하게 첫 존재 후보를 사용한다.
// 실행 시 npx는 같은 디렉토리의 node 바이너리를 찾으므로 PATH에 모든 후보 bin 디렉토리 명시.

// 존재하는 첫 npx 절대경로 + 그 bin 디렉토리 반환. 못 찾으면 PATH 의존 "npx" 폴백.
func resolveNpx(home: String) -> (exec: String, bin: String) {
    let fnmBin = "\(home)/.local/share/fnm/aliases/default/bin"
    let candidates = [
        "\(fnmBin)/npx",          // fnm default symlink
        "/opt/homebrew/bin/npx",  // Homebrew (Apple Silicon)
        "/usr/local/bin/npx",     // Homebrew (Intel) / 공식 Node installer
    ]
    let fm = FileManager.default
    for c in candidates where fm.fileExists(atPath: c) {
        return (c, (c as NSString).deletingLastPathComponent)
    }
    // 모두 없으면 PATH 의존 (env PATH 가 npx 를 찾도록)
    return ("/usr/bin/env", fnmBin)
}

/// npx ccusage <subcommand> --json --offline 을 실행해 stdout JSON Data 반환. 실패 시 nil.
/// daily/weekly/monthly 공용 — 각 호출은 별도 tmp 파일(서브커맨드명 포함)로 redirect.
func runCcusageRaw(_ subcommand: String) -> Data? {
    let process = Process()
    let home = NSHomeDirectory()
    let fnmBin = "\(home)/.local/share/fnm/aliases/default/bin"
    let npx = resolveNpx(home: home)
    if npx.exec == "/usr/bin/env" {
        // 절대경로 후보 미발견 → env 로 PATH 탐색
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["npx", "--yes", "ccusage", subcommand, "--json", "--offline"]
    } else {
        process.executableURL = URL(fileURLWithPath: npx.exec)
        process.arguments = ["--yes", "ccusage", subcommand, "--json", "--offline"]
    }

    var env = ProcessInfo.processInfo.environment
    // 발견된 npx 의 bin 을 PATH 최우선 + 모든 일반 후보 디렉토리 포함.
    env["PATH"] = "\(npx.bin):\(fnmBin):/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["HOME"] = home
    process.environment = env

    // 142KB JSON > 64KB pipe buffer → 자식 write block deadlock 회피용 파일 redirect
    let tmpPath = "/tmp/cc-menubar-ccusage-\(subcommand)-\(getpid()).json"
    FileManager.default.createFile(atPath: tmpPath, contents: nil, attributes: nil)
    guard let writeHandle = FileHandle(forWritingAtPath: tmpPath) else {
        print("CCUSAGE-FAIL[\(subcommand)]: tmp 파일 생성 실패 \(tmpPath)")
        fflush(stdout)
        return nil
    }
    process.standardOutput = writeHandle
    guard let nullError = FileHandle(forWritingAtPath: "/dev/null") else {
        writeHandle.closeFile()
        return nil
    }
    process.standardError = nullError

    guard let result = runTrustedProcessInIsolatedGroup(
        process,
        timeoutSeconds: 60,
        terminationGraceMicroseconds: 700_000
    ) else {
        print("CCUSAGE-FAIL[\(subcommand)]: 격리 프로세스 실행 실패")
        fflush(stdout)
        writeHandle.closeFile()
        nullError.closeFile()
        return nil
    }
    if result.timedOut {
        print("CCUSAGE-TIMEOUT[\(subcommand)]: 60초 초과, 강제 종료")
        fflush(stdout)
    }
    writeHandle.closeFile()
    nullError.closeFile()

    let data = (try? Data(contentsOf: URL(fileURLWithPath: tmpPath))) ?? Data()
    try? FileManager.default.removeItem(atPath: tmpPath)
    print("CCUSAGE[\(subcommand)]: exit=\(result.terminationStatus) bytes=\(data.count)")
    fflush(stdout)

    guard result.terminationStatus == 0, !data.isEmpty else { return nil }
    return data
}

struct IsolatedProcessResult {
    let terminationStatus: Int32
    let timedOut: Bool
}

private func withOwnedCStringArray<Result>(
    _ values: [String],
    _ body: (UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Result
) -> Result {
    var pointers: [UnsafeMutablePointer<CChar>?] = values.map { strdup($0) }
    pointers.append(nil)
    defer {
        for case let pointer? in pointers {
            free(pointer)
        }
    }
    return pointers.withUnsafeMutableBufferPointer { buffer in
        body(buffer.baseAddress!)
    }
}

private func decodedWaitStatus(_ status: Int32) -> Int32 {
    let terminatingSignal = status & 0x7f
    if terminatingSignal == 0 {
        return (status >> 8) & 0xff
    }
    return 128 + terminatingSignal
}

private func childHasExitedWithoutReaping(_ pid: pid_t) -> Bool? {
    var info = siginfo_t()
    let result = waitid(
        P_PID,
        UInt32(bitPattern: pid),
        &info,
        WEXITED | WNOHANG | WNOWAIT
    )
    if result == 0 {
        return info.si_pid == pid
    }
    return errno == EINTR ? false : nil
}

private func reapChild(_ pid: pid_t) -> Int32? {
    var status: Int32 = 0
    while true {
        let result = waitpid(pid, &status, 0)
        if result == pid { return decodedWaitStatus(status) }
        if result == -1, errno == EINTR { continue }
        return nil
    }
}

/// `setsid`/`setpgid`로 의도적으로 탈출하지 않는 QJC 고정 CLI만 실행합니다.
func runTrustedProcessInIsolatedGroup(
    _ process: Process,
    timeoutSeconds: Double,
    terminationGraceMicroseconds: useconds_t
) -> IsolatedProcessResult? {
    guard let executableURL = process.executableURL,
          executableURL.isFileURL,
          let standardOutput = process.standardOutput as? FileHandle,
          let standardError = process.standardError as? FileHandle else { return nil }

    var fileActions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&fileActions) == 0 else { return nil }
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    guard posix_spawn_file_actions_adddup2(
        &fileActions,
        standardOutput.fileDescriptor,
        STDOUT_FILENO
    ) == 0,
    posix_spawn_file_actions_adddup2(
        &fileActions,
        standardError.fileDescriptor,
        STDERR_FILENO
    ) == 0 else { return nil }

    var attributes: posix_spawnattr_t?
    guard posix_spawnattr_init(&attributes) == 0 else { return nil }
    defer { posix_spawnattr_destroy(&attributes) }
    let spawnFlags = Int16(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT)
    guard posix_spawnattr_setflags(&attributes, spawnFlags) == 0,
          posix_spawnattr_setpgroup(&attributes, 0) == 0 else { return nil }

    let executable = executableURL.path
    let arguments = [executable] + (process.arguments ?? [])
    let environment = (process.environment ?? ProcessInfo.processInfo.environment)
        .sorted { $0.key < $1.key }
        .map { "\($0.key)=\($0.value)" }
    var childPid: pid_t = 0
    let spawnResult = executable.withCString { executablePointer in
        withOwnedCStringArray(arguments) { argumentPointers in
            withOwnedCStringArray(environment) { environmentPointers in
                posix_spawn(
                    &childPid,
                    executablePointer,
                    &fileActions,
                    &attributes,
                    argumentPointers,
                    environmentPointers
                )
            }
        }
    }
    guard spawnResult == 0, childPid > 0 else { return nil }

    let timeoutNanoseconds = UInt64(max(timeoutSeconds, 0) * 1_000_000_000)
    let startedAt = DispatchTime.now().uptimeNanoseconds
    while DispatchTime.now().uptimeNanoseconds - startedAt < timeoutNanoseconds {
        guard let hasExited = childHasExitedWithoutReaping(childPid) else {
            _ = Darwin.killpg(childPid, SIGKILL)
            return reapChild(childPid).map {
                IsolatedProcessResult(terminationStatus: $0, timedOut: false)
            }
        }
        if hasExited {
            return reapChild(childPid).map {
                IsolatedProcessResult(terminationStatus: $0, timedOut: false)
            }
        }
        usleep(50_000)
    }

    // childPid는 직접 자식이며 여기까지 waitpid로 회수하지 않았습니다. 따라서
    // process group ID가 재사용되기 전에 TERM/KILL을 같은 그룹에 안전하게 보낼 수 있습니다.
    _ = Darwin.killpg(childPid, SIGTERM)
    if terminationGraceMicroseconds > 0 {
        usleep(terminationGraceMicroseconds)
    }
    _ = Darwin.killpg(childPid, SIGKILL)
    return reapChild(childPid).map {
        IsolatedProcessResult(terminationStatus: $0, timedOut: true)
    }
}

/// daily(필수) + weekly/monthly(정확도 향상, 실패 시 daily 파생 폴백) + 환율을 조합해 UsageData 반환.
/// 수동 호출용 동기 헬퍼이며, 메뉴바 갱신은 loadUsageInBackground 에서 daily quick 반영을 먼저 수행한다.
func runCcusage() -> UsageData? {
    guard let dailyData = runCcusageRaw("daily") else { return nil }
    let weeklyData = runCcusageRaw("weekly")
    let monthlyData = runCcusageRaw("monthly")
    let rate = fetchUsdKrwRate()
    let parsed = parseUsageData(daily: dailyData, weekly: weeklyData, monthly: monthlyData, rate: rate)
    print("CCUSAGE-PARSE: today=\(parsed?.today?.period ?? "nil") cost=\(parsed?.today?.totalCost ?? -1) thisMonth=\(parsed?.thisMonthCost ?? -1) rate=\(rate)")
    fflush(stdout)
    return parsed
}

func parseUsageData(daily dailyData: Data, weekly weeklyData: Data?, monthly monthlyData: Data?, rate: Double) -> UsageData? {
    guard let json = try? JSONSerialization.jsonObject(with: dailyData) as? [String: Any],
          let dailyArray = json["daily"] as? [[String: Any]] else {
        print("CCUSAGE-PARSE-FAIL: JSON 파싱 실패 (data prefix: \(String(data: dailyData.prefix(120), encoding: .utf8) ?? "non-utf8"))")
        fflush(stdout)
        return nil
    }
    print("CCUSAGE-PARSE: dailyArray.count=\(dailyArray.count)")
    fflush(stdout)

    // 오늘 날짜 (YYYY-MM-DD)
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    let todayStr = formatter.string(from: Date())

    // 이번 달 키 (YYYY-MM) + 이번 주 월요일 키 (YYYY-MM-DD) — ccusage native weekly/monthly period 매칭용
    let monthFmt = DateFormatter()
    monthFmt.dateFormat = "yyyy-MM"
    monthFmt.locale = Locale(identifier: "en_US_POSIX")
    let thisMonthKey = monthFmt.string(from: Date())

    let cal = Calendar(identifier: .gregorian)
    let nowDate = Date()
    let weekday = cal.component(.weekday, from: nowDate) // 1=일 .. 7=토
    let mondayOffset = weekday == 1 ? 6 : weekday - 2     // 월요일까지 거슬러 올라갈 일수
    let mondayDate = cal.date(byAdding: .day, value: -mondayOffset, to: cal.startOfDay(for: nowDate)) ?? nowDate
    let thisMondayKey = formatter.string(from: mondayDate)

    // JSON 큰 수는 NSNumber로 와서 Int/Double 캐스팅이 변동 가능 → 안전 추출
    func numInt(_ v: Any?) -> Int {
        if let n = v as? Int { return n }
        if let d = v as? Double { return Int(d) }
        if let n = v as? NSNumber { return n.intValue }
        return 0
    }
    func numDouble(_ v: Any?) -> Double {
        if let d = v as? Double { return d }
        if let n = v as? NSNumber { return n.doubleValue }
        return 0.0
    }

    // ccusage weekly/monthly Data → 지정 period 엔트리(cost/tokens/found) + totals(전체 누적, hasTotals)
    func pickPeriod(_ data: Data?, key: String, arrayKey: String)
        -> (cost: Double, tokens: Int, found: Bool, totalsCost: Double, totalsTokens: Int, hasTotals: Bool) {
        guard let data = data,
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = j[arrayKey] as? [[String: Any]] else {
            return (0, 0, false, 0, 0, false)
        }
        var cost = 0.0, tokens = 0, found = false
        for item in arr where (item["period"] as? String) == key {
            cost = numDouble(item["totalCost"]); tokens = numInt(item["totalTokens"]); found = true
        }
        var tc = 0.0, tt = 0, hasTotals = false
        if let t = j["totals"] as? [String: Any] {
            tc = numDouble(t["totalCost"]); tt = numInt(t["totalTokens"]); hasTotals = true
        }
        return (cost, tokens, found, tc, tt, hasTotals)
    }

    // 이번 달 모델별 분해 — monthly 현재 엔트리의 modelBreakdowns 우선, 없으면 daily(이번달) 집계.
    // codex(gpt) 모델 포함 추적.
    func parseModelBreakdown(_ monthlyData: Data?, monthKey: String) -> [ModelUsage] {
        var raw: [[String: Any]] = []
        if let data = monthlyData,
           let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let arr = j["monthly"] as? [[String: Any]],
           let cur = arr.first(where: { ($0["period"] as? String) == monthKey }),
           let bds = cur["modelBreakdowns"] as? [[String: Any]] {
            raw = bds
        } else if let dd = dailyData as Data?,  // 폴백: daily 이번달 엔트리들의 breakdowns
                  let dj = try? JSONSerialization.jsonObject(with: dd) as? [String: Any],
                  let darr = dj["daily"] as? [[String: Any]] {
            for e in darr where (e["period"] as? String)?.hasPrefix(monthKey) == true {
                if let bds = e["modelBreakdowns"] as? [[String: Any]] { raw.append(contentsOf: bds) }
            }
        }
        var acc: [String: (cost: Double, tokens: Int)] = [:]
        for b in raw {
            guard let name = b["modelName"] as? String else { continue }
            let cost = numDouble(b["cost"])
            let tok = numInt(b["inputTokens"]) + numInt(b["outputTokens"])
                    + numInt(b["cacheCreationTokens"]) + numInt(b["cacheReadTokens"])
            let prev = acc[name] ?? (0, 0)
            acc[name] = (prev.cost + cost, prev.tokens + tok)
        }
        return acc.map {
            ModelUsage(model: $0.key, label: shortenModelName($0.key), provider: providerOf($0.key),
                       cost: $0.value.cost, tokens: $0.value.tokens)
        }.sorted { $0.cost > $1.cost }
    }

    var days: [DailyUsage] = []
    for item in dailyArray {
        guard let period = item["period"] as? String else { continue }
        let totalCost = numDouble(item["totalCost"])
        let inputTokens = numInt(item["inputTokens"])
        let cacheCreationTokens = numInt(item["cacheCreationTokens"])
        let cacheReadTokens = numInt(item["cacheReadTokens"])
        let outputTokens = numInt(item["outputTokens"])

        var models: [String] = []
        if let breakdowns = item["modelBreakdowns"] as? [[String: Any]] {
            // 비용 기준 내림차순 정렬, 상위 2개 모델명 추출
            let sorted = breakdowns.sorted { ($0["cost"] as? Double ?? 0) > ($1["cost"] as? Double ?? 0) }
            for bd in sorted.prefix(2) {
                if let name = bd["modelName"] as? String {
                    models.append(shortenModelName(name))
                }
            }
        }

        days.append(DailyUsage(
            period: period,
            totalCost: totalCost,
            inputTokens: inputTokens,
            cacheCreationTokens: cacheCreationTokens,
            cacheReadTokens: cacheReadTokens,
            outputTokens: outputTokens,
            models: models
        ))
    }

    // 오늘 데이터
    let today = days.first(where: { $0.period == todayStr }) ?? days.last

    // 주간 비용: 최근 7일
    let recentDays = Array(days.suffix(7))
    let weeklyTotalCost = recentDays.reduce(0.0) { $0 + $1.totalCost }

    // native weekly/monthly 에서 이번 주/이번 달 정확 집계
    let weeklyPick = pickPeriod(weeklyData, key: thisMondayKey, arrayKey: "weekly")
    let monthlyPick = pickPeriod(monthlyData, key: thisMonthKey, arrayKey: "monthly")

    // 이번 달 모델별 분해 (codex 포함)
    let modelBreakdown = parseModelBreakdown(monthlyData, monthKey: thisMonthKey)

    func dailyTokens(_ d: DailyUsage) -> Int {
        d.inputTokens + d.cacheCreationTokens + d.cacheReadTokens + d.outputTokens
    }

    // 이번 주 — native 우선, 없으면 daily 파생(월요일 이후 합)
    let thisWeekCost: Double
    let thisWeekTokens: Int
    if weeklyPick.found {
        thisWeekCost = weeklyPick.cost
        thisWeekTokens = weeklyPick.tokens
    } else {
        let wd = days.filter { $0.period >= thisMondayKey && $0.period <= todayStr }
        thisWeekCost = wd.reduce(0.0) { $0 + $1.totalCost }
        thisWeekTokens = wd.reduce(0) { $0 + dailyTokens($1) }
    }

    // 이번 달 — native 우선, 없으면 daily 파생(YYYY-MM 합)
    let thisMonthCost: Double
    let thisMonthTokens: Int
    if monthlyPick.found {
        thisMonthCost = monthlyPick.cost
        thisMonthTokens = monthlyPick.tokens
    } else {
        let md = days.filter { $0.period.hasPrefix(thisMonthKey) }
        thisMonthCost = md.reduce(0.0) { $0 + $1.totalCost }
        thisMonthTokens = md.reduce(0) { $0 + dailyTokens($1) }
    }

    // 누적 — monthly totals(전체 기간, 정확) 우선 → daily totals 블록 → days 합산.
    // hasTotals(블록 존재)로 판정 — totalsCost==0(사용액 0)이어도 블록이 있으면 정상값.
    let totalsObj = json["totals"] as? [String: Any]
    let allTimeCost: Double
    let allTimeTokens: Int
    if monthlyPick.hasTotals {
        allTimeCost = monthlyPick.totalsCost
        allTimeTokens = monthlyPick.totalsTokens
    } else if let t = totalsObj {
        allTimeCost = numDouble(t["totalCost"])
        allTimeTokens = numInt(t["totalTokens"])
    } else {
        allTimeCost = days.reduce(0.0) { $0 + $1.totalCost }
        allTimeTokens = days.reduce(0) { $0 + dailyTokens($1) }
    }

    // 스파크라인/차트용 일별 비용 배열 (과거→오늘 순)
    let last7 = Array(days.suffix(7))
    let last14 = Array(days.suffix(14))
    let last7Costs = last7.map { $0.totalCost }
    let last14Costs = last14.map { $0.totalCost }

    // 일별 추이 상세 (날짜 + 비용 + 토큰)
    func toPoint(_ d: DailyUsage) -> DayPoint {
        DayPoint(
            date: d.period,
            cost: d.totalCost,
            tokens: d.inputTokens + d.cacheCreationTokens + d.cacheReadTokens + d.outputTokens
        )
    }
    let recent7Days = last7.map(toPoint)
    let recent14Days = last14.map(toPoint)

    return UsageData(
        today: today,
        weeklyTotalCost: weeklyTotalCost,
        thisWeekCost: thisWeekCost,
        thisWeekTokens: thisWeekTokens,
        thisMonthCost: thisMonthCost,
        thisMonthTokens: thisMonthTokens,
        allTimeCost: allTimeCost,
        allTimeTokens: allTimeTokens,
        totalDays: days.count,
        usdKrwRate: rate,
        modelBreakdown: modelBreakdown,
        last7Costs: last7Costs,
        last14Costs: last14Costs,
        recent7Days: recent7Days,
        recent14Days: recent14Days
    )
}

// MARK: - 환율 (USD → KRW)

func fetchUsdKrwRate() -> Double {
    let FALLBACK = 1450.0
    let cached = UserDefaults.standard.double(forKey: "usdKrwRate")
    print("FX: 로컬 캐시/폴백 사용 (cached=\(cached))")
    fflush(stdout)
    return cached > 0 ? cached : FALLBACK
}

/// USD → KRW 포맷: ₩1,234,567 (정수, 천단위)
func formatKRW(_ usd: Double, rate: Double) -> String {
    let krw = (usd * rate).rounded()
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.maximumFractionDigits = 0
    return "₩" + (f.string(from: NSNumber(value: krw)) ?? "\(Int(krw))")
}

/// USD → KRW 축약: ₩3.7천만 / ₩1.4억 / ₩14만 / ₩1,380 (메뉴바 롤링용)
func formatKRWShort(_ usd: Double, rate: Double) -> String {
    let krw = (usd * rate).rounded()
    let absK = Swift.abs(krw)
    let sign = krw < 0 ? "-" : ""
    if absK >= 100_000_000 {
        return sign + String(format: absK >= 1_000_000_000 ? "₩%.0f억" : "₩%.1f억", absK / 100_000_000)
    }
    if absK >= 10_000_000 { return sign + String(format: "₩%.1f천만", absK / 10_000_000) }
    if absK >= 10_000 {
        let man = (absK / 10_000).rounded()
        let f = NumberFormatter(); f.numberStyle = .decimal; f.maximumFractionDigits = 0
        return sign + "₩" + (f.string(from: NSNumber(value: man)) ?? "\(Int(man))") + "만"
    }
    let f = NumberFormatter(); f.numberStyle = .decimal; f.maximumFractionDigits = 0
    return sign + "₩" + (f.string(from: NSNumber(value: absK)) ?? "\(Int(absK))")
}

func dailyUsageTotalTokens(_ daily: DailyUsage) -> Int {
    daily.inputTokens + daily.cacheCreationTokens + daily.cacheReadTokens + daily.outputTokens
}

func replacingToday(in data: UsageData, with freshToday: DailyUsage) -> UsageData {
    guard let previousToday = data.today, previousToday.period == freshToday.period else { return data }
    let costDelta = freshToday.totalCost - previousToday.totalCost
    let tokenDelta = dailyUsageTotalTokens(freshToday) - dailyUsageTotalTokens(previousToday)

    func replacePoint(_ point: DayPoint) -> DayPoint {
        guard point.date == freshToday.period else { return point }
        return DayPoint(date: point.date, cost: freshToday.totalCost, tokens: dailyUsageTotalTokens(freshToday))
    }

    let recent7Days = data.recent7Days.map(replacePoint)
    let recent14Days = data.recent14Days.map(replacePoint)

    return UsageData(
        today: freshToday,
        weeklyTotalCost: max(0, data.weeklyTotalCost + costDelta),
        thisWeekCost: max(0, data.thisWeekCost + costDelta),
        thisWeekTokens: max(0, data.thisWeekTokens + tokenDelta),
        thisMonthCost: max(0, data.thisMonthCost + costDelta),
        thisMonthTokens: max(0, data.thisMonthTokens + tokenDelta),
        allTimeCost: max(0, data.allTimeCost + costDelta),
        allTimeTokens: max(0, data.allTimeTokens + tokenDelta),
        totalDays: data.totalDays,
        usdKrwRate: data.usdKrwRate,
        modelBreakdown: data.modelBreakdown,
        last7Costs: recent7Days.isEmpty ? data.last7Costs : recent7Days.map { $0.cost },
        last14Costs: recent14Days.isEmpty ? data.last14Costs : recent14Days.map { $0.cost },
        recent7Days: recent7Days,
        recent14Days: recent14Days
    )
}

// MARK: - 병렬 Claude Code 세션 감지

/// 현재 실행 중인 Claude CLI 인스턴스 수.
/// `claude --effort` 또는 `claude` 명령 패턴으로 감지. ccusage/cc-menubar 같은 자식 프로세스는 자동 제외.
func countParallelClaudeSessions() -> Int {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    process.arguments = ["-f", "^claude( |$)"]

    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()

    do { try process.run() } catch { return 0 }
    process.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let str = String(data: data, encoding: .utf8) else { return 0 }
    return str.split(separator: "\n").filter { !$0.isEmpty }.count
}

// MARK: - 그래픽 렌더링 (메뉴바 스파크라인 + 펄스 도트)

/// 메뉴바용 미니 스파크라인 NSImage. 최근 N일 비용을 막대 그래프로.
/// 마지막 막대(오늘)는 강조색, 나머지는 중간톤. 다크/라이트 자동 대응 위해 isTemplate=false 컬러 직접.
func makeSparklineImage(_ values: [Double], width: CGFloat = 34, height: CGFloat = 16) -> NSImage {
    let image = NSImage(size: NSSize(width: width, height: height))
    image.lockFocus()
    defer { image.unlockFocus() }

    guard !values.isEmpty, let maxV = values.max(), maxV > 0 else { return image }

    let count = values.count
    let gap: CGFloat = 1.5
    let barW = max(1.5, (width - gap * CGFloat(count - 1)) / CGFloat(count))
    let minBarH: CGFloat = 2.0

    for (i, v) in values.enumerated() {
        let ratio = CGFloat(v / maxV)
        let barH = max(minBarH, ratio * (height - 1))
        let x = CGFloat(i) * (barW + gap)
        let rect = NSRect(x: x, y: 0, width: barW, height: barH)
        let path = NSBezierPath(roundedRect: rect, xRadius: 0.8, yRadius: 0.8)
        // 마지막(오늘) 막대는 초록 강조, 나머지는 청록 그라데이션 톤
        if i == count - 1 {
            NSColor(calibratedRed: 0.16, green: 0.65, blue: 0.20, alpha: 1.0).setFill() // 초록 (오늘)
        } else {
            let alpha = 0.35 + 0.45 * (CGFloat(i) / CGFloat(max(count - 1, 1))) // 과거→최근 점점 진하게
            NSColor(calibratedRed: 0.0, green: 0.64, blue: 0.59, alpha: alpha).setFill() // 청록
        }
        path.fill()
    }
    return image
}

/// 펄스 도트 NSImage — 활성 시 채워진 컬러 원(프레임에 따라 크기 변동), idle 시 빈 회색 원.
func makePulseDot(active: Bool, frame: Int, size: CGFloat = 11) -> NSImage {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    defer { image.unlockFocus() }

    let center = NSPoint(x: size / 2, y: size / 2)
    if active {
        // 활성: 초록 채움 + 프레임에 따라 반경 펄스 (숨쉬는 효과)
        let pulse = [0.32, 0.42, 0.50, 0.42][frame % 4]
        let r = size * CGFloat(pulse)
        // 외곽 글로우
        let glowR = r + 2
        NSColor(calibratedRed: 0.16, green: 0.78, blue: 0.25, alpha: 0.25).setFill()
        NSBezierPath(ovalIn: NSRect(x: center.x - glowR, y: center.y - glowR, width: glowR * 2, height: glowR * 2)).fill()
        // 본체
        NSColor(calibratedRed: 0.16, green: 0.78, blue: 0.25, alpha: 1.0).setFill()
        NSBezierPath(ovalIn: NSRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2)).fill()
    } else {
        // idle: 회색 외곽선 원
        let r = size * 0.34
        let path = NSBezierPath(ovalIn: NSRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
        NSColor(calibratedWhite: 0.55, alpha: 0.7).setStroke()
        path.lineWidth = 1.4
        path.stroke()
    }
    return image
}

// MARK: - 드롭다운 차트 NSView

/// "2026-05-22" → "5/22" 날짜 축약
func shortDate(_ ymd: String) -> String {
    let parts = ymd.split(separator: "-")
    guard parts.count == 3 else { return ymd }
    let m = Int(parts[1]) ?? 0
    let d = Int(parts[2]) ?? 0
    return "\(m)/\(d)"
}

private let _ymdFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

/// "2026-05-22" → Date (오늘 판정용)
func dateFromYMD(_ ymd: String) -> Date? {
    _ymdFormatter.date(from: ymd)
}

// TeamClaudePalette(표·섹션 헤더가 공유하는 색·폰트)은 TeamClaudePalette.swift에 있다.
final class TeamClaudeTableView: NSView {
    var health: TeamClaudeHealth? {
        didSet {
            refreshTime()
            needsLayout = true
        }
    }
    private var refreshTimer: Timer?
    private(set) var evaluatedAt = Date()

    func refreshTime(now: Date = Date()) {
        evaluatedAt = now
        guard let health else { return }
        let total = max(health.accountTotal, health.accountConfigured)
        let availability = health.fableAvailability(now: now)
        let ready = availability.filter { $0.state == .ready }.count
        setAccessibilityLabel("TeamClaude, Fable 사용 가능 \(ready)/\(total), 라우팅 가능 \(health.accountUsable), 계정 연동 불일치 \(health.accountConfigDrift), 측정 필요 \(health.measurementPendingCount), 상태 확인 \(health.measurementUnavailableCount), 사용 한도 \(health.quotaLimitedCount), Fable 경고 \(health.fableOver), 상태 \(health.statusLabel)")
        setAccessibilityHelp(health.measurementPendingCount > 0 ? "Return 키를 누르면 미측정 계정을 지금 측정합니다." : nil)
        for (button, state) in zip(subscriptionButtons, availability) {
            button.refreshTitle(now: now, appearance: state.subscriptionAppearance)
        }
        if let laidOutLines, laidOutLines != health.rowLines(now: now, availability: availability) {
            self.laidOutLines = nil
            needsLayout = true
            onContentHeightChange?()
        }
        needsDisplay = true
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        refreshTimer?.invalidate()
        refreshTimer = nil
        guard window != nil else { return }
        refreshTime()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in self?.refreshTime() }
        RunLoop.main.add(timer, forMode: .common)
        refreshTimer = timer
    }

    deinit { refreshTimer?.invalidate() }
    var isMeasuring = false { didSet { needsDisplay = true } }
    var measurementDetail: String? { didSet { needsDisplay = true } }
    var onMeasure: (() -> Void)?
    var onReauthenticate: ((String, String?) -> Void)?
    private var measureActionRect = NSRect.zero
    private var measureRowRects: [NSRect] = []
    private var reauthButtons: [NSButton] = []
    private var reauthButtonTargets: [ObjectIdentifier: (name: String, accountUuid: String?)] = [:]
    private var reauthSignature = ""
    private var subscriptionButtons: [AccountSubscriptionButton] = []
    private var subscriptionSignature = ""
    /// layout()이 마지막으로 배치한 행별 보조 줄. 시간 경과·구독 자동 조회로 판정이 바뀌면 행 높이가 달라지므로
    /// 표 혼자 다시 그리지 않고 onContentHeightChange로 대시보드에 재구성을 맡긴다(표 프레임은 대시보드가 정한다).
    private var laidOutLines: [TeamClaudeRowLines]?
    var onContentHeightChange: (() -> Void)?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func reauthenticationRows() -> [(index: Int, name: String, accountUuid: String?)] {
        guard let health else { return [] }
        let availability = health.fableAvailability(now: evaluatedAt)
        return health.accounts.enumerated().compactMap { index, row in
            guard availability[index].subscriptionAppearance != .ended else { return nil }
            return teamClaudeCanReauthenticate(
                enabled: row.enabled,
                status: row.status,
                source: row.source,
                provider: row.provider,
                errorReason: row.errorReason
            ) ? (index, row.name, row.accountUuid) : nil
        }
    }

    private func ensureReauthenticationButtons() {
        let rows = reauthenticationRows()
        let signature = rows.map { "\($0.index):\($0.name):\($0.accountUuid ?? "-")" }.joined(separator: "|")
        guard signature != reauthSignature else { return }
        reauthSignature = signature
        reauthButtons.forEach { $0.removeFromSuperview() }
        reauthButtons.removeAll(keepingCapacity: true)
        reauthButtonTargets.removeAll(keepingCapacity: true)
        for row in rows {
            let button = NSButton(frame: .zero)
            button.title = "재인증 필요"
            button.bezelStyle = .rounded
            button.isBordered = true
            button.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
            button.contentTintColor = NSColor(calibratedRed: 0.96, green: 0.26, blue: 0.32, alpha: 1.0)
            button.setAccessibilityLabel("재인증 필요: \(row.name)")
            button.setAccessibilityHelp("이 계정으로 Claude OAuth를 다시 인증합니다.")
            button.toolTip = "\(row.name) 계정 재인증"
            button.target = self
            button.action = #selector(reauthenticateButtonClicked(_:))
            reauthButtons.append(button)
            reauthButtonTargets[ObjectIdentifier(button)] = (row.name, row.accountUuid)
            addSubview(button)
        }
    }

    private func ensureSubscriptionButtons() {
        let rows = health?.accounts ?? []
        let signature = rows.map { row in
            let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
            return "\(local.uuid ?? "-"):\(row.name):\(local.plan ?? "-"):\(row.subscriptionConfirmation?.state.rawValue ?? "-"):\(row.subscriptionConfirmation?.date ?? "-"):\(row.subscriptionConfirmation?.checkedAt.timeIntervalSince1970 ?? 0)"
        }.joined(separator: "|")
        guard signature != subscriptionSignature else {
            subscriptionButtons.forEach { $0.refreshTitle() }
            return
        }
        subscriptionSignature = signature
        subscriptionButtons.forEach { $0.removeFromSuperview() }
        subscriptionButtons = rows.map { row in
            let button = AccountSubscriptionButton(provider: "anthropic", accountUuid: row.accountUuid, accountName: row.name, confirmation: row.subscriptionConfirmation)
            button.onChange = { [weak self] in
                guard let self, let health = self.health else { return }
                self.health = health
            }
            addSubview(button)
            return button
        }
    }

    @objc private func reauthenticateButtonClicked(_ sender: NSButton) {
        guard let target = reauthButtonTargets[ObjectIdentifier(sender)] else { return }
        onReauthenticate?(target.name, target.accountUuid)
    }

    override func layout() {
        super.layout()
        ensureReauthenticationButtons()
        ensureSubscriptionButtons()
        refreshTime(now: evaluatedAt)
        guard let health else { return }
        let card = bounds.insetBy(dx: 8, dy: TeamClaudeCardMetrics.cardInset)
        let innerX = card.minX + 16
        let rowsTop = TeamClaudeCardMetrics.rowsTop(hostLine: health.hostSummaryText != nil)
        let buttonX = innerX + 750
        let buttonWidth = card.maxX - buttonX - 2
        let lines = health.rowLines(now: evaluatedAt)
        let origins = teamClaudeRowOrigins(lines)
        laidOutLines = lines
        let rows = reauthenticationRows()
        for (button, row) in zip(reauthButtons, rows) {
            button.frame = NSRect(
                x: buttonX,
                y: rowsTop + origins[row.index] + 1,
                width: buttonWidth,
                height: 24
            )
        }
        for (index, button) in subscriptionButtons.enumerated() {
            let rowY = rowsTop + origins[index]
            if let lineY = teamClaudeSubscriptionLineY(lines[index]) {
                button.setQuietEntry(false)
                button.frame = NSRect(x: innerX + 24, y: rowY + lineY,
                                      width: card.width - 70, height: TeamClaudeRowMetrics.subscriptionHeight)
            } else {
                // 기록이 없는 행: 줄을 세우지 않고 이름 줄 오른쪽에 조용히 둔다. 숨기면 입력 진입점이 사라지고,
                // 프로필 자동 조회도 이 버튼의 refreshTitle에 매달려 있어 버튼은 항상 살아 있어야 한다.
                button.setQuietEntry(true)
                button.frame = NSRect(x: innerX + TeamClaudeSubscriptionEntry.inlineX, y: rowY + 3,
                                      width: TeamClaudeSubscriptionEntry.inlineWidth, height: TeamClaudeSubscriptionEntry.inlineHeight)
            }
        }
        applyHoverAlpha()
    }

    /// 마우스가 올라간 행. 조용한 구독 진입점은 이 행에서만 또렷해진다.
    private var hoveredRow: Int? {
        didSet { if hoveredRow != oldValue { applyHoverAlpha() } }
    }
    private var hoverTrackingArea: NSTrackingArea?

    private func applyHoverAlpha() {
        for (index, button) in subscriptionButtons.enumerated() {
            button.alphaValue = button.isQuietEntry && index != hoveredRow ? TeamClaudeSubscriptionEntry.restingAlpha : 1
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTrackingArea { removeTrackingArea(hoverTrackingArea) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        hoverTrackingArea = area
    }

    override func mouseMoved(with event: NSEvent) {
        super.mouseMoved(with: event)
        guard let health, let lines = laidOutLines else { hoveredRow = nil; return }
        let y = convert(event.locationInWindow, from: nil).y - TeamClaudeCardMetrics.rowsTop(hostLine: health.hostSummaryText != nil)
        let origins = teamClaudeRowOrigins(lines)
        hoveredRow = zip(origins, origins.dropFirst()).enumerated().first { y >= $0.element.0 && y < $0.element.1 }?.offset
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hoveredRow = nil
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if measureActionRect.contains(point) || measureRowRects.contains(where: { $0.contains(point) }) {
            onMeasure?()
            return
        }
        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if (event.keyCode == 36 || event.charactersIgnoringModifiers == " "), health?.measurementPendingCount ?? 0 > 0, !isMeasuring {
            onMeasure?()
            return
        }
        super.keyDown(with: event)
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        if !measureActionRect.isEmpty { addCursorRect(measureActionRect, cursor: .pointingHand) }
        for rect in measureRowRects { addCursorRect(rect, cursor: .pointingHand) }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let health = health else { return }
        measureActionRect = .zero
        measureRowRects.removeAll(keepingCapacity: true)

        let card = bounds.insetBy(dx: 8, dy: TeamClaudeCardMetrics.cardInset)
        let bg = TeamClaudePalette.bg, panel2 = TeamClaudePalette.panel2
        let line = TeamClaudePalette.line, text = TeamClaudePalette.text, muted = TeamClaudePalette.muted
        let green = TeamClaudePalette.green, yellow = TeamClaudePalette.yellow
        let red = TeamClaudePalette.red, blue = TeamClaudePalette.blue
        let titleFont = TeamClaudePalette.titleFont, subFont = TeamClaudePalette.subFont
        let headFont = TeamClaudePalette.headFont, rowFont = TeamClaudePalette.rowFont
        let smallFont = TeamClaudePalette.smallFont

        func attrs(_ font: NSFont, _ color: NSColor) -> [NSAttributedString.Key: Any] {
            [.font: font, .foregroundColor: color]
        }
        func drawText(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            value.draw(at: NSPoint(x: x, y: y), withAttributes: attrs(font, color))
        }
        func drawRight(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            let a = attrs(font, color)
            let s = value.size(withAttributes: a)
            value.draw(at: NSPoint(x: x - s.width, y: y), withAttributes: a)
        }
        func tone(_ percent: Double?) -> NSColor {
            guard let percent = percent else { return muted }
            if percent >= 90 { return red }
            if percent >= 70 { return yellow }
            return green
        }
        func percentText(_ percent: Double?) -> String {
            guard let percent = percent else { return "-" }
            return "\(Int(percent.rounded()))%"
        }
        func probeAttempted(_ row: TeamClaudeAccountHealth) -> Bool {
            row.probedAt != nil || row.totalRequests > 0 || row.totalTokens > 0
        }
        func clipped(_ value: String, _ count: Int) -> String {
            if value.count <= count { return value }
            return String(value.prefix(max(0, count - 1))) + "…"
        }
        func fillRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        func strokeRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setStroke()
            let p = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            p.lineWidth = 1
            p.stroke()
        }
        func pill(_ value: String, x: CGFloat, y: CGFloat, color: NSColor) {
            let size = value.size(withAttributes: attrs(subFont, color))
            let rect = NSRect(x: x, y: y, width: size.width + 16, height: 22)
            fillRound(rect, color.withAlphaComponent(0.14), 11)
            strokeRound(rect, color.withAlphaComponent(0.38), 11)
            drawText(value, x + 8, y + 3.5, subFont, color)
        }
        func bar(_ percent: Double?, x: CGFloat, y: CGFloat, width: CGFloat, color: NSColor) {
            fillRound(NSRect(x: x, y: y, width: width, height: 7), NSColor.white.withAlphaComponent(0.10), 3.5)
            guard let percent = percent else { return }
            let fillW = max(3, width * CGFloat(max(0, min(100, percent)) / 100.0))
            fillRound(NSRect(x: x, y: y, width: fillW, height: 7), color, 3.5)
        }

        fillRound(card, bg, 14)
        strokeRound(card, line, 14)

        let innerX = card.minX + 16
        let hostLineShown = health.hostSummaryText != nil
        let topY = TeamClaudeCardMetrics.titleY(hostLine: hostLineShown)
        let actionRect = NSRect(x: card.maxX - 330, y: topY - 4, width: 314, height: 48)
        markDraw("TeamClaudeTableView.header")
        drawText("TeamClaude", innerX, topY, titleFont, text)
        let titleWidth = "TeamClaude".size(withAttributes: attrs(titleFont, text)).width
        pill(health.serverReachable ? "실행중" : "오프라인", x: innerX + titleWidth + 12, y: topY - 2, color: health.serverReachable ? green : red)
        let integrationLabel = health.accountConfigDrift == 0 ? "연동 정상" : "연동 불일치 \(health.accountConfigDrift)"
        let serverBase = "port \(health.serverPort ?? 0)  ·  pid \(health.serverPid.map(String.init) ?? "-")  ·  \(integrationLabel)"
        let serverColor = health.accountConfigDrift == 0 ? muted : yellow
        let serverLine = teamServerLine(
            base: serverBase,
            full: health.runtimeSummary,
            short: health.runtimeSummaryShort,
            maxWidth: actionRect.minX - 8 - innerX,
            measure: { $0.size(withAttributes: attrs(subFont, serverColor)).width }
        )
        drawText(serverLine, innerX, topY + 28, subFont, serverColor)
        if let hostText = health.hostSummaryText {
            drawText(hostText, innerX, topY + 48, subFont, health.hostIsWarning ? red : muted)
        }
        let availability = health.fableAvailability(now: evaluatedAt)
        subscriptionButtons.forEach { $0.refreshTitle(now: evaluatedAt) }
        let ready = availability.filter { $0.state == .ready }.count
        let limited = availability.filter { $0.state == .limited }.count
        let excluded = availability.filter { $0.state == .excluded }.count
        let unconfirmed = availability.filter { $0.state == .unconfirmed }.count
        let pendingCount = health.measurementPendingCount
        let actionColor: NSColor
        let actionTitle: String
        let actionDetail: String
        if isMeasuring {
            actionColor = blue
            actionTitle = "계정 사용량 측정 중"
            actionDetail = measurementDetail ?? "잠시만 기다려 주세요"
        } else if health.accountConfigDrift > 0 {
            actionColor = yellow
            actionTitle = "\(health.accountConfigDrift)개 계정 연동 불일치"
            actionDetail = "자동 동기화 중 · 서버 반영 확인"
        } else if pendingCount > 0 {
            actionColor = yellow
            actionTitle = "\(pendingCount)개 계정 측정 필요"
            if let measurementDetail, measurementDetail.contains("실패") || measurementDetail.contains("확인 필요") {
                actionDetail = measurementDetail
            } else {
                actionDetail = "클릭하여 지금 측정"
            }
            measureActionRect = actionRect
        } else if unconfirmed > 0 {
            actionColor = yellow
            actionTitle = "\(unconfirmed)개 계정 확인 필요"
            actionDetail = "최신 한도와 구독 종료일을 확인하세요"
        } else if excluded > 0 {
            actionColor = red
            actionTitle = "\(excluded)개 계정 이용 제외"
            actionDetail = "아래에서 구독·인증·비활성 상태 확인"
        } else if limited > 0 {
            actionColor = yellow
            actionTitle = "\(limited)개 계정 한도·요청 대기"
            actionDetail = "세션·전체 주간·Fable 모두 여유가 필요합니다"
        } else {
            actionColor = ready > 0 ? green : muted
            actionTitle = ready > 0 ? "\(ready)개 계정 Fable 사용 가능" : "등록된 계정이 없습니다"
            actionDetail = "세션·전체 주간·Fable 한도를 함께 확인"
        }
        fillRound(actionRect, actionColor.withAlphaComponent(0.11), 8)
        strokeRound(actionRect, actionColor.withAlphaComponent(0.45), 8)
        let actionIcon = isMeasuring ? "↻" : (pendingCount > 0 || unconfirmed > 0 || excluded > 0 || limited > 0 ? "!" : "✓")
        markDraw("TeamClaudeTableView.action")
        drawText(actionIcon, actionRect.minX + 12, actionRect.minY + 8, titleFont, actionColor)
        drawText(clipped(actionTitle, 28), actionRect.minX + 40, actionRect.minY + 6, subFont, actionColor)
        drawText(clipped(actionDetail, 38), actionRect.minX + 40, actionRect.minY + 25, smallFont, muted)

        // 요약 띠 한 줄: 왼쪽은 지금 쓸 수 있는 계정 이름, 오른쪽은 못 쓰는 계정의 분류별 수.
        // "Fable 사용 가능 N/총계"는 맨 위 요약 밴드와 섹션 헤더가 이미 말하므로 여기서 다시 세지 않는다(같은 숫자 두 번 금지).
        let stripY = TeamClaudeCardMetrics.stripY(hostLine: hostLineShown)
        let strip = NSRect(x: innerX, y: stripY, width: card.width - 32, height: TeamClaudeCardMetrics.stripHeight)
        markDraw("TeamClaudeTableView.stats")
        fillRound(strip, (ready > 0 ? green : muted).withAlphaComponent(0.10), 6)
        let stripTextY = strip.minY + 5
        var cursorX = strip.maxX - 10
        // 오른쪽부터 채운다: "확인 필요 14 · 구독·오류·비활성 3 · 한도·요청 대기 0" 순으로 뒤에서 앞으로.
        let breakdown: [(String, Int, NSColor)] = [
            ("확인 필요", unconfirmed, yellow), ("구독·오류·비활성", excluded, red), ("한도·요청 대기", limited, yellow),
        ]
        for (index, item) in breakdown.enumerated() {
            let color = item.1 > 0 ? item.2 : muted
            drawRight(String(item.1), cursorX, stripTextY, rowFont, color)
            cursorX -= String(item.1).size(withAttributes: attrs(rowFont, color)).width + 6
            drawRight(item.0, cursorX, stripTextY + 1, smallFont, muted)
            cursorX -= item.0.size(withAttributes: attrs(smallFont, muted)).width
            if index < breakdown.count - 1 {
                cursorX -= 10
                drawRight("·", cursorX, stripTextY + 1, smallFont, muted)
                cursorX -= 10
            }
        }
        let readyNames = availability
            .enumerated()
            .filter { $0.element.state == .ready }
            .map { $0.offset < health.accounts.count ? health.accounts[$0.offset].name : "" }
            .filter { !$0.isEmpty }
        let namesWidth = cursorX - 16 - (strip.minX + 10)
        let namesCapacity = max(8, Int(namesWidth / "가".size(withAttributes: attrs(smallFont, muted)).width * 1.6))
        let readySummary = readyNames.isEmpty
            ? "사용 가능 계정 없음"
            // TeamCodex 카드와 같은 문구를 쓴다. 폭을 아끼려고 한쪽만 줄이면 두 풀의 표기가 갈린다.
            : "사용 가능 계정: " + clipped(readyNames.joined(separator: " · "), namesCapacity)
        drawText(readySummary, strip.minX + 10, stripTextY + 1, smallFont, ready > 0 ? green : muted)

        let tableY = TeamClaudeCardMetrics.tableHeadY(hostLine: hostLineShown)
        fillRound(NSRect(x: innerX, y: tableY, width: card.width - 32, height: TeamClaudeCardMetrics.tableHeadHeight), panel2, 8)
        let headY = tableY + 9
        drawText("계정", innerX + 12, headY, headFont, muted)
        // 숫자 열은 값이 우측 정렬이므로 머리글도 값의 오른쪽 끝(퍼센트 끝 x)에 맞춘다.
        drawRight("세션 5h", innerX + 306, headY, headFont, muted)
        drawRight("전체 주간", innerX + 486, headY, headFont, muted)
        drawRight("Fable 주간", innerX + 674, headY, headFont, muted)
        // 이 열은 측정 시각뿐 아니라 오류 사유·측정 버튼·종료·재인증 버튼이 들어온다. 내용에 맞춰 "상태"다.
        drawText("상태", innerX + 790, headY, headFont, muted)

        markDraw("TeamClaudeTableView.rows")
        // layout()·teamContentHeight와 같은 판정으로 행 원점을 잡는다. 여기서 다른 기준을 쓰면 버튼과 글자가 어긋난다.
        let lines = health.rowLines(now: evaluatedAt, availability: availability)
        let origins = teamClaudeRowOrigins(lines)
        let rowsTop = TeamClaudeCardMetrics.rowsTop(hostLine: hostLineShown)
        for (i, row) in health.accounts.enumerated() {
            let y = rowsTop + origins[i]
            let rowRect = NSRect(x: innerX, y: y, width: card.width - 32, height: teamClaudeRowHeight(lines[i]))
            let state = availability[i]
            let subscriptionMuted = state.subscriptionAppearance.isMuted
            let inactive = TeamClaudePalette.inactive
            let showCurrent = row.isCurrent && !subscriptionMuted
            if showCurrent {
                fillRound(rowRect, green.withAlphaComponent(0.13), 7)
                strokeRound(rowRect, green.withAlphaComponent(0.32), 7)
            } else if i % 2 == 1 {
                fillRound(rowRect, NSColor.white.withAlphaComponent(0.035), 7)
            }
            let dotColor = subscriptionMuted ? inactive : state.state == .ready ? green : state.state == .excluded ? red : yellow
            if let reasonY = teamClaudeReasonLineY(lines[i]) {
                drawText(state.reason, innerX + 24, y + reasonY, subFont, dotColor)
            }
            fillRound(NSRect(x: innerX + 10, y: y + 9, width: 8, height: 8), dotColor, 4)
            let nameColor = subscriptionMuted ? inactive : showCurrent ? green : (row.status == "configured" ? muted : text)
            drawText((showCurrent ? ">" : " ") + clipped(row.name, 30), innerX + 24, y + 5, rowFont, nameColor)
            if state.subscriptionAppearance == .ended {
                for rightEdge: CGFloat in [306, 486, 674] {
                    drawRight("—", innerX + rightEdge, y + 5, rowFont, inactive)
                }
                drawText("종료", innerX + 790, y + 5, smallFont, inactive)
                continue
            }

            let attempted = probeAttempted(row)
            let session = teamClaudeSessionState(percent: row.sessionPercent, lastUsed: row.probedAt, now: evaluatedAt)
            let sessionPercent = session.percent
            let sesColor = subscriptionMuted ? inactive : tone(sessionPercent)
            drawRight(percentText(sessionPercent), innerX + 306, y + 5, rowFont, subscriptionMuted ? inactive : sessionPercent == nil ? blue : sesColor)
            bar(sessionPercent, x: innerX + 314, y: y + 10, width: 74, color: sesColor)
            let sessionDetail = session.isStale
                ? (row.measurementIssue == .quotaBlocked ? "한도리셋" : "재측정")
                : (sessionPercent != nil ? teamClaudeResetLabel(row.sessionResetSeconds, checkedAt: health.checkedAt, now: evaluatedAt, resetAt: row.sessionResetAt) : (attempted ? StatusVocabulary.needsCheck : StatusVocabulary.notMeasured))
            drawRight(sessionDetail, innerX + 442, y + 5, smallFont, muted)

            // 주간·Fable 독립 표시 — 프록시는 재시작 후 Fable(7d_oi) 창을 의도적으로
            // 스냅샷 복원하지 않고 재측정한다(self-lock 방지). 구 all-four 페어링
            // 가드(teamClaudeQuotaPair)는 Fable 미측정 계정의 주간 표시까지 막아
            // 두 열 모두 "동기화중"으로 떨어뜨렸다 (2026-07-22 사고).
            let wkPercent = row.weeklyPercent
            let wkColor = subscriptionMuted ? inactive : tone(wkPercent)
            drawRight(wkPercent != nil ? percentText(wkPercent) : StatusVocabulary.syncing, innerX + 486, y + 5, rowFont, subscriptionMuted ? inactive : wkPercent != nil ? wkColor : yellow)
            bar(wkPercent, x: innerX + 494, y: y + 10, width: 74, color: wkColor)
            drawRight(teamClaudeResetLabel(row.weeklyResetSeconds, checkedAt: health.checkedAt, now: evaluatedAt, resetAt: row.weeklyResetAt), innerX + 612, y + 5, smallFont, muted)

            let fbPercent = row.fablePercent
            let fbColor = subscriptionMuted ? inactive : tone(fbPercent)
            drawRight(fbPercent != nil ? percentText(fbPercent) : StatusVocabulary.notMeasured, innerX + 674, y + 5, rowFont, fbPercent != nil ? fbColor : muted)
            bar(fbPercent, x: innerX + 682, y: y + 10, width: 48, color: fbColor)
            if !teamClaudeCanReauthenticate(enabled: row.enabled, status: row.status,
                source: row.source, provider: row.provider, errorReason: row.errorReason) {
                drawRight(teamClaudeResetLabel(row.fableResetSeconds, checkedAt: health.checkedAt, now: evaluatedAt, resetAt: row.fableResetAt), innerX + 780, y + 5, smallFont, muted)
            }
            if teamClaudeCanReauthenticate(
                enabled: row.enabled,
                status: row.status,
                source: row.source,
                provider: row.provider,
                errorReason: row.errorReason
            ) {
                continue
            } else if row.status == "error" {
                let reasonText = teamAccountErrorReasonLabel(row.errorReason)
                drawText(reasonText, innerX + 790, y + 5, smallFont, red)
            } else if let issue = row.measurementIssue {
                if issue.canMeasureNow && !isMeasuring && !subscriptionMuted {
                    let rowActionRect = NSRect(x: innerX + 780, y: y + 2, width: 58, height: 22)
                    fillRound(rowActionRect, yellow.withAlphaComponent(0.13), 6)
                    strokeRound(rowActionRect, yellow.withAlphaComponent(0.42), 6)
                    drawText("측정", rowActionRect.minX + 16, y + 5, smallFont, yellow)
                    measureRowRects.append(rowActionRect)
                } else {
                    drawText(issue.compactText, innerX + 790, y + 5, smallFont, issue == .quotaBlocked ? red : muted)
                }
            } else {
                // 마지막 측정 시각. 없으면 "-" — 예전엔 계정 종류(oauth)로 채웠는데 그건 상태도 측정도 아니다.
                drawText(formatTeamClaudeProbe(row.probedAt), innerX + 790, y + 5, smallFont, muted)
            }
        }

        window?.invalidateCursorRects(for: self)

        let footerY = card.maxY - 32
        NSBezierPath.strokeLine(from: NSPoint(x: innerX, y: footerY - 8), to: NSPoint(x: card.maxX - 16, y: footerY - 8))
        let thresholdLabel = health.quotaThresholdPercent.isFinite ? String(format: "%.0f", health.quotaThresholdPercent) : "미확인"
        // 구독 기록 진입점은 행에서 감춰 두므로, 존재를 알리는 문장을 여기 한 번만 둔다.
        // 행마다 두면 기록 없는 계정이 대다수라 같은 문구가 표를 덮는다.
        drawText("Fable 가능 = 세션 + 전체 주간 + Fable 여유 · \(thresholdLabel)%부터 대기 · 미측정 제외 · 행에 마우스를 올리면 구독 기록",
                 innerX, footerY, smallFont, muted)
        markDraw("TeamClaudeTableView.done")
    }
}

final class ServiceAvailabilitySummaryView: NSView {
    /// 한 줄 요약 밴드. 예전 카드 3장(396pt)은 "N개 사용 가능"을 32pt로 말하고 바로 아래 표가 같은 수를 반복했다.
    /// 지금은 세 서비스의 사용 가능 수와 상태 색만 한 줄에 담는다 — "지금 쓸 수 있는가"는 여전히 첫눈에 보인다.
    static let preferredHeight: CGFloat = 48
    /// 왼쪽 "지금 사용 가능" 라벨이 차지하는 폭. 그 뒤를 세 서비스가 균등 분할한다.
    static let leadWidth: CGFloat = 104

    var teamClaude: TeamClaudeHealth? { didSet { refreshSummary() } }
    var teamCodex: TeamCodexPoolHealth? { didSet { refreshSummary() } }
    var evaluatedAt = Date() { didSet { refreshSummary() } }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("사용 가능 현황")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func refreshSummary() {
        let claudeNames: [String]
        if let health = teamClaude {
            let availability = health.fableAvailability(now: evaluatedAt)
            claudeNames = health.accounts.enumerated().compactMap { index, account in
                availability.indices.contains(index) && availability[index].state == .ready ? account.name : nil
            }
        } else {
            claudeNames = []
        }
        let codexNames = teamCodex?.accounts
            .filter { account in
                guard let pool = teamCodex else { return false }
                return account.isUsable(switchThresholdPercent: pool.switchThresholdPercent, now: evaluatedAt)
            }
            .map(\.name) ?? []
        let opusNames = teamClaude?.opusAvailability(now: evaluatedAt) ?? []
        let claudeLabel = claudeNames.isEmpty ? "사용 가능 계정 없음" : claudeNames.joined(separator: " · ")
        let codexLabel = codexNames.isEmpty ? "사용 가능 계정 없음" : codexNames.joined(separator: " · ")
        setAccessibilityLabel("사용 가능 현황, TeamClaude Fable \(claudeNames.count)개 \(claudeLabel), Opus \(opusNames.count)개 \(opusNames.joined(separator: " · ")), TeamCodex \(codexNames.count)개 \(codexLabel)")
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let card = bounds.insetBy(dx: 8, dy: 4)
        let bg = TeamClaudePalette.bg
        let line = TeamClaudePalette.line
        let text = TeamClaudePalette.text
        let muted = TeamClaudePalette.muted
        let green = TeamClaudePalette.green
        let yellow = TeamClaudePalette.yellow
        let red = TeamClaudePalette.red
        let gray = TeamClaudePalette.inactive
        let leadFont = TeamClaudePalette.summaryTitleFont
        let nameFont = TeamClaudePalette.summaryBodyFont
        let countFont = TeamClaudePalette.summaryValueFont
        let detailFont = TeamClaudePalette.summaryNameFont

        func attrs(_ font: NSFont, _ color: NSColor) -> [NSAttributedString.Key: Any] {
            [.font: font, .foregroundColor: color]
        }
        func width(_ value: String, _ font: NSFont) -> CGFloat {
            value.size(withAttributes: attrs(font, text)).width
        }
        func drawText(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            value.draw(at: NSPoint(x: x, y: y), withAttributes: attrs(font, color))
        }
        func fillRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        func strokeRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setStroke()
            let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            path.lineWidth = 1
            path.stroke()
        }
        func namesForClaude() -> [String] {
            guard let health = teamClaude else { return [] }
            let availability = health.fableAvailability(now: evaluatedAt)
            return health.accounts.enumerated().compactMap { index, account in
                availability.indices.contains(index) && availability[index].state == .ready ? account.name : nil
            }
        }
        func namesForCodex() -> [String] {
            guard let pool = teamCodex else { return [] }
            return pool.accounts.filter {
                $0.isUsable(switchThresholdPercent: pool.switchThresholdPercent, now: evaluatedAt)
            }.map(\.name)
        }
        // 색의 의미는 카드 시절과 같다: 미연동 회색, 서버 오프라인 빨강, 0개 노랑, 1개 이상 초록.
        func statusColor(_ count: Int, hasService: Bool, reachable: Bool) -> NSColor {
            guard hasService else { return gray }
            if !reachable { return red }
            return count > 0 ? green : yellow
        }
        /// 수 뒤에 붙는 설명. 사용 가능 계정이 있으면 이름(2개까지, 나머지는 +N), 없으면 왜 0인지.
        func detail(_ names: [String], hasService: Bool, reachable: Bool) -> (String, NSColor) {
            guard hasService else { return ("연동되지 않음", muted) }
            guard reachable else { return ("서버 오프라인", red) }
            guard !names.isEmpty else { return ("", muted) }
            let shown = names.prefix(2).joined(separator: " · ")
            return (names.count > 2 ? "\(shown) +\(names.count - 2)" : shown, text)
        }
        func clippedToWidth(_ value: String, _ font: NSFont, _ maxWidth: CGFloat) -> String {
            if width(value, font) <= maxWidth { return value }
            var trimmed = value
            while !trimmed.isEmpty, width(trimmed + "…", font) > maxWidth { trimmed.removeLast() }
            return trimmed.isEmpty ? "" : trimmed + "…"
        }

        fillRound(card, bg, 12)
        strokeRound(card, line, 12)
        let textY = card.minY + 12
        drawText("지금 사용 가능", card.minX + 16, textY + 1, leadFont, muted)

        let namesClaude = namesForClaude()
        let namesOpus = teamClaude?.opusAvailability(now: evaluatedAt) ?? []
        let namesCodex = namesForCodex()
        let claudeService = teamClaude != nil
        let claudeReachable = teamClaude?.serverReachable ?? false
        let codexService = teamCodex != nil
        let codexReachable = teamCodex?.serverReachable ?? false
        let columns: [(String, [String], NSColor, (String, NSColor))] = [
            ("Claude Fable", namesClaude,
             statusColor(namesClaude.count, hasService: claudeService, reachable: claudeReachable),
             detail(namesClaude, hasService: claudeService, reachable: claudeReachable)),
            ("Claude Opus", namesOpus,
             statusColor(namesOpus.count, hasService: claudeService, reachable: claudeReachable),
             detail(namesOpus, hasService: claudeService, reachable: claudeReachable)),
            ("Codex", namesCodex,
             statusColor(namesCodex.count, hasService: codexService, reachable: codexReachable),
             detail(namesCodex, hasService: codexService, reachable: codexReachable)),
        ]
        let columnsX = card.minX + 16 + Self.leadWidth
        let columnWidth = (card.maxX - 16 - columnsX) / CGFloat(columns.count)
        guard columnWidth > 0 else { return }
        for (index, column) in columns.enumerated() {
            let x = columnsX + CGFloat(index) * columnWidth
            fillRound(NSRect(x: x, y: card.midY - 4, width: 8, height: 8), column.2, 4)
            var cursor = x + 16
            drawText(column.0, cursor, textY, nameFont, text)
            cursor += width(column.0, nameFont) + 8
            let count = "\(column.1.count)개"
            drawText(count, cursor, textY - 1, countFont, column.2)
            cursor += width(count, countFont) + 8
            let remaining = x + columnWidth - 12 - cursor
            if !column.3.0.isEmpty, remaining > 0 {
                drawText(clippedToWidth(column.3.0, detailFont, remaining), cursor, textY + 2, detailFont, column.3.1)
            }
        }
    }
}

/// 메뉴 대시보드 한 장. 요약 카드 아래로 섹션(제목 띠 + 본문)이 이어지는 하나의 연속 문서다 — 섹션별 안쪽 스크롤은 없다.
/// 화면보다 길면 AppDelegate.hostDashboard가 통째로 NSScrollView에 넣고 현재 섹션 이름을 고정 헤더로 띄운다.
/// 대시보드 갱신 비용을 단계별로 재는 작은 누산기. DASHBOARD-REFRESH 로그의 `phases=` 필드가 된다.
final class DashboardRefreshPhases {
    private var marks: [(String, Double)] = []
    private var last = ProcessInfo.processInfo.systemUptime
    func mark(_ name: String) {
        let now = ProcessInfo.processInfo.systemUptime
        marks.append((name, (now - last) * 1_000))
        last = now
    }
    var summary: String { marks.map { "\($0.0):\(Int($0.1))" }.joined(separator: " ") }
}

/// 이 스레드의 CPU 시간(ms). 벽시계 elapsed와 비교해 "바빴는지 / 굶었는지"를 가른다.
func dashboardThreadCPUMs() -> Double {
    var ts = timespec()
    clock_gettime(CLOCK_THREAD_CPUTIME_ID, &ts)
    return Double(ts.tv_sec) * 1_000 + Double(ts.tv_nsec) / 1_000_000
}

final class StatusMenuDashboardView: NSView {
    var lastRefreshPhases: DashboardRefreshPhases?
    static let preferredWidth: CGFloat = 880

    private var summaryView: ServiceAvailabilitySummaryView?
    private var teamClaudeView: TeamClaudeTableView?
    private var codexView: CodexStatusView?
    private var higgsfieldView: HiggsfieldCreditsView?
    private var cliLanesView: CliQuotaLanesView?
    private var burnView: SubscriptionBurnView?
    private var usageView: UsageDashboardView?
    private(set) var sections: [DashboardSection] = []
    private var headerViews: [DashboardSectionHeaderView] = []
    private var renderedHiggsfieldHeight: CGFloat = 0
    private var renderedTeamHeight: CGFloat = 0
    /// 표가 행 높이 변화를 알리면 호출된다. 소유자(AppDelegate)가 갱신을 예약해 updateContent → 재구성으로 이어진다.
    var onTeamRowsChange: (() -> Void)?
    private var renderedAccountCount = -1
    private var renderedTeamClaudePresent = false
    private var renderedCodexPresent = false
    private var renderedTeamCodexAccountCount = -1
    private var renderedTeamCodexPresent = false
    private var renderedUsageHeight: CGFloat = 0
    override var isFlipped: Bool { true }

    static func teamContentHeight(_ health: TeamClaudeHealth?, now: Date = Date()) -> CGFloat {
        guard let health = health else { return 0 }
        // 카드 상단 기하는 layout()/draw()와 같은 TeamClaudeCardMetrics에서 온다(호스트 줄 유무만 갈린다).
        let base = teamClaudeCardBaseHeight(hostLine: health.hostSummaryText != nil)
        // 행 높이는 보조 줄 유무에 따라 다르다. 표의 layout()/draw()와 같은 rowLines 판정을 쓴다.
        return base + teamClaudeRowsHeight(health.rowLines(now: now))
    }

    static func codexHeight(_ health: CodexHealth?, teamCodex: TeamCodexPoolHealth?) -> CGFloat {
        health == nil && teamCodex == nil ? 0 : CodexStatusView.preferredHeight(for: teamCodex)
    }

    /// 첫 섹션 헤더가 놓이는 문서 y — 위 4pt, 요약 카드, 아래 4pt.
    static let sectionStartY: CGFloat = 4 + ServiceAvailabilitySummaryView.preferredHeight + 4

    /// "CLI 쿼터" 본문 = Grok·agy 두 레인이 든 카드 한 장. 두 모델은 옵셔널이 아니라 항상 그린다.
    static let cliHeight: CGFloat = CliQuotaLanesView.fixedHeight

    static func preferredHeight(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?, higgsfield: HiggsfieldCreditsData? = nil,
                                burnModel: SubscriptionBurnModel) -> CGFloat {
        dashboardSectionLayout(startY: sectionStartY, bodies: [
            (id: "burn", title: "구독·소진", summary: "", height: SubscriptionBurnView.preferredHeight(burnModel)),
            (id: "claude", title: "Claude 풀", summary: "", height: teamContentHeight(teamClaude)),
            (id: "codex", title: "Codex 풀", summary: "", height: codexHeight(codex, teamCodex: teamCodex)),
            (id: "higgsfield", title: "Higgsfield", summary: "", height: HiggsfieldCreditsView.preferredHeight(for: higgsfield)),
            (id: "cli", title: "CLI 쿼터", summary: "", height: cliHeight),
            (id: "usage", title: "사용량", summary: "", height: UsageDashboardView.preferredHeight(for: usage)),
        ]).totalHeight
    }

    /// 섹션 헤더 우측 한 줄 요약. 모델에 이미 있는 값만 쓰고, 모르면 빈 문자열(헤더는 제목만 그린다).
    static func sectionSummaries(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?, higgsfield: HiggsfieldCreditsData?) -> [String: String] {
        var out: [String: String] = [:]
        if let teamClaude {
            // 요약 카드와 같은 숫자: 전체 계정 수, Fable 기준 지금 요청을 받을 수 있는 계정 수.
            let usable = teamClaude.fableAvailability(now: Date()).filter { $0.state == .ready }.count
            out["claude"] = "계정 \(teamClaude.accounts.count) · 사용 가능 \(usable)"
        }
        if let teamCodex {
            out["codex"] = "\(teamCodex.statusLabel) · 사용 가능 \(teamCodex.usableCount)/\(teamCodex.poolCount)"
        } else if let codex {
            out["codex"] = codex.statusLabel
        }
        if let higgsfield, higgsfield.error == nil {
            out["higgsfield"] = higgsfieldFormatCredits(higgsfield.credits)
        }
        out["cli"] = "Grok · Agy"
        if let usage, let today = usage.today {
            out["usage"] = "오늘 \(formatKRWShort(today.totalCost, rate: usage.usdKrwRate)) · 총 \(formatTokens(usage.allTimeTokens))"
        }
        return out
    }

    /// 구조가 그대로일 때: 헤더의 요약 글만 바꾸고 다시 그린다.
    private func refreshSectionSummaries(_ summaries: [String: String]) {
        sections = sections.map { section in
            var updated = section
            updated.summary = summaries[section.id] ?? ""
            return updated
        }
        for header in headerViews {
            guard let id = header.section?.id,
                  let section = sections.first(where: { $0.id == id }) else { continue }
            header.section = section
        }
    }

    func configure(
        teamClaude: TeamClaudeHealth?,
        codex: CodexHealth?,
        teamCodex: TeamCodexPoolHealth?,
        usage: UsageData?,
        higgsfield: HiggsfieldCreditsData? = nil,
        grok: GrokCardModel = GrokCardModel(headline: "Grok 확인 중", detail: nil),
        agy: AgyCardModel = AgyCardModel(message: "agy 확인 중", groups: []),
        burnModel: SubscriptionBurnModel,
        laneStaleNotes: [String: String] = [:],
        parallelCount: Int,
        active: Bool,
        isMeasuringTeamClaude: Bool,
        teamClaudeMeasureDetail: String?,
        onMeasureTeamClaude: (() -> Void)?,
        onReauthenticateTeamClaude: ((String, String?) -> Void)? = nil,
        onRecoverTeamCodex: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)? = nil
    ) {
        subviews.removeAll()
        headerViews = []
        teamClaudeView = nil
        codexView = nil
        higgsfieldView = nil
        renderedAccountCount = teamClaude?.accounts.count ?? 0
        renderedTeamClaudePresent = teamClaude != nil
        renderedCodexPresent = codex != nil
        renderedTeamCodexAccountCount = teamCodex?.accounts.count ?? 0
        renderedTeamCodexPresent = teamCodex != nil
        renderedUsageHeight = UsageDashboardView.preferredHeight(for: usage)
        renderedHiggsfieldHeight = HiggsfieldCreditsView.preferredHeight(for: higgsfield)
        renderedTeamHeight = Self.teamContentHeight(teamClaude)

        let summary = ServiceAvailabilitySummaryView(frame: NSRect(x: 0, y: 4, width: bounds.width, height: ServiceAvailabilitySummaryView.preferredHeight))
        summary.teamClaude = teamClaude
        summary.teamCodex = teamCodex
        summary.evaluatedAt = Date()
        addSubview(summary)
        summaryView = summary

        // preferredHeight와 같은 순서·같은 높이. 섹션을 더하면 두 목록과 sectionSummaries를 같이 고친다.
        let summaries = Self.sectionSummaries(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield)
        sections = dashboardSectionLayout(startY: Self.sectionStartY, bodies: [
            (id: "burn", title: "구독·소진", summary: summaries["burn"] ?? "", height: SubscriptionBurnView.preferredHeight(burnModel)),
            (id: "claude", title: "Claude 풀", summary: summaries["claude"] ?? "", height: Self.teamContentHeight(teamClaude)),
            (id: "codex", title: "Codex 풀", summary: summaries["codex"] ?? "", height: Self.codexHeight(codex, teamCodex: teamCodex)),
            (id: "higgsfield", title: "Higgsfield", summary: summaries["higgsfield"] ?? "", height: HiggsfieldCreditsView.preferredHeight(for: higgsfield)),
            (id: "cli", title: "CLI 쿼터", summary: summaries["cli"] ?? "", height: Self.cliHeight),
            (id: "usage", title: "사용량", summary: summaries["usage"] ?? "", height: UsageDashboardView.preferredHeight(for: usage)),
        ]).sections

        for section in sections {
            let header = DashboardSectionHeaderView(frame: NSRect(x: 0, y: section.y, width: bounds.width, height: dashboardSectionHeaderHeight))
            header.section = section
            addSubview(header)
            headerViews.append(header)
            let bodyY = dashboardSectionBodyY(section)
            let bodyHeight = section.height - dashboardSectionHeaderHeight - dashboardSectionGap

            switch section.id {
            case "claude":
                // 표는 전체 높이로 한 장에 그린다 — 안쪽 스크롤 없이 페이지가 통째로 스크롤된다.
                let view = TeamClaudeTableView(frame: NSRect(x: 0, y: bodyY, width: bounds.width, height: bodyHeight))
                view.health = teamClaude
                view.isMeasuring = isMeasuringTeamClaude
                view.measurementDetail = teamClaudeMeasureDetail
                view.onMeasure = onMeasureTeamClaude
                view.onReauthenticate = onReauthenticateTeamClaude
                view.onContentHeightChange = { [weak self] in self?.onTeamRowsChange?() }
                addSubview(view)
                teamClaudeView = view
            case "codex":
                let view = CodexStatusView(frame: NSRect(x: 0, y: bodyY, width: bounds.width, height: bodyHeight))
                view.health = codex
                view.pool = teamCodex
                view.usage = usage
                view.onRecover = onRecoverTeamCodex
                addSubview(view)
                codexView = view
            case "higgsfield":
                let higgsView = HiggsfieldCreditsView(frame: NSRect(x: 0, y: bodyY, width: bounds.width, height: bodyHeight))
                higgsView.data = higgsfield
                higgsView.staleNote = laneStaleNotes["higgsfield"]
                addSubview(higgsView)
                higgsfieldView = higgsView
            case "burn":
                let view = SubscriptionBurnView(frame: NSRect(x: 0, y: bodyY,
                                                              width: bounds.width, height: bodyHeight))
                view.model = burnModel
                addSubview(view)
                burnView = view
            case "cli":
                let lanes = CliQuotaLanesView(frame: NSRect(x: 0, y: bodyY, width: bounds.width, height: CliQuotaLanesView.fixedHeight))
                lanes.grok = grok
                lanes.agy = agy
                lanes.staleNotes = laneStaleNotes
                addSubview(lanes)
                cliLanesView = lanes
            case "usage":
                let view = UsageDashboardView(frame: NSRect(x: 0, y: bodyY, width: bounds.width, height: bodyHeight))
                view.usage = usage
                view.parallelCount = parallelCount
                view.active = active
                addSubview(view)
                usageView = view
            default:
                break
            }
        }
    }

    func updateContent(
        teamClaude: TeamClaudeHealth?,
        codex: CodexHealth?,
        teamCodex: TeamCodexPoolHealth?,
        usage: UsageData?,
        higgsfield: HiggsfieldCreditsData? = nil,
        grok: GrokCardModel = GrokCardModel(headline: "Grok 확인 중", detail: nil),
        agy: AgyCardModel = AgyCardModel(message: "agy 확인 중", groups: []),
        burnModel: SubscriptionBurnModel,
        laneStaleNotes: [String: String] = [:],
        parallelCount: Int,
        active: Bool,
        isMeasuringTeamClaude: Bool,
        teamClaudeMeasureDetail: String?,
        onMeasureTeamClaude: (() -> Void)?,
        onReauthenticateTeamClaude: ((String, String?) -> Void)? = nil,
        onRecoverTeamCodex: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)? = nil
    ) {
        let accountCount = teamClaude?.accounts.count ?? 0
        let usageHeight = UsageDashboardView.preferredHeight(for: usage)
        let structureChanged = accountCount != renderedAccountCount
            || (teamClaude != nil) != renderedTeamClaudePresent
            || (codex != nil) != renderedCodexPresent
            || (teamCodex?.accounts.count ?? 0) != renderedTeamCodexAccountCount
            || (teamCodex != nil) != renderedTeamCodexPresent
            || usageHeight != renderedUsageHeight
            || HiggsfieldCreditsView.preferredHeight(for: higgsfield) != renderedHiggsfieldHeight
            || Self.teamContentHeight(teamClaude) != renderedTeamHeight
        if structureChanged {
            // 가장 비싼 경로다. 여기서도 단계 시간을 남긴다(예전엔 phases=- 로 비어 보였다).
            let structurePhases = DashboardRefreshPhases()
            lastRefreshPhases = structurePhases
            frame.size.height = Self.preferredHeight(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield, burnModel: burnModel)
            structurePhases.mark("height")
            configure(
                teamClaude: teamClaude,
                codex: codex,
                teamCodex: teamCodex,
                usage: usage,
                higgsfield: higgsfield,
                grok: grok,
                agy: agy,
                burnModel: burnModel,
                parallelCount: parallelCount,
                active: active,
                isMeasuringTeamClaude: isMeasuringTeamClaude,
                teamClaudeMeasureDetail: teamClaudeMeasureDetail,
                onMeasureTeamClaude: onMeasureTeamClaude,
                onReauthenticateTeamClaude: onReauthenticateTeamClaude,
                onRecoverTeamCodex: onRecoverTeamCodex
            )
            structurePhases.mark("configure")
            return
        }

        let phases = DashboardRefreshPhases()
        lastRefreshPhases = phases
        summaryView?.teamClaude = teamClaude
        summaryView?.teamCodex = teamCodex
        summaryView?.evaluatedAt = Date()
        phases.mark("summary")
        teamClaudeView?.health = teamClaude
        teamClaudeView?.isMeasuring = isMeasuringTeamClaude
        teamClaudeView?.measurementDetail = teamClaudeMeasureDetail
        teamClaudeView?.onMeasure = onMeasureTeamClaude
        teamClaudeView?.onReauthenticate = onReauthenticateTeamClaude
        phases.mark("team")
        codexView?.health = codex
        codexView?.pool = teamCodex
        codexView?.usage = usage
        codexView?.onRecover = onRecoverTeamCodex
        phases.mark("codex")
        higgsfieldView?.data = higgsfield
        higgsfieldView?.staleNote = laneStaleNotes["higgsfield"]
        burnView?.model = burnModel
        cliLanesView?.grok = grok
        cliLanesView?.staleNotes = laneStaleNotes
        cliLanesView?.agy = agy
        usageView?.usage = usage
        usageView?.parallelCount = parallelCount
        usageView?.active = active
        usageView?.needsDisplay = true
        phases.mark("cards")
        refreshSectionSummaries(Self.sectionSummaries(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield))
        phases.mark("sections")
    }
}

final class UsageDashboardView: NSView {
    var usage: UsageData? {
        didSet {
            if let usage = usage, let today = usage.today {
                setAccessibilityLabel("사용량 대시보드, 오늘 \(formatCost(today.totalCost)), 이번 주 \(formatCost(usage.thisWeekCost)), 이번 달 \(formatCost(usage.thisMonthCost))")
            }
            needsDisplay = true
        }
    }
    var parallelCount: Int = 0
    var active: Bool = false
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("사용량 대시보드")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    static func preferredHeight(for usage: UsageData?) -> CGFloat {
        guard usage?.today != nil else { return 176 }
        return 500
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let bg = NSColor(calibratedRed: 0.06, green: 0.075, blue: 0.10, alpha: 0.97)
        let panel = NSColor(calibratedRed: 0.095, green: 0.115, blue: 0.15, alpha: 1.0)
        let line = NSColor(calibratedRed: 0.23, green: 0.27, blue: 0.34, alpha: 1.0)
        let text = NSColor(calibratedRed: 0.92, green: 0.95, blue: 0.98, alpha: 1.0)
        let muted = NSColor(calibratedRed: 0.55, green: 0.61, blue: 0.70, alpha: 1.0)
        let dim = NSColor(calibratedRed: 0.40, green: 0.46, blue: 0.55, alpha: 1.0)
        let green = NSColor(calibratedRed: 0.18, green: 0.82, blue: 0.48, alpha: 1.0)
        let yellow = NSColor(calibratedRed: 0.93, green: 0.76, blue: 0.22, alpha: 1.0)
        let blue = NSColor(calibratedRed: 0.28, green: 0.55, blue: 0.90, alpha: 1.0)

        let titleFont = NSFont.systemFont(ofSize: 18, weight: .bold)
        let sectionFont = NSFont.systemFont(ofSize: 12.5, weight: .semibold)
        let bodyFont = NSFont.systemFont(ofSize: 12.5, weight: .medium)
        let smallFont = NSFont.systemFont(ofSize: 11, weight: .medium)
        let monoFont = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        let krwRate = usage?.usdKrwRate ?? 1450.0

        func attrs(_ font: NSFont, _ color: NSColor) -> [NSAttributedString.Key: Any] {
            [.font: font, .foregroundColor: color]
        }
        func drawText(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            value.draw(at: NSPoint(x: x, y: y), withAttributes: attrs(font, color))
        }
        func drawRight(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            let a = attrs(font, color)
            let s = value.size(withAttributes: a)
            value.draw(at: NSPoint(x: x - s.width, y: y), withAttributes: a)
        }
        func fillRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        func strokeRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setStroke()
            let p = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            p.lineWidth = 1
            p.stroke()
        }
        func pill(_ value: String, x: CGFloat, y: CGFloat, color: NSColor) {
            let a = attrs(smallFont, color)
            let s = value.size(withAttributes: a)
            let rect = NSRect(x: x, y: y, width: s.width + 16, height: 22)
            fillRound(rect, color.withAlphaComponent(0.14), 11)
            strokeRound(rect, color.withAlphaComponent(0.38), 11)
            value.draw(at: NSPoint(x: x + 8, y: y + 3.5), withAttributes: a)
        }
        func metric(_ label: String, _ usd: String, _ krw: String, _ detail: String, rect: NSRect, color: NSColor) {
            fillRound(rect, panel, 9)
            strokeRound(rect, line.withAlphaComponent(0.80), 9)
            drawText(label.uppercased(), rect.minX + 10, rect.minY + 8, sectionFont, muted)
            drawRight(detail, rect.maxX - 10, rect.minY + 9, smallFont, dim)
            let valueFont = NSFont.monospacedDigitSystemFont(ofSize: usd.count > 11 ? 16 : 18, weight: .bold)
            drawText(usd, rect.minX + 10, rect.minY + 28, valueFont, color)
            drawText(krw, rect.minX + 10, rect.minY + 52, smallFont, muted)
        }
        func labelForDate(_ ymd: String) -> String {
            guard let date = dateFromYMD(ymd) else { return shortDate(ymd) }
            if Calendar.current.isDateInToday(date) { return "오늘" }
            if Calendar.current.isDateInYesterday(date) { return "어제" }
            return shortDate(ymd)
        }
        func drawMiniBar(value: Double, maxValue: Double, rect: NSRect, color: NSColor) {
            fillRound(rect, NSColor.white.withAlphaComponent(0.08), rect.height / 2)
            guard maxValue > 0, value > 0 else { return }
            let width = max(3, rect.width * CGFloat(value / maxValue))
            fillRound(NSRect(x: rect.minX, y: rect.minY, width: width, height: rect.height), color, rect.height / 2)
        }
        func drawTrend(_ points: [DayPoint], rect: NSRect) {
            fillRound(rect, panel, 9)
            strokeRound(rect, line.withAlphaComponent(0.75), 9)
            drawText("최근 14일 비용", rect.minX + 12, rect.minY + 10, sectionFont, muted)
            guard !points.isEmpty, let maxCost = points.map({ $0.cost }).max(), maxCost > 0 else {
                drawText("표시할 비용 데이터가 없습니다", rect.minX + 12, rect.minY + 60, bodyFont, dim)
                return
            }
            if let peak = points.max(by: { $0.cost < $1.cost }) {
                drawRight("최고 \(formatCostShort(peak.cost)) · \(formatKRWShort(peak.cost, rate: krwRate))", rect.maxX - 12, rect.minY + 10, smallFont, dim)
            }
            let chart = NSRect(x: rect.minX + 12, y: rect.minY + 38, width: rect.width - 24, height: rect.height - 58)
            let gap: CGFloat = 3
            let barW = max(3, (chart.width - gap * CGFloat(points.count - 1)) / CGFloat(points.count))
            for (i, point) in points.enumerated() {
                let ratio = CGFloat(point.cost / maxCost)
                let barH = max(2, chart.height * ratio)
                let x = chart.minX + CGFloat(i) * (barW + gap)
                let y = chart.maxY - barH
                let color = i == points.count - 1 ? green : blue.withAlphaComponent(0.38 + 0.46 * CGFloat(i) / CGFloat(max(points.count - 1, 1)))
                fillRound(NSRect(x: x, y: y, width: barW, height: barH), color, 2)
            }
            if let first = points.first, let last = points.last {
                drawText(shortDate(first.date), chart.minX, rect.maxY - 16, smallFont, dim)
                drawRight("오늘 \(shortDate(last.date))", chart.maxX, rect.maxY - 16, smallFont, dim)
            }
        }
        func drawDaily(_ points: [DayPoint], rect: NSRect) {
            fillRound(rect, panel, 9)
            strokeRound(rect, line.withAlphaComponent(0.75), 9)
            drawText("일별 추이", rect.minX + 12, rect.minY + 10, sectionFont, muted)
            let rows = Array(points.reversed().prefix(7))
            let maxCost = rows.map { $0.cost }.max() ?? 1
            for (i, point) in rows.enumerated() {
                let y = rect.minY + 36 + CGFloat(i) * 19
                let isToday = Calendar.current.isDateInToday(dateFromYMD(point.date) ?? Date.distantPast)
                let rowColor = isToday ? green : text
                drawText(labelForDate(point.date), rect.minX + 12, y, monoFont, rowColor)
                drawMiniBar(value: point.cost, maxValue: maxCost, rect: NSRect(x: rect.minX + 62, y: y + 5, width: 112, height: 6), color: isToday ? green : blue)
                drawRight(formatCost(point.cost), rect.maxX - 146, y, monoFont, rowColor)
                drawRight(formatKRWShort(point.cost, rate: krwRate), rect.maxX - 76, y + 1, NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular), dim)
                drawRight(formatTokens(point.tokens), rect.maxX - 12, y + 1, NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular), dim)
            }
        }
        func drawProviders(_ models: [ModelUsage], rect: NSRect, rate: Double) {
            fillRound(rect, panel, 9)
            strokeRound(rect, line.withAlphaComponent(0.75), 9)
            drawText("모델별 비용", rect.minX + 12, rect.minY + 10, sectionFont, muted)
            drawRight("환율 1 USD = ₩\(String(format: "%.1f", rate))", rect.maxX - 12, rect.minY + 10, smallFont, dim)

            if models.isEmpty {
                drawText("이번 달 모델별 데이터가 아직 없습니다", rect.minX + 12, rect.minY + 54, bodyFont, dim)
                return
            }

            var providerTotals: [String: Double] = [:]
            for model in models { providerTotals[model.provider, default: 0] += model.cost }
            let providers = providerTotals.sorted { $0.value > $1.value }
            let total = providers.reduce(0.0) { $0 + $1.value }

            var x = rect.minX + 12
            for item in providers.prefix(4) {
                let color = providerColor(item.key)
                fillRound(NSRect(x: x, y: rect.minY + 36, width: 7, height: 7), color, 3.5)
                x += 11
                let label = "\(item.key) \(formatKRWShort(item.value, rate: rate))"
                drawText(label, x, rect.minY + 31, smallFont, text)
                x += label.size(withAttributes: attrs(smallFont, text)).width + 15
            }

            let track = NSRect(x: rect.minX + 12, y: rect.minY + 55, width: rect.width - 24, height: 8)
            fillRound(track, NSColor.white.withAlphaComponent(0.08), 4)
            if total > 0 {
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(roundedRect: track, xRadius: 4, yRadius: 4).addClip()
                var bx = track.minX
                for item in providers {
                    let seg = track.width * CGFloat(item.value / total)
                    providerColor(item.key).withAlphaComponent(0.90).setFill()
                    NSBezierPath(rect: NSRect(x: bx, y: track.minY, width: seg, height: track.height)).fill()
                    bx += seg
                }
                NSGraphicsContext.restoreGraphicsState()
            }

            let maxCost = models.first?.cost ?? 1
            for (i, model) in models.prefix(4).enumerated() {
                let y = rect.minY + 72 + CGFloat(i) * 18
                let color = providerColor(model.provider)
                fillRound(NSRect(x: rect.minX + 12, y: y + 5, width: 7, height: 7), color, 3.5)
                drawText(model.label, rect.minX + 25, y, bodyFont, text)
                let barX = rect.minX + 154
                let barW = rect.width - 294
                if barW > 20 {
                    drawMiniBar(value: model.cost, maxValue: maxCost, rect: NSRect(x: barX, y: y + 6, width: barW, height: 6), color: color)
                }
                drawRight(formatKRWShort(model.cost, rate: rate), rect.maxX - 88, y + 1, NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular), dim)
                drawRight(formatCost(model.cost), rect.maxX - 12, y, monoFont, text)
            }
        }

        let card = bounds.insetBy(dx: 8, dy: 4)
        fillRound(card, bg, 14)
        strokeRound(card, line, 14)

        guard let usageData = usage, let today = usageData.today else {
            drawText("사용량 대시보드", card.minX + 16, card.minY + 16, titleFont, text)
            pill(active ? "작업 중" : "대기", x: card.minX + 154, y: card.minY + 14, color: active ? green : muted)
            fillRound(NSRect(x: card.minX + 16, y: card.minY + 54, width: card.width - 32, height: 70), panel, 10)
            drawText("ccusage 데이터를 기다리는 중입니다", card.minX + 32, card.minY + 75, NSFont.systemFont(ofSize: 14.5, weight: .semibold), text)
            drawText("새로고침을 누르거나 잠시 뒤 다시 열면 최신 사용량을 표시합니다", card.minX + 32, card.minY + 100, bodyFont, dim)
            return
        }

        let innerX = card.minX + 16
        let topY = card.minY + 16
        let rate = usageData.usdKrwRate
        let todayTokens = today.inputTokens + today.cacheCreationTokens + today.cacheReadTokens + today.outputTokens

        drawText("사용량 대시보드", innerX, topY, titleFont, text)
        pill(active ? "작업 중" : "대기", x: innerX + 148, y: topY - 2, color: active ? green : muted)
        pill("병렬 \(parallelCount)", x: innerX + 236, y: topY - 2, color: parallelCount > 0 ? green : blue)
        drawRight("오늘 \(formatKRWShort(today.totalCost, rate: rate)) · 총 \(formatTokens(usageData.allTimeTokens))", card.maxX - 16, topY + 2, bodyFont, muted)

        let metricY = topY + 44
        let gap: CGFloat = 9
        let metricW = (card.width - 32 - gap * 3) / 4
        metric("오늘", formatCost(today.totalCost), formatKRW(today.totalCost, rate: rate), formatTokens(todayTokens), rect: NSRect(x: innerX, y: metricY, width: metricW, height: 68), color: green)
        metric("최근 7일", formatCost(usageData.weeklyTotalCost), formatKRW(usageData.weeklyTotalCost, rate: rate), "이번주 \(formatKRWShort(usageData.thisWeekCost, rate: rate))", rect: NSRect(x: innerX + (metricW + gap), y: metricY, width: metricW, height: 68), color: blue)
        metric("이번 달", formatCost(usageData.thisMonthCost), formatKRW(usageData.thisMonthCost, rate: rate), formatTokens(usageData.thisMonthTokens), rect: NSRect(x: innerX + (metricW + gap) * 2, y: metricY, width: metricW, height: 68), color: yellow)
        metric("누적", formatCost(usageData.allTimeCost), formatKRW(usageData.allTimeCost, rate: rate), formatTokens(usageData.allTimeTokens), rect: NSRect(x: innerX + (metricW + gap) * 3, y: metricY, width: metricW, height: 68), color: text)

        let mainY = metricY + 84
        let leftW = (card.width - 32 - gap) * 0.47
        let rightW = card.width - 32 - gap - leftW
        drawTrend(usageData.recent14Days, rect: NSRect(x: innerX, y: mainY, width: leftW, height: 162))
        drawDaily(usageData.recent7Days, rect: NSRect(x: innerX + leftW + gap, y: mainY, width: rightW, height: 162))

        let modelY = mainY + 178
        drawProviders(usageData.modelBreakdown, rect: NSRect(x: innerX, y: modelY, width: card.width - 32, height: 138), rate: rate)
    }
}

final class MenuActionRowView: NSView {
    static let preferredHeight: CGFloat = 46
    let icon: String
    let symbolName: String?
    let title: String
    var detail: String {
        didSet {
            setAccessibilityHelp(detail)
            needsDisplay = true
        }
    }
    let tone: NSColor
    var onClick: (() -> Void)?
    private var hovered = false
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }

    init(frame frameRect: NSRect, icon: String, symbolName: String? = nil, title: String, detail: String, tone: NSColor) {
        self.icon = icon
        self.symbolName = symbolName
        self.title = title
        self.detail = detail
        self.tone = tone
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(title)
        setAccessibilityHelp(detail)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach { removeTrackingArea($0) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        onClick?()
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 49 {
            onClick?()
        } else {
            super.keyDown(with: event)
        }
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let bg = hovered
            ? NSColor(calibratedRed: 0.13, green: 0.16, blue: 0.21, alpha: 1.0)
            : NSColor(calibratedRed: 0.075, green: 0.09, blue: 0.12, alpha: 0.98)
        let line = hovered ? tone.withAlphaComponent(0.42) : NSColor(calibratedRed: 0.23, green: 0.27, blue: 0.34, alpha: 0.90)
        let text = NSColor(calibratedRed: 0.92, green: 0.95, blue: 0.98, alpha: 1.0)
        let muted = NSColor(calibratedRed: 0.55, green: 0.61, blue: 0.70, alpha: 1.0)
        let card = bounds.insetBy(dx: 8, dy: 4)

        bg.setFill()
        NSBezierPath(roundedRect: card, xRadius: 8, yRadius: 8).fill()
        line.setStroke()
        let path = NSBezierPath(roundedRect: card, xRadius: 8, yRadius: 8)
        path.lineWidth = 1
        path.stroke()

        let iconRect = NSRect(x: card.minX + 12, y: card.minY + 6, width: 28, height: 28)
        tone.withAlphaComponent(0.16).setFill()
        NSBezierPath(roundedRect: iconRect, xRadius: 7, yRadius: 7).fill()
        tone.withAlphaComponent(0.30).setStroke()
        let iconPath = NSBezierPath(roundedRect: iconRect, xRadius: 7, yRadius: 7)
        iconPath.lineWidth = 1
        iconPath.stroke()

        if #available(macOS 11.0, *),
           let symbolName = symbolName,
           let baseImage = NSImage(systemSymbolName: symbolName, accessibilityDescription: title) {
            let config = NSImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
            let image = baseImage.withSymbolConfiguration(config) ?? baseImage
            let drawRect = iconRect.insetBy(dx: 6, dy: 6)
            image.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0)
            if let context = NSGraphicsContext.current {
                let previousOperation = context.compositingOperation
                context.compositingOperation = .sourceAtop
                tone.setFill()
                NSBezierPath(rect: drawRect).fill()
                context.compositingOperation = previousOperation
            }
        } else {
            let iconAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 16, weight: .semibold),
                .foregroundColor: tone,
            ]
            let iconSize = icon.size(withAttributes: iconAttrs)
            icon.draw(
                at: NSPoint(x: iconRect.midX - iconSize.width / 2, y: iconRect.midY - iconSize.height / 2 - 0.5),
                withAttributes: iconAttrs
            )
        }

        title.draw(at: NSPoint(x: card.minX + 54, y: card.minY + 11), withAttributes: [
            .font: NSFont.systemFont(ofSize: 15, weight: .semibold),
            .foregroundColor: text,
        ])
        let detailAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: muted,
        ]
        let size = detail.size(withAttributes: detailAttrs)
        detail.draw(at: NSPoint(x: card.maxX - size.width - 14, y: card.minY + 13), withAttributes: detailAttrs)
    }
}

func resolveTeamClaudeExecutable() -> String {
    let home = NSHomeDirectory()
    var candidates = [
        "\(home)/.local/share/fnm/aliases/default/bin/teamclaude",
        "\(home)/.local/bin/teamclaude",
        "/opt/homebrew/bin/teamclaude",
        "/usr/local/bin/teamclaude",
    ]
    let fnmVersions = "\(home)/.local/share/fnm/node-versions"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: fnmVersions) {
        let installed = versions.compactMap { version -> (String, Date)? in
            let path = "\(fnmVersions)/\(version)/installation/bin/teamclaude"
            guard FileManager.default.isExecutableFile(atPath: path) else { return nil }
            let modified = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? .distantPast
            return (path, modified)
        }.sorted { $0.1 > $1.1 }.map(\.0)
        candidates.append(contentsOf: installed)
    }
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
    }
    return "teamclaude"
}

/// codex 하위 명령은 teamcodex 진입점으로만 보낸다.
/// 이 호스트에는 후보 경로 어디에도 `teamclaude` 실행 파일이 없다(2026-09-06 실측:
/// `~/.local/bin`·fnm·homebrew·/usr/local 전부 부재). 그래서 codex 명령을
/// `resolveTeamClaudeExecutable()`로 보내면 리터럴 "teamclaude"로 떨어져
/// command not found로 죽는다. teamcodex는 `~/.local/bin/teamcodex`와
/// fnm 설치본으로 실재하며 codex 풀 CLI를 담당한다.
func resolveTeamCodexExecutable() -> String {
    let home = NSHomeDirectory()
    var candidates = [
        "\(home)/.local/bin/teamcodex",
        "\(home)/.local/share/fnm/aliases/default/bin/teamcodex",
        "/opt/homebrew/bin/teamcodex",
        "/usr/local/bin/teamcodex",
    ]
    let fnmVersions = "\(home)/.local/share/fnm/node-versions"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: fnmVersions) {
        let installed = versions.compactMap { version -> (String, Date)? in
            let path = "\(fnmVersions)/\(version)/installation/bin/teamcodex"
            guard FileManager.default.isExecutableFile(atPath: path) else { return nil }
            let modified = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? .distantPast
            return (path, modified)
        }.sorted { $0.1 > $1.1 }.map(\.0)
        candidates.append(contentsOf: installed)
    }
    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
    }
    return resolveTeamClaudeExecutable()
}

func teamClaudeConfigSignature() -> String {
    let path = "\(NSHomeDirectory())/.config/teamclaude.json"
    let modifiedAt = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?
        .timeIntervalSince1970 ?? 0
    guard let config = readTeamClaudeJSON(path) else {
        return "missing|\(modifiedAt)"
    }
    let accounts = tcArray(config["accounts"]) ?? []
    return "\(Int(modifiedAt))|\(accounts.count)|\(teamClaudeAccountTopologySignature())"
}

func teamClaudeAccountTopologySignature() -> Int {
    guard let config = readTeamClaudeJSON("\(NSHomeDirectory())/.config/teamclaude.json") else {
        return 0
    }
    let accounts = tcArray(config["accounts"]) ?? []
    let topology = accounts.compactMap { account -> String? in
        guard let name = tcString(account["name"]), !name.isEmpty else { return nil }
        let enabled = tcBool(account["enabled"]) ?? true
        let type = tcString(account["type"]) ?? tcString(account["source"]) ?? "unknown"
        return "\(name)|\(enabled)|\(type)"
    }.sorted().joined(separator: ";")
    return topology.hashValue
}

struct TeamCodexConfiguredAccount: Equatable {
    let name: String
    let accountUuid: String?
    let enabled: Bool
    /// teamcodex.json의 `type`/`provider`. 프록시가 꺼져 config-only 행으로 떨어지는
    /// 바로 그 순간이 계정을 다시 켜고 싶은 순간이므로, 계정 종류를 여기서도 들고 간다.
    var accountType: String? = nil
    var providerName: String? = nil

    /// 비교 기준은 토폴로지(이름·UUID·on/off)뿐이다. 계정 종류는 수렴 판정
    /// (`teamCodexTopologyMatches`)의 기준이 아니므로 동등성에서 뺀다.
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.name == rhs.name
            && lhs.accountUuid == rhs.accountUuid
            && lhs.enabled == rhs.enabled
    }
}

struct TeamCodexConfigSnapshot: Equatable {
    let signature: Int
    let accounts: [TeamCodexConfiguredAccount]
}

struct TeamCodexRefreshContext {
    let generation: Int
    let configSignature: Int?
}

struct TeamCodexConfigWatchState {
    private(set) var signature: Int?
    private(set) var generation = 0

    mutating func seed(_ snapshot: TeamCodexConfigSnapshot) {
        signature = snapshot.signature
    }

    mutating func observe(_ snapshot: TeamCodexConfigSnapshot) -> Int? {
        guard signature != snapshot.signature else { return nil }
        signature = snapshot.signature
        generation += 1
        return generation
    }

    func refreshContext(configSignature: Int?) -> TeamCodexRefreshContext {
        TeamCodexRefreshContext(
            generation: generation,
            configSignature: configSignature
        )
    }

    func accepts(
        _ context: TeamCodexRefreshContext,
        currentConfigSignature: Int?
    ) -> Bool {
        context.generation == generation
            && context.configSignature == currentConfigSignature
    }
}

func teamCodexConfigSnapshot(home: String = NSHomeDirectory()) -> TeamCodexConfigSnapshot? {
    let path = "\(home)/.config/teamcodex.json"
    guard FileManager.default.fileExists(atPath: path) else {
        return TeamCodexConfigSnapshot(
            signature: "missing-teamcodex-config".hashValue,
            accounts: []
        )
    }
    guard let config = readTeamClaudeJSON(path) else { return nil }
    let rows = tcArray(config["accounts"]) ?? []
    let accounts = rows.compactMap { row -> TeamCodexConfiguredAccount? in
        guard let name = tcString(row["name"]), !name.isEmpty else { return nil }
        return TeamCodexConfiguredAccount(
            name: name,
            accountUuid: tcString(row["accountUuid"]) ?? tcString(row["accountId"]),
            enabled: tcBool(row["enabled"]) ?? true,
            accountType: tcString(row["type"]),
            providerName: tcString(row["provider"])
        )
    }
    let topology = rows.enumerated().map { index, row in
        let name = tcString(row["name"]) ?? "unknown"
        let identity = tcString(row["accountUuid"])
            ?? tcString(row["accountId"])
            ?? name
        let enabled = tcBool(row["enabled"]) ?? true
        let priority = tcInt(row["priority"]) ?? Int.max
        return "\(index)|\(identity)|\(name)|\(enabled)|\(priority)"
    }.joined(separator: ";")
    return TeamCodexConfigSnapshot(signature: topology.hashValue, accounts: accounts)
}

func teamCodexTopologyMatches(
    snapshot: TeamCodexConfigSnapshot,
    pool: TeamCodexPoolHealth
) -> Bool {
    snapshot.accounts == pool.accounts.map {
        TeamCodexConfiguredAccount(
            name: $0.name,
            accountUuid: $0.accountUuid,
            enabled: $0.enabled
        )
    }
}

func teamCodexPoolHealth(
    aligning pool: TeamCodexPoolHealth,
    to snapshot: TeamCodexConfigSnapshot
) -> TeamCodexPoolHealth {
    var liveByUuid: [String: TeamCodexPoolAccount] = [:]
    var liveByName: [String: TeamCodexPoolAccount] = [:]
    var liveUuidCounts: [String: Int] = [:]
    var liveNameCounts: [String: Int] = [:]
    var configuredUuidCounts: [String: Int] = [:]
    var configuredNameCounts: [String: Int] = [:]
    for account in snapshot.accounts {
        if let accountUuid = account.accountUuid {
            configuredUuidCounts[accountUuid, default: 0] += 1
        }
        configuredNameCounts[account.name, default: 0] += 1
    }
    for account in pool.accounts {
        if let accountUuid = account.accountUuid {
            liveUuidCounts[accountUuid, default: 0] += 1
            if liveByUuid[accountUuid] == nil {
                liveByUuid[accountUuid] = account
            }
        }
        liveNameCounts[account.name, default: 0] += 1
        if liveByName[account.name] == nil {
            liveByName[account.name] = account
        }
    }
    let accounts = snapshot.accounts.map { configured -> TeamCodexPoolAccount in
        let configuredUuidIsUnique = configured.accountUuid.map {
            configuredUuidCounts[$0] == 1
        } ?? true
        let uuidCandidate = configured.accountUuid.flatMap { accountUuid in
            configuredUuidCounts[accountUuid] == 1
                && liveUuidCounts[accountUuid] == 1
                ? liveByUuid[accountUuid]
                : nil
        }
        let nameCandidate = liveByName[configured.name]
        let nameFallbackIsSafe = configuredUuidIsUnique
            && configuredNameCounts[configured.name] == 1
            && liveNameCounts[configured.name] == 1
            && (configured.accountUuid == nil || nameCandidate?.accountUuid == nil)
        let live = uuidCandidate
            ?? (nameFallbackIsSafe ? nameCandidate : nil)
        guard let live else {
            return TeamCodexPoolAccount(
                name: configured.name,
                accountUuid: configured.accountUuid,
                isCurrent: false,
                enabled: configured.enabled,
                status: configured.enabled ? "configured" : "disabled",
                errorReason: nil,
                usableFromProxy: nil,
                sessionPercent: nil,
                sessionResetAt: nil,
                weeklyPercent: nil,
                weeklyResetAt: nil,
                inflight: 0,
                maxConcurrent: 0,
                totalRequests: 0,
                totalTokens: 0,
                accountType: configured.accountType,
                providerName: configured.providerName
            )
        }
        return TeamCodexPoolAccount(
            name: live.name,
            accountUuid: configured.accountUuid ?? live.accountUuid,
            isCurrent: live.isCurrent && configured.enabled,
            enabled: configured.enabled,
            status: configured.enabled
                ? (live.status == "disabled" ? "configured" : live.status)
                : "disabled",
            errorReason: live.errorReason,
            usableFromProxy: live.usableFromProxy,
            sessionPercent: live.sessionPercent,
            sessionResetAt: live.sessionResetAt,
            weeklyPercent: live.weeklyPercent,
            weeklyResetAt: live.weeklyResetAt,
            inflight: live.inflight,
            maxConcurrent: live.maxConcurrent,
            totalRequests: live.totalRequests,
            totalTokens: live.totalTokens,
            subscriptionState: live.subscriptionState,
            subscriptionEndsAt: live.subscriptionEndsAt,
            planType: live.planType,
            accountType: live.accountType ?? configured.accountType,
            providerName: live.providerName ?? configured.providerName,
            codexResetCredits: live.codexResetCredits,
            codexResetCreditsAt: live.codexResetCreditsAt
        )
    }
    let accountNames = Set(accounts.filter(\.enabled).map(\.name))
    var enabledUuidCounts: [String: Int] = [:]
    for account in accounts where account.enabled {
        if let accountUuid = account.accountUuid {
            enabledUuidCounts[accountUuid, default: 0] += 1
        }
    }
    let currentAccountUuid = pool.currentAccountUuid.flatMap {
        configuredUuidCounts[$0] == 1
            && liveUuidCounts[$0] == 1
            && enabledUuidCounts[$0] == 1
            ? $0
            : nil
    }
    let currentAccount = pool.currentAccountUuid != nil
        ? accounts.first { $0.accountUuid == currentAccountUuid }?.name
        : pool.currentAccount.flatMap {
            configuredNameCounts[$0] == 1
                && liveNameCounts[$0] == 1
                && accountNames.contains($0)
                ? $0
                : nil
        }
    return TeamCodexPoolHealth(
        checkedAt: pool.checkedAt,
        serverReachable: pool.serverReachable,
        serverPort: pool.serverPort,
        serverPid: pool.serverPid,
        currentAccount: currentAccount,
        currentAccountUuid: currentAccountUuid,
        switchThresholdPercent: pool.switchThresholdPercent,
        accounts: accounts,
        resetCreditsEnabled: pool.resetCreditsEnabled,
        resetCreditsPolicy: pool.resetCreditsPolicy,
        runtimeSummary: pool.runtimeSummary
    )
}

@discardableResult
func kickstartTeamClaudeServer() -> Bool {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["kickstart", "-k", "gui/\(getuid())/com.qjc.teamclaude"]
    do {
        try task.run()
        task.waitUntilExit()
        return task.terminationStatus == 0
    } catch {
        return false
    }
}

func refreshTeamClaudeOAuthAccounts() -> Int32? {
    let process = Process()
    let executable = resolveTeamClaudeExecutable()
    if executable == "teamclaude" {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["teamclaude", "accounts"]
    } else {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["accounts"]
    }

    var environment = ProcessInfo.processInfo.environment
    environment["HOME"] = NSHomeDirectory()
    let executableBin = URL(fileURLWithPath: executable).deletingLastPathComponent().path
    environment["PATH"] = "\(executableBin):/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    process.environment = environment
    let nullOut = FileHandle(forWritingAtPath: "/dev/null")
    process.standardOutput = nullOut
    process.standardError = nullOut

    guard let result = runTrustedProcessInIsolatedGroup(
        process,
        timeoutSeconds: 45,
        terminationGraceMicroseconds: 700_000
    ) else {
        nullOut?.closeFile()
        return nil
    }
    nullOut?.closeFile()
    return result.terminationStatus
}

func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

func escapeForAppleScriptString(_ value: String) -> String {
    value
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
}

// MARK: - 포맷 헬퍼

private let _labelWord: [String: String] = [
    "codex": "Codex", "max": "Max", "mini": "Mini", "pro": "Pro",
    "flash": "Flash", "high": "High", "preview": "Preview", "image": "Image", "free": "Free",
]
private func titleWord(_ w: String) -> String { _labelWord[w.lowercased()] ?? w }

// raw 모델명 → 표시명 (TS modelLabel과 동일 규칙). 8자리 날짜 접미사 제거 + 공백 버전.
// claude-haiku-4-5-20251001 → "Haiku 4.5", claude-opus-4-8 → "Opus 4.8",
// claude-fable-5 → "Fable 5", gpt-5.5 → "GPT-5.5", gpt-5-codex → "GPT-5 Codex",
// gemini-2.5-pro → "Gemini 2.5 Pro".
func shortenModelName(_ name: String) -> String {
    var base = name
    if let r = base.range(of: "-[0-9]{8}$", options: .regularExpression) {
        base.removeSubrange(r)
    }
    let lower = base.lowercased()
    let parts = base.split(separator: "-").map(String.init)
    let tiers = ["opus", "sonnet", "haiku", "fable"]
    if lower.hasPrefix("claude"), parts.count >= 3, tiers.contains(parts[1].lowercased()) {
        let tier = parts[1].prefix(1).uppercased() + parts[1].dropFirst().lowercased()
        let nums = parts.dropFirst(2).filter { $0.allSatisfy { $0.isNumber } }
        return nums.isEmpty ? tier : "\(tier) \(nums.joined(separator: "."))"
    }
    if lower.hasPrefix("gpt") {
        let ver = parts.count > 1 ? parts[1] : ""
        let rest = parts.dropFirst(2).map { titleWord($0) }
        return (["GPT-" + ver] + rest).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }
    if lower.contains("gemini") {
        let cleaned = base.replacingOccurrences(of: "antigravity-", with: "")
        let rparts = cleaned.split(separator: "-").map(String.init).filter { $0.lowercased() != "gemini" }
        return ("Gemini " + rparts.map { titleWord($0) }.joined(separator: " ")).trimmingCharacters(in: .whitespaces)
    }
    return base
}

func formatTokens(_ count: Int) -> String {
    if count >= 1_000_000_000 {
        return String(format: "%.1fB", Double(count) / 1_000_000_000)
    } else if count >= 1_000_000 {
        return String(format: "%.1fM", Double(count) / 1_000_000)
    } else {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: count)) ?? "\(count)"
    }
}

private let _costFormatter: NumberFormatter = {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.minimumFractionDigits = 2
    f.maximumFractionDigits = 2
    return f
}()

// 천단위 구분 포함 비용 표기 — $17,447.49 (가독성). 큰 금액도 한눈에.
func formatCost(_ cost: Double) -> String {
    "$" + (_costFormatter.string(from: NSNumber(value: cost)) ?? String(format: "%.2f", cost))
}

// 축약 비용 — $24.5K / $1.7K / $950 / $0.37 (제공자 칩 등 좁은 공간용)
func formatCostShort(_ cost: Double) -> String {
    if cost >= 1000 { return String(format: "$%.1fK", cost / 1000) }
    if cost >= 100 { return String(format: "$%.0f", cost) }
    return String(format: "$%.2f", cost)
}

func formatDurationShort(_ seconds: Int?) -> String {
    guard let seconds = seconds else { return "-" }
    if seconds >= 3600 { return "\(seconds / 3600)h \((seconds % 3600) / 60)m" }
    if seconds >= 60 { return "\(seconds / 60)m \(seconds % 60)s" }
    return "\(seconds)s"
}

func formatTeamClaudeDuration(_ seconds: Int?) -> String {
    guard let seconds = seconds else { return "-" }
    let days = seconds / 86_400
    let hours = (seconds % 86_400) / 3_600
    let minutes = (seconds % 3_600) / 60
    if days > 0 { return "\(days)d\(hours)h" }
    if hours > 0 { return "\(hours)h\(minutes)m" }
    if minutes > 0 { return "\(minutes)m" }
    return "\(seconds)s"
}

private let _teamClaudeProbeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

func formatTeamClaudeProbe(_ date: Date?) -> String {
    guard let date = date else { return "-" }
    return "@" + _teamClaudeProbeFormatter.string(from: date)
}

// 모델명 → 제공자 (codex 추적 핵심). TS providerOf와 동일 규칙.
func providerOf(_ model: String) -> String {
    let m = model.lowercased()
    if m.hasPrefix("claude") { return "Claude" }
    if m.hasPrefix("gpt") || m.contains("codex") || m.hasPrefix("o1") || m.hasPrefix("o3") { return "Codex" }
    if m.contains("gemini") { return "Gemini" }
    if m.contains("minimax") { return "MiniMax" }
    if m.hasPrefix("glm") { return "GLM" }
    return "Other"
}

// 제공자별 색 (TS PROVIDER_COLOR와 동일 톤)
func providerColor(_ provider: String) -> NSColor {
    switch provider {
    case "Claude":  return NSColor(calibratedRed: 0.82, green: 0.60, blue: 0.04, alpha: 1.0) // 앰버
    case "Codex":   return NSColor(calibratedRed: 0.00, green: 0.64, blue: 0.59, alpha: 1.0) // 청록(OpenAI)
    case "Gemini":  return NSColor(calibratedRed: 0.47, green: 0.38, blue: 0.86, alpha: 1.0) // 보라
    case "MiniMax": return NSColor(calibratedRed: 0.86, green: 0.17, blue: 0.44, alpha: 1.0)
    case "GLM":     return NSColor(calibratedRed: 0.83, green: 0.24, blue: 0.09, alpha: 1.0)
    default:        return NSColor.secondaryLabelColor
    }
}

// MARK: - AppDelegate

// MARK: - 활동 감지 (Claude Code 세션 JSONL 폴링)

/// ~/.claude/projects/ 하위 프로젝트 디렉토리 중 최근 60초 내 수정된 게 있으면 ACTIVE.
/// 디렉토리 mtime은 OS가 자식 jsonl 변경 시 자동 갱신해주므로, 전체 파일 트리 traverse 없이
/// 1-depth 디렉토리 stat만으로 활동 감지 가능. (26K+ jsonl 트리 traverse 회피)
func isClaudeActive() -> Bool {
    let projectsDir = NSHomeDirectory() + "/.claude/projects"
    let fm = FileManager.default
    guard let subdirs = try? fm.contentsOfDirectory(atPath: projectsDir) else { return false }

    let threshold = Date().addingTimeInterval(-60)
    for name in subdirs {
        let path = projectsDir + "/" + name
        if let attrs = try? fm.attributesOfItem(atPath: path),
           let mtime = attrs[.modificationDate] as? Date,
           mtime > threshold {
            return true
        }
    }
    return false
}

func teamClaudeTerminalCommand(
    executable: String,
    commandTitle: String,
    arguments: [String],
    codexMode: Bool
) -> String {
    let quotedExe = shellQuote(executable)
    let argString = arguments.map(shellQuote).joined(separator: " ")
    let product = codexMode ? "TeamCodex" : "TeamClaude"
    let successCommand = codexMode
        ? nil
        : "launchctl kickstart -k gui/$(id -u)/com.qjc.teamclaude || \(quotedExe) restart"
    // codex 경로는 서버를 다시 띄우지 않는다(successCommand가 없다).
    // `codex enable`은 실행 중 서버에 라이브 리로드되지 않아 CLI가 바로 위에
    // "Apply the change with: teamcodex restart"를 찍는다. 앱이 그 줄을
    // "자동 반영됩니다"로 덮으면 사용자는 재시작을 건너뛰고 반영 안 된 상태로 남는다.
    let closingNote = codexMode
        ? "완료 후 위 실행 결과를 확인하세요 · 반영되지 않으면 teamcodex restart가 필요합니다."
        : "완료되면 상태바에 자동 반영됩니다."
    var commands = [
        "clear",
        "echo \(shellQuote("\(product): \(commandTitle)"))",
        "\(quotedExe) \(argString)",
    ]
    if let successCommand {
        commands.append("exit_code=$?")
        commands.append("if [ $exit_code -eq 0 ]; then \(successCommand); fi")
    }
    commands.append(contentsOf: [
        "echo",
        "echo \(shellQuote(closingNote))",
        "read -n 1 -s -r -p \(shellQuote("닫으려면 아무 키나 누르세요"))",
    ])
    return commands.joined(separator: "; ")
}

class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem?
    var dataTimer: Timer?       // ccusage 갱신 (60초)
    var statusTimer: Timer?     // TeamClaude/Codex 상태 갱신 (10초)
    var codexScanTimer: Timer?  // Codex 세션 코퍼스 스캔 (60초, 디스크 작업)
    var rollTimer: Timer?       // 정보 롤링 + 펄스 (1초)
    var activityTimer: Timer?   // 활동 감지 (5초)
    var currentData: UsageData?
    var currentTeamClaude: TeamClaudeHealth?
    var currentCodex: CodexHealth?
    var currentTeamCodex: TeamCodexPoolHealth?
    var currentHiggsfield: HiggsfieldCreditsData?
    private var isFetchingHiggsfield = false
    private var lastHiggsfieldFetchedAt: Date?
    var currentGrokSlot: String?
    var currentGrokCard = GrokCardModel(headline: "Grok 확인 중", detail: nil)
    private var isFetchingGrok = false
    private var lastGrokFetchedAt: Date?
    var grokTimer: Timer?
    var currentAgyCard = AgyCardModel(message: "agy 확인 중", groups: [])
    private var isFetchingAgy = false
    private var lastAgyFetchedAt: Date?
    private var agyHasValue = false
    var agyTimer: Timer?
    /// 힉스필드는 기동 시 1회만 부르면 그 한 번의 실패가 영구 공백이 된다(2026-09-24 실측:
    /// 로그 347분 동안 조회 1회). 10분 주기로 다시 부른다 — 함수 자체가 중복 실행을 막는다.
    var higgsfieldTimer: Timer?
    /// 레인별 마지막 성공 시각. 조회 시도 시각(last*FetchedAt)과 달리 실패는 갱신하지 않는다.
    var grokLastSuccessAt: Date?
    var agyLastSuccessAt: Date?
    var higgsfieldLastSuccessAt: Date?
    let laneWatchStartedAt = Date()
    var lastLaneStaleLogAt: [String: Date] = [:]
    /// 화면에 넘길 최신 지연 꼬리말. 로그 쿨다운과 무관하게 매번 갱신한다 —
    /// 쿨다운은 로그가 도배되지 않게 하는 장치이지 화면을 감추는 장치가 아니다.
    var laneStaleNotes: [String: String] = [:]

    var currentBurnModel = SubscriptionBurnModel(usages: [], rates: [:], recommendations: [])
    /// 레인·창별 직전 관측. 경계는 값이 바뀌는 순간이라 직전 값이 있어야 안다.
    var lastQuotaObservations: [String: QuotaObservation] = [:]
    var quotaHistory: [QuotaCycle] = quotaHistoryDecode((try? Data(contentsOf: quotaHistoryURL)) ?? Data())

    /// 폴링이 끝날 때마다 부른다. 경계가 넘어갔으면 직전 주기를 확정해 남긴다.
    func recordQuotaObservation(_ observation: QuotaObservation, now: Date = Date(),
                                account: String? = nil) {
        let key = "\(observation.lane)/\(observation.window)/\(account ?? "-")"
        let previous = lastQuotaObservations[key]
        // 리셋 시각을 주는 레인은 그 변화로, 주지 않는 레인(Grok)은 큰 하락으로 경계를 본다.
        let closed = observation.resetAt == nil
            ? quotaDropBoundary(previous: previous, current: observation, now: now)
            : quotaCycleBoundary(previous: previous, current: observation, now: now)
        if let closed {
            quotaHistory = quotaHistoryTrimmed(quotaHistory + [closed], keepPerLane: 256)
            if let data = quotaHistoryEncode(quotaHistory) {
                try? FileManager.default.createDirectory(
                    at: quotaHistoryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: quotaHistoryURL, options: [.atomic])
            }
        }
        lastQuotaObservations[key] = observation
    }

    /// 평균은 살아 있는 계정만으로 낸다. 오류·비활성 계정을 분모에 넣으면
    /// 소비량이 실제보다 작게 보이고, 그 숫자로 구독을 줄이면 막힌다.
    private func burnMean(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }

    /// 계정 하나의 주간·세션 관측을 남기고 그 계정만의 전망을 낸다.
    ///
    /// 풀 전체를 최소 리셋 하나로 판정하면, 한 계정이 리셋되는 순간 아직 이전 주기인
    /// 계정과 새 주기인 계정이 섞여 평균이 오염된다. 실측에서 Claude 11계정의 리셋이
    /// 147시간, Codex 7계정이 642시간에 걸쳐 흩어져 있었다(적대 리뷰 2026-09-24).
    private func burnAccountProjection(lane: String, name: String, percent: Double?,
                                       resetAt: Date?, window: String, windowSeconds: Double,
                                       now: Date) -> BurnProjection? {
        guard let percent else { return nil }
        let utilization = percent / 100
        // 기록이 전망보다 먼저다. 순서를 뒤집으면 방금 닫힌 주기가 한 틱 늦게 반영된다.
        recordQuotaObservation(QuotaObservation(
            lane: lane, window: window, resetAt: resetAt,
            contributing: 1, paid: 1,
            meanUtilization: utilization, maxUtilization: utilization,
            exhaustedAccounts: utilization >= 1 ? 1 : 0,
            blocked: utilization >= 1), now: now, account: name)
        return burnProject(current: utilization, windowSeconds: windowSeconds,
                           resetAt: resetAt, history: [], now: now)
    }

    /// 계정별 전망을 하나로 합친다. 레인 이력이 충분하면 그 평균이 이긴다.
    private func burnCombine(_ perAccount: [BurnProjection], history: [QuotaCycle],
                             current: Double?) -> BurnProjection {
        let complete = history.filter { $0.complete }
        if complete.count >= 2 {
            let means = complete.map { $0.meanUtilization }
            let mean = means.reduce(0, +) / Double(means.count)
            return BurnProjection(current: current, projected: mean,
                                  range: (means.min() ?? mean)...(means.max() ?? mean),
                                  basis: .history(cycles: complete.count))
        }
        let projected = perAccount.compactMap { $0.projected }
        guard !projected.isEmpty else {
            return BurnProjection(current: current, projected: nil, range: nil,
                                  basis: current == nil ? .collecting : .unmeasured)
        }
        // 한 계정이라도 주기 초반이면 전체를 낮은 신뢰로 본다. 나쁜 소식을 숨기지 않는다.
        let low = perAccount.contains { $0.basis == .extrapolation(confidence: .low) }
        return BurnProjection(current: current,
                              projected: projected.reduce(0, +) / Double(projected.count),
                              range: nil,
                              basis: .extrapolation(confidence: low ? .low : .normal))
    }

    private func burnPoolUsage(lane: String, rows: [BurnAccountRow], now: Date) -> LaneUsage {
        // 구독이 끝난 계정은 오류가 아니라 해지다. 프록시는 이를 error + subscription-disabled로
        // 보고한다. 오류로 세면 "재인증"을 권하고, 지불 계정으로 세면 지출이 부풀려진다.
        let unsubscribed = rows.filter { $0.subscriptionEnded }
        let subscribed = rows.filter { !$0.subscriptionEnded }
        let live = subscribed.filter { $0.enabled && $0.status != "error" }
        let weeklyPerAccount = live.compactMap {
            burnAccountProjection(lane: lane, name: $0.name, percent: $0.weeklyPercent,
                                  resetAt: $0.weeklyResetAt, window: "7d",
                                  windowSeconds: 7 * 86_400, now: now)
        }
        let sessionPerAccount = live.compactMap {
            burnAccountProjection(lane: lane, name: $0.name, percent: $0.sessionPercent,
                                  resetAt: $0.sessionResetAt, window: "5h",
                                  windowSeconds: 5 * 3_600, now: now)
        }
        let laneHistory = quotaHistory.filter { $0.lane == lane }
        // 살아 있는 계정이 없으면 "한도 소진"이 아니라 "잴 수 없음"이다. 인증 실패를
        // 소진으로 오인하면 적색 부족 판정과 이력이 함께 오염된다(적대 리뷰 2026-09-24).
        let measured = live.compactMap { $0.weeklyPercent }
        let blockedNow = !measured.isEmpty && measured.count == live.count
            && measured.allSatisfy { $0 >= 100 }
        return LaneUsage(
            lane: lane, paidAccounts: subscribed.count, contributingAccounts: live.count,
            // 계정당 한 칸이다. 해지 계정 4개가 enabled=false이기도 했는데(2026-09-27 실측)
            // 그걸 "꺼 둠"에 또 세면 기여 없는 계정이 6이 아니라 10으로 보인다.
            errorAccounts: subscribed.filter { $0.status == "error" }.count,
            disabledAccounts: subscribed.filter { $0.status != "error" && !$0.enabled }.count,
            unsubscribedAccounts: unsubscribed.count,
            weekly: burnCombine(weeklyPerAccount, history: laneHistory.filter { $0.window == "7d" },
                                current: burnMean(measured.map { $0 / 100 })),
            session: burnCombine(sessionPerAccount, history: laneHistory.filter { $0.window == "5h" },
                                 current: burnMean(live.compactMap { $0.sessionPercent }.map { $0 / 100 })),
            blockedMoments: laneHistory.filter { $0.window == "7d" }
                .reduce(0) { $0 + $1.blockedMoments } + (blockedNow ? 1 : 0))
    }

    /// 단일 구독 레인(agy·Grok). 계정이 하나라 판정은 사용률만 본다.
    private func burnSingleUsage(lane: String, utilization: Double?, resetAt: Date?,
                                 windowSeconds: Double, now: Date) -> LaneUsage {
        if let utilization {
            recordQuotaObservation(QuotaObservation(
                lane: lane, window: "7d", resetAt: resetAt, contributing: 1, paid: 1,
                meanUtilization: utilization, maxUtilization: utilization,
                exhaustedAccounts: utilization >= 1 ? 1 : 0, blocked: utilization >= 1), now: now)
        }
        let laneHistory = quotaHistory.filter { $0.lane == lane && $0.window == "7d" }
        return LaneUsage(
            lane: lane, paidAccounts: 1, contributingAccounts: 1,
            errorAccounts: 0, disabledAccounts: 0,
            weekly: burnProject(current: utilization, windowSeconds: windowSeconds,
                                resetAt: resetAt, history: laneHistory, now: now),
            session: BurnProjection(current: nil, projected: nil, range: nil, basis: .collecting),
            blockedMoments: laneHistory.reduce(0) { $0 + $1.blockedMoments })
    }

    /// 네 레인을 한 모델로 모은다. 폴링 결과가 바뀔 때마다 부른다.
    func refreshBurnModel(now: Date = Date()) {
        var usages: [LaneUsage] = []
        if let claude = currentTeamClaude {
            usages.append(burnPoolUsage(lane: "claude", rows: claude.accounts.map {
                BurnAccountRow(name: $0.name, enabled: $0.enabled, status: $0.status,
                               errorReason: $0.errorReason,
                               subscriptionEnded: $0.errorReason == "subscription-disabled"
                                   || $0.subscriptionConfirmation?.state == .ended,
                               weeklyPercent: $0.weeklyPercent, weeklyResetAt: $0.weeklyResetAt,
                               sessionPercent: $0.sessionPercent, sessionResetAt: $0.sessionResetAt)
            }, now: now))
        }
        // Codex도 같은 풀이다. 빠뜨리면 월 합계가 줄고 그 레인의 권고가 사라진다.
        if let codex = currentTeamCodex {
            usages.append(burnPoolUsage(lane: "codex", rows: codex.accounts.map {
                BurnAccountRow(name: $0.name, enabled: $0.enabled, status: $0.status,
                               errorReason: $0.errorReason,
                               subscriptionEnded: $0.isSubscriptionRetired(now: now)
                                   || $0.isSubscriptionEndDateReached(now: now),
                               weeklyPercent: $0.weeklyPercent, weeklyResetAt: $0.weeklyResetAt,
                               sessionPercent: $0.sessionPercent, sessionResetAt: $0.sessionResetAt)
            }, now: now))
        }
        // agy는 잔량을 주므로 1에서 빼 사용률로 뒤집는다.
        if let gemini = currentAgyCard.groups.first, let weekly = gemini.weekly {
            usages.append(burnSingleUsage(lane: "agy", utilization: 1 - weekly.remaining,
                                          resetAt: weekly.resetAt, windowSeconds: 7 * 86_400, now: now))
        }
        // Grok은 리셋 시각을 주지 않는다. 전망은 이력이 쌓인 뒤에 나온다.
        if let slot = currentGrokSlot, let percent = burnGrokPercent(slot) {
            usages.append(burnSingleUsage(lane: "grok", utilization: percent / 100,
                                          resetAt: nil, windowSeconds: 7 * 86_400, now: now))
        }
        currentBurnModel = SubscriptionBurnModel(usages: usages, rates: subscriptionRates(),
                                                 recommendations: burnRecommendations(usages),
                                                 currency: subscriptionCurrency())
    }

    var cachedPulseImage: NSImage?
    var cachedPulseKey: String?
    var cachedComposedImage: NSImage?
    var cachedComposedKey: String?

    // 롤링 상태
    var rollIndex = 0       // 현재 표시 중인 정보 슬롯
    var pulseFrame = 0      // 펄스 애니메이션 프레임 (0~3)
    var tickCount = 0       // 1초 tick 누적 (5의 배수마다 슬롯 전환)
    var isActive = false    // 최근 활동 감지 결과
    var parallelCount = 0   // 현재 병렬 실행 중인 Claude Code 인스턴스 수
    var isFetching = false  // ccusage 전체 호출 진행 중 플래그 (동시 호출 방지 — 좀비 누적 차단)
    var isFetchingUsageQuick = false  // 전체 호출 중 수동 새로고침용 daily quick 경로
    var lastFullUsageCompletedAt: Date?
    var lastUsageQuickCompletedAt: Date?
    var teamClaudeRefreshCoordinator = TeamClaudeRefreshCoordinator()
    var isRefreshingTeamClaude: Bool { teamClaudeRefreshCoordinator.isRunning }
    var isRefreshingCodex = false
    var isRefreshingTeamCodex = false
    var isRefreshingStatus: Bool { isRefreshingTeamClaude || isRefreshingCodex || isRefreshingTeamCodex }
    var isMeasuringTeamClaude = false
    var teamClaudeMeasureDetail: String?
    var teamClaudeConfigWatchGeneration = 0
    var teamCodexConfigWatchState = TeamCodexConfigWatchState()
    var teamCodexConfigRefreshCoordinator = TeamCodexConfigRefreshCoordinator()
    var lastTeamClaudeAutoSyncAt: Date?
    var pendingTeamClaudeForcedSyncReason: String?
    var teamClaudeOutageStartedAt: TimeInterval?
    var attemptedTeamClaudeOutageStartedAt: TimeInterval?
    var attemptedTeamClaudeDriftTopologySignature: Int?
    weak var openDashboardView: StatusMenuDashboardView?
    var cachedDashboardView: StatusMenuDashboardView?
    weak var cachedDashboardItem: NSMenuItem?
    /// 대시보드가 화면보다 길 때 그 스크롤 뷰 위에 떠서 현재 섹션 이름을 말하는 고정 헤더 (스크롤 뷰 하나에 하나).
    var pinnedSectionHeader: DashboardSectionHeaderView?
    weak var dashboardScrollView: NSScrollView?
    var dashboardScrollObserver: NSObjectProtocol?
    weak var refreshMenuView: MenuActionRowView?
    weak var measureMenuView: MenuActionRowView?
    var hasScheduledMenuPrewarm = false
    var isPreparingMenuCache = false
    var cachedSparklineCosts: [Double] = []
    var cachedSparklineImage: NSImage?

    // 펄스 프레임: 활성일 때 회전, idle일 때 정지
    let pulseFramesActive = ["●", "◐", "○", "◐"]
    let pulseFrameIdle = "○"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        trimLogIfNeeded("\(NSHomeDirectory())/.claude/cache/cc-menubar.log")
        if let snapshot = teamCodexConfigSnapshot() {
            teamCodexConfigWatchState.seed(snapshot)
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.button?.toolTip = "Claude Code 사용량 — 좌측 스파크라인은 최근 7일 일별 비용 (오늘=초록). 클릭하면 상세."
        setLoading()

        let menu = NSMenu()
        menu.delegate = self
        statusItem?.menu = menu

        refresh()
        updateActivity() // 즉시 첫 감지
        scheduleMenuPrewarm()

        // 1초마다: 펄스 프레임 회전 + tickCount 누적 (5의 배수에서 슬롯 전환)
        rollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        if let t = rollTimer { RunLoop.main.add(t, forMode: .common) }

        // 15초마다 활동 감지 (1-depth dir mtime만 stat — 매우 가벼움)
        activityTimer = Timer.scheduledTimer(withTimeInterval: 15.0, repeats: true) { [weak self] _ in
            self?.updateActivity()
        }
        if let t = activityTimer { RunLoop.main.add(t, forMode: .common) }

        // 계정 쿼터와 현재 계정은 사용 중 빠르게 바뀌므로 비용 집계와 분리해 갱신한다.
        statusTimer = Timer.scheduledTimer(withTimeInterval: 10.0, repeats: true) { [weak self] _ in
            self?.loadFastStatusInBackground()
        }
        if let t = statusTimer { RunLoop.main.add(t, forMode: .common) }

        // 60초마다 Codex 세션 코퍼스 스캔 (10초 틱에서 분리 — 최근 8일 수백 파일·수 GB를 stat/tail 하는 디스크 작업)
        codexScanTimer = Timer.scheduledTimer(withTimeInterval: 60.0, repeats: true) { [weak self] _ in
            self?.loadCodexStatusInBackground()
        }
        if let t = codexScanTimer { RunLoop.main.add(t, forMode: .common) }

        // 5분마다 ccusage 갱신
        dataTimer = Timer.scheduledTimer(withTimeInterval: 300.0, repeats: true) { [weak self] _ in
            self?.loadUsageInBackground()
        }
        if let t = dataTimer { RunLoop.main.add(t, forMode: .common) }

        grokTimer = Timer.scheduledTimer(withTimeInterval: grokUsageFetchInterval, repeats: true) { [weak self] _ in
            self?.loadGrokUsageInBackground()
        }
        if let t = grokTimer { RunLoop.main.add(t, forMode: .common) }

        agyTimer = Timer.scheduledTimer(withTimeInterval: agyUsageFetchInterval, repeats: true) { [weak self] _ in
            self?.loadAgyUsageInBackground()
        }
        if let t = agyTimer { RunLoop.main.add(t, forMode: .common) }

        higgsfieldTimer = Timer.scheduledTimer(withTimeInterval: higgsfieldFetchInterval, repeats: true) { [weak self] _ in
            // 타이머 자체가 주기다. force 없이 부르면 발화 시 경과가 (간격 − CLI 왕복)이라
            // 같은 값의 스로틀에 걸려 한 틱씩 걸러지고 실효 주기가 두 배가 된다.
            // 중복 실행은 isFetchingHiggsfield가 막는다.
            self?.loadHiggsfieldInBackground(force: true)
        }
        if let t = higgsfieldTimer { RunLoop.main.add(t, forMode: .common) }
    }

    // MARK: - Tick (1초마다 호출)

    func tick() {
        pulseFrame = (pulseFrame + 1) % pulseFramesActive.count
        tickCount += 1
        observeTeamCodexConfigChanges()
        // 5초마다 표시 슬롯 전환
        if tickCount % 5 == 0 {
            rollIndex = (rollIndex + 1) % displaySlots().count
        }
        if tickCount % 60 == 0 { reportStaleLanes() }
        updateTitle()
    }

    /// 갱신이 끊긴 CLI 레인을 로그로 드러낸다. 값이 낡았는데 화면은 멀쩡해 보이는 상태가
    /// 세 번 반복됐다(agy·힉스필드·grok) — 조용히 죽지 않게 하는 것이 목적이다.
    func reportStaleLanes(now: Date = Date()) {

        let messages = laneStaleMessages([
            LaneHealth(name: "grok", interval: grokUsageFetchInterval,
                       lastSuccessAt: grokLastSuccessAt, startedAt: laneWatchStartedAt),
            LaneHealth(name: "agy", interval: agyUsageFetchInterval,
                       lastSuccessAt: agyLastSuccessAt, startedAt: laneWatchStartedAt),
            LaneHealth(name: "higgsfield", interval: higgsfieldFetchInterval,
                       lastSuccessAt: higgsfieldLastSuccessAt, startedAt: laneWatchStartedAt),
        ], now: now)
        let notes = Dictionary(uniqueKeysWithValues: messages.map { ($0.name, $0.note) })
        if notes != laneStaleNotes {
            laneStaleNotes = notes
            scheduleDashboardRefresh(reason: "lane-stale")
        }
        var printed = false
        for notice in messages {
            if let last = lastLaneStaleLogAt[notice.name],
               now.timeIntervalSince(last) < laneStaleLogCooldown {
                continue
            }
            lastLaneStaleLogAt[notice.name] = now
            print(notice.message)
            printed = true
        }
        if printed { fflush(stdout) }
    }

    func updateActivity() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let active = isClaudeActive()
            let parallel = countParallelClaudeSessions()
            DispatchQueue.main.async {
                self?.isActive = active
                self?.parallelCount = parallel
            }
        }
    }

    // MARK: - 타이틀 조립

    /// 롤링 표시 슬롯 (5초마다 순환). 데이터 없으면 병렬 세션 수만 표시.
    func displaySlots() -> [String] {
        if isMeasuringTeamClaude {
            return ["Claude 측정 중"]
        }
        let teamClaudeSlot = currentTeamClaude?.titleSlot
        let codexSlot = currentCodex?.titleSlot
        let teamCodexSlot = currentTeamCodex?.titleSlot
        // 데이터 없으면 최소 정보 — 병렬 세션 수만이라도 의미 있음
        guard let usage = currentData, let today = usage.today else {
            return [teamClaudeSlot, teamCodexSlot, codexSlot, "병렬 \(parallelCount)"].compactMap { $0 }
        }
        let todayTokens = today.inputTokens + today.cacheCreationTokens
                        + today.cacheReadTokens + today.outputTokens
        let rate = usage.usdKrwRate

        // 이번 달 제공자별 비용 (codex 추적) — 상위 제공자 슬롯
        var provAcc: [String: Double] = [:]
        for m in usage.modelBreakdown { provAcc[m.provider, default: 0] += m.cost }
        let codexCost = provAcc["Codex"] ?? 0

        var slots = [
            teamClaudeSlot,
            teamCodexSlot,
            codexSlot,
            "오늘 \(formatCost(today.totalCost))",
            "오늘 \(formatKRWShort(today.totalCost, rate: rate))",
            "토큰 \(formatTokens(todayTokens))",
            "주간 \(formatCost(usage.weeklyTotalCost))",
            "이번주 \(formatCost(usage.thisWeekCost))",
            "이번달 \(formatCost(usage.thisMonthCost))",
            "이번달 \(formatKRWShort(usage.thisMonthCost, rate: rate))",
            "누적 \(formatKRWShort(usage.allTimeCost, rate: rate))",
            "총 \(formatTokens(usage.allTimeTokens))",
            "병렬 \(parallelCount)",
        ].compactMap { $0 }
        // codex 사용이 있으면 별도 슬롯으로 노출
        if codexCost > 0 { slots.append("코덱스 \(formatCost(codexCost))") }
        slots.append(usage.modelBreakdown.first?.label ?? today.models.first ?? "Claude") // 최다 비용 모델
        return slots
    }

    func setLoading() {
        DispatchQueue.main.async { [weak self] in
            self?.statusItem?.button?.title = "○ 로딩…"
        }
    }

    func updateTitle() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let button = self.statusItem?.button else { return }

            let slots = self.displaySlots()
            let info = slots.isEmpty ? "Claude" : slots[self.rollIndex % slots.count]
            let activeMark = self.isActive ? " ⚡" : ""
            // CLI 할당량(Grok·agy)은 회전 슬롯이 아니라 항상 보이는 앞자리에 둔다.
            let cliSlots = [self.currentGrokSlot, agyTitleSlot(self.currentAgyCard)].compactMap { $0 }
            let cliPrefix = cliSlots.isEmpty ? "" : cliSlots.joined(separator: " · ") + " · "
            let text = "\(cliPrefix)\(info)\(activeMark)"

            // 좌측: 펄스 도트(활성=초록 숨쉬기, idle=회색 링) + 스파크라인 미니 차트
            // idle이거나 같은 프레임이면 이미지를 다시 그리지 않는다. 1초 tick의 lockFocus가 클릭을 밀지 않게.
            let pulseKey = self.isActive ? "on-\(self.pulseFrame % self.pulseFramesActive.count)" : "idle"
            if self.cachedPulseKey != pulseKey || self.cachedPulseImage == nil {
                self.cachedPulseImage = makePulseDot(active: self.isActive, frame: self.pulseFrame)
                self.cachedPulseKey = pulseKey
            }
            let pulseDot = self.cachedPulseImage ?? makePulseDot(active: self.isActive, frame: self.pulseFrame)

            // 합성 이미지: [펄스 도트][스파크라인] 가로 배치
            let dotW = pulseDot.size.width
            let sparkline: NSImage?
            if let costs = self.currentData?.last7Costs {
                if costs != self.cachedSparklineCosts {
                    self.cachedSparklineCosts = costs
                    self.cachedSparklineImage = makeSparklineImage(costs)
                }
                sparkline = self.cachedSparklineImage
            } else {
                if !self.cachedSparklineCosts.isEmpty || self.cachedSparklineImage != nil {
                    self.cachedSparklineCosts = []
                    self.cachedSparklineImage = nil
                }
                sparkline = nil
            }
            let composeKey = "\(pulseKey)|\(sparkline == nil ? "none" : "spark")|\(self.cachedSparklineCosts.map { String($0) }.joined(separator: ","))"
            if self.cachedComposedKey != composeKey || self.cachedComposedImage == nil {
                let sparkW = sparkline?.size.width ?? 0
                let composedW = dotW + (sparkW > 0 ? 4 + sparkW : 0)
                let composedH: CGFloat = 16
                let composed = NSImage(size: NSSize(width: composedW, height: composedH))
                composed.lockFocus()
                pulseDot.draw(at: NSPoint(x: 0, y: (composedH - pulseDot.size.height) / 2), from: .zero, operation: .sourceOver, fraction: 1.0)
                if let s = sparkline {
                    s.draw(at: NSPoint(x: dotW + 4, y: 0), from: .zero, operation: .sourceOver, fraction: 1.0)
                }
                composed.unlockFocus()
                composed.isTemplate = false
                self.cachedComposedImage = composed
                self.cachedComposedKey = composeKey
            }

            button.image = self.cachedComposedImage
            button.imagePosition = .imageLeading
            button.title = " \(text)"
            let cliTip = cliSlots.isEmpty ? "" : " · " + cliSlots.joined(separator: " · ")
            if let health = self.currentTeamClaude {
                let fable = health.fableKnown > 0 ? "Fable \(health.fableOver)/\(health.fableKnown)" : "Fable -"
                let measurement = " · 측정 필요 \(health.measurementPendingCount) · 상태 확인 \(health.measurementUnavailableCount) · 한도 리셋 \(health.quotaLimitedCount)"
                let integration = health.accountConfigDrift == 0 ? " · 계정 연동 정상" : " · 계정 연동 불일치 \(health.accountConfigDrift)"
                let codex = self.currentCodex.map { " · codex \($0.statusLabel) · calls \($0.todayCalls)/\($0.weekCalls)" } ?? ""
                button.toolTip = "Claude Code 사용량 · teamclaude \(health.statusLabel) · \(fable) · active \(health.accountActive)/\(max(health.accountTotal, health.accountConfigured))\(integration)\(measurement)\(codex)\(cliTip)"
            } else if let codex = self.currentCodex {
                button.toolTip = "Claude Code 사용량 · codex \(codex.statusLabel) · calls \(codex.todayCalls)/\(codex.weekCalls)\(cliTip)"
            } else if !cliSlots.isEmpty {
                button.toolTip = "Claude Code 사용량\(cliTip)"
            }

        }
    }

    // MARK: - 데이터 로딩

    func refresh() {
        setLoading()
        rollIndex = 0
        updateActivity()
        loadFastStatusInBackground()
        loadCodexStatusInBackground()   // 기동 시 1회 — 이후엔 codexScanTimer(60초)가 돈다
        loadUsageInBackground()
        loadHiggsfieldInBackground()
        loadGrokUsageInBackground(force: true)
        loadAgyUsageInBackground(force: true)
    }

    /// 힉스필드 크레딧 조회. CLI 왕복이라 느릴 수 있어 단일 실행만 허용하고 10분 간격으로 제한한다.
    /// 크레딧은 생성할 때만 움직여서 더 촘촘히 볼 이유가 없다.
    func loadHiggsfieldInBackground(force: Bool = false) {
        guard !isFetchingHiggsfield else { return }
        if !force, let last = lastHiggsfieldFetchedAt, Date().timeIntervalSince(last) < higgsfieldFetchInterval { return }
        isFetchingHiggsfield = true

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let data = fetchHiggsfieldCredits()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isFetchingHiggsfield = false
                self.lastHiggsfieldFetchedAt = Date()
                // 실패해도 기존 데이터를 지우지 않는다(깜빡임 방지). 첫 조회 실패만 그대로 보여 준다.
                // 일부 페이지만 받아도 error는 nil이라, 그것까지 성공으로 적으면
                // 계속 반쪽만 받는 상태에서 지연 경보가 영영 뜨지 않는다.
                if data.error == nil && data.partialError == nil {
                    self.higgsfieldLastSuccessAt = Date()
                }
                // 다른 레인(GROK-SLOT·AGY)은 주기마다 한 줄을 남기는데 힉스필드만 조용했다.
                // 그 공백 때문에 "조회가 도는가"를 로그로 답할 수 없었다(2026-09-24).
                if let failure = data.error ?? data.partialError {
                    print("HIGGSFIELD: 조회 실패 \(failure)")
                } else {
                    print("HIGGSFIELD: \(Int(data.credits))크레딧")
                }
                fflush(stdout)
                if data.error == nil || self.currentHiggsfield == nil {
                    self.currentHiggsfield = data
                }
                self.scheduleDashboardRefresh(reason: "loadHiggsfieldInBackground")
            }
        }
    }

    func refreshStatusOnly() {
        rollIndex = 0
        updateActivity()
        loadFastStatusInBackground()
    }

    func refreshInteractive() {
        rollIndex = 0
        updateActivity()
        loadFastStatusInBackground()
        loadCodexStatusInBackground()
        if isFetching {
            loadUsageQuickInBackground(reason: "manual")
        } else {
            loadUsageInBackground()
        }
    }

    private var pendingDashboardRefresh: DispatchWorkItem?

    /// 로더 완료마다 곧장 다시 그리지 않고 합쳐서 한 번만 그린다 — 열린 메뉴는 0.3초, 닫힌 메뉴는 `closedMenuRefreshWindow`(30초).
    /// 대기 중인 항목이 있으면 그 마감을 유지하는 스로틀이고, 메뉴를 여는 순간 `flushPendingDashboardRefresh`가 그 자리에서 반영한다.
    /// `immediate: true`는 측정 액션(`measureTeamClaudeAction`) 경로만 쓴다.
    func scheduleDashboardRefresh(reason: String, immediate: Bool = false) {
        if immediate {
            pendingDashboardRefresh?.cancel()
            pendingDashboardRefresh = nil
            refreshOpenDashboard(reason: reason)
            return
        }
        // 스로틀: 이미 대기 중이면 그 마감을 유지한다. 새 요청마다 재예약(디바운스)하면 10초마다 오는 로더 완료가
        // 30초 창을 영원히 밀어내 닫힌 메뉴 캐시가 한 번도 갱신되지 않는다(2026-09-23 실측 0건/120초).
        if pendingDashboardRefresh != nil { return }
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingDashboardRefresh = nil
            self.refreshOpenDashboard(reason: reason)
        }
        pendingDashboardRefresh = item
        // 열린 메뉴는 0.3초 안에 합쳐 바로 반영, 닫힌 메뉴는 30초 단위로만 캐시를 데운다(열 때 pending이 있으면 그 자리에서 반영).
        let window: TimeInterval = openDashboardView != nil ? 0.3 : closedMenuRefreshWindow
        DispatchQueue.main.asyncAfter(deadline: .now() + window, execute: item)
    }

    /// 닫힌 메뉴의 캐시 프레젠테이션 갱신 주기. 10초마다 로더 3개가 각각 재구성하던 비용(굶는 메인 스레드에서 2~6초)을 1/9로 줄인다.
    let closedMenuRefreshWindow: TimeInterval = 30

    /// 대기 중인 닫힌 메뉴 갱신을 지금 실행한다(메뉴를 여는 순간 최신 데이터로).
    func flushPendingDashboardRefresh(reason: String) {
        guard let pending = pendingDashboardRefresh else { return }
        pending.cancel()
        pendingDashboardRefresh = nil
        refreshOpenDashboard(reason: reason)
    }

    func refreshOpenDashboard(reason: String = "direct") {
        guard let dashboard = cachedDashboardView ?? openDashboardView else { return }
        let startedAt = ProcessInfo.processInfo.systemUptime
        let cpuStart = dashboardThreadCPUMs()
        dashboard.lastRefreshPhases = nil
        defer {
            let elapsedMs = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
            let cpuMs = Int(dashboardThreadCPUMs() - cpuStart)
            let phases = dashboard.lastRefreshPhases?.summary ?? "-"
            print("DASHBOARD-REFRESH: reason=\(reason) open=\(openDashboardView != nil) elapsed=\(elapsedMs)ms cpu=\(cpuMs)ms phases=\(phases)")
            fflush(stdout)
        }
        // 메뉴가 닫혀 있으면 캐시 프레젠테이션 갱신 한 번으로 끝낸다(그 안에서 updateContent 1회). 예전엔 여기서 한 번 더 돌아 비용이 2배였다.
        if openDashboardView == nil {
            updateCachedMenuPresentation()
            return
        }
        dashboard.updateContent(
            teamClaude: currentTeamClaude,
            codex: currentCodex,
            teamCodex: currentTeamCodex,
            usage: currentData,
            higgsfield: currentHiggsfield,
            grok: currentGrokCard,
            agy: currentAgyCard,
            burnModel: currentBurnModel,
            laneStaleNotes: laneStaleNotes,
            parallelCount: parallelCount,
            active: isActive,
            isMeasuringTeamClaude: isMeasuringTeamClaude,
            teamClaudeMeasureDetail: teamClaudeMeasureDetail,
            onMeasureTeamClaude: { [weak self] in self?.measureTeamClaudeAction() },
            onReauthenticateTeamClaude: { [weak self] name, accountUuid in
                self?.reauthenticateTeamClaudeAccount(name, expectedAccountUuid: accountUuid)
            },
            onRecoverTeamCodex: { [weak self] name, accountUuid, kind in
                self?.recoverTeamCodexAccount(name, expectedAccountUuid: accountUuid, kind: kind)
            }
        )
        dashboard.needsDisplay = true
        updatePinnedSectionHeader()
    }

    /// 10초 틱: 프록시 상태 2종(HTTP 한 번씩)만. Codex 세션 코퍼스 스캔은 디스크 작업이라 `codexScanTimer`(60초)가 따로 돈다.
    func loadFastStatusInBackground() {
        loadTeamClaudeStatusInBackground()
        loadTeamCodexStatusInBackground()
    }

    /// Grok 사용량은 클릭 경로에 붙이지 않는다. 60초에 한 번, 응답이 도착한 뒤에만 제목을 바꾼다.
    func loadGrokUsageInBackground(force: Bool = false) {
        guard !isFetchingGrok else { return }
        if !force, let last = lastGrokFetchedAt, Date().timeIntervalSince(last) < grokUsageFetchInterval { return }
        isFetchingGrok = true
        lastGrokFetchedAt = Date()
        fetchGrokMenuOutcome { [weak self] outcome in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetchingGrok = false
                let slot: String
                switch outcome {
                case .percent(let outcome):
                    self.grokLastSuccessAt = Date()
                    self.currentGrokSlot = outcome.slot
                    self.currentGrokCard = GrokCardModel(
                        headline: outcome.slot,
                        detail: grokCardDetail(product: outcome.productPercent, credit: outcome.creditPercent)
                    )
                    slot = outcome.slot
                case .expired:
                    self.currentGrokSlot = "Grok 갱신 필요"
                    self.currentGrokCard = GrokCardModel(
                        headline: "Grok 갱신 필요",
                        detail: "토큰 기한이 지났습니다. grok을 한 번 실행하면 갱신됩니다."
                    )
                    slot = "Grok 갱신 필요"
                case .login:
                    self.currentGrokSlot = "Grok 로그인"
                    self.currentGrokCard = GrokCardModel(headline: "Grok 로그인", detail: nil)
                    slot = "Grok 로그인"
                case .unavailable:
                    if self.currentGrokSlot == nil
                        || self.currentGrokSlot == "Grok 로그인"
                        || self.currentGrokSlot == "Grok 갱신 필요"
                        || self.currentGrokSlot == "Grok 확인 중" {
                        self.currentGrokSlot = "Grok 확인 필요"
                        self.currentGrokCard = GrokCardModel(headline: "Grok 확인 필요", detail: nil)
                    }
                    slot = self.currentGrokSlot ?? "Grok 확인 필요"
                }
                print("GROK-SLOT: \(slot)")
                fflush(stdout)
                self.updateTitle()
                self.refreshBurnModel()
                self.scheduleDashboardRefresh(reason: "loadGrokUsageInBackground")
            }
        }
    }

    /// agy 할당량도 클릭과 무관하게 60초에 한 번만 읽는다. 실패하면 마지막 정상 값을 유지한다.
    func loadAgyUsageInBackground(force: Bool = false) {
        guard !isFetchingAgy else { return }
        if !force, let last = lastAgyFetchedAt, Date().timeIntervalSince(last) < agyUsageFetchInterval { return }
        isFetchingAgy = true
        // 호출이 끝난 시각에 찍으면 소요 시간만큼 다음 주기가 밀려 실효 간격이 두 배가 된다.
        lastAgyFetchedAt = Date()
        fetchAgyUsage { [weak self] outcome in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetchingAgy = false
                switch outcome {
                case .missing:
                    self.agyHasValue = false
                    self.currentAgyCard = AgyCardModel(message: "agy 없음", groups: [])
                case .ready(let groups):
                    let lanes = agyVisibleGroups(groups)
                    if !lanes.isEmpty { self.agyLastSuccessAt = Date() }
                    self.agyHasValue = !lanes.isEmpty
                    self.currentAgyCard = lanes.isEmpty
                        ? AgyCardModel(message: "agy Gemini 레인 없음", groups: [])
                        : AgyCardModel(message: nil, groups: lanes)
                case .failed:
                    if !self.agyHasValue {
                        self.currentAgyCard = AgyCardModel(message: "agy 확인 필요", groups: [])
                    }
                }
                print("AGY: \(agyLogLine(self.currentAgyCard))")
                fflush(stdout)
                self.refreshBurnModel()
                self.scheduleDashboardRefresh(reason: "loadAgyUsageInBackground")
            }
        }
    }

    func commitTeamClaudeHealth(_ candidate: TeamClaudeHealth, outageDuration: TimeInterval = 0) {
        guard teamClaudeCandidateIsCurrent(
            candidateCheckedAt: candidate.checkedAt,
            currentCheckedAt: currentTeamClaude?.checkedAt
        ) else {
            print("TEAMCLAUDE-STALE: 더 오래된 응답 폐기")
            fflush(stdout)
            return
        }

        let hasMeasuredQuota = currentTeamClaude?.accounts.contains {
            $0.weeklyPercent != nil || $0.fablePercent != nil
        } == true

        if teamClaudeShouldRetainQuota(
            candidateReachable: candidate.serverReachable,
            hasMeasuredQuota: hasMeasuredQuota
        ), let previous = currentTeamClaude {
            currentTeamClaude = teamClaudeRetainingQuota(candidate: candidate, previous: previous)
            print("TEAMCLAUDE-STALE: 서버 연결 실패 \(Int(outageDuration))초, 마지막 정상 주간/Fable 유지")
            fflush(stdout)
            return
        }

        currentTeamClaude = teamClaudeHealthMergingQuota(
            candidate: candidate,
            previous: currentTeamClaude
        )
    }

    func loadTeamClaudeStatusInBackground() {
        guard teamClaudeRefreshCoordinator.request() else { return }
        let forcedSyncReason = pendingTeamClaudeForcedSyncReason
        pendingTeamClaudeForcedSyncReason = nil
        let previousOutageStartedAt = teamClaudeOutageStartedAt
        let previousAttemptedOutageStartedAt = attemptedTeamClaudeOutageStartedAt
        let previousAttemptedDriftTopologySignature = attemptedTeamClaudeDriftTopologySignature
        let autoSyncAllowed = lastTeamClaudeAutoSyncAt.map { Date().timeIntervalSince($0) > 60 } ?? true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            var teamClaude = loadTeamClaudeHealth()
            let topologySignature = teamClaudeAccountTopologySignature()
            let observedAt = ProcessInfo.processInfo.systemUptime
            var outageStartedAt = nextTeamClaudeOutageStartedAt(
                previous: previousOutageStartedAt,
                candidateReachable: teamClaude.serverReachable,
                observedAt: observedAt
            )
            let outageDuration = outageStartedAt.map { max(0, observedAt - $0) } ?? 0
            var syncReason = forcedSyncReason
            if syncReason == nil,
               let recovery = teamClaudeRecoveryReason(
                   serverReachable: teamClaude.serverReachable,
                   configPresent: teamClaude.configPresent,
                   accountConfigDrift: teamClaude.accountConfigDrift
               ) {
                switch recovery {
                case .serverOffline:
                    if teamClaudeShouldAutoRecover(
                        candidateReachable: false,
                        accountConfigDrift: 0,
                        outageDurationSeconds: outageDuration
                    ), teamClaudeShouldAttemptRecoveryForOutage(
                        outageStartedAt: outageStartedAt,
                        attemptedOutageStartedAt: previousAttemptedOutageStartedAt
                    ) {
                        syncReason = "서버 연결 \(Int(outageDuration))초 실패"
                    }
                case .accountDrift(let count):
                    if teamClaudeShouldAttemptRecoveryForDrift(
                        topologySignature: topologySignature,
                        attemptedTopologySignature: previousAttemptedDriftTopologySignature
                    ) {
                        syncReason = "계정 연동 불일치 \(count)개"
                    }
                }
            }

            var syncAttempted = false
            var syncSucceeded = false
            if let syncReason, forcedSyncReason != nil || autoSyncAllowed {
                syncAttempted = true
                print("TEAMCLAUDE-AUTOSYNC: \(syncReason), 서버 재시작")
                fflush(stdout)
                let kicked = kickstartTeamClaudeServer()
                if kicked {
                    for _ in 0..<45 {
                        Thread.sleep(forTimeInterval: 1)
                        teamClaude = loadTeamClaudeHealth()
                        if teamClaude.serverReachable && teamClaude.accountConfigDrift == 0 {
                            outageStartedAt = nil
                            syncSucceeded = true
                            break
                        }
                    }
                }
                if !syncSucceeded {
                    print("TEAMCLAUDE-AUTOSYNC-FAILED: \(syncReason) kicked=\(kicked)")
                    fflush(stdout)
                }
            }

            DispatchQueue.main.async {
                guard let self = self else { return }
                if syncAttempted {
                    self.lastTeamClaudeAutoSyncAt = Date()
                    if let outageStartedAt {
                        self.attemptedTeamClaudeOutageStartedAt = outageStartedAt
                    }
                    if teamClaude.serverReachable && teamClaude.accountConfigDrift > 0 {
                        self.attemptedTeamClaudeDriftTopologySignature = topologySignature
                    }
                }
                if teamClaude.serverReachable {
                    self.attemptedTeamClaudeOutageStartedAt = nil
                }
                if teamClaude.accountConfigDrift == 0 {
                    self.attemptedTeamClaudeDriftTopologySignature = nil
                }
                self.teamClaudeOutageStartedAt = teamClaude.serverReachable ? nil : outageStartedAt
                self.commitTeamClaudeHealth(teamClaude, outageDuration: outageDuration)
                let shouldRefreshAgain = self.teamClaudeRefreshCoordinator.finish()
                self.refreshBurnModel()
                self.scheduleDashboardRefresh(reason: "loadTeamClaudeStatusInBackground")
                self.updateTitle()
                let displayed = self.currentTeamClaude ?? teamClaude
                print("TEAMCLAUDE-REFRESH: status=\(displayed.statusLabel) usable=\(displayed.accountUsable)/\(max(displayed.accountTotal, displayed.accountConfigured)) drift=\(displayed.accountConfigDrift) pending=\(displayed.measurementPendingCount) unavailable=\(displayed.measurementUnavailableCount) quotaLimited=\(displayed.quotaLimitedCount)")
                fflush(stdout)
                if shouldRefreshAgain {
                    self.loadTeamClaudeStatusInBackground()
                }
            }
        }
    }

    func loadCodexStatusInBackground() {
        guard !isRefreshingCodex else { return }
        isRefreshingCodex = true
        // 디스크 바운드 스캔은 background QoS — 대표의 작업·다른 프로세스와 디스크를 다투지 않는다.
        DispatchQueue.global(qos: .background).async { [weak self] in
            let startedAt = ProcessInfo.processInfo.systemUptime
            let codex = autoreleasepool { loadCodexHealth() }
            let elapsedMs = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
            malloc_zone_pressure_relief(nil, 0)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.currentCodex = codex
                self.isRefreshingCodex = false
                self.scheduleDashboardRefresh(reason: "loadCodexStatusInBackground")
                self.updateTitle()
                let scan = codex.scan.map { " scan=files:\($0.files) changed:\($0.changed) bytes:\($0.bytesRead)" } ?? ""
                print("CODEX-REFRESH: status=\(codex.statusLabel) calls=\(codex.todayCalls)/\(codex.weekCalls) duration=\(elapsedMs)ms\(scan)")
                fflush(stdout)
            }
        }
    }

    func loadTeamCodexStatusInBackground() {
        guard !isRefreshingTeamCodex else { return }
        isRefreshingTeamCodex = true
        let snapshot = teamCodexConfigSnapshot()
        let refreshContext = teamCodexConfigWatchState.refreshContext(
            configSignature: snapshot?.signature
        )
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let teamCodex = autoreleasepool { loadTeamCodexPoolHealth() }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isRefreshingTeamCodex = false
                self.commitTeamCodexHealth(
                    teamCodex,
                    expectedContext: refreshContext
                )
            }
        }
    }

    func commitTeamCodexHealth(
        _ candidate: TeamCodexPoolHealth,
        expectedContext: TeamCodexRefreshContext? = nil
    ) {
        let snapshot = teamCodexConfigSnapshot()
        if let expectedContext,
           !teamCodexConfigWatchState.accepts(
               expectedContext,
               currentConfigSignature: snapshot?.signature
           ) {
            print("TEAMCODEX-STALE: 이전 config 응답 폐기")
            fflush(stdout)
            return
        }

        let aligned = snapshot.map {
            teamCodexPoolHealth(aligning: candidate, to: $0)
        } ?? candidate
        currentTeamCodex = aligned
        scheduleDashboardRefresh(reason: "commitTeamCodexHealth")
        updateTitle()
        print("TEAMCODEX-REFRESH: status=\(aligned.statusLabel) accounts=\(aligned.accounts.count) current=\(aligned.currentAccount ?? "-")")
        fflush(stdout)
    }

    func loadUsageInBackground() {
        // ccusage는 느릴 수 있으므로 단일 실행만 허용한다.
        // 상태 갱신(TeamClaude/Codex)은 위 loadFastStatusInBackground 에서 별도로 즉시 처리한다.
        guard !isFetching else {
            print("CCUSAGE-SKIP: 이전 사용량 갱신 진행 중, 상태 갱신만 반영")
            fflush(stdout)
            DispatchQueue.main.async { [weak self] in
                self?.updateTitle()
            }
            return
        }
        isFetching = true
        let startedAt = Date()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let dailyData = runCcusageRaw("daily") else {
                DispatchQueue.main.async {
                    self?.isFetching = false
                    self?.updateTitle()
                }
                return
            }

            let rate = fetchUsdKrwRate()
            if let quickData = parseUsageData(daily: dailyData, weekly: nil, monthly: nil, rate: rate) {
                print("CCUSAGE-QUICK: daily 반영 today=\(quickData.today?.period ?? "nil") cost=\(quickData.today?.totalCost ?? -1)")
                fflush(stdout)
                DispatchQueue.main.async {
                    self?.currentData = quickData
                    self?.scheduleDashboardRefresh(reason: "loadUsageInBackground")
                    self?.updateTitle()
                }
            }

            let weeklyData = runCcusageRaw("weekly")
            let monthlyData = runCcusageRaw("monthly")
            let data = parseUsageData(daily: dailyData, weekly: weeklyData, monthly: monthlyData, rate: rate)
            print("CCUSAGE-FULL: today=\(data?.today?.period ?? "nil") cost=\(data?.today?.totalCost ?? -1) thisMonth=\(data?.thisMonthCost ?? -1) rate=\(rate)")
            fflush(stdout)

            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isFetching = false
                self.lastFullUsageCompletedAt = Date()
                if let data = data {
                    var finalData = data
                    if let quickAt = self.lastUsageQuickCompletedAt,
                       quickAt > startedAt,
                       let currentToday = self.currentData?.today,
                       let parsedToday = data.today,
                       currentToday.period == parsedToday.period,
                       currentToday.totalCost > parsedToday.totalCost {
                        finalData = replacingToday(in: data, with: currentToday)
                        print("CCUSAGE-FULL-MERGE: quick today 유지 cost=\(currentToday.totalCost)")
                        fflush(stdout)
                    }
                    self.currentData = finalData // 실패 시 기존 데이터 유지 (깜빡임 방지)
                }
                self.scheduleDashboardRefresh(reason: "loadUsageInBackground")
                self.updateTitle()
            }
        }
    }

    func loadUsageQuickInBackground(reason: String) {
        guard !isFetchingUsageQuick else {
            print("CCUSAGE-QUICK-SKIP[\(reason)]: 이전 quick 사용량 갱신 진행 중")
            fflush(stdout)
            return
        }

        isFetchingUsageQuick = true
        let startedAt = Date()
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let dailyData = runCcusageRaw("daily") else {
                DispatchQueue.main.async {
                    self?.isFetchingUsageQuick = false
                    self?.updateTitle()
                }
                return
            }

            let rate = fetchUsdKrwRate()
            let quickData = parseUsageData(daily: dailyData, weekly: nil, monthly: nil, rate: rate)
            print("CCUSAGE-QUICK[\(reason)]: today=\(quickData?.today?.period ?? "nil") cost=\(quickData?.today?.totalCost ?? -1)")
            fflush(stdout)

            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isFetchingUsageQuick = false
                if let lastFull = self.lastFullUsageCompletedAt, lastFull > startedAt {
                    print("CCUSAGE-QUICK-DROP[\(reason)]: 더 최신 full 결과 유지")
                    fflush(stdout)
                    self.updateTitle()
                    return
                }
                if let quickData = quickData {
                    self.currentData = quickData
                    self.lastUsageQuickCompletedAt = Date()
                }
                self.scheduleDashboardRefresh(reason: "loadUsageQuickInBackground")
                self.updateTitle()
            }
        }
    }

    // MARK: - NSMenuDelegate

    func scheduleMenuPrewarm() {
        guard !hasScheduledMenuPrewarm else { return }
        hasScheduledMenuPrewarm = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self,
                  let menu = self.statusItem?.menu,
                  menu.items.isEmpty else {
                return
            }
            self.isPreparingMenuCache = true
            self.menuWillOpen(menu)
            self.menuDidClose(menu)
            self.isPreparingMenuCache = false
        }
    }

    func refreshMenuDetailText() -> String {
        if isFetchingUsageQuick { return "오늘 사용량 갱신 중" }
        if isFetching { return "전체 사용량 갱신 중" }
        if isRefreshingStatus { return "상태 갱신 중" }
        return "즉시 갱신"
    }

    func measureMenuDetailText() -> String {
        if isMeasuringTeamClaude { return teamClaudeMeasureDetail ?? "진행 중" }
        if let teamClaudeMeasureDetail { return teamClaudeMeasureDetail }

        let unmeasuredCount = currentTeamClaude?.measurementPendingCount ?? 0
        if unmeasuredCount > 0 { return "\(unmeasuredCount)개 지금 측정 가능" }

        let unavailableCount = currentTeamClaude?.measurementUnavailableCount ?? 0
        if unavailableCount > 0 { return "\(unavailableCount)개 상태 확인 필요" }

        let quotaLimitedCount = currentTeamClaude?.quotaLimitedCount ?? 0
        return quotaLimitedCount > 0
            ? "측정 완료 · \(quotaLimitedCount)개 라우팅 한도 대기"
            : "모든 계정 측정 완료"
    }

    /// 대시보드를 메뉴 항목에 올린다. 화면에 다 들어가면 그대로 항목 뷰가 되고, 넘치면 화면 높이만큼의
    /// NSScrollView 한 겹에 문서로 넣고 현재 섹션 이름을 말하는 고정 헤더를 띄운다(섹션별 상한은 없다).
    /// menuWillOpen의 재구성과 updateCachedMenuPresentation의 제자리 갱신이 같이 쓰는 유일한 호스팅 경로다.
    func hostDashboard(_ dashboard: StatusMenuDashboardView, in item: NSMenuItem, previousScrollOrigin: NSPoint?) {
        let screenVisibleHeight = statusItem?.button?.window?.screen?.visibleFrame.height
            ?? NSScreen.main?.visibleFrame.height
            ?? 900
        let actionAreaHeight = CGFloat(8) * MenuActionRowView.preferredHeight + 72
        let available = max(320, screenVisibleHeight - actionAreaHeight - 16)
        let contentHeight = dashboard.frame.height

        if contentHeight > available {
            // 이미 같은 대시보드를 같은 높이로 호스팅 중이면 다시 꽂지 않는다(문서 뷰 재할당·스크롤 복원은 매 갱신마다 필요 없다).
            if let existing = item.view as? NSScrollView,
               existing === dashboardScrollView,
               existing.documentView === dashboard,
               existing.frame.height == available {
                updatePinnedSectionHeader()
                return
            }
            let scrollView = (item.view as? NSScrollView) ?? NSScrollView(frame: .zero)
            if dashboardScrollView !== scrollView {
                installPinnedSectionHeader(in: scrollView)
            }
            scrollView.frame = NSRect(
                x: 0,
                y: 0,
                width: StatusMenuDashboardView.preferredWidth,
                height: available
            )
            scrollView.documentView = dashboard
            scrollView.hasVerticalScroller = true
            scrollView.autohidesScrollers = true
            scrollView.scrollerStyle = .overlay
            scrollView.drawsBackground = false
            scrollView.borderType = .noBorder
            scrollView.verticalScrollElasticity = .allowed
            if let previousScrollOrigin {
                let maximumY = max(0, contentHeight - scrollView.contentView.bounds.height)
                let restoredY = min(max(previousScrollOrigin.y, 0), maximumY)
                scrollView.contentView.scroll(to: NSPoint(x: previousScrollOrigin.x, y: restoredY))
            }
            item.view = scrollView
        } else {
            if let scrollView = item.view as? NSScrollView {
                scrollView.documentView = nil
            }
            removePinnedSectionHeader()
            dashboard.frame.origin = .zero
            item.view = dashboard
        }
        updatePinnedSectionHeader()
    }

    /// 스크롤 뷰 하나당 한 번: 고정 헤더를 floating subview로 얹고 clip view의 bounds 변화를 구독한다.
    /// 이전 스크롤 뷰의 구독은 여기서 푼다 — 구독 수명은 스크롤 뷰 수명과 같다(menuDidClose는 건드리지 않는다).
    private func installPinnedSectionHeader(in scrollView: NSScrollView) {
        removePinnedSectionHeader()
        let pinned = DashboardSectionHeaderView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: dashboardSectionHeaderHeight))
        pinned.isHidden = true
        scrollView.addFloatingSubview(pinned, for: .vertical)
        scrollView.contentView.postsBoundsChangedNotifications = true
        dashboardScrollObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification,
            object: scrollView.contentView,
            queue: nil
        ) { [weak self] _ in
            self?.updatePinnedSectionHeader()
        }
        pinnedSectionHeader = pinned
        dashboardScrollView = scrollView
    }

    private func removePinnedSectionHeader() {
        if let token = dashboardScrollObserver {
            NotificationCenter.default.removeObserver(token)
            dashboardScrollObserver = nil
        }
        pinnedSectionHeader?.removeFromSuperview()
        pinnedSectionHeader = nil
        dashboardScrollView = nil
    }

    /// 지금 스크롤 위치에서 고정 헤더가 말할 섹션을 정한다. 요약 카드가 위에 보이는 동안(nil)은 숨긴다.
    /// 호스팅 직후와 updateContent 뒤에도 불러 갱신이 낡은 제목을 남기지 않게 한다.
    func updatePinnedSectionHeader() {
        guard let pinned = pinnedSectionHeader,
              let scrollView = dashboardScrollView,
              let dashboard = scrollView.documentView as? StatusMenuDashboardView else {
            pinnedSectionHeader?.isHidden = true
            return
        }
        pinned.section = dashboardCurrentSection(dashboard.sections, scrollOffset: scrollView.contentView.bounds.origin.y)
        pinned.isHidden = (pinned.section == nil)
    }

    func updateCachedMenuPresentation() {
        guard let dashboard = cachedDashboardView,
              let dashboardItem = cachedDashboardItem else {
            return
        }
        let previousScrollOrigin = (dashboardItem.view as? NSScrollView)?.contentView.bounds.origin

        dashboard.updateContent(
            teamClaude: currentTeamClaude,
            codex: currentCodex,
            teamCodex: currentTeamCodex,
            usage: currentData,
            higgsfield: currentHiggsfield,
            grok: currentGrokCard,
            agy: currentAgyCard,
            burnModel: currentBurnModel,
            laneStaleNotes: laneStaleNotes,
            parallelCount: parallelCount,
            active: isActive,
            isMeasuringTeamClaude: isMeasuringTeamClaude,
            teamClaudeMeasureDetail: teamClaudeMeasureDetail,
            onMeasureTeamClaude: { [weak self] in self?.measureTeamClaudeAction() },
            onReauthenticateTeamClaude: { [weak self] name, accountUuid in
                self?.reauthenticateTeamClaudeAccount(name, expectedAccountUuid: accountUuid)
            },
            onRecoverTeamCodex: { [weak self] name, accountUuid, kind in
                self?.recoverTeamCodexAccount(name, expectedAccountUuid: accountUuid, kind: kind)
            }
        )

        let contentHeight = StatusMenuDashboardView.preferredHeight(
            teamClaude: currentTeamClaude,
            codex: currentCodex,
            teamCodex: currentTeamCodex,
            usage: currentData,
            higgsfield: currentHiggsfield,
            burnModel: currentBurnModel
        )
        dashboard.lastRefreshPhases?.mark("height")
        dashboard.frame.size.height = contentHeight
        dashboard.lastRefreshPhases?.mark("frame")
        hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: previousScrollOrigin)
        dashboard.lastRefreshPhases?.mark("host")

        refreshMenuView?.detail = refreshMenuDetailText()
        measureMenuView?.detail = measureMenuDetailText()
    }

    func menuWillOpen(_ menu: NSMenu) {
        let openedAt = ProcessInfo.processInfo.systemUptime
        let eventName = isPreparingMenuCache ? "MENU-PREWARM" : "MENU-OPEN"
        defer {
            let elapsedMs = Int((ProcessInfo.processInfo.systemUptime - openedAt) * 1_000)
            print("\(eventName): \(elapsedMs)ms")
            fflush(stdout)
        }

        if let cachedDashboardView,
           cachedDashboardItem != nil,
           !menu.items.isEmpty {
            flushPendingDashboardRefresh(reason: "menuWillOpen")
            openDashboardView = cachedDashboardView
            refreshMenuView?.detail = refreshMenuDetailText()
            measureMenuView?.detail = measureMenuDetailText()
            loadFastStatusInBackground()
            return
        }

        // 메뉴 열릴 때마다 최신 데이터로 항목 재구성
        menu.removeAllItems()

        let dashboardContentHeight = StatusMenuDashboardView.preferredHeight(teamClaude: currentTeamClaude, codex: currentCodex, teamCodex: currentTeamCodex, usage: currentData, higgsfield: currentHiggsfield, burnModel: currentBurnModel)
        let dashboard = StatusMenuDashboardView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: dashboardContentHeight))
        dashboard.onTeamRowsChange = { [weak self] in self?.scheduleDashboardRefresh(reason: "team-rows") }
        dashboard.configure(
            teamClaude: currentTeamClaude,
            codex: currentCodex,
            teamCodex: currentTeamCodex,
            usage: currentData,
            higgsfield: currentHiggsfield,
            grok: currentGrokCard,
            agy: currentAgyCard,
            burnModel: currentBurnModel,
            laneStaleNotes: laneStaleNotes,
            parallelCount: parallelCount,
            active: isActive,
            isMeasuringTeamClaude: isMeasuringTeamClaude,
            teamClaudeMeasureDetail: teamClaudeMeasureDetail,
            onMeasureTeamClaude: { [weak self] in self?.measureTeamClaudeAction() },
            onReauthenticateTeamClaude: { [weak self] name, accountUuid in
                self?.reauthenticateTeamClaudeAccount(name, expectedAccountUuid: accountUuid)
            },
            onRecoverTeamCodex: { [weak self] name, accountUuid, kind in
                self?.recoverTeamCodexAccount(name, expectedAccountUuid: accountUuid, kind: kind)
            }
        )
        openDashboardView = dashboard
        cachedDashboardView = dashboard
        let dashboardItem = NSMenuItem()
        hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: nil)
        menu.addItem(dashboardItem)
        cachedDashboardItem = dashboardItem

        let actionWidth = StatusMenuDashboardView.preferredWidth
        let green = NSColor(calibratedRed: 0.18, green: 0.82, blue: 0.48, alpha: 1.0)
        let blue = NSColor(calibratedRed: 0.28, green: 0.55, blue: 0.90, alpha: 1.0)
        let yellow = NSColor(calibratedRed: 0.93, green: 0.76, blue: 0.22, alpha: 1.0)
        let red = NSColor(calibratedRed: 0.96, green: 0.26, blue: 0.32, alpha: 1.0)

        let refreshItem = NSMenuItem(title: "새로고침", action: #selector(refreshAction), keyEquivalent: "r")
        refreshItem.target = self
        let refreshDetail = refreshMenuDetailText()
        let refreshView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "↻", symbolName: "arrow.clockwise", title: "새로고침", detail: refreshDetail, tone: green)
        refreshView.onClick = { [weak self, weak menu] in
            self?.refreshAction()
            menu?.cancelTracking()
        }
        refreshItem.view = refreshView
        menu.addItem(refreshItem)
        refreshMenuView = refreshView

        let measureDetail = measureMenuDetailText()
        let measureItem = NSMenuItem(title: "TeamClaude 계정 측정", action: #selector(measureTeamClaudeAction), keyEquivalent: "")
        measureItem.target = self
        let measureView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "◎", symbolName: "gauge", title: "TeamClaude 계정 측정", detail: measureDetail, tone: yellow)
        measureView.onClick = { [weak self, weak menu] in
            self?.measureTeamClaudeAction()
            menu?.cancelTracking()
        }
        measureItem.view = measureView
        menu.addItem(measureItem)
        measureMenuView = measureView

        let importItem = NSMenuItem(title: "Claude Code 계정 가져오기", action: #selector(importClaudeCodeAccountAction), keyEquivalent: "")
        importItem.target = self
        let importView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "↓", symbolName: "square.and.arrow.down", title: "Claude Code 계정 가져오기", detail: "현재 로그인", tone: green)
        importView.onClick = { [weak self, weak menu] in
            self?.importClaudeCodeAccountAction()
            menu?.cancelTracking()
        }
        importItem.view = importView
        menu.addItem(importItem)

        let loginItem = NSMenuItem(title: "Claude OAuth 계정 추가", action: #selector(addClaudeOAuthAccountAction), keyEquivalent: "")
        loginItem.target = self
        let loginView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "+", symbolName: "person.crop.circle.badge.plus", title: "Claude OAuth 계정 추가", detail: "브라우저", tone: blue)
        loginView.onClick = { [weak self, weak menu] in
            self?.addClaudeOAuthAccountAction()
            menu?.cancelTracking()
        }
        loginItem.view = loginView
        menu.addItem(loginItem)

        let codexLoginItem = NSMenuItem(title: "Codex OAuth 계정 추가", action: #selector(addCodexOAuthAccountAction), keyEquivalent: "")
        codexLoginItem.target = self
        let codexLoginView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "+", symbolName: "person.crop.circle.badge.plus", title: "Codex OAuth 계정 추가", detail: "브라우저", tone: blue)
        codexLoginView.onClick = { [weak self, weak menu] in
            self?.addCodexOAuthAccountAction()
            menu?.cancelTracking()
        }
        codexLoginItem.view = codexLoginView
        menu.addItem(codexLoginItem)

        let restartTeamClaudeItem = NSMenuItem(title: "TeamClaude 서버 재시작", action: #selector(restartTeamClaudeAction), keyEquivalent: "")
        restartTeamClaudeItem.target = self
        let restartTeamClaudeView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "⟳", symbolName: "arrow.triangle.2.circlepath", title: "TeamClaude 서버 재시작", detail: "계정 반영", tone: blue)
        restartTeamClaudeView.onClick = { [weak self, weak menu] in
            self?.restartTeamClaudeAction()
            menu?.cancelTracking()
        }
        restartTeamClaudeItem.view = restartTeamClaudeView
        menu.addItem(restartTeamClaudeItem)

        let quitItem = NSMenuItem(title: "종료", action: #selector(quitAction), keyEquivalent: "q")
        quitItem.target = self
        let quitView = MenuActionRowView(frame: NSRect(x: 0, y: 0, width: actionWidth, height: MenuActionRowView.preferredHeight), icon: "×", symbolName: "power", title: "종료", detail: "⌘Q", tone: red)
        quitView.onClick = { [weak self] in
            self?.quitAction()
        }
        quitItem.view = quitView
        menu.addItem(quitItem)

        // 메뉴가 열린 직후 서버 원본을 다시 읽고 위 dashboard를 실시간 갱신한다.
        loadFastStatusInBackground()
    }

    func menuDidClose(_ menu: NSMenu) {
        openDashboardView = nil
        // 아래에서 동기로 갱신하므로 열린 동안 잡혀 있던 0.3초 항목은 버린다(닫힌 뒤 한 번 더 도는 낭비 제거).
        pendingDashboardRefresh?.cancel()
        pendingDashboardRefresh = nil
        updateCachedMenuPresentation()
    }

    // MARK: - 액션

    @objc func refreshAction() {
        refreshInteractive()
    }

    func preferredTeamClaudeProbeModel() -> String {
        if let model = currentData?.modelBreakdown.first(where: { $0.provider == "Claude" && $0.model.lowercased().contains("fable") })?.model {
            return stripClaudeModelSuffix(model)
        }
        if let model = currentData?.modelBreakdown.first(where: { $0.provider == "Claude" })?.model,
           model.lowercased().hasPrefix("claude") {
            return stripClaudeModelSuffix(model)
        }
        if let model = currentData?.today?.models.first(where: { $0.lowercased().hasPrefix("claude") }) {
            return stripClaudeModelSuffix(model)
        }
        return "claude-fable-5"
    }

    @objc func measureTeamClaudeAction() {
        guard !isMeasuringTeamClaude else { return }
        let port = currentTeamClaude?.serverPort ?? 3456
        let model = preferredTeamClaudeProbeModel()
        let config = readTeamClaudeJSON("\(NSHomeDirectory())/.config/teamclaude.json")
        let proxyAuthorizationValue = tcString(tcDict(config?["proxy"])?["apiKey"])
        isMeasuringTeamClaude = true
        teamClaudeMeasureDetail = "OAuth 갱신 중"
        scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
        updateTitle()

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let refreshExit = refreshTeamClaudeOAuthAccounts()
            guard refreshExit == 0 else {
                DispatchQueue.main.async {
                    self?.isMeasuringTeamClaude = false
                    self?.teamClaudeMeasureDetail = "OAuth 갱신 실패"
                    self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                    self?.updateTitle()
                }
                return
            }

            DispatchQueue.main.async {
                self?.teamClaudeMeasureDetail = "서버 동기화 중"
                self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                self?.updateTitle()
            }
            _ = kickstartTeamClaudeServer()
            var serverReady = false
            for _ in 0..<10 {
                if loadTeamClaudeHealth().serverReachable {
                    serverReady = true
                    break
                }
                Thread.sleep(forTimeInterval: 1)
            }
            guard serverReady else {
                DispatchQueue.main.async {
                    self?.isMeasuringTeamClaude = false
                    self?.teamClaudeMeasureDetail = "서버 연결 실패"
                    self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                    self?.updateTitle()
                }
                return
            }

            DispatchQueue.main.async {
                self?.teamClaudeMeasureDetail = "계정 사용량 측정 중"
                self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                self?.updateTitle()
            }
            let exitCode = runTeamClaudeBareClaudeProbe(port: port, apiKey: proxyAuthorizationValue, model: model)
            let directStatus = exitCode == nil ? triggerTeamClaudeQuotaProbe(port: port, model: model) : nil
            print("TEAMCLAUDE-PROBE: refreshExit=\(refreshExit.map(String.init) ?? "nil") model=\(model) claudeExit=\(exitCode.map(String.init) ?? "nil") directStatus=\(directStatus.map(String.init) ?? "nil")")
            fflush(stdout)

            var teamClaude = loadTeamClaudeHealth()
            for _ in 0..<10 {
                let pending = teamClaude.measurementPendingCount
                if pending == 0 { break }
                Thread.sleep(forTimeInterval: 2)
                teamClaude = loadTeamClaudeHealth()
            }
            let pending = teamClaude.measurementPendingCount
            let unavailable = teamClaude.measurementUnavailableCount
            let quotaLimited = teamClaude.quotaLimitedCount
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.commitTeamClaudeHealth(teamClaude)
                self.isMeasuringTeamClaude = false
                if pending > 0 {
                    self.teamClaudeMeasureDetail = "\(pending)개 측정 실패 · 다시 시도"
                } else if unavailable > 0 {
                    self.teamClaudeMeasureDetail = "\(unavailable)개 상태 확인 필요"
                } else if quotaLimited > 0 {
                    self.teamClaudeMeasureDetail = "측정 완료 · \(quotaLimited)개 라우팅 한도 대기"
                } else {
                    self.teamClaudeMeasureDetail = "\(teamClaude.accounts.count)개 계정 측정 완료"
                }
                self.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                self.updateTitle()
                print("TEAMCLAUDE-MEASURE: pending=\(pending) unavailable=\(unavailable) quotaLimited=\(quotaLimited) result=\(self.teamClaudeMeasureDetail ?? "-")")
                fflush(stdout)
            }
        }
    }

    func openTeamClaudeTerminal(commandTitle: String, arguments: [String], codexMode: Bool = false) {
        let exe = codexMode ? resolveTeamCodexExecutable() : resolveTeamClaudeExecutable()
        let command = teamClaudeTerminalCommand(
            executable: exe,
            commandTitle: commandTitle,
            arguments: arguments,
            codexMode: codexMode
        )

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = [
            "-e", "tell application \"Terminal\" to activate",
            "-e", "tell application \"Terminal\" to do script \"\(escapeForAppleScriptString(command))\"",
        ]
        try? task.run()
    }

    func refreshAfterTeamClaudeRestart() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
            self?.refreshStatusOnly()
        }
    }

    func watchTeamClaudeConfigAfterExternalCommand(reason: String) {
        teamClaudeConfigWatchGeneration += 1
        let generation = teamClaudeConfigWatchGeneration
        let initialSignature = teamClaudeConfigSignature()
        let initialTopology = teamClaudeAccountTopologySignature()
        print("TEAMCLAUDE-WATCH: \(reason) 시작")
        fflush(stdout)

        DispatchQueue.global(qos: .utility).async { [weak self] in
            for attempt in 1...60 {
                Thread.sleep(forTimeInterval: 5)
                guard let self = self else { return }
                guard self.teamClaudeConfigWatchGeneration == generation else { return }

                let currentSignature = teamClaudeConfigSignature()
                if currentSignature != initialSignature {
                    let topologyChanged = teamClaudeAccountTopologySignature() != initialTopology
                    let teamClaude = loadTeamClaudeHealth()
                    print("TEAMCLAUDE-WATCH: 설정 변경 감지 attempt=\(attempt) topologyChanged=\(topologyChanged) drift=\(teamClaude.accountConfigDrift)")
                    fflush(stdout)
                    DispatchQueue.main.async {
                        guard self.teamClaudeConfigWatchGeneration == generation else { return }
                        self.commitTeamClaudeHealth(teamClaude)
                        if !topologyChanged || (teamClaude.accountConfigDrift > 0 && !self.isRefreshingTeamClaude) {
                            self.pendingTeamClaudeForcedSyncReason = "\(reason) 설정 변경"
                        }
                        self.refreshStatusOnly()
                        self.updateTitle()
                    }
                    return
                }

                if attempt % 6 == 0 {
                    let teamClaude = loadTeamClaudeHealth()
                    DispatchQueue.main.async {
                        guard self.teamClaudeConfigWatchGeneration == generation else { return }
                        self.commitTeamClaudeHealth(teamClaude)
                        self.updateTitle()
                    }
                }
            }
            print("TEAMCLAUDE-WATCH: \(reason) 변경 감지 없이 종료")
            fflush(stdout)
        }
    }

    func observeTeamCodexConfigChanges() {
        guard let snapshot = teamCodexConfigSnapshot(),
              let generation = teamCodexConfigWatchState.observe(snapshot) else {
            return
        }
        if let currentTeamCodex {
            self.currentTeamCodex = teamCodexPoolHealth(
                aligning: currentTeamCodex,
                to: snapshot
            )
            scheduleDashboardRefresh(reason: "observeTeamCodexConfigChanges")
            updateTitle()
        }
        print("TEAMCODEX-WATCH: 계정 구성 변경 감지 generation=\(generation)")
        fflush(stdout)
        scheduleTeamCodexConfigConvergence()
    }

    func scheduleTeamCodexConfigConvergence() {
        guard let snapshot = teamCodexConfigSnapshot() else { return }
        let refreshContext = teamCodexConfigWatchState.refreshContext(
            configSignature: snapshot.signature
        )
        guard teamCodexConfigRefreshCoordinator.request(
            generation: refreshContext.generation
        ) else {
            return
        }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            var teamCodex = autoreleasepool { loadTeamCodexPoolHealth() }
            for attempt in 0..<12 {
                let shouldContinue = DispatchQueue.main.sync { [weak self] in
                    self?.teamCodexConfigRefreshCoordinator.shouldContinue(
                        generation: refreshContext.generation
                    ) ?? false
                }
                if !shouldContinue {
                    break
                }
                if teamCodexTopologyMatches(snapshot: snapshot, pool: teamCodex) {
                    break
                }
                if attempt < 11 {
                    Thread.sleep(forTimeInterval: 0.25)
                    let shouldRetry = DispatchQueue.main.sync { [weak self] in
                        self?.teamCodexConfigRefreshCoordinator.shouldContinue(
                            generation: refreshContext.generation
                        ) ?? false
                    }
                    if !shouldRetry {
                        break
                    }
                    teamCodex = autoreleasepool { loadTeamCodexPoolHealth() }
                }
            }
            DispatchQueue.main.async {
                guard let self else { return }
                let shouldRunLatest = self.teamCodexConfigRefreshCoordinator.finish(
                    generation: refreshContext.generation
                )
                self.commitTeamCodexHealth(
                    teamCodex,
                    expectedContext: refreshContext
                )
                if shouldRunLatest {
                    self.scheduleTeamCodexConfigConvergence()
                }
            }
        }
    }

    @objc func importClaudeCodeAccountAction() {
        openTeamClaudeTerminal(commandTitle: "현재 Claude Code 로그인 계정 가져오기", arguments: ["import"])
        watchTeamClaudeConfigAfterExternalCommand(reason: "import")
    }

    @objc func addClaudeOAuthAccountAction() {
        openTeamClaudeTerminal(commandTitle: "Claude OAuth 계정 추가", arguments: ["login"])
        watchTeamClaudeConfigAfterExternalCommand(reason: "login")
    }

    func reauthenticateTeamClaudeAccount(_ name: String, expectedAccountUuid: String?) {
        let candidates = currentTeamClaude?.accounts.filter { row in
            expectedAccountUuid.map { row.accountUuid == $0 } ?? (row.name == name)
        } ?? []
        guard candidates.count == 1,
              let row = candidates.first,
              row.name == name,
              teamClaudeCanReauthenticate(
                  enabled: row.enabled,
                  status: row.status,
                  source: row.source,
                  provider: row.provider,
                  errorReason: row.errorReason
              ) else {
            print("TEAMCLAUDE-REAUTH: stale or ineligible account \(name)")
            fflush(stdout)
            return
        }
        var arguments = ["reauth", name]
        if let expectedAccountUuid { arguments.append(contentsOf: ["--account-uuid", expectedAccountUuid]) }
        openTeamClaudeTerminal(
            commandTitle: "Claude OAuth 재인증: \(name)",
            arguments: arguments
        )
        watchTeamClaudeConfigAfterExternalCommand(reason: "reauth \(name)")
    }

    /// 풀에서 빠진 Codex 계정을 그 자리에서 되돌린다.
    /// 화면의 행은 낡았을 수 있으므로 인자를 그대로 믿지 않고 현재 상태에서 다시 판정한다.
    func recoverTeamCodexAccount(
        _ name: String,
        expectedAccountUuid: String?,
        kind: TeamCodexAccountRecoveryKind
    ) {
        let accounts = currentTeamCodex?.accounts ?? []
        let candidates = accounts.filter { row in
            expectedAccountUuid.map { row.accountUuid == $0 } ?? (row.name == name)
        }
        guard candidates.count == 1,
              let row = candidates.first,
              row.name == name,
              let recovery = teamCodexAccountRecovery(row),
              recovery.kind == kind else {
            print("TEAMCODEX-RECOVER: stale or ineligible account (kind=\(kind))")
            fflush(stdout)
            return
        }
        // enable은 CLI가 이름으로만 계정을 찾는다(--account-uuid 없음).
        // 같은 이름이 둘이면 어느 쪽이 바뀔지 알 수 없으므로 실행하지 않는다.
        if recovery.kind == .enable, accounts.filter({ $0.name == name }).count != 1 {
            print("TEAMCODEX-RECOVER: ambiguous account name for enable")
            fflush(stdout)
            return
        }
        let title = recovery.kind == .enable
            ? "Codex 계정 다시 켜기"
            : "Codex OAuth 재인증"
        openTeamClaudeTerminal(
            commandTitle: title,
            arguments: recovery.arguments,
            codexMode: true
        )
        // 별도 감시를 걸지 않는다. teamcodex.json 구성 변경은 tick()의
        // observeTeamCodexConfigChanges()가 1초마다, 프록시 status 변화는 statusTimer가
        // 10초마다 이미 본다. 재인증은 토폴로지를 바꾸지 않으므로 status 폴링이 담당한다.
        print("TEAMCODEX-RECOVER: \(recovery.kind) 명령 실행, 설정·상태 감시로 반영 대기")
        fflush(stdout)
    }

    @objc func addCodexOAuthAccountAction() {
        openTeamClaudeTerminal(
            commandTitle: "Codex OAuth 계정 추가",
            arguments: ["codex", "login"],
            codexMode: true
        )
    }

    @objc func restartTeamClaudeAction() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            _ = kickstartTeamClaudeServer()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self?.refreshStatusOnly()
            }
        }
    }

    @objc func quitAction() {
        dataTimer?.invalidate()
        rollTimer?.invalidate()
        activityTimer?.invalidate()
        NSApp.terminate(nil)
    }
}

// MARK: - 진입점

// 크래시 기록기는 어떤 CLI 분기보다 먼저, 한 번만 설치한다 (모든 오프스크린 렌더 경로가 브레드크럼을 남긴다).
installCrashRecorder()

if let summaryIndex = CommandLine.arguments.firstIndex(of: "--availability-summary-snapshot") {
    let outputPath = CommandLine.arguments.indices.contains(summaryIndex + 1)
        ? CommandLine.arguments[summaryIndex + 1]
        : "/tmp/cc-availability-summary.png"
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let view = ServiceAvailabilitySummaryView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: ServiceAvailabilitySummaryView.preferredHeight))
    view.teamClaude = loadTeamClaudeHealth()
    view.teamCodex = loadTeamCodexPoolHealth()
    view.evaluatedAt = Date()
    view.layoutSubtreeIfNeeded()
    guard let image = view.bitmapImageRepForCachingDisplay(in: view.bounds),
          let data = ({ view.cacheDisplay(in: view.bounds, to: image); return image.representation(using: .png, properties: [:]) })() else {
        fputs("AVAILABILITY-SUMMARY: PNG 생성 실패\n", stderr)
        exit(1)
    }
    do {
        try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        print("AVAILABILITY-SUMMARY: \(outputPath)")
        exit(0)
    } catch {
        fputs("AVAILABILITY-SUMMARY: \(error)\n", stderr)
        exit(1)
    }
}

if CommandLine.arguments.contains("--account-subscription-qa") || CommandLine.arguments.contains("--reset-credits-qa") {
    let app = NSApplication.shared
    app.setActivationPolicy(.regular)
    let resetQA = CommandLine.arguments.contains("--reset-credits-qa")
    let now = Date()
    let pool = TeamCodexPoolHealth(
        checkedAt: Date(), serverReachable: true, serverPort: 3457, serverPid: nil,
        currentAccount: nil, currentAccountUuid: nil, switchThresholdPercent: 98,
        accounts: (0..<(resetQA ? 12 : 3)).map { index in
            TeamCodexPoolAccount(name: "테스트 계정 \(index + 1)", accountUuid: "subscription-qa-\(index)",
                                 isCurrent: index == 0, enabled: index != 3, status: index == 5 ? "error" : "active", errorReason: index == 5 ? "auth-revoked" : nil,
                                 usableFromProxy: index == 0, sessionPercent: 15, sessionResetAt: now.addingTimeInterval(3600),
                                 weeklyPercent: index == 1 ? 100 : 30, weeklyResetAt: now.addingTimeInterval(86400), inflight: 0, maxConcurrent: 3,
                                 totalRequests: 12, totalTokens: 40000, subscriptionState: index == 4 ? "ended" : nil,
                                 planType: index == 0 ? "pro" : "plus", accountType: "oauth", providerName: "codex",
                                 codexResetCredits: index == 2 ? nil : (index == 1 ? 0 : 3),
                                 codexResetCreditsAt: index == 6 ? now.addingTimeInterval(-601) : now)
        }, resetCreditsEnabled: true, resetCreditsPolicy: "account"
    )
    let view = CodexStatusView(frame: NSRect(x: 0, y: 0, width: 880, height: CodexStatusView.preferredHeight(for: pool)))
    view.pool = pool
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 880, height: min(view.bounds.height, 720)), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = resetQA ? "계정별 리셋권 검증" : "계정 구독 표시 검증"
    let scroll = NSScrollView(frame: window.contentView!.bounds)
    scroll.hasVerticalScroller = true
    scroll.documentView = view
    window.contentView = scroll
    window.center()
    window.makeKeyAndOrderFront(nil)
    app.activate(ignoringOtherApps: true)
    view.layoutSubtreeIfNeeded()
    let buttons = view.subviews.compactMap { $0 as? AccountSubscriptionButton }
    precondition(buttons.count == pool.accounts.count)
    for pair in zip(buttons, buttons.dropFirst()) { precondition(!pair.0.frame.intersects(pair.1.frame)) }
    if let image = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
        view.cacheDisplay(in: view.bounds, to: image)
        if let data = image.representation(using: .png, properties: [:]) {
            try? data.write(to: URL(fileURLWithPath: resetQA ? "/tmp/cc-reset-credits-qa.png" : "/tmp/cc-subscription-qa.png"))
        }
    }
    app.run()
    exit(0)
}

if CommandLine.arguments.contains("--teamcodex-dashboard-selftest") {
    func pool(_ count: Int) -> TeamCodexPoolHealth {
        TeamCodexPoolHealth(
            checkedAt: Date(),
            serverReachable: true,
            serverPort: 3457,
            serverPid: nil,
            currentAccount: count > 0 ? "account-0" : nil,
            currentAccountUuid: count > 0 ? "uuid-0" : nil,
            switchThresholdPercent: 98,
            accounts: (0..<count).map { index in
                TeamCodexPoolAccount(
                    name: "account-\(index)",
                    accountUuid: "uuid-\(index)",
                    isCurrent: index == 0,
                    enabled: true,
                    status: index == 0 ? "active" : "available",
                    errorReason: nil,
                    usableFromProxy: nil,
                    sessionPercent: nil,
                    sessionResetAt: nil,
                    weeklyPercent: nil,
                    weeklyResetAt: nil,
                    inflight: 0,
                    maxConcurrent: 3,
                    totalRequests: 0,
                    totalTokens: 0
                )
            }
        )
    }

    func snapshot(_ count: Int, signature: Int) -> TeamCodexConfigSnapshot {
        TeamCodexConfigSnapshot(
            signature: signature,
            accounts: (0..<count).map {
                TeamCodexConfiguredAccount(
                    name: "account-\($0)",
                    accountUuid: "uuid-\($0)",
                    enabled: true
                )
            }
        )
    }

    func account(
        _ name: String,
        uuid: String?,
        current: Bool = false,
        requests: Int = 7
    ) -> TeamCodexPoolAccount {
        TeamCodexPoolAccount(
            name: name,
            accountUuid: uuid,
            isCurrent: current,
            enabled: true,
            status: current ? "active" : "available",
            errorReason: nil,
            usableFromProxy: nil,
            sessionPercent: nil,
            sessionResetAt: nil,
            weeklyPercent: nil,
            weeklyResetAt: nil,
            inflight: 0,
            maxConcurrent: 3,
            totalRequests: requests,
            totalTokens: 0
        )
    }

    func pool(
        accounts: [TeamCodexPoolAccount],
        currentAccount: String?,
        currentAccountUuid: String?
    ) -> TeamCodexPoolHealth {
        TeamCodexPoolHealth(
            checkedAt: Date(),
            serverReachable: true,
            serverPort: 3457,
            serverPid: nil,
            currentAccount: currentAccount,
            currentAccountUuid: currentAccountUuid,
            switchThresholdPercent: 98,
            accounts: accounts
        )
    }

    for count in 0...32 {
        let health = pool(count)
        precondition(CodexStatusView.poolRowCount(for: health) == count)
        precondition(
            CodexStatusView.poolSectionHeight(for: health)
                == 112 + CGFloat(max(1, count)) * 56
        )
    }

    var creditAccount = account("account-0", uuid: "uuid-0")
    creditAccount.codexResetCredits = 3
    creditAccount.codexResetCreditsAt = Date()
    var creditPool = pool(accounts: [creditAccount], currentAccount: nil, currentAccountUuid: nil)
    creditPool.resetCreditsEnabled = true
    creditPool.resetCreditsPolicy = "account"
    creditPool.runtimeSummary = "빌드 abcdef012345 · 재시작 1회"
    let creditAligned = teamCodexPoolHealth(aligning: creditPool, to: snapshot(2, signature: 100))
    precondition(creditAligned.accounts[0].codexResetCredits == 3)
    precondition(creditAligned.accounts[0].codexResetCreditsAt == creditAccount.codexResetCreditsAt)
    precondition(creditAligned.accounts[1].codexResetCredits == nil)
    precondition(creditAligned.resetCreditsPolicy == "account" && creditAligned.resetCreditsEnabled == true)
    precondition(creditAligned.runtimeSummary == "빌드 abcdef012345 · 재시작 1회")

    _ = NSApplication.shared
    func verifySubscriptionLayout(_ view: NSView, count: Int) {
        view.layoutSubtreeIfNeeded()
        let subscriptions = view.subviews.compactMap { $0 as? AccountSubscriptionButton }
        precondition(subscriptions.count == count)
        for button in subscriptions {
            precondition(view.bounds.contains(button.frame))
            precondition(button.attributedTitle.size().width < button.frame.width)
            precondition(button.accessibilityLabel()?.contains("결제일") == true)
            for other in view.subviews.compactMap({ $0 as? NSButton }) where other !== button {
                precondition(!button.frame.intersects(other.frame))
            }
        }
    }
    let codexLayoutPool = pool(32)
    let codexLayout = CodexStatusView(frame: NSRect(x: 0, y: 0, width: 880, height: CodexStatusView.preferredHeight(for: codexLayoutPool)))
    codexLayout.pool = codexLayoutPool
    verifySubscriptionLayout(codexLayout, count: 32)
    let claudeRows = (0..<16).map { index in
        TeamClaudeAccountHealth(name: "subscription-layout-\(index)", isCurrent: false, enabled: true, isUsable: false,
            status: "error", errorReason: "auth-expired", provider: "anthropic", accountUuid: "subscription-layout-\(index)",
            source: "oauth", totalTokens: 0, totalRequests: 0, sessionPercent: nil, sessionResetSeconds: nil,
            weeklyPercent: nil, weeklyResetSeconds: nil, fablePercent: nil, fableResetSeconds: nil, probedAt: nil, measurementIssue: nil)
    }
    let claudeLayoutHealth = TeamClaudeHealth(checkedAt: Date(), overallStatus: "warning", configPresent: true,
        serverReachable: true, serverPort: 3456, serverPid: nil, accountTotal: 16, accountConfigured: 16,
        accountActive: 0, accountUsable: 0, accountThrottled: 0, accountExhausted: 0, accountError: 16,
        accountDisabled: 0, accountConfigDrift: 0, inflight: 0, capacity: 48, fableKnown: 0, fableOver: 0,
        fableMaxPercent: nil, fableAvgPercent: nil, quotaThresholdPercent: 98, retryAfterSeconds: nil,
        accounts: claudeRows, hints: [], host: nil)
    let claudeLayout = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: 880, height: StatusMenuDashboardView.teamContentHeight(claudeLayoutHealth)))
    claudeLayout.health = claudeLayoutHealth
    verifySubscriptionLayout(claudeLayout, count: 16)
    let scrollCheck = NSScrollView(frame: NSRect(x: 0, y: 0, width: 880, height: 400))
    scrollCheck.documentView = claudeLayout
    scrollCheck.contentView.scroll(to: NSPoint(x: 0, y: claudeLayout.bounds.height - 400))
    precondition(scrollCheck.contentView.bounds.maxY >= claudeLayout.subviews.compactMap { $0 as? AccountSubscriptionButton }.last!.frame.maxY)
    print("SUBSCRIPTION-LAYOUT: Claude16/Codex32 bounds, widths, recovery overlap, accessibility and scroll end passed")
    let transitions = [0, 1, 4, 5, 4, 8, 0]
    let initial = pool(transitions[0])
    let dashboard = StatusMenuDashboardView(frame: NSRect(
        x: 0,
        y: 0,
        width: StatusMenuDashboardView.preferredWidth,
        height: StatusMenuDashboardView.preferredHeight(
            teamClaude: nil,
            codex: nil,
            teamCodex: initial,
            usage: nil,
            higgsfield: nil,
            burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: [])
        )
    ))
    dashboard.configure(
        teamClaude: nil,
        codex: nil,
        teamCodex: initial,
        usage: nil,
        burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
        parallelCount: 0,
        active: false,
        isMeasuringTeamClaude: false,
        teamClaudeMeasureDetail: nil,
        onMeasureTeamClaude: nil
    )
    for count in transitions.dropFirst() {
        let health = pool(count)
        dashboard.updateContent(
            teamClaude: nil,
            codex: nil,
            teamCodex: health,
            usage: nil,
            burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
            parallelCount: 0,
            active: false,
            isMeasuringTeamClaude: false,
            teamClaudeMeasureDetail: nil,
            onMeasureTeamClaude: nil
        )
        precondition(
            dashboard.frame.height == StatusMenuDashboardView.preferredHeight(
                teamClaude: nil,
                codex: nil,
                teamCodex: health,
                usage: nil,
                higgsfield: nil,
                burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: [])
            )
        )
    }

    var watchState = TeamCodexConfigWatchState()
    watchState.seed(snapshot(0, signature: 100))
    let addGeneration = watchState.observe(snapshot(1, signature: 101))
    let staleAddContext = watchState.refreshContext(configSignature: 101)
    let removeGeneration = watchState.observe(snapshot(0, signature: 102))
    guard let addGeneration, let removeGeneration else {
        preconditionFailure("Rapid add/remove must advance config generations")
    }
    precondition(addGeneration < removeGeneration)
    precondition(
        !watchState.accepts(
            staleAddContext,
            currentConfigSignature: 102
        )
    )
    let latestContext = watchState.refreshContext(configSignature: 102)
    precondition(
        watchState.accepts(
            latestContext,
            currentConfigSignature: 102
        )
    )
    var missingConfigState = TeamCodexConfigWatchState()
    precondition(missingConfigState.observe(snapshot(1, signature: 101)) == 1)

    let missingHome = FileManager.default.temporaryDirectory
        .appendingPathComponent("cc-menubar-teamcodex-missing-\(UUID().uuidString)")
    try FileManager.default.createDirectory(
        at: missingHome,
        withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: missingHome) }
    guard let missingSnapshot = teamCodexConfigSnapshot(home: missingHome.path) else {
        preconditionFailure("A missing TeamCodex config must be observed as an empty fleet")
    }
    precondition(missingSnapshot.accounts.isEmpty)
    var removedConfigState = TeamCodexConfigWatchState()
    removedConfigState.seed(snapshot(1, signature: 600))
    precondition(removedConfigState.observe(missingSnapshot) == 1)

    let legacyHome = FileManager.default.temporaryDirectory
        .appendingPathComponent("cc-menubar-teamcodex-legacy-\(UUID().uuidString)")
    let legacyConfigDirectory = legacyHome.appendingPathComponent(".config")
    let legacyConfigURL = legacyConfigDirectory.appendingPathComponent("teamcodex.json")
    try FileManager.default.createDirectory(
        at: legacyConfigDirectory,
        withIntermediateDirectories: true
    )
    defer { try? FileManager.default.removeItem(at: legacyHome) }
    let legacyAData = try JSONSerialization.data(withJSONObject: [
        "accounts": [["name": "legacy", "accountId": "legacy-a"]],
    ])
    try legacyAData.write(to: legacyConfigURL)
    guard let legacyA = teamCodexConfigSnapshot(home: legacyHome.path) else {
        preconditionFailure("A legacy accountId-only config must produce a snapshot")
    }
    precondition(legacyA.accounts.first?.accountUuid == "legacy-a")
    let legacyBData = try JSONSerialization.data(withJSONObject: [
        "accounts": [["name": "legacy", "accountId": "legacy-b"]],
    ])
    try legacyBData.write(to: legacyConfigURL)
    guard let legacyB = teamCodexConfigSnapshot(home: legacyHome.path) else {
        preconditionFailure("A replaced legacy accountId-only config must produce a snapshot")
    }
    precondition(legacyB.accounts.first?.accountUuid == "legacy-b")
    var legacyConfigState = TeamCodexConfigWatchState()
    legacyConfigState.seed(legacyA)
    precondition(legacyConfigState.observe(legacyB) == 1)

    let typedConfigData = try JSONSerialization.data(withJSONObject: [
        "accounts": [[
            "name": "typed",
            "accountUuid": "typed-uuid",
            "type": "oauth",
            "provider": "codex",
            "enabled": false,
        ]],
    ])
    try typedConfigData.write(to: legacyConfigURL)
    guard let typedSnapshot = teamCodexConfigSnapshot(home: legacyHome.path) else {
        preconditionFailure("A typed TeamCodex config must produce a snapshot")
    }
    precondition(typedSnapshot.accounts.first?.accountType == "oauth")
    precondition(typedSnapshot.accounts.first?.providerName == "codex")

    var convergenceCoordinator = TeamCodexConfigRefreshCoordinator()
    precondition(convergenceCoordinator.request(generation: 1))
    precondition(convergenceCoordinator.shouldContinue(generation: 1))
    precondition(!convergenceCoordinator.request(generation: 2))
    precondition(!convergenceCoordinator.request(generation: 3))
    precondition(!convergenceCoordinator.shouldContinue(generation: 1))
    precondition(convergenceCoordinator.finish(generation: 1))
    precondition(convergenceCoordinator.request(generation: 3))
    precondition(convergenceCoordinator.shouldContinue(generation: 3))
    precondition(!convergenceCoordinator.finish(generation: 3))

    let codexLoginCommand = teamClaudeTerminalCommand(
        executable: "/tmp/teamclaude",
        commandTitle: "Codex OAuth 계정 추가",
        arguments: ["codex", "login"],
        codexMode: true
    )
    precondition(!codexLoginCommand.contains("status=$?"))
    precondition(!codexLoginCommand.contains("launchctl kickstart"))
    let claudeLoginCommand = teamClaudeTerminalCommand(
        executable: "/tmp/teamclaude",
        commandTitle: "Claude OAuth 계정 추가",
        arguments: ["login"],
        codexMode: false
    )
    precondition(claudeLoginCommand.contains("exit_code=$?"))
    // codex 명령은 서버를 다시 띄우지 않는다. CLI가 "teamcodex restart"를 요구하는 줄을
    // 찍는 바로 그 화면에서 앱이 "자동 반영됩니다"라고 덮어쓰면 안 된다.
    precondition(!codexLoginCommand.contains("완료되면 상태바에 자동 반영됩니다."))
    precondition(codexLoginCommand.contains("teamcodex restart가 필요합니다"))
    precondition(claudeLoginCommand.contains("완료되면 상태바에 자동 반영됩니다."))
    let codexEnableCommand = teamClaudeTerminalCommand(
        executable: "/tmp/teamcodex",
        commandTitle: "Codex 계정 다시 켜기",
        arguments: ["codex", "enable", "off@example.com"],
        codexMode: true
    )
    precondition(!codexEnableCommand.contains("완료되면 상태바에 자동 반영됩니다."))
    precondition(codexEnableCommand.contains("teamcodex restart가 필요합니다"))

    // 프록시가 꺼져 config-only 행으로 떨어져도 다시 켜기 버튼이 살아 있어야 한다.
    // 오프라인인 순간이 바로 계정을 다시 켜고 싶은 순간이다.
    let offlineSnapshot = TeamCodexConfigSnapshot(
        signature: 700,
        accounts: [
            TeamCodexConfiguredAccount(
                name: "off@example.com",
                accountUuid: "uuid-off",
                enabled: false,
                accountType: "oauth",
                providerName: "codex"
            ),
        ]
    )
    let offlineAligned = teamCodexPoolHealth(aligning: pool(0), to: offlineSnapshot)
    precondition(offlineAligned.accounts.count == 1)
    precondition(offlineAligned.accounts[0].accountType == "oauth")
    precondition(offlineAligned.accounts[0].providerName == "codex")
    precondition(offlineAligned.accounts[0].status == "disabled")
    precondition(teamCodexAccountRecovery(offlineAligned.accounts[0])?.kind == .enable)
    precondition(teamCodexTopologyMatches(snapshot: offlineSnapshot, pool: offlineAligned))

    for (liveCount, configuredCount) in [(0, 1), (4, 5), (5, 4), (8, 0)] {
        let configured = snapshot(configuredCount, signature: configuredCount)
        let aligned = teamCodexPoolHealth(aligning: pool(liveCount), to: configured)
        precondition(aligned.accounts.count == configuredCount)
        precondition(teamCodexTopologyMatches(snapshot: configured, pool: aligned))
    }
    let replacement = TeamCodexConfigSnapshot(
        signature: 500,
        accounts: [
            TeamCodexConfiguredAccount(
                name: "account-0",
                accountUuid: "uuid-replacement",
                enabled: true
            ),
        ]
    )
    let replaced = teamCodexPoolHealth(aligning: pool(1), to: replacement)
    precondition(replaced.accounts[0].accountUuid == "uuid-replacement")
    precondition(replaced.accounts[0].status == "configured")
    precondition(replaced.currentAccount == nil)
    precondition(replaced.currentAccountUuid == nil)
    let mixedSnapshot = TeamCodexConfigSnapshot(
        signature: 501,
        accounts: [
            TeamCodexConfiguredAccount(name: "a", accountUuid: "uuid-a", enabled: true),
            TeamCodexConfiguredAccount(name: "b", accountUuid: "uuid-b", enabled: true),
        ]
    )
    let mixed = teamCodexPoolHealth(
        aligning: pool(
            accounts: [
                account("a", uuid: "uuid-a"),
                account("b", uuid: nil, current: true, requests: 9),
            ],
            currentAccount: "b",
            currentAccountUuid: nil
        ),
        to: mixedSnapshot
    )
    precondition(mixed.accounts[1].accountUuid == "uuid-b")
    precondition(mixed.accounts[1].totalRequests == 9)
    precondition(mixed.currentAccount == "b")

    let duplicateSnapshot = TeamCodexConfigSnapshot(
        signature: 502,
        accounts: [
            TeamCodexConfiguredAccount(name: "duplicate", accountUuid: nil, enabled: true),
            TeamCodexConfiguredAccount(name: "duplicate", accountUuid: nil, enabled: true),
        ]
    )
    let duplicate = teamCodexPoolHealth(
        aligning: pool(
            accounts: [
                account("duplicate", uuid: nil, current: true),
                account("duplicate", uuid: nil, current: true),
            ],
            currentAccount: "duplicate",
            currentAccountUuid: nil
        ),
        to: duplicateSnapshot
    )
    precondition(duplicate.accounts.allSatisfy { $0.status == "configured" })
    precondition(duplicate.accounts.allSatisfy { !$0.isCurrent })
    precondition(duplicate.currentAccount == nil)

    let duplicateUuidSnapshot = TeamCodexConfigSnapshot(
        signature: 503,
        accounts: [
            TeamCodexConfiguredAccount(name: "first", accountUuid: "duplicate-uuid", enabled: true),
            TeamCodexConfiguredAccount(name: "second", accountUuid: "duplicate-uuid", enabled: true),
        ]
    )
    let duplicateUuid = teamCodexPoolHealth(
        aligning: pool(
            accounts: [
                account("first", uuid: "duplicate-uuid", current: true),
                account("second", uuid: "duplicate-uuid", current: true),
            ],
            currentAccount: "first",
            currentAccountUuid: "duplicate-uuid"
        ),
        to: duplicateUuidSnapshot
    )
    precondition(duplicateUuid.accounts.allSatisfy { $0.status == "configured" })
    precondition(duplicateUuid.accounts.allSatisfy { !$0.isCurrent })
    precondition(duplicateUuid.currentAccount == nil)
    precondition(duplicateUuid.currentAccountUuid == nil)

    print("TEAMCODEX-DASHBOARD-SELFTEST: transitions, missing config, legacy accountId replacement, typed config-only recovery, terminal follow-up wording, single-flight convergence, shell, UUID/legacy/mixed/duplicate-name/duplicate-UUID identity, 0...32 heights passed")
    exit(0)
}

// 진단: 실제 프록시·설정 데이터로 되돌리기 버튼이 어느 행 어느 좌표에 앉는지 출력한다.
// 좌표를 문서에 손으로 적지 않고 실측하기 위한 출력이다(그리기 경로와 같은 layout()을 쓴다).
if let recoveryLayoutIndex = CommandLine.arguments.firstIndex(of: "--teamcodex-recovery-layout") {
    // 화면과 같은 데이터를 본다. commitTeamCodexHealth와 마찬가지로 설정 파일에 정렬한다.
    let live = loadTeamCodexPoolHealth()
    let pool = teamCodexConfigSnapshot().map {
        teamCodexPoolHealth(aligning: live, to: $0)
    } ?? live
    let view = CodexStatusView(frame: NSRect(
        x: 0,
        y: 0,
        width: StatusMenuDashboardView.preferredWidth,
        height: CodexStatusView.preferredHeight(for: pool)
    ))
    view.pool = pool
    view.layoutSubtreeIfNeeded()
    let buttons = view.subviews.compactMap { $0 as? NSButton }
    let noteFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    print("TEAMCODEX-RECOVERY-LAYOUT: width=\(Int(StatusMenuDashboardView.preferredWidth)) reachable=\(pool.serverReachable) accounts=\(pool.accounts.count) buttons=\(buttons.count)")
    for (index, account) in pool.accounts.enumerated() {
        let state = teamCodexAccountStatusLabel(
            account,
            switchThresholdPercent: pool.switchThresholdPercent,
            now: pool.checkedAt
        )
        guard let recovery = teamCodexAccountRecovery(account, now: pool.checkedAt) else {
            print("  [\(index)] \(account.name) | \(state) | 버튼 없음")
            continue
        }
        let button = buttons.first { $0.accessibilityLabel() == recovery.accessibilityLabel }
        let frame = button?.frame ?? .zero
        let titleWidth = recovery.title.size(withAttributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ]).width
        let noteWidth = recovery.followUpNote.map {
            $0.size(withAttributes: [.font: noteFont]).width
        } ?? 0
        let drawsResetCountdown = !account.isPermanentlyOut(now: pool.checkedAt)
        print("  [\(index)] \(account.name) | \(state) | \(recovery.kind) \"\(recovery.title)\" | x=\(Int(frame.minX)) y=\(Int(frame.minY)) w=\(Int(frame.width)) h=\(Int(frame.height)) 제목폭=\(Int(titleWidth.rounded())) | 보조줄=\(recovery.followUpNote == nil ? "없음" : "폭 \(Int(noteWidth.rounded()))") 카운트다운=\(drawsResetCountdown ? "그림" : "안그림")")
    }
    // 경로를 주면 같은 뷰를 PNG로 남긴다. 로컬 사용량(38GB 세션 로그 스캔)은 부르지 않으므로
    // 풀 표만 즉시 렌더된다 — 버튼과 보조줄이 실제로 겹치지 않는지 눈으로 확인하는 용도다.
    if CommandLine.arguments.indices.contains(recoveryLayoutIndex + 1) {
        let outputPath = CommandLine.arguments[recoveryLayoutIndex + 1]
        guard let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            fputs("TEAMCODEX-RECOVERY-LAYOUT: bitmap 생성 실패\n", stderr)
            exit(1)
        }
        view.cacheDisplay(in: view.bounds, to: representation)
        guard let data = representation.representation(using: .png, properties: [:]) else {
            fputs("TEAMCODEX-RECOVERY-LAYOUT: PNG 변환 실패\n", stderr)
            exit(1)
        }
        do {
            try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
            print("TEAMCODEX-RECOVERY-LAYOUT: \(outputPath)")
        } catch {
            fputs("TEAMCODEX-RECOVERY-LAYOUT: \(error)\n", stderr)
            exit(1)
        }
    }
    exit(0)
}

// 대시보드 한 장을 통째로 오프스크린 렌더한다. 메뉴는 스크립트로 열 수 없어서, 화면을 고쳐 가며
// 눈으로 비교하려면 이 경로가 필요하다. 표 전용 스냅샷(--teamclaude-table-snapshot)의 확장판이다.
if let dashIndex = CommandLine.arguments.firstIndex(of: "--dashboard-snapshot") {
    guard CommandLine.arguments.indices.contains(dashIndex + 1) else {
        fputs("DASHBOARD-SNAPSHOT: usage --dashboard-snapshot <status.json> [out.png]\n", stderr)
        exit(2)
    }
    let fixturePath = CommandLine.arguments[dashIndex + 1]
    let outputPath = CommandLine.arguments.indices.contains(dashIndex + 2)
        ? CommandLine.arguments[dashIndex + 2]
        : "/tmp/cc-menubar-dashboard.png"
    guard let fixtureData = FileManager.default.contents(atPath: fixturePath),
          let fixture = (try? JSONSerialization.jsonObject(with: fixtureData)) as? [String: Any] else {
        fputs("DASHBOARD-SNAPSHOT: fixture 읽기 실패 \(fixturePath)\n", stderr)
        exit(1)
    }
    _ = NSApplication.shared
    let burnModel = subscriptionBurnFixture(fixture["burn"] as? [String: Any])
    let health = (fixture["teamclaude"] as? [String: Any]).map {
        parseTeamClaudeHealth(config: nil, server: nil, status: $0, port: 3456)
    }
    // 힉스필드 카드는 픽스처에 크레딧이 있을 때만 그린다. 지연 표시처럼 실패했을 때만
    // 나타나는 화면은 스냅샷이 다루지 않으면 눈으로 확인된 적이 없는 상태로 남는다.
    let higgsfield = (fixture["higgsfieldCredits"] as? NSNumber).map {
        HiggsfieldCreditsData(credits: $0.doubleValue, planType: fixture["higgsfieldPlan"] as? String,
                              email: nil, transactions: [], checkedAt: Date(),
                              error: nil, partialError: nil)
    }
    let view = StatusMenuDashboardView(frame: NSRect(
        x: 0, y: 0,
        width: StatusMenuDashboardView.preferredWidth,
        height: StatusMenuDashboardView.preferredHeight(
            teamClaude: health, codex: nil, teamCodex: nil, usage: nil,
            higgsfield: higgsfield, burnModel: burnModel
        )
    ))
    view.configure(
        teamClaude: health, codex: nil, teamCodex: nil, usage: nil,
        higgsfield: higgsfield,
        grok: GrokCardModel(headline: (fixture["grok"] as? String) ?? "Grok 21%", detail: nil),
        agy: AgyCardModel(message: nil, groups: []),
        burnModel: burnModel,
        // 픽스처가 지연 상태를 담고 있으면 그대로 그린다. 이 경로는 실패했을 때만 나타나서
        // 스냅샷이 다루지 않으면 눈으로 확인된 적 없는 화면이 된다(적대 리뷰 2026-09-24).
        laneStaleNotes: (fixture["staleNotes"] as? [String: String]) ?? [:],
        parallelCount: 0, active: true,
        isMeasuringTeamClaude: false, teamClaudeMeasureDetail: nil,
        onMeasureTeamClaude: nil
    )
    view.layoutSubtreeIfNeeded()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        fputs("DASHBOARD-SNAPSHOT: bitmap 생성 실패\n", stderr)
        exit(1)
    }
    view.cacheDisplay(in: view.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        fputs("DASHBOARD-SNAPSHOT: PNG 변환 실패\n", stderr)
        exit(1)
    }
    do {
        try png.write(to: URL(fileURLWithPath: outputPath))
        print("DASHBOARD-SNAPSHOT: \(outputPath) \(Int(view.bounds.width))x\(Int(view.bounds.height))")
        exit(0)
    } catch {
        fputs("DASHBOARD-SNAPSHOT: 쓰기 실패 \(error)\n", stderr)
        exit(1)
    }
}

if let snapshotIndex = CommandLine.arguments.firstIndex(of: "--teamclaude-table-snapshot") {
    guard CommandLine.arguments.indices.contains(snapshotIndex + 1) else {
        fputs("TEAMCLAUDE-TABLE-SNAPSHOT: usage --teamclaude-table-snapshot <status.json> [out.png]\n", stderr)
        exit(2)
    }
    let fixturePath = CommandLine.arguments[snapshotIndex + 1]
    let outputPath = CommandLine.arguments.indices.contains(snapshotIndex + 2)
        ? CommandLine.arguments[snapshotIndex + 2]
        : "/tmp/cc-menubar-teamclaude-table.png"
    guard let fixtureData = FileManager.default.contents(atPath: fixturePath),
          let status = (try? JSONSerialization.jsonObject(with: fixtureData)) as? [String: Any] else {
        fputs("TEAMCLAUDE-TABLE-SNAPSHOT: fixture 읽기 실패 \(fixturePath)\n", stderr)
        exit(1)
    }
    _ = NSApplication.shared
    let health = parseTeamClaudeHealth(config: nil, server: nil, status: status, port: 3456)
    let view = TeamClaudeTableView(frame: NSRect(
        x: 0, y: 0,
        width: StatusMenuDashboardView.preferredWidth,
        height: StatusMenuDashboardView.teamContentHeight(health)
    ))
    view.health = health
    view.layoutSubtreeIfNeeded()
    guard let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        fputs("TEAMCLAUDE-TABLE-SNAPSHOT: bitmap 생성 실패\n", stderr)
        exit(1)
    }
    view.cacheDisplay(in: view.bounds, to: representation)
    guard let png = representation.representation(using: .png, properties: [:]) else {
        fputs("TEAMCLAUDE-TABLE-SNAPSHOT: PNG 변환 실패\n", stderr)
        exit(1)
    }
    do {
        try png.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        print("TEAMCLAUDE-TABLE-SNAPSHOT: \(outputPath) accounts=\(health.accountTotal) usable=\(health.accountUsable)")
        exit(0)
    } catch {
        fputs("TEAMCLAUDE-TABLE-SNAPSHOT: \(error)\n", stderr)
        exit(1)
    }
}

if let snapshotIndex = CommandLine.arguments.firstIndex(of: "--teamcodex-snapshot") {
    let outputPath = CommandLine.arguments.indices.contains(snapshotIndex + 1)
        ? CommandLine.arguments[snapshotIndex + 1]
        : "/tmp/cc-menubar-teamcodex.png"
    let pool = loadTeamCodexPoolHealth()
    let height = CodexStatusView.preferredHeight(for: pool)
    let view = CodexStatusView(frame: NSRect(
        x: 0,
        y: 0,
        width: StatusMenuDashboardView.preferredWidth,
        height: height
    ))
    view.pool = pool
    view.health = loadCodexHealth()
    view.layoutSubtreeIfNeeded()
    guard let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        fputs("TEAMCODEX-SNAPSHOT: bitmap 생성 실패\n", stderr)
        exit(1)
    }
    view.cacheDisplay(in: view.bounds, to: representation)
    guard let data = representation.representation(using: .png, properties: [:]) else {
        fputs("TEAMCODEX-SNAPSHOT: PNG 변환 실패\n", stderr)
        exit(1)
    }
    do {
        try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
        print("TEAMCODEX-SNAPSHOT: \(outputPath) accounts=\(pool.accounts.count) current=\(pool.currentAccount ?? "-")")
        exit(0)
    } catch {
        fputs("TEAMCODEX-SNAPSHOT: \(error)\n", stderr)
        exit(1)
    }
}

if CommandLine.arguments.contains("--menu-open-benchmark") {
    _ = NSApplication.shared
    let delegate = AppDelegate()
    delegate.currentTeamClaude = loadTeamClaudeHealth()
    delegate.currentTeamCodex = loadTeamCodexPoolHealth()
    let menu = NSMenu()

    let coldStartedAt = ProcessInfo.processInfo.systemUptime
    delegate.menuWillOpen(menu)
    delegate.menuDidClose(menu)
    let coldMs = Int((ProcessInfo.processInfo.systemUptime - coldStartedAt) * 1_000)

    let warmStartedAt = ProcessInfo.processInfo.systemUptime
    delegate.menuWillOpen(menu)
    delegate.menuDidClose(menu)
    let warmMs = Int((ProcessInfo.processInfo.systemUptime - warmStartedAt) * 1_000)

    print("MENU-BENCHMARK: cold=\(coldMs)ms warm=\(warmMs)ms items=\(menu.items.count)")
    exit(0)
}

if CommandLine.arguments.contains("--codex-loader-benchmark") {
    let startedAt = ProcessInfo.processInfo.systemUptime
    let health = loadCodexHealth()
    let elapsedMs = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1_000)
    print("CODEX-LOADER-BENCHMARK: \(elapsedMs)ms files=\(health.scannedLogFiles)")
    exit(0)
}

// 헤드리스 셀프테스트: `cc-menubar --selftest`는 GUI 없이 프록시 status를 파싱해
// 계정별 세션/주간/Fable 값을 출력하고 종료한다. "동기화중" 진단용(2026-07-22).
if CommandLine.arguments.contains("--selftest") {
    let health = loadTeamClaudeHealth()
    print("SELFTEST reachable=\(health.serverReachable) accounts=\(health.accounts.count) usable=\(health.accountUsable) host=\(health.hostSummaryText ?? "nil")")
    for row in health.accounts {
        let pair = teamClaudeQuotaPair(for: row)
        print("  \(row.name) status=\(row.status) ses=\(String(describing: row.sessionPercent)) wk=\(String(describing: row.weeklyPercent)) wkReset=\(String(describing: row.weeklyResetSeconds)) fb=\(String(describing: row.fablePercent)) pair=\(pair == nil ? "nil(→동기화중)" : "ok")")
    }
    exit(0)
}

let delegate = AppDelegate()
let app = NSApplication.shared
app.delegate = delegate
TeamClaudePalette.prewarm()
app.run()
