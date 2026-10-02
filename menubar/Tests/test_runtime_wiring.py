from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


class RuntimeWiringTests(unittest.TestCase):
    def test_team_claude_table_decodes_and_draws_runtime(self):
        main = (SOURCES / "main.swift").read_text()
        self.assertIn("var runtimeSummary: String? = nil", main)
        self.assertIn('teamRuntimeSummary(status?["runtime"]', main)
        self.assertIn("health.runtimeSummary", main)
        # 쿼터 유지·병합 경로가 새 TeamClaudeHealth를 만들 때 runtime 줄을 잃지 않아야 한다.
        self.assertGreaterEqual(main.count("merged.runtimeSummary = candidate.runtimeSummary"), 2)
        # 축약본도 같은 세 경로를 따라야 하고, 헤더는 폭 계산 헬퍼로 그려야 한다(액션 박스 겹침 방지).
        self.assertIn("var runtimeSummaryShort: String? = nil", main)
        self.assertIn('teamRuntimeSummary(status?["runtime"], short: true)', main)
        self.assertGreaterEqual(main.count("merged.runtimeSummaryShort = candidate.runtimeSummaryShort"), 2)
        self.assertIn("teamServerLine(", main)

    def test_codex_card_decodes_and_draws_runtime(self):
        pool = (SOURCES / "TeamCodexPoolStatus.swift").read_text()
        view = (SOURCES / "CodexStatusView.swift").read_text()
        self.assertIn("var runtimeSummary: String? = nil", pool)
        self.assertIn('teamRuntimeSummary(', pool)
        self.assertIn("pool.runtimeSummary", view)
        main = (SOURCES / "main.swift").read_text()
        # 정렬 함수가 새 TeamCodexPoolHealth를 만들 때 runtime 줄을 잃지 않아야 한다(운영 경로는 항상 정렬을 거친다).
        self.assertIn("runtimeSummary: pool.runtimeSummary", main)


if __name__ == "__main__":
    unittest.main()
