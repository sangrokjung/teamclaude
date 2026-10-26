import Cocoa

// 개요 탭 모델을 기존 로더·판정 결과에서 옮겨 담는다(새 계산 없음 — 고르고 문구를 붙이기만 한다).
// TeamClaudeHealth(main.swift)를 읽으므로 테스트 러너의 라이브러리 묶음 밖이다(run-tests.sh EXCLUDE_SOURCES).
//
// 숫자의 출처:
//  - 큰 숫자 = opusAvailability(세션·주간 여유, 프록시 라우팅 가능) — 지금 요청을 받는 계정.
//    띠·범례·기다리면 풀림·손볼 것도 같은 routingAvailability를 쓴다(Claude 탭 묶음·제목 라우팅 슬롯도 같다)
//  - Claude Fable 레인 = fableAvailability(.ready) — 예전 요약 띠의 "Claude Fable"
//  - Codex 레인 = TeamCodexPoolHealth.usableCount / poolCount
//  - Grok·agy 레인 = 카드 모델의 문구
//  - 띠 = 계정별 주간 사용률(weeklyPercent)과 주간 창 경과(weeklyResetAt / weeklyResetSeconds)
//  - 손볼 것 = 제외된 계정(구독 종료 제외) + Codex 되돌리기 제안(teamCodexAccountRecovery)
//  - 소진 미리보기 = SubscriptionBurnModel의 레인별 전망·판정 문구

/// 리셋까지 남은 초. teamClaudeResetLabel과 같은 기준(리셋 시각이 있으면 그것, 없으면 확인 시각 기준 초).
func teamClaudeRemainingSeconds(_ seconds: Int?, resetAt: Date?, checkedAt: Date, now: Date) -> Double? {
    if let resetAt { return resetAt.timeIntervalSince(now) }
    guard let seconds else { return nil }
    return Double(seconds) - max(0, now.timeIntervalSince(checkedAt))
}

let teamClaudeWeekSeconds: Double = 7 * 86_400
let teamClaudeSessionSeconds: Double = 5 * 3_600

/// 한 계정 행의 표시용 상태(톤·짧은 라벨). 판정은 fableAvailability가 이미 했고, 여기는 낱말만 고른다.
struct TeamClaudeRowPresentation {
    let tone: PanelTone
    let label: String
    let excluded: Bool
    let cap: PanelTone?
}

func teamClaudeRowPresentation(_ row: TeamClaudeAccountHealth, _ state: TeamClaudeFableAvailability) -> TeamClaudeRowPresentation {
    if state.subscriptionAppearance == .ended {
        return TeamClaudeRowPresentation(tone: .off, label: L10n.stateEnded, excluded: true, cap: .off)
    }
    switch state.state {
    case .ready:
        // 동시 요청이 가득 차도 라우팅 중이다. 대기로 그리지 않고 "사용 중 3/3"이라고 말한다(같은 민트 톤, 라우팅 가능으로 센다).
        let label = state.busy.map { L10n.stateBusy($0.inflight, $0.capacity) } ?? L10n.stateReady
        return TeamClaudeRowPresentation(tone: .ready, label: label, excluded: false, cap: nil)
    case .limited:
        return TeamClaudeRowPresentation(tone: .wait, label: L10n.stateLimited, excluded: false, cap: nil)
    case .unconfirmed:
        return TeamClaudeRowPresentation(tone: .wait, label: L10n.stateCheck, excluded: false, cap: nil)
    case .excluded:
        if !row.enabled, row.status != "error" {
            return TeamClaudeRowPresentation(tone: .off, label: L10n.stateDisabled, excluded: true, cap: .off)
        }
        let label = row.status == "error" ? teamAccountErrorReasonLabel(row.errorReason) : L10n.stateExcluded
        return TeamClaudeRowPresentation(tone: .error, label: label, excluded: true, cap: .error)
    }
}

