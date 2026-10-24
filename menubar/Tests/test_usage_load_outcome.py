# menubar/Tests/test_usage_load_outcome.py
"""ccusage 실패 분류(종료 코드·시간 초과·해석 불가)가 실제 로더와 대시보드에 도달하는지 확인한다.

UsageLoadOutcomeTests.swift는 main.swift의 AppDelegate·대시보드를 쓰므로 러너가 직접 컴파일하지 않는다.
여기서 main.swift의 진입점 앞(선언부)만 잘라 나머지 소스와 함께 컴파일하고, npx 자리에 가짜 실행 파일을 둔다."""
import datetime
import json
import os
import pathlib
import shlex
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENTRY_MARKER = "// MARK: - 진입점"

FAKE_NPX = """#!/bin/sh
dir=$(dirname "$0")
PYTHON=@PYTHON@
mode=$(cat "$dir/mode")
# 진짜 ccusage처럼 weekly·monthly는 자기 기간 배열을 낸다(항목 없음). daily 모양을 weekly에 내지 않는다.
case "$mode" in
  nodata|today|yesterday|slow|fixedday)
    if [ "$3" != daily ]; then echo '{"'"$3"'":[]}'; exit 0; fi ;;
esac
case "$mode" in
  exit) echo partial; exit 3 ;;
  garbage) echo "not json at all"; exit 0 ;;
  empty) exit 0 ;;
  nodata) echo '{"daily":[],"totals":{}}' ;;
  today) cat "$dir/today.json" ;;
  yesterday) cat "$dir/yesterday.json" ;;
  slow)
    head -c 20 "$dir/today.json"; sleep 0.5; tail -c +21 "$dir/today.json" ;;
  hang) trap '' TERM; exec /bin/sleep 30 ;;
  flood)
    echo $$ > "$dir/flood.pid"
    trap '' TERM
    i=0; while [ $i -lt 128 ]; do head -c 65536 /dev/zero; i=$((i + 1)); done
    exec /bin/sleep 30 ;;
  burst) head -c 1048576 /dev/zero; exit 0 ;;
  fixedday)
    cat "$dir/fixedday.json" ;;
  bigwrite)
    # 한 번의 write()로 64MB를 낸다. 끝까지 써지면(파일로 받으면 그렇다) 표시 파일을 남긴다.
    echo $$ > "$dir/flood.pid"
    trap '' TERM
    "$PYTHON" -c 'import os, sys; os.write(1, b"x" * (64 << 20)); open(sys.argv[1], "w").write("done")' "$dir/bigwrite.done"
    exec /bin/sleep 30 ;;
  orphan)
    # 직접 자식은 바로 끝나고, 같은 그룹의 손자가 TERM을 무시한 채 계속 쓴다.
    echo $$ > "$dir/flood.pid"
    /bin/sh -c 'trap "" TERM; while :; do echo x; /bin/sleep 0.1; done' &
    echo $! > "$dir/orphan.pid"
    exit 0 ;;
  native)
    cat "$dir/$3-native.json" ;;
  monthlyflood)
    if [ "$3" = monthly ]; then
      trap '' TERM
      i=0; while [ $i -lt 128 ]; do head -c 65536 /dev/zero; i=$((i + 1)); done
      exec /bin/sleep 30
    fi
    cat "$dir/$3-native.json" ;;
  monthlyexit)
    if [ "$3" = monthly ]; then echo partial; exit 3; fi
    cat "$dir/$3-native.json" ;;
  auxexit)
    if [ "$3" != daily ]; then echo partial; exit 3; fi
    cat "$dir/$3-native.json" ;;
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
            npx.write_text(FAKE_NPX.replace("@PYTHON@", shlex.quote(sys.executable)))
            npx.chmod(0o755)
            today = datetime.date.today().isoformat()
            (fake / "today.json").write_text(json.dumps({
                "daily": [{"period": today, "totalCost": 1.25, "inputTokens": 10, "outputTokens": 5,
                           "cacheCreationTokens": 0, "cacheReadTokens": 0}],
                "totals": {"totalCost": 1.25, "totalTokens": 15},
            }))
            yesterday = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
            (fake / "yesterday.json").write_text(json.dumps({
                "daily": [{"period": yesterday, "totalCost": 7.77, "inputTokens": 70, "outputTokens": 7,
                           "cacheCreationTokens": 0, "cacheReadTokens": 0}],
                "totals": {"totalCost": 7.77, "totalTokens": 77},
            }))
            # 자정 경계 검사용 지난 날짜 하루치(실제 오늘과 겹치지 않는다).
            (fake / "fixedday.json").write_text(json.dumps({
                "daily": [{"period": "2020-01-15", "totalCost": 4.5, "inputTokens": 40, "outputTokens": 5,
                           "cacheCreationTokens": 0, "cacheReadTokens": 0}],
                "totals": {"totalCost": 4.5, "totalTokens": 45},
            }))
            # 부분 갱신 검사용 native 세 벌. daily는 today.json과 같고, weekly·monthly는 이번 주·이번 달 항목을 둔다.
            this_day = datetime.date.today()
            monday = (this_day - datetime.timedelta(days=this_day.weekday())).isoformat()
            (fake / "daily-native.json").write_text((fake / "today.json").read_text())
            (fake / "weekly-native.json").write_text(json.dumps({
                "weekly": [{"period": monday, "totalCost": 3.0, "totalTokens": 30}],
                "totals": {"totalCost": 3.0, "totalTokens": 30},
            }))
            (fake / "monthly-native.json").write_text(json.dumps({
                "monthly": [{"period": this_day.strftime("%Y-%m"), "totalCost": 9.5, "totalTokens": 95,
                             "modelBreakdowns": [{"modelName": "claude-opus-4-8", "cost": 9.5, "inputTokens": 50,
                                                  "outputTokens": 45, "cacheCreationTokens": 0,
                                                  "cacheReadTokens": 0}]}],
                "totals": {"totalCost": 20.0, "totalTokens": 200},
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
