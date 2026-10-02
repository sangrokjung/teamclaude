import Foundation
import CryptoKit

struct AccountSubscriptionDetails {
    var plan: String?
    var startedAt: String?
    var paymentDate: String?
    var tracksCancellation = false
    var confirmation: AccountSubscriptionConfirmation?
    var monitorNote: String?
    var monitorStatus: String?
    var automaticallyConfirmed = false
}

enum AccountSubscriptionAppearance {
    case standard, endDateReached, ended

    var isMuted: Bool { self != .standard }
}

extension AccountSubscriptionDetails {
    func appearance(now: Date) -> AccountSubscriptionAppearance {
        guard let confirmation else { return .standard }
        if confirmation.state == .ended { return .ended }
        if confirmation.state == .scheduled,
           let end = confirmation.date.flatMap(accountSubscriptionDate),
           Calendar.current.startOfDay(for: end) < Calendar.current.startOfDay(for: now) {
            return .endDateReached
        }
        return .standard
    }
}

enum AccountSubscriptionState: String {
    case renewing
    case scheduled = "cancellation-scheduled"
    case ended
}

struct AccountSubscriptionConfirmation {
    let state: AccountSubscriptionState
    let date: String?
    let checkedAt: Date
    let source: String
}

func accountSubscriptionConfirmation(_ raw: [String: Any]?, now: Date) -> AccountSubscriptionConfirmation? {
    guard let raw,
          let state = (raw["state"] as? String).flatMap(AccountSubscriptionState.init(rawValue:)),
          let checkedAt = raw["checkedAt"] as? Date, checkedAt <= now,
          let source = raw["source"] as? String,
          ["billing-page", "confirmation-email", "user-confirmed"].contains(source) else { return nil }
    let date = raw["date"] as? String
    if let date, accountSubscriptionDate(date) == nil { return nil }
    return AccountSubscriptionConfirmation(state: state, date: date, checkedAt: checkedAt, source: source)
}

func accountSubscriptionPlan(_ raw: String?) -> String? {
    guard let raw else { return nil }
    switch raw.lowercased() {
    case "free": return "Free"
    case "pro": return "Pro"
    case "plus": return "Plus"
    case "team": return "Team"
    case "business": return "Business"
    case "enterprise": return "Enterprise"
    case "max", "claude_max": return "Max"
    case "default_claude_max_5x", "max_5x": return "Max 5×"
    case "default_claude_max_20x", "max_20x": return "Max 20×"
    case "default_claude_pro", "claude_pro": return "Pro"
    default: return nil
    }
}

func accountSubscriptionDate(_ value: String) -> Date? {
    guard value.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$", options: .regularExpression) != nil else { return nil }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.calendar = Calendar(identifier: .gregorian)
    formatter.dateFormat = "yyyy-MM-dd"
    formatter.isLenient = false
    guard let date = formatter.date(from: value), formatter.string(from: date) == value else { return nil }
    return date
}

func accountSubscriptionLabel(_ details: AccountSubscriptionDetails, now: Date = Date()) -> String {
    let value = accountSubscriptionBaseLabel(details, now: now)
    guard let status = details.monitorStatus else { return value }
    return status + " · " + value
}

