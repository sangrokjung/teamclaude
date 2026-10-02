import Foundation

// 힉스필드(Higgsfield AI) 크레딧. 메뉴바 드롭다운에 "언제 리셋되고 그때 얼마가 사라지는가"를 띄운다.
//
// 힉스필드 API는 재구독일을 주지 않는다. 알 수 있는 건 거래내역뿐이고, 구독 갱신은 이렇게 남는다(실측):
//   grant   +3000    "Subscription Credits"        ← 갱신 시각
//   deduct  -2395.1  "Subscription Credits Reset"  ← 직전 주기 미사용분 소멸(이월 없음)
// 그래서 갱신일도 주기도 이 이력에서 역산한다. 추정이라는 사실은 화면이 숨기지 않는다.

let higgsfieldDayInterval: TimeInterval = 24 * 60 * 60

/// 조회 주기. 크레딧은 생성할 때만 움직여서 촘촘히 볼 이유가 없지만,
/// 한 번도 다시 부르지 않으면 기동 시 실패가 영구 공백이 된다.
let higgsfieldFetchInterval: TimeInterval = 600

/// 지급 이력이 1건뿐이라 간격을 잴 수 없을 때 쓰는 가정치. 실측(8/18 → 9/17)은 30일 고정이었다.
let higgsfieldDefaultCycleDays = 30

/// 경과가 이보다 짧고 쓴 것도 없으면 "전액 소멸" 최대 경보만 남는다. 그 구간은 예측하지 않는다.
let higgsfieldMinProjectionDays: Double = 1

private let higgsfieldSubscriptionLabel = "Subscription Credits"
private let higgsfieldResetLabel = "Subscription Credits Reset"

/// 크레딧 지급·회수라 "사용"이 아닌 액션. 이 둘을 뺀 나머지는 모르는 액션이라도 집계에 넣는다
/// (조용히 버리면 사용량이 과소 계산되고 그만큼 소멸 예상이 과대해진다).
private let higgsfieldNonUsageActions: Set<String> = ["grant", "deduct"]

/// 의미를 아는 사용 액션. 이 밖의 것이 오면 화면이 그 사실을 알린다.
private let higgsfieldKnownUsageActions: Set<String> = ["spend", "refund"]

/// 표시·판정 시간대. 머신 로컬 설정에 따라 D-day가 흔들리지 않게 고정한다.
let higgsfieldDisplayTimeZone = TimeZone(identifier: "Asia/Seoul") ?? TimeZone(secondsFromGMT: 9 * 3600)!

struct HiggsfieldTransaction {
    let action: String
    let createdAt: Date
    let credits: Double
    let displayName: String
}

struct HiggsfieldCycle {
    let lastGrantAt: Date?
    let grantAmount: Double?
    let cycleDays: Int
    let assumedCycle: Bool
    let grantCount: Int
    let nextRenewalAt: Date?
    /// 남은 일수(달력 기준). 이미 지났으면 음수.
    let daysRemaining: Int?
    let elapsedRatio: Double?
    let elapsedDays: Double?
}

enum HiggsfieldProjectionGap {
    case noGrantHistory
    case tooEarly
}

struct HiggsfieldProjection {
    let perDay: Double?
    let projectedSpend: Double?
    /// 갱신 시점에 남아서 소멸할 것으로 보이는 양. **근거가 없으면 nil이며 잔액 전액으로 단정하지 않는다.**
    let projectedExpiry: Double?
    let projectedExpiryRatio: Double?
    let gap: HiggsfieldProjectionGap?
}

struct HiggsfieldCreditsData {
    let credits: Double
    let planType: String?
    let email: String?
    let transactions: [HiggsfieldTransaction]
    let checkedAt: Date
    /// 조회 실패 사유. 있으면 화면이 복구 방법을 안내한다.
    let error: String?
    /// 일부 페이지만 받은 경우의 사유.
    let partialError: String?
}

