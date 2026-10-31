import Cocoa

// 개요 탭(menubar/DESIGN.md "탭"): 지금 라우팅 가능 큰 숫자(+ 상태별 수·다음 복귀) → 레인 4개 →
// Claude 상태별 목록(지금 받는 계정 · 복귀 대기 · 제외) → 손볼 것 → 주간 소진 전망 미리보기.
// 값은 모두 기존 로더·판정이 만든 것을 DashboardOverviewBuilder.swift가 옮겨 담는다. 이 파일은 그리기와
// 그리기에 딸린 작은 계산(속도 경고·정렬·접기)만 한다.

struct OverviewLane: Equatable {
    let name: String
    let value: String
    let unit: String
    let note: String
    let tab: DashboardTab
    /// 숫자가 아닌 값("확인 중"·"미설치")은 작게 그린다.
    let quiet: Bool
}

enum OverviewTodoAction: Equatable {
    case none
    case reauthenticate
    case subscriptionRecord
    case codexRecover(TeamCodexAccountRecoveryKind)
    /// 해지 기록이 있는 인증 오류 계정. 그 계정 행을 펼쳐 "종료로 확정"을 한 번 더 누르게 한다.
    case confirmSubscriptionEnd
}

struct OverviewTodo: Equatable {
    let provider: String
    let name: String
    let accountUuid: String?
    let label: String
    let reason: String
    let tone: PanelTone
    let actionTitle: String?
    let primary: Bool
    let action: OverviewTodoAction
}

struct OverviewBurnLine: Equatable {
    let lane: String
    let projection: String
    let verdict: String
    let verdictColor: NSColor
}

// MARK: Claude 상태별 목록(2026-10-27 웹랩 시안 A "상태별 목록")

/// 작은 막대 하나(주간·Fable).
struct OverviewMiniWindow: Equatable {
    let label: String
    let percent: Double?
    /// 리셋까지 남은 초. 모르면 nil.
    let remainingSeconds: Double?
}

/// 지금 속도면 세션 리셋 전에 98%에 닿는다는 경고.
struct OverviewSessionProjection: Equatable {
    /// 98%에 닿기까지 남은 초.
    let hitsLimitInSeconds: Double
    /// 리셋보다 몇 초 이른가.
    let earlierBySeconds: Double
}

/// 지금 요청을 받는 계정 한 칸. 세션 창(5시간)을 크게, 주간·Fable은 작게.
struct OverviewLiveAccount: Equatable {
    let name: String
    /// 표시 라벨("사용 가능" 또는 동시 요청이 가득 찬 "사용 중 3/3").
    let label: String
    let busy: Bool
    let sessionPercent: Double?
    /// 세션 창이 지난 비율(0~1). 막대 안 세로 눈금.
    let sessionElapsed: Double?
    let sessionRemainingSeconds: Double?
    /// 세션 리셋 벽시계 시각("오후 11:13").
    let sessionResetClock: String?
    let weekly: OverviewMiniWindow
    let fable: OverviewMiniWindow
    let projection: OverviewSessionProjection?
    /// 5시간 창이 없는 계정(검증된 Ultra). 세션 큰 숫자·막대 자리에 "5시간 한도 없음"을 쓴다(세션 값·전망은 비어 있다).
    var sessionWindowAbsent = false
}

/// 기다리는 이유. 판정의 blockedWindows로 나눈다(overviewWaitCause).
enum OverviewWaitCause: Equatable {
    case session, weekly, other

    var tag: String {
        switch self {
        case .session: return L10n.tagSessionFull
        case .weekly: return L10n.tagWeeklyFull
        case .other: return L10n.tagPaused
        }
    }
}

/// 복귀 대기 한 줄.
struct OverviewWaitingAccount: Equatable {
    let name: String
    let cause: OverviewWaitCause
    /// 세션 가득일 때 곁들이는 주간 사용률.
    let weeklyPercent: Double?
    /// 다시 라우팅되기까지 남은 초. 창이 아닌 이유(일시 제한·확인 필요)면 nil.
    let returnSeconds: Double?
    let returnClock: String?
    /// 복귀 시각을 모를 때 오른쪽에 그리는 상태 라벨.
    let note: String?
}

/// 라우팅에서 빠진 계정 한 줄.
struct OverviewExcludedAccount: Equatable {
    let name: String
    let reason: String
    let tone: PanelTone
    /// 손볼 것에 이미 있는 계정. 제외 목록은 다시 그리지 않고 수만 센다.
    let inTodos: Bool
}

struct OverviewModel: Equatable {
    /// TeamClaude가 없으면 큰 숫자 대신 이 안내를 그린다(Phase 1 미설치).
    var claudeNotice: ToolNotice?
    /// Codex·TeamCodex가 둘 다 없을 때의 안내. Codex 레인이 같은 문구를 그린다.
    var codexNotice: ToolNotice?
    var routable = 0
    var total = 0
    var headline = ""
    /// 기다리는 계정이 없을 때 큰 숫자 옆에 그리는 다음 리셋 줄.
    var resetLine = ""
    var lanes: [OverviewLane] = []
    /// 지금 받는 계정(세션 많이 찬 순), 복귀 대기(빨리 풀리는 순), 제외.
    var live: [OverviewLiveAccount] = []
    var waiting: [OverviewWaitingAccount] = []
    var excluded: [OverviewExcludedAccount] = []
    /// 상태별 수. 큰 숫자와 같은 라우팅 판정(routingAvailability)에서 나온다. waitCount = 세션 + 주간 + 일시 대기.
    var readyCount = 0
    var waitCount = 0
    var sessionWaitCount = 0
    var weeklyWaitCount = 0
    var otherWaitCount = 0
    var excludedCount = 0
    /// 복귀 시각을 아는 대기 계정 가운데 가장 먼저 돌아오는 계정.
    var nextReturn: OverviewWaitingAccount?
    var todos: [OverviewTodo] = []
    var burnAside: String?
    var burnLines: [OverviewBurnLine] = []

