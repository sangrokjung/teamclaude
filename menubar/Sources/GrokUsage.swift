import Foundation

// Grok CLI 계정 사용량. 상단 상태바 제목 앞에 고정한다.
// 세션 컨텍스트 창 비율이나 `grok usage` 비용은 플랜 사용량이 아니므로 쓰지 않는다.
// 출처는 CLI와 같은 청구 API다: GET /v1/billing?format=credits

let grokBillingURL = URL(string: "https://cli-chat-proxy.grok.com/v1/billing?format=credits")!
let grokBillingTokenHeader = "xai-grok-cli"
let grokUsageFetchInterval: TimeInterval = 60

enum GrokCredential: Equatable {
    case usable(token: String)
    /// 자격은 있는데 기한이 지났다. grok을 한 번 부르면 갱신된다(재로그인 아님).
    case expired
    case login
}

struct GrokPercentOutcome: Equatable {
    var slot: String
    var productPercent: Double?
    var creditPercent: Double?
}

struct GrokCardModel: Equatable {
    var headline: String
    var detail: String?
}

enum GrokMenuOutcome: Equatable {
    case percent(GrokPercentOutcome)
    case expired
    case login
    case unavailable
}

struct GrokBillingParts: Equatable {
    var productPercent: Double?
    var creditPercent: Double?
    var headline: Double
}

func grokAuthFileURL() -> URL {
    if let override = ProcessInfo.processInfo.environment["CC_MENUBAR_GROK_AUTH"], !override.isEmpty {
        return URL(fileURLWithPath: override)
    }
    return URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".grok/auth.json")
}

func grokCredential(from data: Data, now: Date) -> GrokCredential {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return .login
    }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]

    var candidates: [(token: String, expires: Date?)] = []
    for value in root.values {
        guard let row = value as? [String: Any],
              let token = row["key"] as? String,
              !token.isEmpty else {
            continue
        }
        if let raw = row["expires_at"] as? String {
            guard let expires = fractional.date(from: raw) ?? plain.date(from: raw) else {
                continue
            }
            candidates.append((token, expires))
        } else if row["expires_at"] == nil {
            candidates.append((token, nil))
        }
    }

    if let usable = candidates.first(where: { $0.expires == nil || ($0.expires ?? .distantPast) > now }) {
        return .usable(token: usable.token)
    }
    // 후보가 있었는데 전부 기한이 지난 경우와, 애초에 자격이 없는 경우는 할 일이 다르다.
    // 전자를 "로그인"이라고 쓰면 필요 없는 재로그인을 하게 된다(2026-09-24: 만료된 토큰이
    // 계속 "Grok 로그인"으로 표시돼 원인을 찾는 데 시간이 들었다).
    return candidates.isEmpty ? .login : .expired
}

func grokFinitePercent(_ value: Any?) -> Double? {
    let percent: Double?
    if let number = value as? Double {
        percent = number
    } else if let number = value as? Int {
        percent = Double(number)
    } else if let number = value as? NSNumber {
        percent = number.doubleValue
    } else {
        percent = nil
    }
    guard let percent, percent.isFinite, percent >= 0, percent <= 100 else { return nil }
    return percent
}

/// 청구 JSON에서 GrokBuild 사용률을 고른다. 없으면 계정 전체 creditUsagePercent.
/// 필드가 없거나 범위 밖이면 nil이다. 0은 실제로 0%인 경우만 반환한다.
func grokBillingParts(fromBilling data: Data) -> GrokBillingParts? {
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let config = (root["config"] as? [String: Any]) ?? root
    var product: Double?
    if let products = config["productUsage"] as? [Any] {
        for item in products {
            guard let row = item as? [String: Any],
                  (row["product"] as? String) == "GrokBuild",
                  let percent = grokFinitePercent(row["usagePercent"]) else {
                continue
            }
            product = percent
            break
        }
    }
    let credit = grokFinitePercent(config["creditUsagePercent"])
    guard let headline = product ?? credit else { return nil }
    return GrokBillingParts(productPercent: product, creditPercent: credit, headline: headline)
}

func grokUsagePercent(fromBilling data: Data) -> Double? {
    grokBillingParts(fromBilling: data)?.headline
}

func grokPlainPercent(_ value: Double) -> String? {
    guard let slot = grokPercentSlot(value) else { return nil }
    return String(slot.dropFirst("Grok ".count))
}

func grokCardDetail(product: Double?, credit: Double?) -> String? {
    var parts: [String] = []
    if let product, let label = grokPlainPercent(product) {
        parts.append("GrokBuild \(label)")
    }
    if let credit, let label = grokPlainPercent(credit),
       product == nil || abs((product ?? 0) - credit) >= 0.05 {
        parts.append("크레딧 \(label)")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}

func grokPercentSlot(_ value: Double) -> String? {
    guard let percent = grokFinitePercent(value) else { return nil }
    let tenth = (percent * 10).rounded() / 10
    if abs(tenth - tenth.rounded()) < 0.001 {
        return "Grok \(Int(tenth.rounded()))%"
    }
    let formatted = String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), tenth)
    return "Grok \(formatted)%"
}

func grokFetchBilling(token: String, session: URLSession = URLSession(configuration: .ephemeral), completion: @escaping (Data?) -> Void) {
    var request = URLRequest(url: grokBillingURL)
    request.timeoutInterval = 8
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue(grokBillingTokenHeader, forHTTPHeaderField: "X-XAI-Token-Auth")

    let task = session.dataTask(with: request) { data, response, _ in
        defer { session.finishTasksAndInvalidate() }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            completion(nil)
            return
        }
        completion(data)
    }
    task.resume()
}

func fetchGrokMenuOutcome(now: Date = Date(), authURL: URL = grokAuthFileURL(), completion: @escaping (GrokMenuOutcome) -> Void) {
    guard let data = try? Data(contentsOf: authURL) else {
        completion(.login)
        return
    }
    switch grokCredential(from: data, now: now) {
    case .login:
        completion(.login)
    case .expired:
        completion(.expired)
    case .usable(let token):
        grokFetchBilling(token: token) { billing in
            guard let billing,
                  let parts = grokBillingParts(fromBilling: billing),
                  let slot = grokPercentSlot(parts.headline) else {
                completion(.unavailable)
                return
            }
            completion(.percent(GrokPercentOutcome(
                slot: slot,
                productPercent: parts.productPercent,
                creditPercent: parts.creditPercent
            )))
        }
    }
}