// MARK: - 날짜 (KST 고정)

private let higgsfieldDayKeyFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = higgsfieldDisplayTimeZone
    f.dateFormat = "yyyy-MM-dd"
    return f
}()

private var higgsfieldDayCalendar: Calendar = {
    var c = Calendar(identifier: .gregorian)
    c.timeZone = higgsfieldDisplayTimeZone
    return c
}()

func higgsfieldDayKey(_ date: Date) -> String {
    higgsfieldDayKeyFormatter.string(from: date)
}

/// 두 시각 사이의 달력 날짜 차이(표시 시간대 기준).
/// D-day는 시각 차이가 아니다. 시간으로 올림하면 "이틀 전에 지났다"가 D+1로, "오늘 저녁 갱신"이 D-1로 나온다.
func higgsfieldCalendarDayDiff(from: Date, to: Date) -> Int {
    let a = higgsfieldDayCalendar.startOfDay(for: from)
    let b = higgsfieldDayCalendar.startOfDay(for: to)
    return higgsfieldDayCalendar.dateComponents([.day], from: a, to: b).day ?? 0
}

// MARK: - 이벤트 추출

/// 구독 지급(=재구독이 일어난 시각). 최신순.
func higgsfieldSubscriptionGrants(_ items: [HiggsfieldTransaction]) -> [HiggsfieldTransaction] {
    items
        .filter { $0.action == "grant" && $0.displayName.contains(higgsfieldSubscriptionLabel) }
        .sorted { $0.createdAt > $1.createdAt }
}

/// 갱신 때 회수된 미사용분(소멸). 최신순.
func higgsfieldSubscriptionResets(_ items: [HiggsfieldTransaction]) -> [HiggsfieldTransaction] {
    items
        .filter { $0.action == "deduct" && $0.displayName == higgsfieldResetLabel }
        .sorted { $0.createdAt > $1.createdAt }
}

/// 정규 지급만 남긴다. 주기 중간에 들어오는 보정성 지급을 주기 시작으로 오인하면 D-day와 사용량 창이 통째로 밀린다.
///
/// 판정 기준은 **금액이 아니라 간격**이다. 금액(최빈값)으로 거르면 요금제를 바꿨을 때 새 금액이 소수파가 되어
/// 최신 갱신이 통째로 탈락한다. 임계를 관측값에서만 뽑으면 표본이 1개(지급 2건)일 때 필터가 정의상 무력해지므로,
/// 표본이 부족하면 기본 주기를 사전값으로 쓴다.
/// 간격이 임계보다 짧은 쌍에서는 금액이 큰 쪽(보정은 대개 소액)을 남기고, 동액이면 최신을 남긴다.
///
/// 알려진 한계: 보정 지급이 정규보다 크면 그것이 주기 시작이 된다. 관측된 보정은 모두 소액이라 그대로 두되,
/// 큰 보너스 지급이 생기면 이 규칙을 다시 본다.
func higgsfieldRegularGrants(_ grants: [HiggsfieldTransaction]) -> [HiggsfieldTransaction] {
    guard grants.count > 1 else { return grants }

    var gaps: [Double] = []
    for i in 0..<(grants.count - 1) {
        gaps.append(grants[i].createdAt.timeIntervalSince(grants[i + 1].createdAt) / higgsfieldDayInterval)
    }
    let widest = gaps.max() ?? Double(higgsfieldDefaultCycleDays)
    let base = gaps.count >= 2 ? min(widest, Double(higgsfieldDefaultCycleDays)) : Double(higgsfieldDefaultCycleDays)
    let thresholdDays = base / 2

    var kept: [HiggsfieldTransaction] = [grants[0]]
    for i in 1..<grants.count {
        let candidate = grants[i]
        let last = kept[kept.count - 1]
        let gapDays = last.createdAt.timeIntervalSince(candidate.createdAt) / higgsfieldDayInterval

        if gapDays >= thresholdDays {
            kept.append(candidate)
            continue
        }
        // 둘 중 하나는 보정이다. 금액이 큰 쪽을 정규로 남긴다.
        if candidate.credits > last.credits {
            kept[kept.count - 1] = candidate
        }
    }
    return kept
}