private func accountSubscriptionBaseLabel(_ details: AccountSubscriptionDetails, now: Date) -> String {
    let plan = details.plan ?? "구독 미확인"
    if details.tracksCancellation {
        guard let confirmed = details.confirmation else {
            let payment = details.paymentDate.flatMap { accountSubscriptionDate($0) == nil ? nil : $0 }
            let past = payment.flatMap(accountSubscriptionDate).map {
                Calendar.current.startOfDay(for: $0) < Calendar.current.startOfDay(for: now)
            } ?? false
            let label = past ? "입력 결제일 지남 " : "입력 결제일 "
            return "\(plan) · 해지 미확인 · \(payment.map { label + $0 } ?? "결제일 미확인") · 만료일 미확인"
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "ko_KR")
        formatter.dateFormat = "MM/dd HH:mm"
        let checked = "\(formatter.string(from: confirmed.checkedAt)) \(details.automaticallyConfirmed ? "메일확인" : "확인")"
        let stale = now.timeIntervalSince(confirmed.checkedAt) >= 24 * 3600
        let date = confirmed.date ?? "미확인"
        switch confirmed.state {
        case .renewing:
            let past = confirmed.date.flatMap(accountSubscriptionDate).map {
                Calendar.current.startOfDay(for: $0) < Calendar.current.startOfDay(for: now)
            } ?? false
            let label = past ? "갱신 재확인 · 지난 결제일"
                : (stale ? "갱신 재확인 · 기록 결제일" : "자동갱신 확인 · 다음 결제")
            return "\(plan) · \(label) \(date) · 만료일 미확인 · \(checked)"
        case .scheduled:
            let past = confirmed.date.flatMap(accountSubscriptionDate).map {
                Calendar.current.startOfDay(for: $0) < Calendar.current.startOfDay(for: now)
            } ?? false
            let label = past ? "종료일 경과 · 확인 필요" : (stale ? "해지 재확인 · 예정 종료" : "해지 예약 · 이용 종료")
            return "\(plan) · \(label) \(date)\(confirmed.date == nil ? " · 만료일 미확인" : "") · \(checked)"
        case .ended:
            return "\(plan) · \(stale ? "종료 재확인" : "구독 종료 확인") · 만료일 \(date) · \(checked)"
        }
    }
    guard let raw = details.paymentDate, let date = accountSubscriptionDate(raw) else {
        return "\(plan) · 결제일 미확인 · 입력"
    }
    let past = Calendar.current.startOfDay(for: date) < Calendar.current.startOfDay(for: now)
    return "\(plan) · \(past ? "결제일 지남" : "다음 결제") \(raw) (입력)"
}

func accountSubscriptionProfile(_ payload: [String: Any], expectedUuid: String) -> AccountSubscriptionDetails? {
    guard let account = payload["account"] as? [String: Any],
          account["uuid"] as? String == expectedUuid,
          let organization = payload["organization"] as? [String: Any] else { return nil }
    let plan = accountSubscriptionPlan(organization["rate_limit_tier"] as? String)
        ?? accountSubscriptionPlan(organization["organization_type"] as? String)
        ?? ((account["has_claude_max"] as? Bool) == true ? "Max" : nil)
        ?? ((account["has_claude_pro"] as? Bool) == true ? "Pro" : nil)
    let rawStart = organization["subscription_created_at"] as? String
    let start = rawStart.map { String($0.prefix(10)) }
    return AccountSubscriptionDetails(
        plan: plan,
        startedAt: start.flatMap { accountSubscriptionDate($0) == nil ? nil : $0 },
        paymentDate: nil
    )
}

func accountSubscriptionConfiguredAccount(provider: String, uuid: String?, name: String, rows: [[String: Any]]) -> [String: Any]? {
    let matches = rows.filter { row in
        if let configuredProvider = row["provider"] {
            guard let configuredProvider = configuredProvider as? String,
                  configuredProvider == provider else { return false }
        }
        if let uuid, !uuid.isEmpty {
            return (row["accountUuid"] as? String ?? row["accountId"] as? String) == uuid
        }
        return row["name"] as? String == name
    }
    return matches.count == 1 ? matches[0] : nil
}

/// JSON 파일을 mtime·크기가 그대로면 다시 읽지 않는다.
///
/// 구독 판정은 계정마다 불리고, 표는 메뉴가 열려 있는 동안 1초마다 갱신된다. 캐시가 없으면
/// 계정 17개 화면에서 파일 읽기·JSON 파싱·SHA256이 초당 열일곱 번씩 메인 스레드에서 돈다
/// (2026-09-24 적대 리뷰 지적). 두 파일 모두 외부 프로세스가 가끔 쓰므로 mtime 확인으로 충분하다.
/// 구독 단가 설정(SubscriptionRates.swift)도 같은 캐시를 탄다. 같은 mtime 캐시를 또 만들면
/// 같은 버그를 두 벌 관리하게 되므로 접근 수준만 연다.
final class AccountSubscriptionFileCache {
    static let shared = AccountSubscriptionFileCache()
    private let lock = NSLock()
    private var entries: [String: (stamp: Date, size: Int, json: [String: Any])] = [:]