    var hasLedger: Bool { !live.isEmpty || !waiting.isEmpty || !excluded.isEmpty }
}

/// 속도 경고. 지금 속도(세션 사용률 ÷ 창이 지난 비율)로 리셋 전에 98%에 닿으면 값, 아니면 nil.
/// 창이 막 시작했을 때(15% 미만)의 속도는 믿기 어려워 내다보지 않는다(시안 lib/quota.ts와 같은 문턱).
/// 이미 문턱 이상이면 막대가 호박색으로 말하므로 경고 줄을 그리지 않는다.
func overviewSessionProjection(percent: Double?, elapsed: Double?, remainingSeconds: Double?,
                               thresholdPercent: Double = panelRoutingThresholdPercent) -> OverviewSessionProjection? {
    guard let percent, percent.isFinite, percent > 0, percent < thresholdPercent,
          let elapsed, elapsed.isFinite, elapsed >= 0.15, elapsed < 1,
          let remainingSeconds, remainingSeconds > 0 else { return nil }
    let spentSeconds = elapsed * teamClaudeSessionSeconds
    let perSecond = percent / spentSeconds
    let hitsIn = (thresholdPercent - percent) / perSecond
    guard hitsIn < remainingSeconds else { return nil }
    return OverviewSessionProjection(hitsLimitInSeconds: hitsIn, earlierBySeconds: remainingSeconds - hitsIn)
}

/// 세션 창 길이(5시간). 속도 경고·Claude 탭 막대 눈금이 지난 시간을 잰다.
let teamClaudeSessionSeconds: Double = 5 * 3_600

/// 원인 태그. 주간 창이 들었으면 주간(세션이 먼저 풀려도 주간이 풀릴 때까지 못 쓴다), 세션만이면 세션,
/// 막힌 창이 없으면(throttled·exhausted·확인 필요) 일시 대기.
func overviewWaitCause(blockedWindows: [String]) -> OverviewWaitCause {
    if blockedWindows.contains(L10n.windowAllWeekly) { return .weekly }
    if blockedWindows.contains(L10n.sessionShort) { return .session }
    return .other
}

/// 세션 많이 찬 순. 값이 없으면 뒤로, 같으면 원래 순서.
func overviewSortLive(_ accounts: [OverviewLiveAccount]) -> [OverviewLiveAccount] {
    accounts.enumerated().sorted { lhs, rhs in
        let l = lhs.element.sessionPercent ?? -1, r = rhs.element.sessionPercent ?? -1
        return l != r ? l > r : lhs.offset < rhs.offset
    }.map(\.element)
}

/// 빨리 풀리는 순. 복귀 시각을 모르면 뒤로, 같으면 원래 순서.
func overviewSortWaiting(_ accounts: [OverviewWaitingAccount]) -> [OverviewWaitingAccount] {
    accounts.enumerated().sorted { lhs, rhs in
        let l = lhs.element.returnSeconds ?? .infinity, r = rhs.element.returnSeconds ?? .infinity
        return l != r ? l < r : lhs.offset < rhs.offset
    }.map(\.element)
}

/// 큰 숫자 옆 상태별 수(라벨, 점 색). 폭이 모자라면 0인 대기 항목부터 뺀다.
func overviewSummaryItems(_ model: OverviewModel, maxWidth: CGFloat) -> [(String, PanelTone)] {
    var items: [(String, PanelTone, Int, Int)] = [
        (L10n.legendReady(model.readyCount), .ready, model.readyCount, 99),
        (L10n.legendSessionWait(model.sessionWaitCount), .wait, model.sessionWaitCount, 1),
        (L10n.legendWeeklyWait(model.weeklyWaitCount), .wait, model.weeklyWaitCount, 2),
    ]
    if model.otherWaitCount > 0 { items.append((L10n.legendOtherWait(model.otherWaitCount), .wait, model.otherWaitCount, 0)) }
    items.append((L10n.legendExcluded(model.excludedCount), .error, model.excludedCount, 99))
    for priority in 0...2 where overviewSummaryWidth(items.map { ($0.0, $0.1) }) > maxWidth {
        items.removeAll { $0.3 == priority && $0.2 == 0 }
    }
    return items.map { ($0.0, $0.1) }
}

/// 요약 항목을 한 줄로 그린 폭(점 12 + 글자, 항목 사이 14).
func overviewSummaryWidth(_ items: [(String, PanelTone)]) -> CGFloat {
    items.reduce(0) { $0 + 12 + PanelDraw.width($1.0, TeamClaudePalette.legendFont) } + CGFloat(max(0, items.count - 1)) * 14
}

