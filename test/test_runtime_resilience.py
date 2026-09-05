from __future__ import annotations

import subprocess
import unittest


class RuntimeResilienceTests(unittest.TestCase):
    def run_checked(self, *command: str, cwd: str | None = None) -> None:
        completed = subprocess.run(
            command,
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            completed.returncode,
            0,
            msg=f"{' '.join(command)}\n{completed.stdout}\n{completed.stderr}",
        )

    def test_runtime_deployer_and_watchdog_contracts(self) -> None:
        self.run_checked(
            "python3", "/Users/sangrok/.codex/tests/test_teamcodex_runtime_deployer.py"
        )
        self.run_checked(
            "python3", "/Users/sangrok/.codex/tests/test_codex_502_watchdog.py"
        )
        self.run_checked(
            "python3", "/Users/sangrok/.codex/tests/test_teamcodex_proxy_guard.py"
        )

    def test_supervisor_health_rotation_and_no_replay_contracts(self) -> None:
        self.run_checked(
            "node",
            "--test",
            "--test-name-pattern=status exposes|supervisor preserves worker session affinity|SUPERVISOR froze|worker death after upstream accepts POST|Codex worker-death receipt",
            "test/server-supervisor.test.js",
            cwd="/Users/sangrok/projects/teamclaude",
        )
        self.run_checked(
            "node",
            "--test",
            "test/worker-health.test.js",
            cwd="/Users/sangrok/projects/teamclaude",
        )


if __name__ == "__main__":
    unittest.main()
