import Foundation
import CoreFoundation

struct TeamCodexConfigRefreshCoordinator {
    private(set) var runningGeneration: Int?
    private(set) var pendingGeneration: Int?

    mutating func request(generation: Int) -> Bool {
        guard runningGeneration == nil else {
            pendingGeneration = generation
            return false
        }
        runningGeneration = generation
        return true
    }

    func shouldContinue(generation: Int) -> Bool {
        runningGeneration == generation && pendingGeneration == nil
    }

    mutating func finish(generation: Int) -> Bool {
        guard runningGeneration == generation else { return false }
        let shouldRunLatest = pendingGeneration != nil
        runningGeneration = nil
        pendingGeneration = nil
        return shouldRunLatest
    }
}

struct TeamCodexPoolAccount {
    let name: String
    let accountUuid: String?
    let isCurrent: Bool
    let enabled: Bool
    let status: String
    let errorReason: String?
    let usableFromProxy: Bool?
    let sessionPercent: Double?
    let sessionResetAt: Date?
    let weeklyPercent: Double?
    let weeklyResetAt: Date?
    let inflight: Int
    let maxConcurrent: Int
    let totalRequests: Int
    let totalTokens: Int
    /// 프록시 subscription.state (active | cancellation-scheduled | end-date-reached | ended).
    /// 기존 생성 지점 호환을 위해 기본값이 있는 var로 둔다.
    var subscriptionState: String? = nil
    /// 구독 종료(예정) 시각. 프록시는 ISO8601 문자열로 준다.
    var subscriptionEndsAt: Date? = nil
    var planType: String? = nil
    /// 프록시 status·teamcodex.json의 `type` (oauth 등). 재인증은 oauth 계정만 대상으로 한다.
    var accountType: String? = nil
    /// 프록시 status·teamcodex.json의 `provider` (codex). 다른 풀 계정에 codex 명령을 쏘지 않기 위한 가드.
    var providerName: String? = nil
    var codexResetCredits: Int? = nil
    var codexResetCreditsAt: Date? = nil
    var rateLimitedUntil: Date? = nil

    func resetCreditCount(at now: Date, online: Bool) -> Int? {
        guard online, status != "configured", let count = codexResetCredits, count >= 0,
              let measuredAt = codexResetCreditsAt,
              measuredAt <= now, now.timeIntervalSince(measuredAt) < 600 else { return nil }
        return count
    }

    func resetCreditLabel(at now: Date, online: Bool) -> String {
        resetCreditCount(at: now, online: online).map { "\($0)장" } ?? "미확인"
    }

    func sessionUsagePercent(at now: Date) -> Double? {
        guard let sessionResetAt, sessionResetAt > now else { return nil }
        return sessionPercent
    }

    func weeklyUsagePercent(at now: Date) -> Double? {
        guard let weeklyResetAt, weeklyResetAt > now else { return nil }
        return weeklyPercent
    }

    /// 구독이 확정적으로 끝난 계정. 기다려도 돌아오지 않는다.
    /// `end-date-reached`는 여기 넣지 않는다 — 프록시는 그 상태를 "확인 안 된 종료"로 보고
    /// 인증 실패로 `ended`가 되기 전까지 계속 요청을 보낸다(tui.js는 노랑 `sub due`).
    /// 종료로 접으면 아직 서빙 중인 계정을 화면에서 지워 "사용 가능 0"이라 말하게 된다.
    func isSubscriptionRetired(now: Date = Date()) -> Bool {
        errorReason == "subscription-ended" || subscriptionState == "ended"
    }

    /// 종료일은 지났는데 프록시가 아직 종료로 확정하지 못한 계정. 지금도 요청을 받을 수 있다.
    /// 해지 예약인데 종료 시각을 넘긴 경우도 같은 칸으로 본다(프록시가 곧 이 상태로 옮긴다).
    func isSubscriptionEndDateReached(now: Date = Date()) -> Bool {
        if isSubscriptionRetired(now: now) { return false }
        if subscriptionState == "end-date-reached" { return true }
        guard subscriptionState == "cancellation-scheduled", let subscriptionEndsAt else { return false }
        return subscriptionEndsAt <= now
    }

    /// 아직 서비스하지만 해지가 예약된 계정.
    func isSubscriptionEnding(now: Date = Date()) -> Bool {
        subscriptionState == "cancellation-scheduled"
            && !isSubscriptionRetired(now: now)
            && !isSubscriptionEndDateReached(now: now)
    }

