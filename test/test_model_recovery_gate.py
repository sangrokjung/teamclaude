import hashlib
import os
import pwd
import shutil
import stat
import subprocess
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
USER_HOME = Path(pwd.getpwuid(os.getuid()).pw_dir)


def find_node_runtime():
    path_runtime = shutil.which("node")
    candidates = ([Path(path_runtime)] if path_runtime else []) + [
        Path("/opt/homebrew/bin/node"),
        Path("/usr/local/bin/node"),
        Path("/usr/bin/node"),
        USER_HOME / ".local/share/fnm/aliases/default/bin/node",
    ]
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
            metadata = resolved.stat()
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode) and os.access(resolved, os.X_OK):
            return resolved
    return None


NODE = find_node_runtime()


WATCHDOG = ROOT / "scripts/codex_502_watchdog.py"
ACCOUNT_MANAGER = ROOT / "src/account-manager.js"
ACCOUNT_MANAGER_SHA256 = "64ce737d27ff6cfd90960e720f884034b2cbeaa6b475f8d3c07df7a678e9664a"
CONFIG = ROOT / "src/config.js"
CONFIG_SHA256 = "9dc6f1ceb8d00af4ebd0995c8efae6451f5a22fd7d27aca7bfbbac26e506a30f"
WATCHDOG_TESTS = (
    ROOT / "test/test_codex_502_watchdog.py",
    ROOT / "test/test_codex_502_watchdog_variants.py",
)


class ModelRecoveryGateTest(unittest.TestCase):
    def test_node_model_recovery_regressions(self):
        self.assertIsNotNone(NODE, "Node.js runtime not available")
        verifier_env = os.environ.copy()
        verifier_env.pop("TEAMCLAUDE_SESSION_SUPERVISED", None)
        verifier_env["PATH"] = os.pathsep.join(
            [str(NODE.parent), verifier_env.get("PATH", "")]
        )
        commands = [
            [str(NODE), "--check", "src/server.js"],
            [str(NODE), "--check", "src/index.js"],
            [str(NODE), "--check", "src/account-manager.js"],
            [str(NODE), "--check", "src/config.js"],
            [str(NODE), "--check", "test/server-codex-model-compatibility.test.js"],
            [str(NODE), "--check", "test/server-proxy-connection.test.js"],
            [sys.executable, "-m", "py_compile", str(WATCHDOG)],
            [
                sys.executable, "-m", "unittest", "discover", "-s", "test",
                "-p", "test_codex_502_watchdog*.py", "-v",
            ],
            [
                str(NODE), "--test", "--test-reporter=tap", "--test-concurrency=1",
                "test/account-manager.test.js",
                "test/concurrency.test.js",
                "test/reauth.test.js",
                "test/server-403.test.js",
                "test/server-codex-model-compatibility.test.js",
                "test/server-codex.test.js",
                "test/server-proxy-connection.test.js",
                "test/server-rotation.test.js",
                "test/server-supervisor.test.js",
                "test/status-cli.test.js",
                "test/subscription.test.js",
                "test/tui.test.js",
                "test/warmup.test.js",
            ],
            [
                str(NODE), "--test", "--test-reporter=tap", "--test-concurrency=1",
                "test/codex-resume.test.js",
                "test/config.test.js",
                "test/run-recovery.test.js",
                "test/server-429.test.js",
                "test/server-supervisor.test.js",
            ],
        ]
        for command in commands:
            with self.subTest(command=command):
                result = subprocess.run(
                    command,
                    cwd=ROOT,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=300,
                    env=verifier_env,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    f"command failed: {command!r}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
                )
                if "--test" in command:
                    self.assertIn("# fail 0", result.stdout)
                print(f"verified subprocess: {Path(command[0]).name} {' '.join(command[1:])}")

    def test_watchdog_source_matches_operating_copy(self):
        for test_path in WATCHDOG_TESTS:
            self.assertTrue(test_path.is_file(), test_path)
        deployed_path = os.environ.get("CODEX_WATCHDOG_DEPLOYED_PATH")
        operating = (Path(deployed_path).expanduser() if deployed_path
                     else USER_HOME / ".local/bin/codex_502_watchdog.py")
        if operating.exists():
            operating = operating.resolve(strict=True)
            self.assertEqual(WATCHDOG.read_bytes(), operating.read_bytes())

    def test_account_manager_evidence_matches_source(self):
        self.assertEqual(
            hashlib.sha256(ACCOUNT_MANAGER.read_bytes()).hexdigest(),
            ACCOUNT_MANAGER_SHA256,
        )
        self.assertEqual(
            hashlib.sha256(CONFIG.read_bytes()).hexdigest(),
            CONFIG_SHA256,
        )


if __name__ == "__main__":
    unittest.main()
