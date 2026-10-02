import Foundation

@main
struct CodexStatusLoaderTests {
    static func main() throws {
        let env = ProcessInfo.processInfo.environment
        guard let home = env["CFFIXED_USER_HOME"] else {
            print("Refusing fixture writes outside an isolated temporary home")
            exit(2)
        }
        let isolatedHome = URL(fileURLWithPath: home).resolvingSymlinksInPath()
        let temp = URL(fileURLWithPath: env["TMPDIR"] ?? FileManager.default.temporaryDirectory.path).resolvingSymlinksInPath()
        let expected = [
            "CC_MENUBAR_CODEX_HOME": home + "/.codex",
            "CC_MENUBAR_CODEX_SESSIONS": home + "/.codex/sessions",
            "CC_MENUBAR_CODEX_CALL_LOG": home + "/calls.jsonl",
        ]
        guard isolatedHome.deletingLastPathComponent().path == temp.path,
              isolatedHome.lastPathComponent.hasPrefix("menubar-usage-check-"),
              URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path == isolatedHome.path,
              expected.allSatisfy({ key, path in
                  env[key] == path && URL(fileURLWithPath: path).resolvingSymlinksInPath().path.hasPrefix(isolatedHome.path + "/")
              }) else {
            print("Refusing fixture writes outside an isolated temporary home: root=\(isolatedHome.deletingLastPathComponent().path == temp.path) prefix=\(isolatedHome.lastPathComponent.hasPrefix("menubar-usage-check-")) home=\(URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path == isolatedHome.path) env=\(expected.allSatisfy { key, path in env[key] == path && URL(fileURLWithPath: path).resolvingSymlinksInPath().path.hasPrefix(isolatedHome.path + "/") })")
            exit(2)
        }
        let childMode = CommandLine.arguments.count == 3 && ["--legacy-cache-check", "--cumulative-cache-check", "--last-only-cache-check"].contains(CommandLine.arguments[1])
        let protectedPaths = ["last-only-fixture", "last-only-fixture/fixture.jsonl", "long-line-fixture", "long-line-fixture/fixture.jsonl", "cumulative-fixture", "cumulative-fixture/fixture.jsonl", "component-fixture", "component-fixture/fixture.jsonl", "session-fixture", "session-fixture/fixture.jsonl", ".codex", ".codex/auth.json", ".codex/config.toml", ".codex/cache", ".codex/cache/cc-menubar-session-stats-v4.json", "calls.jsonl"]
        guard protectedPaths.allSatisfy({ relative in
            let url = isolatedHome.appendingPathComponent(relative)
            return url.resolvingSymlinksInPath().path == url.path
        }), childMode || ["last-only-fixture", "long-line-fixture", "session-fixture", "cumulative-fixture", "component-fixture", ".codex", "calls.jsonl"].allSatisfy({
            !FileManager.default.fileExists(atPath: isolatedHome.appendingPathComponent($0).path)
        }) else {
            print("Refusing fixture writes outside an isolated temporary home")
            exit(2)
        }
        if CommandLine.arguments.count == 3 && ["--legacy-cache-check", "--cumulative-cache-check", "--last-only-cache-check"].contains(CommandLine.arguments[1]) {
            let fixture = URL(fileURLWithPath: CommandLine.arguments[2]).resolvingSymlinksInPath()
            let fixtureName = CommandLine.arguments[1] == "--legacy-cache-check" ? "session-fixture" : (CommandLine.arguments[1] == "--last-only-cache-check" ? "last-only-fixture" : "cumulative-fixture")
            guard fixture.path == isolatedHome.appendingPathComponent(fixtureName).path else {
                print("Refusing fixture writes outside an isolated temporary home")
                exit(2)
            }
            let restored = loadCodexSessionStats(root: fixture.path)
            if CommandLine.arguments[1] == "--last-only-cache-check" {
                precondition(restored.todayTokens == 150 && restored.todayCalls == 2)
                return
            }
            if CommandLine.arguments[1] == "--cumulative-cache-check" {
                precondition(restored.todayTokens == 1_800)
                precondition(restored.todayCalls == 4)
                return
            }
            precondition(restored.secondaryUsedPercent == 7, "Older mixed-model cache must not be reused")
            precondition(restored.primaryUsedPercent == nil)
            precondition(restored.todayTokens == 1_400)
            precondition(restored.todayCalls == 4)
            print("Legacy quota cache rejected")
            return
        }
        precondition(codexModelRecommendations.count == 4)
        precondition(codexModelRecommendations[0] == CodexModelRecommendation(task: "구현·설계", model: "gpt-5.6", effort: "medium · 복잡하면 high"))
        precondition(codexModelRecommendations[2].model == "gpt-5.6-terra")

        let root = isolatedHome.appendingPathComponent("session-fixture", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let timestamp = ISO8601DateFormatter().string(from: Date())
        let lines: [[String: Any]] = [
            [
                "timestamp": timestamp,
                "type": "turn_context",
                "payload": ["model": "gpt-5.6-codex"],
            ],
            tokenLine(timestamp: timestamp, total: 1_000, last: 400, primary: 17, secondary: 3),
            tokenLine(timestamp: timestamp, total: 1_600, last: 600, primary: 18, secondary: 4),
        ]
        let data = try lines.map { object -> Data in
            var line = try JSONSerialization.data(withJSONObject: object)
            line.append(0x0A)
            return line
        }.reduce(into: Data()) { $0.append($1) }
        try data.write(to: root.appendingPathComponent("fixture.jsonl"))

        let stats = loadCodexSessionStats(root: root.path)
        precondition(stats.todayCalls == 2)
        precondition(stats.weekCalls == 2)
        precondition(stats.todayTokens == 1_000)
        precondition(stats.weekTokens == 1_000)
        precondition(stats.primaryUsedPercent == 18)
        precondition(stats.secondaryUsedPercent == 4)
        precondition(stats.planType == "pro")
        precondition(stats.profiles.count == 1)
        precondition(stats.profiles[0].profile == "GPT-5.6 Codex")

        let appended = tokenLine(timestamp: timestamp, total: 1_900, last: 300, primary: 19, secondary: 5)
        var appendedData = try JSONSerialization.data(withJSONObject: appended)
        appendedData.append(0x0A)
        let handle = try FileHandle(forWritingTo: root.appendingPathComponent("fixture.jsonl"))
        try handle.seekToEnd()
        try handle.write(contentsOf: appendedData)
        try handle.close()

        let incremental = loadCodexSessionStats(root: root.path)
        precondition(incremental.todayCalls == 3)
        precondition(incremental.todayTokens == 1_300)
        precondition(incremental.primaryUsedPercent == 19)
        precondition(incremental.secondaryUsedPercent == 5)

        var spark = tokenLine(timestamp: timestamp, total: 2_000, last: 100, primary: 0, secondary: 0)
        var sparkPayload = spark["payload"] as! [String: Any]
        var sparkRate = sparkPayload["rate_limits"] as! [String: Any]
        sparkRate["limit_id"] = "codex_spark"
        sparkRate["rate_limit_reached_type"] = "weekly"
        sparkPayload["rate_limits"] = sparkRate
        spark["payload"] = sparkPayload
        try append(spark, to: root)
        let afterSpark = loadCodexSessionStats(root: root.path)
        precondition(afterSpark.primaryUsedPercent == 19, "Spark zero must not overwrite general Codex quota")
        precondition(afterSpark.secondaryUsedPercent == 5)
        precondition(afterSpark.todayTokens == 1_400, "Spark token usage must remain counted")
        precondition(afterSpark.quotaEvents == 0, "Model quota must not become a general quota event")
        precondition(afterSpark.profiles[0].quotaEvents == 1, "Model-specific quota history must remain visible")

        var quotaOnly = tokenLine(timestamp: timestamp, total: 2_000, last: 100, primary: 23, secondary: 7)
        try append(quotaOnly, to: root)
        let afterDuplicate = loadCodexSessionStats(root: root.path)
        precondition(afterDuplicate.primaryUsedPercent == 23, "Unchanged token totals may carry fresh quota")
        precondition(afterDuplicate.todayTokens == 1_400)
        precondition(afterDuplicate.todayCalls == 4)
        var payload = quotaOnly["payload"] as! [String: Any]
        payload.removeValue(forKey: "info")
        var rate = payload["rate_limits"] as! [String: Any]
        rate.removeValue(forKey: "primary")
        payload["rate_limits"] = rate
        quotaOnly["payload"] = payload
        try append(quotaOnly, to: root)
        let afterQuotaOnly = loadCodexSessionStats(root: root.path)
        precondition(afterQuotaOnly.primaryUsedPercent == nil, "Absent windows must not retain stale percentages")
        precondition(afterQuotaOnly.primaryResetAt == nil)
        precondition(afterQuotaOnly.secondaryUsedPercent == 7)
        precondition(afterQuotaOnly.todayTokens == 1_400)
        precondition(afterQuotaOnly.todayCalls == 4, "Quota-only events are not inference calls")

        for limit in ["codex_future_model", ""] {
            var untrusted = tokenLine(timestamp: timestamp, total: 2_100, last: 100, primary: 99, secondary: 99)
            var payload = untrusted["payload"] as! [String: Any]
            var rate = payload["rate_limits"] as! [String: Any]
            if limit.isEmpty { rate.removeValue(forKey: "limit_id") } else { rate["limit_id"] = limit }
            payload.removeValue(forKey: "info")
            payload["rate_limits"] = rate
            untrusted["payload"] = payload
            try append(untrusted, to: root)
        }
        let unknown = loadCodexSessionStats(root: root.path)
        precondition(unknown.primaryUsedPercent == nil)
        precondition(unknown.secondaryUsedPercent == 7, "Unknown/unlabeled limits must not be treated as general Codex")
        precondition(unknown.todayTokens == 1_400)
        precondition(unknown.todayCalls == 4)
        let cacheURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".codex/cache/cc-menubar-session-stats-v4.json")
        var poisoned = try JSONSerialization.jsonObject(with: Data(contentsOf: cacheURL)) as! [String: Any]
        var entries = poisoned["entries"] as! [String: [String: Any]]
        for path in Array(entries.keys) {
            var entry = entries[path]!
            var cached = entry["stats"] as! [String: Any]
            cached["primaryUsedPercent"] = 0
            cached["secondaryUsedPercent"] = 0
            entry["stats"] = cached
            entries[path] = entry
        }
        poisoned["entries"] = entries
        for legacyVersion in [1, 2] {
            poisoned["version"] = legacyVersion
            try JSONSerialization.data(withJSONObject: poisoned).write(to: cacheURL)
            let child = Process()
            child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            child.arguments = ["--legacy-cache-check", root.path]
            try child.run()
            child.waitUntilExit()
            precondition(child.terminationStatus == 0)
        }
        let fixtureHome = URL(fileURLWithPath: codexHomePath())
        try FileManager.default.createDirectory(at: fixtureHome, withIntermediateDirectories: true)
        try Data("{\"auth_mode\":\"chatgpt\",\"tokens\":{}}".utf8).write(to: fixtureHome.appendingPathComponent("auth.json"))
        try Data("model = \"gpt-6\"\n".utf8).write(to: fixtureHome.appendingPathComponent("config.toml"))
        let sessions = URL(fileURLWithPath: codexSessionsPath())
        try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
        var historicalLine = tokenLine(timestamp: timestamp, total: 1_000, last: 400, primary: 99, secondary: 99)
        var historicalPayload = historicalLine["payload"] as! [String: Any]
        var historicalRate = historicalPayload["rate_limits"] as! [String: Any]
        historicalRate["rate_limit_reached_type"] = "weekly"
        historicalPayload["rate_limits"] = historicalRate
        historicalLine["payload"] = historicalPayload
        var historical = try JSONSerialization.data(withJSONObject: historicalLine)
        historical.append(0x0A)
        try historical.write(to: sessions.appendingPathComponent("old-account.jsonl"))
        let health = loadCodexHealth()
        precondition(health.overallStatus == "ok", "A historical account's percentage is not the current account's warning")
        precondition(!health.hints.contains { $0.contains("제한 높음") })
        precondition(health.todayTokens == 400)
        precondition(health.quotaEvents == 1, "General quota history remains available")
        precondition(!health.hints.contains { $0.contains("쿼터") })
        precondition(health.titleSlot == "Codex 400/d")

        try FileManager.default.removeItem(at: sessions.appendingPathComponent("old-account.jsonl"))
        let callLog = URL(fileURLWithPath: codexCallLogPath())
        var fallbackData = Data()
        for limit in ["codex_spark", "codex_future_model", ""] {
            var event: [String: Any] = ["ts": timestamp, "profile": "spark", "verdict_class": "pass_quota"]
            if !limit.isEmpty { event["limit_id"] = limit }
            fallbackData.append(try JSONSerialization.data(withJSONObject: event))
            fallbackData.append(0x0A)
        }
        try fallbackData.write(to: callLog)
        let fallbackStats = loadCodexCallStats(path: callLog.path)
        precondition(fallbackStats.quotaEvents == 0)
        precondition(fallbackStats.totalCalls == 3)
        precondition(fallbackStats.profiles[0].quotaEvents == 3)
        let fallbackHealth = loadCodexHealth()
        precondition(fallbackHealth.overallStatus == "ok")
        precondition(!fallbackHealth.hints.contains { $0.contains("쿼터") })

        var event = spark
        let duplicateHistoryTimestamp = ISO8601DateFormatter().string(from: Date().addingTimeInterval(10))
        event["timestamp"] = duplicateHistoryTimestamp
        try append(event, to: root)
        try append(event, to: root)
        let duplicateHistory = loadCodexSessionStats(root: root.path)
        precondition(duplicateHistory.profiles[0].quotaEvents == 2, "New model quota history survives duplicate token totals; identical events count once")
        var eventPayload = event["payload"] as! [String: Any]
        eventPayload.removeValue(forKey: "info")
        event["payload"] = eventPayload
        event["timestamp"] = ISO8601DateFormatter().string(from: Date().addingTimeInterval(20))
        try append(event, to: root)
        var repeated = spark
        repeated["timestamp"] = duplicateHistoryTimestamp
        try append(repeated, to: root)
        let quotaHistory = loadCodexSessionStats(root: root.path)
        precondition(quotaHistory.profiles[0].quotaEvents == 3, "Quota-only model history survives")
        precondition(quotaHistory.profiles[0].lastVerdict == "pass_quota")
        precondition(quotaHistory.quotaEvents == 0)
        precondition(quotaHistory.todayCalls == 4)
        precondition(quotaHistory.todayTokens == 1_400)
        var onlyHistory = try JSONSerialization.data(withJSONObject: event)
        onlyHistory.append(0x0A)
        try onlyHistory.write(to: sessions.appendingPathComponent("quota-only.jsonl"))
        let onlyHistoryHealth = loadCodexHealth()
        precondition(onlyHistoryHealth.todayCalls == 0)
        precondition(onlyHistoryHealth.todayTokens == 0)
        precondition(onlyHistoryHealth.profiles.count == 1)
        precondition(onlyHistoryHealth.profiles[0].quotaEvents == 1, "Pure model quota-only sessions remain visible as history")
        precondition(onlyHistoryHealth.overallStatus == "ok")
        try FileManager.default.removeItem(at: sessions.appendingPathComponent("quota-only.jsonl"))
        for (index, limit) in ["codex", "codex_spark", "codex_future", "unlabeled"].enumerated() {
            for infoKind in 0...8 {
                var snapshotPayload: [String: Any] = ["type": "token_count", "rate_limits": ["limit_id": limit, "primary": ["used_percent": 0]]]
                if infoKind % 3 == 1 { snapshotPayload["info"] = [String: Any]() }
                if infoKind % 3 == 2 { snapshotPayload["info"] = ["model_context_window": 1000] }
                if infoKind / 3 == 1 { snapshotPayload["rate_limits"] = ["limit_id": limit] }
                if infoKind / 3 == 2 { snapshotPayload["rate_limits"] = ["limit_id": limit, "primary": NSNull(), "secondary": NSNull()] }
                let path = sessions.appendingPathComponent("snapshot-\(index)-\(infoKind).jsonl")
                var snapshotData = try JSONSerialization.data(withJSONObject: ["timestamp": timestamp, "type": "event_msg", "payload": snapshotPayload])
                snapshotData.append(0x0A)
                try snapshotData.write(to: path)
                let snapshotHealth = loadCodexHealth()
                precondition(snapshotHealth.todayCalls == 0, "Quota snapshots without usage fields are not calls")
                precondition(snapshotHealth.todayTokens == 0)
                precondition(snapshotHealth.quotaEvents == 0)
                precondition(snapshotHealth.profiles.count == 1, "Quota-only profiles must not be replaced by fallback history")
                precondition(snapshotHealth.profiles[0].profile == "Codex")
                try FileManager.default.removeItem(at: path)
            }
        }
        let cumulativeRoot = isolatedHome.appendingPathComponent("cumulative-fixture")
        try FileManager.default.createDirectory(at: cumulativeRoot, withIntermediateDirectories: true)
        try Data().write(to: cumulativeRoot.appendingPathComponent("fixture.jsonl"))
        for total in [1_000, 1_600] {
            var cumulative = tokenLine(timestamp: timestamp, total: total, last: 0, primary: 1, secondary: 1)
            var payload = cumulative["payload"] as! [String: Any]
            var info = payload["info"] as! [String: Any]
            info.removeValue(forKey: "last_token_usage")
            payload["info"] = info
            cumulative["payload"] = payload
            try append(cumulative, to: cumulativeRoot)
            let measured = loadCodexSessionStats(root: cumulativeRoot.path)
            precondition(measured.todayTokens == total, "Cumulative-only events must add the delta, including incremental scans")
        }
        var emptyTotal = tokenLine(timestamp: timestamp, total: 0, last: 100, primary: 1, secondary: 1)
        var emptyPayload = emptyTotal["payload"] as! [String: Any]
        var emptyInfo = emptyPayload["info"] as! [String: Any]
        emptyInfo["total_token_usage"] = [String: Any]()
        emptyPayload["info"] = emptyInfo
        emptyTotal["payload"] = emptyPayload
        try append(emptyTotal, to: cumulativeRoot)
        let afterEmptyTotal = loadCodexSessionStats(root: cumulativeRoot.path)
        precondition(afterEmptyTotal.todayTokens == 1_700, "An empty cumulative object must not discard valid last usage")
        precondition(afterEmptyTotal.todayCalls == 3)
        var resumed = tokenLine(timestamp: timestamp, total: 1_800, last: 0, primary: 1, secondary: 1)
        var resumedPayload = resumed["payload"] as! [String: Any]
        var resumedInfo = resumedPayload["info"] as! [String: Any]
        resumedInfo.removeValue(forKey: "last_token_usage")
        resumedPayload["info"] = resumedInfo
        resumed["payload"] = resumedPayload
        try append(resumed, to: cumulativeRoot)
        let reconciled = loadCodexSessionStats(root: cumulativeRoot.path)
        precondition(reconciled.todayTokens == 1_800, "A resumed cumulative counter must not double-count last-only usage")
        precondition(reconciled.todayCalls == 4)
        for cold in [false, true] {
            if cold { try Data("{}".utf8).write(to: cacheURL) }
            let check = Process()
            check.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            check.arguments = ["--cumulative-cache-check", cumulativeRoot.path]
            try check.run()
            check.waitUntilExit()
            precondition(check.terminationStatus == 0)
        }
        let componentRoot = isolatedHome.appendingPathComponent("component-fixture")
        try FileManager.default.createDirectory(at: componentRoot, withIntermediateDirectories: true)
        try Data().write(to: componentRoot.appendingPathComponent("fixture.jsonl"))
        for total in [1_000, 1_600] {
            var cumulative = tokenLine(timestamp: timestamp, total: total, last: 0, primary: 1, secondary: 1)
            var payload = cumulative["payload"] as! [String: Any]
            payload["info"] = ["total_token_usage": ["input_tokens": total, "cached_input_tokens": 500, "output_tokens": 100, "reasoning_output_tokens": 50]]
            cumulative["payload"] = payload
            try append(cumulative, to: componentRoot)
            let measured = loadCodexSessionStats(root: componentRoot.path)
            precondition(measured.todayTokens == total + 100, "Component totals include cached input and reasoning subsets only once")
        }
        let lastRoot = isolatedHome.appendingPathComponent("last-only-fixture")
        try FileManager.default.createDirectory(at: lastRoot, withIntermediateDirectories: true)
        try Data().write(to: lastRoot.appendingPathComponent("fixture.jsonl"))
        let lastOnly: [String: Any] = ["type": "event_msg", "timestamp": timestamp,
            "payload": ["type": "token_count", "info": ["last_token_usage": ["total_tokens": 100]]]]
        let onlyQuota: [String: Any] = ["type": "event_msg", "timestamp": timestamp,
            "payload": ["type": "token_count", "rate_limits": ["limit_id": "codex", "secondary": ["used_percent": 31]]]]
        for object in [lastOnly, onlyQuota, lastOnly] {
            try append(object, to: lastRoot)
            let measured = loadCodexSessionStats(root: lastRoot.path)
            precondition(measured.todayTokens == 100 && measured.todayCalls == 1, "Repeated last-only events must not inflate tokens")
        }
        let totalOnly: [String: Any] = ["type": "event_msg", "timestamp": timestamp,
            "payload": ["type": "token_count", "info": ["total_token_usage": ["total_tokens": 150]]]]
        try append(totalOnly, to: lastRoot)
        precondition(loadCodexSessionStats(root: lastRoot.path).todayTokens == 150)
        try append(lastOnly, to: lastRoot)
        for cold in [false, true] {
            if cold { try Data("{}".utf8).write(to: cacheURL) }
            let check = Process()
            check.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            check.arguments = ["--last-only-cache-check", lastRoot.path]
            try check.run()
            check.waitUntilExit()
            precondition(check.terminationStatus == 0)
        }
        var distinctLast = lastOnly
        distinctLast["event_id"] = "different-call"
        try append(distinctLast, to: lastRoot)
        precondition(loadCodexSessionStats(root: lastRoot.path).todayTokens == 250, "Distinct event identities must remain separate")
        var undatedLast = lastOnly
        undatedLast.removeValue(forKey: "timestamp")
        try append(undatedLast, to: lastRoot)
        try append(undatedLast, to: lastRoot)
        let undatedStats = loadCodexSessionStats(root: lastRoot.path)
        precondition(undatedStats.totalTokens == 450 && undatedStats.totalCalls == 5, "Undated events lack a reliable replay identity")
        let longRoot = isolatedHome.appendingPathComponent("long-line-fixture")
        try FileManager.default.createDirectory(at: longRoot, withIntermediateDirectories: true)
        let longFile = longRoot.appendingPathComponent("fixture.jsonl")
        var longData = Data(repeating: 120, count: 32 * 1024 * 1024 + 3)
        longData.append(0x0A)
        try longData.write(to: longFile)
        try append(["type": "turn_context", "payload": ["model": "gpt-5.6-codex"]], to: longRoot)
        try append(tokenLine(timestamp: timestamp, total: 400, last: 400, primary: 1, secondary: 2), to: longRoot)
        let unfinished = try JSONSerialization.data(withJSONObject: tokenLine(timestamp: timestamp, total: 900, last: 500, primary: 3, secondary: 4))
        let writer = try FileHandle(forWritingTo: longFile)
        try writer.seekToEnd()
        try writer.write(contentsOf: unfinished)
        let scanStarted = ProcessInfo.processInfo.systemUptime
        let longStats = loadCodexSessionStats(root: longRoot.path)
        let scanSeconds = ProcessInfo.processInfo.systemUptime - scanStarted
        precondition(longStats.todayTokens == 400 && longStats.todayCalls == 1)
        precondition(longStats.profiles.first?.profile == "GPT-5.6 Codex")
        precondition(scanSeconds < 10, "Long lines must not repeatedly scan the buffered prefix")
        try writer.write(contentsOf: Data([0x0A]))
        try writer.close()
        try append(tokenLine(timestamp: timestamp, total: 1_000, last: 100, primary: 5, secondary: 6), to: longRoot)
        let completedStats = loadCodexSessionStats(root: longRoot.path)
        precondition(completedStats.todayTokens == 1_000 && completedStats.todayCalls == 3)
        precondition(completedStats.primaryUsedPercent == 5 && completedStats.secondaryUsedPercent == 6)
        print("Long-line scan seconds: \(scanSeconds)")
        print("CodexStatusLoaderTests: all usage regressions passed")
    }

    private static func append(_ object: [String: Any], to root: URL) throws {
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        let handle = try FileHandle(forWritingTo: root.appendingPathComponent("fixture.jsonl"))
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
    }

    private static func tokenLine(
        timestamp: String,
        total: Int,
        last: Int,
        primary: Double,
        secondary: Double
    ) -> [String: Any] {
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
                "rate_limits": [
                    "limit_id": "codex",
                    "plan_type": "pro",
                    "primary": ["used_percent": primary, "resets_at": Date().addingTimeInterval(3_600).timeIntervalSince1970],
                    "secondary": ["used_percent": secondary, "resets_at": Date().addingTimeInterval(86_400).timeIntervalSince1970],
                ],
            ],
        ]
    }
}
