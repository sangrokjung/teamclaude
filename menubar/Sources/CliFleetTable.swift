import Foundation

// CLI 탭 Grok·agy 머신 표의 행 모델과 상태 판정. 그리기는 CliQuotaLanesView(CliQuotaCards.swift)가 한다.
// 상태는 넷이다: 정상 / 확인 중(첫 결과 전) / 주의(남은 양 20% 미만·만료·확인 필요·꺼짐) /
// 문제(미설치·로그인 필요·수집 실패·묵음). 색만으로 나누지 않고 모든 비정상 칸에 글자를 붙인다.

enum CliLevel: Int, Comparable, Equatable {
    case ok = 0, pending, warn, problem
    static func < (lhs: CliLevel, rhs: CliLevel) -> Bool { lhs.rawValue < rhs.rawValue }
}

struct CliGrokCell: Equatable {
    var level: CliLevel
    /// 비정상일 때의 상태 글자("로그인 필요"). 정상이면 nil.
    var word: String?
    var usagePercent: Double?
    var reset: String?
}

struct CliAgyCell: Equatable {
    var level: CliLevel
    var word: String?
    var weeklyRemaining: Double?
    var fiveHourRemaining: Double?
    var reset: String?
}

struct CliFleetRow: Equatable {
    var name: String
    var level: CliLevel
    /// 머신 칸 둘째 줄: 정상·주의·문제, 또는 수집 실패·멈춤 N분·꺼짐.
    var statusWord: String
    /// 값이 묵었다(5분 넘게 안 바뀜). 값은 남기되 흐리게 그린다.
    var dimmed: Bool
    var grok: CliGrokCell
    var agy: CliAgyCell
    var grokLastUsed: String
    var agyLastUsed: String
    var grokToday: String
    var agyToday: String
    /// 접근성·툴팁용 원인(수집기 오류 코드 등).
    var detail: String? = nil
}

/// 이 맥의 현재 상태. 첫 결과 전에는 grok·agy가 nil이다.
struct CliLocalCliState: Equatable {
    var host: String
    var grok: CliGrokStatus?
    var agy: CliAgyStatus?
    var writtenAt: Date? = nil

    var snapshot: CliStatusSnapshot? {
        guard let grok, let agy else { return nil }
        return CliStatusSnapshot(host: host, writtenAt: writtenAt ?? Date(), grok: grok, agy: agy)
    }
}

struct CliFleetTable: Equatable {
    var rows: [CliFleetRow]
    /// 표 머리의 수집기 경고(수집 멈춤·읽기 실패). 정상이면 nil.
    var collectorNote: String?
    var collectorLevel: CliLevel = .ok
    /// 본체 수집 파일에서 온 표인가(아니면 이 맥 한 줄).
    var fromFleet: Bool

    static let lowRemainingPercent = 20.0
    /// 머신 스냅샷은 1분마다 쓴다. 5분 넘게 그대로면 그 머신이 멈춘 것이다.
    static let hostStaleSeconds: TimeInterval = 300
    /// 본체 수집기도 1분마다 돈다. 3분 넘게 그대로면 수집이 멈춘 것이다(머신 줄과 같은 기준).
    static let collectorStaleSeconds: TimeInterval = 180
    static let futureSkewSeconds: TimeInterval = 60

    // 표 기하. 그리기와 높이 계산이 같은 값을 쓴다.
    static let topInset: CGFloat = 6
    static let noteHeight: CGFloat = 22
    static let headHeight: CGFloat = 22
    static let rowHeight: CGFloat = 44
    static let bottomInset: CGFloat = 6

    static func height(rows: Int) -> CGFloat {
        topInset + noteHeight + headHeight + rowHeight * CGFloat(max(1, rows)) + bottomInset
    }

    static var limitNote: String { L10n.cliLimitNote }

    static func make(report: CliFleetReport?, local: CliLocalCliState, now: Date) -> CliFleetTable {
        let localTable = CliFleetTable(rows: [localRow(local, now: now)], collectorNote: nil, fromFleet: false)
        guard let report else { return localTable }
        guard let collected = report.collectedAt else {
            var table = localTable
            table.collectorNote = L10n.cliCollectorUnreadable
            table.collectorLevel = .problem
            return table
        }
        guard !report.hosts.isEmpty else {
            var table = localTable
            table.collectorNote = L10n.fleetEmpty
            table.collectorLevel = .warn
            return table
        }
        let rows = report.hosts.map { host in
            row(name: FleetMachines.label(host.name), status: host.status, hostError: host.ok ? nil : (host.error ?? "unknown"), now: now)
        }
        var table = CliFleetTable(rows: rows, collectorNote: nil, fromFleet: true)
        let age = now.timeIntervalSince(collected)
        if age > collectorStaleSeconds {
            table.collectorNote = age < 1e9 ? L10n.cliCollectorStalled(Int(age / 60)) : L10n.fleetStaleLong
            table.collectorLevel = .problem
        } else if age < -futureSkewSeconds {
            table.collectorNote = L10n.fleetFutureTime
            table.collectorLevel = .warn
        }
        return table
    }

