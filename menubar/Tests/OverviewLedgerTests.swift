// menubar/Tests/OverviewLedgerTests.swift
import Cocoa

// 개요 탭 Claude 영역(상태별 목록, 2026-10-27 웹랩 시안 A)이 계정 수와 무관하게 뷰 안에 들어가는지,
// 속도 경고·원인 태그·접기 규칙이 맞는지 본다. 실제 OverviewTabView를 오프스크린에 그리고 행 사각형과 그린 글자를 본다.
// 모델을 만드는 쪽(makeOverviewModel)의 정렬·분류는 DashboardOverviewBuilderTests가 실제 판정으로 본다.
@main
struct OverviewLedgerTests {
    static let viewWidth: CGFloat = 520  // StatusMenuDashboardView.preferredWidth와 같은 폭
    static let hour: Double = 3_600

    static func live(_ index: Int, session: Double = 40, warn: Bool = false, busy: Bool = false) -> OverviewLiveAccount {
        OverviewLiveAccount(
            name: String(format: "acct-%03d", index + 1), label: busy ? L10n.stateBusy(3, 3) : L10n.stateReady, busy: busy,
            sessionPercent: session, sessionElapsed: 0.4, sessionRemainingSeconds: 3 * hour, sessionResetClock: "오후 11:13",
            weekly: OverviewMiniWindow(label: L10n.weeklyShort, percent: 60, remainingSeconds: 2 * 86_400),
            fable: OverviewMiniWindow(label: "Fable", percent: nil, remainingSeconds: nil),
            projection: warn ? OverviewSessionProjection(hitsLimitInSeconds: hour, earlierBySeconds: 2 * hour) : nil)
    }

    static func waiting(_ index: Int, cause: OverviewWaitCause = .weekly) -> OverviewWaitingAccount {
        OverviewWaitingAccount(name: String(format: "wait-%03d", index + 1), cause: cause,
                               weeklyPercent: cause == .session ? 43 : nil,
                               returnSeconds: cause == .other ? nil : Double(index + 1) * hour,
                               returnClock: cause == .other ? nil : "오후 10:05", note: cause == .other ? L10n.stateLimited : nil)
    }

    /// accounts개를 사용 가능 40% · 대기 50% · 제외 10%로 나눈다.
    static func model(accounts: Int) -> OverviewModel {
        var model = OverviewModel()
        let liveCount = accounts * 4 / 10
        let excludedCount = accounts / 10
        let waitCount = accounts - liveCount - excludedCount
        model.routable = liveCount
        model.total = accounts
        model.headline = L10n.overviewHeadline(liveCount)
        model.lanes = [OverviewLane(name: "Claude Fable", value: "1", unit: "/ \(accounts)", note: "n", tab: .claude, quiet: false)]
        model.live = (0..<liveCount).map { live($0, session: Double(90 - $0 % 80), warn: $0 % 3 == 0, busy: $0 == 1) }
        model.waiting = (0..<waitCount).map { waiting($0, cause: $0 % 4 == 0 ? .session : ($0 % 4 == 3 ? .other : .weekly)) }
        model.excluded = (0..<excludedCount).map {
            OverviewExcludedAccount(name: String(format: "off-%03d", $0 + 1), reason: L10n.stateEnded, tone: .off, inTodos: $0 % 2 == 0)
        }
        model.readyCount = liveCount
        model.waitCount = waitCount
        model.sessionWaitCount = model.waiting.filter { $0.cause == .session }.count
        model.weeklyWaitCount = model.waiting.filter { $0.cause == .weekly }.count
        model.otherWaitCount = model.waiting.filter { $0.cause == .other }.count
        model.excludedCount = excludedCount
        model.nextReturn = model.waiting.first { $0.returnSeconds != nil }
        return model
    }

