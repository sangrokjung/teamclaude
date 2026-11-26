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
}

struct CliStatusSnapshot: Equatable {
    static let schema = 1
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
            ] as [String: Any],
        ]
    }

    func jsonData() -> Data? {
        try? JSONSerialization.data(withJSONObject: jsonObject(), options: [.sortedKeys])
    }

    /// schema·필수 키·열거값이 맞지 않으면 nil. 값 칸이 범위를 벗어나면 그 칸만 비운다.
    static func parse(_ raw: Any) -> CliStatusSnapshot? {
        guard let root = raw as? [String: Any],
              CliStatusCodec.number(root["schema"]).map({ Int($0) }) == schema,
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
        let groups = (agyRaw["groups"] as? [Any] ?? []).compactMap { item -> CliAgyGroupStatus? in
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
                                sessionsToday: CliStatusCodec.count(grokRaw["sessions_today"])),
            agy: CliAgyStatus(installed: agyInstalled, auth: agyAuth, groups: groups,
                              lastUsed: CliStatusCodec.isoDate(agyRaw["last_used"]),
                              conversationsToday: CliStatusCodec.count(agyRaw["conversations_today"])))
    }
}

// MARK: - 앱 상태 → 스냅샷

/// Grok 결과를 스냅샷 칸으로 옮긴다. 미설치 안내가 있으면 installed=false다.
func cliGrokStatus(outcome: GrokMenuOutcome, installed: Bool, activity: CliActivity) -> CliGrokStatus {
    var status = CliGrokStatus(installed: installed, auth: .unavailable, usagePercent: nil, periodEnd: nil,
                               lastUsed: activity.lastUsed, sessionsToday: activity.todayCount)
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
func cliAgyStatus(outcome: AgyFetchOutcome, activity: CliActivity) -> CliAgyStatus {
    switch outcome {
    case .missing:
        return CliAgyStatus(installed: false, auth: .error, groups: [], lastUsed: activity.lastUsed,
                            conversationsToday: activity.todayCount)
    case .failed:
        return CliAgyStatus(installed: true, auth: .error, groups: [], lastUsed: activity.lastUsed,
                            conversationsToday: activity.todayCount)
    case .ready(let groups):
        let mapped = agyVisibleGroups(groups).map { group in
            CliAgyGroupStatus(name: group.name,
                              weeklyRemainingPercent: group.weekly.map { $0.remaining * 100 },
                              weeklyReset: group.weekly?.resetAt,
                              fiveHourRemainingPercent: group.fiveHour.map { $0.remaining * 100 },
                              fiveHourReset: group.fiveHour?.resetAt)
        }
        return CliAgyStatus(installed: true, auth: .ok, groups: mapped, lastUsed: activity.lastUsed,
                            conversationsToday: activity.todayCount)
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
}

enum CliActivityScanner {
    /// 정렬해 살펴볼 최근 항목 수 상한.
    static let entryLimit = 2_000
    /// 목록에서 읽을 원시 항목 수 상한(폴더가 비정상적으로 커도 스캔이 끝나게 한다).
    static let rawLimit = 20_000

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

    private static func children(_ url: URL, limit: Int) -> [URL]? {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { return nil }
        return names.prefix(limit).filter { !$0.hasPrefix(".") }.map { url.appendingPathComponent($0) }
    }

    /// Grok: <root>/<인코딩된 폴더>/<세션 id>/chat_history.jsonl. 가장 최근 mtime이 마지막 사용,
    /// 오늘(현지 자정 이후) 만들어졌거나 바뀐 세션 폴더 수가 오늘 세션 수다.
    static func grok(root: URL, now: Date, calendar: Calendar = .current) -> CliActivity {
        guard let folders = children(root, limit: rawLimit) else { return CliActivity(lastUsed: nil, todayCount: nil) }
        let midnight = calendar.startOfDay(for: now)
        // 폴더 mtime(새 세션이 생기면 바뀐다)으로 최근 폴더부터 본다.
        let ordered = folders.map { ($0, modified($0) ?? .distantPast) }.sorted { $0.1 > $1.1 }
        var visited = 0
        var last: Date?
        var today = 0
        outer: for (folder, _) in ordered {
            guard let sessions = children(folder, limit: rawLimit) else { continue }
            for session in sessions {
                if visited >= entryLimit { break outer }
                visited += 1
                let history = session.appendingPathComponent("chat_history.jsonl")
                guard let stamp = modified(history) else { continue }
                if last == nil || stamp > last! { last = stamp }
                let born = created(session) ?? stamp
                if stamp >= midnight || born >= midnight { today += 1 }
            }
        }
        return CliActivity(lastUsed: last, todayCount: today)
    }

    /// agy: conversations/<id>.db·.db-wal. 같은 id를 한 대화로 센다.
    /// .db-shm은 세지 않는다 — agy가 실행될 때마다 모든 대화의 .db-shm을 건드려서(메뉴바의 /usage 호출 포함,
    /// 2026-11-26 실측: .db-shm 501개 전부 최근 1시간 mtime, .db·.db-wal은 2개) 그대로 세면 매번 "전부 오늘"이 된다.
    static func agy(root: URL, now: Date, calendar: Calendar = .current) -> CliActivity {
        guard let files = children(root, limit: rawLimit) else { return CliActivity(lastUsed: nil, todayCount: nil) }
        let midnight = calendar.startOfDay(for: now)
        var stamps: [String: (modified: Date, born: Date)] = [:]
        for file in files {
            let name = file.lastPathComponent
            guard !name.hasSuffix(".db-shm") else { continue }
            guard let stem = name.split(separator: ".").first.map(String.init), !stem.isEmpty,
                  let stamp = modified(file) else { continue }
            let born = created(file) ?? stamp
            if let prior = stamps[stem] {
                stamps[stem] = (max(prior.modified, stamp), min(prior.born, born))
            } else {
                stamps[stem] = (stamp, born)
            }
        }
        let recent = stamps.values.sorted { $0.modified > $1.modified }.prefix(entryLimit)
        let today = recent.filter { $0.modified >= midnight || $0.born >= midnight }.count
        return CliActivity(lastUsed: recent.first?.modified, todayCount: today)
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
    static let maxHosts = 32

    static func defaultPath(home: String = NSHomeDirectory()) -> String {
        (home as NSString).appendingPathComponent(".claude/cache/fleet-cli.json")
    }

    /// 파일이 없을 때만 nil(워커 화면: 이 맥 한 줄). 읽기·해석 실패는 `.unreadable`로 드러낸다.
    static func load(path: String = defaultPath()) -> CliFleetReport? {
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
        let parsed = hosts.prefix(maxHosts).compactMap { item -> CliFleetHost? in
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