/// 손볼 것 한 줄의 사유. 재인증으로 풀리는지, 아닌지를 먼저 말한다.
func teamClaudeTodoReason(_ row: TeamClaudeAccountHealth, _ state: TeamClaudeFableAvailability) -> String {
    if teamClaudeCanReauthenticate(enabled: row.enabled, status: row.status, source: row.source,
                                   provider: row.provider, errorReason: row.errorReason) {
        return L10n.todoReasonReauth
    }
    if row.errorReason == "subscription-disabled" { return L10n.todoReasonOrgBlocked }
    if !row.enabled { return L10n.todoReasonDisabled }
    return state.reason
}

struct DashboardOverviewInput {
    let teamClaude: TeamClaudeHealth?
    let teamCodex: TeamCodexPoolHealth?
    let grok: GrokCardModel
    let agy: AgyCardModel
    let burn: SubscriptionBurnModel
    let notices: DashboardToolNotices
    let now: Date
}

func makeOverviewModel(_ input: DashboardOverviewInput) -> OverviewModel {
    var model = OverviewModel()
    let now = input.now
    let claudeNotice = input.notices.sections["claude"]
    let codexNotice = input.notices.sections["codex"]
    model.claudeNotice = claudeNotice
    model.codexNotice = codexNotice

    var fableReady = 0
    var total = 0
    if let health = input.teamClaude, claudeNotice == nil {
        // 띠·범례·기다리면 풀림·손볼 것은 큰 숫자와 같은 라우팅 판정을 쓴다(실사용 QA 2026-10-25: 큰 숫자와 범례가
        // 서로 다른 판정을 보면 한쪽만 고쳐도 어긋난다). Fable 레인 숫자만 Fable 창까지 보는 판정이다.
        let availability = health.fableAvailability(now: now)
        let opus = health.opusAvailability(now: now)
        let routing = health.routingAvailability(now: now)
        total = max(health.accountTotal, health.accountConfigured, health.accounts.count)
        fableReady = availability.filter { $0.state == .ready }.count
        model.routable = opus.count
        model.total = total
        model.headline = health.serverReachable ? L10n.overviewHeadline(opus.count)
            : (health.serverResponseDelayed ? L10n.serverDelayed : L10n.serverOffline)

        var soonestSession: Double?
        var soonestWeekly: Double?
        var elapsedValues: [Double] = []
        var waitSession: (count: Int, soonest: Double?) = (0, nil)
        var waitWeekly: (count: Int, soonest: Double?) = (0, nil)
        for (row, state) in zip(health.accounts, routing) {
            let presentation = teamClaudeRowPresentation(row, state)
            let weeklyRemaining = teamClaudeRemainingSeconds(row.weeklyResetSeconds, resetAt: row.weeklyResetAt,
                                                             checkedAt: health.checkedAt, now: now)
            let sessionRemaining = teamClaudeRemainingSeconds(row.sessionResetSeconds, resetAt: row.sessionResetAt,
                                                              checkedAt: health.checkedAt, now: now)
            let elapsed = panelWindowElapsed(remainingSeconds: weeklyRemaining, windowSeconds: teamClaudeWeekSeconds)
            if !presentation.excluded, let elapsed { elapsedValues.append(elapsed) }
            if state.state == .ready {
                if let s = sessionRemaining, s > 0 { soonestSession = min(soonestSession ?? s, s) }
                if let w = weeklyRemaining, w > 0 { soonestWeekly = min(soonestWeekly ?? w, w) }
            }
            model.strip.append(OverviewStripColumn(
                name: row.name, label: presentation.label, tone: presentation.tone,
                weeklyPercent: row.weeklyPercent, sessionPercent: row.sessionPercent, fablePercent: row.fablePercent,
                weeklyElapsed: elapsed, excluded: presentation.excluded, cap: presentation.cap))
            switch presentation.tone {
            case .ready: model.readyCount += 1
            case .wait: model.waitCount += 1
            default: model.excludedCount += 1
            }
            if state.state == .limited {
                model.waitingNames.append(row.name)
                // 주간 창이 찼으면 며칠, 아니면 세션 창이 막은 것이라 몇 시간 안에 돌아온다.
                if (row.weeklyPercent ?? 0) >= panelRoutingThresholdPercent {
                    waitWeekly.count += 1
                    if let w = weeklyRemaining, w > 0 { waitWeekly.soonest = min(waitWeekly.soonest ?? w, w) }
                } else {
                    waitSession.count += 1
                    if let s = sessionRemaining, s > 0 { waitSession.soonest = min(waitSession.soonest ?? s, s) }
                }
            }

            // 손볼 것: 사람이 움직여야 풀리는 계정. 구독이 끝난 계정은 정리 대상이라 여기 넣지 않는다.
            guard state.state == .excluded, state.subscriptionAppearance != .ended else { continue }
            let canReauth = teamClaudeCanReauthenticate(enabled: row.enabled, status: row.status, source: row.source,
                                                        provider: row.provider, errorReason: row.errorReason)
            let orgBlocked = row.errorReason == "subscription-disabled"
            let action: OverviewTodoAction = canReauth ? .reauthenticate : (orgBlocked ? .subscriptionRecord : .none)
            let title: String? = canReauth ? L10n.reauthenticate : (orgBlocked ? L10n.checkSubscription : nil)
            model.todos.append(OverviewTodo(provider: "anthropic", name: row.name, accountUuid: row.accountUuid,
                                            label: presentation.label, reason: teamClaudeTodoReason(row, state),
                                            tone: presentation.tone, actionTitle: title, primary: canReauth, action: action))
        }
        // 오류를 먼저, 꺼 둔 계정은 그다음(SubscriptionPolicy의 권고 순서).
        model.todos.sort { ($0.tone == .error ? 0 : 1) < ($1.tone == .error ? 0 : 1) }
        var resetParts: [String] = []
        if let soonestSession { resetParts.append(L10n.sessionWindowIn(L10n.duration(seconds: Int(soonestSession)))) }
        if let soonestWeekly { resetParts.append(L10n.weeklyWindowIn(L10n.duration(seconds: Int(soonestWeekly)))) }
        model.resetLine = resetParts.isEmpty ? "" : L10n.resetsAfter(resetParts.joined(separator: " · "))
        if !elapsedValues.isEmpty {
            let mean = elapsedValues.reduce(0, +) / Double(elapsedValues.count)
            model.elapsedCaption = L10n.weekElapsedCaption(panelPercentNumber(mean * 100))
        }
        if waitSession.count > 0 {
            model.waitGroups.append(OverviewWaitGroup(window: .session, count: waitSession.count, soonestSeconds: waitSession.soonest))
        }
        if waitWeekly.count > 0 {
            model.waitGroups.append(OverviewWaitGroup(window: .weekly, count: waitWeekly.count, soonestSeconds: waitWeekly.soonest))
        }
        if !model.waitingNames.isEmpty {
            model.waitingCaption = model.waitGroups.isEmpty
                ? L10n.waitingCaption(model.waitingNames.joined(separator: " · "))
                : overviewWaitGroupsCaption(model.waitGroups)
        }
    }

    // Codex 되돌리기 제안도 손볼 것이다(재인증·다시 켜기).
    if let pool = input.teamCodex, codexNotice == nil {
        for account in pool.accounts {
            guard let recovery = teamCodexAccountRecovery(account, now: pool.checkedAt) else { continue }
            let state = teamCodexAccountState(account, switchThresholdPercent: pool.switchThresholdPercent, now: pool.checkedAt)
            let label = state == .failed ? teamAccountErrorReasonLabel(account.errorReason)
                : teamCodexAccountStateLabel(state, status: account.status, errorReason: account.errorReason)
            model.todos.append(OverviewTodo(provider: "codex", name: account.name, accountUuid: account.accountUuid,
                                            label: "Codex · \(label)",
                                            reason: recovery.followUpNote ?? recovery.toolTip,
                                            tone: recovery.kind == .reauth ? .error : .off,
                                            actionTitle: recovery.title, primary: recovery.kind == .reauth,
                                            action: .codexRecover(recovery.kind)))
        }
    }

    // 레인 4개
    let claudeLane: OverviewLane
    if let notice = claudeNotice {
        claudeLane = OverviewLane(name: "Claude Fable", value: L10n.notInstalled, unit: "", note: notice.headline, tab: .claude, quiet: true)
    } else if input.teamClaude == nil {
        claudeLane = OverviewLane(name: "Claude Fable", value: StatusVocabulary.checking, unit: "", note: L10n.waitingForValue, tab: .claude, quiet: true)
    } else {
        claudeLane = OverviewLane(name: "Claude Fable", value: "\(fableReady)", unit: "/ \(total)", note: L10n.fableLaneNote, tab: .claude, quiet: false)
    }
    let codexLane: OverviewLane
    if let notice = codexNotice {
        codexLane = OverviewLane(name: "Codex", value: L10n.notInstalled, unit: "", note: notice.headline, tab: .codex, quiet: true)
    } else if let pool = input.teamCodex {
        codexLane = OverviewLane(name: "Codex", value: "\(pool.usableCount)", unit: "/ \(pool.poolCount)",
                                 note: pool.serverReachable ? L10n.codexLaneNote : L10n.serverOffline, tab: .codex, quiet: false)
    } else {
        codexLane = OverviewLane(name: "Codex", value: StatusVocabulary.none, unit: "", note: StatusVocabulary.noData, tab: .codex, quiet: true)
    }
    let grokLane: OverviewLane
    if let notice = input.grok.notice {
        grokLane = OverviewLane(name: "Grok", value: L10n.notInstalled, unit: "", note: notice.headline, tab: .cli, quiet: true)
    } else if let percent = burnGrokPercent(input.grok.headline) {
        grokLane = OverviewLane(name: "Grok", value: "\(panelPercentNumber(percent))%", unit: "", note: L10n.usageRate, tab: .cli, quiet: false)
    } else {
        let value = input.grok.headline.hasPrefix("Grok ") ? String(input.grok.headline.dropFirst(5)) : input.grok.headline
        grokLane = OverviewLane(name: "Grok", value: value, unit: "", note: input.grok.laneNote ?? input.grok.detail ?? "", tab: .cli, quiet: true)
    }
    let agyLane: OverviewLane
    if let notice = input.agy.notice {
        agyLane = OverviewLane(name: "agy", value: L10n.notInstalled, unit: "", note: notice.headline, tab: .cli, quiet: true)
    } else if let group = input.agy.groups.first, let weekly = group.weekly, let remaining = agyRemainingLabel(weekly.remaining) {
        agyLane = OverviewLane(name: "agy", value: remaining, unit: "", note: L10n.agyLaneNote(agyDisplayName(group.name)), tab: .cli, quiet: true)
    } else {
        let message = input.agy.message ?? StatusVocabulary.checking
        let value = message.hasPrefix("agy ") ? String(message.dropFirst(4)) : message
        agyLane = OverviewLane(name: "agy", value: value, unit: "", note: L10n.waitingForValue, tab: .cli, quiet: true)
    }
    model.lanes = [claudeLane, codexLane, grokLane, agyLane]

    // 소진 미리보기: 레인별 전망과 판정(소진 탭의 표와 같은 문구).
    model.burnLines = input.burn.usages.map { usage in
        let verdict = burnVerdictDisplay(usage)
        return OverviewBurnLine(lane: burnLaneDisplayName(usage.lane),
                                projection: burnProjectionLabel(burnBindingProjection(usage)),
                                verdict: verdict.label, verdictColor: verdict.color)
    }
    if input.burn.usages.contains(where: {
        if case .extrapolation(let confidence) = burnBindingProjection($0).basis { return confidence == .low }
        return false
    }) {
        model.burnAside = L10n.lowConfidence
    }
    return model
}
