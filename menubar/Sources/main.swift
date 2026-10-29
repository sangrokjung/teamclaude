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
    /// status가 응답하지 않지만 프록시 프로세스는 살아 있다(부하로 인한 지연). 재시작 대상이 아니다.
    var serverResponseDelayed = false
    /// 계정 불일치가 worker 재로딩 뒤에도 남았다. 재시작하지 않고 경고만 한다.
    var driftPersistsAfterReload = false

    // 호스트 CPU/RAM 한 줄 요약 (표시할 값이 없으면 nil → 라인 생략)
    var hostSummaryText: String? {
        guard let host = host else { return nil }
        var parts: [String] = []
        if let cpu = host.cpuPercent, cpu.isFinite { parts.append("CPU \(Int(cpu.rounded()))%") }
        if let mem = host.memUsedPercent, mem.isFinite { parts.append("RAM \(Int(mem.rounded()))%") }
        guard !parts.isEmpty else { return nil }
        var extras: [String] = []
        if let load = host.loadavg1, load.isFinite { extras.append(String(format: "load %.1f", load)) }
        if let cores = host.cores { extras.append(L10n.hostCores(cores)) }
        let suffix = extras.isEmpty ? "" : " (\(extras.joined(separator: " / ")))"
        return L10n.hostPrefix + parts.joined(separator: " · ") + suffix
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
        // 평소 경로도 개요 큰 숫자와 같은 라우팅 수(프록시 usable 포함)를 쓴다. Fable 주간 여유는 패널의 Fable 레인이 보여 준다.
        if serverReachable && accountConfigDrift == 0 {
            return L10n.titleClaudeRouting(routableCount, total)
        }
        if !serverReachable && serverResponseDelayed { return L10n.titleClaudeSlow }
        return teamClaudeTitleSlot(titleRoutingInput)
    }

    /// 제목 슬롯 판정 입력. "Claude 라우팅 N/M"의 N은 개요 큰 숫자와 같은 라우팅 판정(프록시 usable 포함)이다.
    /// 예전엔 로컬 문턱 계산(accountUsable)이라 프록시가 유예 차선으로 보내는 계정을 0으로 셌다(실사용 QA 2026-10-25).
    var titleRoutingInput: TeamClaudeHeadlineInput {
        TeamClaudeHeadlineInput(
            serverReachable: serverReachable,
            accountConfigDrift: accountConfigDrift,
            measurementPendingCount: measurementPendingCount,
            quotaLimitedCount: quotaLimitedCount,
            fableKnown: fableKnown,
            fableOver: fableOver,
            totalAccounts: max(accountTotal, accountConfigured),
            accountUsable: routableCount,
            accountActive: accountActive
        )
    }

    var statusLabel: String {
        if isError { return L10n.errGeneric }
        if isWarning { return L10n.statusWarning }
        return L10n.statusOK
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
    /// 세션·주간 측정이 이번 응답 것인가. 라우팅 판정(Fable을 보지 않는다)은 이것만 요구한다.
    /// fableMeasurementCurrent는 Fable 창까지 요구해, 프록시 재시작 뒤 Fable이 비면 라우팅까지 "측정 필요"로 떨어뜨렸다.
    /// nil이면(병합을 거치지 않은 행) fableMeasurementCurrent를 따른다.
    var routingMeasurementCurrent: Bool? = nil
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

func claudeSpec(home: String = NSHomeDirectory()) -> ToolSpec {
    ToolSpec(name: "claude", envKey: "CC_MENUBAR_CLAUDE_BIN", preferred: [
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "\(home)/.local/bin/claude",
    ])
}

/// 시작 로그에 도구별 탐색 결과를 한 줄씩 남긴다. 백그라운드에서 돌려 로그인 셸 조회 캐시도 미리 채운다.
func logToolLocations() {
    DispatchQueue.global(qos: .utility).async {
        let home = NSHomeDirectory()
        let specs = [agySpec(home: home), higgsfieldSpec(home: home), npxSpec(home: home), grokSpec(home: home),
                     claudeSpec(home: home), teamClaudeSpec(home: home), teamCodexSpec(home: home)]
        for spec in specs {
            print(toolLocatorLogLine(spec.name, ToolLocator.shared.resolve(spec)))
        }
        fflush(stdout)
    }
}

func resolveClaudeExecutable() -> String {
    ToolLocator.shared.resolve(claudeSpec()).path ?? "/usr/bin/env"
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
    let configPath = currentTeamClaudeConfigPath()
    let config = configPath.flatMap { readTeamClaudeJSON($0) }
    let server = configPath.flatMap { readTeamClaudeJSON(teamClaudeServerStatePath(configPath: $0)) }
    let port = tcInt(server?["port"])
        ?? tcInt(tcDict(config?["proxy"])?["port"])
        ?? menubarDefaultPort(envKey: "CC_MENUBAR_TEAMCLAUDE_PORT", fallback: 3456)
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
        hints.append(L10n.hintServerConnectFailed)
    }
    if config == nil {
        hints.append(L10n.hintCheckConfig)
    }
    if fableAllOver {
        hints.append(L10n.hintFableAllOver)
    } else if fableOver > 0 {
        hints.append(L10n.hintFableSomeOver)
    }
    if !missingConfiguredRows.isEmpty {
        hints.append(L10n.hintMissingOnServer(missingConfiguredRows.count))
    }
    if !accountDrift.extraOnServer.isEmpty {
        hints.append(L10n.hintExtraOnServer(accountDrift.extraOnServer.count))
    }
    if !accountDrift.stateMismatch.isEmpty {
        hints.append(L10n.hintStateMismatch(accountDrift.stateMismatch.count))
    }
    if measurementPending > 0 {
        hints.append(L10n.hintMeasurePending(measurementPending))
    }
    if measurementUnavailable > 0 {
        hints.append(L10n.hintUnavailable(measurementUnavailable))
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
        hints: candidate.hints + [L10n.hintReconnecting],
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
        routingMeasurementCurrent: (candidate.routingMeasurementCurrent ?? candidate.fableMeasurementCurrent)
            && candidate.sessionPercent != nil && candidate.weeklyPercent != nil
            && (candidate.sessionResetSeconds ?? 0) > 0 && (candidate.weeklyResetSeconds ?? 0) > 0,
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
            ? candidate.hints + [L10n.hintPartialSync]
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
func npxSpec(home: String) -> ToolSpec {
    let fnmBin = "\(home)/.local/share/fnm/aliases/default/bin"
    return ToolSpec(name: "npx", envKey: "CC_MENUBAR_NPX_BIN", preferred: [
        "\(fnmBin)/npx",          // fnm default symlink
        "/opt/homebrew/bin/npx",  // Homebrew (Apple Silicon)
        "/usr/local/bin/npx",     // Homebrew (Intel) / 공식 Node installer
    ])
}

func resolveNpx(home: String) -> (exec: String, bin: String) {
    let fnmBin = "\(home)/.local/share/fnm/aliases/default/bin"
    if let path = ToolLocator.shared.resolve(npxSpec(home: home)).path {
        return (path, (path as NSString).deletingLastPathComponent)
    }
    // 모두 없으면 PATH 의존 (env PATH 가 npx 를 찾도록)
    return ("/usr/bin/env", fnmBin)
}

/// ccusage는 npx로 돈다. npx를 못 찾으면(재정의가 틀린 경우 포함) 미설치다.
func ccusageInstalled(home: String = NSHomeDirectory()) -> Bool {
    ToolLocator.shared.resolve(npxSpec(home: home)).path != nil
}

/// npx ccusage <subcommand> --json --offline 을 실행해 stdout JSON Data 반환. 실패 시 nil.
/// daily/weekly/monthly 공용 — 각 호출은 자기 파이프로 stdout을 받는다.
func runCcusageRaw(_ subcommand: String) -> Data? {
    runCcusageCommand(subcommand, timeoutSeconds: ccusageDefaultTimeoutSeconds).successOutput
}

/// ccusage 한 번의 기본 시간 제한.
let ccusageDefaultTimeoutSeconds: Double = 60

/// ccusage stdout 한 번의 크기 상한. 실제 daily JSON은 수백 KB(오래 쓴 기록도 수 MB)라 32MB면 넉넉하다.
/// 넘으면 오동작(CC_MENUBAR_NPX_BIN 오지정·무한 출력)으로 보고 자식을 그룹째 끊는다. 출력 전량이 메모리에 올라가
/// 메뉴바가 멈추는 것을 막는다.
let ccusageDefaultOutputLimitBytes = 32 * 1024 * 1024

/// ccusage 한 번 실행의 원 결과. 실패를 원인별로 가르려고 종료 코드·시간 초과·출력을 그대로 남긴다.
struct CcusageRun {
    let launched: Bool
    let timedOut: Bool
    let exitStatus: Int32
    /// stdout이 크기 상한을 넘었다. 그때 output은 비어 있다(넘기 전까지 받은 출력도 버린다).
    let outputTooLarge: Bool
    let output: Data

    static let notLaunched = CcusageRun(launched: false, timedOut: false, exitStatus: -1, outputTooLarge: false,
                                        output: Data())

    var successOutput: Data? {
        launched && !timedOut && !outputTooLarge && exitStatus == 0 && !output.isEmpty ? output : nil
    }
}

func runCcusageCommand(_ subcommand: String, timeoutSeconds: Double,
                       outputLimitBytes: Int = ccusageDefaultOutputLimitBytes) -> CcusageRun {
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

    // stdout은 호출마다 새 파이프로 받아 읽는 쪽이 상한까지만 메모리에 모은다(142KB JSON도 읽으면서 받으니
    // 파이프 버퍼에 막히지 않는다). 호출끼리 나누는 상태가 없어 전체·quick 갱신이 겹쳐도 서로의 출력을 섞지 않는다.
    guard let nullError = FileHandle(forWritingAtPath: "/dev/null") else { return .notLaunched }
    defer { nullError.closeFile() }
    process.standardError = nullError

    guard let result = runTrustedProcessInIsolatedGroup(
        process,
        timeoutSeconds: timeoutSeconds,
        terminationGraceMicroseconds: 700_000,
        captureOutputLimitBytes: outputLimitBytes
    ) else {
        print("CCUSAGE-FAIL[\(subcommand)]: 격리 프로세스 실행 실패")
        fflush(stdout)
        return .notLaunched
    }
    if result.timedOut {
        print("CCUSAGE-TIMEOUT[\(subcommand)]: \(Int(timeoutSeconds))초 초과, 강제 종료")
    }
    if result.outputExceeded {
        print("CCUSAGE-FAIL[\(subcommand)]: 출력이 \(outputLimitBytes)바이트 상한 초과, 출력 폐기")
    }
    print("CCUSAGE[\(subcommand)]: exit=\(result.terminationStatus) bytes=\(result.output.count)")
    fflush(stdout)

    return CcusageRun(launched: true, timedOut: result.timedOut, exitStatus: result.terminationStatus,
                      outputTooLarge: result.outputExceeded, output: result.output)
}

/// ccusage daily 한 번의 판정과 그 값. 전체·quick 로더가 같은 판정을 쓴다.
struct CcusageDailyLoad {
    let outcome: CcusageLoadOutcome
    /// 실행·해석에 성공했을 때만 있다(weekly·monthly와 합쳐 다시 해석한다).
    let daily: Data?
    /// daily만으로 만든 값.
    let quick: UsageData?
    let rate: Double
    /// 판정·해석이 본 "지금". weekly·monthly를 합친 최종 해석도 이 시각을 써야 자정을 넘겨도 같은 날을 본다.
    let now: Date
}

/// ccusage가 쓰는 날짜 키(로컬 시간 yyyy-MM-dd).
func ccusageDayKey(_ date: Date) -> String {
    let formatter = DateFormatter()
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.locale = Locale(identifier: "en_US_POSIX")
    return formatter.string(from: date)
}

/// ccusage daily 원시 JSON에 그 날짜 항목이 정확히 있는가. 해석하지 못하면 nil.
func ccusageDailyHasEntry(_ data: Data, period: String) -> Bool? {
    guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let daily = json["daily"] as? [[String: Any]] else { return nil }
    return daily.contains { ($0["period"] as? String) == period }
}

/// daily를 실행하고 실행 실패·시간 초과·종료 코드·빈 출력·해석 실패를 "데이터 없음"과 갈라 판정한다.
func loadCcusageDaily(timeoutSeconds: Double, outputLimitBytes: Int = ccusageDefaultOutputLimitBytes,
                      clock: () -> Date = { Date() }) -> CcusageDailyLoad {
    let run = runCcusageCommand("daily", timeoutSeconds: timeoutSeconds, outputLimitBytes: outputLimitBytes)
    let output = run.successOutput
    let rate = output == nil ? 0 : fetchUsdKrwRate()
    // 해석과 오늘 판정이 같은 "오늘"을 보게 한 시각을 함께 넘긴다(자정 경계에서 엇갈리지 않게).
    let now = clock()
    let todayKey = ccusageDayKey(now)
    let quick = output.flatMap { parseUsageData(daily: $0, weekly: nil, monthly: nil, rate: rate, now: now) }
    // "오늘 읽었다"는 원시 daily에 정확히 오늘 날짜 항목이 있을 때만이다. quick.today는 표시용 값이라
    // (지난 기록만 있으면 0원짜리 오늘) 판정에 쓰지 않는다.
    let hasExactToday = quick == nil ? nil : output.flatMap { ccusageDailyHasEntry($0, period: todayKey) }
    let outcome = ccusageLoadOutcome(launched: run.launched, timedOut: run.timedOut, timeoutSeconds: timeoutSeconds,
                                     exitStatus: run.exitStatus, outputBytes: run.output.count,
                                     parsedHasToday: hasExactToday, outputTooLarge: run.outputTooLarge)
    if case .failed(let failure) = outcome {
        print("CCUSAGE-FAIL[daily]: \(failure.label)")
        fflush(stdout)
    }
    return CcusageDailyLoad(outcome: outcome, daily: outcome.succeeded ? output : nil, quick: quick, rate: rate,
                            now: now)
}

/// 전체 갱신에서 해석에 넣을 weekly·monthly 출력과 실패한 명령.
struct CcusageAuxResolution {
    let weekly: Data?
    let monthly: Data?
    let failures: [CcusageAuxFailure]
}

/// JSON 숫자인가. JSONSerialization은 true/false도 NSNumber로 주므로 불리언은 뺀다.
func ccusageIsJSONNumber(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber else { return false }
    return CFGetTypeID(number) != CFBooleanGetTypeID()
}

/// 비용 값: 유한한 0 이상의 숫자.
func ccusageIsValidCost(_ value: Any?) -> Bool {
    guard ccusageIsJSONNumber(value), let number = value as? NSNumber else { return false }
    let double = number.doubleValue
    return double.isFinite && double >= 0
}

/// 토큰 값: 0 이상의 정수.
func ccusageIsValidTokenCount(_ value: Any?) -> Bool {
    guard ccusageIsValidCost(value), let number = value as? NSNumber else { return false }
    return number.doubleValue.rounded(.towardZero) == number.doubleValue
}

/// 모델별 내역 한 줄: 이름 문자열, 비용과 있는 토큰 필드가 모두 올바른 값.
func ccusageModelBreakdownIsValid(_ entry: [String: Any]) -> Bool {
    guard entry["modelName"] is String, ccusageIsValidCost(entry["cost"]) else { return false }
    return ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"].allSatisfy { key in
        entry[key] == nil || ccusageIsValidTokenCount(entry[key])
    }
}

/// pickPeriod·parseModelBreakdown이 읽는 weekly·monthly 출력 형태인가. 명령별 기간 배열의 각 항목은 명령에 맞는
/// `period`(주간 YYYY-MM-DD, 월간 YYYY-MM), 0 이상의 `totalCost`, 0 이상 정수 `totalTokens`를 갖고, `modelBreakdowns`가
/// 있으면 각 줄이 올바라야 한다. `totals`가 있으면 같은 두 값을 가진 객체여야 한다. 형식이 틀린 값을 해석기가 0으로
/// 읽거나 건너뛰어 정상값처럼 그리지 않게, 여기서 실패로 가른다. 빈 배열은 기간 항목이 없는 정상 경우다.
func ccusageAuxOutputMatchesSchema(_ data: Data, command: CcusageAuxCommand) -> Bool {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let entries = object[command.arrayKey] as? [[String: Any]] else { return false }
    let entriesValid = entries.allSatisfy { entry in
        guard let period = entry["period"] as? String, command.periodMatches(period),
              ccusageIsValidCost(entry["totalCost"]), ccusageIsValidTokenCount(entry["totalTokens"]) else { return false }
        guard let breakdowns = entry["modelBreakdowns"] else { return true }
        guard let rows = breakdowns as? [[String: Any]] else { return false }
        return rows.allSatisfy(ccusageModelBreakdownIsValid)
    }
    guard entriesValid else { return false }
    guard let totals = object["totals"] else { return true }
    guard let totalsObject = totals as? [String: Any] else { return false }
    return ccusageIsValidCost(totalsObject["totalCost"]) && ccusageIsValidTokenCount(totalsObject["totalTokens"])
}

/// weekly·monthly 한 번의 실패 원인. 성공이면 nil. daily와 같은 판정 순서를 쓰고, 해석 실패는 출력이
/// `ccusageAuxOutputMatchesSchema`를 통과하지 못할 때다.
func ccusageAuxFailure(_ run: CcusageRun, command: CcusageAuxCommand, timeoutSeconds: Double) -> CcusageFailure? {
    let matchesSchema = run.successOutput.map { ccusageAuxOutputMatchesSchema($0, command: command) } ?? false
    let outcome = ccusageLoadOutcome(launched: run.launched, timedOut: run.timedOut, timeoutSeconds: timeoutSeconds,
                                     exitStatus: run.exitStatus, outputBytes: run.output.count,
                                     parsedHasToday: matchesSchema ? true : nil, outputTooLarge: run.outputTooLarge)
    if case .failed(let failure) = outcome { return failure }
    return nil
}

/// 전체 갱신의 weekly·monthly 결과를 해석에 넣을 값으로 정한다. 실패한 명령은 이전에 해석에 쓴 출력을 대신 쓰고
/// (없으면 nil — 해석이 daily 파생값으로 폴백한다), 실패 원인은 부분 실패 꼬리말로 넘긴다.
func resolveCcusageAux(weekly: CcusageRun, monthly: CcusageRun, previousWeekly: Data?, previousMonthly: Data?,
                       timeoutSeconds: Double) -> CcusageAuxResolution {
    var failures: [CcusageAuxFailure] = []
    func pick(_ run: CcusageRun, _ command: CcusageAuxCommand, previous: Data?) -> Data? {
        guard let failure = ccusageAuxFailure(run, command: command, timeoutSeconds: timeoutSeconds) else { return run.successOutput }
        failures.append(CcusageAuxFailure(command: command, failure: failure))
        print("CCUSAGE-PARTIAL[\(command.label)]: \(failure.label) · \(previous == nil ? "daily 파생값" : "이전 값") 사용")
        fflush(stdout)
        return previous
    }
    let weeklyData = pick(weekly, .weekly, previous: previousWeekly)
    let monthlyData = pick(monthly, .monthly, previous: previousMonthly)
    return CcusageAuxResolution(weekly: weeklyData, monthly: monthlyData, failures: failures)
}

struct IsolatedProcessResult {
    let terminationStatus: Int32
    let timedOut: Bool
    /// 캡처한 stdout이 상한을 넘어 그룹째 끊었다. 그때 output은 비어 있다.
    var outputExceeded = false
    /// 캡처 모드에서 모은 stdout(상한 이하). 캡처하지 않았으면 비어 있다.
    var output = Data()
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
/// captureOutputLimitBytes를 주면 stdout은 process.standardOutput 대신 이 호출만의 파이프로 받는다
/// (awaitCapturedGroup 참고). 주지 않으면 process.standardOutput(FileHandle)에 그대로 쓴다.
func runTrustedProcessInIsolatedGroup(
    _ process: Process,
    timeoutSeconds: Double,
    terminationGraceMicroseconds: useconds_t,
    captureOutputLimitBytes: Int? = nil
) -> IsolatedProcessResult? {
    guard let executableURL = process.executableURL,
          executableURL.isFileURL,
          let standardError = process.standardError as? FileHandle else { return nil }

    // 캡처 파이프. 두 끝 모두 CLOEXEC라 다른 스레드가 동시에 띄우는 자식에 새지 않는다(새면 EOF가 늦어진다).
    var pipeFDs: [Int32] = [-1, -1]
    if captureOutputLimitBytes != nil {
        guard pipe(&pipeFDs) == 0 else { return nil }
        for fd in pipeFDs { _ = fcntl(fd, F_SETFD, FD_CLOEXEC) }
    }
    let captureRead = pipeFDs[0], captureWrite = pipeFDs[1]
    defer { if captureRead >= 0 { close(captureRead) } }
    var writeEndOpen = captureWrite >= 0
    func closeWriteEnd() {
        if writeEndOpen { close(captureWrite); writeEndOpen = false }
    }
    defer { closeWriteEnd() }
    let stdoutFD: Int32
    if captureOutputLimitBytes != nil {
        stdoutFD = captureWrite
    } else if let standardOutput = process.standardOutput as? FileHandle {
        stdoutFD = standardOutput.fileDescriptor
    } else {
        return nil
    }

    var fileActions: posix_spawn_file_actions_t?
    guard posix_spawn_file_actions_init(&fileActions) == 0 else { return nil }
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    guard posix_spawn_file_actions_adddup2(
        &fileActions,
        stdoutFD,
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
    // 부모 쪽 쓰기 끝을 닫아야 자식(과 손자)이 모두 닫았을 때 EOF가 온다.
    closeWriteEnd()
    guard spawnResult == 0, childPid > 0 else { return nil }

    if let captureOutputLimitBytes {
        var capture = BoundedPipeCapture(fd: captureRead, limit: captureOutputLimitBytes)
        return awaitCapturedGroup(childPid, capture: &capture, timeoutSeconds: timeoutSeconds,
                                  terminationGraceMicroseconds: terminationGraceMicroseconds)
    }

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

/// 캡처 파이프를 비차단으로 읽어 상한까지만 모은다. 상한을 넘기는 읽기가 오면 그 바이트는 버리고 exceeded를 세운다.
/// 읽는 쪽이 멈추면 자식의 write()는 파이프 버퍼(수십 KB)에서 막히므로, 한 번의 큰 write()도 상한 너머로 쌓이지 않는다.
private struct BoundedPipeCapture {
    let fd: Int32
    let limit: Int
    var data = Data()
    var reachedEOF = false
    var exceeded = false
    private var buffer = [UInt8](repeating: 0, count: 64 * 1024)

    init(fd: Int32, limit: Int) {
        self.fd = fd
        self.limit = max(limit, 0)
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    }

    /// 읽을 거리가 올 때까지 최대 milliseconds 기다린 뒤 지금 읽을 수 있는 만큼 읽는다. EOF 뒤에는 그냥 잔다.
    mutating func waitAndDrain(milliseconds: Int32) {
        guard !reachedEOF, !exceeded else {
            usleep(useconds_t(milliseconds) * 1000)
            return
        }
        var poller = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
        _ = poll(&poller, 1, milliseconds)
        drain()
    }

    private mutating func drain() {
        let fd = self.fd
        while !reachedEOF && !exceeded {
            let count = buffer.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if count > 0 {
                guard data.count + count <= limit else {
                    exceeded = true
                    data = Data()
                    return
                }
                data.append(contentsOf: buffer[0..<count])
                continue
            }
            if count == 0 { reachedEOF = true; return }
            if errno == EINTR { continue }
            // EAGAIN은 지금 읽을 것이 없다는 뜻이다. 그 밖의 읽기 오류는 더 받을 수 없으니 EOF로 본다.
            if errno != EAGAIN { reachedEOF = true }
            return
        }
    }
}

/// 직접 자식이 끝나고 파이프가 EOF가 될 때(또는 끝난 뒤 짧은 유예가 지날 때)까지, 혹은 시간 제한까지 읽는다.
/// 상한을 넘기면 유예 없이 그룹째 KILL한다. 그 밖에는 어떻게 끝났든 그룹 전체에 TERM을 보내고, 유예 안에
/// 산 구성원이 남으면 KILL한 뒤에 직접 자식을 회수한다 — 같은 그룹의 손자가 살아남아 계속 쓰지 못한다.
/// 직접 자식은 그룹 신호를 다 보낼 때까지 회수하지 않으므로 그동안 그룹 id가 재사용될 수 없다.
private func awaitCapturedGroup(
    _ childPid: pid_t,
    capture: inout BoundedPipeCapture,
    timeoutSeconds: Double,
    terminationGraceMicroseconds: useconds_t
) -> IsolatedProcessResult? {
    // 직접 자식이 끝난 뒤 손자가 쥔 파이프의 EOF를 기다리는 최대 시간.
    let drainGraceNanoseconds: UInt64 = 200_000_000
    let timeoutNanoseconds = UInt64(max(timeoutSeconds, 0) * 1_000_000_000)
    let startedAt = DispatchTime.now().uptimeNanoseconds
    var exitedAt: UInt64?
    var timedOut = false
    func finish(_ status: Int32) -> IsolatedProcessResult {
        IsolatedProcessResult(terminationStatus: status, timedOut: timedOut, outputExceeded: capture.exceeded,
                              output: capture.exceeded ? Data() : capture.data)
    }

    while true {
        let now = DispatchTime.now().uptimeNanoseconds
        if now - startedAt >= timeoutNanoseconds { timedOut = true; break }
        capture.waitAndDrain(milliseconds: 20)
        if capture.exceeded {
            _ = Darwin.killpg(childPid, SIGKILL)
            return reapChild(childPid).map(finish)
        }
        if exitedAt == nil {
            guard let hasExited = childHasExitedWithoutReaping(childPid) else {
                _ = Darwin.killpg(childPid, SIGKILL)
                return reapChild(childPid).map(finish)
            }
            if hasExited { exitedAt = DispatchTime.now().uptimeNanoseconds }
        }
        if let exitedAt,
           capture.reachedEOF || DispatchTime.now().uptimeNanoseconds - exitedAt >= drainGraceNanoseconds {
            break
        }
    }

    // 파이프 EOF는 그룹이 비었다는 뜻이 아니다(stdout을 돌린 손자는 파이프를 닫고도 남는다).
    // 산 구성원이 없으면 killpg(…, 0)은 실패한다(회수 전 직접 자식은 좀비라 산 구성원이 아니다).
    func groupHasLiveMembers() -> Bool { Darwin.killpg(childPid, 0) == 0 }
    _ = Darwin.killpg(childPid, SIGTERM)
    let graceNanoseconds = UInt64(terminationGraceMicroseconds) * 1_000
    let graceStartedAt = DispatchTime.now().uptimeNanoseconds
    while DispatchTime.now().uptimeNanoseconds - graceStartedAt < graceNanoseconds, groupHasLiveMembers() {
        capture.waitAndDrain(milliseconds: 10)
        if capture.exceeded { break }
    }
    if groupHasLiveMembers() { _ = Darwin.killpg(childPid, SIGKILL) }
    return reapChild(childPid).map(finish)
}

func parseUsageData(daily dailyData: Data, weekly weeklyData: Data?, monthly monthlyData: Data?, rate: Double,
                    now: Date = Date()) -> UsageData? {
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
    let todayStr = formatter.string(from: now)

    // 이번 달 키 (YYYY-MM) + 이번 주 월요일 키 (YYYY-MM-DD) — ccusage native weekly/monthly period 매칭용
    let monthFmt = DateFormatter()
    monthFmt.dateFormat = "yyyy-MM"
    monthFmt.locale = Locale(identifier: "en_US_POSIX")
    let thisMonthKey = monthFmt.string(from: now)

    let cal = Calendar(identifier: .gregorian)
    let nowDate = now
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

    // 오늘 데이터 — 정확히 오늘 날짜 항목만 오늘로 쓴다. 마지막 항목(어제일 수 있다)을 오늘로 쓰지 않는다.
    // ccusage daily는 기록이 있는 날만 내므로, 지난 기록은 있는데 오늘 항목이 없으면 오늘 사용은 0이다.
    // 그때는 0원짜리 오늘을 두어 주·월·누적 같은 지난 기록 표시는 유지한다. 기록이 아예 없으면 nil(데이터 없음).
    let today = days.first(where: { $0.period == todayStr })
        ?? (days.isEmpty ? nil : DailyUsage(period: todayStr, totalCost: 0, inputTokens: 0, cacheCreationTokens: 0,
                                            cacheReadTokens: 0, outputTokens: 0, models: []))

    // 주간 비용: 최근 7일
    let recentDays = Array(days.suffix(7))
    let weeklyTotalCost = recentDays.reduce(0.0) { $0 + $1.totalCost }

    // native weekly/monthly 에서 이번 주/이번 달 정확 집계
    let weeklyPick = pickPeriod(weeklyData, key: thisMondayKey, arrayKey: CcusageAuxCommand.weekly.arrayKey)
    let monthlyPick = pickPeriod(monthlyData, key: thisMonthKey, arrayKey: CcusageAuxCommand.monthly.arrayKey)

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
    // 영어 화면은 만·억 대신 K·M·B로 줄인다(값은 같다).
    if L10n.language == .en {
        if absK >= 1_000_000_000 { return sign + String(format: "₩%.1fB", absK / 1_000_000_000) }
        if absK >= 1_000_000 { return sign + String(format: "₩%.1fM", absK / 1_000_000) }
        if absK >= 10_000 { return sign + String(format: "₩%.0fK", absK / 1_000) }
    }
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
/// Claude 풀 표(A안). 서버 줄 → 측정·연동 안내 → 열 머리(리셋은 여기 한 번) → 상태별 묶음 행.
/// 행을 누르면 구독·동시 요청·누적 요청·창별 리셋과 동작(재인증·측정·구독 기록)이 펼쳐진다.
/// 행 순서·높이는 TeamClaudeRowLines.swift의 teamClaudeGroupedLayout 하나가 정하고 높이·배치·그리기가 같이 쓴다.
final class TeamClaudeTableView: NSView {
    var health: TeamClaudeHealth? {
        didSet {
            refreshTime()
            needsLayout = true
        }
    }
    private var refreshTimer: Timer?
    private(set) var evaluatedAt = Date()

    /// 펼친 계정 이름. 바뀌면 소유자(대시보드)가 표 높이를 다시 잡는다.
    var expandedAccount: String? {
        didSet {
            guard expandedAccount != oldValue else { return }
            expansionChanged()
        }
    }
    /// 펼친 계정 uuid. 같은 이름 계정이 둘이어도 엉뚱한 행을 펼치지 않게 이름과 함께 쓴다(없으면 이름이 하나뿐일 때만).
    var expandedAccountUuid: String? {
        didSet {
            guard expandedAccountUuid != oldValue else { return }
            expansionChanged()
        }
    }
    var onExpansionChange: (() -> Void)?

    private func expansionChanged() {
        detailSignature = ""
        needsLayout = true
        needsDisplay = true
        onExpansionChange?()
    }

    /// 이름·uuid로 행 하나를 펼친다(uuid 먼저 바꿔 두 값이 한 번에 맞게).
    func expand(_ name: String?, accountUuid: String?) {
        expandedAccountUuid = name == nil ? nil : accountUuid
        expandedAccount = name
    }

    static func rowIndex(_ health: TeamClaudeHealth, name: String, accountUuid: String?) -> Int? {
        subscriptionRowIndex(names: health.accounts.map(\.name), uuids: health.accounts.map(\.accountUuid),
                             name: name, accountUuid: accountUuid)
    }

    func refreshTime(now: Date = Date()) {
        evaluatedAt = now
        guard let health else { return }
        let total = max(health.accountTotal, health.accountConfigured)
        let availability = health.routingAvailability(now: now)
        // 접근성 문장의 "Fable 사용 가능"은 Fable 레인 판정, "라우팅 가능"은 표 묶음과 같은 라우팅 판정이다.
        let ready = health.fableAvailability(now: now).filter { $0.state == .ready }.count
        setAccessibilityLabel(L10n.claudeTableAccessibility(ready: ready, total: total, usable: health.routableCount,
                                                           drift: health.accountConfigDrift, pending: health.measurementPendingCount,
                                                           unavailable: health.measurementUnavailableCount, limited: health.quotaLimitedCount,
                                                           fableOver: health.fableOver, status: health.statusLabel))
        setAccessibilityHelp(health.measurementPendingCount > 0 ? L10n.measureReturnHelp : nil)
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
    private var rowHitRects: [(name: String, accountUuid: String?, rect: NSRect)] = []
    private var reauthButtons: [PanelButton] = []
    private var reauthButtonTargets: [ObjectIdentifier: (name: String, accountUuid: String?)] = [:]
    private var reauthSignature = ""
    private var confirmEndButtons: [PanelButton] = []
    private var subscriptionButtons: [AccountSubscriptionButton] = []
    private var subscriptionSignature = ""
    private var detailButtons: [PanelButton] = []
    private var detailSignature = ""
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

    /// 높이 = 표 상단 + 묶음 행. 대시보드의 teamContentHeight와 이 표의 layout·draw가 같은 계산을 쓴다.
    static func contentHeight(_ health: TeamClaudeHealth, expanded: String?, expandedUuid: String? = nil, now: Date = Date()) -> CGFloat {
        let availability = health.routingAvailability(now: now)
        let lines = health.rowLines(now: now, availability: availability)
        let layout = teamClaudeGroupedLayout(groups: availability.map(teamClaudeRowGroup), lines: lines,
                                             expanded: expanded.flatMap { rowIndex(health, name: $0, accountUuid: expandedUuid) })
        return teamClaudeCardBaseHeight(hostLine: health.hostSummaryText != nil) + layout.height
    }

    private var expandedIndex: Int? {
        guard let expandedAccount, let health else { return nil }
        return Self.rowIndex(health, name: expandedAccount, accountUuid: expandedAccountUuid)
    }

    /// 그 계정 행의 사각형(표 좌표). 개요에서 계정을 눌러 들어올 때 스크롤 위치를 잡는다.
    func rowRect(named name: String, accountUuid: String? = nil) -> NSRect? {
        guard let health, let index = Self.rowIndex(health, name: name, accountUuid: accountUuid) else { return nil }
        let availability = health.routingAvailability(now: evaluatedAt)
        let lines = health.rowLines(now: evaluatedAt, availability: availability)
        let layout = teamClaudeGroupedLayout(groups: availability.map(teamClaudeRowGroup), lines: lines, expanded: expandedIndex)
        guard let y = layout.origins[index] else { return nil }
        let rowsTop = TeamClaudeCardMetrics.rowsTop(hostLine: health.hostSummaryText != nil)
        return NSRect(x: 0, y: rowsTop + y, width: bounds.width,
                      height: teamClaudeRowHeight(lines[index], expanded: index == expandedIndex))
    }

    private func reauthenticationRows() -> [(index: Int, name: String, accountUuid: String?)] {
        guard let health else { return [] }
        let availability = health.routingAvailability(now: evaluatedAt)
        let subscriptions = health.subscriptionResolutions(now: evaluatedAt)
        return health.accounts.enumerated().compactMap { index, row in
            guard availability[index].subscriptionAppearance != .ended else { return nil }
            // 해지 기록이 있는 인증 오류 계정은 다시 로그인해도 돌아오지 않는다. 그 자리는 "종료로 확정"이다.
            guard subscriptions[index].state != .ended, !subscriptions[index].isCancelled else { return nil }
            return teamClaudeCanReauthenticate(
                enabled: row.enabled,
                status: row.status,
                source: row.source,
                provider: row.provider,
                errorReason: row.errorReason
            ) ? (index, row.name, row.accountUuid) : nil
        }
    }

    /// 해지 기록이 있는 인증 오류 행(상태 칸에 "종료로 확정"). 누르면 행을 펼치고 펼친 행의 확정 버튼을 무장한다.
    private func confirmEndRows() -> [(index: Int, name: String, accountUuid: String?)] {
        guard let health else { return [] }
        let subscriptions = health.subscriptionResolutions(now: evaluatedAt)
        return health.accounts.enumerated().compactMap { index, row in
            guard subscriptions[index].isCancelled,
                  teamClaudeCanReauthenticate(enabled: row.enabled, status: row.status, source: row.source,
                                              provider: row.provider, errorReason: row.errorReason) else { return nil }
            return (index, row.name, row.accountUuid)
        }
    }

    /// 손볼 것·상태 칸의 "종료로 확정"에서 들어올 때: 펼친 행의 확정 버튼을 한 번 누른 상태로 둔다.
    /// 행은 이름과 uuid로 다시 고른다(같은 이름 계정이 둘이면 이름만으로는 고르지 않는다).
    func armConfirmEnd(_ name: String, accountUuid: String?) {
        guard let health, let index = Self.rowIndex(health, name: name, accountUuid: accountUuid) else { return }
        let subscription = health.subscriptionResolutions(now: evaluatedAt)[index]
        guard subscription.isCancelled else { return }
        SubscriptionActionButtons.arm(health.subscriptionTarget(index).target, .confirmEnd)
        detailSignature = ""
        needsLayout = true
        DispatchQueue.main.asyncAfter(deadline: .now() + SubscriptionActionButtons.armSeconds + 0.05) { [weak self] in
            self?.detailSignature = ""
            self?.needsLayout = true
        }
    }

    private func ensureReauthenticationButtons() {
        let rows = reauthenticationRows()
        let confirmRows = confirmEndRows()
        let signature = rows.map { "\($0.index):\($0.name):\($0.accountUuid ?? "-")" }.joined(separator: "|")
            + "#" + confirmRows.map { "\($0.index):\($0.name):\($0.accountUuid ?? "-")" }.joined(separator: "|")
        guard signature != reauthSignature else { return }
        reauthSignature = signature
        reauthButtons.forEach { $0.removeFromSuperview() }
        reauthButtons.removeAll(keepingCapacity: true)
        reauthButtonTargets.removeAll(keepingCapacity: true)
        for row in rows {
            let button = PanelButton(title: L10n.reauthenticate, style: .primary)
            button.setAccessibilityLabel(L10n.reauthNeededLabel(row.name))
            button.setAccessibilityHelp(L10n.reauthHelp)
            button.toolTip = L10n.reauthToolTip(row.name)
            button.target = self
            button.action = #selector(reauthenticateButtonClicked(_:))
            reauthButtons.append(button)
            reauthButtonTargets[ObjectIdentifier(button)] = (row.name, row.accountUuid)
            addSubview(button)
        }
        confirmEndButtons.forEach { $0.removeFromSuperview() }
        confirmEndButtons = confirmRows.map { row in
            let button = PanelButton(title: L10n.subActionConfirmEnd, style: .primary) { [weak self] in
                // 누른 시점의 행이 그 계정인지 uuid로 다시 확인한다(행 순서가 바뀌었을 수 있다).
                guard let self, let health = self.health, health.accounts.indices.contains(row.index),
                      health.accounts[row.index].name == row.name, health.accounts[row.index].accountUuid == row.accountUuid else { return }
                self.expand(row.name, accountUuid: row.accountUuid)
                self.armConfirmEnd(row.name, accountUuid: row.accountUuid)
            }
            button.setAccessibilityLabel("\(L10n.subActionConfirmEnd): \(row.name)")
            button.toolTip = L10n.subTodoReasonCancelled
            addSubview(button)
            return button
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
            // 구독 줄이 판정과 같은 말을 하게 한다. 해지 예약·종료일 지남·해지 확정이면 "해지 예약 · 11/12 종료 · 14일 남음" 형식.
            button.resolvedLineProvider = { [weak self] now in
                guard let self, let health = self.health,
                      let index = health.accounts.firstIndex(where: { $0.name == row.name && $0.accountUuid == row.accountUuid }),
                      let subscription = health.subscriptionResolution(index, now: now),
                      [.scheduled, .overdue, .ended].contains(subscription.state) else { return nil }
                return subscriptionRowLine(subscription.shown, now: now)
            }
            button.onChange = { [weak self] in
                guard let self, let health = self.health else { return }
                self.health = health
            }
            addSubview(button)
            return button
        }
    }

    /// 펼친 행의 동작 버튼(재인증·측정·구독 기록). 펼친 행이 바뀔 때만 다시 만든다.
    private func ensureDetailButtons(index: Int?, availability: [TeamClaudeFableAvailability]) {
        guard let health else { return }
        let subscription = index.map { health.subscriptionResolutions(now: evaluatedAt)[$0] }
        let target = index.map { health.subscriptionTarget($0) }
        let center = SubscriptionActionCenter.shared
        let armedKinds = target.map { target in
            [SubscriptionActionButtons.Kind.confirmEnd, .clear].filter { SubscriptionActionButtons.isArmed(target.target, $0) }
                .map(\.rawValue).joined(separator: ",")
        } ?? ""
        let signature = (index.map { "\($0):\(health.accounts[$0].name):\(isMeasuring)" } ?? "")
            + ":\(subscription?.state.rawValue ?? "-"):\(subscription?.shown.endDate ?? "-"):\(target.map { center.isBusy($0.target) } ?? false):\(armedKinds)"
        guard signature != detailSignature else { return }
        detailSignature = signature
        detailButtons.forEach { $0.removeFromSuperview() }
        detailButtons = []
        guard let index, health.accounts.indices.contains(index) else { return }
        let row = health.accounts[index]
        let muted = availability[index].subscriptionAppearance.isMuted
        if row.measurementIssue?.canMeasureNow == true, !muted, !isMeasuring {
            detailButtons.append(PanelButton(title: L10n.measureNow, style: .ghost) { [weak self] in self?.onMeasure?() })
        }
        if let subscription, let target, target.target.accountUuid?.isEmpty == false {
            detailButtons += SubscriptionActionButtons.make(target: target.target, resolution: subscription, billingDay: target.billingDay) {
                [weak self] in
                self?.detailSignature = ""
                self?.needsLayout = true
            }
        }
        let subscriptionButton = subscriptionButtons.indices.contains(index) ? subscriptionButtons[index] : nil
        if subscriptionButton?.isEnabled == true {
            detailButtons.append(PanelButton(title: L10n.subscriptionRecord, style: .quiet) { subscriptionButton?.openRecordDialog() })
        }
        for button in detailButtons {
            button.setAccessibilityLabel("\(button.title): \(row.name)")
            addSubview(button)
        }
    }

    /// 펼친 행의 구독 기록(시안 sub-editor 보기). 세 줄, 16pt 간격.
    private func drawSubscriptionRecord(_ subscription: SubscriptionResolution, x: CGFloat, y: CGFloat, rightEdge: CGFloat) {
        let micro = TeamClaudePalette.microFont, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let valueX = x + 60
        let shown = subscription.shown
        PanelDraw.text(L10n.subTermState, x, y, micro, fg3)
        SubscriptionGlyph.draw(shown.state, x: valueX, y: y + 1.5, progress: subscriptionCancelProgress(shown, now: evaluatedAt))
        let labelFont = NSFont.systemFont(ofSize: 11, weight: .semibold)
        let labelColor = shown.state == .unknown || shown.state == .ended ? TeamClaudePalette.fg : SubscriptionGlyph.tone(shown.state)
        let labelWidth = PanelDraw.text(shown.state.label, valueX + 16, y, labelFont, labelColor)
        let detail = subscriptionStateDetail(shown, now: evaluatedAt)
        if !detail.isEmpty {
            PanelDraw.text(PanelDraw.clipped("· " + detail, TeamClaudePalette.smallFont, maxWidth: rightEdge - valueX - 22 - labelWidth),
                           valueX + 20 + labelWidth, y, TeamClaudePalette.smallFont, shown.state == .unknown ? fg3 : fg2)
        }
        var lines: [(term: String?, value: String, color: NSColor)] = []
        if let evidence = subscriptionEvidenceLine(shown) { lines.append((L10n.subTermEvidence, evidence, fg2)) }
        if subscription.disagrees, let local = subscription.local, let proxy = subscription.proxy {
            func describe(_ view: SubscriptionRecordView) -> String {
                let detail = subscriptionStateDetail(view, now: evaluatedAt)
                return detail.isEmpty ? view.state.label : "\(view.state.label) · \(detail)"
            }
            lines.append((L10n.subTermProxy, "\(describe(proxy))  ·  \(L10n.subTermLocal) \(describe(local))", TeamClaudePalette.amber))
        }
        if lines.count < 2 { lines.append((nil, shown.state.rule, fg3)) }
        for (offset, line) in lines.prefix(2).enumerated() {
            let lineY = y + CGFloat(offset + 1) * 16
            if let term = line.term { PanelDraw.text(term, x, lineY, micro, fg3) }
            let lineX = line.term == nil ? x : valueX
            PanelDraw.text(PanelDraw.clipped(line.value, micro, maxWidth: rightEdge - lineX), lineX, lineY, micro, line.color)
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
        let rowsTop = TeamClaudeCardMetrics.rowsTop(hostLine: health.hostSummaryText != nil)
        let availability = health.routingAvailability(now: evaluatedAt)
        let lines = health.rowLines(now: evaluatedAt)
        let expanded = expandedIndex
        let grouped = teamClaudeGroupedLayout(groups: availability.map(teamClaudeRowGroup), lines: lines, expanded: expanded)
        laidOutLines = lines
        ensureDetailButtons(index: expanded, availability: availability)
        let textX = TeamClaudeColumns.nameX + 14
        let rightEdge = bounds.width - TeamClaudeColumns.padding
        // 재인증은 그 행 상태 칸(이름 줄 오른쪽)에 둔다. 행을 펼치지 않아도 보인다.
        for (button, row) in zip(reauthButtons, reauthenticationRows()) {
            guard let y = grouped.origins[row.index] else { continue }
            button.frame = NSRect(x: rightEdge - 14 - button.fittingWidth, y: rowsTop + y + 2, width: button.fittingWidth, height: PanelButton.height)
        }
        for (button, row) in zip(confirmEndButtons, confirmEndRows()) {
            guard let y = grouped.origins[row.index] else { continue }
            button.frame = NSRect(x: rightEdge - 14 - button.fittingWidth, y: rowsTop + y + 2, width: button.fittingWidth, height: PanelButton.height)
        }
        for (index, button) in subscriptionButtons.enumerated() {
            guard lines.indices.contains(index), let y = grouped.origins[index] else { continue }
            let rowY = rowsTop + y
            if let lineY = teamClaudeSubscriptionLineY(lines[index]) {
                button.isHidden = false
                button.frame = NSRect(x: textX, y: rowY + lineY, width: rightEdge - textX, height: TeamClaudeRowMetrics.subscriptionHeight)
            } else if index == expanded {
                // 기록이 없는 행: 펼친 상세 칸의 "구독" 값 자리가 입력 진입점이다.
                button.isHidden = false
                button.frame = NSRect(x: textX + 60, y: rowY + teamClaudeDetailY(lines[index]) + 4,
                                      width: rightEdge - textX - 60, height: TeamClaudeRowMetrics.subscriptionHeight)
            } else {
                // 접힌 행에서는 그리지 않는다. 버튼은 살아 있어 제목 갱신(프로필 자동 조회)은 계속된다.
                button.isHidden = true
                button.frame = NSRect(x: textX, y: rowY, width: 0, height: 0)
            }
        }
        if let expanded, let y = grouped.origins[expanded] {
            var x = textX
            let buttonY = rowsTop + y + teamClaudeDetailY(lines[expanded]) + TeamClaudeRowMetrics.detailHeight - PanelButton.height - 10
            for button in detailButtons {
                // 폭이 모자라면(영어 문구 등) 뒤쪽 덜 급한 버튼부터 숨긴다. 구독 처리 버튼이 앞에 있다.
                button.isHidden = x + button.fittingWidth > rightEdge
                button.frame = NSRect(x: x, y: buttonY, width: button.fittingWidth, height: PanelButton.height)
                x += button.fittingWidth + 6
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if measureActionRect.contains(point) || measureRowRects.contains(where: { $0.contains(point) }) {
            onMeasure?()
            return
        }
        if let hit = rowHitRects.first(where: { $0.rect.contains(point) }) {
            let isOpen = expandedAccount == hit.name && expandedAccountUuid == hit.accountUuid
            expand(isOpen ? nil : hit.name, accountUuid: hit.accountUuid)
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
        for hit in rowHitRects { addCursorRect(hit.rect, cursor: .pointingHand) }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let health = health else { return }
        measureActionRect = .zero
        measureRowRects.removeAll(keepingCapacity: true)
        rowHitRects.removeAll(keepingCapacity: true)

        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let amber = TeamClaudePalette.amber, ember = TeamClaudePalette.ember
        let caption = TeamClaudePalette.captionFont, micro = TeamClaudePalette.microFont
        let left = TeamClaudeColumns.padding
        let rightEdge = bounds.width - TeamClaudeColumns.padding
        let threshold = health.quotaThresholdPercent.isFinite ? health.quotaThresholdPercent : panelRoutingThresholdPercent

        func probeAttempted(_ row: TeamClaudeAccountHealth) -> Bool {
            row.probedAt != nil || row.totalRequests > 0 || row.totalTokens > 0
        }

        // 서버 줄
        let hostLineShown = health.hostSummaryText != nil
        let topY = TeamClaudeCardMetrics.titleY(hostLine: hostLineShown)
        markDraw("TeamClaudeTableView.header")
        let titleWidth = PanelDraw.text("TeamClaude", left, topY, TeamClaudePalette.panelTitleFont, fg)
        let serverTone: PanelTone = health.serverReachable ? .ready : (health.serverResponseDelayed ? .wait : .error)
        let serverLabel = teamClaudeServerPillLabel(serverReachable: health.serverReachable, responseDelayed: health.serverResponseDelayed)
        PanelDraw.dot(left + titleWidth + 10, centerY: topY + 9, serverTone.color)
        let serverLabelWidth = PanelDraw.text(serverLabel, left + titleWidth + 22, topY + 1.5, caption, serverTone.color)
        let integrationLabel = health.accountConfigDrift == 0 ? L10n.integrationOK : L10n.integrationDrift(health.accountConfigDrift)
        let serverBase = "port \(health.serverPort ?? 0)  ·  pid \(health.serverPid.map(String.init) ?? "-")  ·  \(integrationLabel)"
        let serverColor = health.accountConfigDrift == 0 ? fg3 : amber
        let serverLineX = left + titleWidth + 22 + serverLabelWidth + 16
        let serverLine = teamServerLine(
            base: serverBase,
            full: health.runtimeSummary,
            short: health.runtimeSummaryShort,
            maxWidth: rightEdge - serverLineX,
            measure: { PanelDraw.width($0, micro) }
        )
        PanelDraw.right(PanelDraw.clipped(serverLine, micro, maxWidth: rightEdge - serverLineX), rightEdge, topY + 3, micro, serverColor)
        if let hostText = health.hostSummaryText {
            PanelDraw.text(hostText, left, topY + TeamClaudeCardMetrics.headerHeight, micro, health.hostIsWarning ? ember : fg3)
        }

        // 측정·연동 안내
        let availability = health.routingAvailability(now: evaluatedAt)
        subscriptionButtons.forEach { $0.refreshTitle(now: evaluatedAt) }
        let ready = availability.filter { $0.state == .ready }.count
        let limited = availability.filter { $0.state == .limited }.count
        let excluded = availability.filter { $0.state == .excluded }.count
        let unconfirmed = availability.filter { $0.state == .unconfirmed }.count
        let pendingCount = health.measurementPendingCount
        let actionTone: PanelTone
        let actionTitle: String
        let actionDetail: String
        if isMeasuring {
            actionTone = .info
            actionTitle = L10n.measuringTitle
            actionDetail = measurementDetail ?? L10n.pleaseWait
        } else if health.accountConfigDrift > 0 {
            actionTone = .wait
            actionTitle = L10n.driftTitle(health.accountConfigDrift)
            actionDetail = teamClaudeDriftActionDetail(persistsAfterReload: health.driftPersistsAfterReload)
        } else if pendingCount > 0 {
            actionTone = .wait
            actionTitle = L10n.measurePendingTitle(pendingCount)
            if let measurementDetail, L10n.isFailureDetail(measurementDetail) {
                actionDetail = measurementDetail
            } else {
                actionDetail = L10n.clickToMeasure
            }
        } else if unconfirmed > 0 {
            actionTone = .wait
            actionTitle = L10n.checkNeededTitle(unconfirmed)
            actionDetail = L10n.checkNeededDetail
        } else if excluded > 0 {
            actionTone = .error
            actionTitle = L10n.excludedTitle(excluded)
            actionDetail = L10n.excludedDetail
        } else if limited > 0 {
            actionTone = .wait
            actionTitle = L10n.limitedTitle(limited)
            actionDetail = L10n.limitedDetail
        } else {
            actionTone = ready > 0 ? .ready : .off
            actionTitle = ready > 0 ? L10n.routableReadyTitle(ready) : L10n.noAccounts
            actionDetail = L10n.allWindowsDetail
        }
        let strip = NSRect(x: left, y: TeamClaudeCardMetrics.stripY(hostLine: hostLineShown), width: rightEdge - left,
                           height: TeamClaudeCardMetrics.stripHeight)
        markDraw("TeamClaudeTableView.action")
        PanelDraw.card(strip)
        PanelDraw.dot(strip.minX + 12, centerY: strip.midY, actionTone.color)
        PanelDraw.text(PanelDraw.clipped(actionTitle, TeamClaudePalette.bodyMediumFont, maxWidth: strip.width - 140), strip.minX + 28, strip.minY + 6,
                       TeamClaudePalette.bodyMediumFont, fg)
        PanelDraw.text(PanelDraw.clipped(actionDetail, caption, maxWidth: strip.width - 140), strip.minX + 28, strip.minY + 24, caption, fg3)
        if pendingCount > 0, !isMeasuring, health.accountConfigDrift == 0 {
            measureActionRect = strip
            let chip = L10n.measureNow
            let chipWidth = PanelDraw.width(chip, TeamClaudePalette.buttonFont) + 22
            let chipRect = NSRect(x: strip.maxX - 10 - chipWidth, y: strip.midY - 13, width: chipWidth, height: 26)
            PanelDraw.strokeRound(chipRect, TeamClaudePalette.graphite, 8)
            PanelDraw.text(chip, chipRect.minX + 11, chipRect.minY + 5, TeamClaudePalette.buttonFont, fg)
        }

        // 열 머리 — 리셋은 여기서 한 번 말한다(살아 있는 계정 중 가장 빠른 리셋).
        let headY = TeamClaudeCardMetrics.tableHeadY(hostLine: hostLineShown)
        func soonest(_ pick: (TeamClaudeAccountHealth) -> (Int?, Date?)) -> String {
            let values = zip(health.accounts, availability).compactMap { row, state -> Double? in
                guard teamClaudeRowGroup(state) != .excluded else { return nil }
                let (seconds, resetAt) = pick(row)
                return teamClaudeRemainingSeconds(seconds, resetAt: resetAt, checkedAt: health.checkedAt, now: evaluatedAt)
            }.filter { $0 > 0 }
            guard let first = values.min() else { return StatusVocabulary.none }
            return L10n.resetIn(L10n.duration(seconds: Int(first.rounded(.up))))
        }
        PanelDraw.meta(L10n.accountsCount(health.accounts.count), left, headY + 4)
        let columns: [(CGFloat, String, String)] = [
            (TeamClaudeColumns.sessionX, L10n.columnSession, soonest { ($0.sessionResetSeconds, $0.sessionResetAt) }),
            (TeamClaudeColumns.weeklyX, L10n.columnWeekly, soonest { ($0.weeklyResetSeconds, $0.weeklyResetAt) }),
            (TeamClaudeColumns.fableX, L10n.columnFable, soonest { ($0.fableResetSeconds, $0.fableResetAt) }),
        ]
        for (x, title, reset) in columns {
            PanelDraw.meta(title, x, headY + 4)
            PanelDraw.text(PanelDraw.clipped(reset, micro, maxWidth: TeamClaudeColumns.meterWidth), x, headY + 19, micro, fg3)
        }
        PanelDraw.right(L10n.columnStatus, rightEdge, headY + 4, TeamClaudePalette.metaFont, fg3, kern: TeamClaudePalette.metaKern)
        PanelDraw.hairline(left, rightEdge, headY + TeamClaudeCardMetrics.tableHeadHeight - 1)

        markDraw("TeamClaudeTableView.rows")
        // layout()·contentHeight와 같은 판정으로 행 원점을 잡는다. 여기서 다른 기준을 쓰면 버튼과 글자가 어긋난다.
        let lines = health.rowLines(now: evaluatedAt, availability: availability)
        let groups = availability.map(teamClaudeRowGroup)
        let expanded = expandedIndex
        let grouped = teamClaudeGroupedLayout(groups: groups, lines: lines, expanded: expanded)
        let rowsTop = TeamClaudeCardMetrics.rowsTop(hostLine: hostLineShown)
        let subscriptions = health.subscriptionResolutions(now: evaluatedAt)
        for heading in grouped.headings {
            let y = rowsTop + heading.y + 9
            let tone: PanelTone
            let title: String
            let note: String
            switch heading.group {
            case .ready: tone = .ready; title = L10n.groupReady; note = L10n.groupReadyNote
            case .limited: tone = .wait; title = L10n.groupLimited; note = L10n.groupLimitedNote
            case .check: tone = .wait; title = L10n.groupCheck; note = L10n.groupCheckNote
            case .excluded: tone = .error; title = L10n.groupExcluded; note = L10n.groupExcludedNote
            }
            PanelDraw.dot(left + 2, centerY: y + 7.5, tone.color)
            let titleW = PanelDraw.text(title, left + 16, y, TeamClaudePalette.legendMediumFont, fg2)
            PanelDraw.text("\(heading.count)", left + 16 + titleW + 6, y + 0.5, TeamClaudePalette.smallFont, fg3)
            PanelDraw.right(note, rightEdge, y, TeamClaudePalette.legendFont, fg3)
        }

        for i in grouped.order {
            let row = health.accounts[i]
            guard let origin = grouped.origins[i] else { continue }
            let y = rowsTop + origin
            let isExpanded = i == expanded
            let rowRect = NSRect(x: left - 6, y: y, width: rightEdge - left + 12, height: teamClaudeRowHeight(lines[i], expanded: isExpanded))
            let state = availability[i]
            let presentation = teamClaudeRowPresentation(row, state)
            let subscriptionMuted = state.subscriptionAppearance.isMuted
            if isExpanded { PanelDraw.fillRound(rowRect, NSColor.white.withAlphaComponent(0.03), 8) }
            rowHitRects.append((row.name, row.accountUuid, NSRect(x: rowRect.minX, y: rowRect.minY, width: rowRect.width, height: TeamClaudeRowMetrics.nameHeight)))
            let dotColor = subscriptionMuted ? fg3 : presentation.tone.color
            PanelDraw.dot(left + 2, centerY: y + 15, dotColor)
            let textX = TeamClaudeColumns.nameX + 14
            let nameColor = subscriptionMuted ? fg3 : presentation.excluded || row.status == "configured" ? fg2 : fg
            // 이름 옆 구독 기호(시안 B). 기호 자리(6 + 11pt)를 이름 폭에서 뺀다.
            let nameWidth = PanelDraw.text(PanelDraw.clipped(row.name, TeamClaudePalette.nameFont,
                                                             maxWidth: TeamClaudeColumns.nameWidth - 14 - SubscriptionGlyph.size - 6),
                                           textX, y + 7, TeamClaudePalette.nameFont, nameColor)
            SubscriptionGlyph.draw(subscriptions[i].state, x: textX + nameWidth + 6, y: y + 9.5,
                                   progress: subscriptionCancelProgress(subscriptions[i].shown, now: evaluatedAt))
            if let reasonY = teamClaudeReasonLineY(lines[i]) {
                PanelDraw.text(PanelDraw.clipped(state.reason, micro, maxWidth: rightEdge - textX), textX, y + reasonY - 2, micro,
                               dotColor.withAlphaComponent(0.9))
            }

            // 막대 세 칸. 값이 없으면 막대 대신 그 이유를 쓴다(빈 값 어휘).
            func meterCell(_ x: CGFloat, percent: Double?, remaining: Double?, window: Double, empty: String) {
                let cell = NSRect(x: x, y: y + 8, width: TeamClaudeColumns.meterWidth, height: 14)
                if state.subscriptionAppearance == .ended {
                    PanelDraw.right(StatusVocabulary.none, cell.maxX, cell.minY, TeamClaudePalette.numberFont, fg3)
                    return
                }
                guard let percent else {
                    PanelDraw.text(PanelDraw.clipped(empty, micro, maxWidth: cell.width), cell.minX, cell.minY + 0.5, micro,
                                   empty == StatusVocabulary.syncing ? amber : fg3)
                    return
                }
                PanelDraw.meterWithValue(cell, percent: percent,
                                         elapsed: panelWindowElapsed(remainingSeconds: remaining, windowSeconds: window),
                                         muted: presentation.excluded || subscriptionMuted, thresholdPercent: threshold)
            }
            let attempted = probeAttempted(row)
            let session = teamClaudeSessionState(percent: row.sessionPercent, lastUsed: row.probedAt, now: evaluatedAt)
            let sessionEmpty = session.isStale
                ? (row.measurementIssue == .quotaBlocked ? L10n.quotaReset : L10n.remeasure)
                : (attempted ? StatusVocabulary.needsCheck : StatusVocabulary.notMeasured)
            meterCell(TeamClaudeColumns.sessionX, percent: session.isStale ? nil : session.percent,
                      remaining: teamClaudeRemainingSeconds(row.sessionResetSeconds, resetAt: row.sessionResetAt, checkedAt: health.checkedAt, now: evaluatedAt),
                      window: teamClaudeSessionSeconds, empty: sessionEmpty)
            // 주간·Fable 독립 표시 — 프록시는 재시작 후 Fable(7d_oi) 창을 의도적으로
            // 스냅샷 복원하지 않고 재측정한다(self-lock 방지). 구 all-four 페어링
            // 가드(teamClaudeQuotaPair)는 Fable 미측정 계정의 주간 표시까지 막아
            // 두 열 모두 "동기화중"으로 떨어뜨렸다 (2026-07-22 사고).
            meterCell(TeamClaudeColumns.weeklyX, percent: row.weeklyPercent,
                      remaining: teamClaudeRemainingSeconds(row.weeklyResetSeconds, resetAt: row.weeklyResetAt, checkedAt: health.checkedAt, now: evaluatedAt),
                      window: teamClaudeWeekSeconds, empty: StatusVocabulary.syncing)
            meterCell(TeamClaudeColumns.fableX, percent: row.fablePercent,
                      remaining: teamClaudeRemainingSeconds(row.fableResetSeconds, resetAt: row.fableResetAt, checkedAt: health.checkedAt, now: evaluatedAt),
                      window: teamClaudeWeekSeconds, empty: StatusVocabulary.notMeasured)

            // 상태 칸: 재인증 버튼(layout이 배치) · 오류 사유 · 측정 · 측정 문제 · 상태 라벨. 맨 오른쪽은 펼침 표시.
            let chevron = isExpanded ? "⌃" : "⌄"
            PanelDraw.right(chevron, rightEdge, y + 6, micro, fg3)
            let statusRight = rightEdge - 14
            let statusWidth = statusRight - TeamClaudeColumns.statusX
            let canReauth = teamClaudeCanReauthenticate(enabled: row.enabled, status: row.status, source: row.source,
                                                        provider: row.provider, errorReason: row.errorReason)
            if canReauth, state.subscriptionAppearance != .ended {
                // 버튼이 자리를 쓴다.
            } else if row.status == "error" {
                PanelDraw.right(PanelDraw.clipped(teamAccountErrorReasonLabel(row.errorReason), caption, maxWidth: statusWidth), statusRight, y + 8, caption, ember)
            } else if let issue = row.measurementIssue, state.subscriptionAppearance != .ended {
                if issue.canMeasureNow && !isMeasuring && !subscriptionMuted {
                    let chipWidth = PanelDraw.width(L10n.measure, TeamClaudePalette.buttonFont) + 20
                    let chipRect = NSRect(x: statusRight - chipWidth, y: y + 3, width: chipWidth, height: 24)
                    PanelDraw.strokeRound(chipRect, TeamClaudePalette.graphite, 7)
                    PanelDraw.text(L10n.measure, chipRect.minX + 10, chipRect.minY + 4.5, TeamClaudePalette.buttonFont, fg)
                    measureRowRects.append(chipRect)
                } else {
                    PanelDraw.right(PanelDraw.clipped(issue.compactText, micro, maxWidth: statusWidth), statusRight, y + 9, micro, issue == .quotaBlocked ? amber : fg3)
                }
            } else {
                // 동시 요청이 가득 찬 행은 "사용 중 3/3"(presentation)이 이긴다. 현재 계정의 "사용 중"보다 정보가 많다.
                let label = row.isCurrent && state.state == .ready && state.busy == nil ? L10n.stateInUse : presentation.label
                PanelDraw.right(PanelDraw.clipped(label, caption, maxWidth: statusWidth), statusRight, y + 8, caption,
                                subscriptionMuted ? fg3 : presentation.tone.color)
            }

            // 펼친 상세: 구독 · 동시 요청 · 누적 요청 · 마지막 측정, 창별 리셋. 동작 버튼은 layout이 배치한다.
            if isExpanded {
                let detailY = y + teamClaudeDetailY(lines[i])
                if !lines[i].subscription {
                    PanelDraw.text(L10n.factSubscription, textX, detailY + 8, micro, fg3)
                }
                let facts: [(String, String)] = [
                    (L10n.factConcurrent, "\(row.inflightCount.map(String.init) ?? "-") / \(row.concurrentCapacity.map(String.init) ?? "-")"),
                    (L10n.factRequests, L10n.requestCount(row.totalRequests)),
                    (L10n.factLastProbe, formatTeamClaudeProbe(row.probedAt)),
                ]
                // 구독 기록 세 줄: 상태 · 근거 · (로컬/프록시가 다르면 두 값, 아니면 규칙).
                let recordY = detailY + (lines[i].subscription ? 6 : 30)
                drawSubscriptionRecord(subscriptions[i], x: textX, y: recordY, rightEdge: rightEdge)
                var factX = textX
                let factY = recordY + TeamClaudeRowMetrics.recordHeight
                for (term, value) in facts {
                    let termWidth = PanelDraw.text(term, factX, factY, micro, fg3)
                    let valueWidth = PanelDraw.text(value, factX + termWidth + 6, factY, TeamClaudePalette.smallFont, fg2)
                    factX += termWidth + valueWidth + 20
                }
                let resets = [
                    "\(L10n.sessionShort) \(teamClaudeResetLabel(row.sessionResetSeconds, checkedAt: health.checkedAt, now: evaluatedAt, resetAt: row.sessionResetAt))",
                    "\(L10n.weeklyShort) \(teamClaudeResetLabel(row.weeklyResetSeconds, checkedAt: health.checkedAt, now: evaluatedAt, resetAt: row.weeklyResetAt))",
                    "Fable \(teamClaudeResetLabel(row.fableResetSeconds, checkedAt: health.checkedAt, now: evaluatedAt, resetAt: row.fableResetAt))",
                ].joined(separator: " · ")
                PanelDraw.text(PanelDraw.clipped(L10n.resetsLine(resets), micro, maxWidth: rightEdge - textX), textX, factY + 18, micro, fg3)
            }
        }

        window?.invalidateCursorRects(for: self)

        // 범례
        let footerY = bounds.height - TeamClaudeCardMetrics.footerHeight + 12
        TeamClaudePalette.sky.setFill()
        NSBezierPath(roundedRect: NSRect(x: left, y: footerY + 2, width: 2, height: 10), xRadius: 1, yRadius: 1).fill()
        var legendX = left + 8 + PanelDraw.text(L10n.legendElapsedTick, left + 8, footerY, micro, fg3) + 14
        PanelDraw.fillRound(NSRect(x: legendX, y: footerY + 4, width: 12, height: 6), amber, 3)
        let thresholdLabel = String(format: "%.0f", threshold)
        legendX += 18 + PanelDraw.text(L10n.legendThreshold(thresholdLabel), legendX + 18, footerY, micro, fg3) + 14
        PanelDraw.text(PanelDraw.clipped(L10n.legendRowClick, micro, maxWidth: rightEdge - legendX), legendX, footerY, micro, fg3)
        markDraw("TeamClaudeTableView.done")
    }
}

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

/// 메뉴 대시보드 패널(A안, menubar/DESIGN.md). 머리(제목·기준 시각·손볼 것)와 탭 5개, 본문, 하단 동작 막대.
/// 패널 높이는 개요 탭의 자연 높이(최소 minimumBodyHeight, 화면 높이 maxBodyHeight 이하)다. 그보다 긴 탭(계정이 많은 Claude 탭 등)은
/// 본문 안쪽 스크롤 뷰에서 움직인다. 예전엔 가장 긴 탭에 맞춰 계정 20개면 개요 아래 절반이 비었다(실사용 QA 2026-10-25).
/// 탭을 바꾸면 그 스크롤 뷰의 문서만 갈아 끼운다 — 메뉴 항목의 뷰와 기하는 그대로라 열린 메뉴가 흔들리지 않는다.
final class StatusMenuDashboardView: NSView {
    var lastRefreshPhases: DashboardRefreshPhases?
    static let preferredWidth: CGFloat = 520
    static let chromeHeight: CGFloat = DashboardPanelHeaderView.preferredHeight + DashboardPanelFooterView.preferredHeight
    /// 동작 목록이 본문 위에 다 들어가도록 본문 최소 높이를 둔다.
    static let minimumBodyHeight: CGFloat = 400
    /// 탭 본문 위아래 여백.
    static let bodyInset: CGFloat = 8

    private let header = DashboardPanelHeaderView(frame: .zero)
    private let footer = DashboardPanelFooterView(frame: .zero)
    private let bodyScroll = NSScrollView(frame: .zero)
    private let scrim = DashboardScrimView(frame: .zero)
    private let actionList = DashboardActionListView(frame: .zero)
    private var tabDocuments: [DashboardTab: PanelFlippedView] = [:]
    private var tabScrollOrigins: [DashboardTab: NSPoint] = [:]
    private(set) var selectedTab: DashboardTab = .overview
    private(set) var actionsOpen = false
    /// 본문이 차지할 수 있는 최대 높이. 호스트(AppDelegate)가 화면 높이로 정한다.
    var maxBodyHeight: CGFloat = .greatestFiniteMagnitude
    /// 메뉴가 열려 있는 동안 참이다. 그동안은 갱신이 구조를 바꿔도 패널 높이를 바꾸지 않는다(열린 메뉴가 흔들리지 않게).
    /// 호스트가 menuWillOpen에서 켜고 menuDidClose에서 끈 뒤 닫힌 상태의 높이로 다시 맞춘다.
    var heightFrozen = false
    var onRefresh: (() -> Void)?
    var actions: [DashboardAction] = [] {
        didSet { actionList.actions = actions; needsLayout = true }
    }

    private var overviewView: OverviewTabView?
    private var teamClaudeView: TeamClaudeTableView?
    private var codexView: CodexStatusView?
    private var higgsfieldView: HiggsfieldCreditsView?
    private var cliLanesView: CliQuotaLanesView?
    private var burnView: SubscriptionBurnView?
    private var usageView: UsageDashboardView?
    /// 모든 섹션(탭 구분 없이). 헤더 요약과 스냅샷 출력이 읽는다.
    private(set) var sections: [DashboardSection] = []
    private var headerViews: [DashboardSectionHeaderView] = []
    private var overviewModel = OverviewModel()
    /// 펼친 Claude 계정. 구조 재구성(configure)을 지나도 펼친 행을 유지한다.
    private var expandedClaudeAccount: String?
    private var expandedClaudeAccountUuid: String?
    /// 펼친 Codex 계정(구독 기록). Claude와 같은 규칙.
    private var expandedCodexAccount: String?
    private var expandedCodexAccountUuid: String?
    private var renderedCodexHeight: CGFloat = 0
    /// 직전 구독 처리의 되돌리기. 하단 막대에 6초 보인다.
    private var subscriptionUndo: SubscriptionUndo?
    private var subscriptionNoticeTimer: Timer?
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
    private var renderedOverviewHeight: CGFloat = 0
    private var renderedNotices = DashboardToolNotices()
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        bodyScroll.hasVerticalScroller = true
        bodyScroll.autohidesScrollers = true
        bodyScroll.scrollerStyle = .overlay
        bodyScroll.drawsBackground = false
        bodyScroll.borderType = .noBorder
        bodyScroll.verticalScrollElasticity = .allowed
        header.onSelectTab = { [weak self] tab in self?.selectTab(tab) }
        header.onBadge = { [weak self] in self?.selectTab(.overview) }
        footer.onRefresh = { [weak self] in self?.onRefresh?() }
        footer.onUndo = { [weak self] in self?.undoSubscriptionAction() }
        footer.onActions = { [weak self] in self?.setActionsOpen(!(self?.actionsOpen ?? true)) }
        scrim.onClick = { [weak self] in self?.setActionsOpen(false) }
        scrim.isHidden = true
        actionList.isHidden = true
        actionList.onRun = { [weak self] action in
            guard let self else { return }
            let detail = action.run()
            if let detail { self.actionList.updateDetail(id: action.id, detail: detail) }
            if action.closesMenu { self.setActionsOpen(false) }
        }
        for view in [bodyScroll, header, footer, scrim, actionList] as [NSView] { addSubview(view) }
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        TeamClaudePalette.sheet.setFill()
        bounds.fill()
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        let headerHeight = DashboardPanelHeaderView.preferredHeight
        let footerHeight = DashboardPanelFooterView.preferredHeight
        header.frame = NSRect(x: 0, y: 0, width: width, height: headerHeight)
        footer.frame = NSRect(x: 0, y: bounds.height - footerHeight, width: width, height: footerHeight)
        bodyScroll.frame = NSRect(x: 0, y: headerHeight, width: width, height: max(0, bounds.height - headerHeight - footerHeight))
        for document in tabDocuments.values { document.frame.size.width = width }
        scrim.frame = NSRect(x: 0, y: 0, width: width, height: bounds.height - footerHeight)
        let listHeight = DashboardActionListView.preferredHeight(actions)
        actionList.frame = NSRect(x: width - 8 - DashboardActionListView.width,
                                  y: max(8, bounds.height - footerHeight - 6 - listHeight),
                                  width: DashboardActionListView.width, height: listHeight)
    }

    // MARK: 탭·동작 목록·단축키

    func selectTab(_ tab: DashboardTab) {
        if tab != selectedTab, bodyScroll.documentView != nil {
            tabScrollOrigins[selectedTab] = bodyScroll.contentView.bounds.origin
        }
        selectedTab = tab
        header.selectedTab = tab
        setActionsOpen(false)
        showSelectedTab(restoring: tabScrollOrigins[tab] ?? .zero)
    }

    func setActionsOpen(_ open: Bool) {
        guard open != actionsOpen else { return }
        actionsOpen = open
        footer.actionsOpen = open
        scrim.isHidden = !open
        actionList.isHidden = !open
        needsLayout = true
    }

    /// 단축키 판정(DashboardShortcut)을 실행한다.
    func perform(_ shortcut: DashboardShortcut) {
        switch shortcut {
        case .tab(let tab): selectTab(tab)
        case .refresh: onRefresh?()
        case .toggleActions: setActionsOpen(!actionsOpen)
        }
    }

    func qaSnapshot(statusTitle: String, menuOpen: Bool, teamCodex: TeamCodexPoolHealth?) -> QAStateSnapshot {
        QAStateSnapshot(statusTitle: statusTitle, selectedTab: selectedTab.id,
                        claudeRoutable: overviewModel.routable, claudeTotal: overviewModel.total,
                        teamCodexUsable: teamCodex?.usableCount ?? 0, teamCodexTotal: teamCodex?.poolCount ?? 0,
                        menuOpen: menuOpen, panelWidth: Double(bounds.width), panelHeight: Double(bounds.height))
    }

    func updateActionDetail(id: String, detail: String) {
        actionList.updateDetail(id: id, detail: detail)
    }

    /// 지금 탭 본문의 스크롤 위치. 갱신 전후로 같은 자리를 지킨다.
    var bodyScrollOrigin: NSPoint { bodyScroll.contentView.bounds.origin }

    func restoreBodyScroll(_ origin: NSPoint) {
        guard let document = bodyScroll.documentView else { return }
        let maximumY = max(0, document.frame.height - bodyScroll.contentView.bounds.height)
        bodyScroll.contentView.scroll(to: NSPoint(x: 0, y: min(max(origin.y, 0), maximumY)))
        bodyScroll.reflectScrolledClipView(bodyScroll.contentView)
    }

    private func showSelectedTab(restoring origin: NSPoint) {
        guard let document = tabDocuments[selectedTab] else { return }
        if bodyScroll.documentView !== document { bodyScroll.documentView = document }
        restoreBodyScroll(origin)
        footer.context = footerContext(for: selectedTab)
    }

    private func footerContext(for tab: DashboardTab) -> String {
        switch tab {
        case .overview: return L10n.footerOverview(todo: overviewModel.todos.count, waiting: overviewModel.waitCount)
        case .claude: return sections.first { $0.id == "claude" }?.summary ?? ""
        case .codex: return sections.first { $0.id == "codex" }?.summary ?? ""
        case .burn: return L10n.footerBurn
        case .cli: return L10n.footerCli
        }
    }

    // MARK: 구독 처리 결과(하단 막대)

    /// 처리 결과를 하단 막대 왼쪽에 6초 보인다. 성공이면 "되돌리기"를 함께 둔다.
    func showSubscriptionOutcome(_ outcome: SubscriptionOutcome) {
        subscriptionNoticeTimer?.invalidate()
        subscriptionUndo = outcome.undo
        footer.notice = DashboardFooterNotice(text: outcome.message, failed: !outcome.succeeded, undo: outcome.undo != nil)
        let timer = Timer(timeInterval: 6, repeats: false) { [weak self] _ in self?.clearSubscriptionNotice() }
        RunLoop.main.add(timer, forMode: .common)
        subscriptionNoticeTimer = timer
    }

    private func clearSubscriptionNotice() {
        subscriptionNoticeTimer?.invalidate()
        subscriptionNoticeTimer = nil
        subscriptionUndo = nil
        footer.notice = nil
    }

    private func undoSubscriptionAction() {
        guard let undo = subscriptionUndo else { return }
        clearSubscriptionNotice()
        SubscriptionActionCenter.shared.undo(undo) { outcome in SubscriptionActionCenter.shared.onOutcome?(outcome) }
    }

    // MARK: 높이

    static func teamContentHeight(_ health: TeamClaudeHealth?, now: Date = Date()) -> CGFloat {
        guard let health = health else { return 0 }
        // 표의 layout()/draw()와 같은 판정(rowLines + 상태 묶음)으로 잰다. 펼친 행이 없는 높이다.
        return TeamClaudeTableView.contentHeight(health, expanded: nil, now: now)
    }

    static func codexHeight(_ health: CodexHealth?, teamCodex: TeamCodexPoolHealth?) -> CGFloat {
        health == nil && teamCodex == nil ? 0 : CodexStatusView.preferredHeight(for: teamCodex)
    }

    /// "CLI 쿼터" 본문 = Grok·agy 두 레인이 든 카드 한 장. 두 모델은 옵셔널이 아니라 항상 그린다.
    static let cliHeight: CGFloat = CliQuotaLanesView.fixedHeight

    /// 미설치 안내가 있는 섹션은 본문 대신 안내 카드 높이를 쓴다. preferredHeight·configure가 같은 판정을 본다.
    static func bodyHeight(_ id: String, _ natural: CGFloat, _ notices: DashboardToolNotices) -> CGFloat {
        dashboardNoticeBodyHeight(section: id, natural: natural, notices: notices)
    }

    /// 탭별 섹션 본문. 순서는 탭 안의 위→아래 순서다. preferredHeight와 configure가 이 한 목록을 쓴다.
    static func sectionBodies(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?,
                              higgsfield: HiggsfieldCreditsData?, burnModel: SubscriptionBurnModel, notices: DashboardToolNotices,
                              summaries: [String: String]) -> [DashboardTab: [(id: String, title: String, summary: String, height: CGFloat)]] {
        [
            .claude: [(id: "claude", title: L10n.sectionClaude, summary: summaries["claude"] ?? "", height: bodyHeight("claude", teamContentHeight(teamClaude), notices))],
            .codex: [(id: "codex", title: L10n.sectionCodex, summary: summaries["codex"] ?? "", height: bodyHeight("codex", codexHeight(codex, teamCodex: teamCodex), notices))],
            .burn: [(id: "burn", title: L10n.sectionBurn, summary: summaries["burn"] ?? "", height: SubscriptionBurnView.preferredHeight(burnModel)),
                    (id: "usage", title: L10n.sectionUsage, summary: summaries["usage"] ?? "", height: bodyHeight("usage", UsageDashboardView.preferredHeight(for: usage), notices))],
            .cli: [(id: "cli", title: L10n.sectionCli, summary: summaries["cli"] ?? "", height: cliHeight),
                   (id: "higgsfield", title: "Higgsfield", summary: summaries["higgsfield"] ?? "", height: bodyHeight("higgsfield", HiggsfieldCreditsView.preferredHeight(for: higgsfield), notices)),
                   (id: "vocabulary", title: L10n.sectionVocabulary, summary: "", height: EmptyValueVocabularyView.preferredHeight)],
        ]
    }

    /// 개요 탭 모델. 높이 계산만 할 때는 Grok·agy 문구가 높이에 영향을 주지 않으므로 빈 값으로 만든다.
    static func overviewModel(teamClaude: TeamClaudeHealth?, teamCodex: TeamCodexPoolHealth?, grok: GrokCardModel, agy: AgyCardModel,
                              burnModel: SubscriptionBurnModel, notices: DashboardToolNotices, now: Date = Date()) -> OverviewModel {
        makeOverviewModel(DashboardOverviewInput(teamClaude: teamClaude, teamCodex: teamCodex, grok: grok, agy: agy,
                                                 burn: burnModel, notices: notices, now: now))
    }

    static func tabContentHeights(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?,
                                  higgsfield: HiggsfieldCreditsData?, burnModel: SubscriptionBurnModel, notices: DashboardToolNotices,
                                  overview: OverviewModel) -> [DashboardTab: CGFloat] {
        var heights: [DashboardTab: CGFloat] = [.overview: OverviewTabView.preferredHeight(overview)]
        let bodies = sectionBodies(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield,
                                   burnModel: burnModel, notices: notices, summaries: [:])
        for (tab, list) in bodies {
            let layout = dashboardSectionLayout(startY: bodyInset, bodies: list)
            heights[tab] = layout.sections.isEmpty ? PanelEmptyStateView.preferredHeight : layout.totalHeight + bodyInset
        }
        return heights
    }

    /// 패널 높이 = 머리 + 본문(개요 탭 자연 높이, 최소 minimumBodyHeight, 최대 maxBodyHeight) + 하단 막대.
    /// 다른 탭은 이 높이 안에서 스크롤한다. tab을 주면 그 탭 내용에 맞춘다(스냅샷).
    static func preferredHeight(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?, higgsfield: HiggsfieldCreditsData? = nil,
                                burnModel: SubscriptionBurnModel, notices: DashboardToolNotices, maxBodyHeight: CGFloat, tab: DashboardTab? = nil) -> CGFloat {
        let overview = overviewModel(teamClaude: teamClaude, teamCodex: teamCodex, grok: GrokCardModel(headline: "", detail: nil),
                                     agy: AgyCardModel(message: nil, groups: []), burnModel: burnModel, notices: notices)
        let heights = tabContentHeights(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield,
                                        burnModel: burnModel, notices: notices, overview: overview)
        let content = tab.flatMap { heights[$0] } ?? max(heights[.overview] ?? 0, minimumBodyHeight)
        return chromeHeight + min(content, maxBodyHeight)
    }

    /// 섹션 헤더 우측 한 줄 요약. 모델에 이미 있는 값만 쓰고, 모르면 빈 문자열(헤더는 제목만 그린다).
    static func sectionSummaries(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?, higgsfield: HiggsfieldCreditsData?,
                                 notices: DashboardToolNotices, staleNotes: [String: String]) -> [String: String] {
        var out = naturalSectionSummaries(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield)
        // 사용량 갱신이 실패해 이전 값을 보이는 중이면 헤더 요약에도 그 사실을 붙인다(카드 본문과 같은 꼬리말).
        if let note = staleNotes["usage"], let natural = out["usage"] {
            out["usage"] = "\(natural) · \(note)"
        }
        // 미설치 안내가 있는 섹션은 헤더 요약도 같은 안내 제목을 말한다(소비 지점마다 같은 상태).
        for id in notices.sections.keys {
            out[id] = dashboardNoticeSummary(section: id, natural: out[id], notices: notices)
        }
        return out
    }

    private static func naturalSectionSummaries(teamClaude: TeamClaudeHealth?, codex: CodexHealth?, teamCodex: TeamCodexPoolHealth?, usage: UsageData?, higgsfield: HiggsfieldCreditsData?) -> [String: String] {
        var out: [String: String] = [:]
        if let teamClaude {
            // 개요 큰 숫자와 같은 숫자: 전체 계정 수, 지금 라우팅 가능한 계정 수(프록시 usable·동시 요청 가득 포함).
            let usable = teamClaude.routableCount
            out["claude"] = L10n.claudeSectionSummary(accounts: teamClaude.accounts.count, usable: usable)
        }
        if let teamCodex {
            out["codex"] = L10n.codexSectionSummary(status: teamCodex.statusLabel, usable: teamCodex.usableCount, pool: teamCodex.poolCount)
        } else if let codex {
            out["codex"] = codex.statusLabel
        }
        if let higgsfield, higgsfield.error == nil {
            out["higgsfield"] = higgsfieldFormatCredits(higgsfield.credits)
        }
        out["cli"] = "Grok · agy"
        if let usage, let today = usage.today {
            out["usage"] = L10n.usageSectionSummary(today: formatKRWShort(today.totalCost, rate: usage.usdKrwRate), total: formatTokens(usage.allTimeTokens))
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
        footer.context = footerContext(for: selectedTab)
    }

    private func applyChrome(_ overview: OverviewModel, now: Date) {
        overviewModel = overview
        header.todoCount = overview.todos.count
        header.stamp = L10n.asOf(dashboardStampFormatter.string(from: now))
        header.selectedTab = selectedTab
    }

    // MARK: 구성

    func configure(
        teamClaude: TeamClaudeHealth?,
        codex: CodexHealth?,
        teamCodex: TeamCodexPoolHealth?,
        usage: UsageData?,
        higgsfield: HiggsfieldCreditsData? = nil,
        grok: GrokCardModel = GrokCardModel(headline: L10n.grokChecking, detail: nil),
        agy: AgyCardModel = AgyCardModel(message: L10n.agyChecking, groups: []),
        burnModel: SubscriptionBurnModel,
        notices: DashboardToolNotices,
        laneStaleNotes: [String: String] = [:],
        parallelCount: Int,
        active: Bool,
        isMeasuringTeamClaude: Bool,
        teamClaudeMeasureDetail: String?,
        onMeasureTeamClaude: (() -> Void)?,
        onReauthenticateTeamClaude: ((String, String?) -> Void)? = nil,
        onRecoverTeamCodex: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)? = nil
    ) {
        let previousOrigin = bodyScroll.documentView == nil ? nil : bodyScroll.contentView.bounds.origin
        let now = Date()
        bodyScroll.documentView = nil
        tabDocuments = [:]
        headerViews = []
        overviewView = nil
        teamClaudeView = nil
        codexView = nil
        higgsfieldView = nil
        cliLanesView = nil
        burnView = nil
        usageView = nil
        renderedNotices = notices
        renderedAccountCount = teamClaude?.accounts.count ?? 0
        renderedTeamClaudePresent = teamClaude != nil
        renderedCodexPresent = codex != nil
        renderedTeamCodexAccountCount = teamCodex?.accounts.count ?? 0
        renderedTeamCodexPresent = teamCodex != nil
        renderedUsageHeight = UsageDashboardView.preferredHeight(for: usage)
        renderedHiggsfieldHeight = HiggsfieldCreditsView.preferredHeight(for: higgsfield)
        renderedTeamHeight = Self.teamContentHeight(teamClaude)
        renderedCodexHeight = Self.codexHeight(codex, teamCodex: teamCodex)
        let width = bounds.width

        // 개요
        let overview = Self.overviewModel(teamClaude: teamClaude, teamCodex: teamCodex, grok: grok, agy: agy,
                                          burnModel: burnModel, notices: notices, now: now)
        renderedOverviewHeight = OverviewTabView.preferredHeight(overview)
        applyChrome(overview, now: now)
        let overviewDocument = PanelFlippedView(frame: NSRect(x: 0, y: 0, width: width, height: renderedOverviewHeight))
        let overviewView = OverviewTabView(frame: overviewDocument.bounds)
        overviewView.autoresizingMask = [.width]
        overviewView.model = overview
        overviewView.onSelectTab = { [weak self] tab in self?.selectTab(tab) }
        overviewView.onOpenAccount = { [weak self] name in self?.openAccount(name) }
        overviewView.onTodo = { [weak self] todo in
            self?.runTodo(todo, onReauthenticate: onReauthenticateTeamClaude, onRecover: onRecoverTeamCodex)
        }
        overviewDocument.addSubview(overviewView)
        tabDocuments[.overview] = overviewDocument
        self.overviewView = overviewView

        // 나머지 탭. preferredHeight와 같은 목록·같은 높이. 섹션을 더하면 sectionBodies와 sectionSummaries를 같이 고친다.
        let summaries = Self.sectionSummaries(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield, notices: notices, staleNotes: laneStaleNotes)
        let bodies = Self.sectionBodies(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield,
                                        burnModel: burnModel, notices: notices, summaries: summaries)
        var allSections: [DashboardSection] = []
        for tab in DashboardTab.allCases where tab != .overview {
            let layout = dashboardSectionLayout(startY: Self.bodyInset, bodies: bodies[tab] ?? [])
            let document = PanelFlippedView(frame: NSRect(x: 0, y: 0, width: width, height: layout.totalHeight + Self.bodyInset))
            tabDocuments[tab] = document
            if layout.sections.isEmpty {
                // 그릴 데이터가 아직 없다(로딩 중이거나 연동 전). 빈 탭 대신 무엇이 올지 말한다.
                let empty = PanelEmptyStateView(frame: NSRect(x: 0, y: 0, width: width, height: PanelEmptyStateView.preferredHeight))
                empty.title = tab == .codex ? L10n.codexEmptyTitle : StatusVocabulary.checking
                empty.detail = tab == .codex ? L10n.codexEmptyDetail : L10n.waitingForValue
                empty.autoresizingMask = [.width]
                document.frame.size.height = PanelEmptyStateView.preferredHeight
                document.addSubview(empty)
            }
            allSections += layout.sections
            for section in layout.sections {
                let sectionHeader = DashboardSectionHeaderView(frame: NSRect(x: 0, y: section.y, width: width, height: dashboardSectionHeaderHeight))
                sectionHeader.section = section
                sectionHeader.autoresizingMask = [.width]
                document.addSubview(sectionHeader)
                headerViews.append(sectionHeader)
                let bodyY = dashboardSectionBodyY(section)
                let bodyHeight = section.height - dashboardSectionHeaderHeight - dashboardSectionGap
                let frame = NSRect(x: 0, y: bodyY, width: width, height: bodyHeight)

                // 도구가 없는 섹션은 본문 대신 공통 안내 카드를 둔다(구독 섹션은 카드 안에 안내 줄을 더한다).
                if section.id != "burn", let notice = notices.sections[section.id] {
                    let noticeView = ToolNoticeView(frame: frame)
                    noticeView.cardID = section.id
                    noticeView.notice = notice
                    noticeView.autoresizingMask = [.width]
                    document.addSubview(noticeView)
                    continue
                }

                let view: NSView
                switch section.id {
                case "claude":
                    // 표는 전체 높이로 한 장에 그린다 — 탭 본문이 통째로 스크롤된다.
                    let table = TeamClaudeTableView(frame: frame)
                    table.health = teamClaude
                    table.isMeasuring = isMeasuringTeamClaude
                    table.measurementDetail = teamClaudeMeasureDetail
                    table.onMeasure = onMeasureTeamClaude
                    table.onReauthenticate = onReauthenticateTeamClaude
                    table.onContentHeightChange = { [weak self] in self?.onTeamRowsChange?() }
                    table.expandedAccountUuid = expandedClaudeAccountUuid
                    table.expandedAccount = expandedClaudeAccount
                    table.onExpansionChange = { [weak self] in self?.relayoutClaudeTab() }
                    teamClaudeView = table
                    view = table
                case "codex":
                    let codexStatus = CodexStatusView(frame: frame)
                    codexStatus.health = codex
                    codexStatus.pool = teamCodex
                    codexStatus.usage = usage
                    codexStatus.onRecover = onRecoverTeamCodex
                    codexStatus.expand(expandedCodexAccount, accountUuid: expandedCodexAccountUuid)
                    codexStatus.onExpansionChange = { [weak self] in self?.relayoutCodexTab() }
                    codexView = codexStatus
                    view = codexStatus
                case "higgsfield":
                    let higgsView = HiggsfieldCreditsView(frame: frame)
                    higgsView.data = higgsfield
                    higgsView.staleNote = laneStaleNotes["higgsfield"]
                    higgsfieldView = higgsView
                    view = higgsView
                case "burn":
                    let burn = SubscriptionBurnView(frame: frame)
                    burn.model = burnModel
                    burn.onOpenRecords = { [weak self] in self?.selectTab(.claude) }
                    burnView = burn
                    view = burn
                case "cli":
                    let lanes = CliQuotaLanesView(frame: NSRect(x: 0, y: bodyY, width: width, height: CliQuotaLanesView.fixedHeight))
                    lanes.grok = grok
                    lanes.agy = agy
                    lanes.staleNotes = laneStaleNotes
                    cliLanesView = lanes
                    view = lanes
                case "usage":
                    let usageDashboard = UsageDashboardView(frame: frame)
                    usageDashboard.usage = usage
                    usageDashboard.staleNote = laneStaleNotes["usage"]
                    usageDashboard.parallelCount = parallelCount
                    usageDashboard.active = active
                    usageView = usageDashboard
                    view = usageDashboard
                case "vocabulary":
                    view = EmptyValueVocabularyView(frame: frame)
                default:
                    continue
                }
                view.autoresizingMask = [.width]
                document.addSubview(view)
            }
        }
        sections = allSections
        if expandedClaudeAccount != nil { relayoutClaudeTab() }
        if expandedCodexAccount != nil { relayoutCodexTab() }
        footer.context = footerContext(for: selectedTab)
        showSelectedTab(restoring: previousOrigin ?? .zero)
        needsLayout = true
    }

    /// 행을 펼치거나 접으면 표와 Claude 탭 문서의 높이만 다시 잡는다(다른 탭·메뉴 항목 기하는 그대로).
    private func relayoutClaudeTab() {
        guard let table = teamClaudeView, let health = table.health, let document = tabDocuments[.claude] else { return }
        expandedClaudeAccount = table.expandedAccount
        expandedClaudeAccountUuid = table.expandedAccountUuid
        table.frame.size.height = TeamClaudeTableView.contentHeight(health, expanded: table.expandedAccount,
                                                                    expandedUuid: table.expandedAccountUuid)
        document.frame.size.height = table.frame.maxY + dashboardSectionGap + Self.bodyInset
        table.needsLayout = true
        table.needsDisplay = true
    }

    /// Codex 행을 펼치거나 접으면 Codex 뷰와 탭 문서의 높이만 다시 잡는다.
    private func relayoutCodexTab() {
        guard let view = codexView, let document = tabDocuments[.codex] else { return }
        expandedCodexAccount = view.expandedAccount
        expandedCodexAccountUuid = view.expandedAccountUuid
        guard view.pool != nil else { return }
        view.frame.size.height = CodexStatusView.preferredHeight(for: view.pool, expanded: view.expandedAccount,
                                                                 expandedUuid: view.expandedAccountUuid)
        document.frame.size.height = view.frame.maxY + dashboardSectionGap + Self.bodyInset
        view.needsLayout = true
        view.needsDisplay = true
    }

    /// 개요에서 계정을 누르면 Claude 탭에서 그 행을 펼친다.
    func openAccount(_ name: String, accountUuid: String? = nil) {
        selectTab(.claude)
        guard let table = teamClaudeView, let document = tabDocuments[.claude] else { return }
        table.expand(name, accountUuid: accountUuid)
        relayoutClaudeTab()
        table.layoutSubtreeIfNeeded()
        if let rowRect = table.rowRect(named: name, accountUuid: accountUuid) {
            let target = table.convert(rowRect, to: document)
            restoreBodyScroll(NSPoint(x: 0, y: target.minY - 40))
        }
    }

    /// Codex 탭에서 그 계정의 구독 기록을 펼친다(스냅샷 --expand-codex).
    func openCodexAccount(_ name: String, accountUuid: String? = nil) {
        selectTab(.codex)
        codexView?.expand(name, accountUuid: accountUuid)
        relayoutCodexTab()
    }

    /// 손볼 것의 "종료로 확정": 그 계정 행을 펼치고 확정 버튼을 무장시킨다(한 번 더 누르면 확정).
    /// 손볼 것은 계정 uuid를 함께 넘긴다. 같은 이름 계정이 둘이어도 그 계정 행만 펼치고 무장한다.
    func openSubscriptionConfirm(provider: String, name: String, accountUuid: String?) {
        if provider == "codex" {
            selectTab(.codex)
            guard let view = codexView, let document = tabDocuments[.codex] else { return }
            view.expand(name, accountUuid: accountUuid)
            relayoutCodexTab()
            view.armConfirmEnd(name, accountUuid: accountUuid)
            view.layoutSubtreeIfNeeded()
            if let rowRect = view.rowRect(named: name, accountUuid: accountUuid) {
                restoreBodyScroll(NSPoint(x: 0, y: view.convert(rowRect, to: document).minY - 40))
            }
            return
        }
        openAccount(name, accountUuid: accountUuid)
        teamClaudeView?.armConfirmEnd(name, accountUuid: accountUuid)
    }

    private func runTodo(_ todo: OverviewTodo, onReauthenticate: ((String, String?) -> Void)?,
                         onRecover: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)?) {
        switch todo.action {
        case .none: openAccount(todo.name)
        case .reauthenticate: onReauthenticate?(todo.name, todo.accountUuid)
        case .subscriptionRecord:
            AccountSubscriptionButton(provider: todo.provider, accountUuid: todo.accountUuid, accountName: todo.name).openRecordDialog()
        case .codexRecover(let kind): onRecover?(todo.name, todo.accountUuid, kind)
        case .confirmSubscriptionEnd: openSubscriptionConfirm(provider: todo.provider, name: todo.name, accountUuid: todo.accountUuid)
        }
    }

    func updateContent(
        teamClaude: TeamClaudeHealth?,
        codex: CodexHealth?,
        teamCodex: TeamCodexPoolHealth?,
        usage: UsageData?,
        higgsfield: HiggsfieldCreditsData? = nil,
        grok: GrokCardModel = GrokCardModel(headline: L10n.grokChecking, detail: nil),
        agy: AgyCardModel = AgyCardModel(message: L10n.agyChecking, groups: []),
        burnModel: SubscriptionBurnModel,
        notices: DashboardToolNotices,
        laneStaleNotes: [String: String] = [:],
        parallelCount: Int,
        active: Bool,
        isMeasuringTeamClaude: Bool,
        teamClaudeMeasureDetail: String?,
        onMeasureTeamClaude: (() -> Void)?,
        onReauthenticateTeamClaude: ((String, String?) -> Void)? = nil,
        onRecoverTeamCodex: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)? = nil
    ) {
        let now = Date()
        let accountCount = teamClaude?.accounts.count ?? 0
        let usageHeight = UsageDashboardView.preferredHeight(for: usage)
        let overview = Self.overviewModel(teamClaude: teamClaude, teamCodex: teamCodex, grok: grok, agy: agy,
                                          burnModel: burnModel, notices: notices, now: now)
        let structureChanged = accountCount != renderedAccountCount
            || (teamClaude != nil) != renderedTeamClaudePresent
            || (codex != nil) != renderedCodexPresent
            || (teamCodex?.accounts.count ?? 0) != renderedTeamCodexAccountCount
            || (teamCodex != nil) != renderedTeamCodexPresent
            || usageHeight != renderedUsageHeight
            || HiggsfieldCreditsView.preferredHeight(for: higgsfield) != renderedHiggsfieldHeight
            || Self.teamContentHeight(teamClaude) != renderedTeamHeight
            || Self.codexHeight(codex, teamCodex: teamCodex) != renderedCodexHeight
            || OverviewTabView.preferredHeight(overview) != renderedOverviewHeight
            || notices != renderedNotices
        if structureChanged {
            // 가장 비싼 경로다. 여기서도 단계 시간을 남긴다(예전엔 phases=- 로 비어 보였다).
            let structurePhases = DashboardRefreshPhases()
            lastRefreshPhases = structurePhases
            if !heightFrozen {
                frame.size.height = Self.preferredHeight(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield,
                                                         burnModel: burnModel, notices: notices, maxBodyHeight: maxBodyHeight)
            }
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
                notices: notices,
                laneStaleNotes: laneStaleNotes,
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
        applyChrome(overview, now: now)
        overviewView?.model = overview
        phases.mark("overview")
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
        if expandedCodexAccount != nil { relayoutCodexTab() }
        phases.mark("codex")
        higgsfieldView?.data = higgsfield
        higgsfieldView?.staleNote = laneStaleNotes["higgsfield"]
        burnView?.model = burnModel
        cliLanesView?.grok = grok
        cliLanesView?.staleNotes = laneStaleNotes
        cliLanesView?.agy = agy
        usageView?.usage = usage
        usageView?.staleNote = laneStaleNotes["usage"]
        usageView?.parallelCount = parallelCount
        usageView?.active = active
        usageView?.needsDisplay = true
        phases.mark("cards")
        refreshSectionSummaries(Self.sectionSummaries(teamClaude: teamClaude, codex: codex, teamCodex: teamCodex, usage: usage, higgsfield: higgsfield, notices: notices, staleNotes: laneStaleNotes))
        phases.mark("sections")
    }

    // MARK: 스냅샷

    /// 탭 하나만 그린 이미지. 본문 문서를 통째로(스크롤 없이) 머리·하단 막대 사이에 둔다.
    func snapshotDocumentHeight(_ tab: DashboardTab) -> CGFloat { tabDocuments[tab]?.frame.height ?? 0 }
}

let dashboardStampFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "M/d HH:mm"
    return formatter
}()

/// 동작 목록이 열렸을 때 본문을 덮는 투명 막. 바깥을 누르면 목록을 닫는다.
final class DashboardScrimView: NSView {
    var onClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onClick?() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.25).setFill()
        bounds.fill()
    }
}

/// ccusage 사용량(비용). 소진 탭 아래쪽에 둔다(A안이 다루지 않은 섹션 — 기능을 줄이지 않으려고 옮겼다).
/// 위에서부터 상태 칩 → 지표 4개(오늘·최근 7일·이번 달·누적) → 최근 14일 비용 → 일별 추이 → 모델별 비용.
final class UsageDashboardView: NSView {
    var usage: UsageData? {
        didSet {
            refreshAccessibilityLabel()
            needsDisplay = true
        }
    }
    /// 갱신이 실패해 이전 값을 보이는 중일 때의 꼬리말(ccusageStaleNote). 머리 줄 오른쪽에 그린다.
    var staleNote: String? {
        didSet {
            guard staleNote != oldValue else { return }
            // 칩 줄이 좁으면 꼬리말이 "…"로 줄어든다. 전문은 도움말 풍선과 접근성 라벨에 둔다.
            toolTip = staleNote
            refreshAccessibilityLabel()
            needsDisplay = true
        }
    }

    private func refreshAccessibilityLabel() {
        guard let usage = usage, let today = usage.today else { return }
        var label = L10n.usageAccessibility(today: formatCost(today.totalCost), week: formatCost(usage.thisWeekCost),
                                            month: formatCost(usage.thisMonthCost))
        if let staleNote { label += ", \(staleNote)" }
        setAccessibilityLabel(label)
    }
    var parallelCount: Int = 0
    var active: Bool = false
    override var isFlipped: Bool { true }

    static let padding: CGFloat = 16
    static let metricHeight: CGFloat = 64
    static let trendHeight: CGFloat = 132
    static let dailyHeight: CGFloat = 36 + 7 * 19 + 8
    static let providersHeight: CGFloat = 146

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(L10n.sectionUsage)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    static func preferredHeight(for usage: UsageData?) -> CGFloat {
        guard usage?.today != nil else { return 104 }
        return 34 + metricHeight + 12 + trendHeight + 12 + dailyHeight + 12 + providersHeight + 4
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let mint = TeamClaudePalette.mint
        let caption = TeamClaudePalette.captionFont
        let micro = TeamClaudePalette.microFont
        let mono = TeamClaudePalette.numberFont
        let monoSmall = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
        let krwRate = usage?.usdKrwRate ?? 1450.0
        let x0 = Self.padding
        let width = bounds.width - Self.padding * 2

        func chip(_ value: String, x: CGFloat, y: CGFloat, tone: PanelTone) -> CGFloat {
            let w = PanelDraw.width(value, caption) + 24
            let rect = NSRect(x: x, y: y, width: w, height: 22)
            PanelDraw.fillRound(rect, NSColor.white.withAlphaComponent(0.04), 6)
            PanelDraw.dot(rect.minX + 8, centerY: rect.midY, tone.color)
            PanelDraw.text(value, rect.minX + 18, rect.minY + 3.5, caption, fg2)
            return w
        }
        func panelBox(_ rect: NSRect, _ title: String) {
            PanelDraw.card(rect)
            PanelDraw.meta(title, rect.minX + 12, rect.minY + 10)
        }
        func miniBar(value: Double, maxValue: Double, rect: NSRect, color: NSColor) {
            PanelDraw.fillRound(rect, TeamClaudePalette.track, rect.height / 2)
            guard maxValue > 0, value > 0 else { return }
            PanelDraw.fillRound(NSRect(x: rect.minX, y: rect.minY, width: max(3, rect.width * CGFloat(value / maxValue)), height: rect.height),
                                color, rect.height / 2)
        }
        func labelForDate(_ ymd: String) -> String {
            guard let date = dateFromYMD(ymd) else { return shortDate(ymd) }
            if Calendar.current.isDateInToday(date) { return L10n.today }
            if Calendar.current.isDateInYesterday(date) { return L10n.yesterday }
            return shortDate(ymd)
        }

        var x = x0
        x += chip(active ? L10n.usageActive : L10n.usageIdle, x: x, y: 4, tone: active ? .ready : .off) + 6
        guard let usageData = usage, let today = usageData.today else {
            let box = NSRect(x: x0, y: 34, width: width, height: 64)
            PanelDraw.card(box)
            PanelDraw.text(L10n.usageWaiting, box.minX + 14, box.minY + 14, TeamClaudePalette.bodyMediumFont, fg)
            PanelDraw.text(PanelDraw.clipped(L10n.usageWaitingDetail, caption, maxWidth: box.width - 28), box.minX + 14, box.minY + 36, caption, fg3)
            return
        }
        x += chip(L10n.parallelSessions(parallelCount), x: x, y: 4, tone: parallelCount > 0 ? .ready : .info)
        // 갱신이 실패해 이전 값을 보이는 중이면(ccusageStaleNote) 칩 줄 오른쪽에 그 사실을 경고색으로 둔다.
        if let staleNote {
            let noteMax = x0 + width - (x + 12)
            if noteMax > 0 {
                _ = PanelDraw.right(PanelDraw.clipped(staleNote, caption, maxWidth: noteMax), x0 + width, 7.5, caption, TeamClaudePalette.amber)
            }
        }
        let rate = usageData.usdKrwRate
        let todayTokens = today.inputTokens + today.cacheCreationTokens + today.cacheReadTokens + today.outputTokens

        // 지표 4개
        let metricY: CGFloat = 34
        let gap: CGFloat = 8
        let metricWidth = (width - gap * 3) / 4
        let metrics: [(String, Double, String)] = [
            (L10n.today, today.totalCost, formatTokens(todayTokens)),
            (L10n.last7Days, usageData.weeklyTotalCost, L10n.thisWeekShort(formatKRWShort(usageData.thisWeekCost, rate: rate))),
            (L10n.thisMonth, usageData.thisMonthCost, formatTokens(usageData.thisMonthTokens)),
            (L10n.allTime, usageData.allTimeCost, formatTokens(usageData.allTimeTokens)),
        ]
        for (index, metric) in metrics.enumerated() {
            let rect = NSRect(x: x0 + CGFloat(index) * (metricWidth + gap), y: metricY, width: metricWidth, height: Self.metricHeight)
            PanelDraw.card(rect)
            PanelDraw.meta(metric.0, rect.minX + 10, rect.minY + 8)
            let valueFont = NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
            PanelDraw.text(PanelDraw.clipped(formatCost(metric.1), valueFont, maxWidth: rect.width - 20), rect.minX + 10, rect.minY + 24, valueFont,
                           index == 0 ? mint : fg)
            PanelDraw.text(PanelDraw.clipped("\(formatKRWShort(metric.1, rate: rate)) · \(metric.2)", micro, maxWidth: rect.width - 20),
                           rect.minX + 10, rect.minY + 45, micro, fg3)
        }

        // 최근 14일 비용
        let trend = NSRect(x: x0, y: metricY + Self.metricHeight + 12, width: width, height: Self.trendHeight)
        panelBox(trend, L10n.recent14Days)
        let points = usageData.recent14Days
        if points.isEmpty || (points.map(\.cost).max() ?? 0) <= 0 {
            PanelDraw.text(L10n.noCostData, trend.minX + 12, trend.minY + 56, caption, fg3)
        } else {
            let maxCost = points.map(\.cost).max() ?? 1
            if let peak = points.max(by: { $0.cost < $1.cost }) {
                PanelDraw.right(L10n.peakCost("\(formatCostShort(peak.cost)) · \(formatKRWShort(peak.cost, rate: krwRate))"),
                                trend.maxX - 12, trend.minY + 10, micro, fg3)
            }
            let chart = NSRect(x: trend.minX + 12, y: trend.minY + 34, width: trend.width - 24, height: trend.height - 58)
            let barGap: CGFloat = 3
            let barWidth = max(3, (chart.width - barGap * CGFloat(points.count - 1)) / CGFloat(points.count))
            for (index, point) in points.enumerated() {
                let barHeight = max(2, chart.height * CGFloat(point.cost / maxCost))
                let isLast = index == points.count - 1
                PanelDraw.fillRound(NSRect(x: chart.minX + CGFloat(index) * (barWidth + barGap), y: chart.maxY - barHeight,
                                           width: barWidth, height: barHeight),
                                    isLast ? mint : TeamClaudePalette.ash.withAlphaComponent(0.35 + 0.4 * CGFloat(index) / CGFloat(max(points.count - 1, 1))), 2)
            }
            if let first = points.first, let last = points.last {
                PanelDraw.text(shortDate(first.date), chart.minX, trend.maxY - 18, micro, fg3)
                PanelDraw.right("\(L10n.today) \(shortDate(last.date))", chart.maxX, trend.maxY - 18, micro, fg3)
            }
        }

        // 일별 추이
        let daily = NSRect(x: x0, y: trend.maxY + 12, width: width, height: Self.dailyHeight)
        panelBox(daily, L10n.dailyTrend)
        let rows = Array(usageData.recent7Days.reversed().prefix(7))
        let maxDaily = rows.map(\.cost).max() ?? 1
        for (index, point) in rows.enumerated() {
            let y = daily.minY + 34 + CGFloat(index) * 19
            let isToday = Calendar.current.isDateInToday(dateFromYMD(point.date) ?? Date.distantPast)
            let color = isToday ? mint : fg
            PanelDraw.text(labelForDate(point.date), daily.minX + 12, y, mono, color)
            miniBar(value: point.cost, maxValue: maxDaily, rect: NSRect(x: daily.minX + 72, y: y + 5, width: daily.width - 300, height: 6),
                    color: isToday ? mint : TeamClaudePalette.ash.withAlphaComponent(0.7))
            PanelDraw.right(formatCost(point.cost), daily.maxX - 150, y, mono, color)
            PanelDraw.right(formatKRWShort(point.cost, rate: krwRate), daily.maxX - 74, y + 1, monoSmall, fg3)
            PanelDraw.right(formatTokens(point.tokens), daily.maxX - 12, y + 1, monoSmall, fg3)
        }

        // 모델별 비용
        let providers = NSRect(x: x0, y: daily.maxY + 12, width: width, height: Self.providersHeight)
        panelBox(providers, L10n.costByModel)
        PanelDraw.right(L10n.exchangeRate(String(format: "%.1f", rate)), providers.maxX - 12, providers.minY + 10, micro, fg3)
        let models = usageData.modelBreakdown
        guard !models.isEmpty else {
            PanelDraw.text(L10n.noModelData, providers.minX + 12, providers.minY + 54, caption, fg3)
            return
        }
        var totals: [String: Double] = [:]
        for model in models { totals[model.provider, default: 0] += model.cost }
        let sorted = totals.sorted { $0.value > $1.value }
        let total = sorted.reduce(0.0) { $0 + $1.value }
        var legendX = providers.minX + 12
        for item in sorted.prefix(4) {
            PanelDraw.dot(legendX, centerY: providers.minY + 39, providerColor(item.key))
            let label = "\(item.key) \(formatKRWShort(item.value, rate: rate))"
            legendX += 11 + PanelDraw.text(label, legendX + 11, providers.minY + 32, micro, fg2) + 14
        }
        let track = NSRect(x: providers.minX + 12, y: providers.minY + 54, width: providers.width - 24, height: 6)
        PanelDraw.fillRound(track, TeamClaudePalette.track, 3)
        if total > 0 {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: track, xRadius: 3, yRadius: 3).addClip()
            var barX = track.minX
            for item in sorted {
                let segment = track.width * CGFloat(item.value / total)
                providerColor(item.key).withAlphaComponent(0.9).setFill()
                NSRect(x: barX, y: track.minY, width: segment, height: track.height).fill()
                barX += segment
            }
            NSGraphicsContext.restoreGraphicsState()
        }
        let maxCost = models.first?.cost ?? 1
        for (index, model) in models.prefix(4).enumerated() {
            let y = providers.minY + 70 + CGFloat(index) * 18
            PanelDraw.dot(providers.minX + 12, centerY: y + 8, providerColor(model.provider))
            PanelDraw.text(PanelDraw.clipped(model.label, caption, maxWidth: 140), providers.minX + 25, y, caption, fg)
            let barWidth = providers.width - 330
            if barWidth > 20 {
                miniBar(value: model.cost, maxValue: maxCost, rect: NSRect(x: providers.minX + 172, y: y + 6, width: barWidth, height: 6),
                        color: providerColor(model.provider))
            }
            PanelDraw.right(formatKRWShort(model.cost, rate: rate), providers.maxX - 88, y + 1, monoSmall, fg3)
            PanelDraw.right(formatCost(model.cost), providers.maxX - 12, y, mono, fg)
        }
    }
}

func teamClaudeSpec(home: String = NSHomeDirectory()) -> ToolSpec {
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
    return ToolSpec(name: "teamclaude", envKey: "CC_MENUBAR_TEAMCLAUDE_BIN", preferred: candidates)
}

func resolveTeamClaudeExecutable() -> String {
    ToolLocator.shared.resolve(teamClaudeSpec()).path ?? "teamclaude"
}

/// codex 하위 명령은 teamcodex 진입점으로만 보낸다.
/// 이 호스트에는 후보 경로 어디에도 `teamclaude` 실행 파일이 없다(2026-09-06 실측:
/// `~/.local/bin`·fnm·homebrew·/usr/local 전부 부재). 그래서 codex 명령을
/// `resolveTeamClaudeExecutable()`로 보내면 리터럴 "teamclaude"로 떨어져
/// command not found로 죽는다. teamcodex는 `~/.local/bin/teamcodex`와
/// fnm 설치본으로 실재하며 codex 풀 CLI를 담당한다.
func teamCodexSpec(home: String = NSHomeDirectory()) -> ToolSpec {
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
    return ToolSpec(name: "teamcodex", envKey: "CC_MENUBAR_TEAMCODEX_BIN", preferred: candidates)
}

func resolveTeamCodexExecutable() -> String {
    ToolLocator.shared.resolve(teamCodexSpec()).path ?? resolveTeamClaudeExecutable()
}

func teamClaudeConfigSignature() -> String {
    guard let path = currentTeamClaudeConfigPath() else { return "unresolved" }
    let modifiedAt = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?
        .timeIntervalSince1970 ?? 0
    guard let config = readTeamClaudeJSON(path) else {
        return "missing|\(modifiedAt)"
    }
    let accounts = tcArray(config["accounts"]) ?? []
    return "\(Int(modifiedAt))|\(accounts.count)|\(teamClaudeAccountTopologySignature())"
}

func teamClaudeAccountTopologySignature() -> Int {
    guard let config = currentTeamClaudeConfigPath().flatMap({ readTeamClaudeJSON($0) }) else {
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

// MARK: - TeamClaude 프록시 무중단 제어
//
// supervisor 강제 재시작(kickstart의 -k 옵션)은 진행 중인 Claude Code 요청을 모두 끊는다(10/10 23:47 inflight 14건).
// 자동 경로는 재시작하지 않는다. 판정은 TeamClaudeServerControl.swift의 순수 함수가 한다.

/// 환경변수(CC_MENUBAR_TEAMCLAUDE_LABEL) > UserDefaults(teamClaudeLaunchdLabel) > 기본값 com.qjc.teamclaude.
let teamClaudeLaunchdLabel = resolveTeamClaudeLaunchdLabel(
    environment: ProcessInfo.processInfo.environment,
    defaultsValue: UserDefaults.standard.string(forKey: teamClaudeLaunchdLabelDefaultsKey)
)

private func runTeamClaudeCapture(
    executable: String,
    arguments: [String],
    timeoutSeconds: Double = 5
) -> (status: Int32, output: String)? {
    let outputPath = NSTemporaryDirectory() + "cc-menubar-capture-\(UUID().uuidString)"
    guard FileManager.default.createFile(atPath: outputPath, contents: nil, attributes: [.posixPermissions: 0o600]),
          let output = FileHandle(forWritingAtPath: outputPath),
          let nullErr = FileHandle(forWritingAtPath: "/dev/null") else {
        try? FileManager.default.removeItem(atPath: outputPath)
        return nil
    }
    defer {
        output.closeFile()
        nullErr.closeFile()
        try? FileManager.default.removeItem(atPath: outputPath)
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = nullErr
    guard let result = runTrustedProcessInIsolatedGroup(
        process,
        timeoutSeconds: timeoutSeconds,
        terminationGraceMicroseconds: 300_000
    ), !result.timedOut else { return nil }
    let data = (try? Data(contentsOf: URL(fileURLWithPath: outputPath))) ?? Data()
    return (result.terminationStatus, String(decoding: data, as: UTF8.self))
}

func probeTeamClaudeLaunchd() -> TeamClaudeLaunchdProbe {
    guard let result = runTeamClaudeCapture(
        executable: "/bin/launchctl",
        arguments: ["print", "gui/\(getuid())/\(teamClaudeLaunchdLabel)"]
    ) else { return .unknown }
    return parseTeamClaudeLaunchdPrint(output: result.output, exitStatus: result.status)
}

func teamClaudeProcessAlive(_ pid: Int32) -> Bool {
    guard pid > 1 else { return false }
    return kill(pid, 0) == 0 || errno == EPERM
}

/// 프록시 CLI의 readProcessIdentity(ps ppid/lstart/command)와 같은 값을 sysctl로 읽는다.
/// 부하가 높을 때 서브프로세스를 띄우지 않으려고 커널에서 직접 가져온다.
func readTeamClaudeProcessIdentity(pid: Int32) -> TeamClaudeProcessIdentity? {
    guard pid > 1 else { return nil }
    var info = kinfo_proc()
    var infoSize = MemoryLayout<kinfo_proc>.stride
    var procMib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&procMib, u_int(procMib.count), &info, &infoSize, nil, 0) == 0,
          infoSize >= MemoryLayout<kinfo_proc>.stride,
          info.kp_proc.p_pid == pid else { return nil }

    var argMaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    var argMax: Int32 = 0
    var argMaxSize = MemoryLayout<Int32>.size
    guard sysctl(&argMaxMib, u_int(argMaxMib.count), &argMax, &argMaxSize, nil, 0) == 0, argMax > 0 else { return nil }
    var buffer = [UInt8](repeating: 0, count: Int(argMax))
    var bufferSize = buffer.count
    var argsMib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    guard sysctl(&argsMib, u_int(argsMib.count), &buffer, &bufferSize, nil, 0) == 0,
          let arguments = parseTeamClaudeProcArgs(Array(buffer.prefix(bufferSize))) else { return nil }

    return TeamClaudeProcessIdentity(
        pid: pid,
        ppid: info.kp_eproc.e_ppid,
        startedAt: teamClaudeLstartString(epochSeconds: Int(info.kp_proc.p_starttime.tv_sec), timeZone: .current),
        command: arguments.joined(separator: " ")
    )
}

private func probeTeamClaudeLoopback(port: Int, ipv6: Bool, timeoutMs: Int32) -> TeamClaudePortProbe {
    let fd = socket(ipv6 ? AF_INET6 : AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return .unknown }
    defer { close(fd) }
    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL, 0) | O_NONBLOCK)
    let connected: Int32
    if ipv6 {
        var address = sockaddr_in6()
        address.sin6_len = UInt8(MemoryLayout<sockaddr_in6>.size)
        address.sin6_family = sa_family_t(AF_INET6)
        address.sin6_port = in_port_t(UInt16(port).bigEndian)
        address.sin6_addr = in6addr_loopback
        connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in6>.size))
            }
        }
    } else {
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
    }
    if connected == 0 { return .listening }
    if errno == ECONNREFUSED { return .refused }
    guard errno == EINPROGRESS else { return .unknown }
    var pollDescriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    guard poll(&pollDescriptor, 1, timeoutMs) > 0 else { return .unknown }
    var socketError: Int32 = 0
    var length = socklen_t(MemoryLayout<Int32>.size)
    guard getsockopt(fd, SOL_SOCKET, SO_ERROR, &socketError, &length) == 0 else { return .unknown }
    if socketError == 0 { return .listening }
    return socketError == ECONNREFUSED ? .refused : .unknown
}

