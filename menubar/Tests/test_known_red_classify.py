"""known-red.sh의 분류 함수 회귀: 허용 목록 안 실패만 known-red, 허용 밖 실패·파싱 불가는 게이트를 막는다."""
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "menubar" / "known-red.sh"

FAIL_LOG = """test_a (t.T.test_a) ... FAIL
test_b (t.T.test_b) ... ERROR

======================================================================
FAIL: test_a (t.T.test_a)
----------------------------------------------------------------------
AssertionError: nope

======================================================================
ERROR: test_b (t.T.test_b)
----------------------------------------------------------------------
RuntimeError: boom

Ran 3 tests in 0.010s

FAILED (failures=1, errors=1)
"""


def classify(log_text, *methods):
    with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as handle:
        handle.write(log_text)
        path = handle.name
    cmd = ["bash", "-c", f'source "{SCRIPT}"; classify_known_red "$@"', "_", path, *methods]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=10, check=True).stdout.strip()


class KnownRedClassifyTests(unittest.TestCase):
    def test_all_failures_listed_is_known_red(self):
        self.assertEqual("known-red", classify(FAIL_LOG, "test_a", "test_b"))

    def test_unlisted_failure_blocks(self):
        self.assertEqual("unlisted: test_b", classify(FAIL_LOG, "test_a"))

    def test_no_parsable_failure_blocks(self):
        self.assertEqual("no-failures-parsed", classify("Traceback (most recent call last):\n  boom\n", "test_a"))

    def test_runner_exports_snapshot_skip_and_sources_helper(self):
        runner = (ROOT / "menubar" / "run-tests.sh").read_text()
        self.assertIn("export CC_MENUBAR_SKIP_SNAPSHOT=1", runner)
        self.assertIn('source "$ROOT/menubar/known-red.sh"', runner)
        self.assertIn('"$b::"*) known_methods+=', runner)


if __name__ == "__main__":
    unittest.main()