/// 목록 줄·칸을 눌렀을 때 갈 곳. 계정 줄은 그 계정, 접은 줄은 모든 계정이 보이는 Claude 탭.
enum OverviewRowTarget: Equatable {
    case account(String)
    case claudeTab
}

enum OverviewLedgerSection: Equatable { case live, waiting, excluded }

enum OverviewLedgerRowKind: Equatable {
    case live(Int)
    case waiting(Int)
    case excluded(Int)
    /// 접어 둔 나머지(구역, 개수).
    case more(OverviewLedgerSection, Int)
    /// 지금 받는 계정이 없을 때의 빈 줄.
    case empty
}

struct OverviewLedgerRow: Equatable {
    let kind: OverviewLedgerRowKind
    let rect: NSRect
    let target: OverviewRowTarget?
}

struct OverviewLedgerLayout {
    var headers: [(OverviewLedgerSection, CGFloat)] = []
    var cards: [NSRect] = []
    var rows: [OverviewLedgerRow] = []
    var height: CGFloat = 0
}

enum OverviewLedgerMetrics {
    /// 지금 받는 계정 칸은 최대 6개, 복귀 대기·제외는 5줄. 나머지는 "외 N개" 한 줄.
    static let maxLive = 6
    static let maxWaiting = 5
    static let maxExcluded = 5
    static let headerHeight: CGFloat = 22
    static let liveRowHeight: CGFloat = 60
    static let warningHeight: CGFloat = 18
    static let waitRowHeight: CGFloat = 30
    static let excludedRowHeight: CGFloat = 26
    static let moreRowHeight: CGFloat = 28
    static let emptyRowHeight: CGFloat = 34
    static let sectionGap: CGFloat = 14
    /// 줄 안 가로 위치(줄 왼쪽 끝 기준): 점, 이름, 막대·태그 열.
    static let dotX: CGFloat = 12
    static let nameX: CGFloat = 24
    static let columnX: CGFloat = 124

    /// 구역 머리·카드·줄 사각형. 그리기·누르기·높이·테스트가 같은 값을 쓴다.
    static func layout(_ model: OverviewModel, x: CGFloat, width: CGFloat, top: CGFloat) -> OverviewLedgerLayout {
        var result = OverviewLedgerLayout()
        guard model.hasLedger else { return result }
        var y = top

        func card(_ heights: [(OverviewLedgerRowKind, CGFloat, OverviewRowTarget?)]) {
            let cardTop = y
            for (kind, height, target) in heights {
                result.rows.append(OverviewLedgerRow(kind: kind, rect: NSRect(x: x, y: y, width: width, height: height), target: target))
                y += height
            }
            result.cards.append(NSRect(x: x, y: cardTop, width: width, height: y - cardTop))
        }

        // 지금 받는 계정
        result.headers.append((.live, y))
        y += headerHeight
        if model.live.isEmpty {
            card([(.empty, emptyRowHeight, nil)])
        } else {
            var rows = model.live.prefix(maxLive).enumerated().map { index, account in
                (OverviewLedgerRowKind.live(index), liveRowHeight + (account.projection == nil ? 0 : warningHeight),
                 Optional(OverviewRowTarget.account(account.name)))
            }
            if model.live.count > maxLive {
                rows.append((.more(.live, model.live.count - maxLive), moreRowHeight, .claudeTab))
            }
            card(rows)
        }

        // 복귀 대기
        if !model.waiting.isEmpty {
            y += sectionGap
            result.headers.append((.waiting, y))
            y += headerHeight
            var rows = model.waiting.prefix(maxWaiting).enumerated().map { index, account in
                (OverviewLedgerRowKind.waiting(index), waitRowHeight, Optional(OverviewRowTarget.account(account.name)))
            }
            if model.waiting.count > maxWaiting {
                rows.append((.more(.waiting, model.waiting.count - maxWaiting), moreRowHeight, .claudeTab))
            }
            card(rows)
        }

        // 제외: 손볼 것에 이미 있는 계정은 다시 그리지 않는다.
        if !model.excluded.isEmpty {
            y += sectionGap
            result.headers.append((.excluded, y))
            let listed = model.excluded.indices.filter { !model.excluded[$0].inTodos }
            if listed.isEmpty {
                y += 16
            } else {
                y += headerHeight
                var rows = listed.prefix(maxExcluded).map { index in
                    (OverviewLedgerRowKind.excluded(index), excludedRowHeight,
                     Optional(OverviewRowTarget.account(model.excluded[index].name)))
                }
                if listed.count > maxExcluded {
                    rows.append((.more(.excluded, listed.count - maxExcluded), moreRowHeight, .claudeTab))
                }
                card(rows)
            }
        }
        result.height = y - top
        return result
    }
}

final class OverviewTabView: NSView {
    static let padding: CGFloat = 16
    static let heroHeight: CGFloat = 92
    static let lanesHeight: CGFloat = 76
    static let todoRowHeight: CGFloat = 54
    static let sectionGap: CGFloat = 26
    static let burnLineHeight: CGFloat = 22

    static func ledgerHeight(_ model: OverviewModel) -> CGFloat {
        OverviewLedgerMetrics.layout(model, x: 0, width: 488, top: 0).height
    }