/// 포트에 TCP 연결만 시도한다(HTTP 요청 없음). IPv4·IPv6 루프백 둘 다 거절할 때만 refused.
func probeTeamClaudePort(_ port: Int, timeoutMs: Int32 = 1_500) -> TeamClaudePortProbe {
    guard port > 0, port < 65_536 else { return .unknown }
    let ipv4 = probeTeamClaudeLoopback(port: port, ipv6: false, timeoutMs: timeoutMs)
    if ipv4 == .listening { return .listening }
    let ipv6 = probeTeamClaudeLoopback(port: port, ipv6: true, timeoutMs: timeoutMs)
    if ipv6 == .listening { return .listening }
    return ipv4 == .refused && ipv6 == .refused ? .refused : .unknown
}

func probeTeamClaudeOutage(port: Int) -> TeamClaudeOutageVerdict {
    let launchd = probeTeamClaudeLaunchd()
    if case .running(let pid) = launchd, teamClaudeProcessAlive(pid) {
        return teamClaudeOutageVerdict(launchd: launchd, launchdPidAlive: true, port: .unknown)
    }
    return teamClaudeOutageVerdict(launchd: launchd, launchdPidAlive: false, port: probeTeamClaudePort(port))
}

/// 멈춘 서비스만 시작한다. `-k`가 없으므로 살아 있는 프로세스는 건드리지 않는다.
@discardableResult
func startStoppedTeamClaudeService() -> Bool {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["kickstart", "gui/\(getuid())/\(teamClaudeLaunchdLabel)"]
    do {
        try task.run()
        task.waitUntilExit()
        return task.terminationStatus == 0
    } catch {
        return false
    }
}

