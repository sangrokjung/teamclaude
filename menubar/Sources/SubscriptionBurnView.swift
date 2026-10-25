import Cocoa

// 두 블록이 겹치지 않는다. 위는 합계와 새는 돈, 아래는 서비스별이다.
// 서비스 이름을 두 번 적지 않는 것이 이 대시보드의 규율이다.

struct SubscriptionBurnModel: Equatable {
    let usages: [LaneUsage]
    let rates: [String: LaneRate]
    let recommendations: [String]
    /// 금액 앞에 붙는 통화 기호. 단가 파일의 currency에서 온다.
    let currency: String
    /// 구독 수집기 상태 파일이 없을 때의 안내(R4). 높이와 그리기가 같은 모델에서 읽는다.
    let collectorNotice: ToolNotice?

    init(usages: [LaneUsage], rates: [String: LaneRate], recommendations: [String],
         currency: String = "", collectorNotice: ToolNotice? = nil) {
        self.usages = usages
        self.rates = rates
        self.recommendations = recommendations
        self.currency = currency
        self.collectorNotice = collectorNotice
    }
}

private let burnNumberFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter
}()

/// 단가가 없으면 숫자를 만들지 않는다.
func burnAmountLabel(_ monthly: Int?, accounts: Int, currency: String = "") -> String {
    guard let monthly else { return L10n.notEntered }
    let total = monthly * max(accounts, 0)
    return currency + (burnNumberFormatter.string(from: NSNumber(value: total)) ?? "\(total)")
}

/// 레인 id("claude"·"codex"·"agy"·"grok") → 화면 이름.
func burnLaneDisplayName(_ lane: String) -> String {
    switch lane {
    case "claude": return "Claude"
    case "codex": return "Codex"
    case "agy": return "agy"
    case "grok": return "Grok"
    default: return lane
    }
}

private func burnPercent(_ value: Double) -> String { "\(Int((value * 100).rounded()))%" }

/// 전망은 근거를 함께 말한다. 근거를 숨기면 추정이 실측으로 읽힌다.
func burnProjectionLabel(_ projection: BurnProjection) -> String {
    switch projection.basis {
    case .collecting:
        return L10n.burnCollecting
    case .unmeasured:
        return StatusVocabulary.notMeasured
    case .history(let cycles):
        guard let projected = projection.projected else { return StatusVocabulary.notMeasured }
        let base = L10n.burnHistory(cycles: cycles, percent: burnPercent(projected))
        guard let range = projection.range else { return base }
        return "\(base) · \(burnPercent(range.lowerBound))~\(burnPercent(range.upperBound))"
    case .extrapolation(let confidence):
        guard let current = projection.current, let projected = projection.projected else {
            return StatusVocabulary.notMeasured
        }
        // 신뢰 낮은 외삽이 100%를 넘으면 숫자(예: 423%)를 쓰지 않는다. 주기 초반의 작은 값을 경과율로 나눈 값이라
        // 근거가 약하고, 큰 숫자가 실측처럼 읽힌다(실사용 QA 2026-10-25). 계산은 그대로 두고 말만 바꾼다.
        guard confidence == .low else { return L10n.burnEstimate(burnPercent(current), burnPercent(projected)) }
        let base = projected > 1 ? L10n.burnEstimateOver(burnPercent(current))
            : L10n.burnEstimate(burnPercent(current), burnPercent(projected))
        return "\(base) · \(L10n.lowConfidence)"
    }
}

/// 판정을 단정하지 않을 전망인가. 신뢰 낮은 외삽은 "달성"이 아니라 "달성 추정"이다.
func burnVerdictIsTentative(_ projection: BurnProjection) -> Bool {
    projection.basis == .extrapolation(confidence: .low)
}

/// 화면에 그릴 판정 문구와 색. 개요 미리보기·소진 탭 표·접근성이 같은 함수를 쓴다.
/// 관측된 부족(.blocked)과 잴 수 없음(.unknown)은 추정이 아니므로 그대로 둔다.
func burnVerdictDisplay(_ usage: LaneUsage) -> (label: String, color: NSColor) {
    let verdict = burnVerdict(usage)
    let tentative = burnVerdictIsTentative(burnBindingProjection(usage)) && verdict != .blocked && verdict != .unknown
    guard tentative else { return (burnVerdictLabel(verdict), burnVerdictColor(verdict)) }
    return (L10n.verdictTentative(burnVerdictLabel(verdict)), TeamClaudePalette.muted)
}

func burnVerdictLabel(_ verdict: BurnVerdict) -> String {
    switch verdict {
    case .blocked: return L10n.verdictBlocked
    case .onTarget: return L10n.verdictOnTarget
    case .near: return L10n.verdictNear
    case .slack: return L10n.verdictSlack
    case .excess: return L10n.verdictExcess
    case .unknown: return StatusVocabulary.notMeasured
    }
}

