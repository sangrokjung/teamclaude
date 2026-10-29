import Foundation

// 계정별 구독 상태 보기(웹랩 시안 B 2차본, menubar/DESIGN.md "구독 상태").
// 화면에 보이는 상태는 다섯 가지다: 구독 중(확인됨) · 확인 안 됨 · 해지 예약 · 종료일 지남 · 해지 확정.
// Claude는 로컬 기록(AccountSubscriptionStore)과 프록시 기록 중 새 것을, Codex는 프록시 설정을 정본으로 하되
// 메뉴바가 방금 남긴 로컬 확정을 바로 보여 준다. 두 값이 다르면 펼친 행이 둘 다 보인다.
// 이 파일은 main.swift 없이 컴파일된다(테스트 러너의 라이브러리 묶음).

enum SubscriptionDisplayState: String, CaseIterable, Equatable {
    case active, unknown, scheduled, overdue, ended

    var label: String {
        switch self {
        case .active: return L10n.subStateActive
        case .unknown: return L10n.subStateUnknown
        case .scheduled: return L10n.subStateCancelScheduled
        case .overdue: return L10n.subStateOverdue
        case .ended: return L10n.subStateEnded
        }
    }

    /// 상태 아래 규칙 한 줄(시안 SUB_RULE).
    var rule: String {
        switch self {
        case .active: return L10n.subRuleActive
        case .unknown: return L10n.subRuleUnknown
        case .scheduled: return L10n.subRuleScheduled
        case .overdue: return L10n.subRuleOverdue
        case .ended: return L10n.subRuleEnded
        }
    }
}

/// 한 출처(로컬 또는 프록시)가 말하는 구독 기록.
struct SubscriptionRecordView: Equatable {
    var state: SubscriptionDisplayState
    var endDate: String? = nil
    /// billing-page · confirmation-email · user-confirmed · proxy-record
    var source: String? = nil
    var recordedAt: Date? = nil
}

/// 화면이 쓰는 합친 값. shown이 행·묶음·손볼 것을 정하고, local·proxy는 펼친 행에서 둘 다 보인다.
struct SubscriptionResolution: Equatable {
    var shown: SubscriptionRecordView
    var local: SubscriptionRecordView? = nil
    var proxy: SubscriptionRecordView? = nil

    var state: SubscriptionDisplayState { shown.state }
    /// 해지 기록이 있고 아직 확정 전(해지 예약 · 종료일 지남).
    var isCancelled: Bool { state == .scheduled || state == .overdue }
    var disagrees: Bool {
        guard let local, let proxy else { return false }
        return local.state != proxy.state
    }
}

/// 오늘 기준 그 날짜까지 남은 날 수(지난 날은 음수). 형식이 틀리면 nil.
func subscriptionDayOffset(_ date: String, now: Date) -> Int? {
    guard let end = accountSubscriptionDate(date) else { return nil }
    let calendar = Calendar.current
    return calendar.dateComponents([.day], from: calendar.startOfDay(for: now), to: calendar.startOfDay(for: end)).day
}

func subscriptionRecordView(_ confirmation: AccountSubscriptionConfirmation?, now: Date) -> SubscriptionRecordView? {
    guard let confirmation else { return nil }
    let state: SubscriptionDisplayState
    switch confirmation.state {
    case .renewing: state = .active
    case .ended: state = .ended
    case .scheduled:
        // 종료일 당일까지는 쓸 수 있다. 다음 날부터 지남.
        state = (confirmation.date.flatMap { subscriptionDayOffset($0, now: now) } ?? 0) < 0 ? .overdue : .scheduled
    }
    return SubscriptionRecordView(state: state, endDate: confirmation.date, source: confirmation.source,
                                  recordedAt: confirmation.checkedAt)
}

/// Claude 계정. 로컬 기록과 프록시 기록 중 나중에 기록된 쪽이 이긴다(AccountSubscriptionStore.details와 같은 규칙).
/// 프록시가 구독 종료로 판정한 오류(`subscription-ended`)는 기록과 무관하게 해지 확정이다.
func claudeSubscriptionResolution(local: AccountSubscriptionConfirmation?, proxy: AccountSubscriptionConfirmation?,
                                  errorReason: String?, proxyEndReached: Bool, now: Date) -> SubscriptionResolution {
    let localView = subscriptionRecordView(local, now: now)
    var proxyView = subscriptionRecordView(proxy, now: now)
    if errorReason == "subscription-ended" {
        proxyView = SubscriptionRecordView(state: .ended, endDate: proxyView?.endDate, source: "proxy-record",
                                           recordedAt: proxyView?.recordedAt)
    } else if proxyEndReached, proxyView?.state == .scheduled {
        proxyView?.state = .overdue
    }
    let shown: SubscriptionRecordView
    switch (localView, proxyView) {
    case let (local?, proxy?):
        if proxy.state == .ended && errorReason == "subscription-ended" { shown = proxy }
        else { shown = (proxy.recordedAt ?? .distantPast) > (local.recordedAt ?? .distantPast) ? proxy : local }
    case let (local?, nil): shown = local
    case let (nil, proxy?): shown = proxy
    case (nil, nil): shown = SubscriptionRecordView(state: .unknown)
    }
    return SubscriptionResolution(shown: shown, local: localView, proxy: proxyView)
}