/// 라벨이 launchd에 없을 때 `teamclaude server`를 분리 실행해 시작만 한다. 살아 있는 프로세스는 건드리지 않는다
/// (호출부가 포트가 닫혔음을 확인한 뒤에만 부른다). 출력은 ~/Library/Logs/cc-menubar/teamclaude-server.log.
@discardableResult
func startTeamClaudeServerDetached(executable: String) -> Bool {
    let logDir = "\(NSHomeDirectory())/Library/Logs/cc-menubar"
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let command = teamClaudeDetachedStartArguments(executable: executable, logPath: "\(logDir)/teamclaude-server.log")
    let task = Process()
    task.executableURL = URL(fileURLWithPath: command.executable)
    task.arguments = command.arguments
    var environment = ProcessInfo.processInfo.environment
    // teamclaude는 `#!/usr/bin/env node` 스크립트다. 설치 폴더(nvm·fnm·npm prefix)에 같이 있는 node를 먼저 찾게 한다.
    let executableBin = (executable as NSString).deletingLastPathComponent
    environment["PATH"] = "\(executableBin):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    task.environment = environment
    task.standardInput = FileHandle.nullDevice
    task.standardOutput = FileHandle.nullDevice
    task.standardError = FileHandle.nullDevice
    do {
        try task.run()
        task.waitUntilExit()
        print("TEAMCLAUDE-START: launchd 미등록 → teamclaude server 분리 실행 exit=\(task.terminationStatus)")
        fflush(stdout)
        return task.terminationStatus == 0
    } catch {
        return false
    }
}

