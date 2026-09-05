import os
import pwd
import stat
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def find_node_runtime():
    account_home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    candidates = (
        Path("/opt/homebrew/bin/node"),
        Path("/usr/local/bin/node"),
        Path("/usr/bin/node"),
        account_home / ".local/share/fnm/aliases/default/bin/node",
    )
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=True)
            metadata = resolved.stat()
        except OSError:
            continue
        if stat.S_ISREG(metadata.st_mode) and os.access(resolved, os.X_OK):
            return resolved
    raise RuntimeError("trusted Node.js runtime not found in fixed candidates")


NODE = find_node_runtime()


class ModelRecoveryGateTest(unittest.TestCase):
    def test_node_model_recovery_regressions(self):
        commands = [
            [str(NODE), "--check", "src/server.js"],
            [str(NODE), "--check", "src/index.js"],
            [str(NODE), "--check", "test/server-codex-model-compatibility.test.js"],
            [str(NODE), "--check", "test/server-proxy-connection.test.js"],
            [
                str(NODE), "--test", "--test-concurrency=1",
                "test/server-codex-model-compatibility.test.js",
                "test/server-proxy-connection.test.js",
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
                    timeout=120,
                )
                self.assertEqual(
                    result.returncode,
                    0,
                    f"command failed: {command!r}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}",
                )


if __name__ == "__main__":
    unittest.main()