    static func localRow(_ local: CliLocalCliState, now: Date) -> CliFleetRow {
        let grok = local.grok.map { grokCell($0, now: now) }
            ?? CliGrokCell(level: .pending, word: StatusVocabulary.checking, usagePercent: nil, reset: nil)
        let agy = local.agy.map { agyCell($0, now: now) }
            ?? CliAgyCell(level: .pending, word: StatusVocabulary.checking, weeklyRemaining: nil, fiveHourRemaining: nil, reset: nil)
        let level = max(grok.level, agy.level)
        return CliFleetRow(name: local.host, level: level, statusWord: levelWord(level), dimmed: false, grok: grok, agy: agy,
                           grokLastUsed: relative(local.grok?.lastUsed, now: now), agyLastUsed: relative(local.agy?.lastUsed, now: now),
                           grokToday: count(local.grok?.sessionsToday), agyToday: count(local.agy?.conversationsToday))
    }

    /// 머신 한 줄. hostError가 있으면 수집 실패(꺼질 수 있는 머신은 "offline"으로 와서 주의)다.
    static func row(name: String, status: CliStatusSnapshot?, hostError: String?, now: Date) -> CliFleetRow {
        let none = StatusVocabulary.none
        guard hostError == nil, let status else {
            let offline = hostError == "offline"
            let blankGrok = CliGrokCell(level: .pending, word: nil, usagePercent: nil, reset: nil)
            let blankAgy = CliAgyCell(level: .pending, word: nil, weeklyRemaining: nil, fiveHourRemaining: nil, reset: nil)
            return CliFleetRow(name: name, level: offline ? .warn : .problem,
                               statusWord: offline ? L10n.cliOffline : L10n.cliCollectFailed, dimmed: true,
                               grok: blankGrok, agy: blankAgy, grokLastUsed: none, agyLastUsed: none, grokToday: none, agyToday: none,
                               detail: hostError ?? "parse")
        }
        let grok = grokCell(status.grok, now: now)
        let agy = agyCell(status.agy, now: now)
        var level = max(grok.level, agy.level)
        var word = levelWord(level)
        var dimmed = false
        let age = now.timeIntervalSince(status.writtenAt)
        if age > hostStaleSeconds {
            level = .problem
            word = age < 1e9 ? L10n.cliStalled(Int(age / 60)) : L10n.fleetStaleLong
            dimmed = true
        } else if age < -futureSkewSeconds {
            level = max(level, .warn)
            word = L10n.cliClockSkew
        }
        return CliFleetRow(name: name, level: level, statusWord: word, dimmed: dimmed, grok: grok, agy: agy,
                           grokLastUsed: relative(status.grok.lastUsed, now: now), agyLastUsed: relative(status.agy.lastUsed, now: now),
                           grokToday: count(status.grok.sessionsToday), agyToday: count(status.agy.conversationsToday))
    }

    static func grokCell(_ grok: CliGrokStatus, now: Date) -> CliGrokCell {
        let reset = grok.periodEnd.map { resetText($0, now: now) }
        guard grok.installed else { return CliGrokCell(level: .problem, word: StatusVocabulary.notInstalled, usagePercent: nil, reset: nil) }
        switch grok.auth {
        case .login: return CliGrokCell(level: .problem, word: L10n.cliLoginNeeded, usagePercent: nil, reset: nil)
        case .expired: return CliGrokCell(level: .warn, word: L10n.cliRefreshNeeded, usagePercent: grok.usagePercent, reset: reset)
        case .unavailable: return CliGrokCell(level: .warn, word: StatusVocabulary.needsCheck, usagePercent: grok.usagePercent, reset: reset)
        case .ok:
            guard let usage = grok.usagePercent else {
                return CliGrokCell(level: .warn, word: StatusVocabulary.needsCheck, usagePercent: nil, reset: reset)
            }
            let remaining = max(0, 100 - usage)
            if remaining < lowRemainingPercent {
                return CliGrokCell(level: .warn, word: L10n.cliLeft(Int(remaining.rounded(.down))), usagePercent: usage, reset: reset)
            }
            return CliGrokCell(level: .ok, word: nil, usagePercent: usage, reset: reset)
        }
    }