    /// 잠시 빠진 것이 아니라 풀에서 영구히 빠진 계정(구독 종료 또는 운영자가 끔).
    func isPermanentlyOut(now: Date = Date()) -> Bool {
        isSubscriptionRetired(now: now) || !enabled
    }

    func isQuotaBlocked(switchThresholdPercent: Double) -> Bool {
        [sessionPercent, weeklyPercent].compactMap { $0 }.contains { $0 >= switchThresholdPercent }
    }

    func isUsable(switchThresholdPercent: Double, now: Date = Date()) -> Bool {
        guard enabled, !isSubscriptionRetired(now: now) else { return false }
        if let usableFromProxy { return usableFromProxy }
        // 프록시 판정이 없는 행 = 아직 프록시가 싣지 않은 계정(오프라인 스냅샷, 재기동 전 신규 계정).
        // 설정 파일에 있다는 사실만으로 "지금 쓸 수 있다"고 세면 요약줄이 거짓말을 한다.
        return !["disabled", "error", "exhausted", "throttled", "configured", "unknown"]
            .contains(status)
            && !isQuotaBlocked(switchThresholdPercent: switchThresholdPercent)
    }

    /// 한도 때문에 빠진 계정이 돌아오는 시각. 막힌 창(5시간·주간)이 전부 초기화돼야 돌아오므로 늦은 쪽을 쓴다.
    /// 오류·종료·꺼 둔 계정은 기다려도 안 돌아오니 nil.
    func quotaRecoveryAt(switchThresholdPercent: Double, now: Date) -> Date? {
        // 오류 행은 사유 라벨이 없어도 복구 시각을 약속하지 않는다(초기화돼도 돌아오지 않는다).
        guard enabled, status != "error", errorReason == nil, !isSubscriptionRetired(now: now) else { return nil }
        var blockers: [Date] = []
        if let until = rateLimitedUntil, until > now { blockers.append(until) }
        if let percent = sessionPercent, percent >= switchThresholdPercent,
           let at = sessionResetAt, at > now { blockers.append(at) }
        if let percent = weeklyPercent, percent >= switchThresholdPercent,
           let at = weeklyResetAt, at > now { blockers.append(at) }
        return blockers.max()
    }
}

struct TeamCodexPoolHealth {
    let checkedAt: Date
    let serverReachable: Bool
    let serverPort: Int
    let serverPid: Int?
    let currentAccount: String?
    let currentAccountUuid: String?
    let switchThresholdPercent: Double
    let accounts: [TeamCodexPoolAccount]
    var resetCreditsEnabled: Bool? = nil
    var resetCreditsPolicy: String? = nil
    var runtimeSummary: String? = nil

    var resetCreditSummary: String {
        let members = accounts.filter { !$0.isPermanentlyOut(now: checkedAt) }
        let counts = members.compactMap { $0.resetCreditCount(at: checkedAt, online: serverReachable) }
        let unknown = members.count - counts.count
        let total = counts.reduce(0) { sum, count in
            let result = sum.addingReportingOverflow(count)
            return result.overflow ? Int.max : result.partialValue
        }
        if counts.isEmpty && unknown > 0 { return "활성 풀 리셋권 미확인 \(unknown)계정" }
        return "활성 풀 리셋권 \(total)장" + (unknown > 0 ? " · 미확인 \(unknown)계정" : "")
    }

    var resetCreditPolicyLabel: String {
        guard serverReachable, let enabled = resetCreditsEnabled else { return "자동 리셋 상태 미확인" }
        if !enabled { return "자동 리셋 꺼짐" }
        switch resetCreditsPolicy {
        case "account": return "계정별 한도 소진 시 자동 리셋"
        case "fleet": return "전체 풀 소진 시 자동 리셋"
        default: return "자동 리셋 정책 미확인"
        }
    }

    var resetCreditAccessibilitySummary: String {
        let rows = accounts.map { "\($0.name) 리셋권 \($0.resetCreditLabel(at: checkedAt, online: serverReachable))" }
        return ([resetCreditPolicyLabel, resetCreditSummary] + rows).joined(separator: ", ")
    }

    /// 풀에 남아 있는 계정 중 실제로 응답 중인 계정. 꺼 둔 계정·구독 종료 계정은 세지 않는다.
    var activeCount: Int {
        accounts.filter { !$0.isPermanentlyOut(now: checkedAt) && $0.status == "active" }.count
    }