/// 분리 실행할 수 있는 teamclaude 실행 파일(절대 경로). 못 찾으면 nil.
func teamClaudeDetachedExecutable() -> String? {
    let executable = resolveTeamClaudeExecutable()
    return executable.hasPrefix("/") ? executable : nil
}

/// supervisor를 죽였다 다시 띄운다. 진행 중 요청이 모두 끊긴다.
/// 사용자가 확인 대화상자에서 재시작을 고른 restartTeamClaudeAction에서만 부른다.
@discardableResult
func forceRestartTeamClaudeServerConfirmedByUser() -> Bool {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    task.arguments = ["kickstart", "-k", "gui/\(getuid())/\(teamClaudeLaunchdLabel)"]
    do {
        try task.run()
        task.waitUntilExit()
        return task.terminationStatus == 0
    } catch {
        return false
    }
}

enum TeamClaudeSyncOutcome: Equatable {
    case inSync
    case reloaded
    case driftPersists(String)
    case responseDelayed(pid: Int32?)
    case serviceStarted
    case serviceStartFailed
    case serviceNotLoaded
    case undetermined

    var logText: String {
        switch self {
        case .inSync: return "서버 반영 확인 · 재시작 안 함"
        case .reloaded: return "worker 무중단 재로딩으로 반영"
        case .driftPersists(let reason): return "불일치 남음(\(reason)) · 재시작 안 함, 경고만 표시"
        case .responseDelayed(let pid):
            return "프로세스 실행 중(pid \(pid.map(String.init) ?? "미확인")) · 응답 지연, 재시작 안 함"
        case .serviceStarted: return "멈춘 서비스 시작(kickstart, -k 없음)"
        case .serviceStartFailed: return "멈춘 서비스 시작 실패"
        case .serviceNotLoaded: return "launchd 서비스 미등록 · 시작할 설정·실행 파일 없음, 조치 안 함"
        case .undetermined: return "launchd 상태 확인 불가 · 조치 안 함"
        }
    }
}

