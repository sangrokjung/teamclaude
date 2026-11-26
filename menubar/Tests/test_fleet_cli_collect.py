"""scripts/fleet-cli-collect.py 회귀 테스트(표준 라이브러리 unittest, pytest도 수집한다).

실행: python3 menubar/Tests/test_fleet_cli_collect.py (menubar/run-tests.sh가 함께 돌린다)
가짜 ssh(호스트 이름으로 응답을 고르는 셸 스크립트)로 정상·손상·schema 불일치·연결 실패·꺼짐·시간 초과를 만든다.
실제 홈·실제 ssh는 쓰지 않는다(모든 경로를 임시 폴더로 넘긴다).
"""
from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/fleet-cli-collect.py"
SPEC = importlib.util.spec_from_file_location("fleet_cli_collect", SCRIPT)
assert SPEC and SPEC.loader
collect = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collect
SPEC.loader.exec_module(collect)


def snapshot(host="node-a", **overrides):
    base = {
        "schema": 1, "host": host, "written_at": int(time.time()) - 20,
        "grok": {"installed": True, "auth": "ok", "usage_pct": 12.5, "period_end": "2026-11-30T00:00:00Z",
                 "last_used": "2026-11-26T09:00:00Z", "sessions_today": 4},
        "agy": {"installed": True, "auth": "ok",
                "groups": [{"name": "Gemini Models", "weekly_remaining_pct": 78, "weekly_reset": None,
                            "five_hour_remaining_pct": 95, "five_hour_reset": None}],
                "last_used": None, "conversations_today": 2},
    }
    base.update(overrides)
    return base


FAKE_SSH = """#!/bin/sh
# 가짜 ssh: 인자에서 호스트를 골라 미리 둔 응답을 낸다. 받은 인자는 기록한다.
echo "$@" >> "$FAKE_SSH_DIR/calls.log"
for arg in "$@"; do
  case "$arg" in
    -o|BatchMode=yes|ConnectTimeout=5|head|-c|262145|"~/.cache/cc-menubar/cli-status.json") ;;
    *) host="$arg" ;;
  esac
done
case "$host" in
  good-*) cat "$FAKE_SSH_DIR/$host.json"; exit 0 ;;
  broken) printf '{"schema":1,'; exit 0 ;;
  oldschema) printf '{"schema":2,"host":"x"}'; exit 0 ;;
  nofile) echo "cat: no such file" >&2; exit 1 ;;
  down|laptop) echo "ssh: connect: Host is down" >&2; exit 255 ;;
  slow) sleep 30; exit 0 ;;
  nap-*) sleep 2; exit 1 ;;
  flood) exec yes ;;
  stall) printf '{"schema":1,'; exec sleep 30 ;;
esac
exit 1
"""


class FleetCliCollectTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ssh = self.dir / "ssh"
        self.ssh.write_text(FAKE_SSH)
        self.ssh.chmod(self.ssh.stat().st_mode | stat.S_IEXEC)
        os.environ["FAKE_SSH_DIR"] = str(self.dir)
        (self.dir / "good-a.json").write_text(json.dumps(snapshot("good-a")))
        (self.dir / "good-b.json").write_text(json.dumps(snapshot("good-b", extra_secret="must-not-pass")))
        self.local = self.dir / "local.json"
        self.local.write_text(json.dumps(snapshot("hub-host")))
        self.out = self.dir / "cache" / "fleet-cli.json"
        self.manifest = self.dir / "manifest.json"
        self.manifest.write_text(json.dumps({"nodes": [
            {"id": "a", "host": "good-a"}, {"id": "b", "host": "good-b"}, {"host": "broken"},
            {"host": "oldschema"}, {"host": "nofile"}, {"host": "down"},
            {"host": "laptop", "menubarOfflineOk": True}, {"host": "good-a"}, {"host": "-oProxyCommand=x"},
        ]}))

    def tearDown(self):
        os.environ.pop("FAKE_SSH_DIR", None)
        self.tmp.cleanup()

    def run_once(self, *extra):
        return collect.main(["--manifest", str(self.manifest), "--out", str(self.out), "--local", str(self.local),
                             "--ssh", str(self.ssh), "--once", *extra])

    def test_collects_every_host_in_manifest_order(self):
        self.assertEqual(0, self.run_once())
        data = json.loads(self.out.read_text())
        self.assertIsInstance(data["collected_at"], int)
        names = [host["name"] for host in data["hosts"]]
        # 본체 자기 파일이 맨 앞, 매니페스트 순서, 중복·옵션처럼 생긴 호스트는 뺀다.
        self.assertEqual(["hub", "good-a", "good-b", "broken", "oldschema", "nofile", "down", "laptop"], names)
        by = {host["name"]: host for host in data["hosts"]}
        self.assertTrue(by["hub"]["ok"])
        self.assertEqual("hub-host", by["hub"]["status"]["host"])
        self.assertTrue(by["good-a"]["ok"])
        self.assertIsNone(by["good-a"]["error"])
        self.assertEqual(12.5, by["good-a"]["status"]["grok"]["usage_pct"])

    def test_failures_are_per_host(self):
        self.run_once()
        by = {host["name"]: host for host in json.loads(self.out.read_text())["hosts"]}
        expected = {"broken": "parse", "oldschema": "parse", "nofile": "missing", "down": "ssh", "laptop": "offline"}
        for name, error in expected.items():
            with self.subTest(name=name):
                self.assertFalse(by[name]["ok"])
                self.assertEqual(error, by[name]["error"])
                self.assertIsNone(by[name]["status"])

    def test_unknown_keys_are_dropped(self):
        self.run_once()
        by = {host["name"]: host for host in json.loads(self.out.read_text())["hosts"]}
        text = json.dumps(by["good-b"])
        self.assertNotIn("must-not-pass", text)
        self.assertNotIn("extra_secret", text)

    def test_ssh_is_called_non_interactively(self):
        self.run_once()
        calls = (self.dir / "calls.log").read_text().splitlines()
        self.assertTrue(calls)
        for line in calls:
            self.assertTrue(line.startswith("-o BatchMode=yes -o ConnectTimeout=5 "), line)
            self.assertTrue(line.endswith(" head -c 262145 ~/.cache/cc-menubar/cli-status.json"), line)
        self.assertFalse(any("ProxyCommand" in line for line in calls))

    def test_timeout_marks_only_that_host(self):
        self.manifest.write_text(json.dumps({"nodes": [{"host": "slow"}, {"host": "good-a"}]}))
        # 시간 상한은 바쁜 워커에서도 정상 호스트가 넉넉히 끝나게 4초로 둔다. 느린 호스트는 30초를 잔다.
        started = time.time()
        self.assertEqual(0, self.run_once("--timeout", "4"))
        self.assertLess(time.time() - started, 15.0)
        by = {host["name"]: host for host in json.loads(self.out.read_text())["hosts"]}
        self.assertEqual("timeout", by["slow"]["error"])
        self.assertTrue(by["good-a"]["ok"])

    def test_oversize_output_is_cut_without_reading_it_all(self):
        # 끝없는 출력(yes)도 상한+1바이트에서 끊고 "oversize"로 둔다. 시간 초과까지 기다리지 않는다.
        started = time.time()
        result = collect.read_remote("flood", False, ssh=str(self.ssh), timeout=10)
        self.assertLess(time.time() - started, 5.0)
        self.assertEqual({"name": "flood", "ok": False, "error": "oversize", "status": None}, result)

    def test_partial_output_then_stall_times_out(self):
        # 일부를 보낸 뒤 멈춘 호스트도 호스트당 시간 상한에서 끊는다.
        started = time.time()
        result = collect.read_remote("stall", False, ssh=str(self.ssh), timeout=2)
        self.assertLess(time.time() - started, 15.0)
        self.assertEqual("timeout", result["error"])

    def test_oversize_local_file(self):
        self.local.write_bytes(b"{" + b" " * (collect.MAX_BYTES + 10) + b"}")
        self.assertEqual("oversize", collect.read_local("hub", str(self.local))["error"])

    def test_missing_local_file_and_atomic_write(self):
        self.local.unlink()
        self.run_once()
        data = json.loads(self.out.read_text())
        self.assertEqual({"name": "hub", "ok": False, "error": "missing", "status": None}, data["hosts"][0])
        # 임시 파일이 남지 않는다.
        self.assertEqual(["fleet-cli.json"], sorted(os.listdir(self.out.parent)))

    def test_hosts_are_read_in_parallel_with_a_cap(self):
        # nap-* 호스트는 2초씩 잔다. 4대를 차례로 읽으면 8초, 병렬이면 2초 남짓이다. jobs는 8을 넘지 않는다.
        nodes = [(f"nap-{i}", False) for i in range(4)]
        started = time.time()
        payload = collect.collect(nodes, str(self.local), ssh=str(self.ssh), jobs=50, timeout=10)
        self.assertLess(time.time() - started, 6.0)
        self.assertEqual(5, len(payload["hosts"]))
        self.assertEqual(8, collect.MAX_JOBS)

    def test_bad_manifest_exits_2_without_writing(self):
        self.manifest.write_text("{not json")
        self.assertEqual(2, self.run_once())
        self.assertFalse(self.out.exists())

    def test_sanitize_rejects_bad_shapes(self):
        good = snapshot()
        self.assertIsNotNone(collect.sanitize_status(good))
        for bad in ({**good, "schema": True}, {**good, "schema": 2}, {**good, "host": ""},
                    {**good, "grok": {**good["grok"], "auth": "maybe"}},
                    {**good, "agy": {**good["agy"], "installed": "yes"}}, [], "x"):
            with self.subTest(bad=str(bad)[:60]):
                self.assertIsNone(collect.sanitize_status(bad))
        clamped = collect.sanitize_status({**good, "grok": {**good["grok"], "usage_pct": 400}})
        self.assertIsNone(clamped["grok"]["usage_pct"])

    def test_cli_once_runs_as_a_script(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--manifest", str(self.manifest), "--out", str(self.out),
                                 "--local", str(self.local), "--ssh", str(self.ssh), "--once"],
                                capture_output=True, text=True, timeout=60, env={**os.environ})
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("hosts=8", result.stdout)


if __name__ == "__main__":
    unittest.main()
