// menubar/Tests/TeamClaudeApiCreditTests.swift
// 프록시 상태 응답의 API 키 credit 블록(spec B9) 해석과 표시 문구(B10)를 고정한다.
import Foundation

@main
struct TeamClaudeApiCreditTests {
    static func main() {
        let expiresMs = 1_798_729_199_999.0 // 2026-12-31 23:59:59.999 KST 근처(날짜 문자열은 로컬 기준으로 다시 계산)
        let raw: [String: Any] = [
            "usd": 50, "spentUsd": 37.7, "remainingUsd": 12.3, "since": 1000,
            "expiresAt": expiresMs, "exhausted": false, "exhaustedReason": NSNull(), "unpricedTokens": 1234,
        ]
        guard let credit = teamClaudeApiCredit(raw) else { preconditionFailure("credit 블록 해석 실패") }
        precondition(credit.usd == 50)
        precondition(abs(credit.spentUsd - 37.7) < 1e-9)
        precondition(credit.exhausted == false)
        precondition(credit.exhaustedReason == nil)
        precondition(credit.unpricedTokens == 1234)
        precondition(credit.since == Date(timeIntervalSince1970: 1))
        precondition(abs((credit.remainingFraction ?? -1) - 0.246) < 1e-9)

        // 없음·null·모양 틀림은 nil(구버전 프록시, 구독 계정).
        precondition(teamClaudeApiCredit(nil) == nil)
        precondition(teamClaudeApiCredit(NSNull()) == nil)
        precondition(teamClaudeApiCredit("x") == nil)

        // 숫자 아닌 값·불은 무시한다. 지출이 충전을 넘으면 남은 비율은 0.
        let odd = teamClaudeApiCredit(["usd": true, "spentUsd": "3", "exhausted": 1, "unpricedTokens": -5])!
        precondition(odd.usd == nil && odd.spentUsd == 0 && odd.exhausted == false && odd.unpricedTokens == 0)
        // Int 범위를 벗어난 유한값도 앱을 멈추지 않는다(검토 지적 M2): 위로는 상한, 음수는 0.
        precondition(teamClaudeApiCredit(["unpricedTokens": 1e20])!.unpricedTokens == 1_000_000_000_000_000)
        precondition(teamClaudeApiCredit(["unpricedTokens": -1e20])!.unpricedTokens == 0)
        let over = teamClaudeApiCredit(["usd": 10, "spentUsd": 15])!
        precondition(over.remainingFraction == 0)
        precondition(over.remainingShownUsd == 0)
        precondition(teamClaudeApiCredit(["spentUsd": 1])!.remainingFraction == nil)

        let exhausted = teamClaudeApiCredit(["usd": 50, "spentUsd": 1, "exhausted": true, "exhaustedReason": "spend-limit"])!
        precondition(exhausted.exhausted && exhausted.exhaustedReason == "spend-limit")

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let expiryDate = formatter.string(from: Date(timeIntervalSince1970: expiresMs / 1000))
        let beforeExpiry = Date(timeIntervalSince1970: expiresMs / 1000 - 86_400)
        let afterExpiry = Date(timeIntervalSince1970: expiresMs / 1000 + 86_400)

        L10n.language = .ko
        precondition(teamClaudeApiCreditAmountText(credit) == "약 $12.30 남음 · $50.00 중 (추정)", teamClaudeApiCreditAmountText(credit))
        precondition(teamClaudeApiCreditAmountText(teamClaudeApiCredit(["spentUsd": 1.5])!) == "충전 금액 미입력 · 약 $1.50 사용 (추정)")
        precondition(teamClaudeApiCreditExpiryText(credit, now: beforeExpiry) == "만료 \(expiryDate)")
        precondition(teamClaudeApiCreditExpiryText(credit, now: afterExpiry) == "만료됨 \(expiryDate)")
        precondition(teamClaudeApiCreditExpiryText(over, now: beforeExpiry) == nil)
        precondition(teamClaudeApiCreditReason(credit, now: beforeExpiry)
                     == "약 $12.30 남음 · $50.00 중 (추정) · 만료 \(expiryDate) · 단가 없는 토큰 1,234")
        precondition(teamClaudeApiCreditReason(exhausted, now: beforeExpiry) == "크레딧 소진 · 충전 후 api-credit으로 다시 켜기")
        // 소진 차단을 설정에 쓰지 못했으면(재시작하면 풀림) 사유 줄이 그렇게 말한다.
        let unsaved = teamClaudeApiCredit(["usd": 50, "spentUsd": 1, "exhausted": true, "exhaustedReason": "billing", "persistFailed": true])!
        precondition(unsaved.persistFailed && !exhausted.persistFailed)
        precondition(teamClaudeApiCreditReason(unsaved, now: beforeExpiry) == "크레딧 소진 · 충전 후 api-credit으로 다시 켜기 · 설정 저장 실패(재시작하면 풀림)",
                     teamClaudeApiCreditReason(unsaved, now: beforeExpiry))
        precondition(L10n.reasonApiRateLimited == "분당 한도 대기 · 잠시 뒤 다시 사용")
        precondition(teamClaudeApiCreditBarValue(credit) == "$12.30")
        precondition(teamClaudeApiCreditBarValue(teamClaudeApiCredit(["spentUsd": 1])!) == "-")
        precondition(L10n.groupApiCredit == "API 크레딧")
        precondition(L10n.stateCreditExhausted == "크레딧 소진")
        precondition(L10n.stateApiStandby == "대기 · 구독 소진 시")
        precondition(L10n.legendApiCredit(1, 2) == "API 크레딧 1/2")
        precondition(teamAccountErrorReasonLabel("credit-exhausted") == "크레딧 소진")

        L10n.language = .en
        precondition(teamClaudeApiCreditAmountText(credit) == "~$12.30 left of $50.00 (est.)")
        precondition(teamClaudeApiCreditAmountText(teamClaudeApiCredit(["spentUsd": 1.5])!) == "No top-up recorded · ~$1.50 spent (est.)")
        precondition(teamClaudeApiCreditExpiryText(credit, now: beforeExpiry) == "Expires \(expiryDate)")
        precondition(teamClaudeApiCreditExpiryText(credit, now: afterExpiry) == "Expired \(expiryDate)")
        precondition(teamClaudeApiCreditReason(exhausted, now: beforeExpiry) == "Credit exhausted · top up, then re-arm with api-credit")
        precondition(teamClaudeApiCreditReason(unsaved, now: beforeExpiry).hasSuffix(" · Not saved to config (lost on restart)"))
        precondition(L10n.reasonApiRateLimited == "Rate limit · usable again shortly")
        precondition(L10n.groupApiCredit == "API credit")
        precondition(L10n.stateCreditExhausted == "Credit exhausted")
        precondition(L10n.stateApiStandby == "Standby · after plans")
        precondition(L10n.legendApiCredit(1, 2) == "API credit 1/2")
        precondition(teamAccountErrorReasonLabel("credit-exhausted") == "Credit exhausted")
        L10n.language = .ko

        print("TeamClaudeApiCreditTests passed")
    }
}
