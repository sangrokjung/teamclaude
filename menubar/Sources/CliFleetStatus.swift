import Foundation
import SystemConfiguration

// Grok·agy 머신별 상태(2026-11-26 대표 지적: "1% 사용·99% 남음"으로는 부족하다, 머신마다 더 구체적으로).
// 각 머신의 메뉴바가 자기 상태를 ~/.cache/cc-menubar/cli-status.json에 쓰고(이 파일의 스냅샷),
// 본체의 수집기(scripts/fleet-cli-collect.py)가 그것들을 ~/.claude/cache/fleet-cli.json 하나로 모은다.
// CLI 탭 표는 모은 파일이 있으면 머신마다 한 줄, 없으면 이 맥의 스냅샷 한 줄을 그린다.
// 토큰·키 값은 어디에도 쓰지 않는다. 스냅샷에 들어가는 것은 상태·비율·시각·개수뿐이다.

enum CliGrokAuth: String, Equatable { case ok, expired, login, unavailable }
enum CliAgyAuth: String, Equatable { case ok, login, error }

struct CliGrokStatus: Equatable {
    var installed: Bool
    var auth: CliGrokAuth
    /// 사용률 0~100(GrokBuild, 없으면 계정 전체 크레딧). 한도 숫자는 API가 주지 않는다.
    var usagePercent: Double?
    /// 청구 응답 config.currentPeriod.end(주간 초기화 시각).
    var periodEnd: Date?
    var lastUsed: Date?
    var sessionsToday: Int?
    /// 폴더 열거 상한에 걸려 일부만 셌다("오늘 N+").
    var sessionsTodayPartial: Bool = false
    /// 마지막으로 사용률을 받은 시각. 조회가 이어서 실패하면 앞선 값을 보이되 이 시각으로 지연을 말한다.
    var lastOkAt: Date? = nil
    /// 가장 최근 조회가 실패했다(앞선 값을 지키는 중).
    var fetchFailed: Bool = false
}

struct CliAgyGroupStatus: Equatable {
    var name: String
    var weeklyRemainingPercent: Double?
    var weeklyReset: Date?
    var fiveHourRemainingPercent: Double?
    var fiveHourReset: Date?
}

struct CliAgyStatus: Equatable {
    var installed: Bool
    var auth: CliAgyAuth
    var groups: [CliAgyGroupStatus]
    var lastUsed: Date?
    var conversationsToday: Int?
    var conversationsTodayPartial: Bool = false
    var lastOkAt: Date? = nil
    var fetchFailed: Bool = false
}

struct CliStatusSnapshot: Equatable {
    static let schema = 1
    static let maxGroups = 32
    var host: String
    var writtenAt: Date
    var grok: CliGrokStatus
    var agy: CliAgyStatus
}

// MARK: - 날짜·수 변환

enum CliStatusCodec {
    static func isoString(_ date: Date?) -> Any {
        guard let date else { return NSNull() }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    static func isoDate(_ value: Any?) -> Date? {
        guard let raw = value as? String, !raw.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return fractional.date(from: raw) ?? plain.date(from: raw)
    }

    /// 불리언이 아닌 유한한 수만 받는다.
    static func number(_ value: Any?) -> Double? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let double = value.doubleValue
        return double.isFinite ? double : nil
    }

    static func percent(_ value: Any?) -> Double? {
        guard let number = number(value), number >= 0, number <= 100 else { return nil }
        return number
    }

    static func count(_ value: Any?) -> Int? {
        guard let number = number(value), number >= 0, number < 1_000_000 else { return nil }
        return Int(number)
    }

    /// JSON 정수이고 target과 같은가. 1.0·1e0·Double에서 1로 반올림되는 소수(NSNumber 실수형)와 불리언은 아니다.
    static func isInteger(_ value: Any?, equalTo target: Int) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              !CFNumberIsFloatType(number), !(number is NSDecimalNumber) else { return false }
        return number.int64Value == Int64(target)
    }

    static func optional(_ value: Double?) -> Any { value.map { $0 as Any } ?? NSNull() }
    static func optional(_ value: Int?) -> Any { value.map { $0 as Any } ?? NSNull() }
}