// MARK: - 주기 추정

/// 인접 지급 간격(일)의 중앙값을 주기로 본다.
/// 평균이 아니라 중앙값을 쓰는 이유: 결제 실패로 한 주기가 길어져도 값이 끌려가지 않게 하려고.
func higgsfieldEstimateCycle(_ items: [HiggsfieldTransaction], now: Date) -> HiggsfieldCycle {
    let grants = higgsfieldRegularGrants(higgsfieldSubscriptionGrants(items))

    guard let latest = grants.first else {
        return HiggsfieldCycle(
            lastGrantAt: nil, grantAmount: nil,
            cycleDays: higgsfieldDefaultCycleDays, assumedCycle: true,
            grantCount: 0, nextRenewalAt: nil, daysRemaining: nil,
            elapsedRatio: nil, elapsedDays: nil
        )
    }

    var intervals: [Int] = []
    for i in 0..<max(grants.count - 1, 0) {
        let rawDays = grants[i].createdAt.timeIntervalSince(grants[i + 1].createdAt) / higgsfieldDayInterval
        // 하루도 안 되는 간격은 주기가 아니다. 반올림 전 원시 값으로 판정한다
        // (0.5를 반올림하면 1이 되어 12시간 간격이 가드를 통과한다).
        if rawDays >= 1 { intervals.append(Int(rawDays.rounded())) }
    }

    let assumedCycle = intervals.isEmpty
    let cycleDays = assumedCycle ? higgsfieldDefaultCycleDays : higgsfieldMedian(intervals)
    let nextRenewalAt = latest.createdAt.addingTimeInterval(Double(cycleDays) * higgsfieldDayInterval)
    let elapsedDays = now.timeIntervalSince(latest.createdAt) / higgsfieldDayInterval

    return HiggsfieldCycle(
        lastGrantAt: latest.createdAt,
        grantAmount: latest.credits,
        cycleDays: cycleDays,
        assumedCycle: assumedCycle,
        grantCount: grants.count,
        nextRenewalAt: nextRenewalAt,
        daysRemaining: higgsfieldCalendarDayDiff(from: now, to: nextRenewalAt),
        elapsedRatio: higgsfieldClamp01(elapsedDays / Double(cycleDays)),
        elapsedDays: elapsedDays
    )
}

private func higgsfieldMedian(_ values: [Int]) -> Int {
    let sorted = values.sorted()
    let mid = sorted.count / 2
    if sorted.count % 2 == 1 { return sorted[mid] }
    return Int((Double(sorted[mid - 1] + sorted[mid]) / 2).rounded())
}

private func higgsfieldClamp01(_ value: Double) -> Double {
    guard value.isFinite else { return 0 }
    return min(1, max(0, value))
}

// MARK: - 사용량

/// 순사용량. 부호를 뒤집어 "쓴 양"으로 통일한다(spend -45 → +45, refund +2 → -2).
/// 구독 지급·회수만 제외하고, 모르는 액션도 부호 그대로 넣는다.
func higgsfieldNetUsage(_ items: [HiggsfieldTransaction], since: Date?) -> [HiggsfieldTransaction] {
    items
        .filter { !higgsfieldNonUsageActions.contains($0.action) }
        .filter { since == nil ? true : $0.createdAt >= since! }
        .map {
            HiggsfieldTransaction(
                action: $0.action, createdAt: $0.createdAt,
                credits: -$0.credits, displayName: $0.displayName
            )
        }
}

func higgsfieldTotalSpend(_ events: [HiggsfieldTransaction]) -> Double {
    events.reduce(0) { $0 + $1.credits }
}