    static func preferredHeight(_ model: OverviewModel) -> CGFloat {
        var height = 18 + heroHeight + lanesHeight
        if model.hasLedger { height += sectionGap + ledgerHeight(model) }
        if !model.todos.isEmpty {
            height += sectionGap + 20 + CGFloat(model.todos.count) * (todoRowHeight + 6)
        }
        height += sectionGap + 20 + CGFloat(max(1, model.burnLines.count)) * burnLineHeight + 36
        return height + 18
    }

    var model = OverviewModel() {
        didSet {
            guard model != oldValue else { return }
            rebuildButtons()
            updateAccessibility()
            needsDisplay = true
        }
    }
    var onSelectTab: ((DashboardTab) -> Void)?
    var onOpenAccount: ((String) -> Void)?
    var onTodo: ((OverviewTodo) -> Void)?

    private var laneRects: [(DashboardTab, NSRect)] = []
    /// 마지막으로 그린 목록 줄. 누르기와 테스트가 읽는다.
    private(set) var ledgerRows: [OverviewLedgerRow] = []
    private var todoButtons: [PanelButton] = []
    private var burnButton: PanelButton?
    private var todoRowRects: [(String, NSRect)] = []

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        updateAccessibility()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func updateAccessibility() {
        if let notice = model.claudeNotice {
            setAccessibilityLabel("\(L10n.routableNow), \(notice.headline)")
        } else {
            let counts = overviewSummaryItems(model, maxWidth: .infinity).map(\.0).joined(separator: ", ")
            setAccessibilityLabel("\(L10n.routableNow) \(model.routable)/\(model.total), \(model.headline), \(counts), \(L10n.todoBadge(model.todos.count))")
        }
    }

    // MARK: 기하 — draw와 layout이 같은 값을 쓴다

    private var lanesTop: CGFloat { 18 + Self.heroHeight }
    private var ledgerTop: CGFloat { lanesTop + Self.lanesHeight + Self.sectionGap }
    private var todoTop: CGFloat {
        model.hasLedger ? ledgerTop + Self.ledgerHeight(model) + Self.sectionGap : lanesTop + Self.lanesHeight + Self.sectionGap
    }
    private var burnTop: CGFloat {
        guard !model.todos.isEmpty else { return todoTop }
        return todoTop + 20 + CGFloat(model.todos.count) * (Self.todoRowHeight + 6) + Self.sectionGap
    }

    private func todoRowRect(_ index: Int) -> NSRect {
        NSRect(x: Self.padding, y: todoTop + 20 + CGFloat(index) * (Self.todoRowHeight + 6),
               width: bounds.width - Self.padding * 2, height: Self.todoRowHeight)
    }

    private func rebuildButtons() {
        todoButtons.forEach { $0.removeFromSuperview() }
        todoButtons = model.todos.map { todo in
            let button = PanelButton(title: todo.actionTitle ?? "", style: todo.primary ? .primary : .ghost) { [weak self] in
                self?.onTodo?(todo)
            }
            button.isHidden = todo.actionTitle == nil
            button.setAccessibilityLabel("\(todo.actionTitle ?? ""): \(todo.name)")
            addSubview(button)
            return button
        }
        if burnButton == nil {
            let button = PanelButton(title: L10n.burnDetailsLink, style: .quiet) { [weak self] in self?.onSelectTab?(.burn) }
            addSubview(button)
            burnButton = button
        }
        needsLayout = true
    }

