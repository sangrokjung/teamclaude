import Cocoa

/// 메뉴 대시보드의 한 섹션(제목 띠 + 본문 + 아래 간격). 좌표는 flipped 문서 기준이다.
/// 배치와 "지금 어느 섹션인가" 판정은 순수 함수라 main.swift 없이 컴파일·테스트된다.
struct DashboardSection: Equatable {
    let id: String        // "claude" | "codex" | "higgsfield" | "cli" | "usage"
    let title: String     // "Claude 풀" | "Codex 풀" | "Higgsfield" | "CLI 쿼터" | "사용량"
    var summary: String   // one-line right-aligned summary, may be ""
    let y: CGFloat        // document y of the header strip (flipped coords)
    let height: CGFloat   // header + body + gap
}

let dashboardSectionHeaderHeight: CGFloat = 28
let dashboardSectionGap: CGFloat = 4

/// Builds the vertical layout. A body height of 0 omits that section. `startY` is where the first header goes (below the summary card).
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

/// The section whose header has scrolled under the pinned header. nil while the summary card (above the first section) is still visible at the top.
func dashboardCurrentSection(_ sections: [DashboardSection], scrollOffset: CGFloat) -> DashboardSection? {
    var current: DashboardSection?
    for s in sections where s.y <= scrollOffset { current = s }
    return current
}

/// Body origin inside a section (below its header strip).
func dashboardSectionBodyY(_ section: DashboardSection) -> CGFloat { section.y + dashboardSectionHeaderHeight }

/// 섹션 제목 띠. 문서 안에서는 섹션마다 하나, 스크롤 뷰 위에는 현재 섹션을 말하는 고정본 하나가 더 뜬다.
final class DashboardSectionHeaderView: NSView {
    var section: DashboardSection? { didSet { if oldValue != section { needsDisplay = true } } }
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard let section else { return }
        TeamClaudePalette.panel.setFill()
        bounds.fill()
        let titleAttrs: [NSAttributedString.Key: Any] = [.font: TeamClaudePalette.headFont, .foregroundColor: TeamClaudePalette.text]
        let summaryAttrs: [NSAttributedString.Key: Any] = [.font: TeamClaudePalette.smallFont, .foregroundColor: TeamClaudePalette.muted]
        (section.title as NSString).draw(at: NSPoint(x: 16, y: 6), withAttributes: titleAttrs)
        let summary = section.summary as NSString
        let w = summary.size(withAttributes: summaryAttrs).width
        summary.draw(at: NSPoint(x: bounds.width - 16 - w, y: 8), withAttributes: summaryAttrs)
        TeamClaudePalette.line.setFill()
        NSRect(x: 0, y: bounds.height - 1, width: bounds.width, height: 1).fill()
    }
}
