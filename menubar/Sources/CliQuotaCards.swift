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
        CliFleetTable.height(rows: table?.rows.count ?? 1)
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
        let last: CGFloat, lastEnd: CGFloat, today: CGFloat, todayEnd: CGFloat
    }

    static func columns(width: CGFloat) -> Columns {
        let left: CGFloat = 16, right = width - 16
        let todayEnd = right, today = right - 48
        let lastEnd = today - 10, last = lastEnd - 82
        let machine = left
        let grok = left + 80
        let agy = grok + (last - 12 - grok) / 2 + 4
        return Columns(machine: machine, grok: grok, grokEnd: agy - 14, agy: agy, agyEnd: last - 12,
                       last: last, lastEnd: lastEnd, today: today, todayEnd: todayEnd)
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
        let fg3 = TeamClaudePalette.fg3

        // 1. 한도 기준 한 줄 · 오른쪽에 수집기 경고(또는 "이 맥만").
        var y = CliFleetTable.topInset
        let legend = TeamClaudePalette.legendFont
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

        // 2. 열 머리.
        let meta = TeamClaudePalette.metaFont
        let kern = TeamClaudePalette.metaKern
        PanelDraw.text(L10n.cliColMachine, col.machine, y + 3, meta, fg3, kern: kern)
        PanelDraw.text(L10n.cliColGrok, col.grok, y + 3, meta, fg3, kern: kern)
        PanelDraw.text(L10n.cliColAgy, col.agy, y + 3, meta, fg3, kern: kern)
        PanelDraw.right(L10n.cliColLast, col.lastEnd, y + 3, meta, fg3, kern: kern)
        PanelDraw.right(L10n.cliColToday, col.todayEnd, y + 3, meta, fg3, kern: kern)
        y += CliFleetTable.headHeight
        PanelDraw.hairline(col.machine, col.todayEnd, y - 1)

        // 3. 머신마다 한 줄(두 단).
        for (index, row) in table.rows.enumerated() {
            var line = row
            if index == 0, !table.fromFleet { line = Self.withStaleNotes(row, staleNotes) }
            drawRow(line, y: y, col: col)
            y += CliFleetTable.rowHeight
            if index < table.rows.count - 1 { PanelDraw.hairline(col.machine, col.todayEnd, y - 1) }
        }
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
        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let value = row.dimmed ? fg3 : fg
        let micro = TeamClaudePalette.microFont
        let number = TeamClaudePalette.numberFont
        let small = TeamClaudePalette.smallFont
        let line1 = y + 6, line2 = y + 24

        // 머신: 이름 / 상태 점 + 상태 글자
        let name = TeamClaudePalette.nameFont
        PanelDraw.text(PanelDraw.clipped(row.name, name, maxWidth: col.grok - col.machine - 8), col.machine, line1 - 0.5, name,
                       row.dimmed ? fg2 : fg)
        PanelDraw.dot(col.machine, centerY: line2 + 7, Self.levelColor(row.level), size: 6)
        PanelDraw.text(PanelDraw.clipped(row.statusWord, micro, maxWidth: col.grok - col.machine - 18), col.machine + 11, line2, micro,
                       Self.wordColor(row.level))

        // Grok: 점 · 막대 · 사용 % / 상태 글자 또는 초기화까지
        let grokText = col.grok + 12
        if row.grok.level != .pending || row.grok.word != nil {
            PanelDraw.dot(col.grok, centerY: line1 + 8, Self.levelColor(row.grok.level), size: 6)
        }
        if let usage = row.grok.usagePercent {
            let valueText = "\(panelPercentNumber(usage))%"
            let valueWidth = max(PanelDraw.width("100%", number), PanelDraw.width(valueText, number))
            PanelDraw.meter(NSRect(x: grokText, y: line1 + 5.5, width: max(10, col.grokEnd - grokText - valueWidth - 8), height: 5),
                            percent: usage, elapsed: nil, muted: row.dimmed, thresholdPercent: 100 - CliFleetTable.lowRemainingPercent)
            PanelDraw.right(valueText, col.grokEnd, line1, number, row.grok.level == .warn && !row.dimmed ? TeamClaudePalette.amber : value)
            let second = [row.grok.word, row.grok.reset].compactMap { $0 }.joined(separator: " · ")
            PanelDraw.text(PanelDraw.clipped(second, micro, maxWidth: col.grokEnd - col.grok), col.grok, line2, micro,
                           row.grok.word == nil ? fg3 : Self.wordColor(row.grok.level))
        } else {
            let word = row.grok.word ?? StatusVocabulary.none
            PanelDraw.text(PanelDraw.clipped(word, TeamClaudePalette.captionFont, maxWidth: col.grokEnd - grokText), grokText, line1,
                           TeamClaudePalette.captionFont, row.grok.word == nil ? fg3 : Self.wordColor(row.grok.level))
            if let reset = row.grok.reset {
                PanelDraw.text(PanelDraw.clipped(reset, micro, maxWidth: col.grokEnd - col.grok), col.grok, line2, micro, fg3)
            }
        }

        // agy: 점 · 주간 남음 … 5시간 남음 / 상태 글자 또는 초기화까지
        let agyText = col.agy + 12
        if row.agy.level != .pending || row.agy.word != nil {
            PanelDraw.dot(col.agy, centerY: line1 + 8, Self.levelColor(row.agy.level), size: 6)
        }
        if row.agy.weeklyRemaining != nil || row.agy.fiveHourRemaining != nil {
            func color(_ remaining: Double?) -> NSColor {
                guard let remaining, !row.dimmed else { return value }
                return remaining < CliFleetTable.lowRemainingPercent ? TeamClaudePalette.amber : fg
            }
            let weekly = row.agy.weeklyRemaining.map { L10n.cliWeeklyValue(Int($0)) } ?? L10n.cliWeeklyReset(StatusVocabulary.none)
            let five = row.agy.fiveHourRemaining.map { L10n.cliFiveHourValue(Int($0)) } ?? L10n.cliFiveHourReset(StatusVocabulary.none)
            PanelDraw.text(weekly, agyText, line1, number, color(row.agy.weeklyRemaining))
            PanelDraw.right(five, col.agyEnd, line1, number, color(row.agy.fiveHourRemaining))
            let second = [row.agy.word, row.agy.reset].compactMap { $0 }.joined(separator: " · ")
            PanelDraw.text(PanelDraw.clipped(second, micro, maxWidth: col.agyEnd - col.agy), col.agy, line2, micro,
                           row.agy.word == nil ? fg3 : Self.wordColor(row.agy.level))
        } else {
            let word = row.agy.word ?? StatusVocabulary.none
            PanelDraw.text(PanelDraw.clipped(word, TeamClaudePalette.captionFont, maxWidth: col.agyEnd - agyText), agyText, line1,
                           TeamClaudePalette.captionFont, row.agy.word == nil ? fg3 : Self.wordColor(row.agy.level))
            if let reset = row.agy.reset {
                PanelDraw.text(PanelDraw.clipped(reset, micro, maxWidth: col.agyEnd - col.agy), col.agy, line2, micro, fg3)
            }
        }

        // 마지막 사용 · 오늘: 윗단 Grok, 아랫단 agy. 숫자는 고정폭으로 오른쪽 맞춤.
        for (top, bottom, x, end) in [(row.grokLastUsed, row.agyLastUsed, col.last, col.lastEnd),
                                      (row.grokToday, row.agyToday, col.today, col.todayEnd)] {
            PanelDraw.text("Grok", x, line1 + 0.5, micro, fg3)
            PanelDraw.text("agy", x, line2, micro, fg3)
            let width = end - x - PanelDraw.width("Grok", micro) - 4
            PanelDraw.right(PanelDraw.clipped(top, small, maxWidth: width), end, line1 + 0.5, small, top == StatusVocabulary.none ? fg3 : fg2)
            PanelDraw.right(PanelDraw.clipped(bottom, small, maxWidth: width), end, line2, small, bottom == StatusVocabulary.none ? fg3 : fg2)
        }
    }
}
