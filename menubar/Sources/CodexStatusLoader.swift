import Foundation
import CryptoKit

func loadCodexConfigSummary(path: String) -> CodexConfigSummary {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
        return CodexConfigSummary(present: false, model: nil, reasoningEffort: nil, serviceTier: nil, contextWindow: nil)
    }

    var model: String?
    var effort: String?
    var tier: String?
    var window: Int?

    for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
        let line = String(rawLine).trimmingCharacters(in: .whitespaces)
        if line.isEmpty || line.hasPrefix("#") { continue }
        if line.hasPrefix("[") { break }
        guard let eq = line.firstIndex(of: "=") else { continue }
        let key = line[..<eq].trimmingCharacters(in: .whitespaces)
        let rawValue = line[line.index(after: eq)...]
        guard let value = codexTomlValue(String(rawValue)) else { continue }

        switch key {
        case "model":
            model = value
        case "model_reasoning_effort":
            effort = value
        case "service_tier":
            tier = value
        case "model_context_window":
            window = Int(value)
        default:
            continue
        }
    }

    return CodexConfigSummary(present: true, model: model, reasoningEffort: effort, serviceTier: tier, contextWindow: window)
}

private struct CodexSessionFile {
    let url: URL
    let modifiedAt: Date
    let size: Int64
}

/// 세션 파일의 하루치 집계. 카운터는 파싱 시점에 "오늘/이번 주"를 판정하지 않고 날짜 키(`codexDayKey`)로만 쌓이고,
/// 오늘/7일/전체는 읽는 시점에 `codexAggregate`가 버킷을 골라 더한다. 그래서 날짜가 바뀌어도 파일을 다시 읽지 않는다.
/// 최상위 버킷은 `byProfile`에 프로필별 하위 버킷을 품고, 하위 버킷은 `byProfile == nil`이다.
struct CodexDayBucket: Codable, Equatable {
    var calls = 0
    var tokens = 0
    /// 최상위: `limit_id == "codex"`인 rate-limit-reached 이벤트만. 프로필 하위: 그 프로필의 이벤트 전부(limit 무관).
    var quotaEvents = 0
    var errorEvents = 0
    var byProfile: [String: CodexDayBucket]?
    var lastCallAt: Date?
    /// 프로필 하위 버킷만: `lastCallAt` 호출의 판정("ok"/"pass_quota"). 날짜 없는 호출은 lastCallAt 없이 판정만 남는다.
    var lastVerdict: String?
    /// 프로필 하위 버킷만: 그날 마지막 rate-limit-reached 시각. 집계 때 7일 안이면 lastVerdict를 "pass_quota"로 덮는다.
    var lastQuotaAt: Date?

    /// 같은 날짜 키의 버킷을 합친다(파일 여러 개 → 하루). `lastCallAt` 동률은 먼저 온 쪽을 유지한다(파일 순서 병합).
    mutating func merge(_ other: CodexDayBucket) {
        calls += other.calls
        tokens += other.tokens
        quotaEvents += other.quotaEvents
        errorEvents += other.errorEvents
        if let date = other.lastCallAt, lastCallAt == nil || date > lastCallAt! {
            lastCallAt = date
            lastVerdict = other.lastVerdict
        } else if lastCallAt == nil, let verdict = other.lastVerdict {
            lastVerdict = verdict
        }
        if let quotaAt = other.lastQuotaAt, lastQuotaAt == nil || quotaAt > lastQuotaAt! {
            lastQuotaAt = quotaAt
        }
        if let profiles = other.byProfile {
            var merged = byProfile ?? [:]
            for (profile, row) in profiles {
                var current = merged[profile] ?? CodexDayBucket()
                current.merge(row)
                merged[profile] = current
            }
            byProfile = merged
        }
    }
}

/// `codexAggregate`의 결과. `loadCodexSessionStats`가 `CodexCallStats`로 옮겨 담는다.
struct CodexBucketTotals {
    var todayCalls = 0
    var weekCalls = 0
    var totalCalls = 0
    var todayTokens = 0
    var weekTokens = 0
    var totalTokens = 0
    var quotaEvents = 0
    var errorEvents = 0
    var byProfile: [String: CodexMutableProfile] = [:]
}

/// 타임스탬프가 없는 이벤트의 버킷 키. 오늘/7일에는 절대 들지 않고 전체 합계에만 든다.
let codexUndatedDayKey = "undated"

