import Cocoa

// 패널 셸(menubar/DESIGN.md "패널 구성"): 머리(제목·기준 시각·손볼 것 배지) + 탭 5개 + 본문 + 하단 동작 막대.
// 본문을 그리는 카드들은 각 파일에 있고, 여기는 셸과 탭·단축키 판정만 둔다(main.swift 없이 컴파일된다).

enum DashboardTab: Int, CaseIterable {
    case overview, claude, codex, burn, cli

    var title: String {
        switch self {
        case .overview: return L10n.tabOverview
        case .claude: return L10n.tabClaude
        case .codex: return L10n.tabCodex
        case .burn: return L10n.tabBurn
        case .cli: return L10n.tabCli
        }
    }

    /// 숫자 키 1–5.
    var shortcutKey: String { "\(rawValue + 1)" }

    /// 스냅샷 파일 이름·출력에 쓰는 고정 id(언어와 무관).
    var id: String {
        switch self {
        case .overview: return "overview"
        case .claude: return "claude"
        case .codex: return "codex"
        case .burn: return "burn"
        case .cli: return "cli"
        }
    }

    /// 탭에 들어가는 대시보드 섹션 id(DashboardSection.id). 모든 섹션은 정확히 한 탭에 속한다.
    var sectionIDs: [String] {
        switch self {
        case .overview: return ["overview"]
        case .claude: return ["claude"]
        case .codex: return ["codex"]
        case .burn: return ["burn", "usage"]
        case .cli: return ["cli", "higgsfield", "vocabulary"]
        }
    }

    static func containing(section id: String) -> DashboardTab? {
        allCases.first { $0.sectionIDs.contains(id) }
    }
}

/// 패널 단축키(⌘K 동작 목록, R 새로고침, 1–5 탭, esc 닫기). 판정은 순수 함수이고, 키를 받는 쪽은 AppDelegate다.
enum DashboardShortcut: Equatable {
    case tab(DashboardTab)
    case refresh
    case toggleActions
    case closeActions

    static func resolve(characters: String, command: Bool, otherModifiers: Bool) -> DashboardShortcut? {
        let key = characters.lowercased()
        if command, !otherModifiers, key == "k" { return .toggleActions }
        guard !command, !otherModifiers else { return nil }
        if key == "r" { return .refresh }
        if key == "\u{1b}" { return .closeActions }
        if let number = Int(key), let tab = DashboardTab(rawValue: number - 1) { return .tab(tab) }
        return nil
    }
}

/// NSMenuItem.representedObject에 단축키 판정을 싣는 상자.
final class DashboardShortcutBox: NSObject {
    let shortcut: DashboardShortcut
    init(_ shortcut: DashboardShortcut) { self.shortcut = shortcut }
}

/// 하단 동작 목록의 한 항목. 현재 앱의 동작 행을 그대로 옮긴다(동작을 줄이지 않는다).
struct DashboardAction {
    enum Group { case refresh, account, app }
    let id: String
    let group: Group
    let title: String
    var detail: String
    var keys: [String] = []
    var danger = false
    /// true면 실행 뒤 메뉴를 닫는다. 로그인 시 열기처럼 결과를 그 자리에 보여 주는 항목은 false.
    var closesMenu = true
    let run: () -> String?
}

/// 패널 머리: 앱 표시 · 제목 · 기준 시각 · 손볼 것 배지, 그 아래 탭 세그먼트.
final class DashboardPanelHeaderView: NSView {
    static let preferredHeight: CGFloat = 96

    var selectedTab: DashboardTab = .overview { didSet { if oldValue != selectedTab { needsDisplay = true; updateAccessibility() } } }
    var stamp = "" { didSet { if oldValue != stamp { needsDisplay = true } } }
    var todoCount = 0 { didSet { if oldValue != todoCount { needsDisplay = true; updateAccessibility() } } }
    var onSelectTab: ((DashboardTab) -> Void)?
    var onBadge: (() -> Void)?

    private var badgeRect = NSRect.zero
    private var tabRects: [(DashboardTab, NSRect)] = []

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
        updateAccessibility()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private func updateAccessibility() {
        setAccessibilityLabel("\(L10n.panelTitle), \(selectedTab.title), \(L10n.todoBadge(todoCount))")
    }

