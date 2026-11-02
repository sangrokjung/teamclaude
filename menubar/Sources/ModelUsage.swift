import Foundation

// 모델 탭의 데이터와 표시 값(menubar/DESIGN.md "모델 탭").
// 메뉴바는 로그를 직접 읽지 않는다. scripts/model-usage-collector.py가 만든 JSON(schema 1)만 읽고, 여기서 기간·지표에 맞춰 더하고 나눈다.
// 새 수치를 지어내지 않는다. 추정(Pro 200 환산)은 수집기가 낸 기준값으로 나눈 값뿐이다. main.swift 없이 컴파일된다.

let modelUsageSchema = 1

enum ModelUsageRange: Int, CaseIterable {
    case week, fortnight, all
    var days: Int? { self == .week ? 7 : self == .fortnight ? 14 : nil }
}

enum ModelUsageMetric: Int, CaseIterable { case calls, output, total }

struct ModelUsageSelection: Equatable {
    var range: ModelUsageRange = .week
    var metric: ModelUsageMetric = .calls
}

struct ModelUsageRow {
    let date: String, lane: String, model: String, source: String
    let input: Double, output: Double, cacheRead: Double, cacheWrite: Double, calls: Double

    func value(_ metric: ModelUsageMetric) -> Double {
        switch metric {
        case .calls: return calls
        case .output: return output
        case .total: return input + output + cacheRead + cacheWrite
        }
    }
    /// 비캐시 토큰(입력 − 캐시 + 출력). 수집기가 Codex 입력을 이미 캐시를 뺀 값으로 낸다.
    var noncache: Double { input + output }
}

struct ModelUsageReceiptDay { let date: String; let runs: Double; let tokens: Double; let reviewSec: Double }
struct ModelUsageImplDay { let date: String; let runs: Double; let rounds: Double }
struct ModelUsageCycleDay { let date: String; let window: String; let cycles: Double; let exhausted: Double }
struct ModelUsagePoolAccount { let label: String; let util7d: Double?; let reset7d: Date?; let usable: Bool; let enabled: Bool }
struct ModelUsagePool { var available = false; var accounts: [ModelUsagePoolAccount] = [] }
/// samples: 기준값을 낸 표본 창 수(수집기 값). 기간 환산 값에는 없다(nil).
struct ModelUsagePro200 { let mid: Double; let lo: Double; let hi: Double; var samples: Int? = nil }
struct ModelUsageCoverage { var claudeCompleteFrom: String?; var claudeRetentionDays: Int?; var codexCliLastDay: String?; var receiptFirstDay: String? }

struct ModelUsageReport {
    var generatedAt: Date?
    var today: String
    var since: String
    var coverage = ModelUsageCoverage()
    var daily: [ModelUsageRow] = []
    var receipts: [ModelUsageReceiptDay] = []
    var impl: [ModelUsageImplDay] = []
    var pro200: ModelUsagePro200?
    var cycles: [ModelUsageCycleDay] = []
    /// 주기 이력이 처음 남은 날과 온전한 첫날. 메뉴바는 주기를 창마다 256개만 남겨서 수집기가 보기 전에 잘린 몫이 있을 수 있다.
    var cyclesSince: String?
    var cyclesCompleteFrom: String?
    /// 날짜를 알 수 없는 사용량(처음 볼 때 이미 여러 날에 걸친 Hermes 세션). 일별·기간 합계에 넣지 않고 따로 밝힌다.
    var undated: [ModelUsageRow] = []
    var claudePool = ModelUsagePool()
    var codexPool = ModelUsagePool()

    /// 수집기 결과 기본 경로. 구독 수집기와 같은 폴더다.
    static var defaultPath: String { NSHomeDirectory() + "/.local/state/cc-menubar/model-usage.json" }

    static func load(path: String = defaultPath) -> ModelUsageReport? {
        FileManager.default.contents(atPath: path).flatMap(parse)
    }

