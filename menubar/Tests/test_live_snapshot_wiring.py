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

    def test_same_output_runs_are_serialized(self):
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        block = main[start:main.index("exit(0)", start)]
        self.assertIn("liveSnapshotOutputLock(", block)
        self.assertLess(block.index("liveSnapshotOutputLock("), block.index("delegate.refresh()"),
                        "같은 출력 이름의 실행은 갱신 전부터 렌더·정리 끝까지 잠금을 쥐어야 한다")

    def test_renders_into_staging_then_publishes(self):
        # 렌더 중간에 실패해도 이번 실행 이름에 반쯤 그린 결과가 남지 않게, 임시 폴더에 다 그린 뒤 옮긴다.
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        block = main[start:main.index("exit(0)", start)]
        self.assertIn("renderDashboardTabs(view, outputPath: stagedOutput", block)
        self.assertIn("publishLiveSnapshot(", block)

    def test_lock_and_names_use_resolved_path(self):
        # 심볼릭 링크로 같은 폴더를 다른 이름으로 가리켜도 같은 잠금을 얻어야 한다.
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index("func liveSnapshotResolvedOutput(")
        body = main[start:main.index("\n}\n", start)]
        self.assertIn("resolvingSymlinksInPath", body)
        block_start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        block = main[block_start:main.index("exit(0)", block_start)]
        self.assertIn("liveSnapshotOutputLock(resolvedOutput)", block)

    def test_read_only_is_set_before_appkit_init(self):
        main = (pathlib.Path(__file__).resolve().parents[1] / "Sources/main.swift").read_text()
        start = main.index('if let liveIndex = CommandLine.arguments.firstIndex(of: "--live-snapshot")')
        block = main[start:main.index("exit(0)", start)]
        self.assertLess(block.index("MenubarRunMode.readOnly = true"), block.index("NSApplication.shared"),
                        "AppKit 초기화 중 예외도 읽기 전용으로 다뤄지게 플래그를 먼저 세운다")


if __name__ == "__main__":
    unittest.main()
