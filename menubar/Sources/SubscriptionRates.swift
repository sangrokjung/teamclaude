import Foundation

// 단가는 사람이 적는다. 결제 시스템을 연동하지 않는다.
// 값이 없으면 "미입력"이고, 어떤 경우에도 금액을 추정하지 않는다.
// 지어낸 금액으로 구독을 해지하는 판단을 하게 만들 수는 없다.

struct LaneRate: Equatable {
    let plan: String?
    /// 계정 1개당 월 금액. 없거나 비정상이면 nil이다.
    let monthly: Int?
}

var subscriptionRatesURL: URL {
    URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent(".config/cc-menubar-subscriptions.json")
}

func subscriptionRateParse(_ json: [String: Any]?) -> [String: LaneRate] {
    guard let json, (json["version"] as? Int) == 1,
          let lanes = json["lanes"] as? [String: Any] else {
        return [:]
    }
    var out: [String: LaneRate] = [:]
    for (lane, raw) in lanes {
        guard let row = raw as? [String: Any] else { continue }
        // 0과 음수는 "적지 않았다"로 본다. 숫자가 아닌 값도 마찬가지다.
        // Bool도 NSNumber로 들어와 true가 1원이 되므로 따로 막는다(적대 리뷰 2026-09-24).
        let number = row["monthly"] as? NSNumber
        let isBool = number.map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false
        let monthly = isBool ? nil : number?.intValue
        out[lane] = LaneRate(plan: row["plan"] as? String,
                             monthly: (monthly ?? 0) > 0 ? monthly : nil)
    }
    return out
}

func subscriptionRates() -> [String: LaneRate] {
    subscriptionRateParse(AccountSubscriptionFileCache.shared.json(at: subscriptionRatesURL))
}

/// 통화 기호. "3,400"만 그리면 원인지 달러인지 알 수 없어 지출 판단이 흔들린다.
/// 모르는 통화 코드는 코드를 그대로 붙인다 — 지어내지 않는다.
func subscriptionCurrencySymbol(_ json: [String: Any]?) -> String {
    switch (json?["currency"] as? String)?.uppercased() {
    case "USD": return "$"
    case "KRW": return "₩"
    case "EUR": return "€"
    case "JPY": return "¥"
    case let code?: return code + " "
    case nil: return ""
    }
}

func subscriptionCurrency() -> String {
    subscriptionCurrencySymbol(AccountSubscriptionFileCache.shared.json(at: subscriptionRatesURL))
}

/// 합계 = 레인별 단가 × 지불 계정 수. 단가가 하나도 없으면 합계도 없다(0원이 아니다).
func subscriptionMonthlyTotal(rates: [String: LaneRate], paidAccounts: [String: Int]) -> Int? {
    var total = 0
    var counted = false
    for (lane, rate) in rates {
        guard let monthly = rate.monthly else { continue }
        total += monthly * max(paidAccounts[lane] ?? 0, 0)
        counted = true
    }
    return counted ? total : nil
}
