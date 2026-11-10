import Foundation

@main
struct TeamClaudeRecheckTests {
    static func main() {
        L10n.language = .ko
        func cli(_ status: Int32, _ output: String, timedOut: Bool = false) -> SubscriptionCLIResult {
            SubscriptionCLIResult(status: status, output: output, timedOut: timedOut)
        }
        // JSON 줄이 우선이다(앞의 진단 줄은 무시).
        var r = teamClaudeRecheckResult(cli(0, "Saved\n{\"outcome\":\"ok\",\"httpStatus\":200}\n"), name: "a")
        precondition(r.outcome == "ok" && r.succeeded && r.followUp == .refresh, "\(r)")

        r = teamClaudeRecheckResult(cli(2, "{\"outcome\":\"payment-past-due\",\"billingUrl\":\"https://claude.ai/settings/billing\"}"), name: "a")
        precondition(r.outcome == "payment-past-due" && !r.succeeded, "\(r)")
        precondition(r.followUp == .openBilling(URL(string: "https://claude.ai/settings/billing")!))
        precondition(r.message.contains("결제 연체"))

        // 다른 도메인 결제 URL은 따르지 않고 기본 결제 화면으로 간다.
        r = teamClaudeRecheckResult(cli(2, "{\"outcome\":\"payment-past-due\",\"billingUrl\":\"https://evil.example/pay\"}"), name: "a")
        precondition(r.followUp == .openBilling(teamClaudeDefaultBillingURL), "\(r)")

        r = teamClaudeRecheckResult(cli(4, "{\"outcome\":\"auth-invalid\"}"), name: "a")
        precondition(r.followUp == .reauthenticate)
        r = teamClaudeRecheckResult(cli(3, "{\"outcome\":\"org-blocked\"}"), name: "a")
        precondition(r.outcome == "org-blocked" && r.followUp == .refresh)
        r = teamClaudeRecheckResult(cli(5, "{\"outcome\":\"token-expired\"}"), name: "a")
        precondition(r.followUp == .none)

        // 서버 반영 미확인은 성공이 아니다(JSON이든 종료 코드든).
        r = teamClaudeRecheckResult(cli(7, "{\"outcome\":\"not-applied\",\"verdict\":\"ok\"}"), name: "a")
        precondition(r.outcome == "not-applied" && !r.succeeded, "\(r)")
        precondition(teamClaudeRecheckResult(cli(7, ""), name: "a").outcome == "not-applied")
        // ok JSON이라도 시간 초과·비정상 종료면 성공으로 보지 않는다.
        precondition(teamClaudeRecheckResult(cli(0, "{\"outcome\":\"ok\"}", timedOut: true), name: "a").outcome == "unknown")
        precondition(teamClaudeRecheckResult(cli(1, "{\"outcome\":\"ok\"}"), name: "a").outcome == "unknown")

        // JSON이 없으면 종료 코드로, 시간 초과면 판단하지 않는다.
        precondition(teamClaudeRecheckResult(cli(2, "plain text"), name: "a").outcome == "payment-past-due")
        precondition(teamClaudeRecheckResult(cli(0, "", timedOut: true), name: "a").outcome == "unknown")
        precondition(teamClaudeRecheckResult(cli(1, "Account not found"), name: "a").outcome == "unknown")

        // 인자: 플래그처럼 보이는 이름·uuid는 거부, uuid는 신원 고정으로 붙는다.
        precondition(teamClaudeRecheckArguments(name: "-x", accountUuid: nil) == nil)
        precondition(teamClaudeRecheckArguments(name: "a", accountUuid: "-u") == nil)
        precondition(teamClaudeRecheckArguments(name: "a", accountUuid: "u1") == ["recheck", "a", "--json", "--account-uuid", "u1"])
        precondition(teamClaudeRecheckArguments(name: "a", accountUuid: nil) == ["recheck", "a", "--json"])

        // 같은 계정의 중복 클릭은 한 번만 실행한다.
        let center = TeamClaudeRecheckCenter()
        var runs = 0
        var pending: ((SubscriptionCLIResult) -> Void)?
        var results: [String] = []
        center.runner = { _, completion in runs += 1; pending = completion }
        center.onResult = { _, _, result in results.append(result.outcome) }
        center.recheck(name: "a", accountUuid: "u1")
        center.recheck(name: "a", accountUuid: "u1")
        precondition(runs == 1)
        pending?(cli(0, "{\"outcome\":\"ok\"}"))
        precondition(results == ["ok"])
        center.recheck(name: "a", accountUuid: "u1")
        precondition(runs == 2)
        print("TeamClaudeRecheckTests OK")
    }
}