    /// 탭 세그먼트 칸. draw·mouseDown이 같은 값을 쓴다.
    static func tabSegmentRects(width: CGFloat) -> [(DashboardTab, NSRect)] {
        let bar = NSRect(x: 16, y: 50, width: width - 32, height: 34)
        let inner = bar.insetBy(dx: 3, dy: 3)
        let segment = inner.width / CGFloat(DashboardTab.allCases.count)
        return DashboardTab.allCases.map { tab in
            (tab, NSRect(x: inner.minX + CGFloat(tab.rawValue) * segment, y: inner.minY, width: segment, height: inner.height))
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if badgeRect.contains(point) { onBadge?(); return }
        if let hit = tabRects.first(where: { $0.1.contains(point) }) { onSelectTab?(hit.0); return }
        super.mouseDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        TeamClaudePalette.sheet.setFill()
        bounds.fill()
        // 앱 표시 — 풀 용량 띠를 줄인 막대 셋.
        let glyph = NSRect(x: 16, y: 14, width: 22, height: 22)
        PanelDraw.fillRound(glyph, TeamClaudePalette.overlay, 6)
        PanelDraw.strokeRound(glyph, NSColor.white.withAlphaComponent(0.08), 6)
        for (index, (height, color)) in [(6.0, TeamClaudePalette.fg), (10.0, TeamClaudePalette.fg), (8.0, TeamClaudePalette.amber)].enumerated() {
            PanelDraw.fillRound(NSRect(x: glyph.minX + 5.5 + CGFloat(index) * 4, y: glyph.maxY - 5 - CGFloat(height),
                                       width: 3, height: CGFloat(height)), color.withAlphaComponent(0.9), 1)
        }
        let titleWidth = PanelDraw.text(L10n.panelTitle, 46, 16, TeamClaudePalette.panelTitleFont, TeamClaudePalette.fg)
        PanelDraw.text(stamp, 46 + titleWidth + 8, 18.5, TeamClaudePalette.microFont, TeamClaudePalette.fg3)

        badgeRect = .zero
        if todoCount > 0 {
            let label = L10n.todoBadge(todoCount)
            let w = PanelDraw.width(label, TeamClaudePalette.captionFont) + 26
            badgeRect = NSRect(x: bounds.width - 16 - w, y: 14, width: w, height: 22)
            PanelDraw.fillRound(badgeRect, TeamClaudePalette.amber.withAlphaComponent(0.10), 6)
            PanelDraw.dot(badgeRect.minX + 8, centerY: badgeRect.midY, TeamClaudePalette.amber)
            PanelDraw.text(label, badgeRect.minX + 19, badgeRect.minY + 3.5, TeamClaudePalette.captionFont, TeamClaudePalette.amber)
        }

        tabRects = Self.tabSegmentRects(width: bounds.width)
        if let first = tabRects.first?.1, let last = tabRects.last?.1 {
            let bar = NSRect(x: first.minX - 3, y: first.minY - 3, width: last.maxX - first.minX + 6, height: first.height + 6)
            PanelDraw.fillRound(bar, NSColor.white.withAlphaComponent(0.03), 9)
            PanelDraw.strokeRound(bar, TeamClaudePalette.line, 9)
        }
        for (tab, rect) in tabRects {
            let selected = tab == selectedTab
            if selected {
                PanelDraw.fillRound(rect, TeamClaudePalette.overlay, 7)
                PanelDraw.strokeRound(rect, NSColor.white.withAlphaComponent(0.08), 7)
            }
            let font = selected ? TeamClaudePalette.bodyMediumFont : TeamClaudePalette.bodyFont
            let w = PanelDraw.width(tab.title, font)
            PanelDraw.text(tab.title, rect.midX - w / 2, rect.midY - 8, font, selected ? TeamClaudePalette.fg : TeamClaudePalette.fg2)
        }
        PanelDraw.hairline(0, bounds.width, bounds.height - 1)
    }
}

/// 하단 동작 막대: 왼쪽은 지금 탭의 한 줄 요약, 오른쪽은 "새로고침 R"과 "동작 ⌘K".
final class DashboardPanelFooterView: NSView {
    static let preferredHeight: CGFloat = 44

