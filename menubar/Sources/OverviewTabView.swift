import Cocoa

// 개요 탭(menubar/DESIGN.md "탭"): 지금 라우팅 가능 큰 숫자 → 레인 4개 → Claude 풀 주간 사용률 띠 →
// 손볼 것 → 기다리면 풀림 → 주간 소진 전망 미리보기. 값은 모두 기존 로더·판정이 만든 것을
// DashboardOverviewBuilder.swift가 옮겨 담는다. 이 파일은 그리기만 한다(새 계산 없음).

struct OverviewLane: Equatable {
    let name: String
    let value: String
    let unit: String
    let note: String
    let tab: DashboardTab
    /// 숫자가 아닌 값("확인 중"·"미설치")은 작게 그린다.
    let quiet: Bool
}

struct OverviewStripColumn: Equatable {
    let name: String
    let label: String
    let tone: PanelTone
    let weeklyPercent: Double?
    let sessionPercent: Double?
    let fablePercent: Double?
    let weeklyElapsed: Double?
    /// 라우팅에서 빠진 계정(막대를 흐리게).
    let excluded: Bool
    /// 칸 위 3pt 띠(오류 빨강, 꺼 둠 회색). 없으면 nil.
    let cap: PanelTone?
}

enum OverviewTodoAction: Equatable {
    case none
    case reauthenticate
    case subscriptionRecord
    case codexRecover(TeamCodexAccountRecoveryKind)
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

struct OverviewModel: Equatable {
    /// TeamClaude가 없으면 큰 숫자 대신 이 안내를 그린다(Phase 1 미설치).
    var claudeNotice: ToolNotice?
    /// Codex·TeamCodex가 둘 다 없을 때의 안내. Codex 레인이 같은 문구를 그린다.
    var codexNotice: ToolNotice?
    var routable = 0
    var total = 0
    var headline = ""
    var resetLine = ""
    var lanes: [OverviewLane] = []
    var strip: [OverviewStripColumn] = []
    var readyCount = 0
    var waitCount = 0
    var excludedCount = 0
    var elapsedCaption: String?
    var todos: [OverviewTodo] = []
    var waitingNames: [String] = []
    var waitingCaption: String?
    var burnAside: String?
    var burnLines: [OverviewBurnLine] = []
}

final class OverviewTabView: NSView {
    static let padding: CGFloat = 16
    static let heroHeight: CGFloat = 92
    static let lanesHeight: CGFloat = 76
    static let stripHeight: CGFloat = 132
    static let todoRowHeight: CGFloat = 54
    static let sectionGap: CGFloat = 26
    static let burnLineHeight: CGFloat = 22

    static func preferredHeight(_ model: OverviewModel) -> CGFloat {
        var height = 18 + heroHeight + lanesHeight
        if !model.strip.isEmpty { height += sectionGap + stripHeight }
        if !model.todos.isEmpty || !model.waitingNames.isEmpty {
            height += sectionGap + 20 + CGFloat(model.todos.count) * (todoRowHeight + 6)
            if model.waitingCaption != nil { height += 30 }
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
    private var columnRects: [(String, NSRect)] = []
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
            setAccessibilityLabel("\(L10n.routableNow) \(model.routable)/\(model.total), \(model.headline), \(L10n.todoBadge(model.todos.count))")
        }
    }

    // MARK: 기하 — draw와 layout이 같은 값을 쓴다

