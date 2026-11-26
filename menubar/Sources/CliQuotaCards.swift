import Cocoa

/// CLI 탭의 Grok·agy 카드. 머신마다 한 줄인 표다(2026-11-26: "1% 사용·99% 남음"만으로는 부족하다는 지적).
/// 열: 머신 | Grok(상태 점·사용 %·막대·초기화까지) | agy(상태 점·주간·5시간 남음·초기화까지) | 마지막 사용 | 오늘.
/// 본체 수집 파일(~/.claude/cache/fleet-cli.json)이 있으면 머신마다, 없으면 이 맥 한 줄(table 기본값)이다.
/// 행 모델과 상태 판정은 CliFleetTable.swift, 높이는 CliFleetTable.height(rows:)다.
/// 힉스필드는 크레딧·주기·지출까지 실어 정보량이 달라 별도 섹션(HiggsfieldCreditsView)에 그대로 둔다.
final class CliQuotaLanesView: NSView {
    /// 한 줄(이 맥만)일 때의 높이.
    static var fixedHeight: CGFloat { CliFleetTable.height(rows: 1) }

    static func preferredHeight(_ table: CliFleetTable?) -> CGFloat {
        CliFleetTable.height(rows: table?.rows.count ?? 1, hidden: !(table?.hidden.isEmpty ?? true))
    }

    /// 이 맥의 Grok 카드 모델. 미설치 안내(notice)와 접근성 문구가 이 값을 본다.
    var grok = GrokCardModel(headline: L10n.grokChecking, detail: nil) {
        didSet {
            setAccessibilityLabel(accessibilityText)
            needsDisplay = true
        }
    }

    var agy = AgyCardModel(message: L10n.agyChecking, groups: []) {
        didSet {
            setAccessibilityLabel(accessibilityText)
            needsDisplay = true
        }
    }

    /// 그릴 표. 호스트가 CliFleetTable.make로 만든다. nil이면 "확인 중" 한 줄.
    var table: CliFleetTable? {
        didSet {
            guard table != oldValue else { return }
            setAccessibilityLabel(accessibilityText)
            needsDisplay = true
        }
    }

    /// 레인 이름 → 지연 꼬리말. 이 맥 줄에 덧붙인다(값은 그대로 두고 낡았다는 사실만).
    var staleNotes: [String: String] = [:] {
        didSet {
            guard staleNotes != oldValue else { return }
            setAccessibilityLabel(accessibilityText)
            needsDisplay = true
        }
    }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(accessibilityText)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private static let fallbackHost = cliLocalHostName()

    private var shownTable: CliFleetTable {
        table ?? CliFleetTable.make(report: nil, local: CliLocalCliState(host: Self.fallbackHost), now: Date())
    }

    private var accessibilityText: String {
        var grokText = "Grok \(grok.headline)"
        if let detail = grok.detail, !detail.isEmpty { grokText += ", \(detail)" }
        if let note = staleNotes["grok"] { grokText += ", \(note)" }
        var agyText = "agy \(agyLogLine(agy))"
        if let note = staleNotes["agy"] { agyText += ", \(note)" }
        let rows = (table?.rows ?? []).map(Self.rowAccessibility)
        return ([grokText, agyText] + rows).joined(separator: "; ")
    }

    static func rowAccessibility(_ row: CliFleetRow) -> String {
        var grok = "Grok " + (row.grok.word ?? row.grok.usagePercent.map { "\(panelPercentNumber($0))%" } ?? StatusVocabulary.none)
        if let reset = row.grok.reset { grok += " \(reset)" }
        let agyValues = [row.agy.weeklyRemaining.map { L10n.cliWeeklyValue(Int($0)) },
                         row.agy.fiveHourRemaining.map { L10n.cliFiveHourValue(Int($0)) }].compactMap { $0 }
        var agy = "agy " + (row.agy.word ?? (agyValues.isEmpty ? StatusVocabulary.none : agyValues.joined(separator: " ")))
        if let reset = row.agy.reset { agy += " \(reset)" }
        return "\(row.name) \(row.statusWord): \(grok), \(agy), \(L10n.cliColLast) \(row.grokLastUsed)/\(row.agyLastUsed), "
            + "\(L10n.cliColToday) \(row.grokToday)/\(row.agyToday)"
    }

    // MARK: 열 기하(그리기·테스트가 같은 값을 쓴다)