/// 날짜 버킷을 `now` 기준으로 오늘/7일/전체로 접는다(순수 함수, 파일 I/O 없음).
/// - 오늘: `codexDayKey(now)`와 같은 키.
/// - 7일: 버킷의 날짜가 `now - 7일`이 속한 날 이후(그날 포함). 예전 시각 단위 창(`date >= now - 7d`)이 걸치던 날을 버리지 않는다.
/// - 전체: 날짜 없는(`codexUndatedDayKey`) 버킷까지 모두.
/// 프로필 판정: 호출 기준 마지막 판정 위에, 7일 안의 마지막 rate-limit-reached가 그 이후(동시각 포함)면 "pass_quota".
func codexAggregate(buckets: [String: CodexDayBucket], now: Date, calendar: Calendar = .current) -> CodexBucketTotals {
    let todayKey = codexDayKey(now, calendar: calendar)
    let weekStartDay = calendar.startOfDay(for: calendar.date(byAdding: .day, value: -7, to: now) ?? now)
    var totals = CodexBucketTotals()
    var weekQuotaAt: [String: Date] = [:]

    for (key, bucket) in buckets {
        let isToday = key == todayKey
        let isWeek = codexDayKeyDate(key, calendar: calendar).map { $0 >= weekStartDay } ?? false
        totals.totalCalls += bucket.calls
        totals.totalTokens += bucket.tokens
        if isToday {
            totals.todayCalls += bucket.calls
            totals.todayTokens += bucket.tokens
        }
        if isWeek {
            totals.weekCalls += bucket.calls
            totals.weekTokens += bucket.tokens
            totals.quotaEvents += bucket.quotaEvents
            totals.errorEvents += bucket.errorEvents
        }
        for (profile, row) in bucket.byProfile ?? [:] {
            var merged = totals.byProfile[profile] ?? CodexMutableProfile()
            merged.totalCalls += row.calls
            merged.totalTokens += row.tokens
            if isToday {
                merged.todayCalls += row.calls
                merged.todayTokens += row.tokens
            }
            if isWeek {
                merged.weekCalls += row.calls
                merged.weekTokens += row.tokens
                merged.quotaEvents += row.quotaEvents
                merged.errorEvents += row.errorEvents
                if let quotaAt = row.lastQuotaAt, weekQuotaAt[profile] == nil || quotaAt > weekQuotaAt[profile]! {
                    weekQuotaAt[profile] = quotaAt
                }
            }
            if let date = row.lastCallAt, merged.lastAt == nil || date > merged.lastAt! {
                merged.lastAt = date
                merged.lastVerdict = row.lastVerdict ?? "-"
            } else if merged.lastAt == nil, let verdict = row.lastVerdict {
                merged.lastVerdict = verdict
            }
            totals.byProfile[profile] = merged
        }
    }
    for (profile, quotaAt) in weekQuotaAt {
        guard var row = totals.byProfile[profile] else { continue }
        if row.lastAt == nil || quotaAt >= row.lastAt! {
            row.lastAt = quotaAt
            row.lastVerdict = "pass_quota"
        }
        totals.byProfile[profile] = row
    }
    return totals
}

private struct CodexSessionFileStats: Codable {
    var days: [String: CodexDayBucket] = [:]
    var lastCallAt: Date?
    var latestModel: String?
    var latestContextWindow: Int?
    var latestRateAt: Date?
    var planType: String?
    var primaryUsedPercent: Double?
    var secondaryUsedPercent: Double?
    var primaryResetAt: Date?
    var secondaryResetAt: Date?
    var currentModel = "Codex"
    var lastCumulativeTotal: Int?
    var seenQuotaEventKeys: Set<String> = []
    var seenLastUsageEventKeys: Set<String> = []
    var parsedBytes: Int64 = 0
}

private let codexSessionStatsCacheLock = NSLock()
private var codexSessionStatsCache: (signature: String, stats: CodexCallStats)?
private var codexSessionFileStatsCache: [String: (modifiedAt: Int, size: Int64, stats: CodexSessionFileStats)] = [:]
/// 버킷 키가 지역 날짜라서, 시간대가 바뀌면 메모리·디스크 캐시를 모두 버리고 다시 읽는다.
private var codexSessionFileStatsCacheTimeZone: String?
private var codexPersistentCacheLoaded = false
private let codexTokenCountNeedle = Data("token_count".utf8)
private let codexTurnContextNeedle = Data("turn_context".utf8)
private let codexModelNeedle = Data("\"model\"".utf8)

private struct CodexPersistentFileCacheEntry: Codable {
    let modifiedAt: Int
    let size: Int64
    let stats: CodexSessionFileStats
}

private struct CodexPersistentFileCache: Codable {
    let version: Int
    let timeZone: String?
    let entries: [String: CodexPersistentFileCacheEntry]
}

/// v4: 항목이 날짜 키 대신 하루 버킷을 품고, (수정 시각, 크기)가 같으면 날짜와 무관하게 유효하다. 옛 버전 파일은 그냥 무시한다.
private let codexPersistentFileCacheVersion = 4

private func codexPersistentFileCacheURL() -> URL {
    URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".codex/cache", isDirectory: true)
        .appendingPathComponent("cc-menubar-session-stats-v\(codexPersistentFileCacheVersion).json")
}

