import Cocoa

// 모델 탭 본문(menubar/DESIGN.md "모델 탭", 웹랩 시안 b안 2차본).
// 위에서부터: 기간·지표 고르기 → 레인별 큰 숫자 두 칸 → 기록 공백 경고 → 출처별 → 날짜별 → 모델별 → 계정 풀 주간 사용률
// → Claude 5시간 주기 소진 이력 → Codex 용량 현황 → 수집 시각. 값은 ModelUsage.swift가 계산하고 여기서는 그리기만 한다.
// 높이는 layout(순수 함수)이 정하고 draw·mouseDown·preferredHeight가 같은 값을 쓴다. main.swift 없이 컴파일된다.

struct ModelUsageLayout {
    var controls = NSRect.zero
    var hero = NSRect.zero
    var laneNote = NSRect.zero
    var gap: NSRect?
    var sourcesHeader = NSRect.zero
    var sources = NSRect.zero
    var dailyHeader = NSRect.zero
    var claudeChart = NSRect.zero
    var codexChart = NSRect.zero
    var hatchLegend = NSRect.zero
    var modelsHeader = NSRect.zero
    var models = NSRect.zero
    var poolsHeader = NSRect.zero
    var claudePool = NSRect.zero
    var codexPool = NSRect.zero
    var cyclesHeader = NSRect.zero
    var cycles = NSRect.zero
    var facts = NSRect.zero
    var collected = NSRect.zero
    var height: CGFloat = 0

    static let inset: CGFloat = 16
    static let blockGap: CGFloat = 18
    static let headerHeight: CGFloat = 22
    static let sourceRowHeight: CGFloat = 50
    static let modelRowHeight: CGFloat = 28
    static let maxModelRows = 6
    static let chartLegendHeight: CGFloat = 20
    static let chartHeight: CGFloat = 84
    static let poolRowHeight: CGFloat = 18

    static func wrappedHeight(_ text: String, _ font: NSFont, width: CGFloat) -> CGFloat {
        guard !text.isEmpty, width > 0 else { return 0 }
        let bounds = (text as NSString).boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude),
                                                     options: [.usesLineFragmentOrigin], attributes: [.font: font])
        return ceil(bounds.height)
    }

    static func poolHeight(_ pool: ModelUsagePoolPresentation) -> CGFloat {
        guard pool.available, !pool.accounts.isEmpty else { return 20 + poolRowHeight }
        return 20 + CGFloat((pool.accounts.count + 1) / 2) * poolRowHeight
    }

    static func make(_ p: ModelUsagePresentation, width: CGFloat) -> ModelUsageLayout {
        var l = ModelUsageLayout()
        let inner = width - inset * 2
        var y: CGFloat = 4
        func block(_ height: CGFloat) -> NSRect {
            let rect = NSRect(x: inset, y: y, width: inner, height: height)
            y += height
            return rect
        }
        l.controls = block(28); y += 12
        l.hero = block(84); y += 6
        l.laneNote = block(wrappedHeight(L10n.modelLaneNote, TeamClaudePalette.legendFont, width: inner))
        if let note = p.gapNote {
            y += 10
            l.gap = block(wrappedHeight(note, TeamClaudePalette.captionFont, width: inner - 30) + 16)
        }
        y += blockGap
        l.sourcesHeader = block(headerHeight)
        l.sources = block(sourceRowHeight * CGFloat(p.sources.count)); y += blockGap
        l.dailyHeader = block(headerHeight)
        l.claudeChart = block(chartLegendHeight + chartHeight); y += 10
        l.codexChart = block(chartLegendHeight + chartHeight)
        l.hatchLegend = block(18); y += blockGap
        l.modelsHeader = block(headerHeight)
        let rows = min(p.models.count, maxModelRows)
        l.models = block(rows == 0 ? 36 : CGFloat(rows) * modelRowHeight + (p.models.count > maxModelRows ? 22 : 0)); y += blockGap
        l.poolsHeader = block(headerHeight)
        l.claudePool = block(poolHeight(p.claudePool)); y += 8
        l.codexPool = block(poolHeight(p.codexPool)); y += blockGap
        l.cyclesHeader = block(headerHeight)
        l.cycles = block(20 + chartHeight + 18); y += blockGap
        l.facts = block(78); y += 10
        l.collected = block(18)
        l.height = y + 8
        return l
    }
}

final class ModelUsageTabView: NSView {
    static let emptyHeight: CGFloat = 132