/// 집계에 섞인 미지의 액션 종류. 비어 있지 않으면 화면이 신뢰도 하락을 고지한다.
func higgsfieldUnknownActions(_ events: [HiggsfieldTransaction]) -> [String] {
    Set(events.map { $0.action }).subtracting(higgsfieldKnownUsageActions).sorted()
}

/// 현 페이스가 유지된다고 볼 때 갱신 시점에 얼마가 남아 사라지는지.
/// 갱신 이력이 없으면 아무 값도 만들지 않는다. 근거 없이 "전액 소멸"이라고 말하는 쪽이 더 나쁘다.
func higgsfieldProjectExpiry(
    balance: Double,
    spent: Double,
    elapsedDays: Double?,
    cycleDays: Int,
    grantAmount: Double?
) -> HiggsfieldProjection {
    guard let elapsedDaysValue = elapsedDays else {
        return HiggsfieldProjection(perDay: nil, projectedSpend: nil, projectedExpiry: nil, projectedExpiryRatio: nil, gap: .noGrantHistory)
    }

    let elapsed = max(elapsedDaysValue, 0)
    // 주기가 막 시작됐고 쓴 것도 없으면 "전액 소멸" 경보만 남는다. 그 구간만 보류한다.
    if elapsed < higgsfieldMinProjectionDays && spent <= 0 {
        return HiggsfieldProjection(perDay: nil, projectedSpend: nil, projectedExpiry: nil, projectedExpiryRatio: nil, gap: .tooEarly)
    }

    // 경과 0.2일에 45를 썼다고 하루 225로 보면 곧 전액 소진처럼 보인다. 분모 하한은 하루.
    // 환불이 사용을 넘겨 spent가 음수여도 크레딧이 늘어난다고 보지 않는다.
    let perDay = max(spent / max(elapsed, higgsfieldMinProjectionDays), 0)
    let remainingDays = max(Double(cycleDays) - elapsed, 0)
    let projectedSpend = perDay * remainingDays
    // 소멸 예상은 잔액을 넘을 수 없다.
    let projectedExpiry = min(max(balance - projectedSpend, 0), max(balance, 0))
    let ratio: Double? = {
        guard let grant = grantAmount, grant > 0 else { return nil }
        return higgsfieldClamp01(projectedExpiry / grant)
    }()

    return HiggsfieldProjection(
        perDay: perDay, projectedSpend: projectedSpend,
        projectedExpiry: projectedExpiry, projectedExpiryRatio: ratio, gap: nil
    )
}

// MARK: - 표시 형식

/// 크레딧 문자열. 소수점은 실제로 소수인 값에만 붙인다(45 vs 2,395.1).
func higgsfieldFormatCredits(_ value: Double?) -> String {
    guard let value = value, value.isFinite else { return "-" }
    let rounded = (value * 10).rounded() / 10
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.minimumFractionDigits = rounded == rounded.rounded() ? 0 : 1
    formatter.maximumFractionDigits = 1
    return formatter.string(from: NSNumber(value: rounded)) ?? "-"
}

/// 'D-30' / 'D-DAY' / 'D+2'. 갱신이 지났는데 아직 안 들어온 경우도 말이 되게 쓴다.
func higgsfieldFormatDday(_ daysRemaining: Int?) -> String {
    guard let days = daysRemaining else { return "-" }
    if days > 0 { return "D-\(days)" }
    if days == 0 { return "D-DAY" }
    return "D+\(abs(days))"
}

private let higgsfieldDateLabelFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "ko_KR")
    f.timeZone = higgsfieldDisplayTimeZone
    f.dateFormat = "M월 d일"
    return f
}()

private let higgsfieldDateTimeLabelFormatter: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "ko_KR")
    f.timeZone = higgsfieldDisplayTimeZone
    f.dateFormat = "M월 d일 HH:mm"
    return f
}()

