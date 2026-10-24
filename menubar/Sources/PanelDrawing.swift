import Cocoa

// 패널 그리기 부품(menubar/DESIGN.md). 탭 화면들이 같은 점·막대·키캡·버튼을 쓰게 한 곳에 둔다.
// 좌표는 flipped 뷰 기준이다.

/// 상태 톤. 색은 점·짧은 라벨·막대 상태에만 쓴다.
enum PanelTone: Equatable {
    case ready, wait, error, off, info

    var color: NSColor {
        switch self {
        case .ready: return TeamClaudePalette.mint
        case .wait: return TeamClaudePalette.amber
        case .error: return TeamClaudePalette.ember
        case .off: return TeamClaudePalette.fg3
        case .info: return TeamClaudePalette.sky
        }
    }
}

/// 라우팅에서 빼는 사용률 문턱(%) 기본값. 프록시 switchThreshold 0.98과 같다. 막대의 호박색은 여기서부터다.
let panelRoutingThresholdPercent: Double = 98

/// 다 차지 않은 값은 99%에서 멈춘다 — 99.5%를 "100%"로 보이면 찬 것으로 읽힌다.
func panelPercentNumber(_ percent: Double) -> Int {
    guard percent.isFinite else { return 0 }
    if percent >= 100 { return 100 }
    return min(99, max(0, Int(percent.rounded())))
}

func panelPercentText(_ percent: Double?) -> String {
    guard let percent else { return StatusVocabulary.none }
    return "\(panelPercentNumber(percent))%"
}

/// 창이 지난 비율(0~1). 리셋까지 남은 초와 창 길이로 잰다. 범위를 벗어나면 nil(눈금을 그리지 않는다).
func panelWindowElapsed(remainingSeconds: Double?, windowSeconds: Double) -> Double? {
    guard let remainingSeconds, windowSeconds > 0, remainingSeconds > 0, remainingSeconds <= windowSeconds else { return nil }
    let elapsed = (windowSeconds - remainingSeconds) / windowSeconds
    return elapsed > 0 ? elapsed : nil
}

enum PanelDraw {
    static func attrs(_ font: NSFont, _ color: NSColor, kern: CGFloat = 0) -> [NSAttributedString.Key: Any] {
        kern == 0 ? [.font: font, .foregroundColor: color] : [.font: font, .foregroundColor: color, .kern: kern]
    }

    static func width(_ value: String, _ font: NSFont, kern: CGFloat = 0) -> CGFloat {
        (value as NSString).size(withAttributes: attrs(font, .white, kern: kern)).width
    }

    @discardableResult
    static func text(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor, kern: CGFloat = 0) -> CGFloat {
        (value as NSString).draw(at: NSPoint(x: x, y: y), withAttributes: attrs(font, color, kern: kern))
        return width(value, font, kern: kern)
    }

    /// 오른쪽 끝을 x에 맞춰 그린다. 그린 글자의 왼쪽 x를 돌려준다.
    @discardableResult
    static func right(_ value: String, _ x: CGFloat, _ y: CGFloat, _ font: NSFont, _ color: NSColor, kern: CGFloat = 0) -> CGFloat {
        let w = width(value, font, kern: kern)
        text(value, x - w, y, font, color, kern: kern)
        return x - w
    }

    /// 폭을 넘으면 뒤를 "…"로 줄인다.
    static func clipped(_ value: String, _ font: NSFont, maxWidth: CGFloat) -> String {
        guard maxWidth > 0 else { return "" }
        if width(value, font) <= maxWidth { return value }
        var trimmed = value
        while !trimmed.isEmpty, width(trimmed + "…", font) > maxWidth { trimmed.removeLast() }
        return trimmed.isEmpty ? "" : trimmed + "…"
    }

    /// 벌린 자간의 메타 라벨(11pt, fg3).
    @discardableResult
    static func meta(_ value: String, _ x: CGFloat, _ y: CGFloat, color: NSColor = TeamClaudePalette.fg3) -> CGFloat {
        text(value, x, y, TeamClaudePalette.metaFont, color, kern: TeamClaudePalette.metaKern)
    }

