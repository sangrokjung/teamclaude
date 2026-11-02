import Foundation

// 모델 탭 표시 로직(ModelUsage.swift). 수집기 JSON(scripts/model-usage-collector.py, schema 1)을 읽어 화면 값으로 바꾼다.
@main
struct ModelUsageTests {
    static func main() {
        L10n.language = .ko
        testParseAndReject()
        testPeriodsAndClaudeDelta()
        testCodexProConversionAndLowerBound()
        testSourcesKeepTheirOwnUnits()
        testDailyBarsMarkGaps()
        testModelRowsAndWeeks()
        testPoolsCyclesAndFacts()
        testCountFormat()
        testAllRangeCoversEveryKeptDay()
        testAllRangeIncludesCycleOnlyDays()
        print("ModelUsageTests: parse, periods, pro, sources, gaps, models, pools, format passed")
    }

    static func row(_ date: String, _ lane: String, _ model: String, _ source: String, calls: Int, input: Int = 0, output: Int = 0,
                    cacheRead: Int = 0, cacheWrite: Int = 0) -> String {
        """
        {"date":"\(date)","lane":"\(lane)","model":"\(model)","source":"\(source)","input":\(input),"output":\(output),"cacheRead":\(cacheRead),"cacheWrite":\(cacheWrite),"calls":\(calls)}
        """
    }

    static let json: String = {
        let rows = [
            row("2026-10-20", "claude", "claude-opus-5", "claude-code", calls: 100, input: 10, output: 50, cacheRead: 1000, cacheWrite: 40),
            row("2026-10-27", "claude", "claude-opus-5", "claude-code", calls: 300, input: 10, output: 90, cacheRead: 2000, cacheWrite: 0),
            row("2026-11-01", "claude", "claude-opus-5", "claude-code", calls: 200, input: 10, output: 70, cacheRead: 500, cacheWrite: 20),
            row("2026-11-02", "claude", "claude-sonnet-5", "claude-code", calls: 50, input: 5, output: 30, cacheRead: 100, cacheWrite: 0),
            row("2026-10-28", "codex", "gpt-6.1-sol", "codex-cli", calls: 40, input: 6_000_000, output: 2_000_000, cacheRead: 9_000_000),
            row("2026-11-01", "codex", "gpt-6.1-sol", "hermes", calls: 10, input: 1_000_000, output: 1_000_000),
            row("2026-11-01", "claude", "claude-opus-5", "hermes", calls: 5, input: 1, output: 1),
        ].joined(separator: ",")
        return """
        {"schema":1,"generatedAt":"2026-11-02T03:00:00Z","today":"2026-11-02","since":"2026-10-20",
         "coverage":{"claudeCompleteFrom":"2026-10-21","claudeRetentionDays":14,"codexCliLastDay":"2026-10-30","receiptFirstDay":"2026-10-23"},
         "daily":[\(rows)],
         "receipts":{"audit":{"jsonFiles":9,"uniqueRuns":4,"dupRunId":5},"daily":[
           {"date":"2026-10-29","runs":1,"tokens":1000000,"reviewSec":3600},{"date":"2026-11-01","runs":3,"tokens":3000000,"reviewSec":7200}]},
         "implLoop":{"daily":[{"date":"2026-10-31","runs":2,"rounds":5},{"date":"2026-11-02","runs":1,"rounds":1}]},
         "pro200":{"mid":10000000,"lo":5000000,"hi":20000000,"weeks":3,"samples":7,"excluded":2},
         "undated":[{"lane":"codex","model":"gpt-6.1-sol","source":"hermes","input":700,"output":70,"cacheRead":0,"cacheWrite":0,"calls":7}],
         "quotaCycles":{"since":"2026-10-30","completeFrom":"2026-10-31","daily":[{"date":"2026-11-01","window":"5h","cycles":4,"exhausted":3},
           {"date":"2026-11-01","window":"7d","cycles":2,"exhausted":2}]},
         "pools":{"claude":{"available":true,"threshold":0.995,"accounts":[
           {"label":"C01","util7d":0.99,"reset7d":1794078000000,"usable":false,"enabled":true},
           {"label":"C02","util7d":0.4,"reset7d":null,"usable":true,"enabled":true},
           {"label":"C03","util7d":null,"reset7d":null,"usable":false,"enabled":false}]},
          "codex":{"available":false,"threshold":null,"accounts":[]}},
         "scan":{"bytesRead":0,"files":3}}
        """
    }()

    static var report: ModelUsageReport {
        guard let r = ModelUsageReport.parse(Data(json.utf8)) else { preconditionFailure("fixture must parse") }
        return r
    }

