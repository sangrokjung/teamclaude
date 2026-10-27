// menubar/Tests/MenubarRoutabilityTests.swift
import Cocoa

// 실사용 QA(2026-10-25)에서 찾은 결함을 실제 생산 타입으로 고정한다.
//  1. 프록시가 usable=true로 라우팅 중인 계정(동시 요청이 가득 찼거나 5시간 창이 문턱을 넘은 유예 차선)을
//     패널이 "대기"로 그렸다. 큰 숫자·문장·범례·제목 슬롯·Claude 탭 묶음이 모두 프록시와 같은 답을 해야 한다.
//  2. 패널 높이가 가장 긴 탭(계정 20개 Claude 탭)에 묶여 개요 아래 절반이 비었다.
//  3. Grok 갱신 필요가 개요 레인에서 보조 줄 없이 그려졌다.
//  4. 신뢰 낮은 소진 전망이 423% 같은 숫자로 찍혔다.
// TeamClaudeHealth·StatusMenuDashboardView가 main.swift에 있어 러너가 직접 못 돌린다 —
// test_menubar_routability.py가 main.swift 진입점 앞부분을 잘라 붙여 컴파일한다.
@main
struct MenubarRoutabilityTests {
    static func main() {
        _ = NSApplication.shared
        L10n.language = .ko
        let now = Date()
        testAvailabilityTrustsProxy(now: now)
        testConsumersAgree(now: now)
        testCommitPathWithoutFable(now: now)
        testPanelHeight(now: now)
        testGrokLane(now: now)
        testBurnLine(now: now)
        print("MenubarRoutabilityTests: availability, consumers, panel height, grok lane, burn line passed")
    }

    // MARK: 픽스처 — 프록시 /teamclaude/status 모양을 실제 파서로 읽는다

    static func account(_ name: String, usable: Bool?, session: Double, weekly: Double, fable: Double? = 0.4,
                        inflight: Int = 0, capacity: Int = 3, status: String = "active", enabled: Bool = true,
                        now: Date) -> [String: Any] {
        let nowMs = Int64(now.timeIntervalSince1970 * 1000)
        var quota: [String: Any] = [
            "unified5h": session, "unified7d": weekly,
            "unified5hReset": nowMs + 2 * 3_600_000, "unified7dReset": nowMs + 3 * 86_400_000,
            "unifiedStatus": "allowed_warning",
        ]
        if let fable {
            quota["modelWeekly"] = ["7d_oi": ["utilization": fable, "reset": nowMs + 3 * 86_400_000]]
        }
        var row: [String: Any] = [
            "name": name, "type": "oauth", "provider": "anthropic", "accountUuid": "routability-\(name)",
            "status": status, "enabled": enabled, "quota": quota,
            "usage": ["totalInputTokens": 1, "totalOutputTokens": 1, "totalRequests": 1],
            "inflight": inflight, "maxConcurrent": capacity,
        ]
        if let usable { row["usable"] = usable }
        return row
    }

    static func health(_ accounts: [[String: Any]], now: Date) -> TeamClaudeHealth {
        let usable = accounts.filter { ($0["usable"] as? Bool) == true }.count
        let status: [String: Any] = ["accounts": accounts, "usableCount": usable, "totalCount": accounts.count,
                                     "switchThreshold": 0.98]
        return parseTeamClaudeHealth(config: nil, server: nil, status: status, port: 3456, now: now)
    }

    static func single(_ row: [String: Any], now: Date, includeFable: Bool = false) -> TeamClaudeFableAvailability {
        let parsed = health([row], now: now)
        return teamClaudeFableAvailability(parsed.accounts[0], health: parsed, subscription: AccountSubscriptionDetails(),
                                           now: now, includeFable: includeFable)
    }

    /// 사용자 맥의 실제 모양: 20개 중 하나만 프록시가 라우팅 중(5시간 98%·주간 76%·동시 3/3), 나머지는 주간 한도.
    static func liveLikePool(now: Date) -> TeamClaudeHealth {
        var rows = [account("acct-01", usable: true, session: 0.98, weekly: 0.76, inflight: 3, capacity: 3, now: now)]
        for index in 2...20 {
            rows.append(account(String(format: "acct-%02d", index), usable: false, session: 0.5, weekly: 1.0, now: now))
        }
        return health(rows, now: now)
    }

    // MARK: 1. 판정

