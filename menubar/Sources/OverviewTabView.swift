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
    /// 있으면 "기다리면 풀림" 줄을 그린다. 그리는 문구는 overviewWaitingCaption이 폭에 맞춰 waitingNames로 다시 만든다.
    var waitingCaption: String?
    var burnAside: String?
    var burnLines: [OverviewBurnLine] = []
}

/// 띠의 칸 하나. 계정이 칸 수보다 많으면 이웃한 계정 여럿을 한 칸으로 묶는다(그리기만의 일 — 값은 고르고 평균만 낸다).
struct OverviewStripSlot: Equatable {
    /// 그릴 값. 한 계정이면 그 계정 그대로, 묶음이면 합친 값.
    let column: OverviewStripColumn
    let firstIndex: Int
    let memberCount: Int
    let readyCount: Int
    let waitCount: Int
    let excludedCount: Int
}

/// 개요 띠 칸을 눌렀을 때 갈 곳. 한 계정짜리 칸은 그 계정, 여러 계정을 묶은 칸은 구성원이 모두 보이는 Claude 탭.
enum OverviewStripTarget: Equatable {
    case account(String)
    case claudeTab
}

enum OverviewStripMetrics {
    static let gap: CGFloat = 3
    /// 칸이 이보다 얇아지면 묶는다. 띠 폭 안에 들어가는 칸 수가 여기서 정해진다.
    static let minColumnWidth: CGFloat = 4

    static func maxColumns(chartWidth: CGFloat) -> Int {
        max(1, Int(((chartWidth + gap) / (minColumnWidth + gap)).rounded(.down)))
    }

    /// 칸 사각형. 그리기·누르기·테스트가 같은 값을 쓴다.
    static func columnRects(count: Int, chart: NSRect) -> [NSRect] {
        guard count > 0 else { return [] }
        let width = (chart.width - gap * CGFloat(count - 1)) / CGFloat(count)
        return (0..<count).map {
            NSRect(x: chart.minX + CGFloat($0) * (width + gap), y: chart.minY, width: width, height: chart.height)
        }
    }
}

private func overviewMean(_ values: [Double]) -> Double? {
    values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
}

/// 계정을 칸에 나눠 담는다. maxColumns 안이면 한 계정 한 칸, 넘으면 이웃한 계정을 같은 수씩 묶는다.
/// 묶음 칸의 색은 뜻을 지킨다: 대기 계정이 하나라도 있으면 호박색, 전부 빠졌으면 흐리게, 오류가 있으면 빨간 띠.
func overviewStripSlots(_ columns: [OverviewStripColumn], maxColumns: Int) -> [OverviewStripSlot] {
    guard !columns.isEmpty else { return [] }
    let perSlot = max(1, Int((Double(columns.count) / Double(max(1, maxColumns))).rounded(.up)))
    return stride(from: 0, to: columns.count, by: perSlot).map { start in
        let members = Array(columns[start..<min(columns.count, start + perSlot)])
        let ready = members.filter { $0.tone == .ready }.count
        let wait = members.filter { $0.tone == .wait }.count
        let excludedCount = members.count - ready - wait
        guard members.count > 1 else {
            return OverviewStripSlot(column: members[0], firstIndex: start, memberCount: 1,
                                     readyCount: ready, waitCount: wait, excludedCount: excludedCount)
        }
        let routable = members.filter { !$0.excluded }
        let tone: PanelTone
        if routable.isEmpty {
            tone = members.contains { $0.tone == .error } ? .error : members[0].tone
        } else {
            tone = routable.contains { $0.tone == .wait } ? .wait
                : (routable.contains { $0.tone == .ready } ? .ready : routable[0].tone)
        }
        let cap: PanelTone? = members.contains { $0.cap == .error } ? .error
            : (members.allSatisfy { $0.cap != nil } ? members[0].cap : nil)
        let column = OverviewStripColumn(
            name: members[0].name, label: L10n.stripBucketLabel(members.count), tone: tone,
            weeklyPercent: overviewMean((routable.isEmpty ? members : routable).compactMap(\.weeklyPercent)),
            sessionPercent: nil, fablePercent: nil,
            weeklyElapsed: overviewMean(routable.compactMap(\.weeklyElapsed)),
            excluded: routable.isEmpty, cap: cap)
        return OverviewStripSlot(column: column, firstIndex: start, memberCount: members.count,
                                 readyCount: ready, waitCount: wait, excludedCount: excludedCount)
    }
}