extension CliStatusSnapshot {
    /// 파일에 쓰는 모양. 키 이름은 수집기(fleet-cli-collect.py)와 같다.
    func jsonObject() -> [String: Any] {
        [
            "schema": Self.schema,
            "host": host,
            "written_at": Int(writtenAt.timeIntervalSince1970.rounded()),
            "grok": [
                "installed": grok.installed,
                "auth": grok.auth.rawValue,
                "usage_pct": CliStatusCodec.optional(grok.usagePercent),
                "period_end": CliStatusCodec.isoString(grok.periodEnd),
                "last_used": CliStatusCodec.isoString(grok.lastUsed),
                "sessions_today": CliStatusCodec.optional(grok.sessionsToday),
                "sessions_today_partial": grok.sessionsTodayPartial,
                "last_ok_at": CliStatusCodec.isoString(grok.lastOkAt),
                "fetch_failed": grok.fetchFailed,
            ] as [String: Any],
            "agy": [
                "installed": agy.installed,
                "auth": agy.auth.rawValue,
                "groups": agy.groups.map { group -> [String: Any] in
                    [
                        "name": group.name,
                        "weekly_remaining_pct": CliStatusCodec.optional(group.weeklyRemainingPercent),
                        "weekly_reset": CliStatusCodec.isoString(group.weeklyReset),
                        "five_hour_remaining_pct": CliStatusCodec.optional(group.fiveHourRemainingPercent),
                        "five_hour_reset": CliStatusCodec.isoString(group.fiveHourReset),
                    ]
                },
                "last_used": CliStatusCodec.isoString(agy.lastUsed),
                "conversations_today": CliStatusCodec.optional(agy.conversationsToday),
                "conversations_today_partial": agy.conversationsTodayPartial,
                "last_ok_at": CliStatusCodec.isoString(agy.lastOkAt),
                "fetch_failed": agy.fetchFailed,
            ] as [String: Any],
        ]
    }

    func jsonData() -> Data? {
        try? JSONSerialization.data(withJSONObject: jsonObject(), options: [.sortedKeys])
    }

    /// schema·필수 키·열거값이 맞지 않으면 nil. 값 칸이 범위를 벗어나면 그 칸만 비운다.
    static func parse(_ raw: Any) -> CliStatusSnapshot? {
        // schema는 JSON 정수 1만 받는다(1.5·1.0·고정밀 소수·거대한 수는 거부, Int 변환에서 멈추지 않게).
        guard let root = raw as? [String: Any],
              CliStatusCodec.isInteger(root["schema"], equalTo: schema),
              let host = root["host"] as? String, !host.isEmpty,
              let written = CliStatusCodec.number(root["written_at"]), written > 0, written < 10_000_000_000,
              let grokRaw = root["grok"] as? [String: Any],
              let agyRaw = root["agy"] as? [String: Any],
              let grokInstalled = grokRaw["installed"] as? Bool,
              let grokAuth = (grokRaw["auth"] as? String).flatMap(CliGrokAuth.init(rawValue:)),
              let agyInstalled = agyRaw["installed"] as? Bool,
              let agyAuth = (agyRaw["auth"] as? String).flatMap(CliAgyAuth.init(rawValue:)) else {
            return nil
        }
        // 레인 수 상한(수집기와 같은 32). 넘으면 자르지 않고 스냅샷을 거부한다 — 잘린 레인이 최저 잔량을 숨기지 않게.
        let rawGroups = agyRaw["groups"] as? [Any] ?? []
        guard rawGroups.count <= maxGroups else { return nil }
        let groups = rawGroups.compactMap { item -> CliAgyGroupStatus? in
            guard let row = item as? [String: Any], let name = row["name"] as? String, !name.isEmpty else { return nil }
            return CliAgyGroupStatus(
                name: name,
                weeklyRemainingPercent: CliStatusCodec.percent(row["weekly_remaining_pct"]),
                weeklyReset: CliStatusCodec.isoDate(row["weekly_reset"]),
                fiveHourRemainingPercent: CliStatusCodec.percent(row["five_hour_remaining_pct"]),
                fiveHourReset: CliStatusCodec.isoDate(row["five_hour_reset"]))
        }
        return CliStatusSnapshot(
            host: host,
            writtenAt: Date(timeIntervalSince1970: written),
            grok: CliGrokStatus(installed: grokInstalled, auth: grokAuth,
                                usagePercent: CliStatusCodec.percent(grokRaw["usage_pct"]),
                                periodEnd: CliStatusCodec.isoDate(grokRaw["period_end"]),
                                lastUsed: CliStatusCodec.isoDate(grokRaw["last_used"]),
                                sessionsToday: CliStatusCodec.count(grokRaw["sessions_today"]),
                                sessionsTodayPartial: grokRaw["sessions_today_partial"] as? Bool ?? false,
                                lastOkAt: CliStatusCodec.isoDate(grokRaw["last_ok_at"]),
                                fetchFailed: grokRaw["fetch_failed"] as? Bool ?? false),
            agy: CliAgyStatus(installed: agyInstalled, auth: agyAuth, groups: groups,
                              lastUsed: CliStatusCodec.isoDate(agyRaw["last_used"]),
                              conversationsToday: CliStatusCodec.count(agyRaw["conversations_today"]),
                              conversationsTodayPartial: agyRaw["conversations_today_partial"] as? Bool ?? false,
                              lastOkAt: CliStatusCodec.isoDate(agyRaw["last_ok_at"]),
                              fetchFailed: agyRaw["fetch_failed"] as? Bool ?? false))
    }
}