    var context = "" { didSet { if oldValue != context { needsDisplay = true } } }
    var refreshDetail = "" { didSet { if oldValue != refreshDetail { toolTip = refreshDetail } } }
    var actionsOpen = false { didSet { if oldValue != actionsOpen { needsDisplay = true } } }
    var onRefresh: (() -> Void)?
    var onActions: (() -> Void)?

    private var refreshRect = NSRect.zero
    private var actionsRect = NSRect.zero

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.toolbar)
        setAccessibilityLabel("\(L10n.refresh) R, \(L10n.actions) ⌘K")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if refreshRect.contains(point) { onRefresh?(); return }
        if actionsRect.contains(point) { onActions?(); return }
        super.mouseDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        TeamClaudePalette.sheet.setFill()
        bounds.fill()
        NSColor.black.withAlphaComponent(0.25).setFill()
        bounds.fill()
        PanelDraw.hairline(0, bounds.width, 0)
        let midY = bounds.midY
        let fg2 = TeamClaudePalette.fg2
        let font = NSFont.systemFont(ofSize: 12.5)

        // 오른쪽부터: [동작 ⌘ K]  |  [↻ 새로고침 R]
        var x = bounds.width - 6
        let actionKeys = ["⌘", "K"]
        let actionsWidth = 8 + PanelDraw.width(L10n.actions, font) + 8 + PanelDraw.keycapsWidth(actionKeys) + 8
        actionsRect = NSRect(x: x - actionsWidth, y: midY - 16, width: actionsWidth, height: 32)
        if actionsOpen { PanelDraw.fillRound(actionsRect, NSColor.white.withAlphaComponent(0.06), 8) }
        let actionsTextWidth = PanelDraw.text(L10n.actions, actionsRect.minX + 8, midY - 8, font, actionsOpen ? TeamClaudePalette.fg : fg2)
        PanelDraw.keycaps(actionKeys, actionsRect.minX + 16 + actionsTextWidth, centerY: midY, active: actionsOpen)
        x = actionsRect.minX - 6
        TeamClaudePalette.lineStrong.setFill()
        NSRect(x: x - 1, y: midY - 8, width: 1, height: 16).fill()
        x -= 6

        let refreshWidth = 8 + 14 + 8 + PanelDraw.width(L10n.refresh, font) + 8 + PanelDraw.keycapWidth("R") + 8
        refreshRect = NSRect(x: x - refreshWidth, y: midY - 16, width: refreshWidth, height: 32)
        if let icon = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil) {
            let tinted = icon.copy() as? NSImage ?? icon
            tinted.isTemplate = true
            let iconRect = NSRect(x: refreshRect.minX + 8, y: midY - 7, width: 14, height: 14)
            NSGraphicsContext.saveGraphicsState()
            tinted.draw(in: iconRect)
            fg2.set()
            iconRect.fill(using: .sourceAtop)
            NSGraphicsContext.restoreGraphicsState()
        }
        let refreshTextWidth = PanelDraw.text(L10n.refresh, refreshRect.minX + 30, midY - 8, font, fg2)
        PanelDraw.keycap("R", refreshRect.minX + 38 + refreshTextWidth, centerY: midY)

        let contextMax = refreshRect.minX - 16 - 12
        PanelDraw.text(PanelDraw.clipped(context, NSFont.systemFont(ofSize: 11.5), maxWidth: contextMax), 16, midY - 7.5,
                       NSFont.systemFont(ofSize: 11.5), TeamClaudePalette.fg3)
    }
}

/// ⌘K 동작 목록. 하단 막대 위에 뜨고, 항목을 누르면 실행한다.
final class DashboardActionListView: NSView {
    static let width: CGFloat = 320
    static let rowHeight: CGFloat = 36
    static let groupHeadHeight: CGFloat = 26

    var actions: [DashboardAction] = [] { didSet { needsDisplay = true } }
    var onRun: ((DashboardAction) -> Void)?
    private var rowRects: [(Int, NSRect)] = []
    private var hovered: Int? { didSet { if oldValue != hovered { needsDisplay = true } } }
    private var trackingAreaRef: NSTrackingArea?

    override var isFlipped: Bool { true }

