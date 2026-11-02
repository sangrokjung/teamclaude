"""모델 탭 데이터(currentModelUsage)가 모든 소비 지점에 닿는지 소스로 고정한다.

계산해 놓고 화면 일부에만 넘기는 실수가 반복됐다. 열린 패널·닫힌 메뉴 캐시·새로 만드는 패널·두 스냅샷 경로·
하단 막대 요약·QA 키가 모두 같은 값을 받는지 본다. 실제 그리기는 ModelUsageTabLayoutTests와 로케일 스냅샷이 본다."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


def block(text, start_marker, end_marker="\n    }\n"):
    start = text.index(start_marker)
    return text[start:text.index(end_marker, start)]


class ModelUsageWiringTests(unittest.TestCase):
    def setUp(self):
        self.main = (SOURCES / "main.swift").read_text()

    def test_every_app_dashboard_update_gets_the_model_report(self):
        for marker in ("    func refreshOpenDashboard(", "    func updateCachedMenuPresentation("):
            with self.subTest(marker=marker):
                body = block(self.main, marker)
                self.assertIn("dashboard.modelUsage = currentModelUsage", body)
                self.assertLess(body.index("dashboard.modelUsage = currentModelUsage"), body.index("dashboard.updateContent("))
        menu = self.main[self.main.index("dashboard.actions = dashboardActions(menu: menu)"):]
        self.assertLess(menu.index("dashboard.modelUsage = currentModelUsage"), menu.index("dashboard.configure("))

    def test_loader_runs_on_refresh_and_the_minute_tick_and_reads_only_the_json(self):
        self.assertIn("loadModelUsageInBackground()", block(self.main, "    func refresh() {"))
        timer = self.main[self.main.index("codexScanTimer = Timer.scheduledTimer"):]
        self.assertIn("loadModelUsageInBackground()", timer[:timer.index("RunLoop.main.add")])
        loader = block(self.main, "    func loadModelUsageInBackground()")
        self.assertIn("ModelUsageReport.load(path: path)", loader)
        self.assertNotIn(".jsonl", loader, "the app never scans session logs itself")

    def test_dashboard_view_passes_the_report_to_layout_view_and_summaries(self):
        configure = block(self.main, "    func configure(")
        self.assertIn("modelUsage: modelUsage, modelSelection: modelSelection", configure)
        self.assertIn('case "model":', configure)
        self.assertIn("model.report = modelUsage", configure)
        self.assertIn("withModelSummary(Self.sectionSummaries(", configure)
        update = block(self.main, "    func updateContent(")
        self.assertIn("withModelSummary(Self.sectionSummaries(", update)
        self.assertIn('case .model: return sections.first { $0.id == "model" }?.summary ?? ""', self.main)

    def test_snapshot_paths_feed_the_model_tab(self):
        empty = self.main[self.main.index('firstIndex(of: "--empty-home-snapshot")'):]
        empty = empty[:empty.index("exit(0)")]
        self.assertIn("delegate.currentModelUsage = ModelUsageReport.load()", empty)
        self.assertLess(empty.index("view.modelUsage = delegate.currentModelUsage"), empty.index("view.configure("))
        dash = self.main[self.main.index('firstIndex(of: "--dashboard-snapshot")'):]
        dash = dash[:dash.index("exit(0)")]
        self.assertIn('fixture["modelUsage"]', dash)
        self.assertLess(dash.index("view.modelUsage ="), dash.index("view.configure("))

    def test_qa_hook_knows_key_six(self):
        protocol = (SOURCES / "QAProtocol.swift").read_text()
        self.assertRegex(protocol, r'supportedKeys = Set\(\[[^\]]*"6"')
        runtime = (SOURCES / "QAAppRuntime.swift").read_text()
        self.assertIn('case "6": keyCode = 22', runtime)
        qa = (ROOT / "menubar" / "qa.sh").read_text()
        self.assertIn('{"key": "6"}, {"capture": "model"}', qa)

    def test_collector_has_no_runtime_dependencies(self):
        source = (ROOT / "scripts" / "model-usage-collector.py").read_text()
        imports = set(re.findall(r"^(?:import|from) ([a-z0-9_.]+)", source, re.M))
        allowed = {"__future__", "argparse", "datetime", "hashlib", "json", "os", "plistlib", "re", "shutil", "sqlite3", "statistics",
                   "subprocess", "sys", "tempfile", "urllib.request", "pathlib"}
        self.assertLessEqual(imports, allowed)


if __name__ == "__main__":
    unittest.main()
