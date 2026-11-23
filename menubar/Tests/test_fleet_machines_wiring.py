# menubar/Tests/test_fleet_machines_wiring.py
"""머신 줄(FleetMachines) 배선을 소스로 고정한다.

- 높이(contentHeight)·버튼 배치(layout)·그리기(draw)가 같은 줄 수(health.hostLineCount)를 쓴다.
  한 곳만 Bool 판정으로 남으면 머신 줄이 생길 때 행과 버튼이 20pt 어긋난다.
- 상태 로드가 수집기 파일을 읽고, 병합 두 곳이 머신 값을 다음 상태로 넘긴다(빠지면 1분마다 줄이 깜빡인다)."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAIN = ROOT / "menubar" / "Sources" / "main.swift"


class FleetMachinesWiringTests(unittest.TestCase):
    def setUp(self):
        self.main = MAIN.read_text()

    def test_every_card_metric_call_uses_the_shared_line_count(self):
        calls = re.findall(r"(?:TeamClaudeCardMetrics\.\w+|teamClaudeCardBaseHeight)\((hostLines?):\s*([^,)]+)", self.main)
        self.assertGreaterEqual(len(calls), 8)
        for label, value in calls:
            with self.subTest(value=value):
                self.assertEqual(label, "hostLines")
                self.assertIn(value.strip(), {"health.hostLineCount", "hostLines"})
        self.assertIn("let hostLines = health.hostLineCount", self.main)

    def test_line_count_counts_host_and_machine_lines(self):
        self.assertIn(
            "var hostLineCount: Int { (hostSummaryText != nil ? 1 : 0) + (machinesSummaryText != nil ? 1 : 0) }",
            self.main,
        )

    def test_load_reads_collector_and_merges_keep_it(self):
        load = self.main[self.main.index("func loadTeamClaudeHealth()"):]
        load = load[:load.index("\n}\n")]
        self.assertIn(".withMachines(FleetMachines.load())", load)
        self.assertEqual(self.main.count("merged.machines = candidate.machines"), 2)

    def test_draw_places_machine_line_below_host_line(self):
        draw = self.main[self.main.index("var summaryY = topY + TeamClaudeCardMetrics.headerHeight"):]
        draw = draw[:draw.index("// 측정·연동 안내")]
        self.assertLess(draw.index("hostSummaryText"), draw.index("machinesSummaryText"))
        self.assertIn("summaryY += TeamClaudeCardMetrics.hostLineHeight", draw)
        self.assertIn("PanelDraw.clipped(machinesText", draw)


if __name__ == "__main__":
    unittest.main()