    func json(at url: URL, maxBytes: Int = 4_194_304) -> [String: Any]? {
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        guard let stamp = attributes?[.modificationDate] as? Date,
              let size = (attributes?[.size] as? NSNumber)?.intValue,
              size <= maxBytes else {
            return nil
        }

        lock.lock()
        if let cached = entries[url.path], cached.stamp == stamp, cached.size == size {
            lock.unlock()
            return cached.json
        }
        lock.unlock()

        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        lock.lock()
        entries[url.path] = (stamp, size, json)
        lock.unlock()
        return json
    }
}

func accountSubscriptionLocalAccount(provider: String, uuid: String?, name: String) -> (uuid: String?, plan: String?) {
    guard ["anthropic", "codex"].contains(provider) else { return (nil, nil) }
    let filename = provider == "codex" ? "teamcodex.json" : "teamclaude.json"
    let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/\(filename)")
    let rows = AccountSubscriptionFileCache.shared.json(at: url)?["accounts"] as? [[String: Any]] ?? []
    guard !rows.isEmpty,
          let row = accountSubscriptionConfiguredAccount(provider: provider, uuid: uuid, name: name, rows: rows) else {
        return (uuid, nil)
    }
    return (row["accountUuid"] as? String ?? row["accountId"] as? String, row["planType"] as? String)
}

