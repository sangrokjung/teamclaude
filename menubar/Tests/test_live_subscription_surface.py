import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MONITOR = ROOT / "scripts/subscription-monitor.py"

class LiveSurfaceTests(unittest.TestCase):
    def _tabs(self):
        aside = shutil.which("aside")
        self.assertTrue(aside and pathlib.Path(aside).is_file(), "real-aside-required")
        code = 'console.log("TAB_AUDIT="+JSON.stringify(await listBrowserTabs()));\n'
        result = subprocess.run([aside, "repl"], input=code, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, "aside-tab-inventory-failed")
        rows = [line.split("TAB_AUDIT=", 1)[1] for line in result.stdout.splitlines()
                if "TAB_AUDIT=" in line and line.split("TAB_AUDIT=", 1)[1].startswith("[")]
        self.assertEqual(len(rows), 1, "aside-tab-inventory-missing")
        try:
            return {item["targetId"]: (item.get("url"), item.get("title")) for item in json.loads(rows[0])}
        except (ValueError, KeyError, TypeError):
            self.fail("aside-tab-inventory-invalid")

    def test_real_mail_dry_run_and_tab_cleanup(self):
        # gate의 격리 verifier에는 사용자 계정 설정이 없으므로 실계정 표면은 별도 실행에서만 검사한다.
        if not (pathlib.Path.home() / ".config/teamclaude.json").is_file():
            self.skipTest("live-user-config-unavailable-in-isolated-verifier")
        before = self._tabs()
        try:
            result = subprocess.run([sys.executable, str(MONITOR), "--dry-run"], cwd=ROOT,
                                    capture_output=True, text=True, timeout=600)
            self.assertEqual(result.returncode, 0, "live-mail-dry-run-failed")
            try:
                payload = json.loads(result.stdout)
            except ValueError:
                self.fail("live-mail-result-invalid")
            self.assertIs(payload.get("dryRun"), True, "live-mail-dry-run-missing")
            config = json.loads((pathlib.Path.home() / ".config/teamclaude.json").read_text())
            known = {index: row["name"].rpartition("@")[2].lower()
                     for index, row in enumerate(config.get("accounts", []), 1)
                     if isinstance(row, dict) and row.get("type") == "oauth" and row.get("name")}
            successful = set()
            summary = []
            for row in payload.get("accounts", []):
                domain = known.get(row.get("index"), "")
                service = "outlook" if domain in {"outlook.kr", "outlook.com", "hotmail.com", "live.com"} else "naver" if domain == "naver.com" else "google"
                if row.get("status") == "ok":
                    successful.add(service)
                summary.append({"index": row.get("index"), "status": row.get("status")})
            print(json.dumps({"liveMailboxes": summary, "successfulServices": sorted(successful),
                              "asideSHA256": hashlib.sha256(pathlib.Path(shutil.which("aside")).read_bytes()).hexdigest()}))
            self.assertTrue({"google", "naver", "outlook"} <= successful, "live-service-coverage-incomplete")
        finally:
            after = self._tabs()
            self.assertEqual(after, before, "existing-or-owned-browser-tabs-changed")
            print(json.dumps({"existingTabsUnchanged": True, "noOwnedTabsLeft": True}))

    def test_temp_full_build_and_dashboard_layout(self):
        with tempfile.TemporaryDirectory(prefix="subscription-live-build-") as directory:
            menu = pathlib.Path(directory) / "menubar"
            shutil.copytree(ROOT / "menubar", menu, ignore=shutil.ignore_patterns(".build"))
            build = subprocess.run(["bash", str(menu / "build.sh")], cwd=ROOT, capture_output=True, text=True, timeout=900)
            self.assertEqual(build.returncode, 0, "full-menu-build-failed")
            binary = menu / ".build/cc-menubar"
            qa = subprocess.run([str(binary), "--teamcodex-dashboard-selftest"], capture_output=True, text=True, timeout=30)
            self.assertEqual(qa.returncode, 0, "full-dashboard-layout-failed")
            print(json.dumps({"fullMenuBuild": "passed", "dashboardLayout": "passed",
                              "binarySHA256": hashlib.sha256(binary.read_bytes()).hexdigest()}))

if __name__ == "__main__":
    unittest.main(verbosity=2)