    static func parse(_ data: Data) -> ModelUsageReport? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              (root["schema"] as? NSNumber)?.intValue == modelUsageSchema,
              let today = root["today"] as? String, modelUsageDate(today) != nil else { return nil }
        var r = ModelUsageReport(today: today, since: (root["since"] as? String) ?? today)
        r.generatedAt = (root["generatedAt"] as? String).flatMap(modelUsageParseInstant)
        let cov = root["coverage"] as? [String: Any] ?? [:]
        r.coverage = ModelUsageCoverage(claudeCompleteFrom: cov["claudeCompleteFrom"] as? String,
                                        claudeRetentionDays: (cov["claudeRetentionDays"] as? NSNumber)?.intValue,
                                        codexCliLastDay: cov["codexCliLastDay"] as? String, receiptFirstDay: cov["receiptFirstDay"] as? String)
        r.daily = objects(root["daily"]).compactMap { o in
            guard let date = o["date"] as? String else { return nil }
            return row(o, date: date)
        }
        r.undated = objects(root["undated"]).compactMap { row($0, date: "") }
        r.receipts = objects((root["receipts"] as? [String: Any])?["daily"]).compactMap { o in
            (o["date"] as? String).map { ModelUsageReceiptDay(date: $0, runs: num(o["runs"]), tokens: num(o["tokens"]), reviewSec: num(o["reviewSec"])) }
        }
        r.impl = objects((root["implLoop"] as? [String: Any])?["daily"]).compactMap { o in
            (o["date"] as? String).map { ModelUsageImplDay(date: $0, runs: num(o["runs"]), rounds: num(o["rounds"])) }
        }
        if let p = root["pro200"] as? [String: Any], num(p["mid"]) > 0, num(p["lo"]) > 0, num(p["hi"]) > 0 {
            r.pro200 = ModelUsagePro200(mid: num(p["mid"]), lo: num(p["lo"]), hi: num(p["hi"]), samples: (p["samples"] as? NSNumber)?.intValue)
        }
        let quotaCycles = root["quotaCycles"] as? [String: Any] ?? [:]
        r.cyclesSince = quotaCycles["since"] as? String
        r.cyclesCompleteFrom = quotaCycles["completeFrom"] as? String
        r.cycles = objects(quotaCycles["daily"]).compactMap { o in
            guard let date = o["date"] as? String, let window = o["window"] as? String else { return nil }
            return ModelUsageCycleDay(date: date, window: window, cycles: num(o["cycles"]), exhausted: num(o["exhausted"]))
        }
        let pools = root["pools"] as? [String: Any] ?? [:]
        r.claudePool = pool(pools["claude"])
        r.codexPool = pool(pools["codex"])
        return r
    }

    private static func objects(_ value: Any?) -> [[String: Any]] { value as? [[String: Any]] ?? [] }

    private static func row(_ o: [String: Any], date: String) -> ModelUsageRow? {
        guard let lane = o["lane"] as? String, let model = o["model"] as? String, let source = o["source"] as? String else { return nil }
        return ModelUsageRow(date: date, lane: lane, model: model, source: source, input: num(o["input"]), output: num(o["output"]),
                             cacheRead: num(o["cacheRead"]), cacheWrite: num(o["cacheWrite"]), calls: num(o["calls"]))
    }
    private static func num(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? 0 }

    private static func pool(_ value: Any?) -> ModelUsagePool {
        guard let o = value as? [String: Any], (o["available"] as? Bool) == true else { return ModelUsagePool() }
        let accounts = objects(o["accounts"]).compactMap { a -> ModelUsagePoolAccount? in
            guard let label = a["label"] as? String else { return nil }
            let reset = (a["reset7d"] as? NSNumber).map { Date(timeIntervalSince1970: $0.doubleValue / 1000) }
            return ModelUsagePoolAccount(label: label, util7d: (a["util7d"] as? NSNumber)?.doubleValue, reset7d: reset,
                                         usable: (a["usable"] as? Bool) == true, enabled: (a["enabled"] as? Bool) != false)
        }
        return ModelUsagePool(available: true, accounts: accounts)
    }
}