func currentTeamClaudeConfigPath() -> String? {
    teamClaudeConfigPath(environment: ProcessInfo.processInfo.environment, home: NSHomeDirectory())
}

private func reloadTeamClaudeWorkerAccounts(current: TeamClaudeHealth) -> (TeamClaudeSyncOutcome, TeamClaudeHealth) {
    guard let configPath = currentTeamClaudeConfigPath() else {
        return (.driftPersists("TEAMCLAUDE_CONFIG가 상대 경로라 서버 설정 파일을 특정할 수 없음"), current)
    }
    let state = parseTeamClaudeServerState(readTeamClaudeJSON(teamClaudeServerStatePath(configPath: configPath)))
    let launchd = probeTeamClaudeLaunchd()
    let observed = state?.workerPid.flatMap { readTeamClaudeProcessIdentity(pid: $0) }
    let decision = teamClaudeWorkerSignalDecision(
        state: state,
        expectedConfigPath: configPath,
        launchd: launchd,
        observedWorker: observed
    )
    guard case .signal(let pid) = decision else {
        if case .refuse(let reason) = decision { return (.driftPersists("worker 확인 불가: \(reason)"), current) }
        return (.driftPersists("worker 확인 불가"), current)
    }
    guard kill(pid, SIGHUP) == 0 else { return (.driftPersists("SIGHUP 실패 errno \(errno)"), current) }
    var health = current
    for _ in 0..<10 {
        Thread.sleep(forTimeInterval: 2)
        health = loadTeamClaudeHealth()
        if health.serverReachable && health.accountConfigDrift == 0 { return (.reloaded, health) }
    }
    return (.driftPersists("재로딩 후 불일치 \(health.accountConfigDrift)개"), health)
}