// MARK: - 앱 상태 → 스냅샷

/// Grok 결과를 스냅샷 칸으로 옮긴다. 미설치 안내가 있으면 installed=false다.
func cliGrokStatus(outcome: GrokMenuOutcome, installed: Bool, activity: CliActivity,
                   lastOkAt: Date? = nil, fetchFailed: Bool = false) -> CliGrokStatus {
    var status = CliGrokStatus(installed: installed, auth: .unavailable, usagePercent: nil, periodEnd: nil,
                               lastUsed: activity.lastUsed, sessionsToday: activity.todayCount,
                               sessionsTodayPartial: activity.partial, lastOkAt: lastOkAt, fetchFailed: fetchFailed)
    switch outcome {
    case .percent(let percent):
        status.auth = .ok
        status.usagePercent = percent.productPercent ?? percent.creditPercent ?? burnGrokPercent(percent.slot)
        status.periodEnd = percent.periodEnd
    case .expired: status.auth = .expired
    case .login: status.auth = .login
    case .unavailable: status.auth = .unavailable
    }
    return status
}

/// agy 결과를 스냅샷 칸으로 옮긴다. groups는 화면에 올릴 레인(Gemini)만 받는다.
func cliAgyStatus(outcome: AgyFetchOutcome, activity: CliActivity, lastOkAt: Date? = nil, fetchFailed: Bool = false) -> CliAgyStatus {
    switch outcome {
    case .missing:
        return CliAgyStatus(installed: false, auth: .error, groups: [], lastUsed: activity.lastUsed,
                            conversationsToday: activity.todayCount, conversationsTodayPartial: activity.partial)
    case .failed:
        return CliAgyStatus(installed: true, auth: .error, groups: [], lastUsed: activity.lastUsed,
                            conversationsToday: activity.todayCount, conversationsTodayPartial: activity.partial,
                            lastOkAt: lastOkAt, fetchFailed: true)
    case .ready(let groups):
        let mapped = agyVisibleGroups(groups).map { group in
            CliAgyGroupStatus(name: group.name,
                              weeklyRemainingPercent: group.weekly.map { $0.remaining * 100 },
                              weeklyReset: group.weekly?.resetAt,
                              fiveHourRemainingPercent: group.fiveHour.map { $0.remaining * 100 },
                              fiveHourReset: group.fiveHour?.resetAt)
        }
        return CliAgyStatus(installed: true, auth: .ok, groups: mapped, lastUsed: activity.lastUsed,
                            conversationsToday: activity.todayCount, conversationsTodayPartial: activity.partial,
                            lastOkAt: lastOkAt, fetchFailed: fetchFailed)
    }
}

/// 짧은 호스트 이름. 맥의 hostName은 네트워크에 따라 바뀌므로 LocalHostName을 먼저 쓴다.
func cliLocalHostName() -> String {
    if let local = SCDynamicStoreCopyLocalHostName(nil) as String?, !local.isEmpty { return local }
    let host = ProcessInfo.processInfo.hostName
    return host.split(separator: ".").first.map(String.init) ?? host
}