/// ISO 8601 시각(소수 초가 있어도 읽는다).
func modelUsageParseInstant(_ value: String) -> Date? {
    let plain = ISO8601DateFormatter()
    if let date = plain.date(from: value) { return date }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: value)
}

// MARK: 날짜(문자열 YYYY-MM-DD, 시간대 없는 날짜 산술)

private let modelUsageCalendar: Calendar = {
    var c = Calendar(identifier: .iso8601)
    c.timeZone = TimeZone(identifier: "UTC")!
    return c
}()

private let modelUsageDayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = modelUsageCalendar
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = modelUsageCalendar.timeZone
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

func modelUsageDate(_ day: String) -> Date? { modelUsageDayFormatter.date(from: day) }

func modelUsageAddDays(_ day: String, _ n: Int) -> String {
    guard let date = modelUsageDate(day), let moved = modelUsageCalendar.date(byAdding: .day, value: n, to: date) else { return day }
    return modelUsageDayFormatter.string(from: moved)
}

func modelUsageDays(_ from: String, _ to: String) -> [String] {
    var out: [String] = []
    var day = from
    // '전체'는 수집기가 보존한 범위 전체다. 상한은 깨진 입력에서 끝없이 돌지 않게 하는 안전판(10년)일 뿐이다.
    while day <= to, out.count < 3_660 { out.append(day); day = modelUsageAddDays(day, 1) }
    return out
}

/// 기간 표시 "10/27–11/2". 해가 다르면 앞쪽에 연도를 붙인다("25/1/1–11/2").
func modelUsageSpan(_ from: String, _ to: String) -> String {
    "\(modelUsageDayLabel(from, yearOf: to))–\(modelUsageMonthDay(to))"
}

/// 기준 날짜와 해가 다르면 "25/1/1", 같으면 "1/1".
func modelUsageDayLabel(_ day: String, yearOf reference: String) -> String {
    day.prefix(4) == reference.prefix(4) ? modelUsageMonthDay(day) : "\(day.dropFirst(2).prefix(2))/\(modelUsageMonthDay(day))"
}

/// 막대가 그릴 폭보다 많으면 이어진 날을 묶어 한 막대로 합친다(값은 더하고, 하나라도 빗금이면 빗금). 날짜는 묶음의 첫날.
func modelUsageBucketed(_ bars: [ModelUsageDayBar], maxBars: Int) -> [ModelUsageDayBar] {
    guard maxBars > 0, bars.count > maxBars else { return bars }
    let size = (bars.count + maxBars - 1) / maxBars
    return stride(from: 0, to: bars.count, by: size).map { start in
        let group = bars[start..<min(start + size, bars.count)]
        var sums: [Int: Double] = [:]
        var order: [Int] = []
        for part in group.flatMap(\.parts) {
            if sums[part.key] == nil { order.append(part.key) }
            sums[part.key, default: 0] += part.value
        }
        return ModelUsageDayBar(date: group.first!.date, parts: order.map { ModelUsageBarPart(key: $0, value: sums[$0]!) },
                                hatched: group.contains(where: \.hatched))
    }
}

/// "11/2"
func modelUsageMonthDay(_ day: String) -> String {
    let parts = day.split(separator: "-")
    guard parts.count == 3, let m = Int(parts[1]), let d = Int(parts[2]) else { return day }
    return "\(m)/\(d)"
}

struct ModelUsageWeek: Equatable { let from: String; let to: String; let label: String; let partial: Bool }

/// 오늘이 든 주까지 ISO 주(월요일 시작) count개. 마지막 주는 오늘까지라 partial.
func modelUsageWeeks(today: String, count: Int) -> [ModelUsageWeek] {
    guard let date = modelUsageDate(today) else { return [] }
    let weekday = modelUsageCalendar.component(.weekday, from: date)  // 일=1 … 토=7
    let monday = modelUsageAddDays(today, -((weekday + 5) % 7))
    return (0..<count).reversed().map { back in
        let from = modelUsageAddDays(monday, -7 * back)
        let end = modelUsageAddDays(from, 6)
        let week = modelUsageDate(from).map { modelUsageCalendar.component(.weekOfYear, from: $0) } ?? 0
        return ModelUsageWeek(from: from, to: min(end, today), label: String(format: "W%02d", week), partial: end > today)
    }
}

