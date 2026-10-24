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

    static let normalHeight: CGFloat = 176
    static let errorHeight: CGFloat = 96

    static func preferredHeight(for data: HiggsfieldCreditsData?) -> CGFloat {
        guard let data = data else { return 0 }
        return data.error != nil ? errorHeight : normalHeight
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(L10n.higgsfieldTitle)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    private func updateAccessibility() {
        guard let data = data else { return }
        if let error = data.error {
            setAccessibilityLabel(L10n.higgsfieldFailed(error))
            return
        }
        let cycle = higgsfieldEstimateCycle(data.transactions, now: Date())
        var label = L10n.higgsfieldAccessibility(higgsfieldFormatCredits(data.credits), higgsfieldFormatDday(cycle.daysRemaining))
        if let staleNote { label += ", \(staleNote)" }
        setAccessibilityLabel(label)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let amber = TeamClaudePalette.amber, ember = TeamClaudePalette.ember, mint = TeamClaudePalette.mint
        let titleFont = TeamClaudePalette.bodyMediumFont
        let bigFont = NSFont.monospacedDigitSystemFont(ofSize: 24, weight: .semibold)
        let ddayFont = NSFont.monospacedDigitSystemFont(ofSize: 20, weight: .semibold)
        let bodyFont = TeamClaudePalette.captionFont
        let smallFont = TeamClaudePalette.microFont

        let pad: CGFloat = 14
        let card = NSRect(x: 16, y: 0, width: bounds.width - 32, height: bounds.height - 4)
        PanelDraw.card(card)
        let left = card.minX + pad
        let right = card.maxX - pad
        var y = card.minY + 12

        PanelDraw.text(L10n.higgsfieldTitle, left, y, titleFont, fg)

        guard let data = data else {
            PanelDraw.text(L10n.loading, left, y + 26, bodyFont, fg3)
            return
        }

        if let plan = data.planType, !plan.isEmpty {
            let label = plan.uppercased()
            let w = PanelDraw.width(label, smallFont) + 14
            let rect = NSRect(x: right - w, y: y - 1, width: w, height: 18)
            PanelDraw.strokeRound(rect, TeamClaudePalette.lineStrong, 6)
            PanelDraw.text(label, rect.minX + 7, rect.minY + 2, smallFont, fg2)
        }
        y += 26

        // 실패 상태: 사유와 복구 방법만 말한다.
        if let error = data.error {
            PanelDraw.text(PanelDraw.clipped(error, bodyFont, maxWidth: right - left), left, y, bodyFont, ember)
            y += 20
            let hint = higgsfieldLooksLikeAuthFailure(error) ? L10n.higgsfieldLoginHint : L10n.higgsfieldInstallHint
            PanelDraw.text(PanelDraw.clipped(hint, smallFont, maxWidth: right - left), left, y, smallFont, fg3)
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
            guard let days = cycle.daysRemaining else { return fg3 }
            if days <= 3 { return ember }
            if days <= 7 { return amber }
            return fg
        }()

        // 잔액 · D-day
        let creditsWidth = PanelDraw.text(higgsfieldFormatCredits(data.credits), left, y, bigFont, fg)
        if let staleNote {
            // 크레딧 숫자 옆에 붙인다. 숫자만 크게 남기면 낡은 값이 최신값으로 읽힌다.
            PanelDraw.text(staleNote, left + creditsWidth + 12, y + 8, smallFont, fg3)
        }
        PanelDraw.right(higgsfieldFormatDday(cycle.daysRemaining), right, y + 3, ddayFont, ddayColor)
        y += 34

        let grantText = cycle.grantAmount.map { L10n.higgsfieldGrant(higgsfieldFormatCredits($0)) } ?? L10n.higgsfieldGrantUnknown
        let grantWidth = PanelDraw.text(grantText, left, y, smallFont, fg3)
        let renewText = cycle.nextRenewalAt != nil
            ? L10n.higgsfieldRenewal(higgsfieldFormatDateTime(cycle.nextRenewalAt))
            : L10n.higgsfieldNoRenewal
        PanelDraw.right(PanelDraw.clipped(renewText, smallFont, maxWidth: right - left - grantWidth - 12), right, y, smallFont, fg2)
        y += 20

        // 주기 진행바(창 경과와 같은 뜻이라 하늘색 눈금으로 끝을 표시한다)
        let barRect = NSRect(x: left, y: y, width: right - left, height: 6)
        PanelDraw.meter(barRect, percent: cycle.elapsedRatio.map { $0 * 100 }, elapsed: cycle.elapsedRatio, thresholdPercent: 101)
        y += 14

        let elapsedText: String = {
            guard let elapsed = cycle.elapsedDays else { return L10n.higgsfieldNoHistory }
            if elapsed < 0 { return L10n.higgsfieldFutureGrant }
            return L10n.higgsfieldElapsed(Int(elapsed), cycle.cycleDays)
        }()
        let elapsedWidth = PanelDraw.text(elapsedText, left, y, smallFont, fg3)

        let basisText: String = {
            if cycle.lastGrantAt == nil { return L10n.higgsfieldNoGrant }
            if cycle.assumedCycle { return L10n.higgsfieldAssumedCycle(cycle.cycleDays) }
            return L10n.higgsfieldMeasuredCycle(cycle.cycleDays, cycle.grantCount)
        }()
        PanelDraw.right(PanelDraw.clipped(basisText, smallFont, maxWidth: right - left - elapsedWidth - 12), right, y, smallFont, fg3)
        y += 22

        // 이번 주기 사용 · 소멸 예상
        let expiryColor: NSColor = {
            guard let expiry = projection.projectedExpiry else { return fg3 }
            return expiry > 0 ? amber : mint
        }()
        let spentWidth = PanelDraw.text(L10n.higgsfieldSpent(higgsfieldFormatCredits(spent)), left, y, bodyFont, fg2)

        let expiryText: String = {
            if let gap = projection.gap {
                return gap == .noGrantHistory ? L10n.higgsfieldExpiryUnknown : L10n.higgsfieldExpiryMeasuring
            }
            let amount = higgsfieldFormatCredits(projection.projectedExpiry)
            if let ratio = projection.projectedExpiryRatio {
                return L10n.higgsfieldExpiryRatio(amount, Int((ratio * 100).rounded()))
            }
            return L10n.higgsfieldExpiry(amount)
        }()
        PanelDraw.right(PanelDraw.clipped(expiryText, bodyFont, maxWidth: right - left - spentWidth - 12), right, y, bodyFont, expiryColor)
        y += 20

        // 근거 한 줄: 추정이라는 사실과 직전 실제 소멸을 같이 말한다.
        var footnotes: [String] = []
        if let reset = higgsfieldSubscriptionResets(data.transactions).first {
            footnotes.append(L10n.higgsfieldLastReset(higgsfieldFormatDate(reset.createdAt), higgsfieldFormatCredits(abs(reset.credits))))
        }
        footnotes.append(L10n.higgsfieldEstimated)
        if !unknown.isEmpty {
            footnotes.append(L10n.higgsfieldUnknownActions(unknown.joined(separator: ", ")))
        }
        if let partial = data.partialError, !partial.isEmpty {
            footnotes.append(L10n.higgsfieldPartial)
        }
        PanelDraw.text(PanelDraw.clipped(footnotes.joined(separator: " · "), smallFont, maxWidth: right - left), left, y, smallFont, fg3)
    }
}
