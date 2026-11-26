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
    /// 그리는 줄(앞 maxRows대).
    var rows: [CliFleetRow]
    /// 표시 상한 밖의 줄. 그리지 않지만 요약·아래 한 줄에 센다(검토 I3).
    var hidden: [CliFleetRow] = []
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
    /// 그릴 머신 수 상한. 넘는 머신은 "외 N대" 한 줄로 센다.
    static let maxRows = 32

    var totalCount: Int { rows.count + hidden.count }
    var okCount: Int { (rows + hidden).filter { $0.level == .ok }.count }

    /// 표시 상한 밖 머신 한 줄("외 1대 · 문제 1"). 없으면 nil.
    var hiddenNote: String? {
        guard !hidden.isEmpty else { return nil }
        return L10n.cliHiddenMachines(hidden.count, problem: hidden.filter { $0.level == .problem }.count,
                                      warn: hidden.filter { $0.level == .warn }.count)
    }

    var hiddenLevel: CliLevel { hidden.map(\.level).max() ?? .ok }

    /// CLI 섹션 머리 요약. 표시 상한 밖 머신까지 센다("33대 중 정상 32"). 수집 파일이 없으면 "이 맥".
    /// 수집기 경고(멈춤·읽기 실패)가 있으면 그것을 앞세우고, 대수는 정상 판정 없이 "마지막 수집 N대"로만 말한다.
    var sectionSummary: String {
        guard let note = collectorNote else {
            return fromFleet ? L10n.cliFleetSummary(machines: totalCount, ok: okCount) : L10n.cliThisMac
        }
        return fromFleet ? "\(note) · \(L10n.cliLastCollected(totalCount))" : note
    }

    // 표 기하. 그리기와 높이 계산이 같은 값을 쓴다.
    static let topInset: CGFloat = 6
    static let noteHeight: CGFloat = 22
    static let headHeight: CGFloat = 22
    static let rowHeight: CGFloat = 44
    static let bottomInset: CGFloat = 6

    static func height(rows: Int, hidden: Bool = false) -> CGFloat {
        topInset + noteHeight + headHeight + rowHeight * CGFloat(max(1, rows)) + (hidden ? noteHeight : 0) + bottomInset
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
        let all = report.hosts.map { host in
            row(name: FleetMachines.label(host.name), status: host.status, hostError: host.ok ? nil : (host.error ?? "unknown"), now: now)
        }
        var table = CliFleetTable(rows: Array(all.prefix(maxRows)), collectorNote: nil, fromFleet: true)
        table.hidden = Array(all.dropFirst(maxRows))
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
                           grokLastUsed: lastUsed(local.grok?.lastUsed, partial: local.grok?.sessionsTodayPartial ?? false, now: now),
                           agyLastUsed: lastUsed(local.agy?.lastUsed, partial: local.agy?.conversationsTodayPartial ?? false, now: now),
                           grokToday: count(local.grok?.sessionsToday, partial: local.grok?.sessionsTodayPartial ?? false),
                           agyToday: count(local.agy?.conversationsToday, partial: local.agy?.conversationsTodayPartial ?? false))
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
                           grokLastUsed: lastUsed(status.grok.lastUsed, partial: status.grok.sessionsTodayPartial, now: now),
                           agyLastUsed: lastUsed(status.agy.lastUsed, partial: status.agy.conversationsTodayPartial, now: now),
                           grokToday: count(status.grok.sessionsToday, partial: status.grok.sessionsTodayPartial),
                           agyToday: count(status.agy.conversationsToday, partial: status.agy.conversationsTodayPartial))
    }

    /// 조회 지연 문구. 최근 조회가 실패했거나 마지막 성공이 5분을 넘었으면 "조회 지연 N분"(성공 기록이 없으면 "조회 실패").
    /// 파일 기록 시각(written_at)은 매분 새로 붙으므로 신선함의 근거로 쓰지 않는다.
    static func fetchLag(lastOkAt: Date?, failed: Bool, now: Date) -> String? {
        let age = lastOkAt.map { now.timeIntervalSince($0) }
        guard failed || (age ?? 0) > hostStaleSeconds else { return nil }
        guard let age else { return L10n.cliFetchFailed }
        return L10n.cliFetchLag(max(1, Int(min(age, 1e8) / 60)))
    }

    static func grokCell(_ grok: CliGrokStatus, now: Date) -> CliGrokCell {
        let cell = grokCellValue(grok, now: now)
        guard grok.installed, grok.auth == .ok, let lag = fetchLag(lastOkAt: grok.lastOkAt, failed: grok.fetchFailed, now: now) else {
            return cell
        }
        return CliGrokCell(level: max(cell.level, .warn), word: lag, usagePercent: cell.usagePercent, reset: nil)
    }

    private static func grokCellValue(_ grok: CliGrokStatus, now: Date) -> CliGrokCell {
        let reset = grok.periodEnd.map { resetText($0, now: now) }
        guard grok.installed else { return CliGrokCell(level: .problem, word: StatusVocabulary.notInstalled, usagePercent: nil, reset: nil) }
        switch grok.auth {
        case .login: return CliGrokCell(level: .problem, word: L10n.cliLoginNeeded, usagePercent: nil, reset: nil)
        // 만료·확인 필요는 할 일이 먼저다. 둘째 줄에는 상태 글자만 두고 초기화 시각은 싣지 않는다(좁은 칸에서 잘리지 않게).
        case .expired: return CliGrokCell(level: .warn, word: L10n.cliRefreshNeeded, usagePercent: grok.usagePercent, reset: nil)
        case .unavailable: return CliGrokCell(level: .warn, word: StatusVocabulary.needsCheck, usagePercent: grok.usagePercent, reset: nil)
        case .ok:
            guard let usage = grok.usagePercent else {
                return CliGrokCell(level: .warn, word: StatusVocabulary.needsCheck, usagePercent: nil, reset: nil)
            }
            let remaining = max(0, 100 - usage)
            if remaining < lowRemainingPercent {
                // 남은 양이 적으면 언제 돌아오는지가 중요하다. 상태 글자 옆에 한 단위로 줄인 초기화 시각을 둔다.
                let short = grok.periodEnd.map { L10n.cliResetIn(shortDuration($0, now: now)) }
                return CliGrokCell(level: .warn, word: L10n.cliLeft(Int(remaining.rounded(.down))), usagePercent: usage, reset: short)
            }
            return CliGrokCell(level: .ok, word: nil, usagePercent: usage, reset: reset)
        }
    }

    static func agyCell(_ agy: CliAgyStatus, now: Date) -> CliAgyCell {
        let cell = agyCellValue(agy, now: now)
        guard agy.installed, agy.auth == .ok, let lag = fetchLag(lastOkAt: agy.lastOkAt, failed: agy.fetchFailed, now: now) else {
            return cell
        }
        return CliAgyCell(level: max(cell.level, .warn), word: lag, weeklyRemaining: cell.weeklyRemaining,
                          fiveHourRemaining: cell.fiveHourRemaining, reset: nil)
    }

    private static func agyCellValue(_ agy: CliAgyStatus, now: Date) -> CliAgyCell {
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
            // 창마다 (남은 양, 초기화 문구). 레인이 여럿이면 첫 레인 값을 보이고 나머지는 세어서 알린다.
            // 조용히 버리면 남은 양을 오독한다. 주의 판정은 모든 레인의 가장 낮은 남은 양으로 한다.
            let windows: [(remaining: Double, reset: String?)] = agy.groups.flatMap { lane -> [(Double, String?)] in
                var out: [(Double, String?)] = []
                if let left = lane.weeklyRemainingPercent {
                    out.append((left.rounded(.down), lane.weeklyReset.map { L10n.cliWeeklyReset(shortDuration($0, now: now)) }))
                }
                if let left = lane.fiveHourRemainingPercent {
                    out.append((left.rounded(.down), lane.fiveHourReset.map { L10n.cliFiveHourReset(shortDuration($0, now: now)) }))
                }
                return out
            }
            let more = agy.groups.count > 1 ? [L10n.cliMoreLanes(agy.groups.count - 1)] : []
            var parts: [String] = []
            if let reset = group.weeklyReset { parts.append(L10n.cliWeeklyReset(shortDuration(reset, now: now))) }
            if let reset = group.fiveHourReset { parts.append(L10n.cliFiveHourReset(shortDuration(reset, now: now))) }
            if agy.groups.count > 1 { parts.append(L10n.cliMoreLanes(agy.groups.count - 1)) }
            let reset = parts.isEmpty ? nil : parts.joined(separator: " · ")
            guard weekly != nil || fiveHour != nil else {
                return CliAgyCell(level: .warn, word: StatusVocabulary.needsCheck, weeklyRemaining: nil, fiveHourRemaining: nil, reset: reset)
            }
            if let lowest = windows.min(by: { $0.remaining < $1.remaining }), lowest.remaining < lowRemainingPercent {
                // 둘째 줄은 "남음 12% · 5h 2시간": 모자란 창의 초기화만 붙여 좁은 칸에 들어가게 한다.
                let lowReset = ([lowest.reset].compactMap { $0 } + more).joined(separator: " · ")
                return CliAgyCell(level: .warn, word: L10n.cliLeft(Int(lowest.remaining)), weeklyRemaining: weekly, fiveHourRemaining: fiveHour,
                                  reset: lowReset.isEmpty ? nil : lowReset)
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

    /// 마지막 사용. 열거 상한에 걸린 부분 스캔이면 본 것보다 최근 사용이 있을 수 있어 "미확인"이다.
    static func lastUsed(_ date: Date?, partial: Bool, now: Date) -> String {
        partial ? L10n.cliUnverified : relative(date, now: now)
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

    /// 개수. 열거 상한에 걸려 일부만 셌으면 "3+"(하한).
    static func count(_ value: Int?, partial: Bool = false) -> String {
        value.map { "\($0)" + (partial ? "+" : "") } ?? StatusVocabulary.none
    }
}