/// 계정 변경·서버 연결 실패를 재시작 없이 처리한다.
/// - 서버 응답 + 불일치 없음: CLI가 이미 라이브 반영했다. 아무것도 하지 않는다.
/// - 서버 응답 + 불일치: 검증된 worker에 SIGHUP. 그래도 남으면 경고만.
/// - 서버 무응답: 프로세스가 살아 있으면 응답 지연. 프로세스·포트가 모두 없을 때만 -k 없이 시작.
func syncTeamClaudeServerWithoutRestart(current: TeamClaudeHealth) -> (outcome: TeamClaudeSyncOutcome, health: TeamClaudeHealth) {
    switch teamClaudeSyncPlan(serverReachable: current.serverReachable, accountConfigDrift: current.accountConfigDrift) {
    case .nothing:
        return (.inSync, current)
    case .reloadAccounts:
        let (outcome, health) = reloadTeamClaudeWorkerAccounts(current: current)
        return (outcome, health)
    case .checkLiveness:
        switch probeTeamClaudeOutage(port: current.serverPort ?? 3456) {
        case .responseDelayed(let pid):
            return (.responseDelayed(pid: pid), current)
        case .serviceNotLoaded:
            // 라벨이 launchd에 없다(외부 설치 등). 포트가 닫혔음은 판정이 이미 확인했다.
            // 설정과 실행 파일이 있을 때만 `teamclaude server`를 분리 실행해 시작만 한다.
            let executable = teamClaudeDetachedExecutable()
            guard teamClaudeDetachedStartAllowed(configPresent: current.configPresent, executable: executable),
                  let executable, startTeamClaudeServerDetached(executable: executable) else {
                return (.serviceNotLoaded, current)
            }
            var detachedHealth = current
            for _ in 0..<45 {
                Thread.sleep(forTimeInterval: 1)
                detachedHealth = loadTeamClaudeHealth()
                if detachedHealth.serverReachable { return (.serviceStarted, detachedHealth) }
            }
            return (.serviceStartFailed, detachedHealth)
        case .undetermined:
            return (.undetermined, current)
        case .startStoppedService:
            guard startStoppedTeamClaudeService() else { return (.serviceStartFailed, current) }
            var health = current
            for _ in 0..<45 {
                Thread.sleep(forTimeInterval: 1)
                health = loadTeamClaudeHealth()
                if health.serverReachable { return (.serviceStarted, health) }
            }
            return (.serviceStartFailed, health)
        }
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

/// `teamcodex codex subscription …`을 비대화형으로 실행하고 stdout·stderr를 함께 돌려준다.
/// 실패 사유와 "Apply the change with: teamcodex restart" 안내를 읽어야 해서 터미널 대신 직접 실행한다.
func runTeamCodexSubscriptionCommand(_ arguments: [String]) -> SubscriptionCLIResult {
    let executable = resolveTeamCodexExecutable()
    let process = Process()
    if executable.contains("/") {
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
    } else {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executable] + arguments
    }
    // 셸에서 물려받은 TEAMCLAUDE_CONFIG·XDG_CONFIG_HOME이 다른 설정을 가리키지 않게, 화면이 읽는 기본 teamcodex.json으로 고정한다.
    process.environment = teamCodexSubscriptionEnvironment(
        base: ProcessInfo.processInfo.environment, home: NSHomeDirectory(),
        executableBin: URL(fileURLWithPath: executable).deletingLastPathComponent().path)
    let errorURL = FileManager.default.temporaryDirectory.appendingPathComponent("cc-menubar-subscription-\(UUID().uuidString).log")
    guard FileManager.default.createFile(atPath: errorURL.path, contents: nil),
          let errorHandle = FileHandle(forWritingAtPath: errorURL.path) else {
        return SubscriptionCLIResult(status: -1, output: "")
    }
    defer {
        errorHandle.closeFile()
        try? FileManager.default.removeItem(at: errorURL)
    }
    process.standardError = errorHandle
    guard let result = runTrustedProcessInIsolatedGroup(process, timeoutSeconds: 30, terminationGraceMicroseconds: 700_000,
                                                        captureOutputLimitBytes: 65_536) else {
        return SubscriptionCLIResult(status: -1, output: "")
    }
    let stdout = String(data: result.output, encoding: .utf8) ?? ""
    let stderr = (try? String(contentsOf: errorURL, encoding: .utf8)) ?? ""
    return SubscriptionCLIResult(status: result.terminationStatus, output: stdout + stderr, timedOut: result.timedOut)
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
    // 어느 모드든 명령 뒤에 서버를 다시 띄우지 않는다. 재시작은 진행 중 요청을 모두 끊는다.
    // TeamClaude 계정 명령(import/login/reauth)은 CLI가 실행 중 worker에 SIGHUP을 보내
    // 재시작 없이 반영한다. 남은 불일치는 상태바 자동 동기화가 worker 재로딩으로 처리한다.
    // `codex enable`은 실행 중 서버에 라이브 리로드되지 않아 CLI가 바로 위에
    // "Apply the change with: teamcodex restart"를 찍는다. 앱이 그 줄을
    // "자동 반영됩니다"로 덮으면 사용자는 재시작을 건너뛰고 반영 안 된 상태로 남는다.
    let closingNote = codexMode
        ? L10n.terminalFollowUpCodex
        : L10n.terminalFollowUpAuto
    let commands = [
        "clear",
        "echo \(shellQuote("\(product): \(commandTitle)"))",
        "\(quotedExe) \(argString)",
        "echo",
        "echo \(shellQuote(closingNote))",
        "read -n 1 -s -r -p \(shellQuote(L10n.terminalPressAnyKey))",
    ]
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
    /// 도구 설치 여부(R1). 탐색은 백그라운드 로더가 하고 결과만 여기 둔다(로그인 셸 조회가 메인 스레드를 막지 않게).
    /// nil은 아직 모름 — 안내를 띄우지 않고 기존 "확인 중" 화면을 둔다.
    var higgsfieldInstalled: Bool?
    var ccusageInstalledState: Bool?
    /// 마지막으로 끝난 ccusage daily 판정. nil이면 아직 한 번도 끝나지 않았다.
    var usageLoadOutcome: CcusageLoadOutcome?
    /// 마지막 전체 갱신에서 daily는 읽었는데 실패한 weekly·monthly. 다음 전체 갱신이 다시 정한다.
    var usagePartialFailures: [CcusageAuxFailure] = []
    /// 마지막으로 해석에 쓴 weekly·monthly 출력. 다음 전체 갱신에서 그 명령이 실패하면 이 값을 대신 쓴다.
    var lastCcusageWeeklyData: Data?
    var lastCcusageMonthlyData: Data?
    /// ccusage 한 번의 시간 제한. 운영은 기본값, 테스트는 짧게 줄인다.
    var ccusageTimeoutSeconds = ccusageDefaultTimeoutSeconds
    /// ccusage 해석이 볼 "지금". 운영은 실제 시각, 테스트는 자정 경계를 넘기는 시계로 바꾼다.
    var ccusageClock: () -> Date = { Date() }
    /// ccusage stdout 한 번의 크기 상한. 운영은 기본값, 테스트는 작게 줄인다.
    var ccusageOutputLimitBytes = ccusageDefaultOutputLimitBytes
    var teamCodexConfigPresent: Bool?
    private var isFetchingHiggsfield = false
    private var lastHiggsfieldFetchedAt: Date?
    var currentGrokSlot: String?
    var currentGrokCard = GrokCardModel(headline: L10n.grokChecking, detail: nil)
    private var isFetchingGrok = false
    private var lastGrokFetchedAt: Date?
    var grokTimer: Timer?
    var currentAgyCard = AgyCardModel(message: L10n.agyChecking, groups: [])
    private var isFetchingAgy = false
    private var lastAgyFetchedAt: Date?
    private var agyHasValue = false
    var agyTimer: Timer?
    /// 힉스필드는 기동 시 1회만 부르면 그 한 번의 실패가 영구 공백이 된다(2026-09-24 실측:
    /// 로그 347분 동안 조회 1회). 10분 주기로 다시 부른다 — 함수 자체가 중복 실행을 막는다.
    var higgsfieldTimer: Timer?
    var qaTimer: Timer?
    private var qaExecution: QAExecution?
    private lazy var qaRuntime = QAAppRuntime(delegate: self)
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
    var teamClaudeNotice: ToolNotice? {
        guard let health = currentTeamClaude else { return nil }
        return teamClaudeToolNotice(configPresent: health.configPresent, serverReachable: health.serverReachable,
                                    accountCount: health.accounts.count)
    }

    var teamCodexNotice: ToolNotice? {
        guard let pool = currentTeamCodex, let configPresent = teamCodexConfigPresent else { return nil }
        return teamCodexToolNotice(configPresent: configPresent, serverReachable: pool.serverReachable,
                                   accountCount: pool.accounts.count)
    }

    var codexNotice: ToolNotice? {
        guard let codex = currentCodex else { return nil }
        return codexToolNotice(authPresent: codex.authPresent, configPresent: codex.configPresent,
                               scannedLogFiles: codex.scannedLogFiles, totalCalls: codex.totalCalls)
    }

    /// 대시보드의 높이·배치·헤더 요약·요약 띠가 모두 이 값 하나를 본다.
    var currentToolNotices: DashboardToolNotices {
        var sections: [String: ToolNotice] = [:]
        sections["claude"] = teamClaudeNotice
        sections["codex"] = codexSectionToolNotice(codex: codexNotice, teamCodex: teamCodexNotice)
        sections["higgsfield"] = higgsfieldInstalled.flatMap { higgsfieldToolNotice(installed: $0) }
        sections["usage"] = ccusageInstalledState.flatMap {
            ccusageToolNotice(installed: $0, outcome: usageLoadOutcome, hasData: currentData?.today != nil)
        }
        sections["burn"] = currentBurnModel.collectorNotice
        return DashboardToolNotices(sections: sections)
    }

    /// 대시보드에 넘기는 꼬리말. CLI 레인(laneStaleNotes)에 사용량 갱신 실패(이전 값 표시 중)를 더한다.
    var dashboardStaleNotes: [String: String] {
        var notes = laneStaleNotes
        notes["usage"] = ccusageStaleNote(outcome: usageLoadOutcome, hasData: currentData?.today != nil,
                                          partial: usagePartialFailures)
        return notes
    }

    func refreshBurnModel(now: Date = Date()) {
        var usages: [LaneUsage] = []
        // 미설치 도구는 0계정 레인으로 그리지 않는다(지출·소진 표가 없는 풀을 "수집 중"으로 보이게 된다).
        if let claude = currentTeamClaude, teamClaudeNotice == nil {
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
        if let codex = currentTeamCodex, teamCodexNotice == nil {
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
                                                 currency: subscriptionCurrency(),
                                                 collectorNotice: subscriptionCollectorToolNotice(home: NSHomeDirectory()))
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
    /// 마지막 확인에서 status는 무응답이지만 프로세스는 살아 있었다(재시작하지 않고 "응답 지연" 표시).
    var teamClaudeResponseDelayed = false
    /// worker 재로딩 뒤에도 계정 불일치가 남았다. 불일치가 0이 되면 해제한다.
    var teamClaudeDriftPersists = false
    weak var openDashboardView: StatusMenuDashboardView?
    var cachedDashboardView: StatusMenuDashboardView?
    weak var cachedDashboardItem: NSMenuItem?
    var hasScheduledMenuPrewarm = false
    var isPreparingMenuCache = false
    var cachedSparklineCosts: [Double] = []
    var cachedSparklineImage: NSImage?

    // 펄스 프레임: 활성일 때 회전, idle일 때 정지
    let pulseFramesActive = ["●", "◐", "○", "◐"]
    let pulseFrameIdle = "○"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        wireSubscriptionActions()
        trimLogIfNeeded("\(NSHomeDirectory())/.claude/cache/cc-menubar.log")
        logToolLocations()
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

        qaTimer = Timer(timeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pollQARequest()
        }
        if let t = qaTimer { RunLoop.main.add(t, forMode: .common) }
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

    func pollQARequest() {
        guard qaExecution == nil else { return }
        let paths = QAPaths.current()
        guard QAFileSafety.isEnabled(paths) else { return }
        recoverOrphanQAClaims(paths)
        guard QAFileSafety.pathExists(paths.requestFile) else { return }
        let claimed = paths.root.appendingPathComponent(".request-\(UUID().uuidString)")
        guard (try? FileManager.default.moveItem(at: paths.requestFile, to: claimed)) != nil else { return }
        // 결과(실행 결과든 거부 결과든)를 남긴 요청만 지운다. 남기지 못했으면 요청을 failed-*.json으로 보존해
        // 조용히 사라지지 않게 한다(검토 지적 2026-10-26).
        var reported = false
        var handedOff = false
        defer { if !handedOff { settleQAClaim(claimed, reported: reported, paths: paths) } }
        guard QAFileSafety.isOwnedRegularFile(claimed),
              let fileSize = QAFileSafety.regularFileSize(claimed) else { return }
        guard let handle = FileHandle(forReadingAtPath: claimed.path) else { return }
        let data = handle.readData(ofLength: QARequestValidator.maxRequestBytes + 1)
        handle.closeFile()
        if fileSize > off_t(QARequestValidator.maxRequestBytes) || data.count > QARequestValidator.maxRequestBytes {
            reported = rejectQARequest(data: data, reason: QAValidationError.requestTooLarge.description)
            return
        }
        let request: QARequest
        do {
            request = try QARequestValidator.decode(data)
        } catch {
            reported = rejectQARequest(data: data, reason: String(describing: error))
            return
        }
        guard ensureQAOutputRoot(paths) else { return }
        let output = paths.outputRoot.appendingPathComponent(request.id, isDirectory: true)
        guard !QAFileSafety.pathExists(output) else {
            reported = writeQARejection(id: request.id, reason: QAValidationError.outputAlreadyExists.description, paths: paths)
            return
        }
        do {
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        } catch {
            reported = writeQARejection(id: request.id, reason: "could not create output directory: \(error.localizedDescription)", paths: paths)
            return
        }
        // 실행이 끝나 result.json을 저장할 때까지 요청 원문을 붙잡아 둔다. 저장에 실패하면 보존한다.
        handedOff = true
        let execution = QAExecution(request: request, outputDirectory: output, runtime: qaRuntime)
        qaExecution = execution
        execution.start { [weak self, weak execution] _ in
            self?.settleQAClaim(claimed, reported: execution?.resultSaved ?? false, paths: paths)
            self?.qaExecution = nil
        }
    }

    /// 결과(실행·거부)를 남긴 요청만 지우고, 아니면 qa/failed-<uuid>.json으로 옮긴다.
    /// 옮기지 못하면 claim이 남고, 다음 폴링의 recoverOrphanQAClaims가 다시 옮긴다.
    private func settleQAClaim(_ claimed: URL, reported: Bool, paths: QAPaths,
                               reason: String = "menubar app could not save a result for this request") {
        // 결과를 남기지 못한 요청은 경로와 상관없이 그 id로 거부 결과를 먼저 쓴다 — 기다리는 qa.sh가 바로 끝난다.
        let reported = reported || rejectQAClaim(claimed, reason: reason, paths: paths)
        if reported {
            do { try FileManager.default.removeItem(at: claimed) }
            catch { print("QA: could not remove handled request \(claimed.lastPathComponent): \(error.localizedDescription)") }
            fflush(stdout)
            return
        }
        let kept = paths.root.appendingPathComponent("failed-\(UUID().uuidString).json")
        do {
            try FileManager.default.moveItem(at: claimed, to: kept)
            print("QA: request kept without result → \(kept.lastPathComponent)")
        } catch {
            print("QA: could not keep request \(claimed.lastPathComponent) (retry on next poll): \(error.localizedDescription)")
        }
        fflush(stdout)
    }

    /// 실행 중이 아닐 때 남아 있는 .request-* claim은 주인이 없다(실행 중 앱 종료·정산 실패).
    /// 결과를 남기지 못한 요청이므로 그 id로 거부 결과를 쓰고, id를 못 찾으면 failed-*.json으로 보존한다.
    private func recoverOrphanQAClaims(_ paths: QAPaths) {
        guard qaExecution == nil,
              let names = try? FileManager.default.contentsOfDirectory(atPath: paths.root.path) else { return }
        for name in names where name.hasPrefix(".request-") {
            settleQAClaim(paths.root.appendingPathComponent(name), reported: false, paths: paths,
                          reason: "menubar app stopped before the request finished")
        }
    }

    /// claim 원문에서 id를 찾아 거부 결과를 쓴다. 실행이 끝나 result.json이 이미 있으면 결과가 있는 것으로 본다.
    private func rejectQAClaim(_ claim: URL, reason: String, paths: QAPaths) -> Bool {
        guard QAFileSafety.isOwnedRegularFile(claim), let handle = FileHandle(forReadingAtPath: claim.path) else { return false }
        let data = handle.readData(ofLength: QARequestValidator.maxRequestBytes + 1)
        handle.closeFile()
        let parsedID = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String
        guard let id = parsedID.flatMap({ QARequestValidator.validName($0, maxLength: 64) ? $0 : nil })
                ?? QARequestValidator.salvageID(from: data) else { return false }
        let finished = paths.outputRoot.appendingPathComponent(id, isDirectory: true).appendingPathComponent("result.json")
        return QAFileSafety.isOwnedRegularFile(finished) || writeQARejection(id: id, reason: reason, paths: paths)
    }

    private func ensureQAOutputRoot(_ paths: QAPaths) -> Bool {
        if !QAFileSafety.pathExists(paths.outputRoot) {
            try? FileManager.default.createDirectory(at: paths.outputRoot, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        }
        return QAFileSafety.isOwnedDirectory(paths.outputRoot)
    }

    /// 거부 결과를 남겼으면 true.
    private func rejectQARequest(data: Data, reason: String) -> Bool {
        let parsedID = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["id"] as? String
        guard let id = parsedID.flatMap({ QARequestValidator.validName($0, maxLength: 64) ? $0 : nil })
                ?? QARequestValidator.salvageID(from: data) else { return false }
        return writeQARejection(id: id, reason: reason, paths: QAPaths.current())
    }

    /// 거부한 요청도 결과를 남긴다. 결과 폴더를 만들 수 없으면(이미 있음 등) 옆에 `<id>.rejected.json`을 쓴다 —
    /// 결과 없이 지우면 qa.sh가 시간 초과까지 기다린다. 어느 쪽도 쓰지 못하면 false(요청은 보존된다).
    private func writeQARejection(id: String, reason: String, paths: QAPaths) -> Bool {
        guard ensureQAOutputRoot(paths) else { return false }
        let stamp = ISO8601DateFormatter().string(from: Date())
        let result = QAResult(id: id, startedAt: stamp, endedAt: stamp, completed: false, timeout: false,
                              steps: [QAStepResult(index: 0, kind: "request", ok: false, error: reason)])
        guard let data = try? JSONEncoder.qaEncoder.encode(result) else { return false }
        let output = paths.outputRoot.appendingPathComponent(id, isDirectory: true)
        if !QAFileSafety.pathExists(output),
           (try? FileManager.default.createDirectory(at: output, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])) != nil {
            return (try? QAFileSafety.atomicWrite(data, to: output.appendingPathComponent("result.json"))) != nil
        }
        let sidecar = paths.outputRoot.appendingPathComponent("\(id).rejected.json")
        guard !QAFileSafety.pathExists(sidecar) else { return false }
        return (try? QAFileSafety.atomicWrite(data, to: sidecar)) != nil
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
            return [L10n.titleClaudeMeasuring]
        }
        // 미설치 도구는 제목에 올리지 않는다. "로그인"·"오프라인"처럼 고칠 일이 있는 것으로 읽히면 안 된다.
        let teamClaudeSlot = teamClaudeNotice == nil ? currentTeamClaude?.titleSlot : nil
        let codexSlot = codexNotice == nil ? currentCodex?.titleSlot : nil
        let teamCodexSlot = teamCodexNotice == nil ? currentTeamCodex?.titleSlot : nil
        // 데이터 없으면 최소 정보 — 병렬 세션 수만이라도 의미 있음
        guard let usage = currentData, let today = usage.today else {
            return [teamClaudeSlot, teamCodexSlot, codexSlot, L10n.parallelSessions(parallelCount)].compactMap { $0 }
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
            "\(L10n.today) \(formatCost(today.totalCost))",
            "\(L10n.today) \(formatKRWShort(today.totalCost, rate: rate))",
            L10n.slotTokens(formatTokens(todayTokens)),
            "\(L10n.weeklyShort) \(formatCost(usage.weeklyTotalCost))",
            L10n.thisWeekShort(formatCost(usage.thisWeekCost)),
            L10n.slotThisMonth(formatCost(usage.thisMonthCost)),
            L10n.slotThisMonth(formatKRWShort(usage.thisMonthCost, rate: rate)),
            "\(L10n.allTime) \(formatKRWShort(usage.allTimeCost, rate: rate))",
            L10n.slotTotal(formatTokens(usage.allTimeTokens)),
            L10n.parallelSessions(parallelCount),
        ].compactMap { $0 }
        // codex 사용이 있으면 별도 슬롯으로 노출
        if codexCost > 0 { slots.append("Codex \(formatCost(codexCost))") }
        slots.append(usage.modelBreakdown.first?.label ?? today.models.first ?? "Claude") // 최다 비용 모델
        return slots
    }

    func setLoading() {
        DispatchQueue.main.async { [weak self] in
            self?.statusItem?.button?.title = "○ " + L10n.loading
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
                let measurement = L10n.tipMeasurement(health.measurementPendingCount, health.measurementUnavailableCount, health.quotaLimitedCount)
                let integration = " · " + (health.accountConfigDrift == 0 ? L10n.integrationOK : L10n.integrationDrift(health.accountConfigDrift))
                let codex = self.currentCodex.map { " · codex \($0.statusLabel) · calls \($0.todayCalls)/\($0.weekCalls)" } ?? ""
                button.toolTip = L10n.tipPrefix + " · teamclaude \(health.statusLabel) · \(fable) · active \(health.accountActive)/\(max(health.accountTotal, health.accountConfigured))\(integration)\(measurement)\(codex)\(cliTip)"
            } else if let codex = self.currentCodex {
                button.toolTip = L10n.tipPrefix + " · codex \(codex.statusLabel) · calls \(codex.todayCalls)/\(codex.weekCalls)\(cliTip)"
            } else if !cliSlots.isEmpty {
                button.toolTip = L10n.tipPrefix + cliTip
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
            let installed = !higgsfieldBinCandidates().isEmpty
            guard installed else {
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.isFetchingHiggsfield = false
                    self.lastHiggsfieldFetchedAt = Date()
                    if self.higgsfieldInstalled != false {
                        print("HIGGSFIELD: \(StatusVocabulary.notInstalled)")
                        fflush(stdout)
                    }
                    self.higgsfieldInstalled = false
                    self.currentHiggsfield = nil
                    self.scheduleDashboardRefresh(reason: "loadHiggsfieldInBackground")
                }
                return
            }
            let data = fetchHiggsfieldCredits()
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.higgsfieldInstalled = true
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
            notices: currentToolNotices,
            laneStaleNotes: dashboardStaleNotes,
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
        refreshActionDetails()
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
        DispatchQueue.global(qos: .utility).async { [weak self] in
            if let notice = grokPresenceNotice() {
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.isFetchingGrok = false
                    self.currentGrokSlot = nil
                    self.currentGrokCard = grokCardModel(for: notice)
                    print("GROK-SLOT: \(notice.headline)")
                    fflush(stdout)
                    self.updateTitle()
                    self.refreshBurnModel()
                    self.scheduleDashboardRefresh(reason: "loadGrokUsageInBackground")
                }
                return
            }
            self?.fetchGrokUsage()
        }
    }

    private func fetchGrokUsage() {
        fetchGrokMenuOutcome { [weak self] outcome in
            DispatchQueue.main.async {
                guard let self else { return }
                self.isFetchingGrok = false
                if case .percent = outcome { self.grokLastSuccessAt = Date() }
                // 제목 슬롯과 카드는 한 판정(grokPresentation)에서 함께 나온다.
                let presented = grokPresentation(outcome, previousSlot: self.currentGrokSlot, previousCard: self.currentGrokCard)
                self.currentGrokSlot = presented.slot
                self.currentGrokCard = presented.card
                let slot = presented.slot ?? L10n.grokNeedsCheck
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
                    self.currentAgyCard = agyCardModel(for: agyToolNotice())
                case .ready(let groups):
                    let lanes = agyVisibleGroups(groups)
                    if !lanes.isEmpty { self.agyLastSuccessAt = Date() }
                    self.agyHasValue = !lanes.isEmpty
                    self.currentAgyCard = lanes.isEmpty
                        ? AgyCardModel(message: L10n.agyNoGeminiLane, groups: [])
                        : AgyCardModel(message: nil, groups: lanes)
                case .failed:
                    if !self.agyHasValue {
                        self.currentAgyCard = AgyCardModel(message: L10n.agyNeedsCheck, groups: [])
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
        // 병합 경로가 새 TeamClaudeHealth를 만들어도 무중단 제어 상태가 화면까지 가도록 모든 출구에서 덧입힌다.
        defer {
            if let committed = currentTeamClaude {
                if committed.serverReachable && committed.accountConfigDrift == 0 { teamClaudeDriftPersists = false }
                currentTeamClaude?.serverResponseDelayed = !committed.serverReachable && teamClaudeResponseDelayed
                currentTeamClaude?.driftPersistsAfterReload = committed.accountConfigDrift > 0 && teamClaudeDriftPersists
            }
        }
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

            // 자동 경로는 supervisor를 재시작하지 않는다(재시작은 진행 중 요청을 모두 끊는다).
            var syncAttempted = false
            var syncOutcome: TeamClaudeSyncOutcome?
            if let syncReason, forcedSyncReason != nil || autoSyncAllowed {
                syncAttempted = true
                let result = syncTeamClaudeServerWithoutRestart(current: teamClaude)
                teamClaude = result.health
                syncOutcome = result.outcome
                if teamClaude.serverReachable { outageStartedAt = nil }
                print("TEAMCLAUDE-AUTOSYNC: \(syncReason) → \(result.outcome.logText)")
                fflush(stdout)
            }
            // 무응답이면 표시용으로 프로세스 생존을 본다. 살아 있으면 "응답 지연"이지 오프라인이 아니다.
            var responseDelayed = false
            if case .responseDelayed? = syncOutcome {
                responseDelayed = true
            } else if syncOutcome == nil, !teamClaude.serverReachable, teamClaude.configPresent,
                      case .responseDelayed = probeTeamClaudeOutage(port: teamClaude.serverPort ?? 3456) {
                responseDelayed = true
            }
            let driftPersists: Bool
            if case .driftPersists? = syncOutcome { driftPersists = true } else { driftPersists = false }

            DispatchQueue.main.async {
                guard let self = self else { return }
                self.teamClaudeResponseDelayed = responseDelayed
                if driftPersists { self.teamClaudeDriftPersists = true }
                if syncAttempted {
                    self.lastTeamClaudeAutoSyncAt = Date()
                    // 응답 지연은 복구 시도로 치지 않는다. 같은 장애 중 프로세스가 실제로 죽으면 다시 판정해야 한다.
                    if let outageStartedAt, !responseDelayed {
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
        teamCodexConfigPresent = FileManager.default.fileExists(atPath: "\(NSHomeDirectory())/.config/teamcodex.json")
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
        let timeout = ccusageTimeoutSeconds
        let outputLimit = ccusageOutputLimitBytes
        let clock = ccusageClock
        let previousWeekly = lastCcusageWeeklyData
        let previousMonthly = lastCcusageMonthlyData
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard ccusageInstalled() else {
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.isFetching = false
                    self.ccusageInstalledState = false
                    self.usageLoadOutcome = nil
                    self.scheduleDashboardRefresh(reason: "loadUsageInBackground")
                    self.updateTitle()
                }
                return
            }
            // 실행 실패·시간 초과·해석 실패는 "데이터 없음"이 아니다. 판정을 그대로 남긴다(이전 값은 지우지 않는다).
            let daily = loadCcusageDaily(timeoutSeconds: timeout, outputLimitBytes: outputLimit, clock: clock)
            guard let dailyData = daily.daily else {
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.isFetching = false
                    self.ccusageInstalledState = true
                    self.usageLoadOutcome = daily.outcome
                    self.scheduleDashboardRefresh(reason: "loadUsageInBackground")
                    self.updateTitle()
                }
                return
            }

            let rate = daily.rate
            if let quickData = daily.quick {
                print("CCUSAGE-QUICK: daily 반영 today=\(quickData.today?.period ?? "nil") cost=\(quickData.today?.totalCost ?? -1)")
                fflush(stdout)
                DispatchQueue.main.async {
                    self?.currentData = quickData
                    self?.scheduleDashboardRefresh(reason: "loadUsageInBackground")
                    self?.updateTitle()
                }
            }

            // weekly·monthly 실패는 조용히 daily 파생값으로 바꾸지 않는다. 이전 값을 두고 부분 실패로 표시한다.
            let aux = resolveCcusageAux(
                weekly: runCcusageCommand("weekly", timeoutSeconds: timeout, outputLimitBytes: outputLimit),
                monthly: runCcusageCommand("monthly", timeoutSeconds: timeout, outputLimitBytes: outputLimit),
                previousWeekly: previousWeekly, previousMonthly: previousMonthly, timeoutSeconds: timeout)
            // weekly·monthly가 자정을 넘겨도 판정과 같은 날을 본다(기본값 Date()를 쓰면 오늘이 새 날의 0원으로 덮인다).
            let data = parseUsageData(daily: dailyData, weekly: aux.weekly, monthly: aux.monthly, rate: rate,
                                      now: daily.now)
            print("CCUSAGE-FULL: today=\(data?.today?.period ?? "nil") cost=\(data?.today?.totalCost ?? -1) thisMonth=\(data?.thisMonthCost ?? -1) rate=\(rate)")
            fflush(stdout)

            DispatchQueue.main.async {
                guard let self = self else { return }
                self.isFetching = false
                self.ccusageInstalledState = true
                self.usageLoadOutcome = daily.outcome
                self.usagePartialFailures = aux.failures
                self.lastCcusageWeeklyData = aux.weekly
                self.lastCcusageMonthlyData = aux.monthly
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
        let timeout = ccusageTimeoutSeconds
        let outputLimit = ccusageOutputLimitBytes
        let clock = ccusageClock
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let daily = loadCcusageDaily(timeoutSeconds: timeout, outputLimitBytes: outputLimit, clock: clock)
            let quickData = daily.quick
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
                self.usageLoadOutcome = daily.outcome
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
        if isFetchingUsageQuick { return L10n.refreshingToday }
        if isFetching { return L10n.refreshingAll }
        if isRefreshingStatus { return L10n.refreshingStatus }
        return L10n.refreshNow
    }

    func measureMenuDetailText() -> String {
        if isMeasuringTeamClaude { return teamClaudeMeasureDetail ?? L10n.inProgress }
        if let teamClaudeMeasureDetail { return teamClaudeMeasureDetail }

        let unmeasuredCount = currentTeamClaude?.measurementPendingCount ?? 0
        if unmeasuredCount > 0 { return L10n.measurableNow(unmeasuredCount) }

        let unavailableCount = currentTeamClaude?.measurementUnavailableCount ?? 0
        if unavailableCount > 0 { return L10n.stateCheckCount(unavailableCount) }

        let quotaLimitedCount = currentTeamClaude?.quotaLimitedCount ?? 0
        return quotaLimitedCount > 0
            ? L10n.measuredWaiting(quotaLimitedCount)
            : L10n.allMeasured
    }

    /// 패널 본문이 쓸 수 있는 최대 높이. 화면에서 머리·하단 막대와 여백을 뺀 값이다.
    func dashboardMaxBodyHeight() -> CGFloat {
        let screenVisibleHeight = statusItem?.button?.window?.screen?.visibleFrame.height
            ?? NSScreen.main?.visibleFrame.height
            ?? 900
        return max(StatusMenuDashboardView.minimumBodyHeight, screenVisibleHeight - StatusMenuDashboardView.chromeHeight - 24)
    }

    /// 대시보드를 메뉴 항목에 올린다. 패널은 높이가 화면에 맞춰져 있고 탭 본문만 안에서 스크롤하므로
    /// 항목의 뷰는 언제나 패널 하나다. 갱신 전에 잡아 둔 본문 스크롤 위치를 되돌린다.
    /// menuWillOpen의 재구성과 updateCachedMenuPresentation의 제자리 갱신이 같이 쓰는 유일한 호스팅 경로다.
    func hostDashboard(_ dashboard: StatusMenuDashboardView, in item: NSMenuItem, previousScrollOrigin: NSPoint?) {
        if item.view !== dashboard {
            dashboard.frame.origin = .zero
            item.view = dashboard
        }
        if let previousScrollOrigin {
            dashboard.restoreBodyScroll(previousScrollOrigin)
        }
    }

    func updateCachedMenuPresentation() {
        guard let dashboard = cachedDashboardView,
              let dashboardItem = cachedDashboardItem else {
            return
        }
        let previousScrollOrigin = dashboard.bodyScrollOrigin
        dashboard.maxBodyHeight = dashboardMaxBodyHeight()

        dashboard.updateContent(
            teamClaude: currentTeamClaude,
            codex: currentCodex,
            teamCodex: currentTeamCodex,
            usage: currentData,
            higgsfield: currentHiggsfield,
            grok: currentGrokCard,
            agy: currentAgyCard,
            burnModel: currentBurnModel,
            notices: currentToolNotices,
            laneStaleNotes: dashboardStaleNotes,
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
            burnModel: currentBurnModel,
            notices: currentToolNotices,
            maxBodyHeight: dashboard.maxBodyHeight
        )
        dashboard.lastRefreshPhases?.mark("height")
        if !dashboard.heightFrozen { dashboard.frame.size.height = contentHeight }
        dashboard.lastRefreshPhases?.mark("frame")
        hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: previousScrollOrigin)
        dashboard.lastRefreshPhases?.mark("host")
        refreshActionDetails()
    }

    /// 동작 목록의 보조 문구(갱신 중·측정 상태)를 지금 상태로 맞춘다.
    func refreshActionDetails() {
        guard let dashboard = cachedDashboardView ?? openDashboardView else { return }
        dashboard.updateActionDetail(id: "refresh", detail: refreshMenuDetailText())
        dashboard.updateActionDetail(id: "measure", detail: measureMenuDetailText())
    }

    /// 하단 동작 막대의 동작 목록. 예전 메뉴의 동작 행을 하나도 빼지 않고 옮긴다.
    func dashboardActions(menu: NSMenu) -> [DashboardAction] {
        let closeMenu: () -> Void = { [weak menu] in menu?.cancelTracking() }
        var actions: [DashboardAction] = [
            DashboardAction(id: "refresh", group: .refresh, title: L10n.refresh, detail: refreshMenuDetailText(), keys: ["R"]) { [weak self] in
                self?.refreshAction(); closeMenu(); return nil
            },
            DashboardAction(id: "measure", group: .refresh, title: L10n.actionMeasure, detail: measureMenuDetailText()) { [weak self] in
                self?.measureTeamClaudeAction(); closeMenu(); return nil
            },
            DashboardAction(id: "import", group: .account, title: L10n.actionImport, detail: L10n.actionImportDetail) { [weak self] in
                self?.importClaudeCodeAccountAction(); closeMenu(); return nil
            },
            DashboardAction(id: "claude-oauth", group: .account, title: L10n.actionClaudeOAuth, detail: L10n.actionWebLoginDetail) { [weak self] in
                self?.addClaudeOAuthAccountAction(); closeMenu(); return nil
            },
            DashboardAction(id: "codex-oauth", group: .account, title: L10n.actionCodexOAuth, detail: L10n.actionWebLoginDetail) { [weak self] in
                self?.addCodexOAuthAccountAction(); closeMenu(); return nil
            },
            DashboardAction(id: "restart", group: .app, title: L10n.actionRestart, detail: L10n.actionRestartDetail) { [weak self] in
                self?.restartTeamClaudeAction(); closeMenu(); return nil
            },
        ]
        // 외부 배포본(.app)에서만 보인다. 내부 설치는 install.py의 LaunchAgent가 로그인 시 띄운다.
        if menubarLoginItemAvailable(bundlePath: Bundle.main.bundlePath) {
            actions.append(menubarLoginItemAction(enabled: menubarLoginItemIsEnabled(home: NSHomeDirectory())) { [weak self] in
                return self?.toggleLoginItem()
            })
        }
        actions.append(DashboardAction(id: "quit", group: .app, title: L10n.actionQuit, detail: "", keys: ["⌘", "Q"], danger: true) { [weak self] in
            self?.quitAction(); return nil
        })
        return actions
    }

    /// 패널 단축키(R·1–5·⌘K)를 받는 메뉴 항목. 메뉴가 열려 있는 동안 키보드 이벤트는 메뉴 추적 루프가 가져가
    /// 커스텀 뷰에 오지 않으므로, 키 등가(keyEquivalent)를 가진 높이 1pt 항목으로 받는다.
    func addDashboardShortcutItems(to menu: NSMenu) {
        for (key, command) in DashboardShortcut.keyEquivalents {
            guard let shortcut = DashboardShortcut.resolve(characters: key, command: command, otherModifiers: false) else { continue }
            let item = NSMenuItem(title: "", action: #selector(dashboardShortcutAction(_:)), keyEquivalent: key)
            item.keyEquivalentModifierMask = command ? [.command] : []
            item.target = self
            item.representedObject = DashboardShortcutBox(shortcut)
            item.view = NSView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: 1))
            menu.addItem(item)
        }
        // 예전 동작 행의 키 등가(⌘Q 종료)를 지킨다.
        let quit = NSMenuItem(title: "", action: #selector(quitAction), keyEquivalent: "q")
        quit.target = self
        quit.view = NSView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: 1))
        menu.addItem(quit)
    }

    @objc func dashboardShortcutAction(_ sender: NSMenuItem) {
        guard let box = sender.representedObject as? DashboardShortcutBox else { return }
        (openDashboardView ?? cachedDashboardView)?.perform(box.shortcut)
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
            cachedDashboardView.heightFrozen = true
            openDashboardView = cachedDashboardView
            qaRuntime.menuDidOpen()
            refreshActionDetails()
            loadFastStatusInBackground()
            return
        }

        // 메뉴 열릴 때마다 최신 데이터로 항목 재구성
        menu.removeAllItems()

        let maxBodyHeight = dashboardMaxBodyHeight()
        let dashboardContentHeight = StatusMenuDashboardView.preferredHeight(teamClaude: currentTeamClaude, codex: currentCodex, teamCodex: currentTeamCodex, usage: currentData, higgsfield: currentHiggsfield, burnModel: currentBurnModel, notices: currentToolNotices, maxBodyHeight: maxBodyHeight)
        let dashboard = StatusMenuDashboardView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: dashboardContentHeight))
        dashboard.maxBodyHeight = maxBodyHeight
        dashboard.onTeamRowsChange = { [weak self] in self?.scheduleDashboardRefresh(reason: "team-rows") }
        dashboard.onRefresh = { [weak self, weak menu] in
            self?.refreshAction()
            menu?.cancelTracking()
        }
        dashboard.actions = dashboardActions(menu: menu)
        dashboard.configure(
            teamClaude: currentTeamClaude,
            codex: currentCodex,
            teamCodex: currentTeamCodex,
            usage: currentData,
            higgsfield: currentHiggsfield,
            grok: currentGrokCard,
            agy: currentAgyCard,
            burnModel: currentBurnModel,
            notices: currentToolNotices,
            laneStaleNotes: dashboardStaleNotes,
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
        dashboard.heightFrozen = true
        openDashboardView = dashboard
        qaRuntime.menuDidOpen()
        cachedDashboardView = dashboard
        let dashboardItem = NSMenuItem()
        hostDashboard(dashboard, in: dashboardItem, previousScrollOrigin: nil)
        menu.addItem(dashboardItem)
        cachedDashboardItem = dashboardItem

        addDashboardShortcutItems(to: menu)

        // 메뉴가 열린 직후 서버 원본을 다시 읽고 위 dashboard를 실시간 갱신한다.
        loadFastStatusInBackground()
    }

    func menuDidClose(_ menu: NSMenu) {
        openDashboardView = nil
        // 닫혔으니 다음 열림을 위해 높이를 지금 내용에 맞춘다(아래 updateCachedMenuPresentation).
        cachedDashboardView?.heightFrozen = false
        // 다음에 열 때는 "지금 쓸 수 있나"부터 답한다(개요). 닫힌 동안 바꿔 두면 여는 순간 비용이 없다.
        cachedDashboardView?.setActionsOpen(false)
        cachedDashboardView?.selectTab(.overview)
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
        let config = currentTeamClaudeConfigPath().flatMap { readTeamClaudeJSON($0) }
        let proxyAuthorizationValue = tcString(tcDict(config?["proxy"])?["apiKey"])
        isMeasuringTeamClaude = true
        teamClaudeMeasureDetail = L10n.oauthRefreshing
        scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
        updateTitle()

        DispatchQueue.global(qos: .utility).async { [weak self] in
            let refreshExit = refreshTeamClaudeOAuthAccounts()
            guard refreshExit == 0 else {
                DispatchQueue.main.async {
                    self?.isMeasuringTeamClaude = false
                    self?.teamClaudeMeasureDetail = L10n.oauthRefreshFailed
                    self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                    self?.updateTitle()
                }
                return
            }

            DispatchQueue.main.async {
                self?.teamClaudeMeasureDetail = L10n.serverSyncing
                self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                self?.updateTitle()
            }
            // 재시작하지 않는다. CLI가 이미 반영했으면 그대로, 불일치만 worker SIGHUP으로 무중단 재로딩한다.
            let sync = syncTeamClaudeServerWithoutRestart(current: loadTeamClaudeHealth())
            print("TEAMCLAUDE-MEASURE-SYNC: \(sync.outcome.logText)")
            fflush(stdout)
            guard sync.health.serverReachable else {
                let detail: String
                if case .responseDelayed = sync.outcome {
                    detail = L10n.serverSlowRetry
                } else {
                    detail = L10n.serverConnectFailed
                }
                DispatchQueue.main.async {
                    self?.isMeasuringTeamClaude = false
                    self?.teamClaudeMeasureDetail = detail
                    self?.scheduleDashboardRefresh(reason: "measureTeamClaudeAction", immediate: true)
                    self?.updateTitle()
                }
                return
            }

            DispatchQueue.main.async {
                self?.teamClaudeMeasureDetail = L10n.measuringTitle
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
                    self.teamClaudeMeasureDetail = L10n.measureFailedRetry(pending)
                } else if unavailable > 0 {
                    self.teamClaudeMeasureDetail = L10n.stateCheckCount(unavailable)
                } else if quotaLimited > 0 {
                    self.teamClaudeMeasureDetail = L10n.measuredWaiting(quotaLimited)
                } else {
                    self.teamClaudeMeasureDetail = L10n.measuredCount(teamClaude.accounts.count)
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
        openTeamClaudeTerminal(commandTitle: L10n.terminalImport, arguments: ["import"])
        watchTeamClaudeConfigAfterExternalCommand(reason: "import")
    }

    @objc func addClaudeOAuthAccountAction() {
        openTeamClaudeTerminal(commandTitle: L10n.actionClaudeOAuth, arguments: ["login"])
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
            commandTitle: L10n.terminalClaudeReauth(name),
            arguments: arguments
        )
        watchTeamClaudeConfigAfterExternalCommand(reason: "reauth \(name)")
    }

    /// 구독 처리(해지 기록·종료로 확정·기록 지우기·되돌리기). Codex는 teamcodex CLI를 백그라운드에서 실행한다.
    /// 결과는 하단 막대에 6초 보이고, 표는 바로 다시 그린다. Codex는 프록시 status도 다시 읽는다.
    func wireSubscriptionActions() {
        let center = SubscriptionActionCenter.shared
        center.runner = { arguments, completion in
            DispatchQueue.global(qos: .userInitiated).async {
                let result = runTeamCodexSubscriptionCommand(arguments)
                DispatchQueue.main.async { completion(result) }
            }
        }
        center.onChange = { [weak self] in self?.refreshOpenDashboard(reason: "subscription") }
        center.onOutcome = { [weak self] outcome in
            guard let self else { return }
            print("SUBSCRIPTION-ACTION: succeeded=\(outcome.succeeded) restart=\(outcome.restartNeeded)")
            fflush(stdout)
            (self.openDashboardView ?? self.cachedDashboardView)?.showSubscriptionOutcome(outcome)
            self.refreshOpenDashboard(reason: "subscription")
            if outcome.succeeded { self.loadTeamCodexStatusInBackground() }
        }
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
              let recovery = teamCodexSubscriptionAwareRecovery(row, subscription: codexSubscriptionResolution(row, now: Date()), now: Date()),
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
            ? L10n.terminalCodexEnable
            : L10n.terminalCodexReauth
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
            commandTitle: L10n.actionCodexOAuth,
            arguments: ["codex", "login"],
            codexMode: true
        )
    }

    /// 사용자가 명시적으로 누르는 재시작. 끊길 진행 중 요청 수를 보여 주고 확인을 받은 뒤에만 -k 재시작한다.
    @objc func restartTeamClaudeAction() {
        let health = currentTeamClaude
        let port = health?.serverPort ?? 3456
        // 라벨이 launchd에 등록됐는지부터 본다. 미등록이면 kickstart는 쓸 수 없고(A4), 살아 있는 서버는 앱 소관이 아니다.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let launchd = probeTeamClaudeLaunchd()
            let plan = teamClaudeRestartPlan(
                launchd: launchd,
                port: launchd == .notLoaded ? probeTeamClaudePort(port) : .unknown
            )
            // 실행 파일 탐색도 로그인 셸 조회를 띄울 수 있어 백그라운드에서 끝낸다.
            let detachedExecutable = plan == .startDetached ? teamClaudeDetachedExecutable() : nil
            DispatchQueue.main.async {
                guard let self else { return }
                print("TEAMCLAUDE-RESTART: label=\(teamClaudeLaunchdLabel) plan=\(plan)")
                fflush(stdout)
                switch plan {
                case .forceRestartConfirmed:
                    // launchd에 등록된 서비스일 때만 온다. 끊길 진행 중 요청 수를 보여 주고 확인을 받은 뒤에만 -k 재시작한다.
                    let confirmation = teamClaudeRestartConfirmation(
                        inflight: health?.inflight,
                        serverReachable: health?.serverReachable ?? false
                    )
                    let alert = NSAlert()
                    alert.alertStyle = .warning
                    alert.messageText = confirmation.title
                    alert.informativeText = confirmation.message
                    // 첫 버튼(기본, Return)은 취소다. 재시작은 두 번째 버튼을 눌러야 한다.
                    alert.addButton(withTitle: confirmation.cancelTitle)
                    alert.addButton(withTitle: confirmation.confirmTitle)
                    NSApp.activate(ignoringOtherApps: true)
                    guard alert.runModal() == .alertSecondButtonReturn else {
                        print("TEAMCLAUDE-RESTART: 사용자 취소")
                        fflush(stdout)
                        return
                    }
                    print("TEAMCLAUDE-RESTART: 사용자 확인 inflight=\(health?.inflight.description ?? "unknown")")
                    fflush(stdout)
                    DispatchQueue.global(qos: .utility).async { [weak self] in
                        _ = forceRestartTeamClaudeServerConfirmedByUser()
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            self?.refreshStatusOnly()
                        }
                    }
                case .startDetached:
                    guard let executable = detachedExecutable else {
                        self.showTeamClaudeRestartNotice(L10n.restartNoExecutable)
                        return
                    }
                    DispatchQueue.global(qos: .utility).async { [weak self] in
                        _ = startTeamClaudeServerDetached(executable: executable)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self?.refreshStatusOnly() }
                    }
                case .leaveRunning:
                    self.showTeamClaudeRestartNotice(L10n.restartUnmanaged(teamClaudeLaunchdLabel))
                case .undetermined:
                    self.showTeamClaudeRestartNotice(L10n.restartUndetermined)
                }
            }
        }
    }

    private func showTeamClaudeRestartNotice(_ message: String) {
        let notice = NSAlert()
        notice.alertStyle = .informational
        notice.messageText = L10n.restartNoticeTitle
        notice.informativeText = message
        notice.addButton(withTitle: L10n.ok)
        NSApp.activate(ignoringOtherApps: true)
        notice.runModal()
    }

    @objc func toggleLoginItemAction() {
        _ = toggleLoginItem()
    }

    /// 로그인 시 열기를 켜고 끈다. 사용자 LaunchAgent 파일만 다루고, 바뀐 상태 문구를 돌려준다.
    func toggleLoginItem() -> String {
        let home = NSHomeDirectory()
        let enable = !menubarLoginItemIsEnabled(home: home)
        guard let executable = Bundle.main.executablePath else { return menubarLoginItemDetail(enabled: !enable) }
        do {
            try setMenubarLoginItem(enabled: enable, executablePath: executable, home: home)
            print("LOGIN-ITEM: \(menubarLoginItemDetail(enabled: enable))")
        } catch {
            print("LOGIN-ITEM: 변경 실패 \(error.localizedDescription)")
        }
        fflush(stdout)
        return menubarLoginItemDetail(enabled: menubarLoginItemIsEnabled(home: home))
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

/// 대시보드를 탭마다 한 장씩 그린다(탭 본문은 스크롤 없이 통째로). 첫 탭은 outputPath, 나머지는 "-<탭 id>"를 붙인 경로다.
/// panelHeight를 주면 모든 탭을 그 높이(메뉴가 실제로 여는 패널 높이)로 그린다 — 긴 탭은 본문 위쪽만 보이고 나머지는 스크롤 아래다.
/// 탭별로 실제로 그려진 글자(DrawnTextRecorder)와 미설치 안내 카드(ToolNoticeDrawLog)를 함께 돌려준다.
/// renderDashboardTabs가 이 탭 목록으로 쓸 이름(첫 탭은 outputPath 그대로, 나머지는 "-<탭>" 접미). 그리기와 정리가 같은 규칙을 쓴다.
func dashboardTabOutputPath(_ outputPath: String, tab: DashboardTab, tabs: [DashboardTab]) -> String {
    guard tab != tabs.first else { return outputPath }
    let url = URL(fileURLWithPath: outputPath)
    return url.deletingPathExtension().path + "-\(tab.id)." + (url.pathExtension.isEmpty ? "png" : url.pathExtension)
}

func renderDashboardTab(_ view: StatusMenuDashboardView, tab: DashboardTab, path: String, panelHeight: CGFloat? = nil)
    -> (texts: [String], notices: [String: String])? {
    DrawnTextRecorder.install()
    view.selectTab(tab)
    view.frame.size.height = panelHeight ?? StatusMenuDashboardView.chromeHeight + max(view.snapshotDocumentHeight(tab), 120)
    view.layoutSubtreeIfNeeded()
    ToolNoticeDrawLog.reset()
    DrawnTextRecorder.reset()
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
        fputs("DASHBOARD-TABS: bitmap 생성 실패 \(tab.id)\n", stderr)
        return nil
    }
    view.cacheDisplay(in: view.bounds, to: rep)
    DrawnTextRecorder.collectControlTitles(in: view)
    guard let png = rep.representation(using: .png, properties: [:]),
          (try? png.write(to: URL(fileURLWithPath: path), options: .atomic)) != nil else {
        fputs("DASHBOARD-TABS: 쓰기 실패 \(path)\n", stderr)
        return nil
    }
    return (DrawnTextRecorder.strings, ToolNoticeDrawLog.drawn)
}

