// menubar/Tests/OverviewStripTests.swift
import Cocoa

// 개요 탭 띠·대기 문구가 계정 수와 무관하게 뷰 안에 들어가는지(Phase 2 리뷰 Important).
// 17·100·250계정으로 실제 OverviewTabView를 오프스크린에 그리고, 그린 칸 사각형과 그린 글자를 본다.
@main
struct OverviewStripTests {
    static let viewWidth: CGFloat = 520  // StatusMenuDashboardView.preferredWidth와 같은 폭

    static func column(_ index: Int) -> OverviewStripColumn {
        let excluded = index % 11 == 10
        let wait = !excluded && index % 7 == 6
        return OverviewStripColumn(
            name: String(format: "acct-%03d", index + 1), label: excluded ? "오류" : (wait ? "한도 대기" : "사용 가능"),
            tone: excluded ? .error : (wait ? .wait : .ready),
            weeklyPercent: Double(index % 10) * 10, sessionPercent: 20, fablePercent: nil,
            weeklyElapsed: excluded ? nil : 0.4, excluded: excluded, cap: excluded ? .error : nil)
    }

    static func model(accounts: Int) -> OverviewModel {
        var model = OverviewModel()
        model.routable = accounts / 2
        model.total = accounts
        model.headline = "Claude 계정이 지금 요청을 받습니다."
        model.lanes = [OverviewLane(name: "Claude Fable", value: "1", unit: "/ \(accounts)", note: "n", tab: .claude, quiet: false)]
        model.strip = (0..<accounts).map(column)
        model.readyCount = model.strip.filter { $0.tone == .ready }.count
        model.waitCount = model.strip.filter { $0.tone == .wait }.count
        model.excludedCount = model.strip.filter { $0.excluded }.count
        model.waitingNames = model.strip.filter { $0.tone == .wait }.map(\.name)
        model.waitingCaption = model.waitingNames.isEmpty ? nil : L10n.waitingCaption(model.waitingNames.joined(separator: " · "))
        return model
    }

