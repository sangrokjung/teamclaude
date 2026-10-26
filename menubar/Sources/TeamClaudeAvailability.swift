import Foundation

enum TeamClaudeFableState {
    case ready, limited, excluded, unconfirmed
}

/// 라우팅 중인 계정의 동시 요청 칸이 다 찼을 때의 부하. 대기가 아니라 바쁨이다.
struct TeamClaudeConcurrencyLoad: Equatable {
    let inflight: Int
    let capacity: Int
}

struct TeamClaudeFableAvailability {
    let state: TeamClaudeFableState
    let reason: String
    var subscriptionAppearance: AccountSubscriptionAppearance = .standard
    /// .ready인데 동시 요청이 가득 찼다(새 요청은 프록시 대기열에 선다). 라벨만 다르고 라우팅 가능으로 센다.
    var busy: TeamClaudeConcurrencyLoad? = nil
    /// .ready인데 로컬 창 사용률이 문턱 이상인 창 이름들. 프록시가 usable=true로 라우팅 중이라 프록시를 믿었다(유예 차선).
    var graceWindows: [String] = []
    /// .limited인데 문턱 이상이라 막힌 창 이름들. 비어 있으면 창이 아닌 이유(throttled·exhausted)로 기다린다.
    var blockedWindows: [String] = []
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
    guard elapsed >= 0, elapsed < 60, includeFable ? row.fableMeasurementCurrent : (row.routingMeasurementCurrent ?? row.fableMeasurementCurrent) else {
        return result(.unconfirmed, TeamClaudeRowReason.measurementStale)
    }
    var windows: [(String, Double?, Int?)] = [
        (L10n.sessionShort, row.sessionPercent, row.sessionResetSeconds),
        (L10n.windowAllWeekly, row.weeklyPercent, row.weeklyResetSeconds)
    ]
    let fableWindow = "Fable"
    if includeFable { windows.append((fableWindow, row.fablePercent, row.fableResetSeconds)) }
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
    let overThreshold = windows.filter { _, percent, reset in
        guard let percent, percent.isFinite, let reset, reset > 0 else { return false }
        return percent >= threshold
    }.map { $0.0 }
    // 프록시가 usable=true면 세션·주간 창은 프록시를 믿는다(5시간 한도 유예 차선은 98%를 넘어도 라우팅한다).
    // Fable 창은 프록시가 미리 막지 않는 모델 창이라(첫 429에서 판정) Fable 레인에서는 그대로 대기로 본다.
    let proxyRouting = row.usableFromProxy == true
    let grace = proxyRouting ? overThreshold.filter { $0 != fableWindow } : []
    let blocked = proxyRouting ? overThreshold.filter { $0 == fableWindow } : overThreshold
    if !blocked.isEmpty {
        var limited = result(.limited, L10n.reasonWindowsBlocked(blocked.joined(separator: "·")))
        limited.blockedWindows = blocked
        return limited
    }
    if row.usableFromProxy == false { return result(.excluded, L10n.reasonProxyExcluded) }
    guard proxyRouting else { return result(.unconfirmed, L10n.reasonProxyUnknown) }
    guard let inflight = row.inflightCount, inflight >= 0,
          let capacity = row.concurrentCapacity, capacity > 0 else {
        return result(.unconfirmed, L10n.reasonConcurrencyUnknown)
    }
    for (name, percent, reset) in windows {
        guard let percent, percent.isFinite, percent >= 0,
              let reset, reset > 0 else { return result(.unconfirmed, L10n.reasonWindowCheck(name)) }
    }
    // 동시 요청이 가득 찬 것은 대기가 아니다. 프록시는 이 계정으로 계속 보내고 새 요청은 줄을 선다.
    var ready = result(.ready, grace.isEmpty
        ? (includeFable ? TeamClaudeRowReason.fableReady : TeamClaudeRowReason.opusReady)
        : L10n.reasonProxyGrace(grace.joined(separator: "·")))
    ready.graceWindows = grace
    if inflight >= capacity { ready.busy = TeamClaudeConcurrencyLoad(inflight: inflight, capacity: capacity) }
    return ready
}

func teamClaudeResetLabel(_ seconds: Int?, checkedAt: Date, now: Date, resetAt: Date? = nil) -> String {
    guard let seconds else { return formatTeamClaudeDuration(nil) }
    let remaining = resetAt?.timeIntervalSince(now) ?? (Double(seconds) - max(0, now.timeIntervalSince(checkedAt)))
    return remaining > 0 ? formatTeamClaudeDuration(Int(remaining.rounded(.up))) : L10n.remeasure
}

extension TeamClaudeHealth {
    /// 지금 라우팅 가능한가(세션·주간 + 프록시 usable). 개요 큰 숫자·범례·띠·기다리면 풀림·제목 라우팅 슬롯이 이 한 판정을 쓴다.
    /// Fable 주간 창은 보지 않는다 — 그것은 Fable 레인(fableAvailability)의 일이다.
    func routingAvailability(store: AccountSubscriptionStore = .shared, now: Date = Date()) -> [TeamClaudeFableAvailability] {
        accounts.map { row in
            let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
            return teamClaudeFableAvailability(row, health: self,
                subscription: store.details(provider: "anthropic", uuid: local.uuid, fallbackConfirmation: row.subscriptionConfirmation),
                now: now, includeFable: false)
        }
    }

    func opusAvailability(store: AccountSubscriptionStore = .shared, now: Date = Date()) -> [String] {
        zip(accounts, routingAvailability(store: store, now: now)).compactMap { row, availability in
            availability.state == .ready ? row.name : nil
        }
    }

    /// 지금 라우팅 가능한 계정 수(동시 요청이 가득 찬 계정·유예 차선 포함). 개요 큰 숫자와 같은 값이다.
    var routableCount: Int { opusAvailability().count }

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
    /// draw()처럼 이미 판정(routingAvailability)을 계산한 호출자는 availability를 넘겨 같은 시각의 판정을 재사용한다.
    func rowLines(store: AccountSubscriptionStore = .shared, now: Date = Date(),
                  availability: [TeamClaudeFableAvailability]? = nil) -> [TeamClaudeRowLines] {
        // Claude 표 묶음과 같은 라우팅 판정이 기본이다(표의 높이·배치·그리기가 같은 답을 써야 한다).
        let availability = availability ?? routingAvailability(store: store, now: now)
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