    static func testParseAndReject() {
        let r = report
        precondition(r.today == "2026-11-02" && r.daily.count == 7 && r.receipts.count == 2 && r.impl.count == 2)
        precondition(r.coverage.claudeCompleteFrom == "2026-10-21" && r.coverage.codexCliLastDay == "2026-10-30")
        precondition(r.pro200?.mid == 10_000_000 && r.pro200?.samples == 7 && r.claudePool.accounts.count == 3 && !r.codexPool.available)
        precondition(r.generatedAt != nil)
        precondition(r.undated.count == 1 && r.undated[0].calls == 7 && r.cyclesSince == "2026-10-30" && r.cyclesCompleteFrom == "2026-10-31")
        precondition(ModelUsageReport.parse(Data("{}".utf8)) == nil, "schema missing")
        precondition(ModelUsageReport.parse(Data(#"{"schema":2,"today":"2026-11-02","daily":[]}"#.utf8)) == nil, "future schema")
        precondition(ModelUsageReport.parse(Data("nope".utf8)) == nil)
    }

    static func testPeriodsAndClaudeDelta() {
        let r = report
        let week = modelUsagePeriod(r, .week)
        precondition(week.from == "2026-10-27" && week.to == "2026-11-02" && week.days == 7)
        precondition(week.prev?.from == "2026-10-20" && week.prev?.to == "2026-10-26")
        precondition(week.complete && week.prev?.complete == false, "10/20 is before claudeCompleteFrom")
        let all = modelUsagePeriod(r, .all)
        precondition(all.from == "2026-10-20" && all.days == 14 && all.prev == nil && !all.complete)

        let p = makeModelUsagePresentation(r, ModelUsageSelection(range: .week, metric: .calls))
        // Claude 레인 = Claude Code + Hermes(TeamClaude 경유) 호출
        precondition(p.claudeValue == 555, "\(p.claudeValue)")
        precondition(p.claudeDelta == nil && p.claudePrevIncomplete, "incomplete previous period is not compared")
        let out = makeModelUsagePresentation(r, ModelUsageSelection(range: .week, metric: .output))
        precondition(out.claudeValue == 191)
        let total = makeModelUsagePresentation(r, ModelUsageSelection(range: .week, metric: .total))
        precondition(total.claudeValue == 2100 + 600 + 135 + 2, "\(total.claudeValue)")
        precondition(modelUsageDelta(110, 100) == "+10%" && modelUsageDelta(89, 100) == "−11%" && modelUsageDelta(5, 0) == nil)
    }

    static func testCodexProConversionAndLowerBound() {
        let r = report
        let p = makeModelUsagePresentation(r, ModelUsageSelection(range: .week, metric: .calls))
        // CLI 8M + 적대 검증 4M + Hermes(Codex) 2M = 14M 비캐시, 7일 → 1주
        precondition(p.codexNoncache == 14_000_000, "\(p.codexNoncache)")
        precondition(abs((p.codexPro?.mid ?? 0) - 1.4) < 1e-9 && abs((p.codexPro?.lo ?? 0) - 0.7) < 1e-9 && abs((p.codexPro?.hi ?? 0) - 2.8) < 1e-9)
        precondition(p.codexLowerBound, "the range runs past the last Codex CLI log day")
        let fortnight = makeModelUsagePresentation(r, ModelUsageSelection(range: .fortnight, metric: .calls))
        precondition(abs((fortnight.codexPro?.mid ?? 0) - 0.7) < 1e-9, "14 days → per week")
        var noPro = r
        noPro.pro200 = nil
        precondition(makeModelUsagePresentation(noPro, ModelUsageSelection()).codexPro == nil)
    }

    static func testSourcesKeepTheirOwnUnits() {
        let p = makeModelUsagePresentation(report, ModelUsageSelection(range: .week, metric: .total))
        precondition(p.sources.map(\.key) == [.claudeCode, .codexCli, .codexReview, .codexImpl, .hermes])
        let byKey = Dictionary(uniqueKeysWithValues: p.sources.map { ($0.key, $0) })
        precondition(byKey[.claudeCode]?.count == 550, "sources count events, not the chosen metric")
        precondition(byKey[.codexReview]?.count == 4 && byKey[.codexReview]?.tokens == 4_000_000)
        precondition(byKey[.codexImpl]?.count == 3 && byKey[.codexImpl]?.tokens == nil && byKey[.codexImpl]?.extra == 6)
        precondition(byKey[.hermes]?.count == 15 && byKey[.hermes]?.extra == 10, "Hermes codex-side calls, undated calls excluded")
        precondition(p.gapNote?.contains("날짜 불명 7호출") == true, p.gapNote ?? "")
        precondition(byKey[.codexCli]?.note.contains("10/30 뒤 로그 없음") == true, byKey[.codexCli]?.note ?? "")
        precondition(byKey[.codexImpl]?.note.contains("토큰 기록 없음") == true)
        precondition(byKey[.codexReview]?.prevState == .notRecorded, "receipts start 10/23, previous week starts 10/20")
        precondition(byKey[.codexCli]?.prevState == .compared(nil), "previous week had 0 CLI calls → no delta")
        precondition(byKey[.claudeCode]?.weekly.count == 8 && byKey[.claudeCode]?.weekly.last == 50
                     && byKey[.claudeCode]?.weekly[6] == 500, "W45 starts on Monday 11/2")
    }

    static func testDailyBarsMarkGaps() {
        let p = makeModelUsagePresentation(report, ModelUsageSelection(range: .all, metric: .calls))
        precondition(p.claudeDays.count == 14 && p.codexDays.count == 14)
        precondition(p.claudeDays[0].date == "2026-10-20" && p.claudeDays[0].hatched, "before claudeCompleteFrom")
        precondition(!p.claudeDays[1].hatched)
        precondition(p.codexDays.first { $0.date == "2026-10-31" }?.hatched == true, "after the last CLI log day")
        precondition(p.codexDays.first { $0.date == "2026-10-30" }?.hatched == false)
        let nov1 = p.claudeDays.first { $0.date == "2026-11-01" }
        precondition(nov1?.total == 205 && nov1?.parts.first?.value == 205, "opus (named 0) holds Claude Code + Hermes")
        let codexNov1 = p.codexDays.first { $0.date == "2026-11-01" }
        precondition(codexNov1?.parts.map(\.value) == [0, 3_000_000, 2_000_000], "cli · review · hermes")
        precondition(p.gapNote != nil, "the all range starts inside the gap")
        let week = makeModelUsagePresentation(report, ModelUsageSelection(range: .week, metric: .calls))
        precondition(week.gapNote?.contains("10/30") == true, "lower-bound note mentions the last CLI day")
    }

    static func testModelRowsAndWeeks() {
        let p = makeModelUsagePresentation(report, ModelUsageSelection(range: .week, metric: .calls))
        precondition(p.models.map(\.model) == ["claude-opus-5", "claude-sonnet-5", "gpt-6.1-sol"], "\(p.models.map(\.model))")
        precondition(p.models[0].value == 505 && abs(p.models[0].share - 505.0 / 605.0) < 1e-9)
        precondition(p.models[0].delta == nil, "previous week incomplete")
        precondition(modelUsageNamedIndex(report, "claude-opus-5") == 0 && modelUsageNamedIndex(report, "nope") == nil)
        let weeks = modelUsageWeeks(today: "2026-11-02", count: 3)
        precondition(weeks.map(\.label) == ["W43", "W44", "W45"], "\(weeks.map(\.label))")
        precondition(weeks[1].from == "2026-10-26" && weeks[1].to == "2026-11-01" && !weeks[1].partial && weeks[2].partial)
    }

    static func testPoolsCyclesAndFacts() {
        let p = makeModelUsagePresentation(report, ModelUsageSelection(range: .week, metric: .calls))
        precondition(p.claudePool.accounts[0].full && !p.claudePool.accounts[1].full)
        precondition(p.claudePool.accounts[2].muted, "disabled accounts are drawn muted")
        precondition(p.cycles5h.count == 7 && p.cycles5h.first { $0.date == "2026-11-01" }?.exhausted == 3)
        // 10/31부터 온전: 그 앞(10/27~10/30)은 0이 아니라 모름(빗금), 합계에는 경계 날짜를 밝힌다.
        precondition(p.cycles5h.filter(\.hatched).map(\.date) == ["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"])
        precondition(p.cycleSummary.partialBefore == "2026-10-31")
        var noHistory = report
        noHistory.cycles = []
        noHistory.cyclesSince = nil
        noHistory.cyclesCompleteFrom = nil
        precondition(makeModelUsagePresentation(noHistory, ModelUsageSelection()).cycles5h.allSatisfy(\.hatched), "no history → unknown, not zero")
        var complete = report
        complete.cyclesCompleteFrom = nil
        complete.cyclesSince = "2026-10-01"
        let full = makeModelUsagePresentation(complete, ModelUsageSelection())
        precondition(full.cycleSummary.partialBefore == nil && !full.cycles5h.contains(where: \.hatched))
        precondition(p.cycleSummary.fiveCycles == 4 && p.cycleSummary.fiveExhausted == 3 && p.cycleSummary.weekCycles == 2)
        precondition(p.facts.weekLabel == "W44" && p.facts.reviewRuns == 4 && p.facts.implRuns == 2)
        precondition(p.facts.lowerBound, "W44 ends after the last CLI day")
        precondition(p.facts.codexOn == 0 && p.facts.codexTotal == 0, "codex pool unavailable in the fixture")
        let fractional = ModelUsageReport.parse(Data(json.replacingOccurrences(of: "03:00:00Z", with: "03:00:00.123456Z").utf8))
        precondition(fractional?.generatedAt != nil, "fractional seconds still parse")
    }

    /// '전체'는 보존한 범위 전체다(1년이 넘어도). 그릴 때는 막대를 묶되 합은 그대로다.
    static func testAllRangeCoversEveryKeptDay() {
        var old = report
        old.since = "2025-01-01"
        old.daily.append(ModelUsageRow(date: "2025-01-01", lane: "claude", model: "claude-opus-5", source: "claude-code",
                                       input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 1000))
        let all = makeModelUsagePresentation(old, ModelUsageSelection(range: .all, metric: .calls))
        precondition(all.period.from == "2025-01-01" && all.period.days == 671, "\(all.period.from) \(all.period.days)")
        precondition(all.claudeValue == 1000 + 100 + 300 + 200 + 50 + 5, "\(all.claudeValue)")
        precondition(all.claudeDays.count == 671)
        let grouped = modelUsageBucketed(all.claudeDays, maxBars: 244)
        precondition(grouped.count <= 244 && grouped.first?.date == "2025-01-01")
        precondition(grouped.reduce(0) { $0 + $1.total } == all.claudeDays.reduce(0) { $0 + $1.total }, "bucketing keeps the sum")
        precondition(grouped.first?.hatched == true, "a bucket with a gap day stays hatched")
        precondition(modelUsageBucketed(all.claudeDays.suffix(7).map { $0 }, maxBars: 244).count == 7, "short ranges are untouched")
        precondition(modelUsageSpan("2025-01-01", "2026-11-02") == "25/1/1–11/2" && modelUsageSpan("2026-10-27", "2026-11-02") == "10/27–11/2")
        precondition(L10n.modelRangeAllSince(modelUsageDayLabel(all.period.from, yearOf: all.period.to)) == "전체(25/1/1부터)")
    }

    /// 주기 이력만 남은 날(로컬 세션 로그 없음)도 '전체'의 시작에 든다.
    static func testAllRangeIncludesCycleOnlyDays() {
        let only = #"{"schema":1,"today":"2026-11-03","since":"2026-11-02","daily":[],"receipts":{"daily":[]},"implLoop":{"daily":[]},"quotaCycles":{"since":"2026-11-02","completeFrom":null,"daily":[{"date":"2026-11-02","window":"5h","cycles":4,"exhausted":3}]}}"#
        let r = ModelUsageReport.parse(Data(only.utf8))!
        let p = makeModelUsagePresentation(r, ModelUsageSelection(range: .all, metric: .calls))
        precondition(p.period.from == "2026-11-02", p.period.from)
        precondition(p.cycleSummary.fiveCycles == 4 && p.cycles5h.first?.exhausted == 3)
        var older = report
        older.cycles.append(ModelUsageCycleDay(date: "2026-10-10", window: "5h", cycles: 2, exhausted: 1))
        older.cyclesSince = "2026-10-10"
        older.since = "2026-10-10"
        let all = makeModelUsagePresentation(older, ModelUsageSelection(range: .all, metric: .calls))
        precondition(all.period.from == "2026-10-10" && all.cycleSummary.fiveCycles == 6, "\(all.period.from) \(all.cycleSummary.fiveCycles)")
    }

    static func testCountFormat() {
        L10n.language = .ko
        precondition(modelUsageCount(950) == "950" && modelUsageCount(12_345) == "1.2만" && modelUsageCount(146_000) == "14.6만")
        precondition(modelUsageCount(4_770_000_000) == "47.7억" && modelUsageCount(1_250_000) == "125만")
        L10n.language = .en
        precondition(modelUsageCount(950) == "950" && modelUsageCount(12_345) == "12.3K" && modelUsageCount(4_770_000_000) == "4.8B")
        precondition(modelUsageCount(1_260_000) == "1.3M" && modelUsageCount(3_000_000) == "3M")
        L10n.language = .ko
    }
}
