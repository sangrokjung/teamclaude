import Cocoa

// 모델 탭 본문(ModelUsageTabView): 높이 판정·고르기 경로·오프스크린 그리기.
@main
struct ModelUsageTabLayoutTests {
    static func main() {
        _ = NSApplication.shared
        L10n.language = .ko
        testHeightFollowsLayoutAndGapNote()
        testSelectionCallsBack()
        testDrawsWithoutCrashAndRecordsText()
        testEmptyState()
        print("ModelUsageTabLayoutTests: height, selection, draw, empty passed")
    }

    static let fixture = """
    {"schema":1,"generatedAt":"2026-11-02T03:00:00Z","today":"2026-11-02","since":"2026-10-20",
     "coverage":{"claudeCompleteFrom":"2026-10-21","claudeRetentionDays":14,"codexCliLastDay":"2026-11-02","receiptFirstDay":"2026-10-20"},
     "daily":[
      {"date":"2026-10-20","lane":"claude","model":"claude-opus-5","source":"claude-code","input":1,"output":2,"cacheRead":3,"cacheWrite":4,"calls":10},
      {"date":"2026-10-30","lane":"claude","model":"claude-opus-5","source":"claude-code","input":1,"output":2,"cacheRead":3,"cacheWrite":4,"calls":30},
      {"date":"2026-11-01","lane":"codex","model":"gpt-6.1-sol","source":"codex-cli","input":100,"output":20,"cacheRead":300,"cacheWrite":0,"calls":5}],
     "receipts":{"audit":{},"daily":[]},"implLoop":{"daily":[]},"pro200":{"mid":100,"lo":50,"hi":200},
     "quotaCycles":{"since":null,"daily":[]},
     "pools":{"claude":{"available":true,"threshold":0.98,"accounts":[{"label":"C01","util7d":0.5,"reset7d":null,"usable":true,"enabled":true}]},
              "codex":{"available":false,"accounts":[]}}}
    """

    static var report: ModelUsageReport { ModelUsageReport.parse(Data(fixture.utf8))! }

    static func testHeightFollowsLayoutAndGapNote() {
        let week = ModelUsageTabView.preferredHeight(report, selection: ModelUsageSelection(range: .week, metric: .calls))
        let all = ModelUsageTabView.preferredHeight(report, selection: ModelUsageSelection(range: .all, metric: .calls))
        precondition(all > week, "the all range starts inside the Claude gap and adds a warning block: \(week) \(all)")
        let layout = ModelUsageLayout.make(makeModelUsagePresentation(report, ModelUsageSelection()), width: 520)
        precondition(layout.gap == nil && layout.height == week)
        let blocks = [layout.controls, layout.hero, layout.sources, layout.claudeChart, layout.codexChart, layout.models,
                      layout.claudePool, layout.codexPool, layout.cycles, layout.facts, layout.collected]
        for (a, b) in zip(blocks, blocks.dropFirst()) { precondition(b.minY >= a.maxY, "blocks must not overlap: \(a) \(b)") }
        precondition(layout.collected.maxY <= layout.height)
        precondition(ModelUsageTabView.preferredHeight(nil, selection: ModelUsageSelection()) == ModelUsageTabView.emptyHeight)
    }

    static func testSelectionCallsBack() {
        let view = ModelUsageTabView(frame: NSRect(x: 0, y: 0, width: 520, height: 600))
        view.report = report
        var seen: [ModelUsageSelection] = []
        view.onSelectionChange = { seen.append($0) }
        view.select(ModelUsageSelection(range: .all, metric: .output))
        view.select(ModelUsageSelection(range: .all, metric: .output))
        precondition(seen == [ModelUsageSelection(range: .all, metric: .output)], "same selection does not call back twice")
        precondition(view.presentation?.selection.metric == .output)
        precondition(ModelUsageTabView.summary(report, selection: ModelUsageSelection()).hasPrefix("7일 · Claude 30 호출"),
                     ModelUsageTabView.summary(report, selection: ModelUsageSelection()))
    }

    static func render(_ view: NSView) {
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { preconditionFailure("bitmap") }
        view.cacheDisplay(in: view.bounds, to: rep)
    }

    static func testDrawsWithoutCrashAndRecordsText() {
        DrawnTextRecorder.install()
        for metric in ModelUsageMetric.allCases {
            for range in ModelUsageRange.allCases {
                let selection = ModelUsageSelection(range: range, metric: metric)
                let view = ModelUsageTabView(frame: NSRect(x: 0, y: 0, width: 520,
                                                           height: ModelUsageTabView.preferredHeight(report, selection: selection)))
                view.report = report
                view.selection = selection
                DrawnTextRecorder.reset()
                render(view)
                let texts = DrawnTextRecorder.strings
                for expected in ["출처별", "날짜별", "계정 풀 주간 사용률", "Claude 5시간 주기 소진 이력", "Codex 적대 검증", "Codex 구현 루프"] {
                    precondition(texts.contains(expected), "missing \(expected) in \(range) \(metric)")
                }
                precondition(texts.contains("추정") && !texts.contains("하한"), "the CLI log runs to today → estimate badge without lower bound")
            }
        }
    }

    static func testEmptyState() {
        DrawnTextRecorder.install()
        let view = ModelUsageTabView(frame: NSRect(x: 0, y: 0, width: 520, height: ModelUsageTabView.emptyHeight))
        DrawnTextRecorder.reset()
        render(view)
        precondition(DrawnTextRecorder.strings.contains(L10n.modelEmptyTitle))
        precondition(ModelUsageTabView.summary(nil, selection: ModelUsageSelection()) == L10n.modelEmptyTitle)
    }
}