// MARK: - 사용 흔적(마지막 사용·오늘 개수)

struct CliActivity: Equatable {
    var lastUsed: Date?
    /// 폴더가 없으면 nil(도구를 안 쓰는 맥), 있으면 0 이상.
    var todayCount: Int?
    /// 열거 상한에 걸려 일부만 봤다. 값은 하한이다("오늘 N+").
    var partial: Bool = false
}

enum CliActivityScanner {
    /// 한 번의 스캔에서 열거할 항목(폴더·파일) 수 상한. 넘으면 멈추고 부분 집계로 표시한다.
    static let scanLimit = 20_000

    static func grokSessionsURL(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent(".grok/sessions", isDirectory: true)
    }

    static func agyConversationsURL(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent(".gemini/antigravity-cli/conversations", isDirectory: true)
    }

    private static func modified(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }

    private static func created(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.creationDateKey]))?.creationDate
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }

    /// 한 단계 아래 항목을 하나씩 내주는 열거자(목록 전체를 배열로 읽지 않는다).
    private static func children(_ url: URL) -> FileManager.DirectoryEnumerator? {
        FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.contentModificationDateKey, .creationDateKey],
                                       options: [.skipsSubdirectoryDescendants, .skipsHiddenFiles, .skipsPackageDescendants])
    }

    /// Grok: <root>/<인코딩된 폴더>/<세션 id>/chat_history.jsonl. 세션 파일 자체의 mtime으로 센다
    /// (기존 세션에 이어 써도 상위 폴더 mtime은 바뀌지 않으므로 폴더 순서에 기대지 않는다).
    /// 폴더·세션을 합쳐 limit개까지만 열거하고, 남은 항목이 있으면 부분 집계로 표시한다.
    static func grok(root: URL, now: Date, calendar: Calendar = .current, limit: Int = scanLimit) -> CliActivity {
        guard isDirectory(root), let folders = children(root) else { return CliActivity(lastUsed: nil, todayCount: nil) }
        let midnight = calendar.startOfDay(for: now)
        var budget = limit
        var last: Date?
        var today = 0
        var partial = false
        scan: for case let folder as URL in folders {
            guard budget > 0 else { partial = true; break }
            budget -= 1
            guard isDirectory(folder), let sessions = children(folder) else { continue }
            for case let session as URL in sessions {
                guard budget > 0 else { partial = true; break scan }
                budget -= 1
                let history = session.appendingPathComponent("chat_history.jsonl")
                guard let stamp = modified(history) else { continue }
                if last.map({ stamp > $0 }) ?? true { last = stamp }
                let born = created(session) ?? stamp
                if stamp >= midnight || born >= midnight { today += 1 }
            }
        }
        return CliActivity(lastUsed: last, todayCount: today, partial: partial)
    }

    /// agy: conversations/<id>.db·.db-wal. 같은 id를 한 대화로 센다.
    /// .db-shm은 세지 않는다 — agy가 실행될 때마다 모든 대화의 .db-shm을 건드려서(메뉴바의 /usage 호출 포함,
    /// 2026-11-26 실측: .db-shm 501개 전부 최근 1시간 mtime, .db·.db-wal은 2개) 그대로 세면 매번 "전부 오늘"이 된다.
    static func agy(root: URL, now: Date, calendar: Calendar = .current, limit: Int = scanLimit) -> CliActivity {
        guard isDirectory(root) else { return CliActivity(lastUsed: nil, todayCount: nil) }
        let midnight = calendar.startOfDay(for: now)
        var budget = limit
        var partial = false
        var stamps: [String: (modified: Date, born: Date)] = [:]
        guard let files = children(root) else { return CliActivity(lastUsed: nil, todayCount: nil) }
        for case let file as URL in files {
            guard budget > 0 else { partial = true; break }
            budget -= 1
            let name = file.lastPathComponent
            guard !name.hasSuffix(".db-shm"),
                  let stem = name.split(separator: ".").first.map(String.init), !stem.isEmpty,
                  let stamp = modified(file) else { continue }
            let born = created(file) ?? stamp
            if let prior = stamps[stem] {
                stamps[stem] = (max(prior.modified, stamp), min(prior.born, born))
            } else {
                stamps[stem] = (stamp, born)
            }
        }
        let today = stamps.values.filter { $0.modified >= midnight || $0.born >= midnight }.count
        return CliActivity(lastUsed: stamps.values.map(\.modified).max(), todayCount: today, partial: partial)
    }
}