    static func render(_ model: OverviewModel) -> OverviewTabView {
        let view = OverviewTabView(frame: NSRect(x: 0, y: 0, width: viewWidth, height: OverviewTabView.preferredHeight(model)))
        view.model = model
        view.layoutSubtreeIfNeeded()
        guard let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            preconditionFailure("bitmap rep for the overview must exist")
        }
        DrawnTextRecorder.reset()
        view.cacheDisplay(in: view.bounds, to: representation)
        return view
    }

    static func main() {
        _ = NSApplication.shared
        DrawnTextRecorder.install()
        L10n.language = .ko
        testProjection()
        testWaitCause()
        testSorting()
        testManyAccountsStayInsideTheView()
        testWaitingFoldsAfterFive()
        testRowsOpenTheirAccount()
        testLiveRowDrawsSessionFirst()
        testSummaryFitsTheHero()
        testEnglishHasNoHangul()
        print("OverviewLedgerTests: projection, causes, sorting, folding, 17/100/250 accounts inside bounds, clicks passed")
    }

    /// 지금 속도(세션 사용률 ÷ 지난 비율)로 리셋 전에 98%에 닿으면 경고, 아니면 nil.
    static func testProjection() {
        // 5시간 창의 40%(2시간) 지났는데 60% → 시간당 30% → 98%까지 38%p는 1시간 16분, 리셋(3시간 뒤)보다 1시간 44분 이르다.
        guard let hit = overviewSessionProjection(percent: 60, elapsed: 0.4, remainingSeconds: 3 * hour) else {
            preconditionFailure("60% at 40% elapsed must warn")
        }
        precondition(abs(hit.hitsLimitInSeconds - 4_560) < 1, "\(hit.hitsLimitInSeconds)")
        precondition(abs(hit.earlierBySeconds - (3 * hour - 4_560)) < 1, "\(hit.earlierBySeconds)")
        // 같은 지난 비율에 30%면 리셋 때 75%라 경고하지 않는다.
        precondition(overviewSessionProjection(percent: 30, elapsed: 0.4, remainingSeconds: 3 * hour) == nil)
        // 창이 막 시작했을 때(15% 미만 경과)의 속도는 믿지 않는다.
        precondition(overviewSessionProjection(percent: 30, elapsed: 0.1, remainingSeconds: 4.5 * hour) == nil)
        // 이미 98% 이상(유예 차선)이거나 값이 없으면 경고 줄을 그리지 않는다(막대가 호박색으로 말한다).
        precondition(overviewSessionProjection(percent: 98.5, elapsed: 0.5, remainingSeconds: 2.5 * hour) == nil)
        precondition(overviewSessionProjection(percent: nil, elapsed: 0.5, remainingSeconds: 2.5 * hour) == nil)
        precondition(overviewSessionProjection(percent: 50, elapsed: nil, remainingSeconds: nil) == nil)
        precondition(overviewSessionProjection(percent: 0, elapsed: 0.5, remainingSeconds: 2.5 * hour) == nil)
        L10n.language = .ko
        precondition(L10n.paceWarning(L10n.duration(seconds: 3_660), L10n.duration(seconds: 4_740))
                     == "지금 속도면 약 1시간 1분 뒤 98% · 리셋보다 1시간 19분 이름", L10n.paceWarning("a", "b"))
    }

    /// 원인 태그: 주간이 들었으면 주간, 세션만이면 세션, 비면 일시 대기(throttled·exhausted·확인 필요).
    static func testWaitCause() {
        precondition(overviewWaitCause(blockedWindows: [L10n.sessionShort]) == .session)
        precondition(overviewWaitCause(blockedWindows: [L10n.windowAllWeekly]) == .weekly)
        precondition(overviewWaitCause(blockedWindows: [L10n.sessionShort, L10n.windowAllWeekly]) == .weekly)
        precondition(overviewWaitCause(blockedWindows: []) == .other)
        precondition(OverviewWaitCause.session.tag == "세션 가득" && OverviewWaitCause.weekly.tag == "주간 가득"
                     && OverviewWaitCause.other.tag == "일시 대기")
    }

    static func testSorting() {
        let a = live(0, session: 20), b = live(1, session: 80), c = OverviewLiveAccount(
            name: "nil", label: "", busy: false, sessionPercent: nil, sessionElapsed: nil, sessionRemainingSeconds: nil,
            sessionResetClock: nil, weekly: OverviewMiniWindow(label: "", percent: nil, remainingSeconds: nil),
            fable: OverviewMiniWindow(label: "", percent: nil, remainingSeconds: nil), projection: nil)
        precondition(overviewSortLive([a, c, b]).map(\.name) == [b.name, a.name, "nil"])
        let w1 = waiting(5), w2 = waiting(0), other = waiting(2, cause: .other)
        precondition(overviewSortWaiting([w1, other, w2]).map(\.name) == [w2.name, w1.name, other.name])
    }

    static func testManyAccountsStayInsideTheView() {
        for accounts in [17, 100, 250] {
            let model = model(accounts: accounts)
            let view = render(model)
            let rows = view.ledgerRows
            precondition(!rows.isEmpty, "\(accounts): no ledger rows")
            let liveRows = rows.filter { if case .live = $0.kind { return true }; return false }
            let waitRows = rows.filter { if case .waiting = $0.kind { return true }; return false }
            precondition(liveRows.count == min(OverviewLedgerMetrics.maxLive, model.live.count), "\(accounts): live rows \(liveRows.count)")
            precondition(waitRows.count == min(OverviewLedgerMetrics.maxWaiting, model.waiting.count), "\(accounts): wait rows \(waitRows.count)")
            for row in rows {
                precondition(row.rect.minX >= OverviewTabView.padding - 0.01 && row.rect.maxX <= viewWidth - OverviewTabView.padding + 0.01,
                             "\(accounts): row \(row.rect) outside the content width")
                precondition(view.bounds.contains(row.rect), "\(accounts): row \(row.rect) outside \(view.bounds)")
            }
            for (upper, lower) in zip(rows, rows.dropFirst()) {
                precondition(lower.rect.minY >= upper.rect.maxY - 0.01, "\(accounts): rows overlap \(upper.rect) \(lower.rect)")
            }
            let drawn = DrawnTextRecorder.strings
            let hiddenLive = model.live.count - liveRows.count
            if hiddenLive > 0 {
                precondition(drawn.contains(L10n.moreInClaudeTab(hiddenLive)), "\(accounts): live remainder not drawn")
            }
            let hiddenWait = model.waiting.count - waitRows.count
            precondition(hiddenWait > 0 && drawn.contains(L10n.moreInClaudeTab(hiddenWait)), "\(accounts): waiting remainder not drawn")
        }
        // 높이는 계정 수가 늘어도 일정 이상 자라지 않는다(접기 규칙).
        // (100계정은 손볼 것에 없는 제외가 딱 5개라 "외 N개" 줄이 없다. 150부터 모든 구역이 접힌다.)
        precondition(OverviewTabView.preferredHeight(model(accounts: 150)) == OverviewTabView.preferredHeight(model(accounts: 250)),
                     "150 and 250 accounts fold to the same height")
    }

    /// 복귀 대기는 다섯 줄만 펼치고 나머지는 "외 N개 · Claude 탭에서 전부" 한 줄(누르면 Claude 탭).
    static func testWaitingFoldsAfterFive() {
        var small = model(accounts: 17)
        small.waiting = Array(small.waiting.prefix(5))
        let view = render(small)
        precondition(!view.ledgerRows.contains { $0.target == .claudeTab && { if case .more(.waiting, _) = $0.kind { return true }; return false }($0) },
                     "five waiting rows need no remainder line")
        let many = model(accounts: 100)
        let manyView = render(many)
        guard let more = manyView.ledgerRows.first(where: { if case .more(.waiting, _) = $0.kind { return true }; return false }) else {
            preconditionFailure("remainder line for waiting accounts")
        }
        precondition(more.target == .claudeTab)
        precondition(manyView.rowClickTarget(at: NSPoint(x: more.rect.midX, y: more.rect.midY)) == .claudeTab)
        precondition(more.kind == .more(.waiting, many.waiting.count - 5), "\(more.kind)")
    }

    static func testRowsOpenTheirAccount() {
        let model = model(accounts: 17)
        let view = render(model)
        for row in view.ledgerRows {
            let target = view.rowClickTarget(at: NSPoint(x: row.rect.midX, y: row.rect.midY))
            switch row.kind {
            case .live(let index): precondition(target == .account(model.live[index].name), "live \(index) → \(String(describing: target))")
            case .waiting(let index): precondition(target == .account(model.waiting[index].name))
            case .excluded(let index): precondition(target == .account(model.excluded[index].name))
            case .more: precondition(target == .claudeTab)
            case .empty: precondition(target == nil)
            }
        }
        // 제외 목록은 손볼 것에 이미 있는 계정을 다시 그리지 않는다.
        let excludedRows = view.ledgerRows.compactMap { row -> Int? in if case .excluded(let i) = row.kind { return i }; return nil }
        precondition(excludedRows.allSatisfy { !model.excluded[$0].inTodos }, "excluded rows must skip todo accounts")
    }

    static func testLiveRowDrawsSessionFirst() {
        var model = model(accounts: 17)
        model.live = [live(0, session: 71, warn: true), live(1, session: 40, busy: true)]
        let view = render(model)
        let drawn = DrawnTextRecorder.strings
        precondition(drawn.contains("71"), "session percent big number: \(drawn.prefix(40))")
        precondition(drawn.contains(L10n.durationAhead(L10n.duration(seconds: Int(3 * hour)))), "remaining until session reset")
        precondition(drawn.contains(L10n.resetAtClock("오후 11:13")), "reset clock")
        precondition(drawn.contains { $0.hasPrefix("지금 속도면 약 ") }, "pace warning for the fast account")
        precondition(drawn.filter { $0.hasPrefix("지금 속도면 약 ") }.count == 1, "no warning for the slow account")
        precondition(drawn.contains(L10n.stateBusy(3, 3)), "busy accounts keep the in-use label")
        precondition(drawn.contains("지금 받는 계정") && drawn.contains("복귀 대기"), "section titles")
        let liveRows = view.ledgerRows.filter { if case .live = $0.kind { return true }; return false }
        precondition(liveRows[0].rect.height > liveRows[1].rect.height, "the warning adds a line")
        // 제외 0이면 제외 줄을 그리지 않는다.
        model.excluded = []
        model.excludedCount = 0
        render(model)
        precondition(!DrawnTextRecorder.strings.contains("제외"), "no excluded section when nothing is excluded")
    }

    /// 요약 줄: 상태별 수가 큰 숫자 옆 폭에 들어간다. 넘치면 0인 대기 항목부터 뺀다.
    static func testSummaryFitsTheHero() {
        var model = model(accounts: 17)
        model.otherWaitCount = 0
        let wide = overviewSummaryItems(model, maxWidth: 1000)
        precondition(wide.map(\.0) == [L10n.legendReady(model.readyCount), L10n.legendSessionWait(model.sessionWaitCount),
                                       L10n.legendWeeklyWait(model.weeklyWaitCount), L10n.legendExcluded(model.excludedCount)],
                     "\(wide.map(\.0))")
        precondition(wide.map(\.1) == [.ready, .wait, .wait, .error])
        model.otherWaitCount = 2
        precondition(overviewSummaryItems(model, maxWidth: 1000).contains { $0.0 == L10n.legendOtherWait(2) })
        model.sessionWaitCount = 0
        let narrow = overviewSummaryItems(model, maxWidth: 200)
        precondition(!narrow.contains { $0.0 == L10n.legendSessionWait(0) }, "zero items drop first when narrow")
        precondition(narrow.count < overviewSummaryItems(model, maxWidth: 1000).count, "\(narrow.map(\.0))")
        // 넓으면 모두 남고, 폭은 그린 그대로 잰다.
        precondition(overviewSummaryWidth(wide) > 0 && overviewSummaryItems(model, maxWidth: 1000).count == 5)
        let view = render(self.model(accounts: 250))
        _ = view
        let next = DrawnTextRecorder.strings.first { $0.hasPrefix("다음 복귀 ") }
        precondition(next?.contains("wait-001") == true, next ?? "nil")
    }

    static func testEnglishHasNoHangul() {
        L10n.language = .en
        defer { L10n.language = .ko }
        var model = model(accounts: 100)
        model.live = model.live.map {
            OverviewLiveAccount(name: $0.name, label: $0.busy ? L10n.stateBusy(3, 3) : L10n.stateReady, busy: $0.busy,
                                sessionPercent: $0.sessionPercent, sessionElapsed: $0.sessionElapsed,
                                sessionRemainingSeconds: $0.sessionRemainingSeconds, sessionResetClock: "11:13 PM",
                                weekly: OverviewMiniWindow(label: L10n.weeklyShort, percent: 60, remainingSeconds: 86_400),
                                fable: $0.fable, projection: $0.projection)
        }
        model.waiting = model.waiting.map {
            OverviewWaitingAccount(name: $0.name, cause: $0.cause, weeklyPercent: $0.weeklyPercent, returnSeconds: $0.returnSeconds,
                                   returnClock: $0.returnClock == nil ? nil : "Wed 1:53 AM", note: $0.note == nil ? nil : L10n.stateLimited)
        }
        model.excluded = model.excluded.map { OverviewExcludedAccount(name: $0.name, reason: L10n.stateEnded, tone: $0.tone, inTodos: $0.inTodos) }
        model.headline = L10n.overviewHeadline(model.routable)
        model.nextReturn = model.waiting.first { $0.returnSeconds != nil }
        render(model)
        let offenders = DrawnTextRecorder.strings.filter { $0.range(of: "[가-힣]", options: .regularExpression) != nil }
        precondition(offenders.isEmpty, "\(offenders)")
        precondition(DrawnTextRecorder.strings.contains("Taking requests now"), "\(DrawnTextRecorder.strings.prefix(30))")
        precondition(L10n.moreInClaudeTab(4) == "+4 more · all in the Claude tab", L10n.moreInClaudeTab(4))
        precondition(L10n.clockTime(Date(timeIntervalSince1970: 0), now: Date(timeIntervalSince1970: 0)).range(of: "[가-힣]", options: .regularExpression) == nil)
    }
}