    /// 구독 종료·수동 제외를 뺀, 지금 풀에 남아 있는 계정 수.
    var poolCount: Int {
        accounts.filter { !$0.isPermanentlyOut(now: checkedAt) }.count
    }

    /// 지금 풀에 없는 계정 수. 구독 종료(영구)와 운영자가 끈 계정(되돌릴 수 있음)이 함께 들어가므로
    /// 집계 문구에서 "영구"라고 단정하지 않는다. 영구인지 아닌지는 각 줄의 라벨이 말한다.
    var excludedCount: Int {
        accounts.filter { $0.isPermanentlyOut(now: checkedAt) }.count
    }

    var usableCount: Int {
        accounts.filter {
            $0.isUsable(switchThresholdPercent: switchThresholdPercent, now: checkedAt)
        }.count
    }

    var currentQuotaAccount: TeamCodexPoolAccount? {
        guard serverReachable else { return nil }
        let matches = accounts.filter { $0.isCurrent && !$0.isPermanentlyOut(now: checkedAt) }
        return matches.count == 1 ? matches[0] : nil
    }

    /// 프록시엔 닿지만 지금 요청을 받을 계정이 하나도 없는 상태. "온라인"만으로는 0/7을 못 말한다.
    var isExhausted: Bool {
        serverReachable && poolCount > 0 && usableCount == 0
    }

    /// 한도로 빠진 계정 중 가장 먼저 돌아오는 시각.
    var soonestQuotaRecoveryAt: Date? {
        accounts
            .compactMap { $0.quotaRecoveryAt(switchThresholdPercent: switchThresholdPercent, now: checkedAt) }
            .min()
    }

    var statusLabel: String {
        if !serverReachable { return "오프라인" }
        return isExhausted ? "소진" : "온라인"
    }

    func titleSlot(timeZone: TimeZone = .current) -> String {
        if !serverReachable { return "Codex 오프라인" }
        if isExhausted {
            if let at = soonestQuotaRecoveryAt {
                return "Codex 소진 · \(teamCodexShortClock(at, timeZone: timeZone)) 복구"
            }
            return "Codex 소진 0/\(poolCount)"
        }
        return "Codex \(usableCount)/\(poolCount)"
    }

    var titleSlot: String { titleSlot(timeZone: .current) }

    var accessibilitySummary: String {
        "TeamCodex \(statusLabel), 지금 쓸 수 있는 계정 \(usableCount)개, "
            + "풀에 남은 계정 \(poolCount)개, 풀에서 빠진 계정 \(excludedCount)개"
    }
}

enum TeamCodexPoolStatusError: Error {
    case invalidJSON
}

private func teamCodexObject(from data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw TeamCodexPoolStatusError.invalidJSON
    }
    return object
}

private func teamCodexInt(_ value: Any?) -> Int? {
    if let value = value as? Int { return value }
    if let value = value as? NSNumber { return value.intValue }
    if let value = value as? String { return Int(value) }
    return nil
}

private func teamCodexCreditCount(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
          let count = Int(exactly: number.doubleValue), count >= 0 else { return nil }
    return count
}

private func teamCodexCreditTimestamp(_ value: Any?) -> Date? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    return teamCodexDate(number)
}

private func teamCodexDouble(_ value: Any?) -> Double? {
    if let value = value as? Double { return value }
    if let value = value as? NSNumber { return value.doubleValue }
    if let value = value as? String { return Double(value) }
    return nil
}

private func teamCodexBool(_ value: Any?) -> Bool? {
    if let value = value as? Bool { return value }
    if let value = value as? NSNumber { return value.boolValue }
    return nil
}

private func teamCodexString(_ value: Any?) -> String? {
    value as? String
}

private func teamCodexDate(_ value: Any?) -> Date? {
    guard let raw = teamCodexDouble(value), raw.isFinite, raw > 0 else { return nil }
    let seconds = raw > 10_000_000_000 ? raw / 1000 : raw
    return Date(timeIntervalSince1970: seconds)
}

private let teamCodexISOFormatters: [ISO8601DateFormatter] = {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return [fractional, plain]
}()

