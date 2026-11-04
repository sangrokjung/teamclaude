"""status 필드 × 메뉴바 소비자 지도(StatusConsumerMapTests.swift) 실행기.

StatusConsumerMapTests는 실제 CodexStatusView를 화면 밖에 그려 그려진 글자를 비교한다. CodexStatusView는
main.swift 타입에 의존해 러너의 Swift 묶음(EXCLUDE_SOURCES) 밖이라, 여기서 main.swift 진입점 앞부분만 잘라 붙여
실제 생산 타입으로 컴파일하고, 구독 버튼이 ~/.config 아래 설정을 읽으므로 격리 HOME(CFFIXED_USER_HOME)에서 실행한다.
(test_codex_pool_row_layout.py와 같은 방식이다.)"""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MENUBAR = ROOT / "menubar"
ENTRY_MARKER = "// MARK: - 진입점"


class StatusConsumerMapTest(unittest.TestCase):
    def test_every_status_field_is_drawn_or_exempted(self):
        with tempfile.TemporaryDirectory(prefix="cc-status-consumer-map-") as directory:
            work = pathlib.Path(directory)
            main_source = (MENUBAR / "Sources/main.swift").read_text()
            self.assertEqual(1, main_source.count(ENTRY_MARKER))
            declarations = work / "ProductionTypes.swift"
            declarations.write_text(main_source.split(ENTRY_MARKER)[0])
            sources = sorted(p for p in (MENUBAR / "Sources").glob("*.swift") if p.name != "main.swift")
            self.assertIn("CodexStatusView.swift", [p.name for p in sources])
            executable = work / "status-consumer-map-tests"
            result = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1", "-framework", "Cocoa",
                                     "-framework", "Foundation", *map(str, sources), str(declarations),
                                     str(MENUBAR / "Tests/StatusConsumerMapTests.swift"), "-o", str(executable)],
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(0, result.returncode, result.stderr[-4000:])
            home = work / "home"
            (home / ".config").mkdir(parents=True)
            result = subprocess.run([str(executable)], capture_output=True, text=True, timeout=120, cwd=home,
                                    env={**os.environ, "HOME": str(home), "CFFIXED_USER_HOME": str(home),
                                         "CC_MENUBAR_LANG": "ko"})
            print(result.stdout, end="")
            self.assertEqual(0, result.returncode, (result.stdout + result.stderr)[-6000:])
            self.assertIn("STATUS-CONSUMER-MAP: menubar", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
