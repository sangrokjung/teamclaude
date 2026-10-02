import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class UsageRegressionTests(unittest.TestCase):
    def run_swift(self, source_names, test_name):
        with tempfile.TemporaryDirectory(prefix="menubar-usage-check-") as folder:
            binary = Path(folder) / "tests"
            argv = ["swiftc", "-j", "1", *[str(ROOT / "menubar/Sources" / name) for name in source_names],
                    str(ROOT / "menubar/Tests" / test_name), "-o", str(binary)]
            subprocess.run(argv, check=True, capture_output=True, text=True, timeout=600)
            env = dict(os.environ, CFFIXED_USER_HOME=folder, CC_MENUBAR_CODEX_HOME=folder + "/.codex",
                       CC_MENUBAR_CODEX_SESSIONS=folder + "/.codex/sessions", CC_MENUBAR_CODEX_CALL_LOG=folder + "/calls.jsonl")
            if test_name == "CodexStatusLoaderTests.swift":
                unisolated = {key: value for key, value in env.items()
                              if not key.startswith("CC_MENUBAR_CODEX_")}
                with tempfile.TemporaryDirectory(prefix="menubar-protected-home-") as protected:
                    auth = Path(protected) / "auth.json"
                    auth.write_bytes(b"existing-auth-sentinel")
                    for unsafe_env in [unisolated, dict(env, CC_MENUBAR_CODEX_HOME=protected)]:
                        refused = subprocess.run([str(binary)], capture_output=True, text=True,
                                                 env=unsafe_env, timeout=10)
                        self.assertEqual(refused.returncode, 2, refused.stderr)
                        self.assertIn("Refusing fixture writes", refused.stdout)
                        self.assertEqual(auth.read_bytes(), b"existing-auth-sentinel")
                with tempfile.TemporaryDirectory(prefix="menubar-outside-fixture-") as outside:
                    escaped = Path(folder) / "session-fixture"
                    escaped.symlink_to(outside, target_is_directory=True)
                    for root_arg in [outside, str(escaped)]:
                        refused = subprocess.run([str(binary), "--legacy-cache-check", root_arg],
                                                 capture_output=True, text=True, env=env, timeout=10)
                        self.assertEqual(refused.returncode, 2, refused.stdout + refused.stderr)
                        self.assertIn("Refusing fixture writes", refused.stdout)
                    escaped.unlink()
                for relative in ["last-only-fixture", "last-only-fixture/fixture.jsonl", "long-line-fixture", "long-line-fixture/fixture.jsonl", "component-fixture", "component-fixture/fixture.jsonl", "cumulative-fixture", "cumulative-fixture/fixture.jsonl", "session-fixture", "session-fixture/fixture.jsonl", ".codex/auth.json", ".codex/config.toml"]:
                    with tempfile.TemporaryDirectory(prefix="menubar-outside-file-") as outside:
                        sentinel = Path(outside) / "sentinel"
                        sentinel.write_bytes(b"protected-file")
                        link = Path(folder) / relative
                        link.parent.mkdir(parents=True, exist_ok=True)
                        link.symlink_to(sentinel)
                        refused = subprocess.run([str(binary)], capture_output=True, text=True, env=env, timeout=10)
                        self.assertEqual(refused.returncode, 2, refused.stdout + refused.stderr)
                        self.assertEqual(sentinel.read_bytes(), b"protected-file")
                        link.unlink()
                        if link.parent != Path(folder):
                            link.parent.rmdir()
            result = subprocess.run([str(binary)], capture_output=True, text=True, env=env, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertFalse(result.stderr.strip(), result.stderr)
            return result.stdout

    def test_loader_separates_model_limits_and_rejects_old_cache(self):
        output = self.run_swift(["CodexStatusModels.swift", "CodexStatusParsing.swift", "CodexStatusLoader.swift"],
                                "CodexStatusLoaderTests.swift")
        self.assertIn("all usage regressions passed", output)
        self.assertIn("Legacy quota cache rejected", output)

    def test_pool_preserves_unknown_zero_and_current_account(self):
        # TeamCodexPoolStatus.swift가 status의 runtime 블록을 teamRuntimeSummary(TeamClaudePresentationLogic.swift)로 읽으므로 같이 컴파일한다.
        self.run_swift(["TeamCodexPoolStatus.swift", "CodexStatusLayout.swift", "TeamClaudePresentationLogic.swift"],
                       "TeamCodexPoolStatusTests.swift")

    def test_menu_title_uses_tokens(self):
        output = self.run_swift(["CodexStatusModels.swift", "CodexStatusParsing.swift"], "CodexTitleQuotaTests.swift")
        self.assertIn("Codex title token usage test passed", output)

    def test_grok_title_uses_billing_percent(self):
        output = self.run_swift(["GrokUsage.swift"], "GrokUsageTests.swift")
        self.assertIn("Grok title usage test passed", output)

    def test_agy_usage_parser(self):
        output = self.run_swift(["AgyUsage.swift"], "AgyUsageTests.swift")
        self.assertIn("agy usage parser test passed", output)


class BuildGateTests(unittest.TestCase):
    def test_successful_build_replaces_existing_binary(self):
        with tempfile.TemporaryDirectory(prefix="menubar-successful-build-") as folder:
            root = self.gate_copy(folder, "exit 0\n")
            output = root / "menubar/.build/cc-menubar"
            result = subprocess.run(["bash", str(root / "menubar/build.sh")], capture_output=True, text=True,
                                    timeout=600, env=self.gate_env())
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(output.read_bytes()[:4], bytes([0xCF, 0xFA, 0xED, 0xFE]))
            self.assertTrue(os.access(output, os.X_OK))

    def test_failed_regression_does_not_replace_existing_binary(self):
        with tempfile.TemporaryDirectory(prefix="menubar-build-gate-") as folder:
            root = self.gate_copy(folder, 'echo "FAILED: stub regression" >&2\nexit 1\n')
            output = root / "menubar/.build/cc-menubar"
            result = subprocess.run(["bash", str(root / "menubar/build.sh")], capture_output=True, text=True,
                                    timeout=600, env=self.gate_env())
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("FAILED", result.stderr)
            self.assertEqual(output.read_bytes(), b"previous-verified-binary")

    # The gate under test is only "runner exit code => binary replaced or kept". The real runner is
    # exercised by the other test classes, so the temp copy gets a stub runner that just reports a result;
    # otherwise the nested build.sh would re-run the whole suite (and this class inside it) recursively.
    @staticmethod
    def gate_copy(folder, runner_script):
        root = Path(folder)
        shutil.copytree(ROOT / "menubar", root / "menubar", ignore=shutil.ignore_patterns(".build"))
        runner = root / "menubar/run-tests.sh"
        runner.write_text("#!/usr/bin/env bash\n" + runner_script)
        runner.chmod(0o755)
        output = root / "menubar/.build/cc-menubar"
        output.parent.mkdir()
        output.write_bytes(b"previous-verified-binary")
        return root

    # run-tests.sh exports CC_MENUBAR_SKIP_TESTS=1 for the Python tests it runs (its recursion guard);
    # drop it so the nested build.sh really consults the stub runner. CC_MENUBAR_SKIP_SNAPSHOT=1 keeps the
    # offscreen snapshot smoke out of this gate test: it checks only "runner rc => binary replaced / kept".
    @staticmethod
    def gate_env():
        env = {key: value for key, value in os.environ.items() if key != "CC_MENUBAR_SKIP_TESTS"}
        env["CC_MENUBAR_SKIP_SNAPSHOT"] = "1"
        return env


if __name__ == "__main__":
    unittest.main()