/// epoch(ms/s) 숫자와 ISO8601 문자열을 모두 받는다. 프록시 subscription.endsAt은 ISO8601이다.
private func teamCodexTimestamp(_ value: Any?) -> Date? {
    if let date = teamCodexDate(value) { return date }
    guard let raw = teamCodexString(value), !raw.isEmpty else { return nil }
    for formatter in teamCodexISOFormatters {
        if let date = formatter.date(from: raw) { return date }
    }
    return nil
}

func formatTeamCodexResetRemaining(_ date: Date?, now: Date = Date()) -> String {
    guard let date else { return "시각 미측정" }
    let seconds = Int(date.timeIntervalSince(now))
    if seconds <= 0 { return "갱신 확인 중" }

    let minutes = seconds / 60
    if minutes < 60 { return "\(max(1, minutes))분 후" }

    let hours = minutes / 60
    let remainingMinutes = minutes % 60
    if hours < 24 {
        return remainingMinutes == 0
            ? "\(hours)시간 후"
            : "\(hours)시간 \(remainingMinutes)분 후"
    }

    let days = hours / 24
    let remainingHours = hours % 24
    return remainingHours == 0
        ? "\(days)일 후"
        : "\(days)일 \(remainingHours)시간 후"
}

func teamAccountErrorReasonLabel(_ reason: String?) -> String {
    switch reason {
    case "subscription-disabled": return "조직차단"
    case "subscription-ended": return "구독종료"
    case "auth-revoked": return "인증만료"
    case "auth-rejected": return "인증거부"
    case "refresh-failed": return "갱신실패"
    case "send-failed": return "송신실패"
    default: return "오류"
    }
}

/// 계정 한 줄에 무엇을 쓸지 정하는 우선순위.
/// 영구 제외(구독 종료 → 수동 제외) → 오류 → 일시 한도 → 정상 순으로 강한 사실이 이긴다.
enum TeamCodexAccountState {
    /// 구독이 끝났다. 기다려도 돌아오지 않는다.
    case retired
    /// 운영자가 직접 껐다. 다시 켜기 전에는 쓰이지 않는다.
    case excluded
    /// 인증·전송 실패. 고쳐야 한다.
    case failed
    /// 종료일은 지났으나 프록시가 아직 종료로 확정하지 않았다. 지금도 요청을 받는다.
    case endDateReached
    /// 한도를 다 썼다. 초기화되면 돌아온다.
    case limited
    /// 살아 있지만 지금은 배정되지 않는다.
    case paused
    /// 지금 요청을 받을 수 있다.
    case serving
    /// 대기·설정됨 등 그 외 상태.
    case other
}

func teamCodexAccountState(
    _ account: TeamCodexPoolAccount,
    switchThresholdPercent: Double,
    now: Date = Date()
) -> TeamCodexAccountState {
    if account.isSubscriptionRetired(now: now) { return .retired }
    // 꺼 둔 계정이라도 인증·전송 실패는 삼키지 않는다. 삼키면 다시 켜는 순간 처음 알게 된다.
    // 병합 경로(main.swift)는 꺼 둔 계정의 status를 "disabled"로 덮으므로 errorReason도 함께 본다.
    if account.status == "error" || account.errorReason != nil { return .failed }
    if !account.enabled { return .excluded }
    // 종료일 경과는 한도소진보다 강한 사실이다. "초기화되면 돌아온다"로 읽히면 안 된다.
    if account.isSubscriptionEndDateReached(now: now) { return .endDateReached }
    if account.status == "configured" || account.status == "available" { return .other }
    if account.status == "exhausted"
        || account.status == "throttled"
        || account.isQuotaBlocked(switchThresholdPercent: switchThresholdPercent) {
        return .limited
    }
    if account.isUsable(switchThresholdPercent: switchThresholdPercent, now: now) { return .serving }
    if account.status == "active" { return .paused }
    return .other
}

/// 상태 컬럼(폭 105pt)에 들어가는 라벨. 오류 사유는 두 렌더러가 공유하는 canonical 라벨을 쓴다.
func teamCodexAccountStateLabel(
    _ state: TeamCodexAccountState,
    status: String,
    errorReason: String?
) -> String {
    switch state {
    case .retired: return "구독종료"
    // Claude 풀 표(TeamClaudeMeasurementIssue.disabled)와 같은 낱말을 쓴다.
    // 한 창에서 두 표를 읽는 사람이 같은 개념에 두 단어를 배우게 하지 않는다.
    case .excluded: return "비활성"
    case .failed: return teamAccountErrorReasonLabel(errorReason)
    case .endDateReached: return "종료확인중"
    case .limited: return "한도소진"
    case .paused: return "일시대기"
    case .serving: return "사용 중"
    case .other:
        switch status {
        case "available": return "대기"
        case "configured": return "설정됨"
        case "disabled": return "비활성"
        case "exhausted": return "한도소진"
        case "throttled": return "일시대기"
        default: return status
        }
    }
}

