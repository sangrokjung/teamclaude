"""화면 언어 스냅샷(A5)을 러너 요약에 넣는다(Phase 2 리뷰 증거 공백).

snapshot_test_locale.py는 build.sh가 후보 바이너리로만 돌려 run-tests.sh 요약에 나타나지 않았다.
여기서 지금 소스로 바이너리를 새로 컴파일해(낡은 .build/cc-menubar를 쓰지 않는다) 그 바이너리로 스냅샷을 돌린다.
영어 화면 한글 0자·한국어 A안 문구·두 언어 같은 배치를 그대로 본다."""
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MENUBAR = ROOT / "menubar"


class LocaleSnapshotGateTest(unittest.TestCase):
    def test_locale_snapshot_on_fresh_binary(self):
        with tempfile.TemporaryDirectory(prefix="cc-locale-gate-") as directory:
            binary = pathlib.Path(directory) / "cc-menubar"
            sources = sorted((MENUBAR / "Sources").glob("*.swift"))
            result = subprocess.run(["/usr/bin/swiftc", "-j", "1", "-num-threads", "1", "-framework", "Cocoa",
                                     "-framework", "Foundation", *map(str, sources), "-o", str(binary)],
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(0, result.returncode, result.stderr[-4000:])
            result = subprocess.run([sys.executable, str(MENUBAR / "Tests/snapshot_test_locale.py"), "-v"],
                                    capture_output=True, text=True, timeout=900,
                                    env={**os.environ, "CC_MENUBAR_BINARY": str(binary)})
            print(result.stderr[-3000:])
            self.assertEqual(0, result.returncode, (result.stdout + result.stderr)[-4000:])
            self.assertIn("Ran 4 tests", result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
