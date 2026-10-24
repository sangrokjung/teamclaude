import Foundation

enum TeamClaudeFableState {
    case ready, limited, excluded, unconfirmed
}

struct TeamClaudeFableAvailability {
    let state: TeamClaudeFableState
    let reason: String
    var subscriptionAppearance: AccountSubscriptionAppearance = .standard
}

func teamClaudeFableAvailability(
    _ row: TeamClaudeAccountHealth, health: TeamClaudeHealth,
    subscription: AccountSubscriptionDetails, now: Date = Date(), includeFable: Bool = true
) -> TeamClaudeFableAvailability {
    let subscriptionAppearance: AccountSubscriptionAppearance =
        subscription.appearance(now: now) == .endDateReached || row.subscriptionEndReached
        || row.subscriptionEndsAt.map({ end in
            Calendar.current.startOfDay(for: end) < Calendar.current.startOfDay(for: now)
        }) == true ? .endDateReached : .standard
    func result(_ state: TeamClaudeFableState, _ reason: String,
                _ appearance: AccountSubscriptionAppearance? = nil) -> TeamClaudeFableAvailability {
        TeamClaudeFableAvailability(state: state, reason: reason,
            subscriptionAppearance: appearance ?? subscriptionAppearance)
    }
    if subscription.confirmation?.state == .ended || row.errorReason == "subscription-ended" {
        return result(.excluded, L10n.reasonPlanEnded, .ended)
    }
    if row.status == "error" {
        return result(.excluded, teamAccountErrorReasonLabel(row.errorReason), .standard)
    }
    if let reason = row.errorReason, !reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return result(.unconfirmed, L10n.reasonErrorCheck(teamAccountErrorReasonLabel(reason)), .standard)
    }
    if !row.enabled { return result(.excluded, L10n.reasonDisabled) }
    if let provider = row.provider, provider != "anthropic" {
        return result(.excluded, L10n.reasonNotClaude)
    }
    if !health.serverReachable { return result(.unconfirmed, TeamClaudeRowReason.offline) }
    guard ["active", "throttled", "exhausted"].contains(row.status) else {
        return result(.unconfirmed, L10n.reasonServerState)
    }
    if subscriptionAppearance == .endDateReached {
        return result(.unconfirmed, L10n.reasonEndDatePassed, .endDateReached)
    }
    if subscription.appearance(now: now) == .endDateReached {
        return result(.unconfirmed, L10n.reasonEndDatePassed, .endDateReached)
    }
    let elapsed = now.timeIntervalSince(health.checkedAt)
    guard elapsed >= 0, elapsed < 60, row.fableMeasurementCurrent else {
        return result(.unconfirmed, TeamClaudeRowReason.measurementStale)
    }
    var windows: [(String, Double?, Int?)] = [
        (L10n.sessionShort, row.sessionPercent, row.sessionResetSeconds),
        (L10n.windowAllWeekly, row.weeklyPercent, row.weeklyResetSeconds)
    ]
    if includeFable { windows.append(("Fable", row.fablePercent, row.fableResetSeconds)) }
    let threshold = health.quotaThresholdPercent
    guard threshold.isFinite, threshold > 0, threshold <= 100 else {
        return result(.unconfirmed, TeamClaudeRowReason.thresholdUnknown)
    }
    if [row.sessionResetAt, row.weeklyResetAt, includeFable ? row.fableResetAt : nil].compactMap({ $0 }).contains(where: { now >= $0 }) {
        return result(.unconfirmed, L10n.reasonResetPassed)
    }
    if windows.contains(where: { _, _, reset in reset.map { Double($0) <= elapsed } ?? false }) {
        return result(.unconfirmed, L10n.reasonResetPassed)
    }
    if row.status == "throttled" { return result(.limited, L10n.reasonThrottled) }
    if row.status == "exhausted" { return result(.limited, L10n.reasonQuotaReset) }
    let blocked = windows.filter { _, percent, reset in
        guard let percent, percent.isFinite, let reset, reset > 0 else { return false }
        return percent >= threshold
    }.map { $0.0 }
    if !blocked.isEmpty { return result(.limited, L10n.reasonWindowsBlocked(blocked.joined(separator: "·"))) }
    if row.usableFromProxy == false { return result(.excluded, L10n.reasonProxyExcluded) }
    guard row.usableFromProxy == true else { return result(.unconfirmed, L10n.reasonProxyUnknown) }
    guard let inflight = row.inflightCount, inflight >= 0,
          let capacity = row.concurrentCapacity, capacity > 0 else {
        return result(.unconfirmed, L10n.reasonConcurrencyUnknown)
    }
    if inflight >= capacity { return result(.limited, L10n.reasonConcurrencyBusy) }
    for (name, percent, reset) in windows {
        guard let percent, percent.isFinite, percent >= 0,
              let reset, reset > 0 else { return result(.unconfirmed, L10n.reasonWindowCheck(name)) }
    }
    return result(.ready, includeFable ? TeamClaudeRowReason.fableReady : TeamClaudeRowReason.opusReady)
}

