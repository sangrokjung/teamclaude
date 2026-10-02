import Cocoa

/// 메뉴바 드롭다운의 힉스필드 크레딧 섹션.
/// 잔액만 보여주면 정작 중요한 사실을 놓친다. 갱신 때 미사용분은 이월되지 않고 사라진다.
/// 그래서 이 섹션의 중심은 "언제 리셋되고(D-day), 그때 얼마가 사라질 것인가"다.
final class HiggsfieldCreditsView: NSView {
    var data: HiggsfieldCreditsData? {
        didSet {
            updateAccessibility()
            needsDisplay = true
        }
    }

    /// 조회가 끊긴 지 오래됐다는 꼬리말. 크레딧은 마지막 성공값을 계속 그리므로,
    /// 이 표시가 없으면 낡은 숫자가 최신값처럼 읽힌다(적대 리뷰 2026-09-24).
    var staleNote: String? {
        didSet {
            guard staleNote != oldValue else { return }
            updateAccessibility()
            needsDisplay = true
        }
    }

    override var isFlipped: Bool { true }

    static let normalHeight: CGFloat = 148
    static let errorHeight: CGFloat = 96

    static func preferredHeight(for data: HiggsfieldCreditsData?) -> CGFloat {
        guard let data = data else { return 0 }
        return data.error != nil ? errorHeight : normalHeight
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel("힉스필드 크레딧")
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func updateAccessibility() {
        guard let data = data else { return }
        if let error = data.error {
            setAccessibilityLabel("힉스필드 크레딧 조회 실패: \(error)")
            return
        }
        let cycle = higgsfieldEstimateCycle(data.transactions, now: Date())
        var label = "힉스필드 크레딧 \(higgsfieldFormatCredits(data.credits)), 다음 리셋 \(higgsfieldFormatDday(cycle.daysRemaining))"
        if let staleNote { label += ", \(staleNote)" }
        setAccessibilityLabel(label)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let panel = NSColor(calibratedRed: 0.095, green: 0.115, blue: 0.15, alpha: 1.0)
        let line = NSColor(calibratedRed: 0.23, green: 0.27, blue: 0.34, alpha: 1.0)
        let text = NSColor(calibratedRed: 0.92, green: 0.95, blue: 0.98, alpha: 1.0)
        let muted = NSColor(calibratedRed: 0.55, green: 0.61, blue: 0.70, alpha: 1.0)
        let dim = NSColor(calibratedRed: 0.40, green: 0.46, blue: 0.55, alpha: 1.0)
        let green = NSColor(calibratedRed: 0.18, green: 0.82, blue: 0.48, alpha: 1.0)
        let yellow = NSColor(calibratedRed: 0.93, green: 0.76, blue: 0.22, alpha: 1.0)
        let red = NSColor(calibratedRed: 0.96, green: 0.26, blue: 0.32, alpha: 1.0)
        let blue = NSColor(calibratedRed: 0.28, green: 0.55, blue: 0.90, alpha: 1.0)

        let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let bigFont = NSFont.monospacedDigitSystemFont(ofSize: 26, weight: .bold)
        let ddayFont = NSFont.monospacedDigitSystemFont(ofSize: 22, weight: .bold)
        let bodyFont = NSFont.systemFont(ofSize: 12, weight: .medium)
        let smallFont = NSFont.systemFont(ofSize: 11, weight: .medium)

        func attrs(_ font: NSFont, _ color: NSColor) -> [NSAttributedString.Key: Any] {
            [.font: font, .foregroundColor: color]
        }
        func drawText(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            value.draw(at: NSPoint(x: x, y: y), withAttributes: attrs(font, color))
        }
        func drawRight(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor) {
            let a = attrs(font, color)
            let s = value.size(withAttributes: a)
            value.draw(at: NSPoint(x: x - s.width, y: y), withAttributes: a)
        }
        func fillRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setFill()
            NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        }
        func strokeRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
            color.setStroke()
            let p = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
            p.lineWidth = 1
            p.stroke()
        }
        func pill(_ value: String, rightX: CGFloat, y: CGFloat, color: NSColor) {
            let a = attrs(smallFont, color)
            let s = value.size(withAttributes: a)
            let rect = NSRect(x: rightX - s.width - 16, y: y, width: s.width + 16, height: 20)
            fillRound(rect, color.withAlphaComponent(0.14), 10)
            strokeRound(rect, color.withAlphaComponent(0.38), 10)
            value.draw(at: NSPoint(x: rect.minX + 8, y: y + 3), withAttributes: a)
        }

        let pad: CGFloat = 14
        let card = NSRect(x: 8, y: 0, width: bounds.width - 16, height: bounds.height - 4)
        fillRound(card, panel, 10)
        strokeRound(card, line, 10)

        let left = card.minX + pad
        let right = card.maxX - pad
        var y = card.minY + 10

        drawText("힉스필드 크레딧", left, y, titleFont, text)

        guard let data = data else {
            drawText("불러오는 중...", left, y + 26, bodyFont, muted)
            return
        }

        if let plan = data.planType, !plan.isEmpty {
            pill(plan.uppercased(), rightX: right, y: y - 2, color: blue)
        }
        y += 24