private func loadCodexPersistentFileCacheIfNeeded(timeZone: String) {
    codexSessionStatsCacheLock.lock()
    guard !codexPersistentCacheLoaded else {
        codexSessionStatsCacheLock.unlock()
        return
    }
    codexPersistentCacheLoaded = true
    codexSessionStatsCacheLock.unlock()

    let url = codexPersistentFileCacheURL()
    guard let data = try? Data(contentsOf: url),
          let cache = try? JSONDecoder().decode(CodexPersistentFileCache.self, from: data),
          cache.version == codexPersistentFileCacheVersion else {
        return
    }
    guard cache.timeZone == timeZone else {
        // 버킷 키가 현지 날짜라 표준시가 바뀌면 캐시를 버린다. 다음 스캔의 전량 재파싱에 이유를 붙여 둔다.
        print("CODEX-CACHE-TZ: 저장 시각대와 달라 캐시를 버린다")
        fflush(stdout)
        return
    }

    let entries = cache.entries.mapValues { entry in
        (entry.modifiedAt, entry.size, entry.stats)
    }
    codexSessionStatsCacheLock.lock()
    codexSessionFileStatsCache.merge(entries) { current, _ in current }
    codexSessionStatsCacheLock.unlock()
}

private func persistCodexSessionFileStatsCache(timeZone: String) {
    codexSessionStatsCacheLock.lock()
    let entries = codexSessionFileStatsCache.mapValues { entry in
        CodexPersistentFileCacheEntry(
            modifiedAt: entry.modifiedAt,
            size: entry.size,
            stats: entry.stats
        )
    }
    codexSessionStatsCacheLock.unlock()

    let cache = CodexPersistentFileCache(
        version: codexPersistentFileCacheVersion,
        timeZone: timeZone,
        entries: entries
    )
    let url = codexPersistentFileCacheURL()
    let directory = url.deletingLastPathComponent()
    do {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let data = try JSONEncoder().encode(cache)
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        // 옛 판본은 아무도 읽지 않는다. 우리 캐시 폴더의 우리 파일만 지운다.
        for stale in 1..<codexPersistentFileCacheVersion {
            let old = directory.appendingPathComponent("cc-menubar-session-stats-v\(stale).json")
            try? FileManager.default.removeItem(at: old)
        }
    } catch {
        print("CODEX-CACHE-WRITE: \(error.localizedDescription)")
        fflush(stdout)
    }
}

private func emptyCodexCallStats(scannedLogFiles: Int = 0, scannedLogBytes: Int64 = 0) -> CodexCallStats {
    CodexCallStats(
        todayCalls: 0,
        weekCalls: 0,
        totalCalls: 0,
        todayTokens: 0,
        weekTokens: 0,
        totalTokens: 0,
        quotaEvents: 0,
        errorEvents: 0,
        lastCallAt: nil,
        latestModel: nil,
        planType: nil,
        contextWindow: nil,
        primaryUsedPercent: nil,
        secondaryUsedPercent: nil,
        primaryResetAt: nil,
        secondaryResetAt: nil,
        scannedLogFiles: scannedLogFiles,
        scannedLogBytes: scannedLogBytes,
        profiles: []
    )
}

func loadCodexCallStats(path: String) -> CodexCallStats {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
        return emptyCodexCallStats()
    }

    let calendar = Calendar.current
    let now = Date()
    let weekStart = calendar.date(byAdding: .day, value: -7, to: now) ?? Date.distantPast
    var todayCalls = 0
    var weekCalls = 0
    var totalCalls = 0
    var quotaEvents = 0
    var errorEvents = 0
    var lastCallAt: Date?
    var byProfile: [String: CodexMutableProfile] = [:]

    for line in text.split(separator: "\n") {
        guard let data = String(line).data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            continue
        }

        let profile = safeCodexLabel(codexString(obj["profile"]) ?? "default")
        let verdict = codexString(obj["verdict_class"]) ?? "unknown"
        let date = parseCodexDate(obj["ts"])
        let isToday = date.map { calendar.isDateInToday($0) } ?? false
        let isWeek = date.map { $0 >= weekStart } ?? false
        let verdictLower = verdict.lowercased()
        let isQuota = verdictLower.contains("quota")
        let isError = verdictLower != "ok" && !isQuota

        totalCalls += 1
        if isToday { todayCalls += 1 }
        if isWeek { weekCalls += 1 }
        if isWeek, isQuota, codexString(obj["limit_id"]) == "codex" { quotaEvents += 1 }
        if isWeek, isError { errorEvents += 1 }

        var row = byProfile[profile] ?? CodexMutableProfile()
        row.totalCalls += 1
        if isToday { row.todayCalls += 1 }
        if isWeek { row.weekCalls += 1 }
        if isWeek, isQuota { row.quotaEvents += 1 }
        if isWeek, isError { row.errorEvents += 1 }
        if let date = date, lastCallAt == nil || date > lastCallAt! {
            lastCallAt = date
        }
        if let date = date, row.lastAt == nil || date > row.lastAt! {
            row.lastAt = date
            row.lastVerdict = verdict
        } else if row.lastAt == nil {
            row.lastVerdict = verdict
        }
        byProfile[profile] = row
    }

    let profiles = byProfile.map { profile, row in
        CodexProfileHealth(
            profile: profile,
            todayCalls: row.todayCalls,
            weekCalls: row.weekCalls,
            totalCalls: row.totalCalls,
            todayTokens: row.todayTokens,
            weekTokens: row.weekTokens,
            totalTokens: row.totalTokens,
            quotaEvents: row.quotaEvents,
            errorEvents: row.errorEvents,
            lastVerdict: row.lastVerdict,
            lastAt: row.lastAt
        )
    }
    .sorted {
        if $0.todayCalls != $1.todayCalls { return $0.todayCalls > $1.todayCalls }
        if $0.weekCalls != $1.weekCalls { return $0.weekCalls > $1.weekCalls }
        return $0.totalCalls > $1.totalCalls
    }

    return CodexCallStats(
        todayCalls: todayCalls,
        weekCalls: weekCalls,
        totalCalls: totalCalls,
        todayTokens: 0,
        weekTokens: 0,
        totalTokens: 0,
        quotaEvents: quotaEvents,
        errorEvents: errorEvents,
        lastCallAt: lastCallAt,
        latestModel: nil,
        planType: nil,
        contextWindow: nil,
        primaryUsedPercent: nil,
        secondaryUsedPercent: nil,
        primaryResetAt: nil,
        secondaryResetAt: nil,
        scannedLogFiles: 1,
        scannedLogBytes: Int64(text.utf8.count),
        profiles: profiles
    )
}