func teamCodexAccountStatusLabel(
    _ account: TeamCodexPoolAccount,
    switchThresholdPercent: Double,
    now: Date = Date()
) -> String {
    teamCodexAccountStateLabel(
        teamCodexAccountState(
            account,
            switchThresholdPercent: switchThresholdPercent,
            now: now
        ),
        status: account.status,
        errorReason: account.errorReason
    )
}

/// 계정 이름 아래 보조줄. "돌아온다 / 돌아오지 않는다"를 말로 못 박는다.
func teamCodexAccountNote(
    _ account: TeamCodexPoolAccount,
    switchThresholdPercent: Double,
    now: Date = Date()
) -> String? {
    if account.isSubscriptionRetired(now: now) { return "돌아오지 않음" }
    if account.isSubscriptionEndDateReached(now: now) { return "종료일 지남 · 연결 확인 중" }
    // 오류가 상태 칸을 가져가더라도 "직접 껐다"는 사실은 보조줄이 계속 말한다.
    if !account.enabled { return "직접 꺼 둔 계정" }
    guard account.isSubscriptionEnding(now: now) else { return nil }
    guard let endsAt = account.subscriptionEndsAt, endsAt > now else { return "구독 종료 예정" }
    return "구독 종료 예정 · " + formatTeamCodexResetRemaining(endsAt, now: now)
}

/// 풀에서 빠진 계정을 그 자리에서 되돌리는 방법.
enum TeamCodexAccountRecoveryKind {
    /// 운영자가 꺼 둔 계정을 다시 켠다.
    case enable
    /// 인증이 끊긴 계정의 자격증명을 다시 연결한다.
    case reauth
}

/// 버튼이 지어낼 수 있는 문자열을 없애기 위해 제목·실행 인자·설명을 한 값으로 묶는다.
struct TeamCodexAccountRecovery: Equatable {
    let kind: TeamCodexAccountRecoveryKind
    let title: String
    /// teamcodex CLI 인자. 앞에 `codex`가 붙어 Codex 풀로만 간다.
    let arguments: [String]
    let accessibilityLabel: String
    let toolTip: String
    /// 눌러도 실행 중 서버에 바로 반영되지 않을 수 있는 경우에만 채운다.
    let followUpNote: String?
}

/// 다시 켠 계정이 실행 중 서버에 즉시 반영된다는 보장이 없다.
/// CLI는 워커에 SIGHUP을 시도하고, 실패하면 "Apply the change with: teamcodex restart"를 찍는다.
let teamCodexEnableFollowUpNote = "다시 켠 뒤 터미널 안내를 확인하세요 · 반영되지 않으면 teamcodex restart"

/// 꺼져 있으면서 인증까지 깨진 계정. 다시 켜도 빨간 상태가 남는다는 사실을 먼저 말한다.
/// (다시 켜기 전에는 CLI reauth가 disabled 계정을 거부하므로 버튼은 여전히 "다시 켜기" 하나뿐이다.)
let teamCodexEnableThenReauthFollowUpNote = "다시 켠 뒤에도 인증 오류면 재인증이 필요합니다 · 반영은 teamcodex restart"

