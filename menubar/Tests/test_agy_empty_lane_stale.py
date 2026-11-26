# menubar/Tests/test_agy_empty_lane_stale.py
"""agy가 성공하지만 Gemini 레인이 없을 때 감시기가 "갱신 없음"을 붙이지 않는지, 실제 로더·감시기·이 맥 줄을 거쳐 본다.

AgyEmptyLaneStaleTests.swift는 main.swift의 AppDelegate를 쓰므로 러너가 직접 컴파일하지 않는다.
여기서 main.swift의 진입점 앞(선언부)만 잘라 나머지 소스와 함께 컴파일하고, agy 자리에 가짜 실행 파일을 둔다.
실제 홈을 쓰지 않는다(HOME·CFFIXED_USER_HOME을 임시 폴더로)."""
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENTRY_MARKER = "// MARK: - 진입점"

FAKE_AGY = """#!/bin/sh
dir=$(dirname "$0")
mode=$(cat "$dir/mode")
reset=$(date -u -v+5d +%Y-%m-%dT%H:%M:%SZ)
case "$mode" in
  gemini) name="Gemini Models" ;;
  claude) name="Claude Models" ;;
esac
printf '{"num_turns":0,"command":{"name":"usage","data":{"groups":[{"name":"%s","buckets":[{"window":"weekly","remaining_fraction":0.8,"reset_time":"%s"},{"window":"5h","remaining_fraction":0.9,"reset_time":"%s"}]}]}}}' "$name" "$reset" "$reset"
"""


class AgyEmptyLaneStaleTest(unittest.TestCase):
    def test_successful_read_without_gemini_lane_is_not_stale(self):
        with tempfile.TemporaryDirectory(prefix="cc-menubar-agy-empty-") as folder:
            folder = pathlib.Path(folder)
            main_source = (ROOT / "menubar/Sources/main.swift").read_text()
            self.assertEqual(main_source.count(ENTRY_MARKER), 1)
            declarations = folder / "ProductionMenuTypes.swift"
            declarations.write_text(main_source.split(ENTRY_MARKER)[0])
            sources = sorted(p for p in (ROOT / "menubar/Sources").glob("*.swift") if p.name != "main.swift")
            binary = folder / "agy-empty-lane-tests"
            build = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1",
                                    "-framework", "Cocoa", "-framework", "Foundation", *map(str, sources),
                                    str(declarations), str(ROOT / "menubar/Tests/AgyEmptyLaneStaleTests.swift"),
                                    "-o", str(binary)], capture_output=True, text=True, timeout=900)
            self.assertEqual(build.returncode, 0, build.stderr[-4000:])

            fake = folder / "fake"
            fake.mkdir()
            agy = fake / "agy"
            agy.write_text(FAKE_AGY)
            agy.chmod(0o755)
            home = folder / "home"
            home.mkdir()
            env = {"PATH": "/usr/bin:/bin", "HOME": str(home), "CFFIXED_USER_HOME": str(home),
                   "CC_MENUBAR_AGY_BIN": str(agy), "AGY_FAKE_DIR": str(fake), "CC_MENUBAR_LANG": "ko",
                   "TMPDIR": os.environ.get("TMPDIR", "/tmp")}
            result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=180, env=env)
            self.assertEqual(result.returncode, 0, result.stdout[-3000:] + result.stderr[-2000:])
            self.assertIn("AgyEmptyLaneStaleTests OK", result.stdout)
            self.assertNotIn("LANE-STALE: agy", result.stdout)


if __name__ == "__main__":
    unittest.main()
