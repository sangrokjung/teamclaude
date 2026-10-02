import Foundation

struct TeamClaudeAccountDrift: Equatable {
    let missingFromServer: Set<String>
    let extraOnServer: Set<String>
    let stateMismatch: Set<String>

    var count: Int { missingFromServer.count + extraOnServer.count + stateMismatch.count }
    var isEmpty: Bool { missingFromServer.isEmpty && extraOnServer.isEmpty && stateMismatch.isEmpty }
}

func teamClaudeAccountDrift(
    configuredNames: [String],
    serverNames: [String],
    configuredEnabled: [String: Bool] = [:],
    serverEnabled: [String: Bool] = [:]
) -> TeamClaudeAccountDrift {
    let configured = Set(configuredNames)
    let server = Set(serverNames)
    let common = configured.intersection(server)
    return TeamClaudeAccountDrift(
        missingFromServer: configured.subtracting(server),
        extraOnServer: server.subtracting(configured),
        stateMismatch: Set(common.filter { name in
            guard let configuredValue = configuredEnabled[name], let serverValue = serverEnabled[name] else {
                return false
            }
            return configuredValue != serverValue
        })
    )
}

enum TeamClaudeRecoveryReason: Equatable {
    case serverOffline
    case accountDrift(Int)
}

func teamClaudeRecoveryReason(
    serverReachable: Bool,
    configPresent: Bool,
    accountConfigDrift: Int
) -> TeamClaudeRecoveryReason? {
    if !serverReachable, configPresent { return .serverOffline }
    if accountConfigDrift > 0 { return .accountDrift(accountConfigDrift) }
    return nil
}

func teamClaudeShouldRetainQuota(
    candidateReachable: Bool,
    hasMeasuredQuota: Bool
) -> Bool {
    !candidateReachable && hasMeasuredQuota
}

struct TeamClaudeRefreshCoordinator: Equatable {
    private(set) var isRunning = false
    private(set) var isPending = false

    mutating func request() -> Bool {
        guard !isRunning else {
            isPending = true
            return false
        }
        isRunning = true
        return true
    }

    mutating func finish() -> Bool {
        let shouldRunAgain = isPending
        isRunning = false
        isPending = false
        return shouldRunAgain
    }
}

struct TeamClaudeQuotaPair: Equatable {
    let weeklyPercent: Double
    let weeklyResetSeconds: Int
    let fablePercent: Double
    let fableResetSeconds: Int
}

struct TeamClaudeFableSummary: Equatable {
    let known: Int
    let over: Int
    let maximum: Double?
    let average: Double?
}

func teamClaudeFableSummary(
    values: [Double],
    thresholdPercent: Double
) -> TeamClaudeFableSummary {
    TeamClaudeFableSummary(
        known: values.count,
        over: values.filter { $0 >= thresholdPercent }.count,
        maximum: values.max().map { ($0 * 10).rounded() / 10 },
        average: values.isEmpty
            ? nil
            : ((values.reduce(0, +) / Double(values.count)) * 10).rounded() / 10
    )
}

func teamClaudeQuotaPair(
    weeklyPercent: Double?,
    weeklyResetSeconds: Int?,
    fablePercent: Double?,
    fableResetSeconds: Int?
) -> TeamClaudeQuotaPair? {
    guard let weeklyPercent,
          let weeklyResetSeconds,
          let fablePercent,
          let fableResetSeconds else {
        return nil
    }
    return TeamClaudeQuotaPair(
        weeklyPercent: weeklyPercent,
        weeklyResetSeconds: weeklyResetSeconds,
        fablePercent: fablePercent,
        fableResetSeconds: fableResetSeconds
    )
}

func teamClaudeMergedQuotaPair(
    candidate: TeamClaudeQuotaPair?,
    previous: TeamClaudeQuotaPair?
) -> TeamClaudeQuotaPair? {
    candidate ?? previous
}

func teamClaudeAdjustedQuotaPair(
    _ pair: TeamClaudeQuotaPair?,
    elapsedSeconds: Int
) -> TeamClaudeQuotaPair? {
    guard let pair else { return nil }
    let elapsed = max(0, elapsedSeconds)
    let weeklyResetSeconds = pair.weeklyResetSeconds - elapsed
    let fableResetSeconds = pair.fableResetSeconds - elapsed
    guard weeklyResetSeconds > 0, fableResetSeconds > 0 else { return nil }
    return TeamClaudeQuotaPair(
        weeklyPercent: pair.weeklyPercent,
        weeklyResetSeconds: weeklyResetSeconds,
        fablePercent: pair.fablePercent,
        fableResetSeconds: fableResetSeconds
    )
}

func teamClaudeAdjustedResetSeconds(_ resetSeconds: Int?, elapsedSeconds: Int) -> Int? {
    guard let resetSeconds else { return nil }
    let adjusted = resetSeconds - max(0, elapsedSeconds)
    return adjusted > 0 ? adjusted : nil
}

