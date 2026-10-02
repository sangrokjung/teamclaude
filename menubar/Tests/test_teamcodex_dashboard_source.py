import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
TEST_SOURCE = ROOT / "menubar/Tests/TeamCodexDashboardSourceTests.swift"
TEST_BINARY = ROOT / "menubar/.build/tests/TeamCodexDashboardSourceTests"
EXCERPT_SOURCE = ROOT / "menubar/Tests/Fixtures/process_tree_excerpt.swift"
EXCERPT_BINARY = ROOT / "menubar/.build/tests/ProcessTreeExcerptTests"


class TeamCodexDashboardSourceTests(unittest.TestCase):
    def test_source_regressions(self):
        TEST_BINARY.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "swiftc",
                "-parse-as-library",
                str(TEST_SOURCE),
                "-o",
                str(TEST_BINARY),
            ],
            cwd=ROOT,
            check=True,
            timeout=30,
        )
        result = subprocess.run(
            [str(TEST_BINARY), str(ROOT)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("13 passed, 0 failed", result.stdout)

    def test_process_tree_identity_behavior(self):
        subprocess.run(
            [
                "swiftc",
                "-parse-as-library",
                "-D",
                "PROCESS_TREE_SELFTEST",
                str(EXCERPT_SOURCE),
                "-o",
                str(EXCERPT_BINARY),
            ],
            cwd=ROOT,
            check=True,
            timeout=30,
        )
        result = subprocess.run(
            [str(EXCERPT_BINARY)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
            timeout=30,
        )
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertIn("ProcessTreeExcerptTests: 5 passed, 0 failed", result.stdout)


if __name__ == "__main__":
    unittest.main()