/// 픽스처 스냅샷용: 첫 탭은 outputPath 그대로, 나머지는 "-<탭>" 접미. 실패하면 1로 끝낸다.
func renderDashboardTabs(_ view: StatusMenuDashboardView, outputPath: String, tabs: [DashboardTab], panelHeight: CGFloat? = nil)
    -> [(tab: DashboardTab, path: String, texts: [String], notices: [String: String])] {
    var results: [(tab: DashboardTab, path: String, texts: [String], notices: [String: String])] = []
    for tab in tabs {
        let path = dashboardTabOutputPath(outputPath, tab: tab, tabs: tabs)
        guard let drawn = renderDashboardTab(view, tab: tab, path: path, panelHeight: panelHeight) else { exit(1) }
        results.append((tab, path, drawn.texts, drawn.notices))
    }
    return results
}

/// 탭별 그려진 글자를 한 줄씩 출력한다(snapshot_test_locale.py가 읽는다).
func printDashboardTabTexts(_ results: [(tab: DashboardTab, path: String, texts: [String], notices: [String: String])]) {
    for result in results {
        print("TAB \(result.tab.id)=\(result.path)")
        for text in result.texts {
            print("TEXT \(result.tab.id)=\(text.replacingOccurrences(of: "\n", with: " "))")
        }
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
    let view = CodexStatusView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: CodexStatusView.preferredHeight(for: pool)))
    view.pool = pool
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: min(view.bounds.height, 720)), styleMask: [.titled, .closable], backing: .buffered, defer: false)
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
                == CodexStatusView.poolHeaderHeight + CGFloat(max(1, count)) * CodexStatusView.poolRowHeight
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
        // 접힌 Claude 행의 기록 없는 구독 버튼은 숨는다(입력 진입점은 펼친 행에 있다). 보이는 버튼만 기하를 본다.
        for button in subscriptions where !button.isHidden {
            precondition(view.bounds.contains(button.frame))
            precondition(button.attributedTitle.size().width < button.frame.width)
            precondition(button.accessibilityLabel()?.contains("결제일") == true)
            for other in view.subviews.compactMap({ $0 as? NSButton }) where other !== button {
                precondition(!button.frame.intersects(other.frame))
            }
        }
    }
    let codexLayoutPool = pool(32)
    let codexLayout = CodexStatusView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: CodexStatusView.preferredHeight(for: codexLayoutPool)))
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
    let claudeLayout = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: StatusMenuDashboardView.teamContentHeight(claudeLayoutHealth)))
    claudeLayout.health = claudeLayoutHealth
    verifySubscriptionLayout(claudeLayout, count: 16)
    // 행을 펼치면 그 행의 구독 버튼이 상세 칸에 온전한 폭으로 나타난다(기록이 없어도 입력 진입점은 사라지지 않는다).
    claudeLayout.expandedAccount = claudeRows[0].name
    claudeLayout.frame.size.height = TeamClaudeTableView.contentHeight(claudeLayoutHealth, expanded: claudeRows[0].name)
    claudeLayout.needsLayout = true
    verifySubscriptionLayout(claudeLayout, count: 16)
    let expandedEntry = claudeLayout.subviews.compactMap { $0 as? AccountSubscriptionButton }[0]
    precondition(!expandedEntry.isHidden && expandedEntry.frame.width > 200)
    claudeLayout.expandedAccount = nil
    claudeLayout.frame.size.height = StatusMenuDashboardView.teamContentHeight(claudeLayoutHealth)
    claudeLayout.layoutSubtreeIfNeeded()
    let scrollCheck = NSScrollView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: 400))
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
            burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
            notices: DashboardToolNotices(),
            maxBodyHeight: .greatestFiniteMagnitude
        )
    ))
    dashboard.configure(
        teamClaude: nil,
        codex: nil,
        teamCodex: initial,
        usage: nil,
        burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
        notices: DashboardToolNotices(),
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
            notices: DashboardToolNotices(),
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
                burnModel: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
                notices: DashboardToolNotices(),
                maxBodyHeight: .greatestFiniteMagnitude
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
    // 계정 명령 뒤에 프록시를 재시작하지 않는다(CLI가 worker SIGHUP으로 무중단 반영한다).
    precondition(!claudeLoginCommand.contains("kickstart"))
    precondition(!claudeLoginCommand.contains(" restart"))
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

// 빈 HOME 스모크(외부 배포 A1). 도구가 하나도 없는 맥에서 실제 로더와 실제 판정(AppDelegate.currentToolNotices)을
// 그대로 돌려 대시보드 한 장을 그리고, 카드마다 실제로 그려진 안내를 한 줄씩 출력한다.
// 실행: HOME·CFFIXED_USER_HOME을 빈 폴더로, CC_MENUBAR_<TOOL>_BIN을 없는 경로로 두고 부른다(Tests/snapshot_test_empty_home.py).
if let emptyIndex = CommandLine.arguments.firstIndex(of: "--empty-home-snapshot") {
    let outputPath = CommandLine.arguments.indices.contains(emptyIndex + 1)
        ? CommandLine.arguments[emptyIndex + 1]
        : NSTemporaryDirectory() + "cc-menubar-empty-home.png"
    _ = NSApplication.shared
    ToolNoticeDrawLog.isEnabled = true
    let delegate = AppDelegate()
    delegate.currentTeamClaude = loadTeamClaudeHealth()
    delegate.currentTeamCodex = loadTeamCodexPoolHealth()
    delegate.teamCodexConfigPresent = FileManager.default.fileExists(atPath: "\(NSHomeDirectory())/.config/teamcodex.json")
    delegate.currentCodex = loadCodexHealth()
    delegate.higgsfieldInstalled = !higgsfieldBinCandidates().isEmpty
    delegate.ccusageInstalledState = ccusageInstalled()
    // ccusage는 네트워크를 탈 수 있어 스냅샷에서는 실행하지 않는다. 설치돼 있으면 "확인 중"으로 남는다(판정 nil).
    if let notice = grokPresenceNotice() { delegate.currentGrokCard = grokCardModel(for: notice) }
    if agyExecutableURL() == nil { delegate.currentAgyCard = agyCardModel(for: agyToolNotice()) }
    delegate.refreshBurnModel()
    let notices = delegate.currentToolNotices
    let view = StatusMenuDashboardView(frame: NSRect(
        x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth,
        height: StatusMenuDashboardView.preferredHeight(
            teamClaude: delegate.currentTeamClaude, codex: delegate.currentCodex, teamCodex: delegate.currentTeamCodex,
            usage: delegate.currentData, higgsfield: delegate.currentHiggsfield,
            burnModel: delegate.currentBurnModel, notices: notices, maxBodyHeight: .greatestFiniteMagnitude)
    ))
    view.configure(
        teamClaude: delegate.currentTeamClaude, codex: delegate.currentCodex, teamCodex: delegate.currentTeamCodex,
        usage: delegate.currentData, higgsfield: delegate.currentHiggsfield,
        grok: delegate.currentGrokCard, agy: delegate.currentAgyCard,
        burnModel: delegate.currentBurnModel, notices: notices,
        parallelCount: 0, active: false,
        isMeasuringTeamClaude: false, teamClaudeMeasureDetail: nil, onMeasureTeamClaude: nil
    )
    // 탭마다 한 장. 안내 카드가 탭별로 실제로 그려졌는지(TAB-DRAWN)와 전체 합(DRAWN)을 함께 낸다.
    let results = renderDashboardTabs(view, outputPath: outputPath, tabs: DashboardTab.allCases)
    var drawn: [String: String] = [:]
    for result in results {
        drawn.merge(result.notices) { first, _ in first }
        print("TAB-DRAWN \(result.tab.id)=\(result.notices.keys.sorted().joined(separator: ","))")
    }
    for (card, headline) in drawn.sorted(by: { $0.key < $1.key }) {
        print("DRAWN \(card)=\(headline)")
    }
    for section in view.sections {
        print("SECTION \(section.id)=\(section.summary)")
    }
    printDashboardTabTexts(results)
    print("TITLE-SLOTS \(delegate.displaySlots().joined(separator: " | "))")
    print("BURN-LANES \(delegate.currentBurnModel.usages.map(\.lane).joined(separator: ","))")
    print("EMPTY-HOME-SNAPSHOT: \(outputPath) \(Int(view.bounds.width))x\(Int(view.bounds.height))")
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
    // Codex 풀은 프록시 status 모양 그대로 받아 실제 파서로 읽는다(make_dash_fixture.py --codex).
    let teamCodex = (fixture["teamcodex"] as? [String: Any]).flatMap { raw in
        (try? JSONSerialization.data(withJSONObject: raw)).flatMap { try? teamCodexPoolHealth(from: $0, port: 3457, serverPid: nil) }
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
            teamClaude: health, codex: nil, teamCodex: teamCodex, usage: nil,
            higgsfield: higgsfield, burnModel: burnModel, notices: DashboardToolNotices(),
            maxBodyHeight: .greatestFiniteMagnitude
        )
    ))
    view.configure(
        teamClaude: health, codex: nil, teamCodex: teamCodex, usage: nil,
        higgsfield: higgsfield,
        grok: GrokCardModel(headline: (fixture["grok"] as? String) ?? "Grok 21%", detail: nil),
        agy: AgyCardModel(message: nil, groups: []),
        burnModel: burnModel,
        notices: DashboardToolNotices(),
        // 픽스처가 지연 상태를 담고 있으면 그대로 그린다. 이 경로는 실패했을 때만 나타나서
        // 스냅샷이 다루지 않으면 눈으로 확인된 적 없는 화면이 된다(적대 리뷰 2026-09-24).
        laneStaleNotes: (fixture["staleNotes"] as? [String: String]) ?? [:],
        parallelCount: 0, active: true,
        isMeasuringTeamClaude: false, teamClaudeMeasureDetail: nil,
        onMeasureTeamClaude: nil
    )
    // --expand <계정>이면 개요에서 그 계정을 누른 것처럼 Claude 탭에서 행을 펼친다(펼친 상세 칸 확인용).
    if let expandIndex = CommandLine.arguments.firstIndex(of: "--expand"), CommandLine.arguments.indices.contains(expandIndex + 1) {
        view.openAccount(CommandLine.arguments[expandIndex + 1])
    }
    // --expand-codex <계정>이면 Codex 탭에서 그 계정의 구독 기록을 펼친다.
    if let expandIndex = CommandLine.arguments.firstIndex(of: "--expand-codex"), CommandLine.arguments.indices.contains(expandIndex + 1) {
        view.openCodexAccount(CommandLine.arguments[expandIndex + 1])
    }
    // --tab <id>면 그 탭 한 장, 아니면 탭 다섯 장(첫 장이 출력 경로, 나머지는 -<탭 id>).
    let tabs: [DashboardTab]
    if let tabIndex = CommandLine.arguments.firstIndex(of: "--tab"), CommandLine.arguments.indices.contains(tabIndex + 1) {
        guard let tab = DashboardTab.allCases.first(where: { $0.id == CommandLine.arguments[tabIndex + 1] }) else {
            fputs("DASHBOARD-SNAPSHOT: 모르는 탭 \(CommandLine.arguments[tabIndex + 1])\n", stderr)
            exit(2)
        }
        tabs = [tab]
    } else {
        tabs = DashboardTab.allCases
    }
    let results = renderDashboardTabs(view, outputPath: outputPath, tabs: tabs)
    printDashboardTabTexts(results)
    print("DASHBOARD-SNAPSHOT: \(outputPath) \(Int(view.bounds.width))x\(Int(view.bounds.height))")
    exit(0)
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