func higgsfieldFormatDate(_ date: Date?) -> String {
    guard let date = date else { return "-" }
    return higgsfieldDateLabelFormatter.string(from: date)
}

func higgsfieldFormatDateTime(_ date: Date?) -> String {
    guard let date = date else { return "-" }
    return higgsfieldDateTimeLabelFormatter.string(from: date)
}

// MARK: - CLI 호출

/// 힉스필드 CLI 실행 파일 후보. 메뉴바 앱은 GUI라 shell PATH를 상속하지 않는다.
func higgsfieldBinCandidates() -> [String] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return [
        "\(home)/.local/share/fnm/aliases/default/bin/higgsfield",
        "/opt/homebrew/bin/higgsfield",
        "/usr/local/bin/higgsfield",
    ]
}

/// CLI에 넘길 PATH.
/// **CLI는 `#!/usr/bin/env node` 스크립트라 PATH에 node가 있어야 한다.**
/// 표준 경로만 주면 fnm으로 설치한 node를 찾지 못해 `env: node: No such file or directory`로 죽는다.
func higgsfieldPathEnv() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(home)/.local/share/fnm/aliases/default/bin"
}

/// CLI 한 번 호출에 허용하는 시간.
private let higgsfieldTimeout: TimeInterval = 20

/// CLI 호출 결과. 실패 사유를 문자열로 그대로 올려 화면이 복구 방법을 말하게 한다.
enum HiggsfieldRunResult {
    case success(Any)
    case failure(String)
}

private func runHiggsfieldRaw(_ args: [String]) -> HiggsfieldRunResult {
    var execError: String?
    var seen = Set<String>()

    for bin in higgsfieldBinCandidates() {
        let resolved = (try? FileManager.default.destinationOfSymbolicLink(atPath: bin)) ?? bin
        if !seen.insert(resolved).inserted { continue }
        guard FileManager.default.isExecutableFile(atPath: bin) else { continue }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: bin)
        process.arguments = args
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = higgsfieldPathEnv()
        process.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        do {
            try process.run()
        } catch {
            execError = execError ?? "\(bin) 실행 실패: \(error.localizedDescription)"
            continue
        }

        // 파이프는 반드시 비운다. 폴링만 하면 출력이 파이프 버퍼를 넘는 순간 자식이 write에서 막힌다.
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        let deadline = Date().addingTimeInterval(higgsfieldTimeout)
        while process.isRunning && Date() < deadline {
            usleep(50_000)
        }
        if process.isRunning {
            // SIGTERM을 무시하는 상태가 실재한다(2026-09-23 다른 CLI에서 자식이 6시간 20분 생존).
            // 여기서 반환하면 호출부는 풀리지만 자식과 파이프를 읽던 스레드 둘이 그대로 남으므로 유예 뒤 SIGKILL까지 간다.
            let pid = process.processIdentifier
            kill(pid, SIGTERM)
            if group.wait(timeout: .now() + 3) == .timedOut, process.isRunning {
                // 이미 회수된 pid에 보내면 재사용된 남의 프로세스를 죽일 수 있다.
                kill(pid, SIGKILL)
                _ = group.wait(timeout: .now() + 2)
            }
            return .failure("힉스필드 CLI가 \(Int(higgsfieldTimeout))초 안에 응답하지 않아 중단했습니다")
        }
        process.waitUntilExit()
        _ = group.wait(timeout: .now() + 3)

        if process.terminationStatus == 0 {
            guard let json = try? JSONSerialization.jsonObject(with: outData) else {
                return .failure("higgsfield \(args.joined(separator: " ")) JSON 파싱 실패")
            }
            return .success(json)
        }

        if execError == nil {
            let stderr = String(data: errData, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            execError = stderr.isEmpty
                ? "higgsfield \(args.joined(separator: " ")) 실행 실패 (종료 코드 \(process.terminationStatus))"
                : stderr
        }
    }

    return .failure(execError ?? "higgsfield CLI를 찾지 못했습니다")
}