/// 계정 한 줄에 어떤 되돌리기 버튼을 붙일지 정한다. 붙일 것이 없으면 nil.
///
/// 판정 근거는 전부 실제 CLI 동작이다(운영 아티팩트 6b538222 `reauth.js` / `index.js`):
/// - `findReauthTarget`은 `type !== 'oauth'`, 다른 provider, `enabled === false`,
///   `subscriptionDisabled`를 각각 거부한다. 그래서 여기서도 같은 조건을 먼저 막는다.
/// - `canReauthenticateTuiAccount`(프록시 자체 TUI 게이트)는 `subscription-disabled`와
///   `subscription-ended`를 함께 재인증 대상에서 뺀다. 구독이 끝난 계정은 다시 로그인해도
///   돌아오지 않으므로 같은 판단을 따른다(패널 보조줄도 이미 "돌아오지 않음"이라고 쓴다).
/// - `enable`은 CLI가 이름으로만 계정을 찾는다(`--account-uuid` 없음).
///
/// `now`는 구독 종료 판정(`isSubscriptionRetired`)으로만 넘어간다. 지금 그 판정은 `state`와
/// `errorReason`만 보므로 실제로 시각에 의존하지 않는다. 그래도 호출부(뷰·핸들러)가 집계와
/// 같은 시각을 넘기는 규약을 지키도록 파라미터는 유지한다.
/// 재인증으로는 풀리지 않는 오류 사유.
/// - `subscription-disabled`: 조직이 막았다(Claude 표도 같은 이유로 제외한다).
/// - `send-failed`: 업스트림 전송 실패다. 자격증명 문제가 아니라서 상태 칸은 "송신실패"라고
///   쓰는데 버튼만 "재인증"이라고 처방하면 서로 모순되고, 멀쩡한 계정으로 로그인을 완주하게 된다.
func teamCodexReauthCannotFix(_ errorReason: String?) -> Bool {
    errorReason == "subscription-disabled" || errorReason == "send-failed"
}

func teamCodexAccountRecovery(
    _ account: TeamCodexPoolAccount,
    now: Date = Date()
) -> TeamCodexAccountRecovery? {
    // 계정 종류를 모르면 아무것도 제안하지 않는다. 설정 파일과 프록시 status 모두 `type`을 준다.
    guard (account.accountType ?? "").lowercased() == "oauth" else { return nil }
    guard (account.providerName ?? "codex").lowercased() == "codex" else { return nil }

    // 구독이 끝난 계정: 다시 켜도, 다시 연결해도 돌아오지 않는다.
    if account.isSubscriptionRetired(now: now) { return nil }

    // 꺼 둔 계정은 인증 상태와 무관하게 "다시 켜기"가 먼저다.
    // CLI reauth가 disabled 계정을 거부하므로 순서를 바꾸면 실패할 명령을 띄우게 된다.
    if !account.enabled {
        // 상태 칸에 빨간 인증 오류가 그대로 보이는데 버튼은 노란 "다시 켜기" 하나뿐인 조합.
        // 켠 뒤에도 빨간 상태가 남는 이유를 여기서 미리 말해 둔다.
        // 단 조직 차단·송신 실패는 재인증으로 풀리지 않으므로 "켠 뒤 재인증" 약속을 하지 않는다.
        // 켜고 나면 아래 게이트가 재인증 버튼을 아예 안 주기 때문에 지키지 못할 말이 된다.
        let hasAuthIssue = (account.errorReason != nil || account.status == "error")
            && !teamCodexReauthCannotFix(account.errorReason)
        let followUpNote = hasAuthIssue
            ? teamCodexEnableThenReauthFollowUpNote
            : teamCodexEnableFollowUpNote
        return TeamCodexAccountRecovery(
            kind: .enable,
            title: "다시 켜기",
            arguments: ["codex", "enable", account.name],
            accessibilityLabel: "다시 켜기: \(account.name)",
            toolTip: "\(account.name) 계정을 다시 풀에 넣습니다. \(followUpNote)",
            followUpNote: followUpNote
        )
    }

    // 재인증으로 풀리지 않는 사유는 버튼을 주지 않는다.
    if teamCodexReauthCannotFix(account.errorReason) { return nil }

    // 고칠 것이 있는 계정만 재인증을 제안한다. 한도소진·종료확인중·정상은 대상이 아니다.
    guard account.status == "error" || account.errorReason != nil else { return nil }

    // 자격증명을 덮어쓰는 명령이라 신원이 확인된 행에서만 실행한다.
    // 이름만으로도 CLI가 중복을 거부하긴 하지만, 덮어쓰기는 되돌리기 어려우므로 여기서 먼저 막는다.
    guard let accountUuid = account.accountUuid, !accountUuid.isEmpty else { return nil }

    // 낱말은 Claude 풀 표의 같은 버튼("재인증 필요")과 맞춘다. 한 창에서 두 표를 보는 사람이
    // 같은 동작에 두 낱말을 배우게 하지 않는다(버튼 폭은 양쪽 다 이 제목이 들어간다).
    return TeamCodexAccountRecovery(
        kind: .reauth,
        title: "재인증 필요",
        arguments: ["codex", "reauth", account.name, "--account-uuid", accountUuid],
        accessibilityLabel: "재인증 필요: \(account.name)",
        toolTip: "\(account.name) 계정의 Codex 인증을 다시 연결합니다.",
        followUpNote: nil
    )
}

