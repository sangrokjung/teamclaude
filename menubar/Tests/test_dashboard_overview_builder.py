"""makeOverviewModel 직접 검사(Phase 2 리뷰 증거 공백).

DashboardOverviewBuilder.swift는 main.swift의 TeamClaudeHealth를 읽어 러너의 Swift 묶음(EXCLUDE_SOURCES) 밖이다.
여기서 main.swift 진입점 앞부분만 잘라 붙여 실제 생산 타입으로 DashboardOverviewBuilderTests.swift를 컴파일하고,
스냅샷과 같은 픽스처(make_dash_fixture.py --codex)를 넘겨 개요 숫자·레인·손볼 것을 단언한다."""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MENUBAR = ROOT / "menubar"
ENTRY_MARKER = "// MARK: - 진입점"


class DashboardOverviewBuilderTest(unittest.TestCase):
    def test_make_overview_model_from_fixture(self):
        with tempfile.TemporaryDirectory(prefix="cc-overview-builder-") as directory:
            work = pathlib.Path(directory)
            main_source = (MENUBAR / "Sources/main.swift").read_text()
            self.assertEqual(1, main_source.count(ENTRY_MARKER))
            declarations = work / "ProductionTypes.swift"
            declarations.write_text(main_source.split(ENTRY_MARKER)[0])
            sources = sorted(p for p in (MENUBAR / "Sources").glob("*.swift") if p.name != "main.swift")
            self.assertIn("DashboardOverviewBuilder.swift", [p.name for p in sources])
            executable = work / "overview-builder-tests"
            result = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1", "-framework", "Cocoa",
                                     "-framework", "Foundation", *map(str, sources), str(declarations),
                                     str(MENUBAR / "Tests/DashboardOverviewBuilderTests.swift"), "-o", str(executable)],
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(0, result.returncode, result.stderr[-4000:])
            fixture = work / "fixture.json"
            subprocess.run([sys.executable, str(MENUBAR / "Tests/make_dash_fixture.py"), str(fixture), "--codex"],
                           check=True, capture_output=True, timeout=60)
            result = subprocess.run([str(executable), str(fixture)], capture_output=True, text=True, timeout=60,
                                    env={**os.environ, "CC_MENUBAR_LANG": "ko"})
            self.assertEqual(0, result.returncode, (result.stdout + result.stderr)[-4000:])
            self.assertIn("DashboardOverviewBuilderTests: counts, lanes, todos, waiting, notices passed", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