    var report: ModelUsageReport? { didSet { recompute() } }
    var selection = ModelUsageSelection() { didSet { if oldValue != selection { recompute() } } }
    /// 기간·지표를 바꾸면 부른다. 소유자가 고른 값을 기억하고 탭 문서 높이를 다시 잡는다.
    var onSelectionChange: ((ModelUsageSelection) -> Void)?
    var now = Date()

    private(set) var presentation: ModelUsagePresentation?
    private var rangeRects: [(ModelUsageRange, NSRect)] = []
    private var metricRects: [(ModelUsageMetric, NSRect)] = []
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    static func preferredHeight(_ report: ModelUsageReport?, selection: ModelUsageSelection, width: CGFloat = 520) -> CGFloat {
        guard let report else { return emptyHeight }
        return ModelUsageLayout.make(makeModelUsagePresentation(report, selection), width: width).height
    }

    /// 섹션 머리·하단 막대의 한 줄 요약. 머리와 같은 값을 쓴다.
    static func summary(_ report: ModelUsageReport?, selection: ModelUsageSelection) -> String {
        guard let report else { return L10n.modelEmptyTitle }
        let p = makeModelUsagePresentation(report, selection)
        let claude = "\(modelUsageCount(p.claudeValue)) \(metricUnit(selection.metric))"
        return L10n.modelSectionSummary(rangeLabel(selection.range), claude, p.codexPro.map { proText($0.mid) })
    }

    static func rangeLabel(_ range: ModelUsageRange) -> String {
        switch range {
        case .week: return L10n.modelRangeWeek
        case .fortnight: return L10n.modelRangeFortnight
        case .all: return L10n.modelRangeAll
        }
    }

    static func metricLabel(_ metric: ModelUsageMetric) -> String {
        switch metric {
        case .calls: return L10n.modelMetricCalls
        case .output: return L10n.modelMetricOutput
        case .total: return L10n.modelMetricTotal
        }
    }

    static func metricUnit(_ metric: ModelUsageMetric) -> String { metric == .calls ? L10n.modelUnitCalls : L10n.modelUnitTokens }

    /// Pro 환산 값: 10 미만은 소수 한 자리.
    static func proText(_ value: Double) -> String { value < 10 ? String(format: "%.1f", value) : String(Int(value.rounded())) }

    private func recompute() {
        presentation = report.map { makeModelUsagePresentation($0, selection, now: now) }
        setAccessibilityLabel("\(L10n.sectionModel), \(Self.summary(report, selection: selection))")
        needsDisplay = true
    }