// MARK: 기간

struct ModelUsagePeriod {
    let from: String, to: String, days: Int
    let complete: Bool  // Claude 기록이 온전한 구간인가
    let prev: (from: String, to: String, complete: Bool)?
}

/// '전체'의 첫날: 보존된 모든 기록(일별·영수증·구현 루프·주기 이력) 중 가장 이른 날. 기록이 하나도 없으면 수집기의 since.
private func modelUsageFirstDay(_ r: ModelUsageReport) -> String {
    let dates = r.daily.map(\.date) + r.receipts.map(\.date) + r.impl.map(\.date) + r.cycles.map(\.date)
    return min(max(dates.min() ?? r.since, r.since), r.today)
}

private func claudeComplete(_ r: ModelUsageReport, from: String) -> Bool {
    r.coverage.claudeCompleteFrom.map { from >= $0 } ?? true
}

func modelUsagePeriod(_ r: ModelUsageReport, _ range: ModelUsageRange) -> ModelUsagePeriod {
    let first = modelUsageFirstDay(r)
    guard let days = range.days else {
        return ModelUsagePeriod(from: first, to: r.today, days: modelUsageDays(first, r.today).count,
                                complete: claudeComplete(r, from: first), prev: nil)
    }
    let from = modelUsageAddDays(r.today, -(days - 1))
    let prevFrom = modelUsageAddDays(from, -days)
    let prevOK = prevFrom >= r.since && claudeComplete(r, from: prevFrom)
    return ModelUsagePeriod(from: from, to: r.today, days: days, complete: claudeComplete(r, from: from),
                            prev: (prevFrom, modelUsageAddDays(from, -1), prevOK))
}

// MARK: 표시 값

enum ModelUsageSourceKey: CaseIterable { case claudeCode, codexCli, codexReview, codexImpl, hermes }

enum ModelUsagePrevState: Equatable {
    case none            // 전체 기간: 비교 없음
    case notRecorded     // 앞 기간에 그 출처 기록이 아직 없었다
    case compared(String?)  // 비교한 값(앞 기간 0이면 nil)
}

struct ModelUsageSourceLine {
    let key: ModelUsageSourceKey
    let count: Double
    let tokens: Double?
    let extra: Double  // 검토 시간(초)·라운드·Codex 쪽 호출
    let prevState: ModelUsagePrevState
    let note: String
    let weekly: [Double]
}

struct ModelUsageBarPart { let key: Int; let value: Double }  // key: 모델 색 순번(0~3, 4=기타) 또는 출처 순번
struct ModelUsageDayBar { let date: String; let parts: [ModelUsageBarPart]; let hatched: Bool; var total: Double { parts.reduce(0) { $0 + $1.value } } }
struct ModelUsageModelLine { let model: String; let lane: String; let value: Double; let share: Double; let delta: String?; let isNew: Bool }
struct ModelUsagePoolLine { let label: String; let percent: Double?; let elapsed: Double?; let muted: Bool; var full: Bool { (percent ?? 0) >= panelRoutingThresholdPercent } }
struct ModelUsagePoolPresentation { let available: Bool; let accounts: [ModelUsagePoolLine]; var fullCount: Int { accounts.filter(\.full).count } }
/// hatched: 그날 주기 기록이 잘렸거나 아직 없다(0이 아니라 모름).
struct ModelUsageCycleBar { let date: String; let cycles: Double; let exhausted: Double; let hatched: Bool }
struct ModelUsageCycleSummary {
    var fiveCycles: Double = 0; var fiveExhausted: Double = 0; var weekCycles: Double = 0; var weekExhausted: Double = 0
    /// 기간 앞쪽이 기록 공백에 걸리면 그 경계 날짜(이 날부터 온전). 합계는 그 뒤만 온전하다.
    var partialBefore: String?
}
struct ModelUsageFacts { let weekLabel: String; let pro: ModelUsagePro200?; let lowerBound: Bool; let reviewRuns: Double; let implRuns: Double; let codexOn: Int; let codexTotal: Int }

