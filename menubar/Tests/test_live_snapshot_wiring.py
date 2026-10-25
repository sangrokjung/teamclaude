"""--live-snapshot(실데이터 경로 스냅샷)이 픽스처가 아니라 실행 중인 앱과 같은 경로를 타는지 소스로 고정한다.

실행 검사(빈 HOME에서 탭 다섯 장·읽기 전용)는 build.sh가 돌리는 snapshot_test_empty_home.py의 LiveSnapshotReadOnlyTests가 한다.
실제 맥에서의 확인은 사람이 README의 명령으로 한다(프록시·계정이 있는 맥에서만 의미가 있다)."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCES = ROOT / "menubar" / "Sources"


class LiveSnapshotWiringTests(unittest.TestCase):
    def setUp(self):
        main = (SOURCES / "main.swift").read_text()
        start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        self.branch = main[start:main.index("\n}\n", start)]
        self.main = main

    def test_uses_the_app_loaders_and_menu_path(self):
        self.assertIn("MenubarRunMode.readOnly = true", self.branch)
        self.assertLess(self.branch.index("MenubarRunMode.readOnly = true"), self.branch.index("AppDelegate()"),
                        "read-only must be on before any loader runs")
        self.assertIn("delegate.refresh()", self.branch, "same first refresh as applicationDidFinishLaunching")
        self.assertIn("delegate.menuWillOpen(menu)", self.branch, "same panel construction as opening the menu")
        self.assertIn("delegate.cachedDashboardView", self.branch)
        for fixture in ("parseTeamClaudeHealth(", "subscriptionBurnFixture(", "make_dash_fixture", "JSONSerialization"):
            self.assertNotIn(fixture, self.branch, "the live path must not read a fixture")
        launch = self.main[self.main.index("func applicationDidFinishLaunching"):]
        self.assertIn("refresh()", launch[:launch.index("rollTimer")])

    def test_read_only_guards(self):
        self.assertIn("!MenubarRunMode.readOnly", self.main[self.main.index("func loadTeamClaudeStatusInBackground"):
                                                            self.main.index("func loadCodexStatusInBackground")])
        self.assertIn("!MenubarRunMode.readOnly", self.main[self.main.index("func recordQuotaObservation"):
                                                            self.main.index("private func burnMean")])
        subscription = (SOURCES / "AccountSubscription.swift").read_text()
        profile = subscription[subscription.index("func refreshProfile("):]
        self.assertRegex(profile[:400], r"guard !MenubarRunMode\.readOnly else \{ return \}")
        loader = (SOURCES / "CodexStatusLoader.swift").read_text()
        persist = loader[loader.index("private func persistCodexSessionFileStatsCache("):]
        self.assertRegex(persist[:300], r"guard !MenubarRunMode\.readOnly else \{ return \}")
        # 동작 경로(재시작·재인증·측정)를 부르지 않는다.
        for action in ("restartTeamClaudeAction", "measureTeamClaudeAction", "reauthenticate", "recoverTeamCodexAccount",
                       "kickstart", "forceRestart"):
            self.assertNotIn(action, self.branch)

    def test_documented(self):
        for readme in ("README.md", "README.ko.md"):
            text = (ROOT / "menubar" / readme).read_text()
            self.assertIn("--live-snapshot", text, readme)



class CrashRecorderReadOnlyTests(unittest.TestCase):
    def test_read_only_skips_crash_log_file(self):
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index("func installCrashRecorder()")
        body = main[start:main.index("\n}\n", start)]
        self.assertIn("MenubarRunMode.readOnly", body)
        self.assertLess(body.index("MenubarRunMode.readOnly"), body.index("cc-menubar-crash.log"),
                        "read-only(--live-snapshot)에서는 크래시 기록 파일을 만들기 전에 빠져야 한다")

    def test_publishes_whole_folder_once_without_overwrite(self):
        # 새 폴더 계약: 임시 폴더에 다 그린 뒤 RENAME_EXCL로 한 번에 올린다(덮어쓰기·반쪽 게시 없음).
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        block = main[start:main.index("exit(0)", start)]
        self.assertIn("lstat(outputDirectory", block)
        self.assertIn("mkdtemp(", block)
        self.assertIn("renamex_np(stagingDirectory, outputDirectory, UInt32(RENAME_EXCL))", block)
        self.assertLess(block.index("renderDashboardTab(view"), block.index("renamex_np("))

    def test_read_only_is_set_before_appkit_init(self):
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        block = main[start:main.index("exit(0)", start)]
        self.assertLess(block.index("MenubarRunMode.readOnly = true"), block.index("NSApplication.shared"),
                        "AppKit 초기화 중 예외도 읽기 전용으로 다뤄지게 플래그를 먼저 세운다")


if __name__ == "__main__":
    unittest.main()