    static func fillRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat) {
        color.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
    }

    static func strokeRound(_ rect: NSRect, _ color: NSColor, _ radius: CGFloat, lineWidth: CGFloat = 1) {
        color.setStroke()
        let path = NSBezierPath(roundedRect: rect.insetBy(dx: lineWidth / 2, dy: lineWidth / 2), xRadius: radius, yRadius: radius)
        path.lineWidth = lineWidth
        path.stroke()
    }

    /// 카드: 흰색 2.5% 면 + line 테두리, 반경 11.
    static func card(_ rect: NSRect) {
        fillRound(rect, TeamClaudePalette.bg, 11)
        strokeRound(rect, TeamClaudePalette.line, 11)
    }

    static func hairline(_ x1: CGFloat, _ x2: CGFloat, _ y: CGFloat, color: NSColor = TeamClaudePalette.line) {
        color.setFill()
        NSRect(x: x1, y: y, width: x2 - x1, height: 1).fill()
    }

    /// 7pt 상태 점. 중심 y를 받는다.
    static func dot(_ x: CGFloat, centerY: CGFloat, _ color: NSColor, size: CGFloat = 7) {
        fillRound(NSRect(x: x, y: centerY - size / 2, width: size, height: size), color, size / 2)
    }

    /// 사용률 막대. percent는 0~100(nil이면 트랙만), elapsed는 창 경과 0~1.
    /// 채움은 문턱 미만 ash 85%, 문턱 이상 amber, 빠진 계정(muted) graphite. 눈금은 muted가 아닐 때만 그린다.
    static func meter(_ rect: NSRect, percent: Double?, elapsed: Double?, muted: Bool = false,
                      thresholdPercent: Double = panelRoutingThresholdPercent) {
        let radius = rect.height / 2
        fillRound(rect, TeamClaudePalette.track, radius)
        if let percent, percent.isFinite {
            let share = CGFloat(max(0, min(100, percent)) / 100)
            let full = percent >= thresholdPercent
            let color = muted ? TeamClaudePalette.graphite
                : full ? TeamClaudePalette.amber : TeamClaudePalette.ash.withAlphaComponent(0.85)
            let width = max(rect.width * share, rect.width * 0.03)
            fillRound(NSRect(x: rect.minX, y: rect.minY, width: width, height: rect.height), color, radius)
        }
        if let elapsed, !muted, elapsed > 0, elapsed < 1 {
            let x = rect.minX + rect.width * CGFloat(elapsed) - 1
            let tick = NSRect(x: x, y: rect.minY - 1, width: 2, height: rect.height + 2)
            fillRound(tick.insetBy(dx: -1.5, dy: -1.5), TeamClaudePalette.sheet, 2)
            fillRound(tick, TeamClaudePalette.sky, 1)
        }
    }

    /// 막대 + 오른쪽 값 글자. 값 칸 폭(valueWidth)을 빼고 막대를 그린다.
    static func meterWithValue(_ rect: NSRect, percent: Double?, elapsed: Double?, muted: Bool = false,
                               emptyText: String = StatusVocabulary.none, valueWidth: CGFloat = 36,
                               thresholdPercent: Double = panelRoutingThresholdPercent) {
        let barRect = NSRect(x: rect.minX, y: rect.midY - 3, width: max(0, rect.width - valueWidth - 6), height: 6)
        meter(barRect, percent: percent, elapsed: elapsed, muted: muted, thresholdPercent: thresholdPercent)
        let full = (percent ?? 0) >= thresholdPercent
        let color = percent == nil || muted ? TeamClaudePalette.fg3 : full ? TeamClaudePalette.amber : TeamClaudePalette.fg
        let value = percent.map { "\(panelPercentNumber($0))%" } ?? emptyText
        right(value, rect.maxX, rect.midY - 7.5, TeamClaudePalette.numberFont, color)
    }

    static func keycapWidth(_ key: String) -> CGFloat {
        max(20, width(key, TeamClaudePalette.keycapFont) + 12)
    }

    /// 키캡 칩(높이 20). 그린 폭을 돌려준다.
    @discardableResult
    static func keycap(_ key: String, _ x: CGFloat, centerY: CGFloat, active: Bool = false) -> CGFloat {
        let w = keycapWidth(key)
        let rect = NSRect(x: x, y: centerY - 10 + (active ? 1 : 0), width: w, height: 20)
        fillRound(rect.offsetBy(dx: 0, dy: 1.5), NSColor.black.withAlphaComponent(0.45), 5)
        fillRound(rect, TeamClaudePalette.overlay, 5)
        strokeRound(rect, NSColor.white.withAlphaComponent(0.10), 5)
        let font = TeamClaudePalette.keycapFont
        text(key, rect.minX + (w - width(key, font)) / 2, rect.minY + 3, font, active ? TeamClaudePalette.fg : TeamClaudePalette.fg2)
        return w
    }

    /// 키캡 여러 개(간격 4). 전체 폭.
    static func keycapsWidth(_ keys: [String]) -> CGFloat {
        keys.map(keycapWidth).reduce(0, +) + CGFloat(max(0, keys.count - 1)) * 4
    }

    @discardableResult
    static func keycaps(_ keys: [String], _ x: CGFloat, centerY: CGFloat, active: Bool = false) -> CGFloat {
        var cursor = x
        for key in keys { cursor += keycap(key, cursor, centerY: centerY, active: active) + 4 }
        return cursor - x - (keys.isEmpty ? 0 : 4)
    }
}