    struct Columns {
        let machine: CGFloat, grok: CGFloat, grokEnd: CGFloat, agy: CGFloat, agyEnd: CGFloat
        /// 마지막 사용·오늘 두 열이 같이 쓰는 도구 이름 칸(윗단 Grok, 아랫단 agy).
        let tool: CGFloat, lastEnd: CGFloat, todayEnd: CGFloat
    }

    static func columns(width: CGFloat) -> Columns {
        let left: CGFloat = 16, right = width - 16
        let todayEnd = right, lastEnd = right - 40
        let tool = lastEnd - 74
        let agyEnd = tool - 12
        let grok = left + 92
        let span = agyEnd - grok - 14
        let grokEnd = grok + span / 2
        return Columns(machine: left, grok: grok, grokEnd: grokEnd, agy: grokEnd + 14, agyEnd: agyEnd,
                       tool: tool, lastEnd: lastEnd, todayEnd: todayEnd)
    }

    static func levelColor(_ level: CliLevel) -> NSColor {
        switch level {
        case .ok: return TeamClaudePalette.mint
        case .pending: return TeamClaudePalette.fg3
        case .warn: return TeamClaudePalette.amber
        case .problem: return TeamClaudePalette.ember
        }
    }

    /// 상태 글자 색. 정상은 2차 글자(점이 민트라 글자까지 칠하지 않는다).
    static func wordColor(_ level: CliLevel) -> NSColor {
        level == .ok ? TeamClaudePalette.fg2 : levelColor(level)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard bounds.width > 0 else { return }
        if let notice = grok.notice { ToolNoticeDrawLog.record("grok", notice) }
        if let notice = agy.notice { ToolNoticeDrawLog.record("agy", notice) }
        let table = shownTable
        let col = Self.columns(width: bounds.width)
        var y = drawHead(table, col: col)
        // 3. 머신마다 한 줄(두 단).
        for (index, row) in table.rows.enumerated() {
            var line = row
            if index == 0, !table.fromFleet { line = Self.withStaleNotes(row, staleNotes) }
            drawRow(line, y: y, col: col)
            y += CliFleetTable.rowHeight
            if index < table.rows.count - 1 { PanelDraw.hairline(col.machine, col.todayEnd, y - 1) }
        }
        // 4. 표시 상한 밖 머신은 한 줄로 센다(잘린 쪽의 주의·문제 수 포함).
        if let note = table.hiddenNote {
            PanelDraw.hairline(col.machine, col.todayEnd, y - 1)
            PanelDraw.dot(col.machine, centerY: y + 11, Self.levelColor(table.hiddenLevel == .ok ? .pending : table.hiddenLevel), size: 6)
            PanelDraw.text(note, col.machine + 11, y + 4, TeamClaudePalette.legendFont, Self.wordColor(table.hiddenLevel))
        }
    }

    /// 1. 한도 기준 한 줄 · 오른쪽에 수집기 경고(또는 "이 맥만"). 2. 열 머리. 다음 줄의 y를 돌려준다.
    private func drawHead(_ table: CliFleetTable, col: Columns) -> CGFloat {
        let fg3 = TeamClaudePalette.fg3, legend = TeamClaudePalette.legendFont
        var y = CliFleetTable.topInset
        var rightText: (String, NSColor, CliLevel?)?
        if let note = table.collectorNote {
            rightText = (note, Self.wordColor(table.collectorLevel), table.collectorLevel)
        } else if !table.fromFleet {
            rightText = (L10n.cliThisMacOnly, fg3, nil)
        }
        var noteMax = col.todayEnd - col.machine
        if let (text, color, level) = rightText {
            let w = PanelDraw.width(text, legend)
            PanelDraw.right(text, col.todayEnd, y + 2, legend, color)
            if let level { PanelDraw.dot(col.todayEnd - w - 12, centerY: y + 9.5, Self.levelColor(level)) }
            noteMax -= w + 24
        }
        PanelDraw.text(PanelDraw.clipped(Self.limitNoteText, legend, maxWidth: noteMax), col.machine, y + 2, legend, fg3)
        y += CliFleetTable.noteHeight
        let meta = TeamClaudePalette.metaFont, kern = TeamClaudePalette.metaKern
        PanelDraw.text(L10n.cliColMachine, col.machine, y + 3, meta, fg3, kern: kern)
        PanelDraw.text(L10n.cliColGrok, col.grok, y + 3, meta, fg3, kern: kern)
        PanelDraw.text(L10n.cliColAgy, col.agy, y + 3, meta, fg3, kern: kern)
        PanelDraw.right(L10n.cliColLast, col.lastEnd, y + 3, meta, fg3, kern: kern) // 도구 이름 칸 위는 비운다
        PanelDraw.right(L10n.cliColToday, col.todayEnd, y + 3, meta, fg3, kern: kern)
        y += CliFleetTable.headHeight
        PanelDraw.hairline(col.machine, col.todayEnd, y - 1)
        return y
    }