    private var lanesTop: CGFloat { 18 + Self.heroHeight }
    private var stripTop: CGFloat { lanesTop + Self.lanesHeight + Self.sectionGap }
    private var todoTop: CGFloat {
        model.strip.isEmpty ? lanesTop + Self.lanesHeight + Self.sectionGap : stripTop + Self.stripHeight + Self.sectionGap
    }
    private var burnTop: CGFloat {
        guard !model.todos.isEmpty || !model.waitingNames.isEmpty else { return todoTop }
        return todoTop + 20 + CGFloat(model.todos.count) * (Self.todoRowHeight + 6)
            + (model.waitingCaption != nil ? 30 : 0) + Self.sectionGap
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
        if let column = columnRects.first(where: { $0.1.contains(point) }) { onOpenAccount?(column.0); return }
        if let row = todoRowRects.first(where: { $0.1.contains(point) }) { onOpenAccount?(row.0); return }
        super.mouseDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let x0 = Self.padding
        let width = bounds.width - Self.padding * 2
        laneRects = []
        columnRects = []
        todoRowRects = []
        removeAllToolTips()

        // 1. 지금 몇 개가 되는가
        PanelDraw.meta(L10n.routableNow, x0, 18)
        if let notice = model.claudeNotice {
            PanelDraw.text(notice.headline, x0, 44, NSFont.systemFont(ofSize: 20, weight: .semibold), TeamClaudePalette.fg2)
            PanelDraw.text(PanelDraw.clipped(notice.detail, TeamClaudePalette.captionFont, maxWidth: width), x0, 74,
                           TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
            // 예전 요약 띠와 같은 카드 id로 남긴다(빈 HOME 스냅샷이 소비 지점마다 같은 상태를 확인한다).
            ToolNoticeDrawLog.record("summary-\(notice.tool.rawValue)", notice)
        } else {
            let number = "\(model.routable)"
            let numberWidth = PanelDraw.text(number, x0 - 2, 30, TeamClaudePalette.heroFont, TeamClaudePalette.fg)
            let unit = "/ \(model.total)"
            let unitWidth = PanelDraw.text(unit, x0 + numberWidth + 6, 66, TeamClaudePalette.heroUnitFont, TeamClaudePalette.fg3)
            let textX = x0 + numberWidth + unitWidth + 26
            let textWidth = bounds.width - Self.padding - textX
            PanelDraw.text(PanelDraw.clipped(model.headline, TeamClaudePalette.bodyFont, maxWidth: textWidth), textX, 52,
                           TeamClaudePalette.bodyFont, TeamClaudePalette.fg2)
            PanelDraw.text(PanelDraw.clipped(model.resetLine, TeamClaudePalette.captionFont, maxWidth: textWidth), textX, 72,
                           TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
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
            PanelDraw.text(PanelDraw.clipped(lane.name, NSFont.systemFont(ofSize: 11.5), maxWidth: maxText), inner, rect.minY + 12,
                           NSFont.systemFont(ofSize: 11.5), TeamClaudePalette.fg3)
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

        // 2. Claude 풀 주간 사용률 띠
        if !model.strip.isEmpty {
            drawStrip(x0: x0, width: width)
        }

        // 3. 손볼 것
        if !model.todos.isEmpty || !model.waitingNames.isEmpty {
            PanelDraw.meta(L10n.todoBadge(model.todos.count), x0, todoTop)
            PanelDraw.right(L10n.todoAside, x0 + width, todoTop, NSFont.systemFont(ofSize: 11.5), TeamClaudePalette.fg3)
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
            if let caption = model.waitingCaption {
                let y = todoRowRect(model.todos.count).minY + 4
                PanelDraw.dot(x0 + 4, centerY: y + 8, TeamClaudePalette.amber)
                PanelDraw.text(PanelDraw.clipped(caption, TeamClaudePalette.captionFont, maxWidth: width - 20), x0 + 18, y,
                               TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
            }
        }

        // 4. 주간 소진 전망 미리보기
        PanelDraw.meta(L10n.burnPreviewTitle, x0, burnTop)
        if let aside = model.burnAside {
            PanelDraw.right(aside, x0 + width, burnTop, NSFont.systemFont(ofSize: 11.5), TeamClaudePalette.amber)
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

    private func drawStrip(x0: CGFloat, width: CGFloat) {
        let top = stripTop
        PanelDraw.meta(L10n.stripTitle, x0, top)
        // 범례: 사용 가능 · 대기 · 제외
        var legendX = x0 + width
        for (label, tone) in [(L10n.legendExcluded(model.excludedCount), PanelTone.error),
                              (L10n.legendWait(model.waitCount), PanelTone.wait),
                              (L10n.legendReady(model.readyCount), PanelTone.ready)] {
            legendX = PanelDraw.right(label, legendX, top, NSFont.systemFont(ofSize: 11.5), TeamClaudePalette.fg3)
            PanelDraw.dot(legendX - 12, centerY: top + 7.5, tone.color)
            legendX -= 24
        }

        let chart = NSRect(x: x0, y: top + 28, width: width, height: 56)
        let count = CGFloat(model.strip.count)
        let gap: CGFloat = 3
        let columnWidth = max(2, (chart.width - gap * (count - 1)) / count)
        for (index, column) in model.strip.enumerated() {
            let rect = NSRect(x: chart.minX + CGFloat(index) * (columnWidth + gap), y: chart.minY, width: columnWidth, height: chart.height)
            columnRects.append((column.name, rect))
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: rect, xRadius: 4, yRadius: 4).addClip()
            NSColor.white.withAlphaComponent(0.06).setFill()
            rect.fill()
            if let weekly = column.weeklyPercent {
                let share = CGFloat(max(0, min(100, weekly)) / 100)
                let fill = column.excluded ? TeamClaudePalette.graphite
                    : column.tone == .wait ? TeamClaudePalette.amber : TeamClaudePalette.ash.withAlphaComponent(0.85)
                fill.setFill()
                NSRect(x: rect.minX, y: rect.maxY - rect.height * share, width: rect.width, height: rect.height * share).fill()
            }
            if let cap = column.cap {
                cap.color.setFill()
                NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: 3).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
            // 창 경과 눈금 — 이 선보다 높은 칸은 리셋 전에 찰 속도로 쓰는 중이다.
            if let elapsed = column.weeklyElapsed, !column.excluded {
                let y = rect.maxY - rect.height * CGFloat(elapsed) - 1
                TeamClaudePalette.sky.withAlphaComponent(0.9).setFill()
                NSRect(x: rect.minX - (index == 0 ? 0 : gap / 2), y: y, width: rect.width + gap, height: 2).fill()
            }
            let tip = "\(column.name) · \(column.label) · \(L10n.weeklyShort) \(panelPercentText(column.weeklyPercent))"
                + " · \(L10n.sessionShort) \(panelPercentText(column.sessionPercent))"
                + (column.fablePercent.map { " · Fable \(panelPercentText($0))" } ?? "")
            addToolTip(rect, owner: tip as NSString, userData: nil)
            let label = String(format: "%02d", index + 1)
            let labelFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
            let showLabel = count <= 20 || index == 0 || index == model.strip.count - 1 || (index + 1) % 5 == 0
            if showLabel {
                let w = PanelDraw.width(label, labelFont)
                PanelDraw.text(label, rect.midX - w / 2, chart.maxY + 6, labelFont, TeamClaudePalette.fg3)
            }
        }
        if let caption = model.elapsedCaption {
            let y = chart.maxY + 26
            TeamClaudePalette.sky.setFill()
            NSBezierPath(roundedRect: NSRect(x: x0, y: y + 7, width: 16, height: 2), xRadius: 1, yRadius: 1).fill()
            PanelDraw.text(PanelDraw.clipped(caption, NSFont.systemFont(ofSize: 11.5), maxWidth: width - 24), x0 + 24, y,
                           NSFont.systemFont(ofSize: 11.5), TeamClaudePalette.fg3)
        }
    }
}