/// "기다리면 풀림" 한 줄. 이름이 다 안 들어가면 앞에서부터 들어가는 만큼 + "외 N개".
/// 이름 하나도 안 들어가면 첫 이름을 줄여서라도 남은 개수는 남긴다.
func overviewWaitingCaption(_ names: [String], font: NSFont, maxWidth: CGFloat) -> String {
    guard !names.isEmpty else { return "" }
    func fits(_ value: String) -> Bool { PanelDraw.width(value, font) <= maxWidth }
    let all = L10n.waitingCaption(names.joined(separator: " · "))
    if fits(all) { return all }
    func caption(_ shown: Int) -> String {
        L10n.waitingCaption(names.prefix(shown).joined(separator: " · ") + " " + L10n.andMore(names.count - shown))
    }
    var best: String?
    for shown in 1..<names.count {
        let candidate = caption(shown)
        guard fits(candidate) else { break }
        best = candidate
    }
    if let best { return best }
    let suffix = names.count > 1 ? " " + L10n.andMore(names.count - 1) : ""
    var first = names[0]
    while !first.isEmpty {
        first.removeLast()
        let candidate = L10n.waitingCaption(first + "…" + suffix)
        if fits(candidate) { return candidate }
    }
    return PanelDraw.clipped(all, font, maxWidth: maxWidth)
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
    /// 마지막으로 그린 띠 칸(이름, 사각형). 누르기와 테스트가 읽는다.
    private(set) var columnRects: [(OverviewStripTarget, NSRect)] = []
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
        if let target = stripClickTarget(at: point) {
            switch target {
            case .account(let name): onOpenAccount?(name)
            case .claudeTab: onSelectTab?(.claude)
            }
            return
        }
        if let row = todoRowRects.first(where: { $0.1.contains(point) }) { onOpenAccount?(row.0); return }
        super.mouseDown(with: event)
    }

    /// 띠 칸 위의 점을 누르면 갈 곳. 칸 밖이면 nil.
    func stripClickTarget(at point: NSPoint) -> OverviewStripTarget? {
        columnRects.first(where: { $0.1.contains(point) })?.0
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

        // 2. Claude 풀 주간 사용률 띠
        if !model.strip.isEmpty {
            drawStrip(x0: x0, width: width)
        }

        // 3. 손볼 것
        if !model.todos.isEmpty || !model.waitingNames.isEmpty {
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
            if model.waitingCaption != nil {
                let y = todoRowRect(model.todos.count).minY + 4
                PanelDraw.dot(x0 + 4, centerY: y + 8, TeamClaudePalette.amber)
                PanelDraw.text(overviewWaitingCaption(model.waitingNames, font: TeamClaudePalette.captionFont, maxWidth: width - 20),
                               x0 + 18, y, TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
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

    private func drawStrip(x0: CGFloat, width: CGFloat) {
        let top = stripTop
        PanelDraw.meta(L10n.stripTitle, x0, top)
        // 범례: 사용 가능 · 대기 · 제외
        var legendX = x0 + width
        for (label, tone) in [(L10n.legendExcluded(model.excludedCount), PanelTone.error),
                              (L10n.legendWait(model.waitCount), PanelTone.wait),
                              (L10n.legendReady(model.readyCount), PanelTone.ready)] {
            legendX = PanelDraw.right(label, legendX, top, TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
            PanelDraw.dot(legendX - 12, centerY: top + 7.5, tone.color)
            legendX -= 24
        }

        let chart = NSRect(x: x0, y: top + 28, width: width, height: 56)
        let slots = overviewStripSlots(model.strip, maxColumns: OverviewStripMetrics.maxColumns(chartWidth: chart.width))
        let rects = OverviewStripMetrics.columnRects(count: slots.count, chart: chart)
        let gap = OverviewStripMetrics.gap
        let bucketed = slots.count < model.strip.count
        for (index, (slot, rect)) in zip(slots, rects).enumerated() {
            let column = slot.column
            columnRects.append((slot.memberCount == 1 ? .account(column.name) : .claudeTab, rect))
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
            let tip: String
            if slot.memberCount > 1 {
                tip = String(format: "%02d–%02d", slot.firstIndex + 1, slot.firstIndex + slot.memberCount) + " · \(column.label)"
                    + " · \(L10n.legendReady(slot.readyCount)) · \(L10n.legendWait(slot.waitCount)) · \(L10n.legendExcluded(slot.excludedCount))"
                    + " · \(L10n.weeklyShort) \(panelPercentText(column.weeklyPercent))"
            } else {
                tip = "\(column.name) · \(column.label) · \(L10n.weeklyShort) \(panelPercentText(column.weeklyPercent))"
                    + " · \(L10n.sessionShort) \(panelPercentText(column.sessionPercent))"
                    + (column.fablePercent.map { " · Fable \(panelPercentText($0))" } ?? "")
            }
            addToolTip(rect, owner: tip as NSString, userData: nil)
            guard !bucketed else { continue }
            let label = String(format: "%02d", index + 1)
            let labelFont = NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular)
            let showLabel = slots.count <= 20 || index == 0 || index == slots.count - 1 || (index + 1) % 5 == 0
            if showLabel {
                let w = PanelDraw.width(label, labelFont)
                PanelDraw.text(label, rect.midX - w / 2, chart.maxY + 6, labelFont, TeamClaudePalette.fg3)
            }
        }
        // 묶은 칸에는 번호 대신 묶음 안내를 그린다(칸마다 몇 개인지는 툴팁이 범위로 보여 준다).
        if bucketed {
            let note = L10n.stripBucketNote(total: model.strip.count, perSlot: slots.map(\.memberCount).max() ?? 1)
            PanelDraw.text(PanelDraw.clipped(note, TeamClaudePalette.legendFont, maxWidth: width), x0, chart.maxY + 5,
                           TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
        }
        if let caption = model.elapsedCaption {
            let y = chart.maxY + 26
            TeamClaudePalette.sky.setFill()
            NSBezierPath(roundedRect: NSRect(x: x0, y: y + 7, width: 16, height: 2), xRadius: 1, yRadius: 1).fill()
            PanelDraw.text(PanelDraw.clipped(caption, TeamClaudePalette.legendFont, maxWidth: width - 24), x0 + 24, y,
                           TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
        }
    }
}