    static var limitNoteText: String { CliFleetTable.limitNote }

    /// 이 맥 줄: 갱신이 실패해 앞선 값을 보이는 중이면 상태 글자에 그 사실을 붙인다.
    /// 한 번도 성공하지 못해 값이 없는 줄("확인 중")에도 붙인다 — 예전 카드가 조기 반환으로 꼬리말을 빠뜨리던 자리다.
    static func withStaleNotes(_ row: CliFleetRow, _ notes: [String: String]) -> CliFleetRow {
        var out = row
        if let note = notes["grok"] {
            out.grok.word = out.grok.word.map { "\($0) · \(note)" } ?? note
            out.grok.level = max(out.grok.level, .warn)
        }
        if let note = notes["agy"] {
            out.agy.word = out.agy.word.map { "\($0) · \(note)" } ?? note
            out.agy.level = max(out.agy.level, .warn)
        }
        let level = max(out.level, out.grok.level, out.agy.level)
        if level != out.level { out.level = level; out.statusWord = CliFleetTable.levelWord(level) }
        return out
    }

    private func drawRow(_ row: CliFleetRow, y: CGFloat, col: Columns) {
        let line1 = y + 6, line2 = y + 24
        drawMachineCell(row, line1: line1, line2: line2, col: col)
        drawGrokCell(row, line1: line1, line2: line2, col: col)
        drawAgyCell(row, line1: line1, line2: line2, col: col)
        drawActivityCells(row, line1: line1, line2: line2, col: col)
    }

    /// 머신: 이름 / 상태 점 + 상태 글자.
    private func drawMachineCell(_ row: CliFleetRow, line1: CGFloat, line2: CGFloat, col: Columns) {
        let name = TeamClaudePalette.nameFont, micro = TeamClaudePalette.microFont
        PanelDraw.text(PanelDraw.clipped(row.name, name, maxWidth: col.grok - col.machine - 8), col.machine, line1 - 0.5, name,
                       row.dimmed ? TeamClaudePalette.fg2 : TeamClaudePalette.fg)
        PanelDraw.dot(col.machine, centerY: line2 + 7, Self.levelColor(row.level), size: 6)
        PanelDraw.text(PanelDraw.clipped(row.statusWord, micro, maxWidth: col.grok - col.machine - 18), col.machine + 11, line2, micro,
                       Self.wordColor(row.level))
    }

    /// 값이 없는 칸: 윗단에 상태 글자(없으면 —), 아랫단에 초기화 문구.
    private func drawWordCell(word: String?, level: CliLevel, reset: String?, x: CGFloat, end: CGFloat, line1: CGFloat, line2: CGFloat) {
        let caption = TeamClaudePalette.captionFont, micro = TeamClaudePalette.microFont
        PanelDraw.text(PanelDraw.clipped(word ?? StatusVocabulary.none, caption, maxWidth: end - x - 12), x + 12, line1, caption,
                       word == nil ? TeamClaudePalette.fg3 : Self.wordColor(level))
        if let reset { PanelDraw.text(PanelDraw.clipped(reset, micro, maxWidth: end - x), x, line2, micro, TeamClaudePalette.fg3) }
    }

    /// 값이 있는 칸의 아랫단: 상태 글자 · 초기화 문구.
    private func drawSecondLine(word: String?, level: CliLevel, reset: String?, x: CGFloat, end: CGFloat, line2: CGFloat) {
        let micro = TeamClaudePalette.microFont
        let text = [word, reset].compactMap { $0 }.joined(separator: " · ")
        PanelDraw.text(PanelDraw.clipped(text, micro, maxWidth: end - x), x, line2, micro, word == nil ? TeamClaudePalette.fg3 : Self.wordColor(level))
    }

