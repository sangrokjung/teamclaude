import hashlib
import importlib.util
import json
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("fleet_propagate", ROOT / "menubar/fleet-propagate.py")
fp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fp)


class Result:
    def __init__(self, returncode=0, stdout="", stderr=""):
        self.returncode, self.stdout, self.stderr = returncode, stdout, stderr


class FakeRunner:
    """launchctl·ps·selftest·ssh·scp를 흉내 낸다. 실패시킬 호스트를 고를 수 있다."""

    def __init__(self, binary, etimes=("01:00",), selftest_rc=0, comm=None, failing_hosts=(), hanging_hosts=(),
                 on_selftest=None):
        self.binary, self.etimes, self.selftest_rc = str(binary), list(etimes), selftest_rc
        self.comm = comm or self.binary
        self.failing_hosts = set(failing_hosts)
        self.hanging_hosts = set(hanging_hosts)
        self.on_selftest = on_selftest
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command[0] == "launchctl":
            return Result(stdout="\tpid = 42\n")
        if command[0] == "ps":
            if command[-1] == "comm=":
                return Result(stdout=self.comm)
            return Result(stdout=self.etimes.pop(0) if len(self.etimes) > 1 else self.etimes[0])
        if command[-1] == "--selftest":
            if self.on_selftest:
                self.on_selftest()
            return Result(self.selftest_rc, "SELFTEST reachable=true" if self.selftest_rc == 0 else "")
        host = command[-1].split(":")[0] if command[0].endswith("scp") else command[-2]
        if host in self.hanging_hosts and "input" in kwargs:
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 1))
        if host in self.failing_hosts:
            return Result(255, "", "ssh: connect timed out")
        if "input" in kwargs:
            return Result(0, "OK installed abc\n")
        return Result()

    def installs(self):
        return [c[-2] for c, k in self.calls if "input" in k]


class Clock:
    def __init__(self, start=1.9e9):
        self.value = start

    def __call__(self):
        return self.value


class FleetPropagateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cc-fleet-test-")
        self.base = pathlib.Path(self.tmp.name).resolve()  # 스크립트는 링크를 풀어 비교한다(/var → /private/var)
        self.binary = self.base / "app/cc-menubar"
        self.binary.parent.mkdir()
        self.write_binary(b"binary-v1")
        self.state = self.base / "state"
        self.state.mkdir()
        self.clock = Clock()
        self.manifest = {"menubar": str(self.binary), "nodes": [
            {"id": "a", "host": "host-a", "python": "/opt/py"},
            {"id": "b", "host": "host-b"},
            {"id": "off", "menubarAutoUpdate": False},
        ]}

    def tearDown(self):
        self.tmp.cleanup()

    def write_binary(self, data):
        self.binary.write_bytes(data)
        subprocess.run(["touch", "-t", "202001010000", str(self.binary)], check=True)

    def propagate(self, runner, clock=None):
        return fp.propagate(self.manifest, self.state, ROOT / "menubar", runner,
                            clock=clock or self.clock, sleep=lambda s: None)

    def state_nodes(self):
        return json.loads((self.state / "state.json").read_text())["nodes"]

    def test_installs_every_enabled_node_then_skips_same_hash(self):
        runner = FakeRunner(self.binary)
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual(runner.installs(), ["host-a", "host-b"])
        self.assertEqual(set(self.state_nodes()), {"a", "b"})
        self.assertTrue((self.state / "last-ok").exists())
        self.assertFalse((self.state / "FAILED").exists())
        second = FakeRunner(self.binary)
        self.assertEqual(self.propagate(second), 0)
        self.assertEqual(second.installs(), [])

    def test_same_build_is_reverified_after_interval_and_on_host_change(self):
        self.propagate(FakeRunner(self.binary))
        self.clock.value += fp.REVERIFY_SECONDS + 1  # 누가 워커를 손으로 되돌렸을 수 있다
        runner = FakeRunner(self.binary)
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual(runner.installs(), ["host-a", "host-b"])
        self.manifest["nodes"][1]["host"] = "host-b2"
        runner = FakeRunner(self.binary)
        self.propagate(runner)
        self.assertEqual(runner.installs(), ["host-b2"])

    def test_remote_command_quotes_stage_and_uses_node_python(self):
        runner = FakeRunner(self.binary)
        self.propagate(runner)
        commands = [c[-1] for c, k in runner.calls if "input" in k]
        self.assertTrue(commands[0].startswith('/opt/py - "$HOME"/.cache/cc-menubar-fleet/'), commands[0])
        self.assertTrue(commands[1].startswith('python3 - '))

    def test_failed_node_is_marked_and_retried_next_round(self):
        runner = FakeRunner(self.binary, failing_hosts={"host-b"})
        self.assertEqual(self.propagate(runner), 1)
        failed = json.loads((self.state / "FAILED").read_text())
        self.assertEqual(list(failed["nodes"]), ["b"])
        retry = FakeRunner(self.binary)
        self.assertEqual(self.propagate(retry), 0)
        self.assertEqual(retry.installs(), ["host-b"])
        self.assertFalse((self.state / "FAILED").exists())

    def test_new_hub_binary_goes_to_every_node_again(self):
        self.propagate(FakeRunner(self.binary))
        self.write_binary(b"binary-v2")
        runner = FakeRunner(self.binary)
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual(len(runner.installs()), 2)

    def test_timeout_on_one_node_does_not_stop_the_others(self):
        self.manifest["nodes"].insert(0, {"id": "hang", "host": "host-hang"})
        runner = FakeRunner(self.binary, hanging_hosts={"host-hang"})
        self.assertEqual(self.propagate(runner), 1)
        self.assertEqual(runner.installs(), ["host-hang", "host-a", "host-b"])
        nodes = self.state_nodes()
        self.assertIn("timeout", nodes["hang"]["lastError"])
        self.assertEqual({"a", "b"}, {k for k, v in nodes.items() if "hash" in v})

    def test_failed_install_forgets_old_success_so_hub_rollback_rechecks(self):
        self.propagate(FakeRunner(self.binary))  # v1 everywhere
        self.write_binary(b"binary-v2")
        self.assertEqual(self.propagate(FakeRunner(self.binary, failing_hosts={"host-b"})), 1)
        self.assertNotIn("hash", self.state_nodes()["b"])
        self.write_binary(b"binary-v1")  # 운영자가 허브를 v1로 되돌림
        runner = FakeRunner(self.binary)
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual(runner.installs(), ["host-a", "host-b"])  # b는 옛 v1 기록으로 건너뛰지 않는다

    def test_broken_hub_build_is_not_propagated(self):
        runner = FakeRunner(self.binary, selftest_rc=1)
        self.assertEqual(self.propagate(runner), 1)
        self.assertEqual(runner.installs(), [])
        self.assertIn("hub-selftest-failed", (self.state / "FAILED").read_text())

    def test_hub_running_another_binary_is_not_propagated(self):
        runner = FakeRunner(self.binary, comm="/old/cc-menubar")
        self.assertEqual(self.propagate(runner), 1)
        self.assertEqual(runner.installs(), [])
        self.assertTrue((self.state / "FAILED").exists())

    def test_hub_that_never_stabilizes_is_a_failure_not_a_wait(self):
        ticks = iter(range(0, 100000, 30))
        runner = FakeRunner(self.binary, etimes=("00:03",))
        self.assertEqual(self.propagate(runner, clock=lambda: 1.9e9 + next(ticks)), 1)
        self.assertEqual(runner.installs(), [])
        self.assertIn("hub-not-stable-after", (self.state / "FAILED").read_text())

    def test_hub_that_settles_within_grace_is_propagated(self):
        runner = FakeRunner(self.binary, etimes=("00:03", "00:10", "00:30"))
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual(runner.installs(), ["host-a", "host-b"])

    def test_build_replaced_during_hub_check_is_not_sent(self):
        runner = FakeRunner(self.binary, on_selftest=lambda: self.write_binary(b"binary-unchecked"))
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual(runner.installs(), [])
        self.assertFalse((self.state / "last-ok").exists())

    def test_malformed_manifest_stops_instead_of_skipping_nodes(self):
        for nodes in ([{"id": "a", "host": "h1"}, {"id": "a", "host": "h2"}], [{"id": "a"}], [{"host": "h"}],
                      [{"id": "a", "host": "h", "menubarAutoUpdate": None}],
                      [{"id": "a", "host": "h", "menubarAutoUpdate": "false"}],
                      [{"id": "a", "host": "h", "python": 42}]):
            self.manifest["nodes"] = nodes
            with self.assertRaises(ValueError, msg=nodes):
                self.propagate(FakeRunner(self.binary))

    def test_unreadable_manifest_leaves_failure_marker(self):
        import argparse
        bad = self.base / "bad.json"
        bad.write_text("{not json")
        self.assertEqual(fp.run_command(argparse.Namespace(manifest=str(bad), state_dir=str(self.state))), 1)
        self.assertIn("manifest", (self.state / "FAILED").read_text())

    # --- 워커 쪽 스크립트(REMOTE)를 임시 HOME에서 실제로 실행 ---

    def run_remote(self, candidate, install_py="raise SystemExit('install.py must not run')", old_backups=0,
                   path="/usr/bin:/bin"):
        home = self.base / "home"
        self.app = home / "Applications/cc-menubar"
        self.app.mkdir(parents=True)
        (self.app / "cc-menubar").write_text("old")
        for i in range(old_backups):
            (self.app / ("backup-old-%d" % i)).mkdir()
        stage = home / "stage"
        stage.mkdir()
        (stage / "cc-menubar").write_bytes(candidate)
        (stage / "cc-menubar").chmod(0o755)
        (stage / "install.py").write_text(install_py)
        want = hashlib.sha256(candidate).hexdigest()
        result = subprocess.run(["/usr/bin/python3", "-", str(stage), want, ""], input=fp.REMOTE, text=True,
                                capture_output=True, timeout=120, env={"HOME": str(home), "PATH": path})
        return result, (self.app / "cc-menubar").read_bytes()

    def test_remote_does_nothing_when_user_is_logged_out(self):
        fake = self.base / "fakebin"
        fake.mkdir()
        (fake / "launchctl").write_text("#!/bin/sh\nexit 113\n")  # GUI 도메인 없음
        (fake / "launchctl").chmod(0o755)
        result, installed = self.run_remote(b"anything", path="%s:/usr/bin:/bin" % fake)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL no-gui-session", result.stdout)
        self.assertEqual(installed, b"old")
        self.assertEqual(list(self.app.glob("backup-*")), [])

    def selftest_binary(self):
        """--selftest에 SELFTEST를 찍는 이 맥용 실행 파일."""
        if not shutil.which("cc", path="/usr/bin"):
            self.skipTest("C 컴파일러 없음")
        source = self.base / "ok.c"
        source.write_text('#include <stdio.h>\nint main(void){puts("SELFTEST ok");return 0;}\n')
        out = self.base / "ok"
        subprocess.run(["/usr/bin/cc", str(source), "-o", str(out)], check=True, capture_output=True)
        return out.read_bytes()

    def test_remote_refuses_candidate_this_mac_cannot_run_before_touching_install(self):
        result, installed = self.run_remote(b"#!/bin/sh\necho SELFTEST\n")  # Mach-O가 아님 → 아키텍처 확인 실패
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL arch-mismatch", result.stdout)
        self.assertEqual(installed, b"old")

    def test_remote_refuses_candidate_whose_selftest_fails(self):
        result, installed = self.run_remote(pathlib.Path("/usr/bin/false").read_bytes())  # 실행은 되지만 점검 실패
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL candidate-selftest-failed", result.stdout)
        self.assertEqual(installed, b"old")

    def test_remote_restores_backup_when_installed_build_does_not_run_as_the_service(self):
        # 가짜 install.py: 실제 install.py처럼 backup-* 폴더에 기존 파일을 남기고 교체한다(launchd는 건드리지 않음).
        fake_install = (
            "import sys, shutil, pathlib, time\n"
            "a = sys.argv; b = pathlib.Path(a[a.index('--binary') + 1]); d = pathlib.Path(a[a.index('--install-dir') + 1])\n"
            "bk = d / ('backup-%d' % time.time_ns()); bk.mkdir()\n"
            "shutil.copy2(d / 'cc-menubar', bk / 'cc-menubar'); shutil.copy2(b, d / 'cc-menubar')\n")
        # 이 임시 설치본은 실제 LaunchAgent가 실행하는 파일이 아니므로 확인 단계가 실패해야 하고, 백업으로 되돌아가야 한다.
        result, installed = self.run_remote(self.selftest_binary(), install_py=fake_install, old_backups=7)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("rolled-back rc=0", result.stdout)
        self.assertEqual(installed, b"old")
        self.assertEqual(len(list(self.app.glob("backup-*"))), 5)  # 재시도가 백업을 쌓지 않는다

    def test_elapsed_seconds_parses_ps_formats(self):
        self.assertEqual(fp.elapsed_seconds("00:21"), 21)
        self.assertEqual(fp.elapsed_seconds("01:02:03"), 3723)
        self.assertEqual(fp.elapsed_seconds("2-00:00:01"), 172801)


if __name__ == "__main__":
    unittest.main()
