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
    /// API 키 계정의 판정이다. 표에서는 상태와 무관하게 "API 크레딧" 묶음으로 간다.
    var apiCredit = false
}

/// API 키 계정(spec B3·B10). 세션·주간 창이 없고 구독이 모두 소진된 뒤에야 프록시가 쓰는 유료 계층이다.
/// .ready는 "지금 받는 중"이 아니라 "쓸 수 있는 대기"다. 사유 줄에는 남은 금액(추정)·만료를 쓴다.
func teamClaudeApiCreditAvailability(_ row: TeamClaudeAccountHealth, health: TeamClaudeHealth,
                                     now: Date) -> TeamClaudeFableAvailability {
    func result(_ state: TeamClaudeFableState, _ reason: String) -> TeamClaudeFableAvailability {
        var availability = TeamClaudeFableAvailability(state: state, reason: reason)
        availability.apiCredit = true
        return availability
    }
    if row.apiCredit?.exhausted == true || row.errorReason == "credit-exhausted" {
        return result(.excluded, L10n.apiCreditExhaustedReason)
    }
    if row.status == "error" { return result(.excluded, teamAccountErrorReasonLabel(row.errorReason)) }
    if !row.enabled { return result(.excluded, L10n.reasonDisabled) }
    if !health.serverReachable { return result(.unconfirmed, TeamClaudeRowReason.offline) }
    let detail = row.apiCredit.map { teamClaudeApiCreditReason($0, now: now) } ?? L10n.reasonServerState
    switch row.status {
    // 크레딧은 남았지만 프록시가 usable:false(분당 토큰·요청 한도)로 준 키는 일시 대기다(영구 소진과 구분).
    case "active" where row.usableFromProxy == false: return result(.limited, L10n.reasonApiRateLimited)
    case "active": return result(.ready, detail)
    case "throttled", "exhausted": return result(.limited, row.status == "throttled" ? L10n.reasonThrottled : L10n.reasonQuotaReset)
    default: return result(.unconfirmed, L10n.reasonServerState)
    }
}

func teamClaudeFableAvailability(
    _ row: TeamClaudeAccountHealth, health: TeamClaudeHealth,
    subscription: AccountSubscriptionDetails, now: Date = Date(), includeFable: Bool = true
) -> TeamClaudeFableAvailability {
    if row.isApiKey { return teamClaudeApiCreditAvailability(row, health: health, now: now) }
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
    var windows: [(String, Double?, Int?)] = [(L10n.windowAllWeekly, row.weeklyPercent, row.weeklyResetSeconds)]
    // 5시간 창이 없는 계정(검증된 Ultra)은 잴 세션 창이 없다. 넣으면 "세션 확인 필요"로 영영 미확인에 머문다.
    if !row.sessionWindowAbsent { windows.insert((L10n.sessionShort, row.sessionPercent, row.sessionResetSeconds), at: 0) }
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

    /// 계정별 구독 상태(로컬 기록 + 프록시 기록). 이름 옆 기호·펼친 행·손볼 것이 이 한 판정을 쓴다.
    /// 로컬 값은 표의 구독 줄과 같은 details(메일 수집기 포함, 프록시 기록 제외)다.
    func subscriptionResolutions(store: AccountSubscriptionStore = .shared, now: Date = Date()) -> [SubscriptionResolution] {
        accounts.indices.compactMap { subscriptionResolution($0, store: store, now: now) }
    }

    /// 한 행의 구독 상태(subscriptionResolutions와 같은 판정).
    func subscriptionResolution(_ index: Int, store: AccountSubscriptionStore = .shared, now: Date = Date()) -> SubscriptionResolution? {
        guard accounts.indices.contains(index) else { return nil }
        let row = accounts[index]
        let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
        let details = store.details(provider: "anthropic", uuid: local.uuid, fallbackPlan: local.plan)
        return claudeSubscriptionResolution(local: details.confirmation, proxy: row.subscriptionConfirmation,
                                            errorReason: row.errorReason, proxyEndReached: row.subscriptionEndReached, now: now)
    }

    /// 처리 대상(신원은 로컬 설정에서 확인한 uuid). 결제일은 해지 기록 대화상자의 "결제일" 선택지다.
    func subscriptionTarget(_ index: Int, store: AccountSubscriptionStore = .shared) -> (target: SubscriptionTarget, billingDay: String?) {
        let row = accounts[index]
        let local = accountSubscriptionLocalAccount(provider: "anthropic", uuid: row.accountUuid, name: row.name)
        let billing = store.details(provider: "anthropic", uuid: local.uuid).paymentDate
        return (SubscriptionTarget(provider: "anthropic", name: row.name, accountUuid: local.uuid), billing)
    }

    /// 지금 라우팅 가능한 구독 계정. API 키 계정은 구독이 모두 소진된 뒤의 대기라 세지 않는다(apiCreditReadyCount).
    func opusAvailability(store: AccountSubscriptionStore = .shared, now: Date = Date()) -> [String] {
        zip(accounts, routingAvailability(store: store, now: now)).compactMap { row, availability in
            availability.state == .ready && !row.isApiKey ? row.name : nil
        }
    }

    /// API 키 계정 수와 그중 쓸 수 있는(크레딧 미소진·켜짐) 수, 크레딧 소진 수.
    var apiCreditCounts: (ready: Int, total: Int, exhausted: Int) {
        let keys = accounts.filter(\.isApiKey)
        return (keys.filter(\.isUsable).count, keys.count,
                keys.filter { $0.apiCredit?.exhausted == true || $0.errorReason == "credit-exhausted" }.count)
    }

    /// 구독 계정 수(제목·개요의 "N/M"의 M). API 키 계정은 따로 센다.
    var subscriptionAccountTotal: Int {
        max(0, max(accountTotal, accountConfigured, accounts.count) - accounts.filter(\.isApiKey).count)
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
            // API 키 행은 구독 기록이 없다. 사유 줄(남은 금액·만료·소진)만 그린다.
            return TeamClaudeRowLines(
                reason: teamClaudeReasonLineIsInformative(state.reason),
                subscription: !row.isApiKey && accountSubscriptionLineIsInformative(details, appearance: appearance))
        }
    }
}

/// 표의 상태 묶음. 구독이 끝난 계정은 판정과 무관하게 제외 묶음이다.
func teamClaudeRowGroup(_ state: TeamClaudeFableAvailability) -> TeamClaudeRowGroup {
    if state.apiCredit { return .apiCredit }
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