    override func layout() {
        super.layout()
        if todoButtons.count != model.todos.count { rebuildButtons() }
        for (index, button) in todoButtons.enumerated() {
            let row = todoRowRect(index)
            button.frame = NSRect(x: row.maxX - 10 - button.fittingWidth, y: row.midY - PanelButton.height / 2,
                                  width: button.fittingWidth, height: PanelButton.height)
        }
        if let burnButton {
            let y = burnTop + 20 + CGFloat(max(1, model.burnLines.count)) * Self.burnLineHeight + 6
            burnButton.frame = NSRect(x: Self.padding - 10, y: y, width: burnButton.fittingWidth + 14, height: PanelButton.height)
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let lane = laneRects.first(where: { $0.1.contains(point) }) { onSelectTab?(lane.0); return }
        if let target = rowClickTarget(at: point) {
            switch target {
            case .account(let name): onOpenAccount?(name)
            case .claudeTab: onSelectTab?(.claude)
            }
            return
        }
        if let row = todoRowRects.first(where: { $0.1.contains(point) }) { onOpenAccount?(row.0); return }
        super.mouseDown(with: event)
    }

    /// 목록 줄 위의 점을 누르면 갈 곳. 줄 밖이거나 갈 곳이 없는 줄이면 nil.
    func rowClickTarget(at point: NSPoint) -> OverviewRowTarget? {
        ledgerRows.first(where: { $0.rect.contains(point) })?.target
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let x0 = Self.padding
        let width = bounds.width - Self.padding * 2
        laneRects = []
        ledgerRows = []
        todoRowRects = []

        // 1. 지금 몇 개가 되는가
        PanelDraw.meta(L10n.routableNow, x0, 18)
        if let notice = model.claudeNotice {
            PanelDraw.text(notice.headline, x0, 44, NSFont.systemFont(ofSize: 20, weight: .semibold), TeamClaudePalette.fg2)
            PanelDraw.text(PanelDraw.clipped(notice.detail, TeamClaudePalette.captionFont, maxWidth: width), x0, 74,
                           TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
            // 예전 요약 띠와 같은 카드 id로 남긴다(빈 HOME 스냅샷이 소비 지점마다 같은 상태를 확인한다).
            ToolNoticeDrawLog.record("summary-\(notice.tool.rawValue)", notice)
        } else {
            drawHero(x0: x0)
        }

        if let notice = model.codexNotice { ToolNoticeDrawLog.record("summary-\(notice.tool.rawValue)", notice) }

        // 레인 4개
        let lanesRect = NSRect(x: x0, y: lanesTop, width: width, height: Self.lanesHeight)
        PanelDraw.hairline(lanesRect.minX, lanesRect.maxX, lanesRect.minY)
        PanelDraw.hairline(lanesRect.minX, lanesRect.maxX, lanesRect.maxY - 1)
        let laneWidth = width / CGFloat(max(1, model.lanes.count))
        for (index, lane) in model.lanes.enumerated() {
            let rect = NSRect(x: x0 + CGFloat(index) * laneWidth, y: lanesRect.minY, width: laneWidth, height: lanesRect.height)
            laneRects.append((lane.tab, rect))
            if index > 0 {
                TeamClaudePalette.line.setFill()
                NSRect(x: rect.minX, y: rect.minY, width: 1, height: rect.height).fill()
            }
            let inner = rect.minX + 12
            let maxText = rect.width - 20
            PanelDraw.text(PanelDraw.clipped(lane.name, TeamClaudePalette.legendFont, maxWidth: maxText), inner, rect.minY + 12,
                           TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
            if lane.quiet {
                PanelDraw.text(PanelDraw.clipped(lane.value, NSFont.systemFont(ofSize: 14, weight: .semibold), maxWidth: maxText),
                               inner, rect.minY + 32, NSFont.systemFont(ofSize: 14, weight: .semibold), TeamClaudePalette.fg2)
            } else {
                let valueWidth = PanelDraw.text(lane.value, inner, rect.minY + 27, TeamClaudePalette.laneValueFont, TeamClaudePalette.fg)
                if !lane.unit.isEmpty {
                    PanelDraw.text(lane.unit, inner + valueWidth + 4, rect.minY + 34, TeamClaudePalette.numberFont, TeamClaudePalette.fg3)
                }
            }
            PanelDraw.text(PanelDraw.clipped(lane.note, TeamClaudePalette.microFont, maxWidth: maxText), inner, rect.minY + 55,
                           TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        }

        // 2. Claude 상태별 목록
        if model.hasLedger {
            drawLedger(OverviewLedgerMetrics.layout(model, x: x0, width: width, top: ledgerTop), x0: x0, width: width)
        }

        // 3. 손볼 것
        if !model.todos.isEmpty {
            PanelDraw.meta(L10n.todoBadge(model.todos.count), x0, todoTop)
            PanelDraw.right(L10n.todoAside, x0 + width, todoTop, TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
            for (index, todo) in model.todos.enumerated() {
                let row = todoRowRect(index)
                PanelDraw.card(row)
                PanelDraw.dot(row.minX + 12, centerY: row.midY, todo.tone.color)
                let buttonWidth = index < todoButtons.count && todo.actionTitle != nil ? todoButtons[index].fittingWidth + 20 : 0
                let textX = row.minX + 30
                let textMax = row.maxX - buttonWidth - textX - 8
                let nameWidth = PanelDraw.text(PanelDraw.clipped(todo.name, TeamClaudePalette.nameFont, maxWidth: textMax * 0.6),
                                               textX, row.minY + 10, TeamClaudePalette.nameFont, TeamClaudePalette.fg)
                PanelDraw.text(PanelDraw.clipped(todo.label, TeamClaudePalette.captionFont, maxWidth: textMax - nameWidth - 8),
                               textX + nameWidth + 8, row.minY + 10.5, TeamClaudePalette.captionFont,
                               todo.tone == .error ? TeamClaudePalette.ember : TeamClaudePalette.fg2)
                PanelDraw.text(PanelDraw.clipped(todo.reason, TeamClaudePalette.captionFont, maxWidth: textMax), textX, row.minY + 29,
                               TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
                if todo.provider == "anthropic" {
                    todoRowRects.append((todo.name, NSRect(x: row.minX, y: row.minY, width: row.width - buttonWidth, height: row.height)))
                }
            }
        }

        // 4. 주간 소진 전망 미리보기
        PanelDraw.meta(L10n.burnPreviewTitle, x0, burnTop)
        if let aside = model.burnAside {
            PanelDraw.right(aside, x0 + width, burnTop, TeamClaudePalette.legendFont, TeamClaudePalette.amber)
        }
        if model.burnLines.isEmpty {
            PanelDraw.text(StatusVocabulary.notMeasured, x0, burnTop + 22, TeamClaudePalette.bodyFont, TeamClaudePalette.fg3)
        }
        for (index, line) in model.burnLines.enumerated() {
            let y = burnTop + 22 + CGFloat(index) * Self.burnLineHeight
            PanelDraw.text(line.lane, x0, y, TeamClaudePalette.bodyMediumFont, TeamClaudePalette.fg)
            PanelDraw.right(line.verdict, x0 + width, y, TeamClaudePalette.bodyFont, line.verdictColor)
            let maxProjection = width - 90 - PanelDraw.width(line.verdict, TeamClaudePalette.bodyFont) - 12
            PanelDraw.text(PanelDraw.clipped(line.projection, TeamClaudePalette.numberFont, maxWidth: maxProjection), x0 + 90, y + 1,
                           TeamClaudePalette.numberFont, TeamClaudePalette.fg2)
        }
    }

    // MARK: 큰 숫자 + 상태별 수 + 다음 복귀

    private func drawHero(x0: CGFloat) {
        let number = "\(model.routable)"
        let numberWidth = PanelDraw.text(number, x0 - 2, 30, TeamClaudePalette.heroFont, TeamClaudePalette.fg)
        let unit = "/ \(model.total)"
        let unitWidth = PanelDraw.text(unit, x0 + numberWidth + 6, 66, TeamClaudePalette.heroUnitFont, TeamClaudePalette.fg3)
        let textX = x0 + numberWidth + unitWidth + 26
        let textWidth = bounds.width - Self.padding - textX
        PanelDraw.text(PanelDraw.clipped(model.headline, TeamClaudePalette.bodyFont, maxWidth: textWidth), textX, 34,
                       TeamClaudePalette.bodyFont, TeamClaudePalette.fg2)
        // 상태별 수: 범례 색 점(사용 가능 민트 · 대기 호박 · 제외 빨강) + 라벨.
        var cursor = textX
        for (label, tone) in overviewSummaryItems(model, maxWidth: textWidth) {
            let room = textX + textWidth - cursor - 12
            guard room > 16 else { break }
            PanelDraw.dot(cursor, centerY: 62, tone.color)
            let shown = PanelDraw.clipped(label, TeamClaudePalette.legendFont, maxWidth: room)
            cursor += 12 + PanelDraw.text(shown, cursor + 12, 54, TeamClaudePalette.legendFont, TeamClaudePalette.fg2) + 14
        }
        let next: String
        if let wait = model.nextReturn, let seconds = wait.returnSeconds {
            next = L10n.nextReturn(wait.name, L10n.duration(seconds: Int(seconds)), wait.returnClock)
        } else {
            next = model.resetLine
        }
        PanelDraw.text(PanelDraw.clipped(next, TeamClaudePalette.captionFont, maxWidth: textWidth), textX, 74,
                       TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
    }

    // MARK: 상태별 목록

    private func drawLedger(_ layout: OverviewLedgerLayout, x0: CGFloat, width: CGFloat) {
        ledgerRows = layout.rows
        for (section, y) in layout.headers {
            drawSectionHeader(section, x0: x0, width: width, y: y)
        }
        for card in layout.cards { PanelDraw.card(card) }
        for (index, row) in layout.rows.enumerated() {
            if index > 0, layout.rows[index - 1].rect.maxY == row.rect.minY {
                PanelDraw.hairline(row.rect.minX + 1, row.rect.maxX - 1, row.rect.minY)
            }
            switch row.kind {
            case .live(let i): drawLiveRow(model.live[i], row.rect)
            case .waiting(let i): drawWaitingRow(model.waiting[i], row.rect)
            case .excluded(let i): drawExcludedRow(model.excluded[i], row.rect)
            case .more(_, let count): drawCentered(L10n.moreInClaudeTab(count), row.rect)
            case .empty: drawCentered(L10n.noLiveAccounts, row.rect)
            }
        }
    }

    private func drawSectionHeader(_ section: OverviewLedgerSection, x0: CGFloat, width: CGFloat, y: CGFloat) {
        let title: String, count: Int, hint: String?
        switch section {
        case .live:
            title = L10n.liveSectionTitle; count = model.live.count; hint = L10n.liveSectionHint
        case .waiting:
            title = L10n.waitingSectionTitle; count = model.waiting.count
            let soon = model.waiting.filter { ($0.returnSeconds ?? .infinity) <= teamClaudeSessionSeconds }.count
            hint = soon > 0 ? L10n.waitingSoonHint(soon) : L10n.waitingSectionHint
        case .excluded:
            title = L10n.excludedSectionTitle; count = model.excluded.count
            let inTodos = model.excluded.filter(\.inTodos).count
            hint = inTodos > 0 ? L10n.excludedInTodosHint(inTodos) : nil
        }
        let titleWidth = PanelDraw.meta(title, x0, y)
        PanelDraw.text("\(count)", x0 + titleWidth + 6, y - 0.5, TeamClaudePalette.numberFont, TeamClaudePalette.fg3)
        if let hint {
            PanelDraw.right(hint, x0 + width, y, TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
        }
    }

    private func drawCentered(_ text: String, _ rect: NSRect) {
        let font = TeamClaudePalette.legendFont
        let shown = PanelDraw.clipped(text, font, maxWidth: rect.width - 24)
        PanelDraw.text(shown, rect.midX - PanelDraw.width(shown, font) / 2, rect.midY - 7.5, font, TeamClaudePalette.fg3)
    }

    /// 세션·주간·Fable 라벨 열 폭(언어마다 가장 긴 라벨).
    private var windowLabelWidth: CGFloat {
        [L10n.sessionShort, L10n.weeklyShort, "Fable"].map { PanelDraw.width($0, TeamClaudePalette.microFont) }.max().map { ceil($0) + 6 } ?? 36
    }

    private func drawLiveRow(_ account: OverviewLiveAccount, _ rect: NSRect) {
        let m = OverviewLedgerMetrics.self
        let right = rect.maxX - 12
        let top = rect.minY
        // 이름 열
        PanelDraw.dot(rect.minX + m.dotX, centerY: top + 19, TeamClaudePalette.mint)
        PanelDraw.text(PanelDraw.clipped(account.name, TeamClaudePalette.nameFont, maxWidth: m.columnX - m.nameX - 8),
                       rect.minX + m.nameX, top + 11, TeamClaudePalette.nameFont, TeamClaudePalette.fg)
        if account.busy {
            PanelDraw.text(PanelDraw.clipped(account.label, TeamClaudePalette.microFont, maxWidth: m.columnX - m.nameX - 8),
                           rect.minX + m.nameX, top + 40, TeamClaudePalette.microFont, TeamClaudePalette.fg2)
        }
        // 오른쪽: 리셋까지 남은 시간과 리셋 시각
        // 열 폭은 그릴 글자에 맞춘다(영어 "resets Wed 2:41 AM"이 한국어보다 길다). 막대가 너무 줄지 않게 140에서 멈춘다.
        var timeColumn: CGFloat = 92
        if let remaining = account.sessionRemainingSeconds, remaining > 0 {
            let ahead = L10n.durationAhead(L10n.duration(seconds: Int(remaining)))
            let reset = account.sessionResetClock.map(L10n.resetAtClock)
            timeColumn = min(140, max(timeColumn, ceil(PanelDraw.width(ahead, TeamClaudePalette.captionFont)),
                                      ceil(reset.map { PanelDraw.width($0, TeamClaudePalette.microFont) } ?? 0)))
            PanelDraw.right(PanelDraw.clipped(ahead, TeamClaudePalette.captionFont, maxWidth: timeColumn), right, top + 9,
                            TeamClaudePalette.captionFont, TeamClaudePalette.fg2)
            if let reset {
                PanelDraw.right(PanelDraw.clipped(reset, TeamClaudePalette.microFont, maxWidth: timeColumn),
                                right, top + 24, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            }
        } else {
            PanelDraw.right(StatusVocabulary.none, right, top + 9, TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
        }
        // 세션 퍼센트(큰 숫자)
        let percentRight = right - timeColumn - 8
        let labelX = rect.minX + m.columnX
        let labelWidth = windowLabelWidth
        PanelDraw.text(L10n.sessionShort, labelX, top + 12, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        if account.sessionWindowAbsent {
            // 5시간 창이 없는 계정: 큰 숫자·막대 대신 문구 한 줄. 막대가 없으니 측정 누락처럼 보이지 않는다.
            let barX = labelX + labelWidth
            PanelDraw.text(PanelDraw.clipped(L10n.sessionNone, TeamClaudePalette.captionFont, maxWidth: max(24, percentRight - barX)),
                           barX, top + 9, TeamClaudePalette.captionFont, TeamClaudePalette.fg2)
        } else {
            let full = (account.sessionPercent ?? 0) >= panelRoutingThresholdPercent
            let signLeft = PanelDraw.right("%", percentRight, top + 13, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            let value = account.sessionPercent.map { "\(panelPercentNumber($0))" } ?? StatusVocabulary.none
            let valueLeft = PanelDraw.right(value, signLeft - 1, top + 9, TeamClaudePalette.sessionValueFont,
                                            full ? TeamClaudePalette.amber : TeamClaudePalette.fg)
            // 세션 막대(크게) — 안의 세로 눈금이 5시간 창이 지난 비율이다.
            let barX = labelX + labelWidth
            let barWidth = max(24, valueLeft - 10 - barX)
            PanelDraw.meter(NSRect(x: barX, y: top + 15, width: barWidth, height: 8), percent: account.sessionPercent,
                            elapsed: account.sessionElapsed)
        }
        // 주간·Fable 작은 막대
        let miniWidth = (right - labelX - 12) / 2
        drawMini(account.weekly, x: labelX, centerY: top + 47, width: miniWidth, labelWidth: labelWidth)
        drawMini(account.fable, x: labelX + miniWidth + 12, centerY: top + 47, width: miniWidth, labelWidth: labelWidth)
        // 속도 경고
        if let projection = account.projection {
            let y = top + m.liveRowHeight - 2
            drawWarningGlyph(x: rect.minX + m.dotX - 1, centerY: y + 7.5)
            let text = L10n.paceWarning(L10n.duration(seconds: Int(projection.hitsLimitInSeconds)),
                                        L10n.duration(seconds: Int(projection.earlierBySeconds)))
            PanelDraw.text(PanelDraw.clipped(text, TeamClaudePalette.captionFont, maxWidth: right - rect.minX - m.nameX),
                           rect.minX + m.nameX, y, TeamClaudePalette.captionFont, TeamClaudePalette.fg2)
        }
    }

    private func drawMini(_ window: OverviewMiniWindow, x: CGFloat, centerY: CGFloat, width: CGFloat, labelWidth: CGFloat) {
        let font = TeamClaudePalette.microFont
        PanelDraw.text(window.label, x, centerY - 7, font, TeamClaudePalette.fg3)
        let bar = NSRect(x: x + labelWidth, y: centerY - 2, width: 36, height: 4)
        PanelDraw.meter(bar, percent: window.percent, elapsed: nil)
        let percentRight = bar.maxX + 36
        PanelDraw.right(panelPercentText(window.percent), percentRight, centerY - 7.5, TeamClaudePalette.smallFont,
                        (window.percent ?? 0) >= panelRoutingThresholdPercent ? TeamClaudePalette.amber : TeamClaudePalette.fg2)
        if let remaining = window.remainingSeconds, remaining > 0 {
            let room = x + width - percentRight - 6
            PanelDraw.text(PanelDraw.clipped(L10n.duration(seconds: Int(remaining)), font, maxWidth: room), percentRight + 6,
                           centerY - 7, font, TeamClaudePalette.fg3)
        }
    }

    private func drawWarningGlyph(x: CGFloat, centerY: CGFloat) {
        let path = NSBezierPath()
        path.move(to: NSPoint(x: x + 4.5, y: centerY - 4.5))
        path.line(to: NSPoint(x: x + 9, y: centerY + 3.5))
        path.line(to: NSPoint(x: x, y: centerY + 3.5))
        path.close()
        TeamClaudePalette.amber.setFill()
        path.fill()
    }

    private func drawWaitingRow(_ account: OverviewWaitingAccount, _ rect: NSRect) {
        let m = OverviewLedgerMetrics.self
        let right = rect.maxX - 12
        PanelDraw.dot(rect.minX + m.dotX, centerY: rect.midY, TeamClaudePalette.amber)
        PanelDraw.text(PanelDraw.clipped(account.name, TeamClaudePalette.nameFont, maxWidth: m.columnX - m.nameX - 8),
                       rect.minX + m.nameX, rect.midY - 8, TeamClaudePalette.nameFont, TeamClaudePalette.fg2)
        // 원인 태그(면은 무채색, 세션 가득만 글자를 밝게 — 몇 시간이면 돌아온다).
        let tag = account.cause.tag
        let tagWidth = ceil(PanelDraw.width(tag, TeamClaudePalette.microFont)) + 12
        let tagRect = NSRect(x: rect.minX + m.columnX, y: rect.midY - 8.5, width: tagWidth, height: 17)
        PanelDraw.fillRound(tagRect, NSColor.white.withAlphaComponent(0.06), 6)
        PanelDraw.text(tag, tagRect.minX + 6, tagRect.minY + 1.5, TeamClaudePalette.microFont,
                       account.cause == .session ? TeamClaudePalette.fg2 : TeamClaudePalette.fg3)
        // 오른쪽: 남은 시간 · 복귀 시각
        let clockColumn: CGFloat = 92
        var leftLimit = right
        if let seconds = account.returnSeconds {
            if let clock = account.returnClock {
                PanelDraw.right(PanelDraw.clipped(clock, TeamClaudePalette.microFont, maxWidth: clockColumn), right, rect.midY - 7,
                                TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            }
            leftLimit = PanelDraw.right(L10n.durationAhead(L10n.duration(seconds: Int(seconds))), right - clockColumn - 8, rect.midY - 8,
                                        TeamClaudePalette.captionFont,
                                        seconds <= teamClaudeSessionSeconds ? TeamClaudePalette.fg : TeamClaudePalette.fg2)
        } else if let note = account.note {
            leftLimit = PanelDraw.right(PanelDraw.clipped(note, TeamClaudePalette.captionFont, maxWidth: 140), right, rect.midY - 8,
                                        TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
        }
        // 세션 가득이면 주간 작은 막대와 퍼센트(주간에 여유가 있어 몇 시간이면 돌아온다는 뜻).
        if account.cause == .session, let weekly = account.weeklyPercent {
            let x = tagRect.maxX + 10
            let labelWidth = ceil(PanelDraw.width(L10n.weeklyShort, TeamClaudePalette.microFont)) + 6
            let needed = labelWidth + 36 + 6 + PanelDraw.width("100%", TeamClaudePalette.smallFont)
            if x + needed < leftLimit - 8 {
                PanelDraw.text(L10n.weeklyShort, x, rect.midY - 7, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
                PanelDraw.meter(NSRect(x: x + labelWidth, y: rect.midY - 2, width: 36, height: 4), percent: weekly, elapsed: nil)
                PanelDraw.text(panelPercentText(weekly), x + labelWidth + 42, rect.midY - 7.5, TeamClaudePalette.smallFont,
                               TeamClaudePalette.fg2)
            }
        }
    }

    private func drawExcludedRow(_ account: OverviewExcludedAccount, _ rect: NSRect) {
        let m = OverviewLedgerMetrics.self
        PanelDraw.dot(rect.minX + m.dotX, centerY: rect.midY, account.tone.color)
        PanelDraw.text(PanelDraw.clipped(account.name, TeamClaudePalette.nameFont, maxWidth: m.columnX - m.nameX - 8),
                       rect.minX + m.nameX, rect.midY - 8, TeamClaudePalette.nameFont, TeamClaudePalette.fg2)
        PanelDraw.text(PanelDraw.clipped(account.reason, TeamClaudePalette.captionFont, maxWidth: rect.maxX - 12 - rect.minX - m.columnX),
                       rect.minX + m.columnX, rect.midY - 8, TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
    }
}
