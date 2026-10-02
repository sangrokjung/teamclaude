"""agy 로더 회귀: 전용 워크스페이스·SIGKILL 에스컬레이션·단일 완료·제목 슬롯 배선.

2026-09-23 사고: 데몬 cwd가 루트라 agy가 루트를 워크스페이스로 열고 6시간 20분 멈췄다.
워치독은 SIGTERM만 보냈고 그 상태에서는 죽지 않아 완료 콜백이 끝내 오지 않았고,
호출부의 isFetchingAgy가 true로 박혀 폴링이 데몬 수명 내내 정지했다(AGY 1줄 vs GROK 219줄).
"""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


class AgyLoaderWiringTests(unittest.TestCase):
    def setUp(self):
        self.agy = (SOURCES / "AgyUsage.swift").read_text()
        self.main = (SOURCES / "main.swift").read_text()
        match = re.search(r"func fetchAgyUsage\(.*?\n\}\n", self.agy, re.DOTALL)
        self.assertIsNotNone(match, "fetchAgyUsage must remain discoverable")
        self.fetch = match.group(0)

    def test_runs_in_a_dedicated_workspace_not_the_daemon_cwd(self):
        self.assertIn("func agyWorkspaceURL()", self.agy)
        self.assertIn(".claude/cache/cc-menubar-agy", self.agy)
        self.assertIn("process.currentDirectoryURL = workspace", self.fetch)

    def test_watchdog_escalates_to_sigkill(self):
        self.assertIn("kill(pid, SIGTERM)", self.fetch)
        self.assertIn("kill(pid, SIGKILL)", self.fetch)
        # SIGTERM만 믿던 옛 경로로 돌아가지 않는다.
        self.assertNotIn("process.terminate()", self.fetch)

    def test_completion_fires_exactly_once_and_never_blocks_the_queue(self):
        self.assertIn("func finish(", self.fetch)
        self.assertIn("guard isFirst else { return }", self.fetch)
        self.assertIn("process.terminationHandler", self.fetch)
        # waitUntilExit는 스레드를 붙잡은 채 영원히 기다릴 수 있다.
        self.assertNotIn("waitUntilExit", self.fetch)
        # 종료 핸들러가 오지 않아도 완료가 돌아가는 마지막 안전망.
        self.assertIn("agyFetchTimeout + agyKillGrace", self.fetch)

    def test_reads_stdout_while_the_child_runs(self):
        self.assertIn("output.fileHandleForReading.readabilityHandler", self.fetch)
        self.assertNotIn("readDataToEndOfFile", self.fetch)
        # stdout reader 는 하나뿐이어야 한다. 종료 핸들러에서 한 번 더 읽으면 마지막 청크가
        # 어느 쪽에 떨어질지 정해져 있지 않고, 블로킹 read 가 스레드를 붙잡는다.
        self.assertNotIn("readToEnd", self.fetch)
        self.assertIn("sawEOF", self.fetch)
        self.assertIn("exitStatus", self.fetch)

    def test_title_carries_only_the_gemini_lane(self):
        # 제목에 Claude·GPT 한도를 올리지 않는다 — 우리는 그 모델을 쓰지 않는다(agy 레인 규칙).
        slot = re.search(r"func agyTitleSlot\(.*?\n\}\n", self.agy, re.DOTALL)
        self.assertIsNotNone(slot)
        self.assertIn('contains("gemini")', slot.group(0))
        self.assertNotIn("joined(separator: \"/\")", slot.group(0))

    def test_title_shows_agy_next_to_grok(self):
        self.assertIn("func agyTitleSlot(", self.agy)
        self.assertIn("agyTitleSlot(self.currentAgyCard)", self.main)
        self.assertIn("let cliSlots = [self.currentGrokSlot, agyTitleSlot(self.currentAgyCard)]", self.main)
        self.assertIn("cliPrefix", self.main)
        self.assertNotIn("grokTip", self.main)


if __name__ == "__main__":
    unittest.main()