    // MARK: 입력

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let hit = rangeRects.first(where: { $0.1.contains(point) }) {
            select(ModelUsageSelection(range: hit.0, metric: selection.metric)); return
        }
        if let hit = metricRects.first(where: { $0.1.contains(point) }) {
            select(ModelUsageSelection(range: selection.range, metric: hit.0)); return
        }
        super.mouseDown(with: event)
    }

    /// 고르기(클릭과 같은 경로). 스냅샷·테스트도 이 함수를 쓴다.
    func select(_ next: ModelUsageSelection) {
        guard next != selection else { return }
        selection = next
        onSelectionChange?(next)
    }

    // MARK: 그리기

    override func draw(_ dirtyRect: NSRect) {
        guard let p = presentation, let report else { drawEmpty(); return }
        let l = ModelUsageLayout.make(p, width: bounds.width)
        drawControls(l.controls)
        drawHero(p, l.hero)
        drawWrapped(L10n.modelLaneNote, l.laneNote, TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
        if let gap = l.gap, let note = p.gapNote { drawGap(note, gap) }
        let weeks = p.weeks
        drawHeader(L10n.modelSourcesTitle, L10n.modelSourcesHint(weeks.first?.label ?? "", weeks.last?.label ?? ""), l.sourcesHeader)
        drawSources(p, l.sources)
        drawHeader(L10n.modelDailyTitle, "\(modelUsageMonthDay(p.period.from))–\(modelUsageMonthDay(p.period.to))", l.dailyHeader)
        drawClaudeChart(p, report, l.claudeChart)
        drawCodexChart(p, l.codexChart)
        drawHatchLegend(l.hatchLegend)
        let compareDays = p.period.prev?.complete == true ? p.period.days : nil
        drawHeader("\(L10n.modelModelsTitle) \(p.models.count)", L10n.modelModelsHint(compareDays: compareDays), l.modelsHeader)
        drawModels(p, report, l.models, compared: compareDays != nil)
        drawHeader(L10n.modelPoolsTitle, L10n.modelPoolsHint, l.poolsHeader)
        drawPool("TeamClaude", p.claudePool, l.claudePool)
        drawPool("TeamCodex", p.codexPool, l.codexPool)
        drawHeader(L10n.modelCyclesTitle, "\(modelUsageMonthDay(p.period.from))–\(modelUsageMonthDay(p.period.to))", l.cyclesHeader)
        drawCycles(p, l.cycles)
        drawFacts(p, l.facts)
        let stamp = report.generatedAt.map { modelUsageStampFormatter.string(from: $0) } ?? report.today
        PanelDraw.text(L10n.modelCollectedAt(stamp), l.collected.minX, l.collected.minY, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
    }

    private func drawEmpty() {
        let badge = NSRect(x: 16, y: 18, width: 32, height: 32)
        PanelDraw.fillRound(badge, TeamClaudePalette.overlay, 8)
        PanelDraw.dot(badge.midX - 3.5, centerY: badge.midY, TeamClaudePalette.sky)
        PanelDraw.text(L10n.modelEmptyTitle, 16, 62, NSFont.systemFont(ofSize: 15, weight: .semibold), TeamClaudePalette.fg)
        drawWrapped(L10n.modelEmptyDetail, NSRect(x: 16, y: 86, width: bounds.width - 32, height: 40), TeamClaudePalette.bodyFont, TeamClaudePalette.fg2)
    }

    private func drawWrapped(_ text: String, _ rect: NSRect, _ font: NSFont, _ color: NSColor) {
        (text as NSString).draw(with: rect, options: [.usesLineFragmentOrigin], attributes: PanelDraw.attrs(font, color), context: nil)
    }

    private func drawHeader(_ title: String, _ hint: String, _ rect: NSRect) {
        let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let w = PanelDraw.text(title, rect.minX, rect.minY + 2, titleFont, TeamClaudePalette.fg)
        let room = rect.width - w - 16
        PanelDraw.right(PanelDraw.clipped(hint, TeamClaudePalette.microFont, maxWidth: room), rect.maxX, rect.minY + 4,
                        TeamClaudePalette.microFont, TeamClaudePalette.fg3)
    }

    private func segmentWidth(_ text: String) -> CGFloat { ceil(PanelDraw.width(text, TeamClaudePalette.buttonFont)) + 22 }

    private func drawSegmented<T>(_ items: [(T, String)], selected: Int, x: CGFloat, rect: NSRect) -> [(T, NSRect)] {
        let total = items.reduce(CGFloat(6)) { $0 + segmentWidth($1.1) }
        let outer = NSRect(x: x, y: rect.minY, width: total, height: rect.height)
        PanelDraw.fillRound(outer, NSColor.white.withAlphaComponent(0.03), 8)
        PanelDraw.strokeRound(outer, TeamClaudePalette.line, 8)
        var cursor = outer.minX + 3
        var out: [(T, NSRect)] = []
        for (index, item) in items.enumerated() {
            let w = segmentWidth(item.1)
            let seg = NSRect(x: cursor, y: outer.minY + 3, width: w, height: outer.height - 6)
            if index == selected {
                PanelDraw.fillRound(seg, TeamClaudePalette.overlay, 6)
                PanelDraw.strokeRound(seg, TeamClaudePalette.lineStrong, 6)
            }
            let color = index == selected ? TeamClaudePalette.fg : TeamClaudePalette.fg2
            PanelDraw.text(item.1, seg.midX - PanelDraw.width(item.1, TeamClaudePalette.buttonFont) / 2, seg.minY + 3.5,
                           TeamClaudePalette.buttonFont, color)
            out.append((item.0, seg))
            cursor += w
        }
        return out
    }

    private func drawControls(_ rect: NSRect) {
        let ranges = ModelUsageRange.allCases.map { ($0, Self.rangeLabel($0)) }
        rangeRects = drawSegmented(ranges, selected: selection.range.rawValue, x: rect.minX, rect: rect)
        let next = (rangeRects.last?.1.maxX ?? rect.minX) + 3 + 10
        let metrics = ModelUsageMetric.allCases.map { ($0, Self.metricLabel($0)) }
        metricRects = drawSegmented(metrics, selected: selection.metric.rawValue, x: next, rect: rect)
    }

    @discardableResult
    private func drawBadge(_ text: String, _ x: CGFloat, centerY: CGFloat) -> CGFloat {
        let font = TeamClaudePalette.microFont
        let w = ceil(PanelDraw.width(text, font)) + 10
        let rect = NSRect(x: x, y: centerY - 8, width: w, height: 16)
        PanelDraw.fillRound(rect, TeamClaudePalette.overlay, 5)
        PanelDraw.strokeRound(rect, TeamClaudePalette.line, 5)
        PanelDraw.text(text, rect.minX + 5, rect.minY + 1.5, font, TeamClaudePalette.fg2)
        return w
    }

    private func drawHero(_ p: ModelUsagePresentation, _ rect: NSRect) {
        PanelDraw.card(rect)
        let half = rect.width / 2
        TeamClaudePalette.line.setFill()
        NSRect(x: rect.minX + half, y: rect.minY + 12, width: 1, height: rect.height - 24).fill()
        let bigFont = NSFont.monospacedDigitSystemFont(ofSize: 30, weight: .semibold)
        let unitFont = TeamClaudePalette.captionFont
        // Claude
        var x = rect.minX + 14
        PanelDraw.dot(x, centerY: rect.minY + 19, TeamClaudePalette.series[0])
        PanelDraw.meta("Claude · \(Self.metricLabel(p.selection.metric))", x + 12, rect.minY + 12)
        let w = PanelDraw.text(modelUsageCount(p.claudeValue), x, rect.minY + 28, bigFont, TeamClaudePalette.fg)
        PanelDraw.text(Self.metricUnit(p.selection.metric), x + w + 6, rect.minY + 44, unitFont, TeamClaudePalette.fg2)
        let claudeLine: String
        if let delta = p.claudeDelta {
            claudeLine = L10n.modelVsPrevious(p.period.days, delta)
        } else if p.claudePrevIncomplete {
            claudeLine = L10n.modelPrevIncomplete
        } else if p.period.prev != nil {
            claudeLine = L10n.modelPrevZero
        } else {
            claudeLine = "\(modelUsageMonthDay(p.period.from))–\(modelUsageMonthDay(p.period.to))"
        }
        PanelDraw.text(PanelDraw.clipped(claudeLine, TeamClaudePalette.microFont, maxWidth: half - 28), x, rect.minY + 64,
                       TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        // Codex
        x = rect.minX + half + 14
        PanelDraw.dot(x, centerY: rect.minY + 19, TeamClaudePalette.series[1])
        let metaW = PanelDraw.meta(L10n.modelCodexMeta, x + 12, rect.minY + 12)
        drawBadge(L10n.modelBadgeEstimate, x + 12 + metaW + 6, centerY: rect.minY + 19)
        if let pro = p.codexPro {
            let bw = PanelDraw.text(Self.proText(pro.mid), x, rect.minY + 28, bigFont, TeamClaudePalette.fg)
            let uw = PanelDraw.text(L10n.modelCodexUnit, x + bw + 6, rect.minY + 44, unitFont, TeamClaudePalette.fg2)
            if p.codexLowerBound { drawBadge(L10n.modelBadgeLowerBound, x + bw + 6 + uw + 6, centerY: rect.minY + 52) }
            let line = L10n.modelCodexRange(Self.proText(pro.lo), Self.proText(pro.hi), modelUsageCount(p.codexNoncache))
            PanelDraw.text(PanelDraw.clipped(line, TeamClaudePalette.microFont, maxWidth: half - 28), x, rect.minY + 64,
                           TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        } else {
            PanelDraw.text(StatusVocabulary.none, x, rect.minY + 28, bigFont, TeamClaudePalette.fg3)
            PanelDraw.text(PanelDraw.clipped(L10n.modelCodexNoBaseline, TeamClaudePalette.microFont, maxWidth: half - 28), x, rect.minY + 64,
                           TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        }
    }

    private func drawGap(_ note: String, _ rect: NSRect) {
        PanelDraw.strokeRound(rect, TeamClaudePalette.line, 8)
        PanelDraw.dot(rect.minX + 11, centerY: rect.minY + 15, TeamClaudePalette.amber)
        drawWrapped(note, NSRect(x: rect.minX + 26, y: rect.minY + 7, width: rect.width - 30, height: rect.height - 10),
                    TeamClaudePalette.captionFont, TeamClaudePalette.fg2)
    }

    // MARK: 출처별

    static func sourceLabel(_ key: ModelUsageSourceKey) -> String {
        switch key {
        case .claudeCode: return L10n.modelSourceClaudeCode
        case .codexCli: return L10n.modelSourceCodexCli
        case .codexReview: return L10n.modelSourceReview
        case .codexImpl: return L10n.modelSourceImpl
        case .hermes: return L10n.modelSourceHermes
        }
    }

    private static func sourceUnit(_ key: ModelUsageSourceKey) -> String {
        switch key {
        case .claudeCode, .codexCli: return L10n.modelUnitResponse
        case .codexReview: return L10n.modelUnitRun
        case .codexImpl: return L10n.modelUnitNoTokens
        case .hermes: return L10n.modelUnitCall
        }
    }

    private static func sourceColor(_ key: ModelUsageSourceKey) -> NSColor {
        switch key {
        case .claudeCode: return TeamClaudePalette.series[0]
        case .codexCli, .codexReview, .codexImpl: return TeamClaudePalette.series[1]
        case .hermes: return TeamClaudePalette.fg2
        }
    }

    private func drawSources(_ p: ModelUsagePresentation, _ rect: NSRect) {
        PanelDraw.card(rect)
        let right = rect.maxX - 12
        for (index, line) in p.sources.enumerated() {
            let y = rect.minY + CGFloat(index) * ModelUsageLayout.sourceRowHeight
            if index > 0 { PanelDraw.hairline(rect.minX + 1, rect.maxX - 1, y) }
            PanelDraw.dot(rect.minX + 12, centerY: y + 16, Self.sourceColor(line.key))
            let lw = PanelDraw.text(Self.sourceLabel(line.key), rect.minX + 26, y + 8, TeamClaudePalette.bodyFont, TeamClaudePalette.fg)
            drawBadge(Self.sourceUnit(line.key), rect.minX + 26 + lw + 6, centerY: y + 16)
            let delta: String
            switch line.prevState {
            case .none: delta = ""
            case .notRecorded: delta = L10n.modelNotRecorded
            case .compared(let value): delta = value ?? StatusVocabulary.none
            }
            if !delta.isEmpty {
                PanelDraw.right(delta, right, y + 9, TeamClaudePalette.smallFont, delta.hasPrefix("+") ? TeamClaudePalette.fg : TeamClaudePalette.fg3)
            }
            let suffix = line.key == .codexReview || line.key == .codexImpl ? L10n.modelCountSuffixRuns : L10n.modelCountSuffixEvents
            let countRight = right - (p.period.prev == nil ? 0 : 56)
            var cx = countRight
            if !suffix.isEmpty { cx = PanelDraw.right(suffix, countRight, y + 9, TeamClaudePalette.microFont, TeamClaudePalette.fg3) - 2 }
            PanelDraw.right(modelUsageCount(line.count), cx, y + 8, TeamClaudePalette.numberFont, TeamClaudePalette.fg)
            // 주별 막대(자기 눈금)
            let barsWidth: CGFloat = CGFloat(line.weekly.count) * 13 - 3
            let bars = NSRect(x: right - barsWidth, y: y + 28, width: barsWidth, height: 14)
            drawWeekly(line.weekly, weeks: p.weeks, color: Self.sourceColor(line.key), rect: bars)
            PanelDraw.text(PanelDraw.clipped(line.note, TeamClaudePalette.microFont, maxWidth: bars.minX - rect.minX - 36), rect.minX + 26, y + 29,
                           TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        }
    }

    private func drawWeekly(_ values: [Double], weeks: [ModelUsageWeek], color: NSColor, rect: NSRect) {
        let peak = values.max() ?? 0
        for (i, value) in values.enumerated() {
            let x = rect.minX + CGFloat(i) * 13
            PanelDraw.hairline(x, x + 10, rect.maxY - 1, color: TeamClaudePalette.track)
            guard peak > 0, value > 0 else { continue }
            let h = max(2, rect.height * CGFloat(value / peak))
            let partial = i < weeks.count && weeks[i].partial
            PanelDraw.fillRound(NSRect(x: x, y: rect.maxY - h, width: 10, height: h), color.withAlphaComponent(partial ? 0.45 : 0.9), 1.5)
        }
    }

    // MARK: 날짜별

    private func modelColor(_ key: Int) -> NSColor { key < TeamClaudePalette.series.count ? TeamClaudePalette.series[key] : TeamClaudePalette.seriesOther }

    private func codexPartColor(_ key: Int) -> NSColor { TeamClaudePalette.series[1].withAlphaComponent([1, 0.62, 0.34][min(key, 2)]) }

    private func drawLegend(_ text: String, color: NSColor, peak: Double, rect: NSRect) {
        PanelDraw.fillRound(NSRect(x: rect.minX, y: rect.minY + 4, width: 8, height: 8), color, 1.5)
        PanelDraw.text(PanelDraw.clipped(text, TeamClaudePalette.legendFont, maxWidth: rect.width - 80), rect.minX + 14, rect.minY,
                       TeamClaudePalette.legendFont, TeamClaudePalette.fg2)
        if peak > 0 { PanelDraw.right(modelUsageCount(peak), rect.maxX, rect.minY + 1, TeamClaudePalette.smallFont, TeamClaudePalette.fg3) }
    }

    private func drawClaudeChart(_ p: ModelUsagePresentation, _ report: ModelUsageReport, _ rect: NSRect) {
        let peak = p.claudeDays.map(\.total).max() ?? 0
        let legend = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: ModelUsageLayout.chartLegendHeight)
        drawLegend(L10n.modelClaudeChart(Self.metricLabel(p.selection.metric)), color: TeamClaudePalette.series[0], peak: peak, rect: legend)
        drawStacked(p.claudeDays, peak: peak, color: modelColor, rect: NSRect(x: rect.minX, y: legend.maxY, width: rect.width, height: ModelUsageLayout.chartHeight))
    }

    private func drawCodexChart(_ p: ModelUsagePresentation, _ rect: NSRect) {
        let peak = p.codexDays.map(\.total).max() ?? 0
        let legend = NSRect(x: rect.minX, y: rect.minY, width: rect.width, height: ModelUsageLayout.chartLegendHeight)
        drawLegend(L10n.modelCodexChart, color: TeamClaudePalette.series[1], peak: peak, rect: legend)
        drawStacked(p.codexDays, peak: peak, color: codexPartColor, rect: NSRect(x: rect.minX, y: legend.maxY, width: rect.width, height: ModelUsageLayout.chartHeight))
    }

    private func barSlots(_ count: Int, _ rect: NSRect) -> (width: CGFloat, step: CGFloat) {
        guard count > 0 else { return (0, 0) }
        let gap: CGFloat = count > 30 ? 1 : 3
        let width = max(1, (rect.width - gap * CGFloat(count - 1)) / CGFloat(count))
        return (width, width + gap)
    }

    private func drawHatch(_ rect: NSRect, color: NSColor) {
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: rect).addClip()
        color.setStroke()
        let path = NSBezierPath()
        path.lineWidth = 1
        var x = rect.minX - rect.height
        while x < rect.maxX {
            path.move(to: NSPoint(x: x, y: rect.maxY))
            path.line(to: NSPoint(x: x + rect.height, y: rect.minY))
            x += 4
        }
        path.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }

    /// 날짜별 쌓은 막대. 아래 14pt는 날짜 글자. 빗금 날은 바탕 열에 옅은 빗금, 막대 위에 진한 빗금.
    private func drawStacked(_ days: [ModelUsageDayBar], peak: Double, color: (Int) -> NSColor, rect: NSRect) {
        let area = NSRect(x: rect.minX, y: rect.minY + 2, width: rect.width, height: rect.height - 18)
        PanelDraw.hairline(area.minX, area.maxX, area.maxY, color: TeamClaudePalette.line)
        let slots = barSlots(days.count, area)
        for (i, day) in days.enumerated() {
            let x = area.minX + CGFloat(i) * slots.step
            let column = NSRect(x: x, y: area.minY, width: slots.width, height: area.height)
            if day.hatched { drawHatch(column, color: TeamClaudePalette.track) }
            guard peak > 0 else { continue }
            var top = area.maxY
            for part in day.parts where part.value > 0 {
                let h = max(1, area.height * CGFloat(part.value / peak))
                let seg = NSRect(x: x, y: top - h, width: slots.width, height: h)
                color(part.key).setFill()
                seg.fill()
                top -= h
            }
            if day.hatched, day.total > 0 {
                drawHatch(NSRect(x: x, y: top, width: slots.width, height: area.maxY - top), color: TeamClaudePalette.sheet.withAlphaComponent(0.7))
            }
        }
        drawDateLabels(days.map(\.date), area: area, slots: slots)
    }

    private func drawDateLabels(_ dates: [String], area: NSRect, slots: (width: CGFloat, step: CGFloat)) {
        guard !dates.isEmpty else { return }
        let picks = Array(Set([0, dates.count / 2, dates.count - 1])).sorted()
        for i in picks {
            let label = modelUsageMonthDay(dates[i])
            let center = area.minX + CGFloat(i) * slots.step + slots.width / 2
            let w = PanelDraw.width(label, TeamClaudePalette.microFont)
            let x = min(max(area.minX, center - w / 2), area.maxX - w)
            PanelDraw.text(label, x, area.maxY + 2, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        }
    }

    private func drawHatchLegend(_ rect: NSRect) {
        var x = rect.minX
        for text in [L10n.modelHatchClaude, L10n.modelHatchCli] {
            let swatch = NSRect(x: x, y: rect.minY + 3, width: 10, height: 10)
            PanelDraw.strokeRound(swatch, TeamClaudePalette.line, 1)
            drawHatch(swatch, color: TeamClaudePalette.fg3)
            x += 16 + PanelDraw.text(text, x + 16, rect.minY, TeamClaudePalette.microFont, TeamClaudePalette.fg3) + 14
        }
    }

    // MARK: 모델별

    private func drawModels(_ p: ModelUsagePresentation, _ report: ModelUsageReport, _ rect: NSRect, compared: Bool) {
        guard !p.models.isEmpty else {
            PanelDraw.text(L10n.modelNoRecords, rect.minX, rect.minY + 10, TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
            return
        }
        let right = rect.maxX
        for (i, line) in p.models.prefix(ModelUsageLayout.maxModelRows).enumerated() {
            let y = rect.minY + CGFloat(i) * ModelUsageLayout.modelRowHeight
            if i > 0 { PanelDraw.hairline(rect.minX, rect.maxX, y) }
            let color = modelColor(modelUsageNamedIndex(report, line.model) ?? 4)
            PanelDraw.fillRound(NSRect(x: rect.minX, y: y + 10, width: 8, height: 8), color, 1.5)
            let lane = line.lane == "claude" ? "Claude" : line.lane == "codex" ? "Codex" : L10n.modelOther
            let laneW = PanelDraw.width(lane, TeamClaudePalette.microFont)
            let nameRoom = rect.width - 14 - laneW - 8 - (compared ? 180 : 124)
            let nw = PanelDraw.text(PanelDraw.clipped(line.model, TeamClaudePalette.nameFont, maxWidth: nameRoom), rect.minX + 14, y + 6,
                                    TeamClaudePalette.nameFont, TeamClaudePalette.fg)
            PanelDraw.text(lane, rect.minX + 14 + nw + 8, y + 8, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            var cursor = right
            if compared {
                let delta = line.isNew ? L10n.modelNew : (line.delta ?? StatusVocabulary.none)
                PanelDraw.right(delta, cursor, y + 7, TeamClaudePalette.smallFont, delta.hasPrefix("+") ? TeamClaudePalette.fg : TeamClaudePalette.fg3)
                cursor -= 56
            }
            PanelDraw.right(modelUsageCount(line.value), cursor, y + 7, TeamClaudePalette.smallFont, TeamClaudePalette.fg3)
            cursor -= 62
            PanelDraw.right(String(format: "%.1f%%", line.share * 100), cursor, y + 6, TeamClaudePalette.numberFont, TeamClaudePalette.fg)
        }
        if p.models.count > ModelUsageLayout.maxModelRows {
            let y = rect.minY + CGFloat(ModelUsageLayout.maxModelRows) * ModelUsageLayout.modelRowHeight
            PanelDraw.hairline(rect.minX, rect.maxX, y)
            PanelDraw.text(L10n.modelMoreModels(p.models.count - ModelUsageLayout.maxModelRows), rect.minX + 14, y + 5,
                           TeamClaudePalette.microFont, TeamClaudePalette.fg3)
        }
    }

    // MARK: 계정 풀·주기·용량

    private func drawPool(_ name: String, _ pool: ModelUsagePoolPresentation, _ rect: NSRect) {
        guard pool.available, !pool.accounts.isEmpty else {
            PanelDraw.text(name, rect.minX, rect.minY, TeamClaudePalette.captionFont, TeamClaudePalette.fg2)
            PanelDraw.text(L10n.modelPoolUnavailable, rect.minX, rect.minY + 20, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            return
        }
        PanelDraw.text(L10n.modelPoolSummary(name, full: pool.fullCount, total: pool.accounts.count), rect.minX, rect.minY,
                       TeamClaudePalette.captionFont, TeamClaudePalette.fg2)
        let colWidth = (rect.width - 20) / 2
        for (i, account) in pool.accounts.enumerated() {
            let col = CGFloat(i % 2), row = CGFloat(i / 2)
            let x = rect.minX + col * (colWidth + 20)
            let y = rect.minY + 20 + row * ModelUsageLayout.poolRowHeight
            PanelDraw.text(account.label, x, y + 1, TeamClaudePalette.smallFont, account.muted ? TeamClaudePalette.fg3 : TeamClaudePalette.fg2)
            PanelDraw.meterWithValue(NSRect(x: x + 34, y: y, width: colWidth - 34, height: ModelUsageLayout.poolRowHeight),
                                     percent: account.percent, elapsed: account.elapsed, muted: account.muted)
        }
    }

    private func drawCycles(_ p: ModelUsagePresentation, _ rect: NSRect) {
        let s = p.cycleSummary
        let summary = s.fiveCycles + s.weekCycles > 0
            ? L10n.modelCyclesSummary(modelUsageCount(s.fiveCycles), modelUsageCount(s.fiveExhausted), modelUsageCount(s.weekCycles), modelUsageCount(s.weekExhausted))
            : L10n.modelCyclesEmpty
        PanelDraw.text(PanelDraw.clipped(summary, TeamClaudePalette.legendFont, maxWidth: rect.width), rect.minX, rect.minY,
                       TeamClaudePalette.legendFont, TeamClaudePalette.fg2)
        let bars = p.cycles5h.map { ModelUsageDayBar(date: $0.date, parts: [ModelUsageBarPart(key: 0, value: $0.exhausted),
                                                                             ModelUsageBarPart(key: 1, value: max(0, $0.cycles - $0.exhausted))], hatched: false) }
        let peak = bars.map(\.total).max() ?? 0
        drawStacked(bars, peak: peak, color: { $0 == 0 ? TeamClaudePalette.amber : TeamClaudePalette.ash.withAlphaComponent(0.35) },
                    rect: NSRect(x: rect.minX, y: rect.minY + 20, width: rect.width, height: ModelUsageLayout.chartHeight))
        var x = rect.minX
        let y = rect.minY + 20 + ModelUsageLayout.chartHeight + 2
        for (text, color) in [(L10n.modelCyclesExhausted, TeamClaudePalette.amber), (L10n.modelCyclesHeadroom, TeamClaudePalette.ash.withAlphaComponent(0.35))] {
            PanelDraw.fillRound(NSRect(x: x, y: y + 3, width: 8, height: 8), color, 1.5)
            x += 14 + PanelDraw.text(text, x + 14, y, TeamClaudePalette.microFont, TeamClaudePalette.fg3) + 14
        }
    }

    private func drawFacts(_ p: ModelUsagePresentation, _ rect: NSRect) {
        PanelDraw.card(rect)
        PanelDraw.dot(rect.minX + 12, centerY: rect.minY + 17, TeamClaudePalette.series[1])
        PanelDraw.meta(L10n.modelFactsTitle(p.facts.weekLabel), rect.minX + 26, rect.minY + 10)
        let f = p.facts
        let demand = f.pro.map { L10n.modelFactDemandValue(Self.proText($0.mid)) } ?? StatusVocabulary.none
        let demandSub = f.pro.map { "\(Self.proText($0.lo))~\(Self.proText($0.hi))" + (f.lowerBound ? " · \(L10n.modelBadgeLowerBound)" : "") } ?? ""
        let facts: [(String, String, String)] = [
            (L10n.modelFactDemand, demand, demandSub),
            (L10n.modelFactRuns, "\(modelUsageCount(f.reviewRuns)) · \(modelUsageCount(f.implRuns))", ""),
            (L10n.modelFactAccounts, f.codexTotal > 0 ? "\(f.codexOn)/\(f.codexTotal)" : StatusVocabulary.none, ""),
        ]
        let col = (rect.width - 24) / 3
        for (i, fact) in facts.enumerated() {
            let x = rect.minX + 12 + CGFloat(i) * col
            PanelDraw.text(PanelDraw.clipped(fact.0, TeamClaudePalette.microFont, maxWidth: col - 8), x, rect.minY + 28, TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            PanelDraw.text(fact.1, x, rect.minY + 41, TeamClaudePalette.sessionValueFont, TeamClaudePalette.fg)
            if !fact.2.isEmpty {
                PanelDraw.text(PanelDraw.clipped(fact.2, TeamClaudePalette.microFont, maxWidth: col - 8), x, rect.minY + 60,
                               TeamClaudePalette.microFont, TeamClaudePalette.fg3)
            }
        }
    }
}

let modelUsageStampFormatter: DateFormatter = {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "M/d HH:mm"
    return f
}()
