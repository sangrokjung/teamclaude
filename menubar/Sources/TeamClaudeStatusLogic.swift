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
        case .disabled: return L10n.issueDisabledLong
        case .serverNotSynced: return L10n.issueNotSyncedLong
        case .accountError: return L10n.issueAccountErrorLong
        case .throttled: return L10n.reasonThrottled
        case .exhausted: return L10n.issueExhaustedLong
        case .quotaBlocked: return L10n.reasonQuotaReset
        case .staleSession: return L10n.issueStaleLong
        case .sessionMissing: return L10n.issueSessionMissingLong
        case .weeklyMissing: return L10n.issueWeeklyMissingLong
        case .fableMissing: return L10n.issueFableMissingLong
        }
    }

    var compactText: String {
        switch self {
        case .disabled: return L10n.stateInactive
        case .serverNotSynced: return L10n.issueNotSyncedShort
        case .accountError: return L10n.issueAccountErrorShort
        case .throttled: return L10n.issueThrottledShort
        case .exhausted: return L10n.issueExhaustedShort
        case .quotaBlocked: return L10n.quotaReset
        case .staleSession, .sessionMissing, .weeklyMissing, .fableMissing: return L10n.issueMeasureShort
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
    now: Date = Date(),
    sessionWindowAbsent: Bool = false
) -> TeamClaudeMeasurementIssue? {
    guard enabled else { return .disabled }
    if status == "configured" { return .serverNotSynced }
    if status == "error" { return .accountError }
    if status == "throttled" { return .throttled }
    if status == "exhausted" { return .exhausted }

    // 5시간 창이 없는 계정은 세션 값을 보지 않는다(남은 값이 실려 와도 무시, 누락도 측정 문제가 아니다).
    let sessionValue = sessionWindowAbsent ? nil : sessionPercent
    let knownMaximum = [sessionValue, weeklyPercent].compactMap { $0 }.max()
    if let knownMaximum, knownMaximum >= thresholdPercent {
        return .quotaBlocked
    }

    if sessionWindowAbsent {
        if weeklyPercent == nil { return .weeklyMissing }
        return fablePercent == nil ? .fableMissing : nil
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
    thresholdPercent: Double,
    sessionWindowAbsent: Bool = false
) -> Bool {
    guard enabled, status == "active", let weeklyPercent = weeklyPercent else { return false }
    // 5시간 창이 없는 계정(검증된 Ultra)은 주간 창만으로 판정한다.
    if sessionWindowAbsent { return weeklyPercent < thresholdPercent }
    guard let sessionPercent = sessionPercent else { return false }
    return max(sessionPercent, weeklyPercent) < thresholdPercent
}

/// 상태 응답 quota.sessionWindowStated가 JSON 불 false인가(5시간 창 없이 주간 창만 받는 계정, spec A6).
/// 필드 없음(구버전 프록시)·null·true·문자열·숫자는 전부 "있음"으로 읽어 지금 동작을 유지한다.
func teamClaudeSessionWindowAbsent(_ quota: [String: Any]?) -> Bool {
    guard let value = quota?["sessionWindowStated"] as? NSNumber,
          CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
    return !value.boolValue
}
