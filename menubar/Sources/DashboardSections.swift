import Cocoa

/// 탭 본문 안의 한 섹션(머리 + 본문 + 아래 간격). 좌표는 flipped 탭 문서 기준이다.
/// 배치는 순수 함수라 main.swift 없이 컴파일·테스트된다.
struct DashboardSection: Equatable {
    let id: String        // DashboardTab.sectionIDs 중 하나
    let title: String     // L10n.section* 문구
    var summary: String   // one-line right-aligned summary, may be ""
    let y: CGFloat        // document y of the header strip (flipped coords)
    let height: CGFloat   // header + body + gap
}

let dashboardSectionHeaderHeight: CGFloat = 28
let dashboardSectionGap: CGFloat = 4

/// Builds the vertical layout of one tab. A body height of 0 omits that section. `startY` is where the first header goes.
func dashboardSectionLayout(startY: CGFloat, bodies: [(id: String, title: String, summary: String, height: CGFloat)]) -> (sections: [DashboardSection], totalHeight: CGFloat) {
    var y = startY
    var out: [DashboardSection] = []
    for body in bodies where body.height > 0 {
        let h = dashboardSectionHeaderHeight + body.height + dashboardSectionGap
        out.append(DashboardSection(id: body.id, title: body.title, summary: body.summary, y: y, height: h))
        y += h
    }
    return (out, y)
}

/// Body origin inside a section (below its header strip).
func dashboardSectionBodyY(_ section: DashboardSection) -> CGFloat { section.y + dashboardSectionHeaderHeight }

/// 섹션 머리: 벌린 자간의 메타 라벨(왼쪽)과 한 줄 요약(오른쪽). 면을 칠하지 않는다(A안).
final class DashboardSectionHeaderView: NSView {
    var section: DashboardSection? { didSet { if oldValue != section { needsDisplay = true } } }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard let section else { return }
        let titleAttrs: [NSAttributedString.Key: Any] = [.font: TeamClaudePalette.metaFont, .foregroundColor: TeamClaudePalette.fg3,
                                                         .kern: TeamClaudePalette.metaKern]
        let summaryAttrs: [NSAttributedString.Key: Any] = [.font: TeamClaudePalette.captionFont, .foregroundColor: TeamClaudePalette.fg3]
        (section.title as NSString).draw(at: NSPoint(x: 16, y: 9), withAttributes: titleAttrs)
        let titleWidth = (section.title as NSString).size(withAttributes: titleAttrs).width
        let summary = section.summary as NSString
        let w = summary.size(withAttributes: summaryAttrs).width
        summary.draw(at: NSPoint(x: max(16 + titleWidth + 12, bounds.width - 16 - w), y: 8.5), withAttributes: summaryAttrs)
    }
}

/// CLI 탭 맨 아래: 값이 없는 칸에 쓰는 말 네 가지(StatusVocabulary)와 지연 꼬리말 규칙.
final class EmptyValueVocabularyView: NSView {
    static let preferredHeight: CGFloat = 112
    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(L10n.sectionVocabulary)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func draw(_ dirtyRect: NSRect) {
        let entries: [(String, String)] = [
            (StatusVocabulary.checking, L10n.vocabCheckingDesc), (StatusVocabulary.needsCheck, L10n.vocabNeedsCheckDesc),
            (StatusVocabulary.syncing, L10n.vocabSyncingDesc), (StatusVocabulary.notMeasured, L10n.vocabNotMeasuredDesc),
        ]
        let columnWidth = (bounds.width - 32 - 16) / 2
        for (index, entry) in entries.enumerated() {
            let x = 16 + CGFloat(index % 2) * (columnWidth + 16)
            let y = 4 + CGFloat(index / 2) * 36
            PanelDraw.text(entry.0, x, y, TeamClaudePalette.captionFont, TeamClaudePalette.fg)
            PanelDraw.text(PanelDraw.clipped(entry.1, TeamClaudePalette.captionFont, maxWidth: columnWidth), x, y + 16,
                           TeamClaudePalette.captionFont, TeamClaudePalette.fg3)
        }
        PanelDraw.text(PanelDraw.clipped(L10n.vocabStaleNote, TeamClaudePalette.legendFont, maxWidth: bounds.width - 32), 16, 84,
                       TeamClaudePalette.legendFont, TeamClaudePalette.fg3)
    }
}