final class AccountSubscriptionStore {
    static let shared = AccountSubscriptionStore()
    private let defaults: UserDefaults
    private let configURL: URL
    private let monitorURL: URL
    private let clock: () -> Date
    private let sessionConfiguration: URLSessionConfiguration
    private let redirectDelegate = AccountSubscriptionRedirectDelegate()
    private var pending: [String: [() -> Void]] = [:]
    private lazy var session: URLSession = {
        let config = sessionConfiguration
        config.timeoutIntervalForRequest = 10
        config.timeoutIntervalForResource = 12
        config.httpMaximumConnectionsPerHost = 2
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: redirectDelegate, delegateQueue: nil)
    }()

    init(defaults: UserDefaults = .standard,
         configURL: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/teamclaude.json"),
         monitorURL: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/state/cc-menubar/subscription-monitor.json"),
         sessionConfiguration: URLSessionConfiguration = .ephemeral,
         clock: @escaping () -> Date = Date.init) {
        self.defaults = defaults
        self.configURL = configURL
        self.monitorURL = monitorURL
        self.sessionConfiguration = sessionConfiguration
        self.clock = clock
    }

    private func key(provider: String, uuid: String) -> String {
        "cc.account-subscription.v1.\(provider).\(uuid)"
    }

    func details(provider: String, uuid: String?, fallbackPlan: String? = nil, fallbackConfirmation: AccountSubscriptionConfirmation? = nil) -> AccountSubscriptionDetails {
        guard let uuid, !uuid.isEmpty else {
            return AccountSubscriptionDetails(plan: accountSubscriptionPlan(fallbackPlan), tracksCancellation: provider == "anthropic", confirmation: fallbackConfirmation)
        }
        let data = defaults.dictionary(forKey: key(provider: provider, uuid: uuid)) ?? [:]
        let plan = provider == "anthropic"
            ? (data["plan"] as? String ?? accountSubscriptionPlan(fallbackPlan))
            : (accountSubscriptionPlan(fallbackPlan) ?? data["plan"] as? String)
        var details = AccountSubscriptionDetails(
            plan: plan,
            startedAt: data["startedAt"] as? String,
            paymentDate: data["paymentDate"] as? String,
            tracksCancellation: provider == "anthropic",
            confirmation: accountSubscriptionConfirmation(data["confirmation"] as? [String: Any], now: clock())
        )
        guard provider == "anthropic" else { return details }
        if let fallbackConfirmation, fallbackConfirmation.checkedAt <= clock(),
           details.confirmation.map({ fallbackConfirmation.checkedAt > $0.checkedAt }) ?? true {
            details.confirmation = fallbackConfirmation
        }
        return accountSubscriptionMonitored(details, uuid: uuid, url: monitorURL, now: clock(),
            dismissedBefore: data["emailEventsDismissedBefore"] as? Date)
    }

    func saveConfirmation(_ state: AccountSubscriptionState?, date: String?, provider: String, uuid: String,
                          source: String = "user-confirmed") -> Bool {
        guard provider == "anthropic", !uuid.isEmpty,
              ["billing-page", "confirmation-email", "user-confirmed"].contains(source) else { return false }
        if let date, accountSubscriptionDate(date) == nil { return false }
        let key = key(provider: provider, uuid: uuid)
        var data = defaults.dictionary(forKey: key) ?? [:]
        if let state {
            var record: [String: Any] = ["state": state.rawValue, "checkedAt": clock(), "source": source]
            record["date"] = date
            data["confirmation"] = record
        } else {
            data.removeValue(forKey: "confirmation")
            data["emailEventsDismissedBefore"] = clock()
        }
        defaults.set(data, forKey: key)
        return true
    }

    func savePaymentDate(_ value: String?, provider: String, uuid: String) -> Bool {
        guard !uuid.isEmpty else { return false }
        if let value, accountSubscriptionDate(value) == nil { return false }
        let key = key(provider: provider, uuid: uuid)
        var data = defaults.dictionary(forKey: key) ?? [:]
        data["paymentDate"] = value
        defaults.set(data, forKey: key)
        return true
    }

    func refreshProfile(provider: String, uuid: String?, completion: @escaping () -> Void) {
        precondition(Thread.isMainThread)
        guard provider == "anthropic", let uuid, !uuid.isEmpty else { return }
        let key = key(provider: provider, uuid: uuid)
        if pending[key] != nil {
            pending[key]?.append(completion)
            return
        }
        let saved = defaults.dictionary(forKey: key) ?? [:]
        let checkedAt = saved["checkedAt"] as? Date ?? .distantPast
        let now = clock()
        guard now.timeIntervalSince(checkedAt) > 6 * 3600,
              now.timeIntervalSince(saved["attemptedAt"] as? Date ?? .distantPast) > 300 else { return }
        var attempted = saved
        attempted["attemptedAt"] = now
        defaults.set(attempted, forKey: key)
        guard let data = try? Data(contentsOf: configURL),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accounts = config["accounts"] as? [[String: Any]],
              let account = accountSubscriptionConfiguredAccount(provider: "anthropic", uuid: uuid, name: "", rows: accounts),
              account["type"] as? String == "oauth",
              account["authRevoked"] as? Bool != true,
              let bearer = account["accessToken"] as? String, !bearer.isEmpty,
              let url = URL(string: "https://api.anthropic.com/api/oauth/profile") else { return }
        pending[key] = [completion]
        var request = URLRequest(url: url)
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: request) { [weak self] data, response, _ in
            let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let details = (response as? HTTPURLResponse)?.statusCode == 200
                ? payload.flatMap { accountSubscriptionProfile($0, expectedUuid: uuid) } : nil
            DispatchQueue.main.async {
                guard let self else { return }
                let callbacks = self.pending.removeValue(forKey: key) ?? []
                if let details {
                    var saved = self.defaults.dictionary(forKey: key) ?? [:]
                    saved["plan"] = details.plan
                    saved["startedAt"] = details.startedAt
                    saved["checkedAt"] = self.clock()
                    self.defaults.set(saved, forKey: key)
                }
                callbacks.forEach { $0() }
            }
        }.resume()
    }

}

