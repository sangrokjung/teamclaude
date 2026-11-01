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

    def __init__(self, binary, etime="01:00", selftest_rc=0, comm=None, failing_hosts=()):
        self.binary, self.etime, self.selftest_rc = str(binary), etime, selftest_rc
        self.comm = comm or self.binary
        self.failing_hosts = set(failing_hosts)
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
        if host in self.failing_hosts:
            return Result(255, "", "ssh: connect timed out")
        if "input" in kwargs:
            return Result(0, "OK abc 99\n")
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

    def test_broken_hub_build_is_not_propagated(self):
        runner = FakeRunner(self.binary, selftest_rc=1)
        self.assertEqual(self.propagate(runner), 1)
        self.assertEqual(runner.installs(), [])

    def test_hub_running_another_binary_is_not_propagated(self):
        runner = FakeRunner(self.binary, comm="/old/cc-menubar")
        self.assertEqual(self.propagate(runner), 1)
        self.assertEqual(runner.installs(), [])

    def test_young_hub_process_waits_without_failure_marker(self):
        ticks = iter(range(0, 100000, 30))
        runner = FakeRunner(self.binary, etime="00:03")
        self.assertEqual(self.propagate(runner, clock=lambda: 1.9e9 + next(ticks)), 0)
        self.assertEqual(runner.installs(), [])
        self.assertFalse((self.state / "FAILED").exists())

    def test_elapsed_seconds_parses_ps_formats(self):
        self.assertEqual(fp.elapsed_seconds("00:21"), 21)
        self.assertEqual(fp.elapsed_seconds("01:02:03"), 3723)
        self.assertEqual(fp.elapsed_seconds("2-00:00:01"), 172801)


if __name__ == "__main__":
    unittest.main()
