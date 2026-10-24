// menubar/Tests/DashboardPanelTests.swift
import Cocoa

// 패널 셸(A안)의 순수 판정: 탭 구성, 단축키, 막대 수치, 상태 묶음 배치.
@main
struct DashboardPanelTests {
    static func main() {
        testTabsCoverEverySectionOnce()
        testShortcuts()
        testMeterNumbers()
        testGroupedLayout()
        testShellDrawsOffscreen()
        print("DashboardPanelTests: tabs, shortcuts, meter numbers, grouped layout, shell draw passed")
    }

    static func testTabsCoverEverySectionOnce() {
        precondition(DashboardTab.allCases.count == 5)
        precondition(DashboardTab.allCases.map(\.id) == ["overview", "claude", "codex", "burn", "cli"])
        let all = DashboardTab.allCases.flatMap(\.sectionIDs)
        precondition(Set(all).count == all.count, "a section must live in exactly one tab: \(all)")
        // 예전 대시보드 섹션 전부 + 새 개요·빈 값 어휘. 하나라도 빠지면 기능이 사라진다.
        for id in ["overview", "burn", "claude", "codex", "higgsfield", "cli", "usage", "vocabulary"] {
            precondition(DashboardTab.containing(section: id) != nil, "section \(id) has no tab")
        }
        precondition(DashboardTab.containing(section: "usage") == .burn, "ccusage cost lives in the burn tab")
        precondition(DashboardTab.containing(section: "higgsfield") == .cli)
        L10n.language = .ko
        precondition(DashboardTab.allCases.map(\.title) == ["개요", "Claude", "Codex", "소진", "CLI"])
        L10n.language = .en
        precondition(DashboardTab.allCases.map(\.title) == ["Overview", "Claude", "Codex", "Burn", "CLI"])
        L10n.language = .ko
    }

    static func testShortcuts() {
        precondition(DashboardShortcut.resolve(characters: "k", command: true, otherModifiers: false) == .toggleActions)
        precondition(DashboardShortcut.resolve(characters: "K", command: true, otherModifiers: false) == .toggleActions)
        precondition(DashboardShortcut.resolve(characters: "k", command: false, otherModifiers: false) == nil)
        precondition(DashboardShortcut.resolve(characters: "r", command: false, otherModifiers: false) == .refresh)
        precondition(DashboardShortcut.resolve(characters: "r", command: false, otherModifiers: true) == nil)
        precondition(DashboardShortcut.resolve(characters: "r", command: true, otherModifiers: false) == .refresh, "⌘R from the old menu still refreshes")
        precondition(DashboardShortcut.resolve(characters: "1", command: true, otherModifiers: false) == nil)
        // 등록하는 키 등가는 전부 판정이 있다(메뉴 항목과 판정이 갈리지 않는다).
        for entry in DashboardShortcut.keyEquivalents {
            precondition(DashboardShortcut.resolve(characters: entry.key, command: entry.command, otherModifiers: false) != nil, entry.key)
        }
        precondition(DashboardShortcut.keyEquivalents.count == 3 + DashboardTab.allCases.count)
        for tab in DashboardTab.allCases {
            precondition(DashboardShortcut.resolve(characters: tab.shortcutKey, command: false, otherModifiers: false) == .tab(tab))
        }
        precondition(DashboardShortcut.resolve(characters: "6", command: false, otherModifiers: false) == nil)
        precondition(DashboardShortcut.resolve(characters: "0", command: false, otherModifiers: false) == nil)
    }

