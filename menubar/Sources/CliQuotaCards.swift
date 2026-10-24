import Cocoa

/// CLI 탭의 쿼터 레인(A안 목록). Grok·agy 두 레인을 한 카드 안에 레인당 두 줄(이름·값 / 막대·보조)로 둔다.
/// 힉스필드는 크레딧·주기·지출까지 실어 정보량이 달라 별도 섹션(HiggsfieldCreditsView)에 그대로 둔다.
/// 높이는 값이 없어도 같다 — "확인 중"도 한 레인이다.
final class CliQuotaLanesView: NSView {
    static let laneHeight: CGFloat = 52
    static let topInset: CGFloat = 4
    static let fixedHeight: CGFloat = topInset * 2 + laneHeight * 2

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

    /// 레인 이름 → 지연 꼬리말. 값은 그대로 두고 낡았다는 사실만 덧붙인다.
    /// 지연이 로그에만 남으면 화면은 멀쩡해 보이고, 그게 이번 사고들의 공통 모양이었다.
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

    private var accessibilityText: String {
        var grokText = "Grok \(grok.headline)"
        if let detail = grok.detail, !detail.isEmpty { grokText += ", \(detail)" }
        if let note = staleNotes["grok"] { grokText += ", \(note)" }
        var agyText = "agy \(agyLogLine(agy))"
        if let note = staleNotes["agy"] { agyText += ", \(note)" }
        return "\(grokText); \(agyText)"
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard bounds.width > 0 else { return }
        let fg = TeamClaudePalette.fg, fg2 = TeamClaudePalette.fg2, fg3 = TeamClaudePalette.fg3
        let x0: CGFloat = 16
        let right = bounds.width - 16
        let label = TeamClaudePalette.bodyMediumFont
        let value = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        let micro = TeamClaudePalette.microFont

        // Grok: 이름 · 값 / 막대(사용률을 알 때) · 보조 문구 · 지연 꼬리말
        let grokY = Self.topInset
        PanelDraw.text("Grok", x0, grokY + 6, label, fg)
        let headline = grok.headline.hasPrefix("Grok ") ? String(grok.headline.dropFirst(5)) : grok.headline
        let percent = burnGrokPercent(grok.headline)
        PanelDraw.right(PanelDraw.clipped(headline, value, maxWidth: right - x0 - 90), right, grokY + 6, value, percent == nil ? fg2 : fg)
        if let notice = grok.notice { ToolNoticeDrawLog.record("grok", notice) }
        var grokTail = grok.detail ?? ""
        if let note = staleNotes["grok"] {
            grokTail = grokTail.isEmpty ? note : "\(grokTail) · \(note)"
        }
        if let percent {
            PanelDraw.meter(NSRect(x: x0, y: grokY + 30, width: (right - x0) * 0.45, height: 6), percent: percent, elapsed: nil)
        }
        if !grokTail.isEmpty {
            let tailX = percent == nil ? x0 : x0 + (right - x0) * 0.45 + 12
            PanelDraw.text(PanelDraw.clipped(grokTail, micro, maxWidth: right - tailX), tailX, grokY + 26, micro, fg3)
        }
        PanelDraw.hairline(x0, right, Self.topInset + Self.laneHeight)

        // agy: 이름 · 첫 레인 / 주간·5시간 두 버킷
        let agyY = Self.topInset + Self.laneHeight
        guard let group = agy.groups.first else {
            PanelDraw.text("agy", x0, agyY + 10, label, fg)
            // 기동 후 한 번도 성공하지 못한 경우가 여기다. 지연 꼬리말을 함께 그리지 않으면
            // 접근성 레이블만 "갱신 없음"을 말하고 화면은 조용해진다(적대 리뷰 2026-09-24).
            let message = agy.message ?? StatusVocabulary.checking
            let line = staleNotes["agy"].map { "\(message) · \($0)" } ?? message
            PanelDraw.right(PanelDraw.clipped(line, value, maxWidth: right - x0 - 60), right, agyY + 10, value, fg2)
            if agy.notice == nil {
                PanelDraw.dot(x0 + 2, centerY: agyY + 38, TeamClaudePalette.sky)
                PanelDraw.text(L10n.agyAskingNote, x0 + 14, agyY + 31, micro, fg3)
            }
            if let notice = agy.notice { ToolNoticeDrawLog.record("agy", notice) }
            return
        }
        // 레인이 여럿이면 첫 줄만 그리고 나머지는 세어서 알린다. 조용히 버리면 화면과
        // 접근성 레이블이 어긋나고, 남은 쿼터를 실제보다 적게 읽게 된다(적대 리뷰 2026-09-24).
        let name = agy.groups.count > 1
            ? L10n.agyMoreLanes(agyDisplayName(group.name), agy.groups.count - 1)
            : agyDisplayName(group.name)
        PanelDraw.text("agy", x0, agyY + 6, label, fg)
        PanelDraw.right(PanelDraw.clipped(name, TeamClaudePalette.captionFont, maxWidth: right - x0 - 60), right, agyY + 7,
                        TeamClaudePalette.captionFont, fg2)
        // 두 버킷을 같은 줄에 나란히.
        let bucketWidth = (right - x0 - 16) / 2
        drawBucket(L10n.weeklyShort, group.weekly, x0, agyY + 26, bucketWidth)
        drawBucket(L10n.codexFiveHours, group.fiveHour, x0 + bucketWidth + 16, agyY + 26, bucketWidth)
        if let note = staleNotes["agy"] {
            PanelDraw.right(note, right, agyY + 6 + 15, micro, fg3)
        }
    }

    /// 버킷 한 칸: 이름 · 남은 양 · 리셋 / 막대(쓴 양을 채운다. 5% 남으면 호박색).
    private func drawBucket(_ title: String, _ bucket: AgyQuotaBucket?, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat) {
        let micro = TeamClaudePalette.microFont
        PanelDraw.text(title, x, y, micro, TeamClaudePalette.fg3)
        guard let bucket, let label = agyRemainingLabel(bucket.remaining) else {
            PanelDraw.right(StatusVocabulary.needsCheck, x + width, y, micro, TeamClaudePalette.fg3)
            return
        }
        var caption = label
        if let hint = agyResetHint(bucket.resetAt, now: Date()) {
            caption += " · \(hint)"
        }
        PanelDraw.right(PanelDraw.clipped(caption, micro, maxWidth: width - 50), x + width, y, micro, TeamClaudePalette.fg)
        let used = min(1, max(0, 1 - bucket.remaining)) * 100
        PanelDraw.meter(NSRect(x: x, y: y + 17, width: width, height: 5), percent: used, elapsed: nil, thresholdPercent: 95)
    }
}