private func teamCodexAccounts(
    from rows: [[String: Any]],
    currentAccount: String?,
    currentAccountUuid: String?
) -> [TeamCodexPoolAccount] {
    var nameCounts: [String: Int] = [:]
    var uuidCounts: [String: Int] = [:]
    for row in rows {
        guard let name = teamCodexString(row["name"]), !name.isEmpty else { continue }
        nameCounts[name, default: 0] += 1
        if let accountUuid = teamCodexString(row["accountUuid"]) {
            uuidCounts[accountUuid, default: 0] += 1
        }
    }

    return rows.compactMap { row in
        guard let name = teamCodexString(row["name"]), !name.isEmpty else { return nil }
        let accountUuid = teamCodexString(row["accountUuid"])
        let quota = row["quota"] as? [String: Any] ?? [:]
        let usage = row["usage"] as? [String: Any] ?? [:]
        let subscription = row["subscription"] as? [String: Any] ?? [:]
        let inputTokens = max(0, teamCodexInt(usage["totalInputTokens"]) ?? 0)
        let outputTokens = max(0, teamCodexInt(usage["totalOutputTokens"]) ?? 0)
        let isCurrent: Bool
        if let currentAccountUuid {
            isCurrent = currentAccountUuid == accountUuid
                && uuidCounts[currentAccountUuid] == 1
        } else {
            isCurrent = currentAccount == name && nameCounts[name] == 1
        }
        return TeamCodexPoolAccount(
            name: name,
            accountUuid: accountUuid,
            isCurrent: isCurrent,
            enabled: teamCodexBool(row["enabled"]) ?? true,
            status: teamCodexString(row["status"]) ?? "unknown",
            errorReason: teamCodexString(row["errorReason"]),
            usableFromProxy: teamCodexBool(row["usable"]),
            sessionPercent: teamCodexDouble(quota["unified5h"]).map { $0 * 100 },
            sessionResetAt: teamCodexDate(quota["unified5hReset"]),
            weeklyPercent: teamCodexDouble(quota["unified7d"]).map { $0 * 100 },
            weeklyResetAt: teamCodexDate(quota["unified7dReset"]),
            inflight: max(0, teamCodexInt(row["inflight"]) ?? 0),
            maxConcurrent: max(0, teamCodexInt(row["maxConcurrent"]) ?? 0),
            totalRequests: max(0, teamCodexInt(usage["totalRequests"]) ?? 0),
            totalTokens: inputTokens.addingReportingOverflow(outputTokens).overflow
                ? Int.max
                : inputTokens + outputTokens,
            subscriptionState: teamCodexString(subscription["state"]),
            subscriptionEndsAt: teamCodexTimestamp(subscription["endsAt"]),
            planType: teamCodexString(row["planType"]),
            accountType: teamCodexString(row["type"]),
            providerName: teamCodexString(row["provider"]),
            codexResetCredits: teamCodexCreditCount(quota["codexResetCredits"]),
            codexResetCreditsAt: teamCodexCreditTimestamp(quota["codexResetCreditsAt"]),
            rateLimitedUntil: teamCodexTimestamp(row["rateLimitedUntil"])
        )
    }
}

func teamCodexPoolHealth(
    from data: Data,
    port: Int,
    serverPid: Int?,
    checkedAt: Date = Date()
) throws -> TeamCodexPoolHealth {
    let object = try teamCodexObject(from: data)
    let currentAccount = teamCodexString(object["currentAccount"])
    let currentAccountUuid = teamCodexString(object["currentAccountUuid"])
    let rows = object["accounts"] as? [[String: Any]] ?? []
    let accounts = teamCodexAccounts(
        from: rows,
        currentAccount: currentAccount,
        currentAccountUuid: currentAccountUuid
    )
    let resolvedCurrent = accounts.first { $0.isCurrent }
    let resetCredits = object["resetCredits"] as? [String: Any] ?? [:]
    var pool = TeamCodexPoolHealth(
        checkedAt: checkedAt,
        serverReachable: true,
        serverPort: port,
        serverPid: serverPid,
        currentAccount: resolvedCurrent?.name,
        currentAccountUuid: resolvedCurrent?.accountUuid,
        switchThresholdPercent: (teamCodexDouble(object["switchThreshold"]) ?? 0.98) * 100,
        accounts: accounts,
        resetCreditsEnabled: teamCodexBool(resetCredits["enabled"]),
        resetCreditsPolicy: teamCodexString(resetCredits["policy"])
    )
    pool.runtimeSummary = teamRuntimeSummary(object["runtime"], short: true)
    return pool
}