/// Codex 프록시 status가 말하는 구독 상태. 기록이 없으면 nil(프록시는 "구독 중 확인됨"을 따로 기록하지 않는다).
func codexProxySubscriptionView(_ account: TeamCodexPoolAccount, now: Date) -> SubscriptionRecordView? {
    let endDate = account.subscriptionEndsAt.map { end -> String in
        // 프록시 endsAt은 "그날까지 사용"의 다음 순간이다. Claude 기록(teamClaudeSubscriptionConfirmation)과 같게 1ms 당겨 읽는다.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: end.addingTimeInterval(-0.001))
    }
    if account.isSubscriptionRetired(now: now) {
        return SubscriptionRecordView(state: .ended, endDate: endDate, source: "proxy-record")
    }
    if account.isSubscriptionEndDateReached(now: now) {
        return SubscriptionRecordView(state: .overdue, endDate: endDate, source: "proxy-record")
    }
    if account.isSubscriptionEnding(now: now) {
        return SubscriptionRecordView(state: .scheduled, endDate: endDate, source: "proxy-record")
    }
    return nil
}

/// Codex 계정. 프록시가 해지 확정이면 그 값, 아니면 메뉴바가 남긴 로컬 기록, 없으면 프록시 값.
/// 로컬 기록은 이 맥에서 처리한 뒤 프록시 재시작 전에도 상태가 바로 보이게 하려는 것이다.
func codexSubscriptionResolution(account: TeamCodexPoolAccount, local: AccountSubscriptionConfirmation?,
                                 now: Date) -> SubscriptionResolution {
    let localView = subscriptionRecordView(local, now: now)
    let proxyView = codexProxySubscriptionView(account, now: now)
    let shown: SubscriptionRecordView
    if let proxyView, proxyView.state == .ended { shown = proxyView }
    else { shown = localView ?? proxyView ?? SubscriptionRecordView(state: .unknown) }
    return SubscriptionResolution(shown: shown, local: localView, proxy: proxyView)
}

/// 풀 행 하나의 구독 상태(이 맥 기록은 프록시 status가 준 계정 uuid로 찾는다. CLI도 같은 uuid로 신원을 고정한다).
func codexSubscriptionResolution(_ account: TeamCodexPoolAccount, store: AccountSubscriptionStore = .shared,
                                 now: Date) -> SubscriptionResolution {
    let local = account.accountUuid.flatMap { $0.isEmpty ? nil : store.localConfirmation(provider: "codex", uuid: $0) }
    return codexSubscriptionResolution(account: account, local: local, now: now)
}

func codexSubscriptionTarget(_ account: TeamCodexPoolAccount, store: AccountSubscriptionStore = .shared)
    -> (target: SubscriptionTarget, billingDay: String?) {
    let billing = account.accountUuid.flatMap { $0.isEmpty ? nil : store.details(provider: "codex", uuid: $0).paymentDate }
    return (SubscriptionTarget(provider: "codex", name: account.name, accountUuid: account.accountUuid), billing)
}

// MARK: 문구

/// "2026-11-12" → "11/12"
func subscriptionShortDate(_ date: String) -> String {
    let parts = date.split(separator: "-")
    guard parts.count == 3, let month = Int(parts[1]), let day = Int(parts[2]) else { return date }
    return "\(month)/\(day)"
}

func subscriptionEvidenceLabel(_ source: String?) -> String? {
    switch source {
    case "user-confirmed": return L10n.subEvidenceUser
    case "billing-page": return L10n.subEvidenceBilling
    case "confirmation-email": return L10n.subEvidenceMail
    case "proxy-record": return L10n.subEvidenceProxy
    default: return nil
    }
}

private func subscriptionRemaining(_ date: String, now: Date) -> String? {
    guard let days = subscriptionDayOffset(date, now: now) else { return nil }
    if days > 0 { return L10n.subDaysLeft(days) }
    if days == 0 { return L10n.subEndsToday }
    return L10n.subDaysAgo(-days)
}

/// 행 아래 한 줄. 해지 계열만 쓴다(구독 중·확인 안 됨은 이름 옆 기호로 충분하다).
func subscriptionRowLine(_ view: SubscriptionRecordView, now: Date) -> String? {
    switch view.state {
    case .scheduled:
        guard let end = view.endDate else { return "\(L10n.subStateCancelScheduled) · \(L10n.subEndUnknown)" }
        let remaining = subscriptionRemaining(end, now: now).map { " · \($0)" } ?? ""
        return "\(L10n.subStateCancelScheduled) · \(L10n.subEndsOn(subscriptionShortDate(end)))\(remaining)"
    case .overdue:
        guard let end = view.endDate else { return L10n.subStateOverdue }
        return "\(L10n.subStateOverdue) · \(L10n.subEndsOn(subscriptionShortDate(end))) · \(L10n.subBeforeConfirm)"
    case .ended:
        let end = view.endDate.map { L10n.subEndsOn(subscriptionShortDate($0)) } ?? L10n.subEndUnrecorded
        let evidence = subscriptionEvidenceLabel(view.source).map { " · \($0)" } ?? ""
        return "\(L10n.subStateEnded) · \(end)\(evidence)"
    case .active, .unknown:
        return nil
    }
}