/// 색은 기존 팔레트 의미를 그대로 쓴다. 새 색을 만들면 같은 색이 두 가지를 뜻하게 된다.
func burnVerdictColor(_ verdict: BurnVerdict) -> NSColor {
    switch verdict {
    case .blocked: return TeamClaudePalette.red
    case .onTarget, .near: return TeamClaudePalette.green
    case .slack, .unknown: return TeamClaudePalette.muted
    case .excess: return TeamClaudePalette.yellow
    }
}

/// 소진 탭 위쪽(A안): 지출 요약 두 칸 → 서비스별 판정 → 먼저 할 일 → 수집기 안내 → 구독 기록 진입.
final class SubscriptionBurnView: NSView {
    static let padding: CGFloat = 16
    static let spendHeight: CGFloat = 74
    static let headerHeight: CGFloat = 26
    static let rowHeight: CGFloat = 36
    static let recommendationHeight: CGFloat = 40
    static let blockGap: CGFloat = 22
    static let noticeHeight: CGFloat = 26
    static let linkHeight: CGFloat = 34

    static func preferredHeight(_ model: SubscriptionBurnModel) -> CGFloat {
        let rows = CGFloat(max(1, model.usages.count)) * rowHeight
        let recommendations = model.recommendations.isEmpty ? 0
            : blockGap + headerHeight + CGFloat(model.recommendations.count) * recommendationHeight
        let collector = model.collectorNotice == nil ? 0 : noticeHeight
        return 4 + spendHeight + blockGap + headerHeight + rows + recommendations + collector + linkHeight
    }

    var model = SubscriptionBurnModel(usages: [], rates: [:], recommendations: []) {
        didSet {
            guard model != oldValue else { return }
            setAccessibilityLabel(accessibilityText)
            needsDisplay = true
            needsLayout = true
        }
    }
    /// 계정별 구독 기록으로 가는 길(Claude 탭에서 행을 펼친다). 대시보드가 탭 이동을 맡는다.
    var onOpenRecords: (() -> Void)? {
        didSet { recordsButton.isHidden = onOpenRecords == nil }
    }
    private lazy var recordsButton = PanelButton(title: L10n.burnRecordsLink, style: .quiet) { [weak self] in self?.onOpenRecords?() }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(accessibilityText)
        recordsButton.isHidden = true
        addSubview(recordsButton)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private var accessibilityText: String {
        let lanes = model.usages.map { usage in
            L10n.burnLaneAccessibility(lane: burnLaneDisplayName(usage.lane), paid: usage.paidAccounts, contributing: usage.contributingAccounts)
            + ", \(burnProjectionLabel(burnBindingProjection(usage))), \(burnVerdictDisplay(usage).label)"
        }
        let collector = model.collectorNotice.map { [$0.headline] } ?? []
        return ([L10n.burnAccessibilityTitle] + lanes + model.recommendations + collector).joined(separator: "; ")
    }

    override func layout() {
        super.layout()
        recordsButton.frame = NSRect(x: Self.padding - 10, y: bounds.height - Self.linkHeight + 4,
                                     width: recordsButton.fittingWidth + 12, height: PanelButton.height)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard bounds.width > 0 else { return }
        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let body = TeamClaudePalette.bodyFont
        let number = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)
        let micro = TeamClaudePalette.microFont
        let legend = TeamClaudePalette.legendFont
        let x0 = Self.padding
        let width = bounds.width - Self.padding * 2

