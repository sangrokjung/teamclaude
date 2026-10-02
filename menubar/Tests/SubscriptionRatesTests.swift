// menubar/Tests/SubscriptionRatesTests.swift
import Foundation

@main
struct SubscriptionRatesTests {
    static func main() {
        func parse(_ raw: String) -> [String: LaneRate] {
            let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8))
            return subscriptionRateParse(object as? [String: Any])
        }

        let ok = parse(#"{"version":1,"lanes":{"claude":{"plan":"Max 20x","monthly":280000}}}"#)
        precondition(ok["claude"]?.monthly == 280_000)
        precondition(ok["claude"]?.plan == "Max 20x")

        // 파일이 없거나 버전이 다르면 빈 표다. 금액을 추정하지 않는다.
        precondition(subscriptionRateParse(nil).isEmpty)
        precondition(parse(#"{"version":2,"lanes":{"claude":{"monthly":1}}}"#).isEmpty)

        // 비정상 값은 미입력으로 본다.
        let bad = parse("""
        {"version":1,"lanes":{
          "a":{"monthly":-5},
          "b":{"monthly":"많이"},
          "c":{"monthly":0},
          "d":{"plan":"Pro"},
          "e":{"monthly":true}
        }}
        """)
        // true가 1원으로 읽히면 합계가 조용히 틀린다(적대 리뷰 2026-09-24).
        for lane in ["a", "b", "c", "d", "e"] {
            precondition(bad[lane]?.monthly == nil, "\(lane)은 미입력이어야 한다")
        }
        precondition(bad["d"]?.plan == "Pro", "금액이 없어도 요금제 이름은 남긴다")

        // 합계는 단가 × 지불 계정 수다.
        let rates = parse(#"{"version":1,"lanes":{"claude":{"monthly":100},"agy":{"monthly":50}}}"#)
        precondition(subscriptionMonthlyTotal(rates: rates,
                                              paidAccounts: ["claude": 17, "agy": 1]) == 1_750)

        // 단가가 하나도 없으면 합계가 없다. 0원이라고 말하지 않는다.
        precondition(subscriptionMonthlyTotal(rates: [:], paidAccounts: ["claude": 17]) == nil)

        // 일부만 입력돼 있으면 입력된 것만 더하고, 합계는 낸다.
        let partial = parse(#"{"version":1,"lanes":{"claude":{"monthly":100}}}"#)
        precondition(subscriptionMonthlyTotal(rates: partial,
                                              paidAccounts: ["claude": 2, "agy": 1]) == 200)

        // 통화 기호. 모르는 코드는 지어내지 않고 코드를 그대로 붙인다.
        precondition(subscriptionCurrencySymbol(["currency": "USD"]) == "$")
        precondition(subscriptionCurrencySymbol(["currency": "krw"]) == "₩")
        precondition(subscriptionCurrencySymbol(["currency": "CHF"]) == "CHF ")
        precondition(subscriptionCurrencySymbol(nil) == "")

        print("SubscriptionRatesTests: 통과")
    }
}