        // 실패 상태: 사유와 복구 방법만 말한다.
        if let error = data.error {
            drawText(error, left, y, bodyFont, red)
            y += 20
            let hint = higgsfieldLooksLikeAuthFailure(error)
                ? "터미널에서 higgsfield auth login 으로 로그인한 뒤 새로고침하세요"
                : "CLI 설치 확인: npm i -g @higgsfield/cli"
            drawText(hint, left, y, smallFont, dim)
            return
        }

        let now = Date()
        let cycle = higgsfieldEstimateCycle(data.transactions, now: now)
        let usage = higgsfieldNetUsage(data.transactions, since: cycle.lastGrantAt)
        let spent = higgsfieldTotalSpend(usage)
        let unknown = higgsfieldUnknownActions(usage)
        let projection = higgsfieldProjectExpiry(
            balance: data.credits, spent: spent,
            elapsedDays: cycle.elapsedDays, cycleDays: cycle.cycleDays,
            grantAmount: cycle.grantAmount
        )

        let ddayColor: NSColor = {
            guard let days = cycle.daysRemaining else { return muted }
            if days <= 3 { return red }
            if days <= 7 { return yellow }
            return blue
        }()

        // 잔액 · D-day
        drawText(higgsfieldFormatCredits(data.credits), left, y, bigFont, text)
        if let staleNote {
            // 크레딧 숫자 옆에 붙인다. 숫자만 크게 남기면 낡은 값이 최신값으로 읽힌다.
            let used = higgsfieldFormatCredits(data.credits).size(withAttributes: [.font: bigFont]).width
            drawText(staleNote, left + used + 12, y + 8,
                     NSFont.systemFont(ofSize: 11, weight: .medium), muted)
        }
        drawRight(higgsfieldFormatDday(cycle.daysRemaining), right, y + 3, ddayFont, ddayColor)
        y += 32

        let grantText = cycle.grantAmount.map { "주기 지급 \(higgsfieldFormatCredits($0))" } ?? "주기 지급 미상"
        drawText(grantText, left, y, smallFont, dim)
        let renewText = cycle.nextRenewalAt != nil
            ? "\(higgsfieldFormatDateTime(cycle.nextRenewalAt)) 갱신 예정"
            : "갱신 이력이 없어 예정일을 계산할 수 없습니다"
        drawRight(renewText, right, y, smallFont, muted)
        y += 20

        // 주기 진행바
        let barRect = NSRect(x: left, y: y, width: right - left, height: 6)
        fillRound(barRect, NSColor(calibratedRed: 0.16, green: 0.19, blue: 0.24, alpha: 1.0), 3)
        if let ratio = cycle.elapsedRatio, ratio > 0 {
            let filled = NSRect(x: left, y: y, width: max((right - left) * CGFloat(ratio), 3), height: 6)
            fillRound(filled, blue, 3)
        }
        y += 12

        let elapsedText: String = {
            guard let elapsed = cycle.elapsedDays else { return "갱신 이력 없음" }
            if elapsed < 0 { return "지급 시각이 미래입니다 · 시계 확인 필요" }
            return "\(Int(elapsed))일 경과 / \(cycle.cycleDays)일"
        }()
        drawText(elapsedText, left, y, smallFont, dim)

        let basisText: String = {
            if cycle.lastGrantAt == nil { return "지급 기록 없음" }
            if cycle.assumedCycle { return "주기 미실측 · 기본 \(cycle.cycleDays)일 가정" }
            return "\(cycle.cycleDays)일 주기 · 갱신 \(cycle.grantCount)건 실측"
        }()
        drawRight(basisText, right, y, smallFont, dim)
        y += 20

        // 이번 주기 사용 · 소멸 예상
        let expiryColor: NSColor = {
            guard let expiry = projection.projectedExpiry else { return muted }
            return expiry > 0 ? yellow : green
        }()
        drawText("이번 주기 사용 \(higgsfieldFormatCredits(spent))", left, y, bodyFont, muted)

        let expiryText: String = {
            if let gap = projection.gap {
                return gap == .noGrantHistory ? "소멸 예상 계산 불가" : "소멸 예상 측정 중"
            }
            let amount = higgsfieldFormatCredits(projection.projectedExpiry)
            if let ratio = projection.projectedExpiryRatio {
                return "소멸 예상 \(amount) (지급분 \(Int((ratio * 100).rounded()))%)"
            }
            return "소멸 예상 \(amount)"
        }()
        drawRight(expiryText, right, y, bodyFont, expiryColor)
        y += 19

        // 근거 한 줄: 추정이라는 사실과 직전 실제 소멸을 같이 말한다.
        var footnotes: [String] = []
        if let reset = higgsfieldSubscriptionResets(data.transactions).first {
            footnotes.append("직전 갱신(\(higgsfieldFormatDate(reset.createdAt)))에 \(higgsfieldFormatCredits(abs(reset.credits))) 소멸")
        }
        footnotes.append("갱신일은 API 미제공 · 지급 이력으로 추정")
        if !unknown.isEmpty {
            footnotes.append("처음 보는 거래 유형(\(unknown.joined(separator: ", ")))")
        }
        if let partial = data.partialError, !partial.isEmpty {
            footnotes.append("일부만 조회됨")
        }
        drawText(footnotes.joined(separator: " · "), left, y, smallFont, dim)
    }
}