private func recentCodexSessionFiles(root: String, now: Date, calendar: Calendar) -> [CodexSessionFile] {
    let fm = FileManager.default
    let rootURL = URL(fileURLWithPath: root, isDirectory: true)
    guard fm.fileExists(atPath: rootURL.path) else { return [] }

    let cutoff = calendar.date(byAdding: .day, value: -8, to: now) ?? Date.distantPast
    let keys: [URLResourceKey] = [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey]
    guard let enumerator = fm.enumerator(
        at: rootURL,
        includingPropertiesForKeys: keys,
        options: [.skipsHiddenFiles, .skipsPackageDescendants]
    ) else {
        return []
    }

    var files: [CodexSessionFile] = []
    for case let url as URL in enumerator {
        guard url.pathExtension == "jsonl",
              let values = try? url.resourceValues(forKeys: Set(keys)),
              values.isRegularFile == true,
              let modifiedAt = values.contentModificationDate,
              modifiedAt >= cutoff else {
            continue
        }
        files.append(CodexSessionFile(
            url: url,
            modifiedAt: modifiedAt,
            size: Int64(values.fileSize ?? 0)
        ))
    }
    return files.sorted {
        if $0.modifiedAt != $1.modifiedAt { return $0.modifiedAt < $1.modifiedAt }
        return $0.url.path < $1.url.path
    }
}

/// 집계 결과 캐시의 키. 파일 상태 외에 날짜 키·시간대를 품어서, 날짜가 넘어가면 (파일은 그대로여도) 버킷을 다시 접는다.
private func codexSessionSignature(_ files: [CodexSessionFile], dayKey: String, timeZone: String) -> String {
    dayKey + "|" + timeZone + "\n" + files.map { file in
        "\(file.url.path)|\(Int(file.modifiedAt.timeIntervalSince1970))|\(file.size)"
    }.joined(separator: "\n")
}

/// 버킷 키. `calendar`의 시간대 기준 지역 날짜(`Y-M-D`, 0 채움 없음).
func codexDayKey(_ date: Date, calendar: Calendar) -> String {
    let components = calendar.dateComponents([.year, .month, .day], from: date)
    return "\(components.year ?? 0)-\(components.month ?? 0)-\(components.day ?? 0)"
}

/// `codexDayKey`의 역변환(그날 0시). `codexUndatedDayKey` 등 날짜가 아닌 키는 nil.
private func codexDayKeyDate(_ key: String, calendar: Calendar) -> Date? {
    let parts = key.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 3, let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]) else {
        return nil
    }
    return calendar.date(from: DateComponents(year: year, month: month, day: day))
}

