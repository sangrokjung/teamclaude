import Cocoa

// 두 블록이 겹치지 않는다. 위는 합계와 새는 돈, 아래는 서비스별이다.
// 서비스 이름을 두 번 적지 않는 것이 이 대시보드의 규율이다.

struct SubscriptionBurnModel: Equatable {
    let usages: [LaneUsage]
    let rates: [String: LaneRate]
    let recommendations: [String]
    /// 금액 앞에 붙는 통화 기호. 단가 파일의 currency에서 온다.
    let currency: String

    init(usages: [LaneUsage], rates: [String: LaneRate], recommendations: [String],
         currency: String = "") {
        self.usages = usages
        self.rates = rates
        self.recommendations = recommendations
        self.currency = currency
    }
}

private let burnNumberFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    return formatter
}()

/// 단가가 없으면 숫자를 만들지 않는다.
func burnAmountLabel(_ monthly: Int?, accounts: Int, currency: String = "") -> String {
    guard let monthly else { return "미입력" }
    let total = monthly * max(accounts, 0)
    return currency + (burnNumberFormatter.string(from: NSNumber(value: total)) ?? "\(total)")
}

private func burnPercent(_ value: Double) -> String { "\(Int((value * 100).rounded()))%" }

/// 전망은 근거를 함께 말한다. 근거를 숨기면 추정이 실측으로 읽힌다.
func burnProjectionLabel(_ projection: BurnProjection) -> String {
    switch projection.basis {
    case .collecting:
        return "수집 중"
    case .unmeasured:
        return StatusVocabulary.notMeasured
    case .history(let cycles):
        guard let projected = projection.projected else { return StatusVocabulary.notMeasured }
        let base = "최근 \(cycles)주 평균 \(burnPercent(projected))"
        guard let range = projection.range else { return base }
        return "\(base) · \(burnPercent(range.lowerBound))~\(burnPercent(range.upperBound))"
    case .extrapolation(let confidence):
        guard let current = projection.current, let projected = projection.projected else {
            return StatusVocabulary.notMeasured
        }
        let base = "\(burnPercent(current)) → \(burnPercent(projected)) 추정"
        return confidence == .low ? "\(base) · 신뢰 낮음" : base
    }
}