    static func agyCell(_ agy: CliAgyStatus, now: Date) -> CliAgyCell {
        guard agy.installed else {
            return CliAgyCell(level: .problem, word: StatusVocabulary.notInstalled, weeklyRemaining: nil, fiveHourRemaining: nil, reset: nil)
        }
        switch agy.auth {
        case .login:
            return CliAgyCell(level: .problem, word: L10n.cliLoginNeeded, weeklyRemaining: nil, fiveHourRemaining: nil, reset: nil)
        case .error:
            return CliAgyCell(level: .warn, word: StatusVocabulary.needsCheck, weeklyRemaining: nil, fiveHourRemaining: nil, reset: nil)
        case .ok:
            guard let group = agy.groups.first(where: { $0.name.lowercased().contains("gemini") }) ?? agy.groups.first else {
                return CliAgyCell(level: .warn, word: L10n.cliNoGemini, weeklyRemaining: nil, fiveHourRemaining: nil, reset: nil)
            }
            // 남은 양은 낮춰 말한다(99.5%를 100%로 보이지 않게, 제목 슬롯과 같은 규칙).
            let weekly = group.weeklyRemainingPercent.map { $0.rounded(.down) }
            let fiveHour = group.fiveHourRemainingPercent.map { $0.rounded(.down) }
            var parts: [String] = []
            if let reset = group.weeklyReset { parts.append(L10n.cliWeeklyReset(shortDuration(reset, now: now))) }
            if let reset = group.fiveHourReset { parts.append(L10n.cliFiveHourReset(shortDuration(reset, now: now))) }
            let reset = parts.isEmpty ? nil : parts.joined(separator: " · ")
            guard weekly != nil || fiveHour != nil else {
                return CliAgyCell(level: .warn, word: StatusVocabulary.needsCheck, weeklyRemaining: nil, fiveHourRemaining: nil, reset: reset)
            }
            let lowest = [weekly, fiveHour].compactMap { $0 }.min() ?? 100
            if lowest < lowRemainingPercent {
                return CliAgyCell(level: .warn, word: L10n.cliLeft(Int(lowest)), weeklyRemaining: weekly, fiveHourRemaining: fiveHour, reset: reset)
            }
            return CliAgyCell(level: .ok, word: nil, weeklyRemaining: weekly, fiveHourRemaining: fiveHour, reset: reset)
        }
    }

    static func levelWord(_ level: CliLevel) -> String {
        switch level {
        case .ok: return L10n.cliStateOk
        case .pending: return StatusVocabulary.checking
        case .warn: return L10n.cliStateWarn
        case .problem: return L10n.cliStateProblem
        }
    }

    /// "초기화 3일 4시간"(큰 단위 두 개). 지났으면 "곧 초기화".
    static func resetText(_ date: Date, now: Date) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return L10n.cliResetSoon }
        return L10n.cliResetIn(L10n.duration(seconds: Int(min(seconds, 1e8))))
    }

    /// 한 단위만: 40분·2시간·5일. 좁은 agy 칸에 두 창을 함께 넣는다.
    static func shortDuration(_ date: Date, now: Date) -> String {
        let seconds = date.timeIntervalSince(now)
        guard seconds > 0 else { return L10n.cliSoon }
        let minutes = max(1, Int(min(seconds, 1e8) / 60))
        if minutes < 60 { return L10n.durationMinutes(minutes) }
        let hours = minutes / 60
        if hours < 48 { return L10n.durationHours(hours) }
        return L10n.durationDays(hours / 24)
    }

    /// "방금"·"3분 전"·"2시간 전"·"4일 전". 없으면 —.
    static func relative(_ date: Date?, now: Date) -> String {
        guard let date else { return StatusVocabulary.none }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return L10n.cliJustNow }
        let minutes = Int(min(seconds, 1e8) / 60)
        if minutes < 60 { return L10n.cliAgo(L10n.durationMinutes(minutes)) }
        let hours = minutes / 60
        if hours < 48 { return L10n.cliAgo(L10n.durationHours(hours)) }
        return L10n.cliAgo(L10n.durationDays(hours / 24))
    }

    static func count(_ value: Int?) -> String { value.map(String.init) ?? StatusVocabulary.none }
}