@discardableResult
private func forEachCodexSessionInterestingLine(url: URL, startOffset: Int64, _ body: (Data) -> Void) -> Int64 {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return startOffset }
    defer { handle.closeFile() }
    do {
        try handle.seek(toOffset: UInt64(max(0, startOffset)))
    } catch {
        return startOffset
    }

    let newline = Data([0x0A])
    var buffer = Data()
    var consumedOffset = startOffset
    while true {
        let chunk = handle.readData(ofLength: 64 * 1024)
        if chunk.isEmpty { break }
        let previousCount = buffer.count
        buffer.append(chunk)
        var searchStart = buffer.startIndex + previousCount

        while let newlineRange = buffer.range(of: newline, in: searchStart..<buffer.endIndex) {
            let newlineIndex = newlineRange.lowerBound
            let lineRange = buffer.startIndex..<newlineIndex
            let hasTokenCount = buffer.range(of: codexTokenCountNeedle, options: [], in: lineRange) != nil
            let hasTurnContext = buffer.range(of: codexTurnContextNeedle, options: [], in: lineRange) != nil
                && buffer.range(of: codexModelNeedle, options: [], in: lineRange) != nil
            if hasTokenCount || hasTurnContext {
                let lineData = Data(buffer[lineRange])
                autoreleasepool {
                    body(lineData)
                }
            }
            let consumed = buffer.distance(from: buffer.startIndex, to: newlineIndex) + 1
            buffer.removeFirst(consumed)
            consumedOffset += Int64(consumed)
            searchStart = buffer.startIndex
        }
    }
    return consumedOffset
}

private func codexTokenTotal(_ usage: [String: Any]?) -> Int {
    guard let usage = usage else { return 0 }
    if let total = codexInt(usage["total_tokens"]) {
        return total
    }
    let input = codexInt(usage["input_tokens"]) ?? codexInt(usage["cached_input_tokens"]) ?? 0
    let output = codexInt(usage["output_tokens"]) ?? codexInt(usage["reasoning_output_tokens"]) ?? 0
    return input + output
}

/// `existing.parsedBytes`부터 이어 읽어 날짜 버킷(`days`)을 채운다. "오늘/이번 주" 판정은 여기서 하지 않는다(`codexAggregate`).
private func scanCodexSessionFile(
    _ file: CodexSessionFile,
    calendar: Calendar,
    existing: CodexSessionFileStats? = nil
) -> CodexSessionFileStats {
    var stats = existing ?? CodexSessionFileStats()
    var currentModel = stats.currentModel
    var lastCumulativeTotal = stats.lastCumulativeTotal

    let consumedOffset = forEachCodexSessionInterestingLine(url: file.url, startOffset: stats.parsedBytes) { lineData in
        if lineData.range(of: codexTurnContextNeedle) != nil,
           let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
           codexString(obj["type"]) == "turn_context",
           let payload = obj["payload"] as? [String: Any],
           let model = codexString(payload["model"]) {
            currentModel = model
            return
        }

        guard lineData.range(of: codexTokenCountNeedle) != nil,
              let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
              let payload = obj["payload"] as? [String: Any],
              codexString(payload["type"]) == "token_count" else {
            return
        }

        let date = parseCodexDate(obj["timestamp"])
        let info = payload["info"] as? [String: Any]
        let totalUsage = info?["total_token_usage"] as? [String: Any]
        if let rate = payload["rate_limits"] as? [String: Any],
           codexString(rate["limit_id"]) == "codex",
           let date,
           stats.latestRateAt == nil || date >= stats.latestRateAt! {
            stats.latestRateAt = date
            stats.planType = codexString(rate["plan_type"]) ?? stats.planType
            let primary = rate["primary"] as? [String: Any]
            let secondary = rate["secondary"] as? [String: Any]
            stats.primaryUsedPercent = codexDouble(primary?["used_percent"])
            stats.primaryResetAt = parseCodexDate(primary?["resets_at"])
            stats.secondaryUsedPercent = codexDouble(secondary?["used_percent"])
            stats.secondaryResetAt = parseCodexDate(secondary?["resets_at"])
        }
        let dayKey = date.map { codexDayKey($0, calendar: calendar) } ?? codexUndatedDayKey
        let rawModel = currentModel.isEmpty ? "Codex" : currentModel
        let profile = safeCodexLabel(codexShortenModelName(rawModel))
        var verdict = "ok"
        if payload["rate_limits"] is [String: Any] {
            // rate-limit 스냅샷만 있는 프로필도 목록에 보이게 빈 행을 만들어 둔다.
            var bucket = stats.days[dayKey] ?? CodexDayBucket()
            var profiles = bucket.byProfile ?? [:]
            profiles[profile] = profiles[profile] ?? CodexDayBucket()
            bucket.byProfile = profiles
            stats.days[dayKey] = bucket
        }
        if let rate = payload["rate_limits"] as? [String: Any],
           let reached = codexString(rate["rate_limit_reached_type"]), !reached.isEmpty {
            verdict = "pass_quota"
            let limit = codexString(rate["limit_id"]) ?? "unlabeled"
            let eventKey = "\(limit)|\(codexString(obj["timestamp"]) ?? "undated")|\(rawModel)|\(reached)"
            if stats.seenQuotaEventKeys.insert(eventKey).inserted, let date {
                var bucket = stats.days[dayKey] ?? CodexDayBucket()
                if limit == "codex" { bucket.quotaEvents += 1 }
                var profiles = bucket.byProfile ?? [:]
                var row = profiles[profile] ?? CodexDayBucket()
                row.quotaEvents += 1
                if row.lastQuotaAt == nil || date >= row.lastQuotaAt! {
                    row.lastQuotaAt = date
                }
                profiles[profile] = row
                bucket.byProfile = profiles
                stats.days[dayKey] = bucket
            }
        }
        let usageKeys = ["total_tokens", "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"]
        let lastUsage = info?["last_token_usage"] as? [String: Any]
        guard usageKeys.contains(where: { codexInt(totalUsage?[$0]) != nil || codexInt(lastUsage?[$0]) != nil }) else { return }
        let previousCumulativeTotal = lastCumulativeTotal ?? 0
        let hasCumulativeUsage = usageKeys.contains { codexInt(totalUsage?[$0]) != nil }
        if !hasCumulativeUsage, date != nil,
           let encoded = try? JSONSerialization.data(withJSONObject: ["model": currentModel, "event": obj], options: [.sortedKeys]) {
            let eventKey = SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
            guard stats.seenLastUsageEventKeys.insert(eventKey).inserted else { return }
        }
        if let totalUsage, hasCumulativeUsage {
            let cumulativeTotal = codexTokenTotal(totalUsage)
            if let last = lastCumulativeTotal, cumulativeTotal <= last {
                return
            }
            lastCumulativeTotal = cumulativeTotal
        }

        let tokens: Int
        if let lastUsage, usageKeys.contains(where: { codexInt(lastUsage[$0]) != nil }) {
            tokens = codexTokenTotal(lastUsage)
        } else {
            tokens = max(0, codexTokenTotal(totalUsage) - previousCumulativeTotal)
        }
        if !hasCumulativeUsage {
            lastCumulativeTotal = previousCumulativeTotal + tokens
        }
        var bucket = stats.days[dayKey] ?? CodexDayBucket()
        bucket.calls += 1
        bucket.tokens += tokens
        if let date = date, bucket.lastCallAt == nil || date > bucket.lastCallAt! {
            bucket.lastCallAt = date
        }
        var profiles = bucket.byProfile ?? [:]
        var row = profiles[profile] ?? CodexDayBucket()
        row.calls += 1
        row.tokens += tokens
        if let date = date, stats.lastCallAt == nil || date > stats.lastCallAt! {
            stats.lastCallAt = date
            stats.latestModel = rawModel
            stats.latestContextWindow = codexInt(info?["model_context_window"])
        }
        if let date = date, row.lastCallAt == nil || date > row.lastCallAt! {
            row.lastCallAt = date
            row.lastVerdict = verdict
        } else if row.lastCallAt == nil {
            row.lastVerdict = verdict
        }
        profiles[profile] = row
        bucket.byProfile = profiles
        stats.days[dayKey] = bucket
    }

    stats.currentModel = currentModel
    stats.lastCumulativeTotal = lastCumulativeTotal
    stats.parsedBytes = consumedOffset
    return stats
}