func teamClaudeSafeInt64(_ value: Double) -> Int64? {
    guard value.isFinite,
          value >= -9_223_372_036_854_775_808.0,
          value < 9_223_372_036_854_775_808.0 else {
        return nil
    }
    return Int64(value)
}

func teamClaudeBoundedCount(_ value: Int?, maximum: Int) -> Int {
    guard let value, value >= 0, value <= maximum else { return 0 }
    return value
}

func teamClaudeAddingCounts(_ lhs: Int, _ rhs: Int, maximum: Int) -> Int {
    let (sum, overflow) = lhs.addingReportingOverflow(rhs)
    guard !overflow else { return maximum }
    return min(maximum, max(0, sum))
}

func teamClaudeCandidateIsCurrent(candidateCheckedAt: Date, currentCheckedAt: Date?) -> Bool {
    guard let currentCheckedAt else { return true }
    return candidateCheckedAt >= currentCheckedAt
}

func nextTeamClaudeOutageStartedAt(
    previous: TimeInterval?,
    candidateReachable: Bool,
    observedAt: TimeInterval
) -> TimeInterval? {
    candidateReachable ? nil : (previous ?? observedAt)
}

func teamClaudeShouldAutoRecover(
    candidateReachable: Bool,
    accountConfigDrift: Int,
    outageDurationSeconds: TimeInterval,
    minimumOutageSeconds: TimeInterval = 60
) -> Bool {
    if accountConfigDrift > 0 { return true }
    guard !candidateReachable else { return false }
    return outageDurationSeconds >= max(1, minimumOutageSeconds)
}

func teamClaudeShouldAttemptRecoveryForOutage(
    outageStartedAt: TimeInterval?,
    attemptedOutageStartedAt: TimeInterval?
) -> Bool {
    guard let outageStartedAt else { return false }
    return outageStartedAt != attemptedOutageStartedAt
}

func teamClaudeShouldAttemptRecoveryForDrift(
    topologySignature: Int,
    attemptedTopologySignature: Int?
) -> Bool {
    topologySignature != attemptedTopologySignature
}

enum TeamClaudeMeasurementIssue: Equatable {
    case disabled
    case serverNotSynced
    case accountError
    case throttled
    case exhausted
    case quotaBlocked
    case staleSession
    case sessionMissing
    case weeklyMissing
    case fableMissing

    var canMeasureNow: Bool {
        switch self {
        case .serverNotSynced, .accountError, .staleSession, .sessionMissing, .weeklyMissing, .fableMissing:
            return true
        case .disabled, .throttled, .exhausted, .quotaBlocked:
            return false
        }
    }

    var isMeasurementUnavailable: Bool { self == .throttled || self == .exhausted }

    var isQuotaLimited: Bool { self == .quotaBlocked }

    var displayText: String {
        switch self {
        case .disabled: return "비활성 계정"
        case .serverNotSynced: return "서버 동기화 필요"
        case .accountError: return "인증 확인 필요"
        case .throttled: return "일시 제한 해제 대기"
        case .exhausted: return "사용 한도 초기화 대기"
        case .quotaBlocked: return "사용 한도 리셋 대기"
        case .staleSession: return "세션 만료, 재측정 필요"
        case .sessionMissing: return "세션 사용량 미측정"
        case .weeklyMissing: return "주간 사용량 미측정"
        case .fableMissing: return "Fable 사용량 미측정"
        }
    }

    var compactText: String {
        switch self {
        case .disabled: return "비활성"
        case .serverNotSynced: return "동기화"
        case .accountError: return "인증확인"
        case .throttled: return "제한대기"
        case .exhausted: return "한도대기"
        case .quotaBlocked: return "한도리셋"
        case .staleSession, .sessionMissing, .weeklyMissing, .fableMissing: return "지금측정"
        }
    }
}

func teamClaudeCanReauthenticate(
    enabled: Bool,
    status: String,
    source: String?,
    provider: String?,
    errorReason: String?
) -> Bool {
    enabled
        && status == "error"
        && (source ?? "").lowercased() == "oauth"
        && (provider ?? "anthropic").lowercased() == "anthropic"
        && errorReason != "subscription-disabled"
}

struct TeamClaudeQuotaWindowState: Equatable {
    let utilization: Double?
    let resetAtMs: Int64?
}

struct TeamClaudeRetryAccountState: Equatable {
    let enabled: Bool
    let status: String
    let rateLimitedUntilMs: Int64?
    let windows: [TeamClaudeQuotaWindowState]
}

func teamClaudeCurrentQuotaUtilization(
    _ utilization: Double?,
    resetAtMs: Int64?,
    nowMs: Int64
) -> Double? {
    guard let utilization,
          utilization.isFinite,
          utilization >= 0,
          let resetAtMs,
          resetAtMs > nowMs else {
        return nil
    }
    return utilization
}