func teamCodexPoolOfflineHealth(
    configData: Data?,
    port: Int,
    serverPid: Int?,
    checkedAt: Date = Date()
) throws -> TeamCodexPoolHealth {
    let object = try configData.map(teamCodexObject) ?? [:]
    let rows = object["accounts"] as? [[String: Any]] ?? []
    let configuredRows = rows.map { row -> [String: Any] in
        var configured = row
        configured["status"] = "configured"
        configured["quota"] = [:]
        configured["usage"] = [:]
        return configured
    }
    return TeamCodexPoolHealth(
        checkedAt: checkedAt,
        serverReachable: false,
        serverPort: port,
        serverPid: serverPid,
        currentAccount: nil,
        currentAccountUuid: nil,
        switchThresholdPercent: (teamCodexDouble(object["switchThreshold"]) ?? 0.98) * 100,
        accounts: teamCodexAccounts(
            from: configuredRows,
            currentAccount: nil,
            currentAccountUuid: nil
        )
    )
}

private func teamCodexReadObject(_ path: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return nil }
    return try? teamCodexObject(from: data)
}

func teamCodexStatusRequest(port: Int, apiKey: String?) -> URLRequest? {
    guard let url = URL(string: "http://127.0.0.1:\(port)/teamclaude/status") else { return nil }
    var request = URLRequest(url: url)
    request.timeoutInterval = 2.5
    if let apiKey, !apiKey.isEmpty {
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("1", forHTTPHeaderField: "x-teamcodex-status-identity")
    }
    return request
}

final class TeamCodexStatusRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @Sendable @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

func teamCodexFetchStatus(
    port: Int,
    apiKey: String?,
    sessionConfiguration: URLSessionConfiguration = .ephemeral
) -> Data? {
    guard let request = teamCodexStatusRequest(port: port, apiKey: apiKey) else { return nil }

    let semaphore = DispatchSemaphore(value: 0)
    var result: Data?
    let statusSession = URLSession(
        configuration: sessionConfiguration,
        delegate: TeamCodexStatusRedirectDelegate(),
        delegateQueue: nil
    )
    let task = statusSession.dataTask(with: request) { data, response, _ in
        defer { semaphore.signal() }
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            return
        }
        result = data
    }
    task.resume()
    _ = semaphore.wait(timeout: .now() + 3)
    task.cancel()
    statusSession.invalidateAndCancel()
    return result
}

func loadTeamCodexPoolHealth(home: String = NSHomeDirectory()) -> TeamCodexPoolHealth {
    let configPath = "\(home)/.config/teamcodex.json"
    let serverPath = "\(home)/.config/teamcodex.server.json"
    let configData = try? Data(contentsOf: URL(fileURLWithPath: configPath))
    let config = teamCodexReadObject(configPath)
    let server = teamCodexReadObject(serverPath)
    let proxy = config?["proxy"] as? [String: Any]
    let port = teamCodexInt(server?["port"]) ?? teamCodexInt(proxy?["port"]) ?? 3457
    let serverPid = teamCodexInt(server?["pid"])

    if let data = teamCodexFetchStatus(port: port, apiKey: teamCodexString(proxy?["apiKey"])),
       let health = try? teamCodexPoolHealth(from: data, port: port, serverPid: serverPid) {
        return health
    }
    return (try? teamCodexPoolOfflineHealth(
        configData: configData,
        port: port,
        serverPid: serverPid
    )) ?? TeamCodexPoolHealth(
        checkedAt: Date(),
        serverReachable: false,
        serverPort: port,
        serverPid: serverPid,
        currentAccount: nil,
        currentAccountUuid: nil,
        switchThresholdPercent: 98,
        accounts: []
    )
}

/// 메뉴바 타이틀용 짧은 시각. 예: "9/25 14:01".
func teamCodexShortClock(_ date: Date, timeZone: TimeZone) -> String {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = timeZone
    formatter.dateFormat = "M/d HH:mm"
    return formatter.string(from: date)
}