/// 패널 버튼(DESIGN.md "버튼"). 주 동작은 ash 면, 나머지는 테두리, 덜 급한 것은 글자만.
final class PanelButton: NSButton {
    enum Style { case primary, ghost, quiet }

    static let height: CGFloat = 26

    var style: Style = .ghost { didSet { needsDisplay = true } }
    var onPress: (() -> Void)?
    private var hovering = false { didSet { needsDisplay = true } }
    private var trackingAreaRef: NSTrackingArea?

    convenience init(title: String, style: Style, onPress: (() -> Void)? = nil) {
        self.init(frame: .zero)
        self.title = title
        self.style = style
        self.onPress = onPress
        isBordered = false
        setButtonType(.momentaryPushIn)
        target = self
        action = #selector(pressed)
        setAccessibilityLabel(title)
        frame.size = NSSize(width: fittingWidth, height: Self.height)
    }

    var fittingWidth: CGFloat { ceil(PanelDraw.width(title, TeamClaudePalette.buttonFont)) + 22 }

    @objc private func pressed() { onPress?() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let trackingAreaRef { removeTrackingArea(trackingAreaRef) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        addTrackingArea(area)
        trackingAreaRef = area
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }

    override func draw(_ dirtyRect: NSRect) {
        let rect = bounds
        let pressedDown = isHighlighted
        let color: NSColor
        switch style {
        case .primary:
            PanelDraw.fillRound(rect, hovering || pressedDown ? TeamClaudePalette.fg : TeamClaudePalette.ash, 8)
            color = TeamClaudePalette.ashInk
        case .ghost:
            if hovering || pressedDown { PanelDraw.fillRound(rect, NSColor.white.withAlphaComponent(0.04), 8) }
            PanelDraw.strokeRound(rect, hovering ? TeamClaudePalette.fg3 : TeamClaudePalette.graphite, 8)
            color = TeamClaudePalette.fg
        case .quiet:
            if hovering || pressedDown { PanelDraw.fillRound(rect, NSColor.white.withAlphaComponent(0.06), 8) }
            color = hovering ? TeamClaudePalette.fg : TeamClaudePalette.fg2
        }
        let font = TeamClaudePalette.buttonFont
        let w = PanelDraw.width(title, font)
        PanelDraw.text(title, rect.minX + (rect.width - w) / 2, rect.minY + (rect.height - 15) / 2, font, color)
    }

    override var isFlipped: Bool { true }
}

/// 자식 뷰를 위에서부터 쌓는 flipped 컨테이너(탭 본문 문서).
final class PanelFlippedView: NSView {
    override var isFlipped: Bool { true }
}
