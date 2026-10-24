# menubar/Tests/test_usage_load_outcome.py
"""ccusage 실패 분류(종료 코드·시간 초과·해석 불가)가 실제 로더와 대시보드에 도달하는지 확인한다.

UsageLoadOutcomeTests.swift는 main.swift의 AppDelegate·대시보드를 쓰므로 러너가 직접 컴파일하지 않는다.
여기서 main.swift의 진입점 앞(선언부)만 잘라 나머지 소스와 함께 컴파일하고, npx 자리에 가짜 실행 파일을 둔다."""
import datetime
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENTRY_MARKER = "// MARK: - 진입점"

FAKE_NPX = """#!/bin/sh
dir=$(dirname "$0")
case "$(cat "$dir/mode")" in
  exit) echo partial; exit 3 ;;
  garbage) echo "not json at all"; exit 0 ;;
  empty) exit 0 ;;
  nodata) echo '{"daily":[],"totals":{}}' ;;
  today) cat "$dir/today.json" ;;
  hang) trap '' TERM; exec /bin/sleep 30 ;;
esac
"""


class UsageLoadOutcomeTests(unittest.TestCase):
    def test_failures_are_not_reported_as_no_data(self):
        with tempfile.TemporaryDirectory(prefix="cc-menubar-usage-outcome-") as folder:
            folder = pathlib.Path(folder)
            main_source = (ROOT / "menubar/Sources/main.swift").read_text()
            self.assertEqual(main_source.count(ENTRY_MARKER), 1)
            declarations = folder / "ProductionMenuTypes.swift"
            declarations.write_text(main_source.split(ENTRY_MARKER)[0])
            sources = sorted(p for p in (ROOT / "menubar/Sources").glob("*.swift") if p.name != "main.swift")
            binary = folder / "usage-outcome-tests"
            build = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1",
                                    "-framework", "Cocoa", "-framework", "Foundation", *map(str, sources),
                                    str(declarations), str(ROOT / "menubar/Tests/UsageLoadOutcomeTests.swift"),
                                    "-o", str(binary)], capture_output=True, text=True, timeout=900)
            self.assertEqual(build.returncode, 0, build.stderr[-4000:])

            fake = folder / "fake"
            fake.mkdir()
            npx = fake / "npx"
            npx.write_text(FAKE_NPX)
            npx.chmod(0o755)
            today = datetime.date.today().isoformat()
            (fake / "today.json").write_text(json.dumps({
                "daily": [{"period": today, "totalCost": 1.25, "inputTokens": 10, "outputTokens": 5,
                           "cacheCreationTokens": 0, "cacheReadTokens": 0}],
                "totals": {"totalCost": 1.25, "totalTokens": 15},
            }))
            home = folder / "home"
            home.mkdir()
            env = {key: value for key, value in os.environ.items() if not key.startswith("CC_MENUBAR_")}
            env.update(HOME=str(home), CFFIXED_USER_HOME=str(home), CC_MENUBAR_NPX_BIN=str(npx))
            result = subprocess.run([str(binary), str(fake)], capture_output=True, text=True, timeout=120,
                                    env=env, cwd=str(home))
            self.assertEqual(result.returncode, 0, result.stdout[-4000:] + result.stderr[-4000:])
            self.assertIn("UsageLoadOutcomeTests: ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