    static func testMeterNumbers() {
        // 다 차지 않은 값은 99%에서 멈춘다.
        precondition(panelPercentNumber(99.5) == 99)
        precondition(panelPercentNumber(100) == 100)
        precondition(panelPercentNumber(-3) == 0)
        precondition(panelPercentNumber(.nan) == 0)
        precondition(panelPercentText(nil) == StatusVocabulary.none)
        // 경고색 문턱은 라우팅 문턱 98%(예전 70%·90% 색 단계는 없다).
        precondition(panelRoutingThresholdPercent == 98)
        // 창 경과: 7일 창에서 6일 남으면 1/7 경과. 창 밖이면 눈금이 없다.
        let week: Double = 7 * 86_400
        precondition(abs((panelWindowElapsed(remainingSeconds: 6 * 86_400, windowSeconds: week) ?? 0) - 1.0 / 7) < 1e-9)
        precondition(panelWindowElapsed(remainingSeconds: nil, windowSeconds: week) == nil)
        precondition(panelWindowElapsed(remainingSeconds: 0, windowSeconds: week) == nil)
        precondition(panelWindowElapsed(remainingSeconds: week + 1, windowSeconds: week) == nil)
        precondition(panelWindowElapsed(remainingSeconds: week, windowSeconds: week) == nil, "0% elapsed draws no tick")
    }

    static func testGroupedLayout() {
        let compact = TeamClaudeRowLines.compact
        let reason = TeamClaudeRowLines(reason: true, subscription: false)
        let groups: [TeamClaudeRowGroup] = [.excluded, .ready, .limited, .ready]
        let lines: [TeamClaudeRowLines] = [reason, compact, compact, compact]
        let layout = teamClaudeGroupedLayout(groups: groups, lines: lines, expanded: nil)
        precondition(layout.order == [1, 3, 2, 0], "ready → limited → excluded, original order inside a group: \(layout.order)")
        precondition(layout.headings.map(\.group) == [.ready, .limited, .excluded])
        precondition(layout.headings.map(\.count) == [2, 1, 1])
        let head = TeamClaudeRowMetrics.groupHeadHeight
        let compactStride = teamClaudeRowStride(compact)
        precondition(layout.origins[1] == head)
        precondition(layout.origins[3] == head + compactStride)
        precondition(layout.origins[2] == head * 2 + compactStride * 2)
        precondition(layout.origins[0] == head * 3 + compactStride * 3)
        precondition(layout.height == head * 3 + compactStride * 3 + teamClaudeRowStride(reason))
        // 펼친 행만큼 아래 행들이 내려가고 전체가 길어진다.
        let expanded = teamClaudeGroupedLayout(groups: groups, lines: lines, expanded: 1)
        precondition(expanded.origins[3] == head + compactStride + TeamClaudeRowMetrics.detailHeight)
        precondition(expanded.height == layout.height + TeamClaudeRowMetrics.detailHeight)
        precondition(teamClaudeDetailY(reason) == teamClaudeRowHeight(reason))
        let empty = teamClaudeGroupedLayout(groups: [], lines: [], expanded: nil)
        precondition(empty.order.isEmpty && empty.headings.isEmpty && empty.height == 0)
    }

    static func testShellDrawsOffscreen() {
        _ = NSApplication.shared
        for view in [DashboardPanelHeaderView(frame: NSRect(x: 0, y: 0, width: 520, height: DashboardPanelHeaderView.preferredHeight)),
                     DashboardPanelFooterView(frame: NSRect(x: 0, y: 0, width: 520, height: DashboardPanelFooterView.preferredHeight))] as [NSView] {
            guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { preconditionFailure("bitmap") }
            view.cacheDisplay(in: view.bounds, to: rep)
            precondition(rep.pixelsWide > 0)
        }
        // 탭 세그먼트는 겹치지 않고 패널 안에 든다.
        let rects = DashboardPanelHeaderView.tabSegmentRects(width: 520).map(\.1)
        precondition(rects.count == 5)
        for (a, b) in zip(rects, rects.dropFirst()) { precondition(!a.intersects(b) && a.maxX <= b.minX + 0.001) }
        precondition(rects.first!.minX >= 16 && rects.last!.maxX <= 504)
        // 동작 목록 높이: 묶음 머리 + 행.
        let actions = [
            DashboardAction(id: "a", group: .refresh, title: "a", detail: "") { nil },
            DashboardAction(id: "b", group: .refresh, title: "b", detail: "") { nil },
            DashboardAction(id: "c", group: .app, title: "c", detail: "") { nil },
        ]
        precondition(DashboardActionListView.preferredHeight(actions)
                     == 12 + DashboardActionListView.groupHeadHeight * 2 + DashboardActionListView.rowHeight * 3)
    }
}
