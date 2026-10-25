"""실사용 QA(2026-10-25) 결함 고정 — 라우팅 판정·소비 지점·패널 높이·Grok 레인·소진 미리보기.

MenubarRoutabilityTests.swift는 main.swift의 TeamClaudeHealth·StatusMenuDashboardView를 쓴다.
러너의 Swift 묶음 밖이라 여기서 main.swift 진입점 앞부분만 잘라 붙여 실제 생산 타입으로 컴파일·실행한다."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MENUBAR = ROOT / "menubar"
ENTRY_MARKER = "// MARK: - 진입점"


class MenubarRoutabilityTest(unittest.TestCase):
    def test_routability_consumers_panel_height(self):
        with tempfile.TemporaryDirectory(prefix="cc-routability-") as directory:
            work = pathlib.Path(directory)
            main_source = (MENUBAR / "Sources/main.swift").read_text()
            self.assertEqual(1, main_source.count(ENTRY_MARKER))
            declarations = work / "ProductionTypes.swift"
            declarations.write_text(main_source.split(ENTRY_MARKER)[0])
            sources = sorted(p for p in (MENUBAR / "Sources").glob("*.swift") if p.name != "main.swift")
            executable = work / "routability-tests"
            result = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1", "-framework", "Cocoa",
                                     "-framework", "Foundation", *map(str, sources), str(declarations),
                                     str(MENUBAR / "Tests/MenubarRoutabilityTests.swift"), "-o", str(executable)],
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(0, result.returncode, result.stderr[-4000:])
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=120,
                                    env={**os.environ, "CC_MENUBAR_LANG": "ko"})
            self.assertEqual(0, result.returncode, (result.stdout + result.stderr)[-4000:])
            self.assertIn("MenubarRoutabilityTests: availability, consumers, panel height, grok lane, burn line passed",
                          result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
