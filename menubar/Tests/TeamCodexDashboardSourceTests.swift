import Foundation

@main
struct TeamCodexDashboardSourceTests {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            fatalError("Usage: TeamCodexDashboardSourceTests <repository-root>")
        }

        let sourcePath = "\(CommandLine.arguments[1])/menubar/Sources/main.swift"
        let source = try String(contentsOfFile: sourcePath, encoding: .utf8)
        let codexStatusViewPath = "\(CommandLine.arguments[1])/menubar/Sources/CodexStatusView.swift"
        let codexStatusView = try String(contentsOfFile: codexStatusViewPath, encoding: .utf8)

        let tick = try functionBody(
            named: "func tick()",
            endingBefore: "\n    func updateActivity()",
            in: source
        )
        precondition(
            tick.contains("observeTeamCodexConfigChanges()"),
            "The 1-second app tick must continuously observe external TeamCodex config changes"
        )
        let commit = try functionBody(
            named: "func commitTeamCodexHealth(",
            endingBefore: "\n    func loadUsageInBackground()",
            in: source
        )
        precondition(
            commit.contains("teamCodexConfigWatchState.accepts("),
            "Every TeamCodex status commit must validate its refresh context"
        )
        precondition(
            commit.contains("teamCodexPoolHealth(")
                && commit.contains("aligning: candidate,")
                && commit.contains("to: $0"),
            "Live TeamCodex status must align to config during add/remove convergence"
        )
        precondition(
            source.contains("--teamcodex-dashboard-selftest"),
            "The menubar binary must expose account transition and layout regression checks"
        )
        precondition(
            !source.contains("구독연체") && !codexStatusView.contains("구독연체"),
            "A denied Claude Code organization must not be mislabeled as delinquent billing"
        )
        precondition(
            source.contains("teamAccountErrorReasonLabel(row.errorReason)")
                && codexStatusView.contains("teamAccountErrorReasonLabel(account.errorReason)"),
            "Both TeamClaude renderers must share the canonical error-reason label"
        )
        precondition(
            source.contains("사용 가능 계정:") && codexStatusView.contains("사용 가능 계정:"),
            "Both account pools must show the names of currently usable accounts"
        )
        precondition(
            source.contains("teamClaudeCanReauthenticate(")
                && source.contains("button.title = \"재인증 필요\"")
                && source.contains("onReauthenticateTeamClaude"),
            "The graphical TeamClaude table must expose eligible re-auth buttons in the accessibility tree"
        )
        precondition(
            source.contains("expectedAccountUuid: accountUuid")
                && source.contains("--account-uuid"),
            "The re-auth action must carry the selected account UUID to the CLI"
        )
        // Claude 재인증과 같은 강도로 Codex 되돌리기 "배선"도 고정한다.
        // 순수 함수만 덮으면 콜백 한 줄이 지워져도 테스트가 전부 통과한 채 버튼만 죽는다.
        precondition(
            codexStatusView.contains("var onRecover: ((String, String?, TeamCodexAccountRecoveryKind) -> Void)?")
                && codexStatusView.contains("teamCodexAccountRecovery(account, now: pool.checkedAt)")
                && codexStatusView.contains("addSubview(button)")
                && codexStatusView.contains("onRecover?(target.name, target.accountUuid, target.kind)"),
            "The Codex pool table must build recovery buttons and report clicks through onRecover"
        )
        precondition(
            source.contains("view.onRecover = onRecoverTeamCodex")
                && source.contains("codexView?.onRecover = onRecoverTeamCodex")
                && source.contains("self?.recoverTeamCodexAccount(name, expectedAccountUuid: accountUuid, kind: kind)"),
            "Both the first render and the update path must wire the Codex recovery callback"
        )
        let recoverTeamCodex = try functionBody(
            named: "    func recoverTeamCodexAccount(",
            endingBefore: "\n    @objc func addCodexOAuthAccountAction()",
            in: source
        )
        precondition(
            recoverTeamCodex.contains("teamCodexAccountRecovery(row)")
                && recoverTeamCodex.contains("recovery.kind == kind")
                && recoverTeamCodex.contains("codexMode: true"),
            "The Codex recovery action must re-verify the live row and run through the teamcodex entrypoint"
        )
        let terminalCommand = try functionBody(
            named: "func teamClaudeTerminalCommand(",
            endingBefore: "\nclass AppDelegate",
            in: source
        )
        precondition(
            terminalCommand.contains("teamcodex restart가 필요합니다")
                && terminalCommand.contains("let closingNote = codexMode"),
            "A codex-mode terminal must not overwrite the CLI restart warning with an auto-apply promise"
        )
        let isolatedProcess = try functionBody(
            named: "func runTrustedProcessInIsolatedGroup(",
            endingBefore: "\n/// daily(필수)",
            in: source
        )
        let ccusage = try functionBody(
            named: "func runCcusageRaw(_ subcommand: String)",
            endingBefore: "\nstruct IsolatedProcessResult",
            in: source
        )
        let claudeProbe = try functionBody(
            named: "func runTeamClaudeBareClaudeProbe(",
            endingBefore: "\nfunc stripClaudeModelSuffix",
            in: source
        )
        let accountRefresh = try functionBody(
            named: "func refreshTeamClaudeOAuthAccounts()",
            endingBefore: "\nfunc shellQuote",
            in: source
        )
        precondition(
            isolatedProcess.contains("POSIX_SPAWN_SETPGROUP")
                && isolatedProcess.contains("posix_spawnattr_setpgroup(&attributes, 0)")
                && source.contains("WEXITED | WNOHANG | WNOWAIT")
                && isolatedProcess.contains("Darwin.killpg(childPid, SIGTERM)")
                && isolatedProcess.contains("Darwin.killpg(childPid, SIGKILL)")
                && source.contains("private func reapChild(_ pid: pid_t)")
                && source.contains("`setsid`/`setpgid`로 의도적으로 탈출하지 않는 QJC 고정 CLI")
                && ccusage.contains("runTrustedProcessInIsolatedGroup(")
                && claudeProbe.contains("runTrustedProcessInIsolatedGroup(")
                && accountRefresh.contains("runTrustedProcessInIsolatedGroup(")
                && !source.contains("/bin/ps")
                && !source.contains("cc-menubar-process-tree-")
                && !source.contains("proc_pidinfo(")
                && !source.contains("terminateProcessTree("),
            "Timeout cleanup must signal an unreaped, isolated process group without PID lookups"
        )

        print("TeamCodexDashboardSourceTests: 13 passed, 0 failed")
    }

    private static func functionBody(
        named startMarker: String,
        endingBefore endMarker: String,
        in source: String
    ) throws -> Substring {
        guard let start = source.range(of: startMarker),
              let end = source.range(
                of: endMarker,
                range: start.upperBound..<source.endIndex
              ) else {
            throw SourceTestError.missingFunction(startMarker)
        }
        return source[start.lowerBound..<end.lowerBound]
    }

    private enum SourceTestError: Error {
        case missingFunction(String)
    }
}
