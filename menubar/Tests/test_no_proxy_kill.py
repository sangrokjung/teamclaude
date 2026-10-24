"""상태바 앱이 살아 있는 TeamClaude 프록시를 죽이지 않는지 소스로 고정한다.

`launchctl kickstart -k`는 supervisor를 죽였다 다시 띄워 진행 중 요청을 모두 끊는다
(10/10 23:47 inflight 14건, 3일간 재시작 70회의 주범). 남는 `-k` 호출은 사용자가
확인 대화상자에서 명시적으로 고른 경로뿐이어야 한다.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


def function_body(source: str, signature: str) -> str:
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 0
    for index in range(brace, len(source)):
        char = source[index]
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(f"unterminated body: {signature}")


class NoProxyKillTests(unittest.TestCase):
    def setUp(self):
        self.main = (SOURCES / "main.swift").read_text()
        self.all_sources = {path.name: path.read_text() for path in SOURCES.glob("*.swift")}

    def test_force_kickstart_lives_in_one_confirmed_function(self):
        hits = [
            (name, match.start())
            for name, text in self.all_sources.items()
            for match in re.finditer(r'"kickstart",\s*"-k"', text)
        ]
        self.assertEqual(len(hits), 1, hits)
        self.assertEqual(hits[0][0], "main.swift")
        force = function_body(self.main, "func forceRestartTeamClaudeServerConfirmedByUser(")
        self.assertRegex(force, r'"kickstart",\s*"-k"')
        # 셸 문자열 형태의 kickstart -k도 남지 않아야 한다.
        for name, text in self.all_sources.items():
            self.assertNotIn("kickstart -k", text, name)
        self.assertNotIn("func kickstartTeamClaudeServer(", self.main)
        self.assertNotIn("kickstartTeamClaudeServer()", self.main)

    def test_force_restart_only_called_after_user_confirmation(self):
        calls = [m.start() for m in re.finditer(r"(?<!func )forceRestartTeamClaudeServerConfirmedByUser\(\)", self.main)]
        self.assertEqual(len(calls), 1, "정의 외 호출은 수동 재시작 액션 한 곳뿐이어야 한다")
        action = function_body(self.main, "@objc func restartTeamClaudeAction(")
        self.assertIn("forceRestartTeamClaudeServerConfirmedByUser()", action)
        self.assertIn("teamClaudeRestartConfirmation(", action)
        self.assertIn("runModal()", action)
        # 기본 버튼(Return)은 취소다. 재시작은 두 번째 버튼을 명시적으로 눌러야 한다.
        self.assertIn(".alertSecondButtonReturn", action)
        self.assertNotIn(".alertFirstButtonReturn", action)
        self.assertLess(action.index("runModal()"), action.index("forceRestartTeamClaudeServerConfirmedByUser()"))

    def test_start_stopped_service_has_no_kill_flag(self):
        start = function_body(self.main, "func startStoppedTeamClaudeService(")
        self.assertIn('"kickstart"', start)
        self.assertNotIn('"-k"', start)

    def test_terminal_command_does_not_restart_proxy(self):
        terminal = function_body(self.main, "func teamClaudeTerminalCommand(")
        code = "\n".join(line for line in terminal.splitlines() if not line.strip().startswith("//"))
        self.assertNotIn("kickstart", code)
        self.assertNotIn(") restart", code)
        self.assertNotIn("successCommand", code)

    def test_autosync_and_measure_use_no_restart_path(self):
        load = function_body(self.main, "func loadTeamClaudeStatusInBackground(")
        measure = function_body(self.main, "@objc func measureTeamClaudeAction(")
        for body in (load, measure):
            self.assertIn("syncTeamClaudeServerWithoutRestart(", body)
            self.assertNotIn("forceRestart", body)
            self.assertNotIn("서버 재시작", body)
        sync = function_body(self.main, "func syncTeamClaudeServerWithoutRestart(")
        self.assertIn("teamClaudeSyncPlan(", sync)
        self.assertIn("probeTeamClaudeOutage(", sync)
        self.assertIn("reloadTeamClaudeWorkerAccounts(", sync)
        self.assertIn("startStoppedTeamClaudeService()", sync)
        self.assertNotIn("forceRestart", sync)
        outage = function_body(self.main, "func probeTeamClaudeOutage(")
        self.assertIn("teamClaudeOutageVerdict(", outage)
        reload = function_body(self.main, "private func reloadTeamClaudeWorkerAccounts(")
        # SIGHUP은 검증 판정이 .signal일 때만 보낸다.
        self.assertIn("teamClaudeWorkerSignalDecision(", reload)
        self.assertIn("guard case .signal(let pid) = decision", reload)
        self.assertLess(reload.index("guard case .signal(let pid) = decision"), reload.index("kill(pid, SIGHUP)"))
        self.assertNotIn("forceRestart", reload)

    def test_delay_and_drift_states_reach_display(self):
        self.assertIn("teamClaudeServerPillLabel(", self.main)
        self.assertIn("teamClaudeDriftActionDetail(", self.main)
        self.assertIn("L10n.titleClaudeSlow", self.main)
        self.assertIn('t("Claude 응답 지연", "Claude slow")', (SOURCES / "L10n.swift").read_text())
        commit = function_body(self.main, "func commitTeamClaudeHealth(")
        self.assertIn("serverResponseDelayed", commit)
        self.assertIn("driftPersistsAfterReload", commit)


if __name__ == "__main__":
    unittest.main()
