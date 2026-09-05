import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import subprocess
import unittest


WORKER_IP = "100.75.151.101"
WRAPPER_PID = 77168
SESSION = "qjc-codex-couple-life-plan-be2567232593-26389adb-7e92-429b-a846-a925e57edd4e"
SESSION_ID = "01a0278a-b479-79e0-ba17-190c0f4fdf83"
ORPHAN_PIDS = (50061, 50096, 50126, 53788, 73280, 73366, 73395)
PRESERVED_WORKTREES = (
    Path("/private/tmp/qjc-pr2491-37e4-review.DKLQ5b/worktree"),
    Path(
        "/private/var/folders/nz/5ksj54nx5hd_kd898dzpqlbm0000gn/T/"
        "qjc-pr2491-fix-wv3osj"
    ),
)
USER_ENV = {
    **os.environ,
    "HOME": "/Users/sangrok",
    "PATH": (
        "/Users/sangrok/.local/bin:/Users/sangrok/bin:/usr/local/bin:"
        "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    ),
}


def run(command, *args, env=None):
    return subprocess.run(
        (command, *args),
        capture_output=True,
        check=False,
        env=env,
        text=True,
        timeout=20,
    )


def ssh(remote_command):
    return run(
        "/usr/bin/ssh",
        "-i",
        "/Users/sangrok/.ssh/id_ed25519_studio2_codex",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "UserKnownHostsFile=/Users/sangrok/.ssh/known_hosts",
        f"imac@{WORKER_IP}",
        remote_command,
    )


class WorkerSshRuntimeTest(unittest.TestCase):
    def test_01_tailscale_data_path_answers(self):
        result = run("/usr/local/bin/tailscale", "ping", "-c", "1", WORKER_IP)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("pong from mac-studio", result.stdout)

    def test_02_batch_mode_ssh_answers(self):
        result = ssh('printf "SSH_OK\\n"; hostname')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"(?m)^SSH_OK$")
        self.assertRegex(result.stdout, r"(?m)^Mac-Studio\.local$")

    def test_03_original_wrapper_remains_alive(self):
        os.kill(WRAPPER_PID, 0)

    def test_04_qjc_agent_status_reaches_worker(self):
        result = run(
            "/Users/sangrok/.local/bin/qjc-agent", "status", env=USER_ENV
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"managed_sessions=\d+/\d+")
        self.assertIn(SESSION, result.stdout)

    def test_05_detached_tmux_session_remains_alive(self):
        result = ssh(
            f"tmux has-session -t '{SESSION}' && "
            f"tmux display-message -p -t '{SESSION}' "
            "'#{session_attached}|#{pane_current_command}'"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"(?m)^0\|bash$")

    def test_06_saved_codex_identity_is_unchanged(self):
        result = run(
            "/Users/sangrok/.local/bin/qjc-agent", "saved", env=USER_ENV
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(
            result.stdout,
            rf"(?m)^codex\|{SESSION_ID}\|.*\|running:",
        )

    def test_07_exact_orphan_pids_remain_absent(self):
        for pid in ORPHAN_PIDS:
            with self.subTest(pid=pid):
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)

    def test_08_validation_ports_have_no_listeners(self):
        for port in (3100, 3152):
            with self.subTest(port=port):
                result = run(
                    "/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"
                )
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertEqual(result.stdout, "")

    def test_09_temporary_worktrees_are_preserved(self):
        for worktree in PRESERVED_WORKTREES:
            with self.subTest(worktree=worktree):
                self.assertTrue(worktree.is_dir())

    def test_10_tailscale_key_expiry_is_future_and_finite(self):
        result = run("/usr/local/bin/tailscale", "status", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        peers = json.loads(result.stdout)["Peer"].values()
        peer = next(item for item in peers if WORKER_IP in item["TailscaleIPs"])
        self.assertTrue(peer["Online"])
        self.assertTrue(peer["Active"])
        expiry = datetime.fromisoformat(peer["KeyExpiry"].replace("Z", "+00:00"))
        self.assertIsNotNone(expiry.tzinfo)
        self.assertGreater(expiry, datetime.now(timezone.utc) + timedelta(days=1))

    def test_11_supabase_containers_remain_running(self):
        result = ssh('docker ps --format "{{.ID}}" | wc -l')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertGreaterEqual(int(result.stdout.strip()), 12)

    def test_12_qgate_reason_matches_colima_12gib(self):
        qgate_result = ssh("python3 ~/.claude/scripts/qgate.py status --json")
        colima_result = ssh("colima status --json")
        sampler_result = ssh(
            "python3 - <<'PY'\n"
            "import json, os, runpy\n"
            "qgate = runpy.run_path(os.path.expanduser('~/.claude/scripts/qgate.py'))\n"
            "process = max(qgate['ps_snapshot'](), key=lambda item: item['memory_kb'])\n"
            "print(json.dumps({\n"
            "    'pid': process['pid'],\n"
            "    'memory_mb': round(process['memory_kb'] / 1024.0, 1),\n"
            "    'memory_source': process['memory_source'],\n"
            "    'args': process['args'],\n"
            "}))\n"
            "PY"
        )
        self.assertEqual(qgate_result.returncode, 0, qgate_result.stderr)
        self.assertEqual(colima_result.returncode, 0, colima_result.stderr)
        self.assertEqual(sampler_result.returncode, 0, sampler_result.stderr)
        qgate = json.loads(qgate_result.stdout)
        colima = json.loads(colima_result.stdout)
        sampled = json.loads(sampler_result.stdout)
        self.assertFalse(qgate["gate_open"])
        self.assertRegex(qgate["gate_reason"], r"^single-process RSS MB ")
        self.assertGreaterEqual(qgate["resources"]["max_process_rss_mb"], 12_288)
        self.assertEqual(colima["memory"], 12 * 1024**3)
        self.assertEqual(colima["driver"], "macOS Virtualization.Framework")
        self.assertEqual(sampled["memory_source"], "phys_footprint")
        self.assertAlmostEqual(
            sampled["memory_mb"],
            qgate["resources"]["max_process_rss_mb"],
            delta=0.1,
        )
        self.assertIn("com.apple.Virtualization.VirtualMachine", sampled["args"])
        vm_pid_result = ssh(
            'pgrep -f "com.apple.Virtualization.VirtualMachine" | head -1'
        )
        self.assertEqual(vm_pid_result.returncode, 0, vm_pid_result.stderr)
        self.assertEqual(sampled["pid"], int(vm_pid_result.stdout.strip()))

    def test_13_colima_footprint_belongs_to_live_vm(self):
        result = ssh(
            'pid=$(pgrep -f "com.apple.Virtualization.VirtualMachine" | head -1); '
            'printf "PID=%s\\n" "$pid"; '
            'ps -p "$pid" -o ppid=,command=; '
            'vmmap -summary "$pid" 2>/dev/null | grep "^Physical footprint:"'
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r"(?m)^PID=\d+$")
        self.assertRegex(
            result.stdout,
            r"(?m)^\s*1 .*com\.apple\.Virtualization\.VirtualMachine",
        )
        self.assertRegex(result.stdout, r"(?m)^Physical footprint:\s+12\.0G$")


if __name__ == "__main__":
    unittest.main()