struct ModelUsagePresentation {
    let selection: ModelUsageSelection
    let period: ModelUsagePeriod
    let claudeValue: Double
    let claudeDelta: String?
    let claudePrevIncomplete: Bool
    let codexNoncache: Double
    let codexPro: ModelUsagePro200?
    let codexLowerBound: Bool
    let gapNote: String?
    let sources: [ModelUsageSourceLine]
    let weeks: [ModelUsageWeek]
    let claudeDays: [ModelUsageDayBar]
    let codexDays: [ModelUsageDayBar]
    let models: [ModelUsageModelLine]
    let claudePool: ModelUsagePoolPresentation
    let codexPool: ModelUsagePoolPresentation
    let cycles5h: [ModelUsageCycleBar]
    let cycleSummary: ModelUsageCycleSummary
    let facts: ModelUsageFacts
}

/// "+10%", "−11%". 앞 값이 0이면 비교하지 않는다(nil).
func modelUsageDelta(_ now: Double, _ prev: Double) -> String? {
    guard prev > 0 else { return nil }
    let pct = Int(((now - prev) / prev * 100).rounded())
    return pct >= 0 ? "+\(pct)%" : "−\(-pct)%"
}

/// 전체 기간 호출 수 상위 4개 모델의 색 순번. 범위·지표를 바꿔도 색은 그대로다.
func modelUsageNamedIndex(_ r: ModelUsageReport, _ model: String) -> Int? {
    var totals: [String: Double] = [:]
    for row in r.daily { totals[row.model, default: 0] += row.calls }
    let named = totals.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.prefix(4).map(\.key)
    return named.firstIndex(of: model)
}

/// 수: 한국어 1.2만·47.7억, 영어 12.3K·4.8B.
func modelUsageCount(_ value: Double) -> String {
    let v = max(0, value)
    func short(_ x: Double) -> String { x < 100 ? String(format: "%.1f", x).replacingOccurrences(of: ".0", with: "") : String(Int(x.rounded())) }
    if L10n.language == .ko {
        if v < 10_000 { return String(Int(v.rounded())) }
        if v < 100_000_000 { return short(v / 10_000) + "만" }
        return short(v / 100_000_000) + "억"
    }
    if v < 1_000 { return String(Int(v.rounded())) }
    if v < 1_000_000 { return short(v / 1_000) + "K" }
    if v < 1_000_000_000 { return short(v / 1_000_000) + "M" }
    return short(v / 1_000_000_000) + "B"
}

private func inRange(_ day: String, _ from: String, _ to: String) -> Bool { day >= from && day <= to }

private func claudeLaneTotal(_ r: ModelUsageReport, _ from: String, _ to: String, _ metric: ModelUsageMetric) -> Double {
    r.daily.filter { $0.lane == "claude" && inRange($0.date, from, to) }.reduce(0) { $0 + $1.value(metric) }
}

/// Codex 수요(비캐시 토큰): Codex CLI + 적대 검증 tokens used + Hermes(Codex 쪽). 구현 루프는 토큰이 없어 빠진다.
func modelUsageCodexNoncache(_ r: ModelUsageReport, _ from: String, _ to: String) -> (cli: Double, review: Double, hermes: Double) {
    var cli = 0.0, hermes = 0.0
    for row in r.daily where row.lane == "codex" && inRange(row.date, from, to) {
        if row.source == "codex-cli" { cli += row.noncache } else if row.source == "hermes" { hermes += row.noncache }
    }
    let review = r.receipts.filter { inRange($0.date, from, to) }.reduce(0) { $0 + $1.tokens }
    return (cli, review, hermes)
}

