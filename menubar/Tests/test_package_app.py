"""외부 배포용 유니버설 .app 번들 스크립트(R6) 회귀 검사.

package-app.sh는 arm64·x86_64를 따로 컴파일해 lipo로 합치고, LSUIElement가 든 Info.plist로
`CC Menubar.app`을 만든 뒤 ad-hoc 서명·zip·sha256까지 한다. 내부 설치용 build.sh의 단일 바이너리
(.build/cc-menubar)와 install.py 경로는 건드리지 않는다. 실제 두 아키텍처 컴파일은 무거워 기본 러너에서
돌리지 않고 Release 워크플로와 수동 검증(lipo -archs)이 맡는다. 여기서는 스크립트 계약과 Info.plist 생성기를 본다."""
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "menubar" / "package-app.sh"


class PackageAppScriptTests(unittest.TestCase):
    def setUp(self):
        self.script = SCRIPT.read_text()

    def test_compiles_both_architectures_and_merges_with_lipo(self):
        self.assertIn("arm64-apple-macosx13.0", self.script)
        self.assertIn("x86_64-apple-macosx13.0", self.script)
        self.assertIn("lipo -create", self.script)
        self.assertIn("lipo -archs", self.script)

    def test_bundle_is_ad_hoc_signed_zipped_and_hashed(self):
        self.assertIn('codesign --force --sign -', self.script)
        self.assertIn("ditto -c -k --keepParent", self.script)
        self.assertIn("shasum -a 256", self.script)
        self.assertIn('"CC Menubar.app"', self.script)

    def test_does_not_touch_internal_install_outputs(self):
        # build.sh의 결과물·내부 설치 경로·LaunchAgent는 이 스크립트의 대상이 아니다.
        for forbidden in ('"$BUILD_DIR/cc-menubar"', "Applications/cc-menubar", "com.qjc.cc-menubar",
                          "launchctl", "install.py"):
            self.assertNotIn(forbidden, self.script)

    def test_snapshot_smokes_run_on_the_universal_binary(self):
        self.assertIn("snapshot_test_teamclaude_table.py", self.script)
        self.assertIn("snapshot_test_empty_home.py", self.script)

    def test_info_plist_generator(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / "Info.plist"
            result = subprocess.run(["bash", str(SCRIPT), "--info-plist-only", str(out), "1.2.3"],
                                    capture_output=True, text=True, timeout=60)
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            info = plistlib.loads(out.read_bytes())
        self.assertIs(info["LSUIElement"], True)
        self.assertEqual("13.0", info["LSMinimumSystemVersion"])
        self.assertEqual("cc-menubar", info["CFBundleExecutable"])
        self.assertEqual("CC Menubar", info["CFBundleName"])
        self.assertEqual("dev.teamclaude.cc-menubar", info["CFBundleIdentifier"])
        self.assertEqual("1.2.3", info["CFBundleShortVersionString"])
        self.assertEqual("APPL", info["CFBundlePackageType"])

    def test_version_comes_from_the_release_tag(self):
        self.assertIn("menubar-v", self.script)
        self.assertIn("MENUBAR_VERSION", self.script)


if __name__ == "__main__":
    unittest.main()