        // 지출 요약 두 칸(위아래 선, 가운데 세로선)
        let spend = NSRect(x: x0, y: 4, width: width, height: Self.spendHeight)
        PanelDraw.hairline(spend.minX, spend.maxX, spend.minY)
        PanelDraw.hairline(spend.minX, spend.maxX, spend.maxY - 1)
        TeamClaudePalette.line.setFill()
        NSRect(x: spend.midX, y: spend.minY, width: 1, height: spend.height).fill()
        let paidTotal = model.usages.reduce(0) { $0 + $1.paidAccounts }
        let idle = model.usages.reduce(0) { $0 + $1.errorAccounts + $1.disabledAccounts }
        let paidAccounts = Dictionary(model.usages.map { ($0.lane, $0.paidAccounts) }, uniquingKeysWith: { first, _ in first })
        let total = subscriptionMonthlyTotal(rates: model.rates, paidAccounts: paidAccounts)
        let errors = model.usages.reduce(0) { $0 + $1.errorAccounts }
        let disabled = model.usages.reduce(0) { $0 + $1.disabledAccounts }
        let unsubscribed = model.usages.reduce(0) { $0 + $1.unsubscribedAccounts }
        let big = NSFont.monospacedDigitSystemFont(ofSize: 17, weight: .semibold)
        PanelDraw.text(L10n.burnMonthlyTotal, spend.minX, spend.minY + 12, legend, fg3)
        PanelDraw.text(total.map { burnAmountLabel($0, accounts: 1, currency: model.currency) } ?? L10n.notEntered,
                       spend.minX, spend.minY + 30, big, total == nil ? fg2 : fg)
        PanelDraw.text(PanelDraw.clipped(total == nil ? L10n.burnRatesHint : L10n.burnRatesSet, micro, maxWidth: width / 2 - 14),
                       spend.minX, spend.minY + 54, micro, fg3)
        let rightX = spend.midX + 14
        PanelDraw.text(L10n.burnIdleAccounts, rightX, spend.minY + 12, legend, fg3)
        let idleWidth = PanelDraw.text("\(idle)", rightX, spend.minY + 30, big, idle > 0 ? TeamClaudePalette.amber : fg)
        PanelDraw.text("/ \(paidTotal)", rightX + idleWidth + 6, spend.minY + 34, NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium), fg3)
        // 해지는 돈이 안 나가는 계정이라 지출 합계에 없다. 그 사실을 화면이 말해야 "왜 17개가 아니지"가 안 생긴다.
        PanelDraw.text(PanelDraw.clipped(L10n.burnIdleBreakdown(errors: errors, disabled: disabled, unsubscribed: unsubscribed),
                                         micro, maxWidth: width / 2 - 14), rightX, spend.minY + 54, micro, fg3)

        // 서비스별 판정
        var y = spend.maxY + Self.blockGap
        PanelDraw.meta(L10n.burnByService, x0, y)
        PanelDraw.right(L10n.burnByServiceAside, x0 + width, y, legend, fg3)
        y += Self.headerHeight
        let columnSeats = x0 + 76
        let columnSpend = x0 + 134
        let columnBurn = x0 + 226
        if model.usages.isEmpty {
            PanelDraw.text(StatusVocabulary.notMeasured, x0, y + 8, body, fg3)
        }
        for (index, usage) in model.usages.enumerated() {
            if index > 0 { PanelDraw.hairline(x0, x0 + width, y) }
            let verdict = burnVerdictDisplay(usage)
            PanelDraw.text(burnLaneDisplayName(usage.lane), x0, y + 10, TeamClaudePalette.bodyMediumFont, fg)
            // 돈 내는 수와 실제 기여하는 수가 다른 것이 이 화면의 핵심이라 붙여 둔다.
            let seats = usage.paidAccounts == usage.contributingAccounts
                ? "\(usage.paidAccounts)" : "\(usage.paidAccounts) (\(usage.contributingAccounts))"
            PanelDraw.text(seats, columnSeats, y + 10, number, fg2)
            let monthly = model.rates[usage.lane]?.monthly
            PanelDraw.text(PanelDraw.clipped(burnAmountLabel(monthly, accounts: usage.paidAccounts, currency: model.currency), number,
                                             maxWidth: columnBurn - columnSpend - 8),
                           columnSpend, y + 10, number, monthly == nil ? fg3 : fg)
            let verdictLeft = PanelDraw.right(verdict.label, x0 + width, y + 10, body, verdict.color)
            PanelDraw.text(PanelDraw.clipped(burnProjectionLabel(burnBindingProjection(usage)), number, maxWidth: verdictLeft - columnBurn - 10),
                           columnBurn, y + 10, number, fg)
            y += Self.rowHeight
        }
        if model.usages.isEmpty { y += Self.rowHeight }

        // 먼저 할 일 — 순서가 의미다: 기여하지 않는 계정을 먼저 살리고, 계정 수 조정은 그다음.
        if !model.recommendations.isEmpty {
            y += Self.blockGap
            PanelDraw.meta(L10n.burnFirstSteps, x0, y)
            PanelDraw.right(L10n.burnFirstStepsAside, x0 + width, y, legend, fg3)
            y += Self.headerHeight
            for (index, line) in model.recommendations.enumerated() {
                let row = NSRect(x: x0, y: y, width: width, height: Self.recommendationHeight - 6)
                PanelDraw.card(row)
                let badge = NSRect(x: row.minX + 10, y: row.midY - 10, width: 20, height: 20)
                PanelDraw.fillRound(badge, TeamClaudePalette.overlay, 10)
                let numberText = "\(index + 1)"
                PanelDraw.text(numberText, badge.midX - PanelDraw.width(numberText, TeamClaudePalette.smallFont) / 2, badge.minY + 3,
                               TeamClaudePalette.smallFont, fg2)
                PanelDraw.text(PanelDraw.clipped(line, body, maxWidth: row.width - 50), row.minX + 40, row.midY - 8, body, fg)
                y += Self.recommendationHeight
            }
        }
        if let notice = model.collectorNotice {
            PanelDraw.dot(x0 + 2, centerY: y + 12, TeamClaudePalette.sky)
            PanelDraw.text(PanelDraw.clipped(notice.line, legend, maxWidth: width - 16), x0 + 14, y + 5, legend, fg3)
            ToolNoticeDrawLog.record("subscription", notice)
        }
    }
}