private func toPro(_ r: ModelUsageReport, _ noncache: Double, days: Int) -> ModelUsagePro200? {
    guard let p = r.pro200, days > 0 else { return nil }
    let weeks = Double(days) / 7
    return ModelUsagePro200(mid: noncache / p.mid / weeks, lo: noncache / p.hi / weeks, hi: noncache / p.lo / weeks)
}

private func lowerBound(_ r: ModelUsageReport, to: String) -> Bool { r.coverage.codexCliLastDay.map { to > $0 } ?? false }

private func sourceTotal(_ r: ModelUsageReport, _ key: ModelUsageSourceKey, _ from: String, _ to: String) -> (count: Double, tokens: Double?, extra: Double) {
    switch key {
    case .codexReview:
        let days = r.receipts.filter { inRange($0.date, from, to) }
        return (days.reduce(0) { $0 + $1.runs }, days.reduce(0) { $0 + $1.tokens }, days.reduce(0) { $0 + $1.reviewSec })
    case .codexImpl:
        let days = r.impl.filter { inRange($0.date, from, to) }
        return (days.reduce(0) { $0 + $1.runs }, nil, days.reduce(0) { $0 + $1.rounds })
    case .claudeCode, .codexCli, .hermes:
        let source = key == .claudeCode ? "claude-code" : key == .codexCli ? "codex-cli" : "hermes"
        let rows = r.daily.filter { $0.source == source && inRange($0.date, from, to) }
        let tokens = rows.reduce(0) { $0 + (key == .claudeCode ? $1.value(.total) : $1.noncache) }
        let extra = key == .hermes ? rows.filter { $0.lane == "codex" }.reduce(0) { $0 + $1.calls } : 0
        return (rows.reduce(0) { $0 + $1.calls }, tokens, extra)
    }
}

private func sourceFirstDay(_ r: ModelUsageReport, _ key: ModelUsageSourceKey) -> String? {
    switch key {
    case .claudeCode: return r.coverage.claudeCompleteFrom
    case .codexReview: return r.coverage.receiptFirstDay ?? r.receipts.map(\.date).min()
    case .codexImpl: return r.impl.map(\.date).min()
    case .codexCli, .hermes: return nil
    }
}

private func sourceNote(_ r: ModelUsageReport, _ key: ModelUsageSourceKey, _ total: (count: Double, tokens: Double?, extra: Double), to: String) -> String {
    switch key {
    case .claudeCode: return L10n.modelSourceNoteClaude(modelUsageCount(total.tokens ?? 0))
    case .codexCli:
        let gap = r.coverage.codexCliLastDay.flatMap { to > $0 ? modelUsageMonthDay($0) : nil }
        return L10n.modelSourceNoteCli(modelUsageCount(total.tokens ?? 0), afterDay: gap)
    case .codexReview: return L10n.modelSourceNoteReview(modelUsageCount(total.tokens ?? 0), hours: Int((total.extra / 3600).rounded()))
    case .codexImpl: return L10n.modelSourceNoteImpl(modelUsageCount(total.extra))
    case .hermes: return L10n.modelSourceNoteHermes(modelUsageCount(total.extra), modelUsageCount(total.tokens ?? 0))
    }
}

private func sourceLines(_ r: ModelUsageReport, _ period: ModelUsagePeriod, weeks: [ModelUsageWeek]) -> [ModelUsageSourceLine] {
    ModelUsageSourceKey.allCases.map { key in
        let now = sourceTotal(r, key, period.from, period.to)
        var prevState = ModelUsagePrevState.none
        if let prev = period.prev {
            let recorded = prev.from >= r.since && (sourceFirstDay(r, key).map { prev.from >= $0 } ?? true)
            prevState = recorded ? .compared(modelUsageDelta(now.count, sourceTotal(r, key, prev.from, prev.to).count)) : .notRecorded
        }
        return ModelUsageSourceLine(key: key, count: now.count, tokens: now.tokens, extra: now.extra, prevState: prevState,
                                    note: sourceNote(r, key, now, to: period.to),
                                    weekly: weeks.map { sourceTotal(r, key, $0.from, $0.to).count })
    }
}