    static func testAvailabilityTrustsProxy(now: Date) {
        // 프록시가 라우팅 중인데 동시 요청이 가득 찼다 → 라우팅 가능 + 바쁨.
        let busy = single(account("busy", usable: true, session: 0.2, weekly: 0.3, inflight: 3, capacity: 3, now: now), now: now)
        precondition(busy.state == .ready, "usable + at capacity must stay routable: \(busy.reason)")
        precondition(busy.busy == TeamClaudeConcurrencyLoad(inflight: 3, capacity: 3), "\(String(describing: busy.busy))")
        precondition(teamClaudeRowGroup(busy) == .ready)
        precondition(!teamClaudeReasonLineIsInformative(busy.reason), "the busy label already says it; no extra row line")
        let notBusy = single(account("idle", usable: true, session: 0.2, weekly: 0.3, inflight: 2, capacity: 3, now: now), now: now)
        precondition(notBusy.state == .ready && notBusy.busy == nil)

        // 유예 차선: 로컬 창은 문턱(98%)을 넘었지만 프록시가 usable=true로 라우팅 중 → 프록시를 믿는다. 창 정보는 사유로 남긴다.
        let grace = single(account("grace", usable: true, session: 0.98, weekly: 0.76, now: now), now: now)
        precondition(grace.state == .ready, "usable + session ≥ threshold must stay routable: \(grace.reason)")
        precondition(grace.graceWindows == [L10n.sessionShort], "\(grace.graceWindows)")
        precondition(teamClaudeReasonLineIsInformative(grace.reason), "keep the window info visible: \(grace.reason)")
        precondition(grace.reason.contains(L10n.sessionShort), grace.reason)
        // 둘 다(사용자 맥의 그 계정).
        let both = single(account("both", usable: true, session: 0.98, weekly: 0.76, inflight: 3, capacity: 3, now: now), now: now)
        precondition(both.state == .ready && both.busy != nil && !both.graceWindows.isEmpty)

        // Fable 레인은 Fable 창 의미를 지킨다: Fable 주간이 문턱이면 프록시 usable이어도 Fable 대기.
        let fableFull = single(account("fable-full", usable: true, session: 0.2, weekly: 0.3, fable: 0.99, now: now),
                               now: now, includeFable: true)
        precondition(fableFull.state == .limited, "the Fable lane keeps its own window: \(fableFull.reason)")
        // 그러나 동시 요청이 가득 찼다고 Fable에서 떨어뜨리지는 않는다.
        let fableBusy = single(account("fable-busy", usable: true, session: 0.2, weekly: 0.3, fable: 0.4, inflight: 3, capacity: 3,
                                       now: now), now: now, includeFable: true)
        precondition(fableBusy.state == .ready && fableBusy.busy != nil, "at capacity must not demote the Fable lane: \(fableBusy.reason)")
        // 세션 유예도 Fable 레인에서 프록시를 믿는다(프록시는 Fable 요청도 그 계정으로 보낸다).
        let fableGrace = single(account("fable-grace", usable: true, session: 0.98, weekly: 0.76, fable: 0.4, now: now),
                                now: now, includeFable: true)
        precondition(fableGrace.state == .ready, fableGrace.reason)

        // usable=false·모름은 예전 그대로다.
        precondition(single(account("off-limit", usable: false, session: 0.98, weekly: 0.3, now: now), now: now).state == .limited)
        precondition(single(account("off", usable: false, session: 0.2, weekly: 0.3, now: now), now: now).state == .excluded)
        precondition(single(account("off-busy", usable: false, session: 0.2, weekly: 0.3, inflight: 3, capacity: 3, now: now),
                            now: now).state == .excluded)
        precondition(single(account("unknown-limit", usable: nil, session: 0.98, weekly: 0.3, now: now), now: now).state == .limited)
        precondition(single(account("unknown", usable: nil, session: 0.2, weekly: 0.3, now: now), now: now).state == .unconfirmed)
        precondition(single(account("throttled", usable: true, session: 0.2, weekly: 0.3, status: "throttled", now: now),
                            now: now).state == .limited)
    }

    // MARK: 1. 소비 지점

