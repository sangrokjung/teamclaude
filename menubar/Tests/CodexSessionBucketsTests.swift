import Foundation

/// 세션 통계는 날짜 버킷으로 쌓이고 오늘/7일/전체는 읽는 시점에 접는다(CodexStatusLoader C2).
/// 러너 호환(@main + precondition). 영구 캐시가 진짜 홈에 닿지 않도록 CFFIXED_USER_HOME을 임시 폴더로 돌리고,
/// 돌리기에 실패하면 아무것도 쓰지 않고 멈춘다.
@main
struct CodexSessionBucketsTests {
    static func main() throws {
        let fm = FileManager.default
        let base = fm.temporaryDirectory.appendingPathComponent(
            "menubar-buckets-\(ProcessInfo.processInfo.processIdentifier)-\(UUID().uuidString.prefix(8))",
            isDirectory: true
        )
        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: base) }
        setenv("CFFIXED_USER_HOME", base.path, 1)
        let resolvedHome = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path
        precondition(resolvedHome == base.resolvingSymlinksInPath().path,
                     "home isolation failed; refusing to touch the real cache: \(NSHomeDirectory())")

        let calendar = Calendar.current
        // Whole seconds so the ISO8601 round-trip through the fixture compares exactly.
        let noon = calendar.date(bySettingHour: 12, minute: 0, second: 0, of: Date())!
        let today = Date(timeIntervalSince1970: floor(noon.timeIntervalSince1970))
        let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
        let tomorrow = calendar.date(byAdding: .day, value: 1, to: today)!

        testAggregateFoldsBucketsByNow(calendar: calendar, today: today, yesterday: yesterday, tomorrow: tomorrow)
        try testLoaderBucketsAndRollover(
            root: base.appendingPathComponent("sessions", isDirectory: true),
            calendar: calendar, today: today, yesterday: yesterday, tomorrow: tomorrow
        )
        print("CodexSessionBucketsTests: aggregate, today/yesterday, append, rollover, truncate passed")
    }

    static func testAggregateFoldsBucketsByNow(calendar: Calendar, today: Date, yesterday: Date, tomorrow: Date) {
        let todayKey = codexDayKey(today, calendar: calendar)
        let yesterdayKey = codexDayKey(yesterday, calendar: calendar)
        precondition(todayKey != yesterdayKey && todayKey != codexUndatedDayKey)
        var buckets: [String: CodexDayBucket] = [:]
        buckets[yesterdayKey] = CodexDayBucket(
            calls: 2, tokens: 20, quotaEvents: 1,
            byProfile: ["A": CodexDayBucket(calls: 2, tokens: 20, quotaEvents: 1, lastCallAt: yesterday,
                                            lastVerdict: "ok", lastQuotaAt: yesterday.addingTimeInterval(60))],
            lastCallAt: yesterday
        )
        buckets[todayKey] = CodexDayBucket(
            calls: 3, tokens: 30,
            byProfile: ["A": CodexDayBucket(calls: 3, tokens: 30, lastCallAt: today, lastVerdict: "ok")],
            lastCallAt: today
        )
        buckets[codexUndatedDayKey] = CodexDayBucket(
            calls: 1, tokens: 5,
            byProfile: ["B": CodexDayBucket(calls: 1, tokens: 5, lastVerdict: "ok")]
        )

        let now = codexAggregate(buckets: buckets, now: today, calendar: calendar)
        precondition(now.todayCalls == 3 && now.todayTokens == 30, "today = today's bucket only")
        precondition(now.weekCalls == 5 && now.weekTokens == 50, "week = today + yesterday; undated excluded")
        precondition(now.totalCalls == 6 && now.totalTokens == 55, "total = every bucket including undated")
        precondition(now.quotaEvents == 1)
        let profileA = now.byProfile["A"]!
        precondition(profileA.todayCalls == 3 && profileA.weekCalls == 5 && profileA.totalCalls == 5)
        precondition(profileA.quotaEvents == 1)
        precondition(profileA.lastVerdict == "ok" && profileA.lastAt == today,
                     "a call after the last quota event keeps its own verdict")
        let profileB = now.byProfile["B"]!
        precondition(profileB.totalCalls == 1 && profileB.weekCalls == 0 && profileB.lastAt == nil && profileB.lastVerdict == "ok")

        let rolled = codexAggregate(buckets: buckets, now: tomorrow, calendar: calendar)
        precondition(rolled.todayCalls == 0 && rolled.todayTokens == 0, "after rollover nothing is today")
        precondition(rolled.weekCalls == 5 && rolled.totalCalls == 6)
        precondition(rolled.byProfile["A"]?.todayCalls == 0 && rolled.byProfile["A"]?.weekCalls == 5)

        let sevenLater = codexAggregate(buckets: buckets, now: calendar.date(byAdding: .day, value: 7, to: today)!, calendar: calendar)
        precondition(sevenLater.weekCalls == 3 && sevenLater.quotaEvents == 0,
                     "the day exactly 7 days back stays in the week; the day before it leaves")
        let eightLater = codexAggregate(buckets: buckets, now: calendar.date(byAdding: .day, value: 8, to: today)!, calendar: calendar)
        precondition(eightLater.weekCalls == 0 && eightLater.totalCalls == 6)
        precondition(eightLater.byProfile["A"]?.lastVerdict == "ok" && eightLater.byProfile["A"]?.totalCalls == 5)

        // A rate-limit-reached after the last call: "pass_quota" while inside the week, the call's own verdict once it ages out.
        var quotaLater = buckets
        var todayBucket = quotaLater[todayKey]!
        var rowA = todayBucket.byProfile!["A"]!
        rowA.lastQuotaAt = today.addingTimeInterval(1)
        todayBucket.byProfile!["A"] = rowA
        quotaLater[todayKey] = todayBucket
        precondition(codexAggregate(buckets: quotaLater, now: today, calendar: calendar).byProfile["A"]?.lastVerdict == "pass_quota")
        precondition(codexAggregate(buckets: quotaLater, now: calendar.date(byAdding: .day, value: 8, to: today)!, calendar: calendar)
            .byProfile["A"]?.lastVerdict == "ok")

        // Merging two files' buckets for the same day adds counters and keeps the earlier of tied last calls.
        var merged = buckets[todayKey]!
        merged.merge(CodexDayBucket(calls: 1, tokens: 1, byProfile: ["A": CodexDayBucket(calls: 1, tokens: 1, lastCallAt: today, lastVerdict: "pass_quota")]))
        precondition(merged.calls == 4 && merged.tokens == 31)
        precondition(merged.byProfile?["A"]?.calls == 4 && merged.byProfile?["A"]?.lastVerdict == "ok")
    }

    static func testLoaderBucketsAndRollover(root: URL, calendar: Calendar, today: Date, yesterday: Date, tomorrow: Date) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent("fixture.jsonl")
        let iso = ISO8601DateFormatter()
        var lines: [[String: Any]] = [
            ["timestamp": iso.string(from: yesterday), "type": "turn_context", "payload": ["model": "gpt-5.6-codex"]],
        ]
        var total = 0
        for offset in [-3_600.0, -1_800.0] { // yesterday: 2 calls
            total += 100
            lines.append(tokenLine(timestamp: iso.string(from: yesterday.addingTimeInterval(offset)), total: total, last: 100))
        }
        for offset in [-3_600.0, -1_800.0, -600.0] { // today: 3 calls
            total += 100
            lines.append(tokenLine(timestamp: iso.string(from: today.addingTimeInterval(offset)), total: total, last: 100))
        }
        let initial = try encode(lines)
        try initial.write(to: file)

        // (1) yesterday + today in one file → today / week / total.
        let first = loadCodexSessionStats(root: root.path, now: today, calendar: calendar)
        precondition(first.todayCalls == 3 && first.todayTokens == 300, "today counts: \(first.todayCalls)/\(first.todayTokens)")
        precondition(first.weekCalls == 5 && first.weekTokens == 500, "week counts: \(first.weekCalls)/\(first.weekTokens)")
        precondition(first.totalCalls == 5 && first.totalTokens == 500)
        precondition(first.profiles.count == 1 && first.profiles[0].profile == "GPT-5.6 Codex")
        precondition(first.profiles[0].todayCalls == 3 && first.profiles[0].weekCalls == 5 && first.profiles[0].totalCalls == 5)
        precondition(first.lastCallAt == today.addingTimeInterval(-600))
        let firstScan = codexLastScan()!
        precondition(firstScan.files == 1 && firstScan.changed == 1 && firstScan.bytesRead == Int64(initial.count),
                     "first scan reads the whole file: \(firstScan)")
        let cacheURL = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent(".codex/cache/cc-menubar-session-stats-v4.json")
        precondition(fm.fileExists(atPath: cacheURL.path), "the persistent cache is written after a scan that changed something")
        let cacheJSON = try JSONSerialization.jsonObject(with: Data(contentsOf: cacheURL)) as! [String: Any]
        precondition(cacheJSON["version"] as? Int == 4)
        precondition(cacheJSON["timeZone"] as? String == calendar.timeZone.identifier)
        let entries = cacheJSON["entries"] as! [String: [String: Any]]
        precondition(entries.count == 1 && entries.values.first!["dayKey"] == nil, "v4 entries carry no dayKey")
        let cachedStats = entries.values.first!["stats"] as! [String: Any]
        precondition((cachedStats["days"] as? [String: Any])?.count == 2, "v4 entries carry one bucket per day")

        // (2) append → the incremental path reads exactly the appended bytes.
        total += 100
        let appended = try encode([tokenLine(timestamp: iso.string(from: today.addingTimeInterval(-300)), total: total, last: 100)])
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: appended)
        try handle.close()
        let second = loadCodexSessionStats(root: root.path, now: today, calendar: calendar)
        precondition(second.todayCalls == 4 && second.todayTokens == 400, "appended call counted: \(second.todayCalls)")
        precondition(second.weekCalls == 6 && second.totalCalls == 6)
        let secondScan = codexLastScan()!
        precondition(secondScan.files == 1 && secondScan.changed == 1 && secondScan.bytesRead == Int64(appended.count),
                     "incremental scan reads only the appended bytes: \(secondScan)")

        // (3) rollover: same file, "now" one day later → re-aggregated from buckets, nothing re-parsed, nothing rewritten.
        let cacheModifiedBefore = try fm.attributesOfItem(atPath: cacheURL.path)[.modificationDate] as! Date
        let rolled = loadCodexSessionStats(root: root.path, now: tomorrow, calendar: calendar)
        precondition(rolled.todayCalls == 0 && rolled.todayTokens == 0, "yesterday's calls left today: \(rolled.todayCalls)")
        precondition(rolled.weekCalls == 6 && rolled.weekTokens == 600)
        precondition(rolled.totalCalls == 6 && rolled.totalTokens == 600)
        precondition(rolled.profiles[0].todayCalls == 0 && rolled.profiles[0].weekCalls == 6)
        let rolledScan = codexLastScan()!
        precondition(rolledScan.files == 1 && rolledScan.changed == 0 && rolledScan.bytesRead == 0,
                     "rollover must not re-parse: \(rolledScan)")
        let cacheModifiedAfter = try fm.attributesOfItem(atPath: cacheURL.path)[.modificationDate] as! Date
        precondition(cacheModifiedAfter == cacheModifiedBefore, "rollover must not rewrite the persistent cache")

        // (4) truncated / rewritten file (size shrinks) → full re-parse.
        let rewritten = try encode([lines[0], lines[1]]) // turn_context + one yesterday call
        precondition(rewritten.count < initial.count + appended.count)
        try rewritten.write(to: file)
        let truncated = loadCodexSessionStats(root: root.path, now: today, calendar: calendar)
        precondition(truncated.todayCalls == 0 && truncated.weekCalls == 1 && truncated.totalCalls == 1,
                     "rewritten file is re-read from scratch: \(truncated.totalCalls)")
        precondition(truncated.totalTokens == 100)
        let truncatedScan = codexLastScan()!
        precondition(truncatedScan.files == 1 && truncatedScan.changed == 1 && truncatedScan.bytesRead == Int64(rewritten.count),
                     "a shrunk file is fully re-parsed: \(truncatedScan)")
    }

    private static func tokenLine(timestamp: String, total: Int, last: Int) -> [String: Any] {
        [
            "timestamp": timestamp,
            "type": "event_msg",
            "payload": [
                "type": "token_count",
                "info": [
                    "model_context_window": 1_000_000,
                    "total_token_usage": ["total_tokens": total],
                    "last_token_usage": ["total_tokens": last],
                ],
            ],
        ]
    }

    private static func encode(_ objects: [[String: Any]]) throws -> Data {
        var data = Data()
        for object in objects {
            data.append(try JSONSerialization.data(withJSONObject: object))
            data.append(0x0A)
        }
        return data
    }
}
