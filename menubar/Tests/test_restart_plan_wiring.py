"""launchd 라벨 일반화(외부 배포 R3·A4)가 PR #64의 불변식을 지키는지 소스로 고정한다.

라벨이 launchd에 없으면 재시작 버튼은 kickstart를 부르지 않는다. -k 재시작은 등록된 서비스에서
확인 대화상자를 거친 경로뿐이고, 자동 동기화는 미등록 라벨에서 `teamclaude server`를 분리 실행해
시작만 한다(설정·실행 파일이 있을 때만). 판정 자체는 TeamClaudeServerControlTests.swift가 본다."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


def function_body(source, signature):
    start = source.index(signature)
    brace = source.index("{", start)
    depth = 0
    for index in range(brace, len(source)):
        if source[index] == "{":
            depth += 1
        elif source[index] == "}":
            depth -= 1
            if depth == 0:
                return source[start:index + 1]
    raise AssertionError(signature)


class RestartPlanWiringTests(unittest.TestCase):
    def setUp(self):
        self.main = (SOURCES / "main.swift").read_text()

    def test_label_is_resolved_not_hardcoded(self):
        self.assertNotIn('let teamClaudeLaunchdLabel = "com.qjc.teamclaude"', self.main)
        self.assertIn("let teamClaudeLaunchdLabel = resolveTeamClaudeLaunchdLabel(", self.main)
        self.assertIn("teamClaudeLaunchdLabelDefaultsKey", self.main)
        control = (SOURCES / "TeamClaudeServerControl.swift").read_text()
        self.assertIn('let teamClaudeDefaultLaunchdLabel = "com.qjc.teamclaude"', control)
        self.assertIn('"CC_MENUBAR_TEAMCLAUDE_LABEL"', control)

    def test_restart_button_routes_by_plan_and_force_restart_only_in_registered_branch(self):
        action = function_body(self.main, "@objc func restartTeamClaudeAction(")
        self.assertIn("probeTeamClaudeLaunchd()", action)
        self.assertIn("teamClaudeRestartPlan(", action)
        self.assertLess(action.index("teamClaudeRestartPlan("), action.index("forceRestartTeamClaudeServerConfirmedByUser()"))
        registered = action[action.index("case .forceRestartConfirmed:"):action.index("case .startDetached:")]
        self.assertIn("forceRestartTeamClaudeServerConfirmedByUser()", registered)
        self.assertIn("runModal()", registered)
        for case in ("case .startDetached:", "case .leaveRunning:", "case .undetermined:"):
            tail = action[action.index(case):]
            branch = tail[:tail.index("case .", len(case))] if "case ." in tail[len(case):] else tail
            with self.subTest(case=case):
                self.assertNotIn("forceRestart", branch)
                self.assertNotIn("kickstart", branch)
                self.assertNotIn("startStoppedTeamClaudeService", branch)

    def test_detached_start_has_no_kill_or_restart(self):
        start = function_body(self.main, "func startTeamClaudeServerDetached(")
        self.assertIn("teamClaudeDetachedStartArguments(", start)
        for word in ("kickstart", "kill(", "restart", "SIGTERM", "SIGKILL"):
            self.assertNotIn(word, start)

    def test_autosync_starts_unregistered_server_only_when_allowed(self):
        sync = function_body(self.main, "func syncTeamClaudeServerWithoutRestart(")
        branch = sync[sync.index("case .serviceNotLoaded:"):sync.index("case .undetermined:")]
        self.assertIn("teamClaudeDetachedStartAllowed(", branch)
        self.assertLess(branch.index("teamClaudeDetachedStartAllowed("), branch.index("startTeamClaudeServerDetached("))
        self.assertNotIn("forceRestart", branch)
        self.assertNotIn("startStoppedTeamClaudeService", branch)


if __name__ == "__main__":
    unittest.main()
