import Foundation

// 접근이 막힌 Claude 계정의 "다시 확인" 버튼. `teamclaude recheck <name> --json`을 백그라운드에서 돌리고
// 결과(프록시 subscription-recheck.js의 outcome)에 따라 다음 동작을 고른다.
//   ok               → 프록시가 차단 깃발을 지웠다. 표를 다시 읽는다.
//   payment-past-due → 결제 연체. 재인증으로 안 풀리므로 claude.ai 결제 화면을 연다.
//   org-blocked      → 조직이 막았다. 사람이 할 수 있는 일이 없으니 알리기만 한다.
//   auth-invalid     → 토큰 거부. 재인증 창을 연다(계정 재연동).
//   token-expired    → 서버가 곧 토큰을 갱신한다. 잠시 뒤 다시.

enum TeamClaudeRecheckFollowUp: Equatable {
    case refresh
    case openBilling(URL)
    case reauthenticate
    case none
}

struct TeamClaudeRecheckResult: Equatable {
    let outcome: String
    let succeeded: Bool
    let message: String
    let followUp: TeamClaudeRecheckFollowUp
}

let teamClaudeDefaultBillingURL = URL(string: "https://claude.ai/settings/billing")!

/// CLI 결과를 화면 동작으로 바꾼다. 출력의 마지막 JSON 줄을 읽고, 없으면 종료 코드로 판단한다.
func teamClaudeRecheckResult(_ cli: SubscriptionCLIResult, name: String) -> TeamClaudeRecheckResult {
    // 시간 초과로 끊긴 실행은 출력에 무엇이 있든 결과를 믿지 않는다.
    if cli.timedOut {
        return TeamClaudeRecheckResult(outcome: "unknown", succeeded: false, message: L10n.recheckInconclusive(name), followUp: .none)
    }
    var outcome: String?
    var billing: URL?
    for line in cli.output.split(separator: "\n").reversed() {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["outcome"] as? String else { continue }
        outcome = value
        if let raw = object["billingUrl"] as? String, let url = URL(string: raw),
           url.scheme == "https", url.host == "claude.ai" {
            billing = url
        }
        break
    }
    if outcome == nil {
        let byExit: [Int32: String] = [0: "ok", 2: "payment-past-due", 3: "org-blocked", 4: "auth-invalid", 5: "token-expired",
                                       7: "not-applied", 8: "access-denied"]
        outcome = byExit[cli.status]
    }
    // JSON과 종료 코드가 어긋나면(예: ok인데 비정상 종료) 성공으로 보지 않는다.
    if outcome == "ok" && cli.status != 0 { outcome = "unknown" }
    switch outcome {
    case "not-applied":
        return TeamClaudeRecheckResult(outcome: "not-applied", succeeded: false, message: L10n.recheckNotApplied(name), followUp: .refresh)
    case "ok":
        return TeamClaudeRecheckResult(outcome: "ok", succeeded: true, message: L10n.recheckOk(name), followUp: .refresh)
    case "payment-past-due":
        return TeamClaudeRecheckResult(outcome: "payment-past-due", succeeded: false, message: L10n.recheckPastDue(name),
                                       followUp: .openBilling(billing ?? teamClaudeDefaultBillingURL))
    case "access-denied":
        return TeamClaudeRecheckResult(outcome: "access-denied", succeeded: false, message: L10n.recheckAccessDenied(name), followUp: .refresh)
    case "org-blocked":
        return TeamClaudeRecheckResult(outcome: "org-blocked", succeeded: false, message: L10n.recheckOrgBlocked(name), followUp: .refresh)
    case "auth-invalid":
        return TeamClaudeRecheckResult(outcome: "auth-invalid", succeeded: false, message: L10n.recheckAuthInvalid(name), followUp: .reauthenticate)
    case "token-expired":
        return TeamClaudeRecheckResult(outcome: "token-expired", succeeded: false, message: L10n.recheckTokenExpiring(name), followUp: .none)
    default:
        return TeamClaudeRecheckResult(outcome: "unknown", succeeded: false, message: L10n.recheckInconclusive(name), followUp: .none)
    }
}

/// recheck 인자. 신원이 확인된 행에서만 실행하고, 플래그처럼 보이는 이름은 거부한다.
func teamClaudeRecheckArguments(name: String, accountUuid: String?) -> [String]? {
    guard !name.isEmpty, !name.hasPrefix("-") else { return nil }
    var arguments = ["recheck", name, "--json"]
    if let accountUuid, !accountUuid.isEmpty {
        guard !accountUuid.hasPrefix("-") else { return nil }
        arguments.append(contentsOf: ["--account-uuid", accountUuid])
    }
    return arguments
}

final class TeamClaudeRecheckCenter {
    static let shared = TeamClaudeRecheckCenter()

    /// 백그라운드에서 CLI를 돌리고 메인 스레드에서 completion을 부른다. main.swift가 실제 실행기로 바꾼다.
    var runner: (_ arguments: [String], _ completion: @escaping (SubscriptionCLIResult) -> Void) -> Void = { _, completion in
        completion(SubscriptionCLIResult(status: -1, output: ""))
    }
    var onStart: ((String) -> Void)?
    var onResult: ((_ name: String, _ accountUuid: String?, _ result: TeamClaudeRecheckResult) -> Void)?
    private var busy: Set<String> = []

    func recheck(name: String, accountUuid: String?) {
        guard let arguments = teamClaudeRecheckArguments(name: name, accountUuid: accountUuid) else { return }
        let key = accountUuid ?? name
        guard !busy.contains(key) else { return }
        busy.insert(key)
        onStart?(name)
        runner(arguments) { [weak self] cli in
            self?.busy.remove(key)
            self?.onResult?(name, accountUuid, teamClaudeRecheckResult(cli, name: name))
        }
    }
}