func teamClaudeResetLabel(_ seconds: Int?, checkedAt: Date, now: Date, resetAt: Date? = nil) -> String {
    guard let seconds else { return formatTeamClaudeDuration(nil) }
    let remaining = resetAt?.timeIntervalSince(now) ?? (Double(seconds) - max(0, now.timeIntervalSince(checkedAt)))
    return remaining > 0 ? formatTeamClaudeDuration(Int(remaining.rounded(.up))) : L10n.remeasure
}

extension TeamClaudeHealth {
    func opusAvailability(store: AccountSubscriptionStore = .shared, now: Date = Date()) -> [String] {
        accounts.compactMap { row in
            let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
            let availability = teamClaudeFableAvailability(row, health: self,
                subscription: store.details(provider: "anthropic", uuid: local.uuid, fallbackConfirmation: row.subscriptionConfirmation),
                now: now, includeFable: false)
            return availability.state == .ready ? row.name : nil
        }
    }

    func fableAvailability(store: AccountSubscriptionStore = .shared, now: Date = Date()) -> [TeamClaudeFableAvailability] {
        accounts.map { row in
            let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
            return teamClaudeFableAvailability(row, health: self,
                subscription: store.details(provider: "anthropic", uuid: local.uuid, fallbackConfirmation: row.subscriptionConfirmation), now: now)
        }
    }

    /// 각 계정 행에 그릴 보조 줄. 높이 계산과 그리기가 이 한 함수의 답을 나눠 쓴다(TeamClaudeRowLines.swift).
    /// 구독 판정은 행의 AccountSubscriptionButton이 제목을 만들 때와 같은 details(로컬 설정 플랜 폴백 포함)로 해야
    /// 버튼이 보이는데 줄 높이가 없거나, 높이는 있는데 버튼이 숨는 어긋남이 없다.
    /// draw()처럼 이미 fableAvailability를 계산한 호출자는 availability를 넘겨 같은 시각의 판정을 재사용한다.
    func rowLines(store: AccountSubscriptionStore = .shared, now: Date = Date(),
                  availability: [TeamClaudeFableAvailability]? = nil) -> [TeamClaudeRowLines] {
        let availability = availability ?? fableAvailability(store: store, now: now)
        return zip(accounts, availability).map { row, state in
            let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
            let details = store.details(provider: "anthropic", uuid: local.uuid, fallbackPlan: local.plan,
                                        fallbackConfirmation: row.subscriptionConfirmation)
            let appearance = state.subscriptionAppearance == .standard ? details.appearance(now: now) : state.subscriptionAppearance
            // 구독 줄은 기록이 있을 때만 그린다. 기록이 없는 행의 입력 진입점은 펼친 행의 상세 칸에 있다.
            return TeamClaudeRowLines(
                reason: teamClaudeReasonLineIsInformative(state.reason),
                subscription: accountSubscriptionLineIsInformative(details, appearance: appearance))
        }
    }
}

/// 표의 상태 묶음. 구독이 끝난 계정은 판정과 무관하게 제외 묶음이다.
func teamClaudeRowGroup(_ state: TeamClaudeFableAvailability) -> TeamClaudeRowGroup {
    if state.subscriptionAppearance == .ended { return .excluded }
    switch state.state {
    case .ready: return .ready
    case .limited: return .limited
    case .unconfirmed: return .check
    case .excluded: return .excluded
    }
}

func teamClaudeErrorReason(_ raw: Any?) -> String? {
    guard let raw, !(raw is NSNull) else { return nil }
    guard let reason = raw as? String else { return "invalid-error-state" }
    return reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : reason
}

func teamClaudeQuotaNumber(_ raw: Any?) -> Double? {
    guard let value = raw as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
          value.doubleValue.isFinite else { return nil }
    return value.doubleValue
}

func teamClaudeStatusBool(_ raw: Any?) -> Bool? {
    guard let value = raw as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }
    return value.boolValue
}

func teamClaudeConcurrencyValue(_ raw: Any?, positive: Bool = false) -> Int? {
    guard let value = raw as? NSNumber, String(cString: value.objCType) != "c" else { return nil }
    let number = value.doubleValue
    guard number.isFinite, number >= (positive ? 1 : 0), number <= 1_000_000,
          number.rounded(.towardZero) == number else { return nil }
    return Int(number)
}

func teamClaudeSubscriptionConfirmation(_ raw: [String: Any]?, now: Date) -> AccountSubscriptionConfirmation? {
    guard let raw, let state = raw["state"] as? String,
          ["ended", "cancellation-scheduled", "end-date-reached"].contains(state) else { return nil }
    let end = parseTeamClaudeTimeMs(raw["endsAt"]).map { Date(timeIntervalSince1970: (Double($0) - 1) / 1000) }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    let recorded = parseTeamClaudeTimeMs(raw["recordedAt"]).map { Date(timeIntervalSince1970: Double($0) / 1000) }
    return AccountSubscriptionConfirmation(state: state == "ended" ? .ended : .scheduled,
        date: end.map { formatter.string(from: $0) }, checkedAt: recorded ?? now, source: "proxy-record")
}