final class AccountSubscriptionRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

// 메일 수집기는 별도 캐시만 쓴다. UI의 수동 기록은 변경하지 않는다.
func accountSubscriptionMonitored(_ saved: AccountSubscriptionDetails, uuid: String, url: URL, now: Date,
                                  dismissedBefore: Date? = nil) -> AccountSubscriptionDetails {
    var result = saved
    guard let root = AccountSubscriptionFileCache.shared.json(at: url, maxBytes: 1_048_576),
          root["version"] as? Int == 1,
          let rows = root["accounts"] as? [String: Any] else { return result }
    let key = SHA256.hash(data: Data(("anthropic:" + uuid).utf8)).map { String(format: "%02x", $0) }.joined()
    guard let row = rows[key] as? [String: Any], let status = row["status"] as? String,
          ["ok", "error", "busy", "login-required", "unsupported"].contains(status) else { return result }
    let parser = ISO8601DateFormatter()
    func date(_ value: Any?) -> Date? {
        guard let text = value as? String else { return nil }
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = parser.date(from: text)
        parser.formatOptions = [.withInternetDateTime]
        guard let date = parsed ?? parser.date(from: text), date <= now else { return nil }
        return date
    }
    guard let attempted = date(root["checkedAt"]) else { return result }
    let statusText: String
    if now.timeIntervalSince(attempted) > 7 * 3600 { statusText = "자동조회 지연" }
    else {
        switch status {
        case "ok": statusText = "메일 자동조회 완료"
        case "busy": statusText = "메일 사용 중 · 다음 회차 재시도"
        case "login-required": statusText = "메일 로그인 필요"
        case "unsupported": statusText = "이 메일 서비스는 자동 조회를 지원하지 않습니다"
        default: statusText = "메일 자동조회 실패 · 마지막 확인 유지"
        }
    }
    if now.timeIntervalSince(attempted) > 7 * 3600 { result.monitorStatus = "조회 지연" }
    else if status != "ok" {
        result.monitorStatus = status == "unsupported" ? "자동조회 미지원" : (status == "login-required" ? "로그인 필요" : (status == "busy" ? "조회 대기" : "조회 실패"))
    } else { result.monitorStatus = "메일조회" }
    result.monitorNote = statusText + " (6시간마다 확인)."
    guard let checked = date(row["lastSuccessAt"]) else { return result }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "ko_KR")
    formatter.dateFormat = "MM/dd HH:mm"
    result.monitorNote = (result.monitorNote ?? "") + " 마지막 성공 " + formatter.string(from: checked)
    guard checked <= attempted, let event = row["event"] as? [String: Any],
          let eventAt = date(event["eventAt"]), eventAt <= checked,
          let kind = event["kind"] as? String, ["cancel", "join"].contains(kind) else { return result }
    if let dismissedBefore, dismissedBefore <= now, eventAt <= dismissedBefore { return result }
    let end = event["endsOn"] as? String
    if kind == "cancel", end.flatMap(accountSubscriptionDate) == nil { return result }
    if let previous = saved.confirmation {
        let sameEmail = previous.source == "confirmation-email" && kind == "cancel"
            && previous.state == .scheduled && previous.date == end
        guard (sameEmail && checked > previous.checkedAt) || eventAt > previous.checkedAt else { return result }
    }
    if kind == "join" {
        result.confirmation = nil
        result.paymentDate = nil
        result.monitorNote = (result.monitorNote ?? "") + ". 과거 해지 이후 재가입 확인 · 현재 갱신 여부는 미확인"
    } else {
        result.confirmation = AccountSubscriptionConfirmation(state: .scheduled, date: end, checkedAt: checked, source: "confirmation-email")
        result.automaticallyConfirmed = true
        if status == "ok" && now.timeIntervalSince(attempted) <= 7 * 3600 { result.monitorStatus = "자동확인" }
    }
    return result
}