private let codexLastScanReportLock = NSLock()
private var codexLastScanReport: CodexScanReport?

func codexLastScan() -> CodexScanReport? {
    codexLastScanReportLock.lock(); defer { codexLastScanReportLock.unlock() }
    return codexLastScanReport
}

private func recordCodexScan(files: Int, changed: Int, bytesRead: Int64) {
    codexLastScanReportLock.lock(); defer { codexLastScanReportLock.unlock() }
    codexLastScanReport = CodexScanReport(files: files, changed: changed, bytesRead: bytesRead)
}

/// `now`가 오늘/7일 경계를 정한다(테스트가 날짜 넘김을 흉내 내려고 주입). 파일 열거 컷오프(8일)도 같은 기준을 쓴다.
/// 파일별 캐시는 (수정 시각, 크기)로만 유효성을 보므로 날짜가 바뀌어도 버킷을 다시 접을 뿐 파일을 다시 읽지 않는다.
func loadCodexSessionStats(root: String, now: Date = Date(), calendar: Calendar = .current) -> CodexCallStats {
    let files = recentCodexSessionFiles(root: root, now: now, calendar: calendar)
    let scannedBytes = files.reduce(Int64(0)) { $0 + $1.size }
    guard !files.isEmpty else {
        return emptyCodexCallStats()
    }

    let dayKey = codexDayKey(now, calendar: calendar)
    let timeZone = calendar.timeZone.identifier
    codexSessionStatsCacheLock.lock()
    if codexSessionFileStatsCacheTimeZone != timeZone {
        codexSessionFileStatsCache = [:]
        codexSessionStatsCache = nil
        codexSessionFileStatsCacheTimeZone = timeZone
    }
    codexSessionStatsCacheLock.unlock()
    loadCodexPersistentFileCacheIfNeeded(timeZone: timeZone)
    let signature = codexSessionSignature(files, dayKey: dayKey, timeZone: timeZone)
    codexSessionStatsCacheLock.lock()
    if let cached = codexSessionStatsCache, cached.signature == signature {
        codexSessionStatsCacheLock.unlock()
        recordCodexScan(files: files.count, changed: 0, bytesRead: 0)
        return cached.stats
    }
    codexSessionStatsCacheLock.unlock()
    var fileStatsList: [CodexSessionFileStats] = []
    var changedFiles = 0
    var bytesRead: Int64 = 0
    var activeFilePaths = Set<String>()

    for file in files {
        let path = file.url.path
        let modifiedAt = Int(file.modifiedAt.timeIntervalSince1970)
        activeFilePaths.insert(path)

        codexSessionStatsCacheLock.lock()
        let cachedEntry = codexSessionFileStatsCache[path]
        codexSessionStatsCacheLock.unlock()

        let parsedStats: CodexSessionFileStats
        if let cached = cachedEntry,
           file.size > cached.size,
           file.size >= cached.stats.parsedBytes {
            // 뒤에 붙기만 한 파일: 이어 읽는다. 날짜가 바뀌었어도 이미 읽은 버킷은 그대로다.
            parsedStats = autoreleasepool {
                scanCodexSessionFile(file, calendar: calendar, existing: cached.stats)
            }
            changedFiles += 1
            bytesRead += max(0, parsedStats.parsedBytes - cached.stats.parsedBytes)
        } else if let cached = cachedEntry,
                  cached.size == file.size,
                  cached.modifiedAt == modifiedAt {
            parsedStats = cached.stats
        } else {
            // 처음 보는 파일이거나 줄어들었거나(잘림·재작성) 같은 크기로 다시 써진 파일: 처음부터 읽는다.
            parsedStats = autoreleasepool {
                scanCodexSessionFile(file, calendar: calendar)
            }
            changedFiles += 1
            bytesRead += max(0, parsedStats.parsedBytes)
        }

        codexSessionStatsCacheLock.lock()
        codexSessionFileStatsCache[path] = (modifiedAt, file.size, parsedStats)
        codexSessionStatsCacheLock.unlock()
        fileStatsList.append(parsedStats)
    }

    codexSessionStatsCacheLock.lock()
    let cachedBeforePrune = codexSessionFileStatsCache.count
    codexSessionFileStatsCache = codexSessionFileStatsCache.filter { activeFilePaths.contains($0.key) }
    let prunedEntries = cachedBeforePrune - codexSessionFileStatsCache.count
    codexSessionStatsCacheLock.unlock()
    // 디스크 캐시는 무언가 바뀐 스캔 뒤에만 쓴다(원자적 쓰기). 날짜만 넘어간 스캔은 아무것도 쓰지 않는다.
    if changedFiles > 0 || prunedEntries > 0 {
        persistCodexSessionFileStatsCache(timeZone: timeZone)
    }

    var buckets: [String: CodexDayBucket] = [:]
    var lastCallAt: Date?
    var latestModel: String?
    var latestContextWindow: Int?
    var latestRateAt: Date?
    var planType: String?
    var primaryUsedPercent: Double?
    var secondaryUsedPercent: Double?
    var primaryResetAt: Date?
    var secondaryResetAt: Date?

    for fileStats in fileStatsList {
        for (day, bucket) in fileStats.days {
            buckets[day, default: CodexDayBucket()].merge(bucket)
        }
        if let date = fileStats.lastCallAt, lastCallAt == nil || date > lastCallAt! {
            lastCallAt = date
            latestModel = fileStats.latestModel
            latestContextWindow = fileStats.latestContextWindow
        }
        if let rateAt = fileStats.latestRateAt, latestRateAt == nil || rateAt > latestRateAt! {
            latestRateAt = rateAt
            planType = fileStats.planType
            primaryUsedPercent = fileStats.primaryUsedPercent
            secondaryUsedPercent = fileStats.secondaryUsedPercent
            primaryResetAt = fileStats.primaryResetAt
            secondaryResetAt = fileStats.secondaryResetAt
        }
    }
    let totals = codexAggregate(buckets: buckets, now: now, calendar: calendar)

    let profiles = totals.byProfile.map { profile, row in
        CodexProfileHealth(
            profile: profile,
            todayCalls: row.todayCalls,
            weekCalls: row.weekCalls,
            totalCalls: row.totalCalls,
            todayTokens: row.todayTokens,
            weekTokens: row.weekTokens,
            totalTokens: row.totalTokens,
            quotaEvents: row.quotaEvents,
            errorEvents: row.errorEvents,
            lastVerdict: row.lastVerdict,
            lastAt: row.lastAt
        )
    }
    .sorted {
        if $0.todayTokens != $1.todayTokens { return $0.todayTokens > $1.todayTokens }
        if $0.weekTokens != $1.weekTokens { return $0.weekTokens > $1.weekTokens }
        if $0.todayCalls != $1.todayCalls { return $0.todayCalls > $1.todayCalls }
        return $0.weekCalls > $1.weekCalls
    }

    let stats = CodexCallStats(
        todayCalls: totals.todayCalls,
        weekCalls: totals.weekCalls,
        totalCalls: totals.totalCalls,
        todayTokens: totals.todayTokens,
        weekTokens: totals.weekTokens,
        totalTokens: totals.totalTokens,
        quotaEvents: totals.quotaEvents,
        errorEvents: totals.errorEvents,
        lastCallAt: lastCallAt,
        latestModel: latestModel,
        planType: planType,
        contextWindow: latestContextWindow,
        primaryUsedPercent: primaryUsedPercent,
        secondaryUsedPercent: secondaryUsedPercent,
        primaryResetAt: primaryResetAt,
        secondaryResetAt: secondaryResetAt,
        scannedLogFiles: files.count,
        scannedLogBytes: scannedBytes,
        profiles: profiles
    )

    codexSessionStatsCacheLock.lock()
    codexSessionStatsCache = (signature, stats)
    codexSessionStatsCacheLock.unlock()
    recordCodexScan(files: files.count, changed: changedFiles, bytesRead: bytesRead)
    return stats
}