    static func testConsumersAgree(now: Date) {
        let pool = liveLikePool(now: now)
        precondition(pool.routableCount == 1, "routable \(pool.routableCount)")
        let model = makeOverviewModel(DashboardOverviewInput(
            teamClaude: pool, teamCodex: nil, grok: GrokCardModel(headline: "Grok 21%", detail: nil),
            agy: AgyCardModel(message: nil, groups: []),
            burn: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
            notices: DashboardToolNotices(), now: now))
        // 큰 숫자·문장
        precondition(model.routable == 1 && model.total == 20, "big number \(model.routable)/\(model.total)")
        precondition(model.headline == L10n.overviewHeadline(1), model.headline)
        // 범례: 사용 가능 1 · 대기 19 · 제외 0 — 큰 숫자와 같은 답
        precondition(model.readyCount == 1 && model.waitCount == 19 && model.excludedCount == 0,
                     "legend ready \(model.readyCount) wait \(model.waitCount) excluded \(model.excludedCount)")
        precondition(model.readyCount == model.routable, "legend must agree with the big number")
        // 그 계정 칸은 바쁨 라벨(사용 중 3/3)로 지금 받는 계정에 있고, 대기 아님
        precondition(model.live.map(\.name) == ["acct-01"], "\(model.live.map(\.name))")
        let first = model.live[0]
        precondition(first.label == L10n.stateBusy(3, 3) && first.busy, "\(first.label)")
        precondition(!model.waiting.contains { $0.name == "acct-01" } && model.waiting.count == 19, "\(model.waiting.map(\.name))")
        // Fable 레인: 그 계정의 Fable 주간은 40% → 1
        precondition(model.lanes[0].value == "1", "fable lane \(model.lanes[0].value)")
        // 메뉴바 제목 슬롯: 평소 경로도 개요 큰 숫자와 같은 라우팅 수를 쓴다(Fable 문턱·미측정과 무관, 실사용 QA 2026-10-25)
        precondition(pool.titleSlot == L10n.titleClaudeRouting(model.routable, 20), pool.titleSlot)
        precondition(pool.titleRoutingInput.accountUsable == 1, "title routing slot must count what the proxy routes")
        // Claude 탭 묶음·라벨·헤더 요약
        let tab = pool.fableAvailability(now: now)
        precondition(teamClaudeRowGroup(tab[0]) == .ready, "Claude tab must group it as available")
        precondition(teamClaudeRowPresentation(pool.accounts[0], tab[0]).label == L10n.stateBusy(3, 3))
        let summaries = StatusMenuDashboardView.sectionSummaries(teamClaude: pool, codex: nil, teamCodex: nil, usage: nil, higgsfield: nil,
                                                                notices: DashboardToolNotices(), staleNotes: [:])
        precondition(summaries["claude"] == L10n.claudeSectionSummary(accounts: 20, usable: 1), summaries["claude"] ?? "nil")
        // 영어 라벨에 한글이 없다.
        L10n.language = .en
        precondition(L10n.stateBusy(3, 3) == "In use 3/3", L10n.stateBusy(3, 3))
        let graceReason = single(account("grace-en", usable: true, session: 0.98, weekly: 0.76, now: now), now: now).reason
        precondition(graceReason.range(of: "[가-힣]", options: .regularExpression) == nil, graceReason)
        L10n.language = .ko
    }

    // MARK: 1. 실제 앱 경로(커밋 병합) — 실제 맥에서 찾았다