func teamClaudeRetryAfterSeconds(
    accounts: [TeamClaudeRetryAccountState],
    threshold: Double,
    nowMs: Int64,
    unknownRetrySeconds: Int = 60
) -> Int? {
    var soonestDelayMs: Int64?

    for account in accounts where account.enabled && account.status != "error" && account.status != "configured" {
        var isBlocked = account.status == "exhausted"
        var freeAtMs: Int64 = 0

        if account.status == "throttled" {
            if let rateLimitedUntilMs = account.rateLimitedUntilMs {
                if rateLimitedUntilMs > nowMs {
                    isBlocked = true
                    freeAtMs = rateLimitedUntilMs
                }
            } else {
                isBlocked = true
            }
        }

        for window in account.windows {
            guard let utilization = teamClaudeCurrentQuotaUtilization(
                window.utilization,
                resetAtMs: window.resetAtMs,
                nowMs: nowMs
            ), utilization >= threshold else {
                continue
            }
            isBlocked = true
            if let resetAtMs = window.resetAtMs {
                freeAtMs = max(freeAtMs, resetAtMs)
            }
        }

        guard isBlocked else { continue }
        let delayMs = freeAtMs > nowMs
            ? freeAtMs - nowMs
            : Int64(max(1, unknownRetrySeconds)) * 1_000
        if let currentDelayMs = soonestDelayMs {
            if delayMs < currentDelayMs { soonestDelayMs = delayMs }
        } else {
            soonestDelayMs = delayMs
        }
    }

    guard let soonestDelayMs else { return nil }
    return max(1, Int(ceil(Double(soonestDelayMs) / 1_000.0)))
}

enum TeamClaudeSessionState: Equatable {
    case measured(Double)
    case stale
    case unknown

    var percent: Double? {
        switch self {
        case .measured(let value): return value
        case .stale: return nil
        case .unknown: return nil
        }
    }

    var isStale: Bool {
        if case .stale = self { return true }
        return false
    }
}

func teamClaudeSessionState(
    percent: Double?,
    lastUsed: Date?,
    now: Date = Date(),
    sessionWindow: TimeInterval = 5 * 60 * 60
) -> TeamClaudeSessionState {
    if let percent = percent {
        return .measured(percent)
    }
    if let lastUsed = lastUsed, now.timeIntervalSince(lastUsed) >= sessionWindow {
        return .stale
    }
    return .unknown
}

func teamClaudeQuotaNeedsRefresh(
    sessionPercent: Double?,
    weeklyPercent: Double?,
    fablePercent: Double?,
    lastUsed: Date?,
    now: Date = Date(),
    enabled: Bool = true,
    status: String = "active",
    thresholdPercent: Double = 98
) -> Bool {
    teamClaudeMeasurementIssue(
        enabled: enabled,
        status: status,
        sessionPercent: sessionPercent,
        weeklyPercent: weeklyPercent,
        fablePercent: fablePercent,
        lastUsed: lastUsed,
        thresholdPercent: thresholdPercent,
        now: now
    )?.canMeasureNow == true
}

func teamClaudeMeasurementIssue(
    enabled: Bool,
    status: String,
    sessionPercent: Double?,
    weeklyPercent: Double?,
    fablePercent: Double?,
    lastUsed: Date?,
    thresholdPercent: Double = 98,
    now: Date = Date()
) -> TeamClaudeMeasurementIssue? {
    guard enabled else { return .disabled }
    if status == "configured" { return .serverNotSynced }
    if status == "error" { return .accountError }
    if status == "throttled" { return .throttled }
    if status == "exhausted" { return .exhausted }

    let knownMaximum = [sessionPercent, weeklyPercent].compactMap { $0 }.max()
    if let knownMaximum, knownMaximum >= thresholdPercent {
        return .quotaBlocked
    }

    let hasMissingValue = sessionPercent == nil || weeklyPercent == nil || fablePercent == nil
    guard hasMissingValue else { return nil }

    let session = teamClaudeSessionState(percent: sessionPercent, lastUsed: lastUsed, now: now)
    if session.isStale { return .staleSession }
    if session.percent == nil { return .sessionMissing }
    if weeklyPercent == nil { return .weeklyMissing }
    return .fableMissing
}

func teamClaudeAccountIsUsable(
    enabled: Bool,
    status: String,
    sessionPercent: Double?,
    weeklyPercent: Double?,
    fablePercent: Double?,
    thresholdPercent: Double
) -> Bool {
    guard enabled,
          status == "active",
          let sessionPercent = sessionPercent,
          let weeklyPercent = weeklyPercent else {
        return false
    }
    return max(sessionPercent, weeklyPercent) < thresholdPercent
}
