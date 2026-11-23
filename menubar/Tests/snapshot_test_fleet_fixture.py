# menubar/Tests/snapshot_test_fleet_fixture.py
"""빌드된 cc-menubar의 --dashboard-snapshot이 머신 줄 픽스처(fleetUsage)를 실제로 소비하는지 본다.
build.sh가 mv 직전의 후보 바이너리(CC_MENUBAR_BINARY)로 실행한다(러너의 test_*.py 글롭 밖).

- 정상 fleetUsage(신선·멈춤)는 PNG를 낸다.
- 명시한 fleetUsage가 깨졌거나(hosts 타입), ageSeconds 타입이 틀리면 비정상 종료한다.
  수집 멈춤을 검증하려던 스냅샷이 최신 상태로 조용히 성공하지 않게 한다."""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BINARY = pathlib.Path(os.environ.get("CC_MENUBAR_BINARY", str(ROOT / "menubar" / ".build" / "cc-menubar")))
BASE = json.loads((ROOT / "menubar" / "Tests" / "fixtures-dash.json").read_text())
HOSTS = [{"name": "hub", "ok": True, "load1": 3, "cores": 30},
         {"name": "node-a", "ok": False}]


@unittest.skipUnless(BINARY.exists(), f"binary not built: {BINARY}")
class FleetFixtureSnapshotTests(unittest.TestCase):
    def run_snapshot(self, fleet_usage):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = pathlib.Path(tmp) / "fixture.json"
            fixture.write_text(json.dumps({**BASE, "fleetUsage": fleet_usage}))
            out = pathlib.Path(tmp) / "out.png"
            result = subprocess.run([str(BINARY), "--dashboard-snapshot", str(fixture), str(out)],
                                    capture_output=True, text=True, timeout=120,
                                    env={**os.environ, "CC_MENUBAR_LANG": "ko"})
            return result, out.exists() and out.stat().st_size > 0

    def test_valid_fleet_fixtures_render(self):
        for usage in ({"hosts": HOSTS}, {"ageSeconds": 600, "hosts": HOSTS}):
            with self.subTest(usage=usage):
                result, rendered = self.run_snapshot(usage)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(rendered)

    def test_malformed_fleet_fixtures_fail(self):
        for usage in ({"hosts": "bad"}, {"ageSeconds": "600", "hosts": HOSTS}):
            with self.subTest(usage=usage):
                result, rendered = self.run_snapshot(usage)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("fleetUsage", result.stderr)
                self.assertFalse(rendered, "a rejected fixture must not leave a PNG")


if __name__ == "__main__":
    unittest.main()
