import Cocoa

@main
struct DashboardSectionsTests {
    static func main() {
        testLayoutIsOneContinuousDocument()
        testCurrentSectionFollowsScrollOffset()
        testHeaderDrawsOffscreen()
        print("DashboardSectionsTests: layout, current section, header draw passed")
    }

    static func bodies(higgsfield: CGFloat = 0) -> [(id: String, title: String, summary: String, height: CGFloat)] {
        [
            (id: "claude", title: "Claude 풀", summary: "계정 16 · 사용 가능 3", height: 1408),
            (id: "codex", title: "Codex 풀", summary: "온라인 · 사용 가능 5/7", height: 420),
            (id: "higgsfield", title: "Higgsfield", summary: "", height: higgsfield),
            (id: "cli", title: "CLI 쿼터", summary: "Grok · Agy", height: 200),
            (id: "usage", title: "사용량", summary: "", height: 300),
        ]
    }

    static func testLayoutIsOneContinuousDocument() {
        let layout = dashboardSectionLayout(startY: 404, bodies: bodies())
        precondition(layout.sections.count == 4, "a 0pt body is omitted: \(layout.sections.map(\.id))")
        precondition(layout.sections.map(\.id) == ["claude", "codex", "cli", "usage"])
        precondition(layout.sections.map(\.title) == ["Claude 풀", "Codex 풀", "CLI 쿼터", "사용량"])
        // 리터럴을 한 식에 몰면 타입 검사가 터진다(워커 실측). 섹션 높이를 상수로 먼저 잡는다.
        let claudeHeight: CGFloat = 28 + 1408 + 4   // 1440
        let codexHeight: CGFloat = 28 + 420 + 4     // 452
        let cliHeight: CGFloat = 28 + 200 + 4       // 232
        let usageHeight: CGFloat = 28 + 300 + 4     // 332
        precondition(layout.sections[0].y == 404)
        precondition(layout.sections[0].height == claudeHeight, "no clamp on a tall account table: \(layout.sections[0].height)")
        precondition(layout.sections[1].y == 404 + claudeHeight, "\(layout.sections[1].y)")
        precondition(layout.sections[1].y == 1844)
        precondition(layout.sections[2].y == 1844 + codexHeight)
        precondition(layout.sections[2].y == 2296)
        precondition(layout.sections[3].y == 2296 + cliHeight)
        precondition(layout.sections[3].y == 2528)
        let expectedTotal: CGFloat = 404 + claudeHeight + codexHeight + cliHeight + usageHeight
        precondition(expectedTotal == 2860)
        precondition(layout.totalHeight == expectedTotal, "\(layout.totalHeight) != \(expectedTotal)")
        for (previous, next) in zip(layout.sections, layout.sections.dropFirst()) {
            precondition(next.y == previous.y + previous.height, "\(previous.id) → \(next.id) must be contiguous")
        }
        precondition(dashboardSectionBodyY(layout.sections[0]) == 404 + 28)
        precondition(layout.sections[0].summary == "계정 16 · 사용 가능 3")

        let withHiggsfield = dashboardSectionLayout(startY: 404, bodies: bodies(higgsfield: 148))
        let higgsfieldHeight: CGFloat = 28 + 148 + 4  // 180
        precondition(withHiggsfield.sections.count == 5)
        precondition(withHiggsfield.sections[2].id == "higgsfield")
        precondition(withHiggsfield.totalHeight == expectedTotal + higgsfieldHeight)

        let empty = dashboardSectionLayout(startY: 404, bodies: [])
        precondition(empty.sections.isEmpty && empty.totalHeight == 404)
    }

    static func testCurrentSectionFollowsScrollOffset() {
        let sections = dashboardSectionLayout(startY: 404, bodies: bodies()).sections
        precondition(dashboardCurrentSection(sections, scrollOffset: 0) == nil, "the summary card is still on top")
        precondition(dashboardCurrentSection(sections, scrollOffset: 403) == nil)
        precondition(dashboardCurrentSection(sections, scrollOffset: 404)?.id == "claude")
        precondition(dashboardCurrentSection(sections, scrollOffset: 1843)?.id == "claude")
        precondition(dashboardCurrentSection(sections, scrollOffset: 1844)?.id == "codex")
        precondition(dashboardCurrentSection(sections, scrollOffset: 99_999)?.id == "usage")
        precondition(dashboardCurrentSection([], scrollOffset: 99_999) == nil)
    }

    static func testHeaderDrawsOffscreen() {
        _ = NSApplication.shared
        let header = DashboardSectionHeaderView(frame: NSRect(x: 0, y: 0, width: 880, height: 28))
        header.section = DashboardSection(id: "claude", title: "Claude 풀", summary: "계정 16 · 사용 가능 3", y: 404, height: 1440)
        header.layoutSubtreeIfNeeded()
        guard let representation = header.bitmapImageRepForCachingDisplay(in: header.bounds) else {
            preconditionFailure("bitmap rep for the section header must exist")
        }
        header.cacheDisplay(in: header.bounds, to: representation)
        precondition(representation.pixelsWide > 0 && representation.pixelsHigh > 0)

        // 요약이 비어도(제목만) 그리고, section이 nil이면 아무것도 그리지 않는다.
        header.section = DashboardSection(id: "usage", title: "사용량", summary: "", y: 0, height: 332)
        header.cacheDisplay(in: header.bounds, to: representation)
        header.section = nil
        header.cacheDisplay(in: header.bounds, to: representation)
    }
}