    /// Grok: 점 · 막대 · 사용 % / 상태 글자 또는 초기화까지.
    private func drawGrokCell(_ row: CliFleetRow, line1: CGFloat, line2: CGFloat, col: Columns) {
        let cell = row.grok
        if cell.level != .pending || cell.word != nil { PanelDraw.dot(col.grok, centerY: line1 + 8, Self.levelColor(cell.level), size: 6) }
        guard let usage = cell.usagePercent else {
            drawWordCell(word: cell.word, level: cell.level, reset: cell.reset, x: col.grok, end: col.grokEnd, line1: line1, line2: line2)
            return
        }
        let number = TeamClaudePalette.numberFont
        let valueText = "\(panelPercentNumber(usage))%"
        let valueWidth = max(PanelDraw.width("100%", number), PanelDraw.width(valueText, number))
        let barX = col.grok + 12
        PanelDraw.meter(NSRect(x: barX, y: line1 + 5.5, width: max(10, col.grokEnd - barX - valueWidth - 8), height: 5),
                        percent: usage, elapsed: nil, muted: row.dimmed, thresholdPercent: 100 - CliFleetTable.lowRemainingPercent)
        let color = row.dimmed ? TeamClaudePalette.fg3 : cell.level == .warn ? TeamClaudePalette.amber : TeamClaudePalette.fg
        PanelDraw.right(valueText, col.grokEnd, line1, number, color)
        drawSecondLine(word: cell.word, level: cell.level, reset: cell.reset, x: col.grok, end: col.grokEnd, line2: line2)
    }

    /// agy: 점 · 주간 남음 … 5시간 남음 / 상태 글자 또는 초기화까지.
    private func drawAgyCell(_ row: CliFleetRow, line1: CGFloat, line2: CGFloat, col: Columns) {
        let cell = row.agy
        if cell.level != .pending || cell.word != nil { PanelDraw.dot(col.agy, centerY: line1 + 8, Self.levelColor(cell.level), size: 6) }
        guard cell.weeklyRemaining != nil || cell.fiveHourRemaining != nil else {
            drawWordCell(word: cell.word, level: cell.level, reset: cell.reset, x: col.agy, end: col.agyEnd, line1: line1, line2: line2)
            return
        }
        func color(_ remaining: Double?) -> NSColor {
            guard let remaining, !row.dimmed else { return row.dimmed ? TeamClaudePalette.fg3 : TeamClaudePalette.fg }
            return remaining < CliFleetTable.lowRemainingPercent ? TeamClaudePalette.amber : TeamClaudePalette.fg
        }
        let number = TeamClaudePalette.numberFont
        let weekly = cell.weeklyRemaining.map { L10n.cliWeeklyValue(Int($0)) } ?? L10n.cliWeeklyReset(StatusVocabulary.none)
        let five = cell.fiveHourRemaining.map { L10n.cliFiveHourValue(Int($0)) } ?? L10n.cliFiveHourReset(StatusVocabulary.none)
        PanelDraw.text(weekly, col.agy + 12, line1, number, color(cell.weeklyRemaining))
        PanelDraw.right(five, col.agyEnd, line1, number, color(cell.fiveHourRemaining))
        drawSecondLine(word: cell.word, level: cell.level, reset: cell.reset, x: col.agy, end: col.agyEnd, line2: line2)
    }

    /// 마지막 사용 · 오늘: 윗단 Grok, 아랫단 agy. 도구 이름은 한 번만, 숫자는 고정폭으로 오른쪽 맞춤.
    private func drawActivityCells(_ row: CliFleetRow, line1: CGFloat, line2: CGFloat, col: Columns) {
        let micro = TeamClaudePalette.microFont, small = TeamClaudePalette.smallFont
        let fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        PanelDraw.text("Grok", col.tool, line1 + 0.5, micro, fg3)
        PanelDraw.text("agy", col.tool, line2, micro, fg3)
        let lastWidth = col.lastEnd - col.tool - PanelDraw.width("Grok", micro) - 4
        let todayWidth = col.todayEnd - col.lastEnd - 6
        for (top, bottom, end, width) in [(row.grokLastUsed, row.agyLastUsed, col.lastEnd, lastWidth),
                                          (row.grokToday, row.agyToday, col.todayEnd, todayWidth)] {
            PanelDraw.right(PanelDraw.clipped(top, small, maxWidth: width), end, line1 + 0.5, small, top == StatusVocabulary.none ? fg3 : fg2)
            PanelDraw.right(PanelDraw.clipped(bottom, small, maxWidth: width), end, line2, small, bottom == StatusVocabulary.none ? fg3 : fg2)
        }
    }
}