private func dayBars(_ r: ModelUsageReport, _ period: ModelUsagePeriod, metric: ModelUsageMetric) -> (claude: [ModelUsageDayBar], codex: [ModelUsageDayBar]) {
    var named: [String: Int] = [:]
    for model in Set(r.daily.map(\.model)) { named[model] = modelUsageNamedIndex(r, model) ?? 4 }
    let days = modelUsageDays(period.from, period.to)
    let claude = days.map { day -> ModelUsageDayBar in
        var parts = [Double](repeating: 0, count: 5)
        for row in r.daily where row.lane == "claude" && row.date == day { parts[named[row.model] ?? 4] += row.value(metric) }
        return ModelUsageDayBar(date: day, parts: parts.enumerated().map { ModelUsageBarPart(key: $0.offset, value: $0.element) },
                                hatched: !claudeComplete(r, from: day))
    }
    let codex = days.map { day -> ModelUsageDayBar in
        let d = modelUsageCodexNoncache(r, day, day)
        return ModelUsageDayBar(date: day, parts: [d.cli, d.review, d.hermes].enumerated().map { ModelUsageBarPart(key: $0.offset, value: $0.element) },
                                hatched: lowerBound(r, to: day))
    }
    return (claude, codex)
}

private func modelLines(_ r: ModelUsageReport, _ period: ModelUsagePeriod, metric: ModelUsageMetric) -> [ModelUsageModelLine] {
    var now: [String: Double] = [:], lane: [String: String] = [:], prev: [String: Double] = [:]
    for row in r.daily where inRange(row.date, period.from, period.to) {
        now[row.model, default: 0] += row.value(metric)
        lane[row.model] = lane[row.model] ?? row.lane
    }
    let compare = period.prev?.complete == true
    if let p = period.prev, compare {
        for row in r.daily where inRange(row.date, p.from, p.to) { prev[row.model, default: 0] += row.value(metric) }
    }
    let total = now.values.reduce(0, +)
    return now.filter { $0.value > 0 }.sorted { $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key }.map { model, value in
        ModelUsageModelLine(model: model, lane: lane[model] ?? "other", value: value, share: total > 0 ? value / total : 0,
                            delta: compare ? modelUsageDelta(value, prev[model] ?? 0) : nil, isNew: compare && (prev[model] ?? 0) == 0)
    }
}

private func poolLines(_ pool: ModelUsagePool, now: Date) -> ModelUsagePoolPresentation {
    let lines = pool.accounts.map { a in
        ModelUsagePoolLine(label: a.label, percent: a.util7d.map { $0 * 100 },
                           elapsed: panelWeekElapsed(a.reset7d, now: now), muted: !a.enabled || (!a.usable && (a.util7d ?? 0) * 100 < panelRoutingThresholdPercent))
    }
    return ModelUsagePoolPresentation(available: pool.available, accounts: lines)
}

private func panelWeekElapsed(_ reset: Date?, now: Date) -> Double? {
    guard let reset else { return nil }
    let remaining = reset.timeIntervalSince(now)
    let window = 7 * 86_400.0
    guard remaining > 0, remaining <= window else { return nil }
    return (window - remaining) / window
}

private func gapNote(_ r: ModelUsageReport, _ period: ModelUsagePeriod) -> String? {
    var parts: [String] = []
    if !period.complete, let from = r.coverage.claudeCompleteFrom {
        parts.append(L10n.modelGapClaude(modelUsageMonthDay(from), days: r.coverage.claudeRetentionDays ?? 30))
    }
    if lowerBound(r, to: period.to), let last = r.coverage.codexCliLastDay {
        parts.append(L10n.modelGapCli(modelUsageMonthDay(last)))
    }
    // 날짜를 모르는 몫은 어느 기간에도 넣지 않았다는 사실을 기간과 무관하게 밝힌다.
    let undated = r.undated.reduce(0) { $0 + $1.calls }
    if undated > 0 { parts.append(L10n.modelUndated(modelUsageCount(undated))) }
    return parts.isEmpty ? nil : parts.joined(separator: " ")
}