private let higgsfieldISOFormatters: [ISO8601DateFormatter] = {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return [withFraction, plain]
}()

func higgsfieldParseDate(_ value: String) -> Date? {
    for formatter in higgsfieldISOFormatters {
        if let date = formatter.date(from: value) { return date }
    }
    return nil
}

func higgsfieldParseTransactions(_ raw: Any?) -> [HiggsfieldTransaction] {
    guard let dict = raw as? [String: Any],
          let items = dict["items"] as? [[String: Any]] else { return [] }

    return items.compactMap { item in
        guard let action = item["action"] as? String,
              let createdAt = item["created_at"] as? String,
              let date = higgsfieldParseDate(createdAt),
              let credits = (item["credits"] as? NSNumber)?.doubleValue else { return nil }
        return HiggsfieldTransaction(
            action: action,
            createdAt: date,
            credits: credits,
            displayName: (item["display_name"] as? String) ?? ""
        )
    }
}

/// 거래내역 한 페이지에서 다음 cursor를 뽑는다. 가득 차지 않은 페이지는 마지막이다.
func higgsfieldNextCursor(_ raw: Any?, pageItemCount: Int, pageSize: Int) -> String? {
    guard pageItemCount >= pageSize, let dict = raw as? [String: Any] else { return nil }
    if let s = dict["cursor"] as? String, !s.isEmpty { return s }
    if let n = dict["cursor"] as? NSNumber { return n.stringValue }
    return nil
}

/// 계정 잔액 + 거래내역을 함께 조회한다. 구독 갱신 간격을 재려면 최소 2주기가 필요해 기본 2페이지를 받는다.
func fetchHiggsfieldCredits(pages: Int = 2) -> HiggsfieldCreditsData {
    let now = Date()
    let pageSize = 100

    let accountResult = runHiggsfieldRaw(["account", "status", "--json"])
    var credits: Double = 0
    var planType: String?
    var email: String?
    var accountError: String?

    switch accountResult {
    case .success(let raw):
        if let dict = raw as? [String: Any] {
            credits = (dict["credits"] as? NSNumber)?.doubleValue ?? 0
            planType = dict["subscription_plan_type"] as? String
            email = dict["email"] as? String
        }
    case .failure(let message):
        accountError = message
    }

    var transactions: [HiggsfieldTransaction] = []
    var cursor: String?
    var partialError: String?

    for _ in 0..<max(pages, 1) {
        var args = ["account", "transactions", "--size", "\(pageSize)", "--json"]
        if let c = cursor {
            args.append("--cursor")
            args.append(c)
        }
        switch runHiggsfieldRaw(args) {
        case .success(let raw):
            let page = higgsfieldParseTransactions(raw)
            let rawCount = ((raw as? [String: Any])?["items"] as? [[String: Any]])?.count ?? page.count
            transactions.append(contentsOf: page)
            guard let next = higgsfieldNextCursor(raw, pageItemCount: rawCount, pageSize: pageSize) else {
                cursor = nil
                break
            }
            cursor = next
        case .failure(let message):
            // 일부라도 받았으면 그것으로 그린다.
            partialError = message
            cursor = nil
        }
        if cursor == nil { break }
    }

    return HiggsfieldCreditsData(
        credits: credits,
        planType: planType,
        email: email,
        transactions: transactions,
        checkedAt: now,
        error: accountError ?? (transactions.isEmpty ? partialError : nil),
        partialError: transactions.isEmpty ? nil : partialError
    )
}

/// 인증이 필요한 실패인지. 아무 실패에나 "로그인하세요"를 붙이면 오진단이 된다.
func higgsfieldLooksLikeAuthFailure(_ message: String) -> Bool {
    let lower = message.lowercased()
    return ["unauthor", "not logged in", "login", "auth", "token", "credential", "401", "403"]
        .contains { lower.contains($0) }
}
