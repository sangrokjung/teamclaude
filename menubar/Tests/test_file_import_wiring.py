# menubar/Tests/test_file_import_wiring.py
"""파일 넣기 배선 회귀(소스 정규식). FileImporters.swift의 순수 부분은 FileImportersTests.swift가 본다.
여기서는 main.swift가 그 부분을 실제로 쓰는지만 본다: 60초 배경 읽기가 importers.json을 읽고, 동작 목록(⌘K)에
넣기 항목이 들어가고, 메뉴바 아이콘 창이 끌어다 놓기를 받고, 설정이 비면 등록을 푼다."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


def function_body(source, signature):
    start = source.index(signature)
    end = source.index("\n    }\n", start)
    return source[start:end]


class FileImportWiringTests(unittest.TestCase):
    def setUp(self):
        self.main = (SOURCES / "main.swift").read_text()
        self.tracker = (SOURCES / "CliLocalTracker.swift").read_text()
        self.importers = (SOURCES / "FileImporters.swift").read_text()
        self.host = (SOURCES / "FileImportHost.swift").read_text()

    def test_background_scan_reads_importers(self):
        self.assertIn("importers: FileImporters.load()", self.tracker)
        self.assertIn("self.applyImporters(scan.importers)", self.main)

    def test_action_list_has_import_entries(self):
        actions = function_body(self.main, "    func dashboardActions(menu: NSMenu) -> [DashboardAction] {")
        self.assertIn("fileImportActions(currentImporters)", actions)
        self.assertIn("chooseFilesForImport(importer, menu: menu)", actions)

    def test_apply_importers_rebuilds_actions_and_drop_target(self):
        apply = function_body(self.host, "    func applyImporters(_ importers: [FileImporter]) {")
        self.assertIn("ensureFileDropTarget()", apply)
        self.assertIn("dashboard.actions = dashboardActions(menu: menu)", apply)

    def test_choose_closes_menu_and_runs_import(self):
        choose = self.host[self.host.index("    func chooseFilesForImport("):]
        choose = choose[:choose.index("\n    /// 고른 파일")]
        self.assertIn("menu?.cancelTracking()", choose)
        self.assertIn("allowsMultipleSelection = true", choose)
        self.assertIn("runFileImport(importer, urls: panel.urls)", choose)

    def test_drop_target_follows_config(self):
        ensure = function_body(self.host, "    func ensureFileDropTarget() {")
        self.assertIn("registerForDraggedTypes([.fileURL])", ensure)
        self.assertIn("previous.unregisterDraggedTypes()", ensure)
        self.assertIn("if window.delegate == nil { window.delegate = self }", ensure)
        self.assertIn("guard window.delegate === self else {", ensure)
        self.assertLess(ensure.index("guard window.delegate === self"), ensure.index("fileDropWindow = window"),
                        "the window is remembered only after this app is its receiver")
        self.assertIn("self.ensureFileDropTarget()", self.main.split("func updateTitle()", 1)[1][:400])

    def test_drop_delegate_uses_first_importer_and_candidates(self):
        ext = self.host[self.host.index("extension AppDelegate: NSWindowDelegate, NSDraggingDestination {"):]
        self.assertIn("func draggingEntered(", ext)
        self.assertIn("fileDropOperation(sender)", ext)
        self.assertIn("return runFileImport(importer, urls: droppedFileURLs(sender))", ext, "the drop reports whether it was taken")
        verdict = function_body(self.host, "    func fileDropOperation(")
        self.assertIn("sender.draggingSequenceNumber", verdict, "one check per drag session")
        self.assertIn("fileImportHasCandidate(", verdict)
        self.assertIn("!fileImportRunner.isRunning", verdict, "no drop while an import runs")

    def test_host_is_kept_out_of_the_library_bundle(self):
        self.assertIn("EXCLUDE_SOURCES+=(FileImportHost.swift)", (ROOT / "menubar" / "run-tests.sh").read_text())

    def test_command_runs_without_a_shell(self):
        self.assertIn("process.executableURL = URL(fileURLWithPath: importer.command[0])", self.importers)
        self.assertNotIn('"/bin/sh"', self.importers)
        self.assertNotIn('"-c"', self.importers)

    def test_no_home_paths_in_sources(self):
        # 넣기 명령·경로는 이 맥의 importers.json에만 둔다. 소스에 홈 경로가 박히면 공개 저장소로 새어 나간다.
        for name in ("FileImporters.swift", "FileImportHost.swift", "main.swift", "L10n.swift"):
            text = (SOURCES / name).read_text()
            for marker in ("/Users/", "/home/"):
                self.assertNotIn(marker, text, f"{marker} must not appear in {name}")


if __name__ == "__main__":
    unittest.main()
