"""Codex 풀 행 배치 직접 검사(Phase 2 독립 리뷰 Important: 구독 버튼이 보조 줄을 덮음).

CodexStatusView.swift는 main.swift 타입에 의존해 러너의 Swift 묶음(EXCLUDE_SOURCES) 밖이다.
여기서 main.swift 진입점 앞부분만 잘라 붙여 실제 생산 타입으로 CodexPoolRowLayoutTests.swift를 컴파일하고,
구독 버튼이 ~/.config 아래 설정을 읽으므로 격리 HOME(CFFIXED_USER_HOME)에서 실행한다."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MENUBAR = ROOT / "menubar"
ENTRY_MARKER = "// MARK: - 진입점"


class CodexPoolRowLayoutTest(unittest.TestCase):
    def test_subscription_band_does_not_cover_row_text(self):
        with tempfile.TemporaryDirectory(prefix="cc-codex-row-layout-") as directory:
            work = pathlib.Path(directory)
            main_source = (MENUBAR / "Sources/main.swift").read_text()
            self.assertEqual(1, main_source.count(ENTRY_MARKER))
            declarations = work / "ProductionTypes.swift"
            declarations.write_text(main_source.split(ENTRY_MARKER)[0])
            sources = sorted(p for p in (MENUBAR / "Sources").glob("*.swift") if p.name != "main.swift")
            self.assertIn("CodexStatusView.swift", [p.name for p in sources])
            executable = work / "codex-row-layout-tests"
            result = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1", "-framework", "Cocoa",
                                     "-framework", "Foundation", *map(str, sources), str(declarations),
                                     str(MENUBAR / "Tests/CodexPoolRowLayoutTests.swift"), "-o", str(executable)],
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(0, result.returncode, result.stderr[-4000:])
            home = work / "home"
            (home / ".config").mkdir(parents=True)
            args = [str(executable)]
            screenshot = os.environ.get("CC_MENUBAR_ROW_LAYOUT_PNG")
            if screenshot:
                args += ["--screenshot", screenshot]
            result = subprocess.run(args, capture_output=True, text=True, timeout=60, cwd=home,
                                    env={**os.environ, "HOME": str(home), "CFFIXED_USER_HOME": str(home),
                                         "CC_MENUBAR_LANG": "ko"})
            self.assertEqual(0, result.returncode, (result.stdout + result.stderr)[-4000:])
            self.assertIn("CODEX-ROW-LAYOUT: subscription band below facts/notes, recovery placement and section height passed",
                          result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