/// 펼친 행의 "구독" 값. 상태 라벨 뒤에 종료일·남은 날(또는 기록 없음).
func subscriptionStateDetail(_ view: SubscriptionRecordView, now: Date) -> String {
    switch view.state {
    case .scheduled, .overdue, .ended:
        guard let end = view.endDate else {
            return view.state == .ended ? L10n.subEndUnrecorded : L10n.subEndUnknown
        }
        let remaining = subscriptionRemaining(end, now: now).map { " · \($0)" } ?? ""
        return L10n.subEndsOn(subscriptionShortDate(end)) + remaining
    case .unknown: return L10n.subNoRecord
    case .active: return ""
    }
}

/// 펼친 행의 "근거" 값: "사용자 확인 · 10/28 14:00 기록". 기록이 없으면 nil.
func subscriptionEvidenceLine(_ view: SubscriptionRecordView) -> String? {
    guard let evidence = subscriptionEvidenceLabel(view.source) else { return nil }
    guard let at = view.recordedAt else { return evidence }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "M/d HH:mm"
    return "\(evidence) · \(L10n.subRecordedAt(formatter.string(from: at)))"
}

/// 해지 예약 파이가 찬 비율: 기록 시점 → 종료일 사이에서 지난 비율(0.12…0.92로 자른다).
func subscriptionCancelProgress(_ view: SubscriptionRecordView, now: Date) -> Double {
    guard view.state == .scheduled, let end = view.endDate.flatMap(accountSubscriptionDate),
          let at = view.recordedAt else { return 0.5 }
    let total = end.timeIntervalSince(at)
    guard total > 0 else { return 0.9 }
    return min(0.92, max(0.12, now.timeIntervalSince(at) / total))
}

// MARK: 손볼 것·되돌리기 버튼 분기

/// 손볼 것 한 줄의 동작. nil이면 그 계정은 손볼 것에서 빠진다.
struct SubscriptionTodoPlan: Equatable {
    let action: OverviewTodoAction
    let title: String?
    let primary: Bool
    let reason: String
}

/// Claude 계정: 해지 기록이 있는 인증 오류 계정은 재인증 대신 종료로 확정, 해지 확정 계정은 빠진다.
/// 조직 차단은 지금처럼 구독 확인, 기록 없는 인증 오류는 재인증에 해지 기록 안내를 붙인다.
func claudeSubscriptionTodoPlan(canReauth: Bool, orgBlocked: Bool, subscription: SubscriptionDisplayState,
                                baseReason: String) -> SubscriptionTodoPlan? {
    if subscription == .ended { return nil }
    let cancelled = subscription == .scheduled || subscription == .overdue
    if canReauth && cancelled {
        return SubscriptionTodoPlan(action: .confirmSubscriptionEnd, title: L10n.subActionConfirmEnd, primary: true,
                                    reason: L10n.subTodoReasonCancelled)
    }
    if canReauth {
        return SubscriptionTodoPlan(action: .reauthenticate, title: L10n.reauthenticate, primary: true,
                                    reason: "\(baseReason) · \(L10n.subTodoReauthHint)")
    }
    if orgBlocked {
        return SubscriptionTodoPlan(action: .subscriptionRecord, title: L10n.checkSubscription, primary: false, reason: baseReason)
    }
    return SubscriptionTodoPlan(action: .none, title: nil, primary: false, reason: baseReason)
}

/// Codex 행의 되돌리기 버튼. 해지 계정에는 다시 켜기·재인증을 권하지 않는다
/// (해지 확정은 돌아오지 않고, 해지 기록 + 인증 오류는 종료로 확정이 그 자리를 갖는다).
func teamCodexSubscriptionAwareRecovery(_ account: TeamCodexPoolAccount, subscription: SubscriptionResolution,
                                        now: Date) -> TeamCodexAccountRecovery? {
    if subscription.state == .ended || subscription.isCancelled { return nil }
    return teamCodexAccountRecovery(account, now: now)
}

/// Codex 계정이 손볼 것에 오를 때의 동작. nil이면 올리지 않는다.
func codexSubscriptionTodoPlan(_ account: TeamCodexPoolAccount, subscription: SubscriptionResolution,
                               now: Date) -> SubscriptionTodoPlan? {
    if subscription.state == .ended { return nil }
    let failed = account.status == "error" || account.errorReason != nil
    if subscription.isCancelled {
        guard failed else { return nil }
        return SubscriptionTodoPlan(action: .confirmSubscriptionEnd, title: L10n.subActionConfirmEnd, primary: true,
                                    reason: L10n.subTodoReasonCancelled)
    }
    guard let recovery = teamCodexAccountRecovery(account, now: now) else { return nil }
    return SubscriptionTodoPlan(action: .codexRecover(recovery.kind), title: recovery.title, primary: recovery.kind == .reauth,
                                reason: recovery.followUpNote ?? recovery.toolTip)
}
