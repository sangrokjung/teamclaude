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
        precondition(teamClaudeApiCreditReason(exhausted, now: beforeExpiry) == "Anthropic이 사용 한도 도달로 거절 · 한도 조정 후 api-credit으로 다시 켜기",
                     teamClaudeApiCreditReason(exhausted, now: beforeExpiry))
        // 소진 차단을 설정에 쓰지 못했으면(재시작하면 풀림) 사유 줄이 그렇게 말한다.
        let unsaved = teamClaudeApiCredit(["usd": 50, "spentUsd": 1, "exhausted": true, "exhaustedReason": "billing", "persistFailed": true])!
        precondition(unsaved.persistFailed && !exhausted.persistFailed)
        precondition(teamClaudeApiCreditReason(unsaved, now: beforeExpiry) == "Anthropic이 결제 문제로 거절 · 결제 확인 후 api-credit으로 다시 켜기 · 설정 저장 실패(재시작하면 풀림)",
                     teamClaudeApiCreditReason(unsaved, now: beforeExpiry))
        precondition(L10n.reasonApiRateLimited == "분당 한도 대기 · 잠시 뒤 다시 사용")
        precondition(teamClaudeApiCreditBarValue(credit) == "$12.30")
        precondition(teamClaudeApiCreditBarValue(teamClaudeApiCredit(["spentUsd": 1])!) == "-")
        testRefusedIsZero(credit: credit, now: beforeExpiry)
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
        precondition(teamClaudeApiCreditReason(exhausted, now: beforeExpiry) == "Refused by Anthropic: usage limit reached · raise the limit, then re-arm with api-credit",
                     teamClaudeApiCreditReason(exhausted, now: beforeExpiry))
        precondition(teamClaudeApiCreditRefusedReason(nil) == "Refused by Anthropic: credit balance too low · top up, then re-arm with api-credit",
                     teamClaudeApiCreditRefusedReason(nil))
        precondition(teamClaudeApiCreditRefusedReason(unsaved) == "Refused by Anthropic: billing issue · fix billing, then re-arm with api-credit · Not saved to config (lost on restart)",
                     teamClaudeApiCreditRefusedReason(unsaved))
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

    /// Anthropic이 잔액 부족으로 거절한 키는 금액 칸이 $0.00이고 막대도 비운다. 잔액 조회 API가 없어
    /// 확정적으로 아는 사실은 "거절 = 쓸 수 있는 잔액 0"뿐이라, 등록값에서 지출을 뺀 추정치는 남기지 않는다.
    /// 거절되지 않은 키의 추정치는 그대로다(회귀). 한국어 기준(호출 전 L10n.language = .ko).
    static func testRefusedIsZero(credit: TeamClaudeApiCredit, now: Date) {
        // 보고된 증상: 충전 $200, 추정 지출 $31.87, 상류 거절로 프록시가 뺀 키가 "$168.13"으로 보였다.
        let refusedFlag = teamClaudeApiCredit(["usd": 200, "spentUsd": 31.87, "exhausted": true, "exhaustedReason": "credit-exhausted"])!
        precondition(teamClaudeApiCreditRefused(refusedFlag, errorReason: "credit-exhausted"))
        precondition(teamClaudeApiCreditBarValue(refusedFlag) == "$0.00", teamClaudeApiCreditBarValue(refusedFlag))
        precondition(teamClaudeApiCreditMeterFraction(refusedFlag) == 0)
        precondition(teamClaudeApiCreditReason(refusedFlag, now: now) == "Anthropic이 잔액 부족으로 거절 · 충전 후 api-credit으로 다시 켜기",
                     teamClaudeApiCreditReason(refusedFlag, now: now))

        // credit 블록에 소진 표시가 없어도 행의 errorReason이 credit-exhausted면 거절로 본다(같은 판정을 모든 소비 지점이 쓴다).
        let blockOnly = teamClaudeApiCredit(["usd": 200, "spentUsd": 0, "exhausted": false])!
        precondition(teamClaudeApiCreditRefused(blockOnly, errorReason: "credit-exhausted"))
        precondition(teamClaudeApiCreditBarValue(blockOnly, refused: true) == "$0.00")
        precondition(teamClaudeApiCreditMeterFraction(blockOnly, refused: true) == 0)
        let blockOnlyReason = teamClaudeApiCreditReason(blockOnly, refused: true, now: now)
        precondition(blockOnlyReason == "Anthropic이 잔액 부족으로 거절 · 충전 후 api-credit으로 다시 켜기", blockOnlyReason)
        precondition(!blockOnlyReason.contains("$200.00") && !blockOnlyReason.contains("추정"), "거절 행에 추정치를 남기지 않는다")
        // credit 블록이 없는 구버전 프록시라도 거절이면 $0.00.
        precondition(teamClaudeApiCreditRefused(nil, errorReason: "credit-exhausted"))
        precondition(teamClaudeApiCreditBarValue(nil, refused: true) == "$0.00")
        precondition(teamClaudeApiCreditMeterFraction(nil, refused: true) == 0)
        precondition(teamClaudeApiCreditRefusedReason(nil) == "Anthropic이 잔액 부족으로 거절 · 충전 후 api-credit으로 다시 켜기")

        // 회귀: 거절되지 않은 키는 추정치·비율·사유가 바뀌지 않는다.
        precondition(!teamClaudeApiCreditRefused(credit, errorReason: nil))
        precondition(!teamClaudeApiCreditRefused(credit, errorReason: "auth-rejected"))
        precondition(!teamClaudeApiCreditRefused(nil, errorReason: nil))
        precondition(teamClaudeApiCreditBarValue(credit, refused: false) == "$12.30")
        precondition(teamClaudeApiCreditBarValue(blockOnly) == "$200.00")
        precondition(teamClaudeApiCreditBarValue(nil) == "-")
        precondition(abs((teamClaudeApiCreditMeterFraction(credit) ?? -1) - 0.246) < 1e-9)
        precondition(teamClaudeApiCreditMeterFraction(blockOnly) == 1)
        precondition(teamClaudeApiCreditMeterFraction(nil) == nil)
        precondition(teamClaudeApiCreditReason(blockOnly, now: now) == "약 $200.00 남음 · $200.00 중 (추정)",
                     teamClaudeApiCreditReason(blockOnly, now: now))
    }
}