    static func render(_ model: OverviewModel) -> OverviewTabView {
        let view = OverviewTabView(frame: NSRect(x: 0, y: 0, width: viewWidth, height: OverviewTabView.preferredHeight(model)))
        view.model = model
        view.layoutSubtreeIfNeeded()
        guard let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            preconditionFailure("bitmap rep for the overview must exist")
        }
        DrawnTextRecorder.reset()
        view.cacheDisplay(in: view.bounds, to: representation)
        return view
    }

    static func main() {
        _ = NSApplication.shared
        DrawnTextRecorder.install()
        L10n.language = .ko
        testAccountsStayInsideTheView()
        testBucketKeepsStatusMeaning()
        testWaitingCaptionShowsRemainder()
        testBucketClickOpensClaudeTab()
        testBucketBandPriority()
        L10n.language = .en
        precondition(L10n.andMore(4) == "+4 more", L10n.andMore(4))
        precondition(L10n.stripBucketNote(total: 250, perSlot: 4) == "250 accounts · 4 per bar", L10n.stripBucketNote(total: 250, perSlot: 4))
        print("OverviewStripTests: 17/100/250 accounts inside bounds, buckets, waiting remainder passed")
    }

    static func testAccountsStayInsideTheView() {
        let chartWidth = viewWidth - OverviewTabView.padding * 2
        let maxColumns = OverviewStripMetrics.maxColumns(chartWidth: chartWidth)
        precondition(maxColumns >= 20 && maxColumns < 100, "max visible columns at \(chartWidth)pt: \(maxColumns)")
        for accounts in [17, 100, 250] {
            let model = model(accounts: accounts)
            let view = render(model)
            let rects = view.columnRects.map(\.1)
            precondition(!rects.isEmpty)
            precondition(rects.count <= maxColumns, "\(accounts): \(rects.count) columns > \(maxColumns)")
            for rect in rects {
                precondition(rect.minX >= OverviewTabView.padding - 0.01 && rect.maxX <= viewWidth - OverviewTabView.padding + 0.01,
                              "\(accounts): column \(rect) outside the chart")
                precondition(view.bounds.contains(rect), "\(accounts): column \(rect) outside \(view.bounds)")
                precondition(rect.width >= OverviewStripMetrics.minColumnWidth - 0.01, "\(accounts): column too thin \(rect.width)")
            }
            for (left, right) in zip(rects, rects.dropFirst()) {
                precondition(right.minX >= left.maxX, "\(accounts): columns overlap \(left) \(right)")
            }
            let slots = overviewStripSlots(model.strip, maxColumns: maxColumns)
            precondition(slots.count == rects.count)
            precondition(slots.reduce(0) { $0 + $1.memberCount } == accounts, "\(accounts): every account lands in a column")
            let drawn = DrawnTextRecorder.strings
            let caption = drawn.first { $0.hasPrefix("기다리면 풀림") }
            if accounts == 17 {
                precondition(slots.allSatisfy { $0.memberCount == 1 }, "17 accounts fit one column each")
                precondition(!drawn.contains { $0.contains("묶음") }, "no bucket note when every account fits")
                precondition(caption?.contains("외 ") == false, "two waiting names fit: \(caption ?? "nil")")
                precondition(caption?.contains("acct-007") == true && caption?.contains("acct-014") == true, caption ?? "nil")
            } else {
                let perSlot = slots.map(\.memberCount).max() ?? 0
                precondition(perSlot > 1, "\(accounts) accounts must be bucketed")
                let note = L10n.stripBucketNote(total: accounts, perSlot: perSlot)
                precondition(note.contains("\(accounts)개") && note.contains("묶음"), note)
                precondition(drawn.contains(note), "\(accounts): bucket note not drawn: \(drawn.filter { $0.contains("계정") })")
                guard let caption else { preconditionFailure("\(accounts): waiting caption not drawn") }
                let waiting = model.waitingNames.count
                let shown = model.waitingNames.filter { caption.contains($0) }.count
                precondition(shown >= 1 && shown < waiting, "\(accounts): shown \(shown) of \(waiting)")
                precondition(caption.contains("외 \(waiting - shown)개"), "\(accounts): remainder missing in \(caption)")
                precondition(!caption.contains("…"), "\(accounts): caption must fit without clipping: \(caption)")
                let maxWidth = viewWidth - OverviewTabView.padding * 2 - 20
                precondition(PanelDraw.width(caption, TeamClaudePalette.captionFont) <= maxWidth, "\(accounts): caption too wide")
            }
        }
    }

    /// 한 계정짜리 칸은 그 계정을 열고, 여러 계정을 묶은 칸은 모든 구성원이 보이는 Claude 탭을 연다.
    static func testBucketClickOpensClaudeTab() {
        for accounts in [17, 250] {
            let view = render(model(accounts: accounts))
            let slots = overviewStripSlots(model(accounts: accounts).strip,
                                           maxColumns: OverviewStripMetrics.maxColumns(chartWidth: viewWidth - OverviewTabView.padding * 2))
            for (slot, (_, rect)) in zip(slots, view.columnRects) {
                let target = view.stripClickTarget(at: NSPoint(x: rect.midX, y: rect.midY))
                if slot.memberCount == 1 {
                    precondition(target == .account(slot.column.name), "\(accounts): single column → \(String(describing: target))")
                } else {
                    precondition(target == .claudeTab, "\(accounts): bucket of \(slot.memberCount) → \(String(describing: target))")
                }
            }
        }
    }

    static func testBucketKeepsStatusMeaning() {
        func col(_ tone: PanelTone, weekly: Double?, excluded: Bool = false, cap: PanelTone? = nil) -> OverviewStripColumn {
            OverviewStripColumn(name: "a\(weekly ?? -1)", label: "", tone: tone, weeklyPercent: weekly, sessionPercent: nil,
                                fablePercent: nil, weeklyElapsed: excluded ? nil : 0.5, excluded: excluded, cap: cap)
        }
        // 넷씩 묶이도록 칸 수를 1로 둔다.
        let mixed = overviewStripSlots([col(.ready, weekly: 20), col(.wait, weekly: 99), col(.ready, weekly: 40),
                                        col(.error, weekly: 90, excluded: true, cap: .error)], maxColumns: 1)
        precondition(mixed.count == 1 && mixed[0].memberCount == 4 && mixed[0].firstIndex == 0)
        let slot = mixed[0]
        precondition(slot.readyCount == 2 && slot.waitCount == 1 && slot.excludedCount == 1)
        precondition(slot.column.tone == .wait, "a waiting member keeps the amber tone")
        precondition(!slot.column.excluded, "a bucket with routable members is not dimmed")
        precondition(slot.column.cap == .error, "an error member keeps the red cap visible")
        precondition(slot.column.weeklyPercent == 53, "mean of routable members: \(String(describing: slot.column.weeklyPercent))")
        precondition(slot.column.weeklyElapsed == 0.5)

        let ready = overviewStripSlots([col(.ready, weekly: 10), col(.ready, weekly: 30)], maxColumns: 1)[0]
        precondition(ready.column.tone == .ready && ready.column.cap == nil && ready.column.weeklyPercent == 20)

        let off = overviewStripSlots([col(.off, weekly: 10, excluded: true, cap: .off),
                                      col(.off, weekly: nil, excluded: true, cap: .off)], maxColumns: 1)[0]
        precondition(off.column.excluded && off.column.tone == .off && off.column.cap == .off)
        precondition(off.column.weeklyPercent == 10 && off.column.weeklyElapsed == nil)

        // 칸이 넉넉하면 그대로 한 칸씩(값을 바꾸지 않는다).
        let plain = [col(.ready, weekly: 10), col(.wait, weekly: 99)]
        let unbucketed = overviewStripSlots(plain, maxColumns: 10)
        precondition(unbucketed.map(\.column) == plain && unbucketed.map(\.firstIndex) == [0, 1])
        precondition(overviewStripSlots([], maxColumns: 10).isEmpty)

        // 남는 칸 없이 고르게: 250개를 63칸이면 칸마다 4개, 마지막 칸은 2개.
        let many = (0..<250).map(column)
        let buckets = overviewStripSlots(many, maxColumns: 63)
        precondition(buckets.count == 63 && buckets.first?.memberCount == 4 && buckets.last?.memberCount == 2)
        precondition(buckets.map(\.firstIndex) == Array(stride(from: 0, to: 250, by: 4)))
    }

    static func testWaitingCaptionShowsRemainder() {
        let font = TeamClaudePalette.captionFont
        let short = overviewWaitingCaption(["acct-16", "acct-17"], font: font, maxWidth: 400)
        precondition(short == L10n.waitingCaption("acct-16 · acct-17"), short)
        let names = (1...40).map { String(format: "acct-%03d", $0) }
        let fitted = overviewWaitingCaption(names, font: font, maxWidth: 400)
        precondition(PanelDraw.width(fitted, font) <= 400, fitted)
        let shown = names.filter { fitted.contains($0) }.count
        precondition(shown >= 1 && fitted.contains("외 \(40 - shown)개"), fitted)
        // 이름 하나도 안 들어가는 폭이어도 남은 개수는 남긴다(이름을 줄인다).
        let long = ["very-long-account-name-that-cannot-possibly-fit-\(String(repeating: "x", count: 60))", "b", "c"]
        let narrow = overviewWaitingCaption(long, font: font, maxWidth: 260)
        precondition(PanelDraw.width(narrow, font) <= 260 && narrow.contains("외 2개") && narrow.contains("…"), narrow)
        precondition(overviewWaitingCaption([], font: font, maxWidth: 400).isEmpty)
    }

    /// 묶인 칸의 띠: 오류 > 대기 > 사용 가능 > 꺼 둠(검토 지적 2026-10-26 — 혼합 묶음에서 색이 사라졌다).
    static func testBucketBandPriority() {
        func member(_ tone: PanelTone, excluded: Bool = false, cap: PanelTone? = nil) -> OverviewStripColumn {
            OverviewStripColumn(name: "m", label: "", tone: tone, weeklyPercent: 50, sessionPercent: nil, fablePercent: nil,
                                weeklyElapsed: 0.4, excluded: excluded, cap: cap)
        }
        func band(_ members: [OverviewStripColumn]) -> PanelTone? {
            let slot = overviewStripSlots(members, maxColumns: 1)[0].column
            return slot.cap ?? overviewStripStateBand(slot.tone)
        }
        precondition(band([member(.ready), member(.error, excluded: true, cap: .error)]) == .error)
        precondition(band([member(.ready), member(.wait)]) == .wait)
        precondition(band([member(.ready), member(.off, excluded: true, cap: .off)]) == .ready)
        precondition(band([member(.off, excluded: true, cap: .off), member(.off, excluded: true, cap: .off)]) == .off)
    }
}