// MARK: - 스냅샷 파일 쓰기

enum CliStatusFile {
    static func defaultURL(home: String = NSHomeDirectory()) -> URL {
        URL(fileURLWithPath: home).appendingPathComponent(".cache/cc-menubar/cli-status.json")
    }

    /// 임시 파일에 쓴 뒤 rename한다. 읽는 쪽(ssh cat)이 반쯤 쓴 파일을 보지 않는다.
    @discardableResult
    static func write(_ snapshot: CliStatusSnapshot, to url: URL = defaultURL()) -> Bool {
        guard let data = snapshot.jsonData() else { return false }
        let folder = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let temp = folder.appendingPathComponent(".\(url.lastPathComponent).\(ProcessInfo.processInfo.processIdentifier).tmp")
            try data.write(to: temp)
            guard rename(temp.path, url.path) == 0 else {
                try? FileManager.default.removeItem(at: temp)
                return false
            }
            return true
        } catch {
            return false
        }
    }
}

// MARK: - 본체 수집 결과(fleet-cli.json)

struct CliFleetHost: Equatable {
    let name: String
    let ok: Bool
    let error: String?
    let status: CliStatusSnapshot?
}

struct CliFleetReport: Equatable {
    /// nil이면 파일은 있는데 읽거나 해석하지 못했다.
    let collectedAt: Date?
    let hosts: [CliFleetHost]

    static let unreadable = CliFleetReport(collectedAt: nil, hosts: [])

    static func defaultPath(home: String = NSHomeDirectory()) -> String {
        (home as NSString).appendingPathComponent(".claude/cache/fleet-cli.json")
    }

    /// 이보다 큰 수집 파일은 읽지 않는다(수집기 출력 상한과 같은 2MiB).
    static let maxFileBytes = 2 * 1024 * 1024

    /// 파일이 없을 때만 nil(워커 화면: 이 맥 한 줄). 읽기·해석 실패와 크기 초과는 `.unreadable`로 드러낸다.
    static func load(path: String = defaultPath()) -> CliFleetReport? {
        if let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber,
           size.int64Value > Int64(maxFileBytes) {
            return .unreadable // 읽기 전에 크기로 거부한다
        }
        do {
            return parse(try Data(contentsOf: URL(fileURLWithPath: path))) ?? .unreadable
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            return nil
        } catch let error as NSError where error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
            return nil
        } catch {
            return .unreadable
        }
    }

    static func parse(_ data: Data) -> CliFleetReport? {
        guard let object = try? JSONSerialization.jsonObject(with: data) else { return nil }
        return parse(object: object)
    }

    /// 손상된 호스트 스냅샷은 그 호스트만 ok=false, error="parse"로 둔다(수집기와 같은 규칙).
    static func parse(object: Any) -> CliFleetReport? {
        guard let root = object as? [String: Any],
              let collected = CliStatusCodec.number(root["collected_at"]), collected > 0, collected < 10_000_000_000,
              let hosts = root["hosts"] as? [Any] else { return nil }
        let parsed = hosts.compactMap { item -> CliFleetHost? in
            guard let row = item as? [String: Any], let name = row["name"] as? String, !name.isEmpty else { return nil }
            let ok = row["ok"] as? Bool == true
            let error = row["error"] as? String
            guard ok else { return CliFleetHost(name: name, ok: false, error: error ?? "unknown", status: nil) }
            guard let raw = row["status"], let status = CliStatusSnapshot.parse(raw) else {
                return CliFleetHost(name: name, ok: false, error: "parse", status: nil)
            }
            return CliFleetHost(name: name, ok: true, error: nil, status: status)
        }
        return CliFleetReport(collectedAt: Date(timeIntervalSince1970: collected), hosts: parsed)
    }
}