    static func groupTitle(_ group: DashboardAction.Group) -> String {
        switch group {
        case .refresh: return L10n.actionGroupRefresh
        case .account: return L10n.actionGroupAccount
        case .app: return L10n.actionGroupApp
        }
    }

    static func preferredHeight(_ actions: [DashboardAction]) -> CGFloat {
        var height: CGFloat = 12
        var last: DashboardAction.Group?
        for action in actions {
            if action.group != last { height += groupHeadHeight; last = action.group }
            height += rowHeight
        }
        return height
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.list)
        setAccessibilityLabel(L10n.actions)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaRef { removeTrackingArea(trackingAreaRef) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        trackingAreaRef = area
    }

    override func mouseMoved(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        hovered = rowRects.first { $0.1.contains(point) }?.0
    }

    override func mouseExited(with event: NSEvent) { hovered = nil }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        guard let index = rowRects.first(where: { $0.1.contains(point) })?.0, actions.indices.contains(index) else { return }
        onRun?(actions[index])
    }

    func updateDetail(id: String, detail: String) {
        guard let index = actions.firstIndex(where: { $0.id == id }) else { return }
        actions[index].detail = detail
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.black.withAlphaComponent(0.45).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1).offsetBy(dx: 0, dy: 3), xRadius: 11, yRadius: 11).fill()
        PanelDraw.fillRound(bounds, TeamClaudePalette.raised, 11)
        PanelDraw.strokeRound(bounds, TeamClaudePalette.lineStrong, 11)
        rowRects = []
        var y: CGFloat = 6
        var last: DashboardAction.Group?
        for (index, action) in actions.enumerated() {
            if action.group != last {
                PanelDraw.meta(Self.groupTitle(action.group), 16, y + 8)
                y += Self.groupHeadHeight
                last = action.group
            }
            let row = NSRect(x: 6, y: y, width: bounds.width - 12, height: Self.rowHeight)
            rowRects.append((index, row))
            let active = index == hovered
            if active { PanelDraw.fillRound(row, NSColor.white.withAlphaComponent(0.07), 8) }
            let titleColor = active ? (action.danger ? TeamClaudePalette.ember : TeamClaudePalette.fg) : TeamClaudePalette.fg2
            var right = row.maxX - 10
            if !action.keys.isEmpty {
                right -= PanelDraw.keycapsWidth(action.keys)
                PanelDraw.keycaps(action.keys, right, centerY: row.midY)
                right -= 8
            }
            if !action.detail.isEmpty {
                let detailFont = NSFont.systemFont(ofSize: 11.5)
                let detail = PanelDraw.clipped(action.detail, detailFont, maxWidth: 130)
                right = PanelDraw.right(detail, right, row.midY - 7.5, detailFont, TeamClaudePalette.fg3) - 10
            }
            let title = PanelDraw.clipped(action.title, TeamClaudePalette.bodyFont, maxWidth: right - row.minX - 10)
            PanelDraw.text(title, row.minX + 10, row.midY - 8, TeamClaudePalette.bodyFont, titleColor)
            y += Self.rowHeight
        }
    }
}

/// 그릴 데이터가 없는 탭의 빈 상태: 정보 표시 · 제목 · 무엇이 여기 올지.
final class PanelEmptyStateView: NSView {
    static let preferredHeight: CGFloat = 150
    var title = "" { didSet { needsDisplay = true; setAccessibilityLabel(title) } }
    var detail = "" { didSet { needsDisplay = true; setAccessibilityHelp(detail) } }
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let badge = NSRect(x: 16, y: 32, width: 32, height: 32)
        PanelDraw.fillRound(badge, TeamClaudePalette.overlay, 8)
        let mark = "i"
        let markFont = NSFont.systemFont(ofSize: 15, weight: .semibold)
        PanelDraw.text(mark, badge.midX - PanelDraw.width(mark, markFont) / 2, badge.minY + 7, markFont, TeamClaudePalette.fg2)
        PanelDraw.text(title, 16, 76, NSFont.systemFont(ofSize: 15, weight: .semibold), TeamClaudePalette.fg)
        PanelDraw.text(PanelDraw.clipped(detail, TeamClaudePalette.bodyFont, maxWidth: bounds.width - 32), 16, 100,
                       TeamClaudePalette.bodyFont, TeamClaudePalette.fg2)
    }
}
