# menubar/Tests/test_crash_recorder.py
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "menubar" / "Sources" / "main.swift"
PALETTE_SOURCE = ROOT / "menubar" / "Sources" / "TeamClaudePalette.swift"


class CrashRecorderWiringTests(unittest.TestCase):
    def setUp(self):
        self.source = SOURCE.read_text()

    def test_uncaught_exception_handler_is_installed_before_the_app_runs(self):
        self.assertIn("NSSetUncaughtExceptionHandler", self.source)
        self.assertIn("cc-menubar-crash.log", self.source)
        # main.swift에는 app.run()이 2곳이다(4821행 벤치마크 분기, 5399행 최상위 일반 실행).
        # 데몬이 실제로 도는 곳은 마지막(최상위) 호출이므로 rfind로 잡는다.
        run_at = self.source.rfind("app.run()")
        self.assertNotEqual(-1, run_at, "app.run() must remain discoverable")
        # 기록기는 진입점의 첫 CLI 분기보다 앞에서 정확히 한 번 호출된다 — 모든 오프스크린 렌더 경로가 브레드크럼을 남긴다.
        calls = [m.start() for m in re.finditer(r"(?<!func )installCrashRecorder\(\)", self.source)]
        self.assertEqual(1, len(calls), f"installCrashRecorder() must be called exactly once at the entry point, found {len(calls)}")
        first_branch = self.source.find("CommandLine.arguments")
        self.assertNotEqual(-1, first_branch)
        self.assertLess(calls[0], first_branch, "the recorder must be installed before the first CLI branch")
        self.assertLess(calls[0], run_at)

    def test_team_claude_table_draw_leaves_breadcrumbs(self):
        match = re.search(
            r"final class TeamClaudeTableView: NSView \{(?P<body>.*?)\nfinal class ServiceAvailabilitySummaryView",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        crumbs = re.findall(r'markDraw\("TeamClaudeTableView\.[a-z]+"\)', match.group("body"))
        self.assertGreaterEqual(len(crumbs), 4, crumbs)

    def test_availability_summary_uses_the_static_palette(self):
        match = re.search(
            r"final class ServiceAvailabilitySummaryView.*?(?=\nfinal class )",
            self.source,
            re.DOTALL,
        )
        self.assertIsNotNone(match)
        body = match.group(0)
        self.assertNotIn("NSColor(calibrated", body)
        self.assertNotIn("NSFont.", body)
        self.assertIn("TeamClaudePalette.summaryTitleFont", body)
        self.assertIn("TeamClaudePalette.inactive", body)
        palette = PALETTE_SOURCE.read_text()
        for member in ("summaryTitleFont", "summaryBodyFont", "summaryValueFont", "summaryNameFont", "summaryFootFont"):
            self.assertIn(f"static let {member}", palette)
            self.assertRegex(palette, r"_ = \([^)]*\b" + member + r"\b")

    def test_team_claude_table_uses_a_static_palette(self):
        # 팔레트는 자기 파일(TeamClaudePalette.swift)에 산다 — 러너의 라이브러리 소스 집합에 들어가야 하므로 main.swift 밖이다.
        palette = PALETTE_SOURCE.read_text()
        self.assertIn("enum TeamClaudePalette", palette)
        self.assertIn("static func prewarm()", palette)
        self.assertNotIn("enum TeamClaudePalette", self.source)
        match = re.search(
            r"final class TeamClaudeTableView: NSView \{(?P<body>.*?)\nfinal class ServiceAvailabilitySummaryView",
            self.source,
            re.DOTALL,
        )
        body = match.group("body")
        self.assertNotIn("let titleFont = NSFont.systemFont", body)
        self.assertNotIn("let bg = NSColor(calibratedRed", body)
        self.assertIn("TeamClaudePalette.titleFont", body)
        self.assertIn("TeamClaudePalette.prewarm()", self.source)
        self.assertLess(self.source.rfind("installCrashRecorder()"), self.source.rfind("TeamClaudePalette.prewarm()"),
                        "the recorder must be installed before the palette is pre-warmed")


if __name__ == "__main__":
    unittest.main()