private func facts(_ r: ModelUsageReport) -> ModelUsageFacts {
    let weeks = modelUsageWeeks(today: r.today, count: 2)
    let last = weeks.first ?? ModelUsageWeek(from: r.today, to: r.today, label: "", partial: true)
    let d = modelUsageCodexNoncache(r, last.from, last.to)
    let on = r.codexPool.accounts.filter(\.enabled).count  // 켜진(설정상 사용) 계정. 지금 한도에 막혔는지는 풀 막대가 말한다
    return ModelUsageFacts(weekLabel: last.label, pro: toPro(r, d.cli + d.review + d.hermes, days: 7), lowerBound: lowerBound(r, to: last.to),
                           reviewRuns: sourceTotal(r, .codexReview, last.from, last.to).count,
                           implRuns: sourceTotal(r, .codexImpl, last.from, last.to).count,
                           codexOn: on, codexTotal: r.codexPool.accounts.count)
}

func makeModelUsagePresentation(_ r: ModelUsageReport, _ selection: ModelUsageSelection, now: Date = Date()) -> ModelUsagePresentation {
    let period = modelUsagePeriod(r, selection.range)
    let claudeNow = claudeLaneTotal(r, period.from, period.to, selection.metric)
    var claudeDelta: String?
    if let p = period.prev, p.complete { claudeDelta = modelUsageDelta(claudeNow, claudeLaneTotal(r, p.from, p.to, selection.metric)) }
    let codex = modelUsageCodexNoncache(r, period.from, period.to)
    let noncache = codex.cli + codex.review + codex.hermes
    let weeks = modelUsageWeeks(today: r.today, count: 8)
    let bars = dayBars(r, period, metric: selection.metric)
    let cycleDays = modelUsageDays(period.from, period.to)
    let five = r.cycles.filter { $0.window == "5h" }
    // 기록이 온전한 첫날: 잘린 경계(completeFrom)가 있으면 그날, 없으면 이력이 처음 남은 날. 이력이 없으면 전부 모름.
    let cyclesComplete = r.cyclesCompleteFrom ?? r.cyclesSince
    let cycles5h = cycleDays.map { day in
        ModelUsageCycleBar(date: day, cycles: five.filter { $0.date == day }.reduce(0) { $0 + $1.cycles },
                           exhausted: five.filter { $0.date == day }.reduce(0) { $0 + $1.exhausted },
                           hatched: cyclesComplete.map { day < $0 } ?? true)
    }
    var summary = ModelUsageCycleSummary()
    if let complete = cyclesComplete, period.from < complete { summary.partialBefore = complete }
    for c in r.cycles where inRange(c.date, period.from, period.to) {
        if c.window == "5h" { summary.fiveCycles += c.cycles; summary.fiveExhausted += c.exhausted }
        if c.window == "7d" { summary.weekCycles += c.cycles; summary.weekExhausted += c.exhausted }
    }
    return ModelUsagePresentation(
        selection: selection, period: period, claudeValue: claudeNow, claudeDelta: claudeDelta,
        claudePrevIncomplete: period.prev.map { !$0.complete } ?? false,
        codexNoncache: noncache, codexPro: toPro(r, noncache, days: period.days), codexLowerBound: lowerBound(r, to: period.to),
        gapNote: gapNote(r, period), sources: sourceLines(r, period, weeks: weeks), weeks: weeks,
        claudeDays: bars.claude, codexDays: bars.codex, models: modelLines(r, period, metric: selection.metric),
        claudePool: poolLines(r.claudePool, now: now), codexPool: poolLines(r.codexPool, now: now),
        cycles5h: cycles5h, cycleSummary: summary, facts: facts(r))
}