func loadCodexHealth() -> CodexHealth {
    let home = codexHomePath()
    let fm = FileManager.default
    let authPath = "\(home)/auth.json"
    let configPath = "\(home)/config.toml"
    let authFileExists = fm.fileExists(atPath: authPath)
    let auth = readCodexJSON(authPath)
    let authMalformed = authFileExists && auth == nil
    let authMode = codexString(auth?["auth_mode"])
    let hasApiKey = (codexString(auth?["OPENAI_API_KEY"])?.isEmpty == false)
    let tokenObject = auth?["tokens"]
    let hasTokens = tokenObject != nil && !(tokenObject is NSNull)
    let lastRefresh = parseCodexDate(auth?["last_refresh"])
    let config = loadCodexConfigSummary(path: configPath)
    let sessionStats = loadCodexSessionStats(root: codexSessionsPath())
    let stats = (!sessionStats.profiles.isEmpty || sessionStats.primaryUsedPercent != nil || sessionStats.secondaryUsedPercent != nil)
        ? sessionStats
        : loadCodexCallStats(path: codexCallLogPath())

    let authLabel: String
    if authMode?.lowercased().contains("chatgpt") == true || (hasTokens && !hasApiKey) {
        authLabel = "ChatGPT"
    } else if authMode?.lowercased().contains("api") == true || hasApiKey {
        authLabel = "API Key"
    } else {
        authLabel = "로그인 필요"
    }

    let staleRefresh = lastRefresh.map { $0 < Date().addingTimeInterval(TimeInterval(-14 * 86_400)) } ?? false
    var hints: [String] = []
    if authMalformed {
        hints.append("auth.json 파싱 실패")
    } else if !authFileExists {
        hints.append("Codex auth 파일 없음")
    } else if !hasApiKey && !hasTokens {
        hints.append("Codex 인증 정보 없음")
    }
    if staleRefresh {
        hints.append("마지막 refresh 14일 초과")
    }
    if !config.present {
        hints.append("config.toml 없음")
    }
    if stats.scannedLogFiles == 0 {
        hints.append("Codex 세션 로그 없음")
    }
    if stats.errorEvents > 0 {
        hints.append("최근 7일 오류 이벤트 \(stats.errorEvents)회")
    }


    let status: String
    if authMalformed {
        status = "error"
    } else if !authFileExists || (!hasApiKey && !hasTokens) || staleRefresh || stats.errorEvents > 0 {
        status = "warning"
    } else {
        status = "ok"
    }

    var health = CodexHealth(
        checkedAt: Date(),
        overallStatus: status,
        configPresent: config.present,
        authPresent: authFileExists,
        authMode: authMode,
        authLabel: authLabel,
        hasApiKey: hasApiKey,
        hasTokens: hasTokens,
        lastRefresh: lastRefresh,
        model: stats.latestModel ?? config.model,
        reasoningEffort: config.reasoningEffort,
        serviceTier: config.serviceTier,
        contextWindow: stats.contextWindow ?? config.contextWindow,
        todayCalls: stats.todayCalls,
        weekCalls: stats.weekCalls,
        totalCalls: stats.totalCalls,
        todayTokens: stats.todayTokens,
        weekTokens: stats.weekTokens,
        totalTokens: stats.totalTokens,
        quotaEvents: stats.quotaEvents,
        errorEvents: stats.errorEvents,
        lastCallAt: stats.lastCallAt,
        planType: stats.planType,
        scannedLogFiles: stats.scannedLogFiles,
        scannedLogBytes: stats.scannedLogBytes,
        profiles: stats.profiles,
        hints: hints
    )
    health.scan = codexLastScan()
    return health
}