func burnVerdictLabel(_ verdict: BurnVerdict) -> String {
    switch verdict {
    case .blocked: return "부족"
    case .onTarget: return "달성"
    case .near: return "근접"
    case .slack: return "여유"
    case .excess: return "과다"
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

final class SubscriptionBurnView: NSView {
    static let spendHeight: CGFloat = 56
    static let headerHeight: CGFloat = 26
    static let rowHeight: CGFloat = 24
    static let recommendationHeight: CGFloat = 26
    static let blockGap: CGFloat = 8
    static let padding: CGFloat = 12

    static func preferredHeight(_ model: SubscriptionBurnModel) -> CGFloat {
        let rows = CGFloat(model.usages.count) * rowHeight
        let recommendations = model.recommendations.isEmpty ? 0 : recommendationHeight
        return spendHeight + blockGap + padding * 2 + headerHeight + rows + recommendations
    }

    var model = SubscriptionBurnModel(usages: [], rates: [:], recommendations: []) {
        didSet {
            guard model != oldValue else { return }
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

    private var accessibilityText: String {
        let lanes = model.usages.map { usage in
            "\(usage.lane) \(usage.paidAccounts)계정 중 기여 \(usage.contributingAccounts), "
            + "\(burnProjectionLabel(burnBindingProjection(usage))), \(burnVerdictLabel(burnVerdict(usage)))"
        }
        return (["구독 지출과 한도 소진"] + lanes + model.recommendations).joined(separator: "; ")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard bounds.width > 0 else { return }

        let text = TeamClaudePalette.text
        let muted = TeamClaudePalette.muted
        let head = NSFont.systemFont(ofSize: 12, weight: .semibold)
        let body = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        let small = NSFont.systemFont(ofSize: 11, weight: .medium)

        func drawText(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            (value as NSString).draw(at: NSPoint(x: x, y: y),
                                     withAttributes: [.font: font, .foregroundColor: color])
        }
        func drawRight(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            let width = (value as NSString).size(withAttributes: [.font: font]).width
            drawText(value, x - width, y, font, color)
        }
        func fill(_ rect: NSRect) {
            let path = NSBezierPath(roundedRect: rect, xRadius: 8, yRadius: 8)
            TeamClaudePalette.panel.setFill()
            path.fill()
        }

        let inner = bounds.insetBy(dx: 8, dy: 0)
        let spend = NSRect(x: inner.minX, y: 0, width: inner.width, height: Self.spendHeight)
        fill(spend)

        let paidTotal = model.usages.reduce(0) { $0 + $1.paidAccounts }
        let idle = model.usages.reduce(0) { $0 + $1.errorAccounts + $1.disabledAccounts }
        let paidAccounts = Dictionary(model.usages.map { ($0.lane, $0.paidAccounts) },
                                      uniquingKeysWith: { first, _ in first })
        let total = subscriptionMonthlyTotal(rates: model.rates, paidAccounts: paidAccounts)

        drawText("월 합계", spend.minX + Self.padding, 12, head, muted)
        drawText(total.map { burnAmountLabel($0, accounts: 1, currency: model.currency) } ?? "미입력",
                 spend.minX + Self.padding + 64, 10, body, total == nil ? muted : text)
        drawRight("기여 없는 계정 \(idle) / \(paidTotal)",
                  spend.maxX - Self.padding, 12, head, idle > 0 ? TeamClaudePalette.yellow : muted)

        let errors = model.usages.reduce(0) { $0 + $1.errorAccounts }
        let disabled = model.usages.reduce(0) { $0 + $1.disabledAccounts }
        let unsubscribed = model.usages.reduce(0) { $0 + $1.unsubscribedAccounts }
        drawText("오류 \(errors) · 복구 가능", spend.minX + Self.padding, 34, small, muted)
        drawText("꺼 둠 \(disabled) · 결정 필요", spend.minX + Self.padding + 160, 34, small, muted)
        if unsubscribed > 0 {
            // 돈이 안 나가는 계정이라 지출 합계에 없다. 그 사실을 화면이 말해야 "왜 17개가 아니지"가 안 생긴다.
            drawText("해지 \(unsubscribed) · 지출 제외", spend.minX + Self.padding + 320, 34, small, muted)
        }

        let burnTop = Self.spendHeight + Self.blockGap
        let burn = NSRect(x: inner.minX, y: burnTop, width: inner.width,
                          height: max(bounds.height - burnTop, 0))
        fill(burn)

        let columnLane = burn.minX + Self.padding
        let columnAccounts = burn.minX + 120
        let columnSpend = burn.minX + 260
        let columnBurn = burn.minX + 380
        let columnVerdict = burn.maxX - Self.padding

        var y = burnTop + Self.padding
        drawText("서비스", columnLane, y, head, muted)
        drawText("계정", columnAccounts, y, head, muted)
        drawText("월 지출", columnSpend, y, head, muted)
        drawText("주간 소진", columnBurn, y, head, muted)
        drawRight("판정", columnVerdict, y, head, muted)
        y += Self.headerHeight

        for usage in model.usages {
            let verdict = burnVerdict(usage)
            drawText(usage.lane, columnLane, y, body, text)
            // 돈 내는 수와 실제 기여하는 수가 다른 것이 이 화면의 핵심이라 붙여 둔다.
            let accounts = usage.paidAccounts == usage.contributingAccounts
                ? "\(usage.paidAccounts)"
                : "\(usage.paidAccounts) (\(usage.contributingAccounts))"
            drawText(accounts, columnAccounts, y, body, text)
            let monthly = model.rates[usage.lane]?.monthly
            drawText(burnAmountLabel(monthly, accounts: usage.paidAccounts, currency: model.currency),
                     columnSpend, y, body, monthly == nil ? muted : text)
            drawText(burnProjectionLabel(burnBindingProjection(usage)), columnBurn, y + 1, small, muted)
            drawRight(burnVerdictLabel(verdict), columnVerdict, y, body, burnVerdictColor(verdict))
            y += Self.rowHeight
        }

        if !model.recommendations.isEmpty {
            drawText(model.recommendations.joined(separator: " · "), columnLane, y + 4, small, muted)
        }
    }
}
