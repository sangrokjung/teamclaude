import Cocoa

/// 공통 안내 카드. 도구가 없는 섹션의 본문 자리에 놓인다.
final class ToolNoticeView: NSView {
    static let preferredHeight: CGFloat = toolNoticeCardHeight

    var cardID = ""
    var notice: ToolNotice? {
        didSet {
            guard notice != oldValue else { return }
            setAccessibilityLabel(notice.map { "\($0.headline), \($0.detail)" } ?? "")
            needsDisplay = true
        }
    }

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let notice, bounds.width > 0 else { return }
        TeamClaudePalette.panel.setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 8, dy: 4), xRadius: 8, yRadius: 8).fill()
        (notice.headline as NSString).draw(at: NSPoint(x: 24, y: 14), withAttributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: .semibold),
            .foregroundColor: TeamClaudePalette.text,
        ])
        (notice.detail as NSString).draw(at: NSPoint(x: 24, y: 36), withAttributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: TeamClaudePalette.muted,
        ])
        ToolNoticeDrawLog.record(cardID, notice)
    }
}
