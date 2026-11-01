import importlib.util
import json
import pathlib
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

    def __init__(self, binary, etime="01:00", selftest_rc=0, comm=None, failing_hosts=(), hanging_hosts=()):
        self.binary, self.etime, self.selftest_rc = str(binary), etime, selftest_rc
        self.comm = comm or self.binary
        self.failing_hosts = set(failing_hosts)
        self.hanging_hosts = set(hanging_hosts)
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if command[0] == "launchctl":
            return Result(stdout="\tpid = 42\n")
        if command[0] == "ps":
            return Result(stdout=self.comm if command[-1] == "comm=" else self.etime)
        if command[-1] == "--selftest":
            return Result(self.selftest_rc, "SELFTEST reachable=true" if self.selftest_rc == 0 else "")
        host = command[-1].split(":")[0] if command[0].endswith("scp") else command[-2]
        if host in self.hanging_hosts and "input" in kwargs:
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 1))
        if host in self.failing_hosts:
            if "input" in kwargs:
                return Result(1, "FAIL selftest-failed rc=1 (rolled-back rc=0)\n")
            return Result(255, "", "ssh: connect timed out")
        if "input" in kwargs:
            return Result(0, "OK abc\n")
        return Result()

    def installs(self):
        return [c for c, k in self.calls if "input" in k]


class FleetPropagateTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="cc-fleet-test-")
        base = pathlib.Path(self.tmp.name).resolve()  # 스크립트는 링크를 풀어 비교한다(/var → /private/var)
        self.binary = base / "app/cc-menubar"
        self.binary.parent.mkdir()
        self.write_binary(b"binary-v1")
        self.state = base / "state"
        self.state.mkdir()
        self.manifest = {"menubar": str(self.binary), "nodes": [
            {"id": "a", "host": "host-a", "python": "/opt/py"},
            {"id": "b", "host": "host-b"},
            {"id": "off", "host": "host-off", "menubarAutoUpdate": False},
        ]}

    def tearDown(self):
        self.tmp.cleanup()

    def write_binary(self, data):
        self.binary.write_bytes(data)
        subprocess.run(["touch", "-t", "202001010000", str(self.binary)], check=True)

    def propagate(self, runner, **kwargs):
        return fp.propagate(self.manifest, self.state, ROOT / "menubar", runner, sleep=lambda s: None, **kwargs)

    def test_installs_every_enabled_node_then_skips_same_hash(self):
        runner = FakeRunner(self.binary)
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual([c[-2] for c in runner.installs()], ["host-a", "host-b"])
        state = json.loads((self.state / "state.json").read_text())
        self.assertEqual(set(state["nodes"]), {"a", "b"})
        self.assertTrue((self.state / "last-ok").exists())
        self.assertFalse((self.state / "FAILED").exists())
        second = FakeRunner(self.binary)
        self.assertEqual(self.propagate(second), 0)
        self.assertEqual(second.installs(), [])

    def test_remote_command_quotes_stage_and_uses_node_python(self):
        runner = FakeRunner(self.binary)
        self.propagate(runner)
        command = runner.installs()[0][-1]
        self.assertTrue(command.startswith('/opt/py - "$HOME"/.cache/cc-menubar-fleet/'), command)
        self.assertTrue(runner.installs()[1][-1].startswith('python3 - '))

    def test_failed_node_is_marked_and_retried_next_round(self):
        runner = FakeRunner(self.binary, failing_hosts={"host-b"})
        self.assertEqual(self.propagate(runner), 1)
        failed = json.loads((self.state / "FAILED").read_text())
        self.assertEqual(list(failed["nodes"]), ["b"])
        retry = FakeRunner(self.binary)
        self.assertEqual(self.propagate(retry), 0)
        self.assertEqual([c[-2] for c in retry.installs()], ["host-b"])
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
        self.assertEqual([c[-2] for c in runner.installs()], ["host-hang", "host-a", "host-b"])
        state = json.loads((self.state / "state.json").read_text())
        self.assertIn("timeout", state["nodes"]["hang"]["lastError"])
        self.assertEqual({"a", "b"}, {k for k, v in state["nodes"].items() if "hash" in v})

    def test_failed_install_forgets_old_success_so_hub_rollback_rechecks(self):
        self.propagate(FakeRunner(self.binary))  # v1 everywhere
        self.write_binary(b"binary-v2")
        self.assertEqual(self.propagate(FakeRunner(self.binary, failing_hosts={"host-b"})), 1)
        state = json.loads((self.state / "state.json").read_text())
        self.assertNotIn("hash", state["nodes"]["b"])
        self.write_binary(b"binary-v1")  # 운영자가 허브를 v1로 되돌림
        runner = FakeRunner(self.binary)
        self.assertEqual(self.propagate(runner), 0)
        self.assertEqual([c[-2] for c in runner.installs()], ["host-a", "host-b"])  # b는 옛 v1 기록으로 건너뛰지 않는다

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

    def test_young_hub_process_waits_without_failure_marker(self):
        ticks = iter(range(0, 100000, 30))
        runner = FakeRunner(self.binary, etime="00:03")
        self.assertEqual(self.propagate(runner, clock=lambda: 1.9e9 + next(ticks)), 0)
        self.assertEqual(runner.installs(), [])
        self.assertFalse((self.state / "FAILED").exists())

    def test_remote_refuses_candidate_whose_selftest_fails(self):
        result, installed = self.run_remote(pathlib.Path("/usr/bin/false").read_bytes())  # 이 맥에서 실행되지만 점검 실패
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL candidate-selftest-failed", result.stdout)
        self.assertEqual(installed, "old")

    def run_remote(self, candidate_body):
        """REMOTE를 임시 HOME에서 실제로 실행한다. 기존 설치는 'old' 내용의 실행 파일."""
        home = pathlib.Path(self.tmp.name).resolve() / "home"
        app = home / "Applications/cc-menubar"
        app.mkdir(parents=True)
        (app / "cc-menubar").write_text("old")
        stage = home / "stage"
        stage.mkdir()
        (stage / "cc-menubar").write_bytes(candidate_body if isinstance(candidate_body, bytes) else candidate_body.encode())
        (stage / "cc-menubar").chmod(0o755)
        (stage / "install.py").write_text("raise SystemExit('install.py must not run')")
        import hashlib
        want = hashlib.sha256((stage / "cc-menubar").read_bytes()).hexdigest()
        result = subprocess.run(["/usr/bin/python3", "-", str(stage), want, ""], input=fp.REMOTE, text=True,
                                capture_output=True, timeout=60, env={"HOME": str(home), "PATH": "/usr/bin:/bin"})
        return result, (app / "cc-menubar").read_text()

    def test_remote_refuses_candidate_this_mac_cannot_run_before_touching_install(self):
        result, installed = self.run_remote("#!/bin/sh\necho SELFTEST\n")  # Mach-O가 아님 → 아키텍처 확인 실패
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("FAIL arch-mismatch", result.stdout)
        self.assertEqual(installed, "old")

    def test_elapsed_seconds_parses_ps_formats(self):
        self.assertEqual(fp.elapsed_seconds("00:21"), 21)
        self.assertEqual(fp.elapsed_seconds("01:02:03"), 3723)
        self.assertEqual(fp.elapsed_seconds("2-00:00:01"), 172801)


if __name__ == "__main__":
    unittest.main()