    /// 앱은 파서 결과를 그대로 쓰지 않고 commitTeamClaudeHealth → teamClaudeHealthMergingQuota를 지난다.
    /// 프록시는 재시작 후 Fable(7d_oi) 창을 복원하지 않으므로 Fable이 모두 비어 있을 수 있다. 그때 병합이
    /// fableMeasurementCurrent를 끄면서 세션·주간 라우팅 판정까지 "최신 한도 측정 필요"로 떨어져 0/20이 됐다
    /// (실사용 QA 2026-10-25: 프록시 usable 2, 패널 0). 픽스처 경로(파서 직접)는 이 병합을 지나지 않아 가려졌다.
    static func testCommitPathWithoutFable(now: Date) {
        var rows = [account("acct-01", usable: true, session: 0.1, weekly: 0.79, fable: nil, inflight: 3, capacity: 3, now: now)]
        for index in 2...16 {
            rows.append(account(String(format: "acct-%02d", index), usable: false, session: 0, weekly: 1.0, fable: nil, now: now))
        }
        rows.append(account("acct-17", usable: true, session: 0.1, weekly: 0.79, fable: nil, inflight: 3, capacity: 3, now: now))
        for index in 18...20 {
            rows.append(account(String(format: "acct-%02d", index), usable: false, session: 0, weekly: 1.0, fable: nil, now: now))
        }
        let committed = teamClaudeHealthMergingQuota(candidate: health(rows, now: now), previous: nil)
        precondition(committed.routableCount == 2, "commit path routable \(committed.routableCount) (proxy usable 2)")
        let routing = committed.routingAvailability(now: now)
        precondition(routing[0].state == .ready && routing[0].busy == TeamClaudeConcurrencyLoad(inflight: 3, capacity: 3),
                     "\(routing[0].state) \(routing[0].reason)")
        precondition(routing[1].state == .limited, "\(routing[1].state) \(routing[1].reason)")
        // Fable 레인은 Fable이 비어 있으니 확인 필요다(그 의미는 지킨다).
        precondition(committed.fableAvailability(now: now)[0].state == .unconfirmed)
        let model = makeOverviewModel(DashboardOverviewInput(
            teamClaude: committed, teamCodex: nil, grok: GrokCardModel(headline: "Grok 21%", detail: nil),
            agy: AgyCardModel(message: nil, groups: []),
            burn: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []),
            notices: DashboardToolNotices(), now: now))
        precondition(model.routable == 2 && model.readyCount == 2 && model.waitCount == 18,
                     "overview \(model.routable) ready \(model.readyCount) wait \(model.waitCount)")
        // Claude 탭 묶음도 라우팅 판정이다: 프록시가 보내는 두 계정은 "사용 가능 · 라우팅 중"에 있다(Fable 측정 전은 열에서 보인다).
        let groups = committed.routingAvailability(now: now).map(teamClaudeRowGroup)
        precondition(groups.filter { $0 == .ready }.count == 2, "\(groups)")
        precondition(committed.rowLines(now: now).count == 20)
        let summaries = StatusMenuDashboardView.sectionSummaries(teamClaude: committed, codex: nil, teamCodex: nil, usage: nil,
                                                                higgsfield: nil, notices: DashboardToolNotices(), staleNotes: [:])
        precondition(summaries["claude"] == L10n.claudeSectionSummary(accounts: 20, usable: 2), summaries["claude"] ?? "nil")
        // 표의 높이·묶음은 라우팅 판정으로 잰다(그리기와 같은 판정).
        let table = TeamClaudeTableView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth,
                                                      height: TeamClaudeTableView.contentHeight(committed, expanded: nil, now: now)))
        table.health = committed
        table.refreshTime(now: now)
        precondition(table.accessibilityLabel()?.contains("라우팅 가능 2") == true, table.accessibilityLabel() ?? "nil")
        let routingLines = committed.rowLines(now: now, availability: routing)
        let expectedHeight = teamClaudeCardBaseHeight(hostLine: committed.hostSummaryText != nil)
            + teamClaudeGroupedLayout(groups: routing.map(teamClaudeRowGroup), lines: routingLines, expanded: nil).height
        precondition(TeamClaudeTableView.contentHeight(committed, expanded: nil, now: now) == expectedHeight,
                     "the Claude table groups by the routing judgment")
        precondition(committed.rowLines(now: now) == routingLines, "rowLines defaults to the routing judgment")
    }

    // MARK: 2. 패널 높이

    static func readyPool(_ count: Int, now: Date) -> TeamClaudeHealth {
        health((1...count).map { account(String(format: "acct-%03d", $0), usable: true, session: 0.2, weekly: 0.3, now: now) },
               now: now)
    }

    static func testPanelHeight(now: Date) {
        let burn = SubscriptionBurnModel(usages: [], rates: [:], recommendations: [])
        func height(_ pool: TeamClaudeHealth, max: CGFloat = 5_000) -> CGFloat {
            StatusMenuDashboardView.preferredHeight(teamClaude: pool, codex: nil, teamCodex: nil, usage: nil, higgsfield: nil,
                                                    burnModel: burn, notices: DashboardToolNotices(), maxBodyHeight: max)
        }
        let twenty = readyPool(20, now: now), hundred = readyPool(100, now: now)
        let h20 = height(twenty), h100 = height(hundred)
        precondition(h20 == h100, "the overview decides the panel height, not the Claude tab: \(h20) vs \(h100)")
        let overview = StatusMenuDashboardView.overviewModel(teamClaude: twenty, teamCodex: nil,
                                                              grok: GrokCardModel(headline: "", detail: nil),
                                                              agy: AgyCardModel(message: nil, groups: []), burnModel: burn,
                                                              notices: DashboardToolNotices(), now: now)
        let expected = StatusMenuDashboardView.chromeHeight
            + max(OverviewTabView.preferredHeight(overview), StatusMenuDashboardView.minimumBodyHeight)
        precondition(h20 == expected, "panel = chrome + overview natural height (min clamp): \(h20) vs \(expected)")
        precondition(h100 < StatusMenuDashboardView.chromeHeight + StatusMenuDashboardView.teamContentHeight(hundred),
                     "a 100-account Claude tab must not stretch the panel")
        // 화면에 맞춰 자른다.
        precondition(height(hundred, max: 300) == StatusMenuDashboardView.chromeHeight + 300)

        // 긴 탭은 본문 안에서 스크롤한다.
        let view = StatusMenuDashboardView(frame: NSRect(x: 0, y: 0, width: StatusMenuDashboardView.preferredWidth, height: h100))
        func update(_ pool: TeamClaudeHealth) {
            view.updateContent(teamClaude: pool, codex: nil, teamCodex: nil, usage: nil, higgsfield: nil,
                               grok: GrokCardModel(headline: "Grok 21%", detail: nil), agy: AgyCardModel(message: nil, groups: []),
                               burnModel: burn, notices: DashboardToolNotices(), parallelCount: 0, active: false,
                               isMeasuringTeamClaude: false, teamClaudeMeasureDetail: nil, onMeasureTeamClaude: nil)
        }
        view.configure(teamClaude: hundred, codex: nil, teamCodex: nil, usage: nil, burnModel: burn, notices: DashboardToolNotices(),
                       parallelCount: 0, active: false, isMeasuringTeamClaude: false, teamClaudeMeasureDetail: nil,
                       onMeasureTeamClaude: nil)
        view.selectTab(.claude)
        view.layoutSubtreeIfNeeded()
        let body = view.bounds.height - StatusMenuDashboardView.chromeHeight
        precondition(view.snapshotDocumentHeight(.claude) > body + 100, "the Claude tab is taller than the body and scrolls")
        view.restoreBodyScroll(NSPoint(x: 0, y: 400))
        precondition(view.bodyScrollOrigin.y > 0, "the Claude tab body scrolls inside the panel")

        // 메뉴가 열린 동안에는 높이를 바꾸지 않는다(구조가 바뀌는 갱신이 와도).
        view.heightFrozen = true
        let before = view.frame.height
        update(readyPool(3, now: now))
        precondition(view.frame.height == before, "no resizing while the menu is open: \(before) → \(view.frame.height)")
        view.heightFrozen = false
        update(readyPool(4, now: now))
        precondition(view.frame.height == height(readyPool(4, now: now), max: view.maxBodyHeight),
                     "a closed menu takes the new height")
    }

    // MARK: 3. Grok 레인

    static func testGrokLane(now: Date) {
        let card = grokPresentation(.expired, previousSlot: nil, previousCard: GrokCardModel(headline: L10n.grokChecking, detail: nil)).card
        let model = makeOverviewModel(DashboardOverviewInput(
            teamClaude: nil, teamCodex: nil, grok: card, agy: AgyCardModel(message: nil, groups: []),
            burn: SubscriptionBurnModel(usages: [], rates: [:], recommendations: []), notices: DashboardToolNotices(), now: now))
        let grok = model.lanes[2]
        precondition(grok.name == "Grok" && grok.value == "갱신 필요", "lane value \(grok.value)")
        precondition(grok.note == L10n.grokRefreshLaneNote && !grok.note.isEmpty, "lane note \(grok.note)")
    }

    // MARK: 4. 소진 미리보기

    static func testBurnLine(now: Date) {
        let wild = BurnProjection(current: 0.03, projected: 4.23, range: nil, basis: .extrapolation(confidence: .low))
        let usage = LaneUsage(lane: "codex", paidAccounts: 1, contributingAccounts: 1, errorAccounts: 0, disabledAccounts: 0,
                              weekly: wild, session: BurnProjection(current: nil, projected: nil, range: nil, basis: .collecting),
                              blockedMoments: 0)
        let model = makeOverviewModel(DashboardOverviewInput(
            teamClaude: nil, teamCodex: nil, grok: GrokCardModel(headline: "Grok 21%", detail: nil),
            agy: AgyCardModel(message: nil, groups: []),
            burn: SubscriptionBurnModel(usages: [usage], rates: [:], recommendations: []), notices: DashboardToolNotices(), now: now))
        let line = model.burnLines[0]
        precondition(!line.projection.contains("423%") && line.projection.contains(L10n.burnOverHundred), line.projection)
        precondition(line.verdict == L10n.verdictTentative(L10n.verdictOnTarget), line.verdict)
    }
}
