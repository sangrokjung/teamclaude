import importlib.util
from pathlib import Path
import plistlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("installer", ROOT / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def exercise(self, fail=False):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            directory = home / "Apps & Tools/menu bar"
            directory.mkdir(parents=True)
            target = directory / "cc-menubar"
            target.write_bytes(b"old-binary")
            plist = home / "Library/LaunchAgents/com.qjc.cc-menubar.plist"
            plist.parent.mkdir(parents=True)
            old = plistlib.dumps({"Label": installer.LABEL, "ProgramArguments": [str(target)]})
            plist.write_bytes(old)
            candidate = home / "candidate"
            candidate.write_bytes(b"new-binary")
            candidate.chmod(0o700)
            calls = []

            def launch(args, **kwargs):
                calls.append(args)
                if fail and args[1] == "bootstrap" and sum(a[1] == "bootstrap" for a in calls) == 1:
                    raise subprocess.CalledProcessError(5, args)
                return subprocess.CompletedProcess(args, 0)

            with patch.object(installer.subprocess, "run", side_effect=launch):
                if fail:
                    with self.assertRaises(subprocess.CalledProcessError):
                        installer.install(candidate, directory, home)
                    self.assertEqual(target.read_bytes(), b"old-binary")
                    self.assertEqual(plist.read_bytes(), old)
                    self.assertEqual(sum(a[1] == "bootstrap" for a in calls), 2)
                else:
                    installer.install(candidate, directory, home)
                    self.assertEqual(target.read_bytes(), b"new-binary")
                    actual = plistlib.loads(plist.read_bytes())
                    self.assertEqual(actual["ProgramArguments"], [str(target)])
                    self.assertEqual(actual["EnvironmentVariables"]["HOME"], str(home))
                    self.assertEqual(actual["ProcessType"], "Interactive")
            self.assertEqual(candidate.read_bytes(), b"new-binary")
            self.assertEqual(list(directory.glob("backup-*/cc-menubar"))[0].read_bytes(), b"old-binary")

    def test_install_keeps_backup_and_encodes_paths(self):
        self.exercise()

    def test_failed_launch_restores_binary_and_plist(self):
        self.exercise(fail=True)

    def test_no_desktop_launcher_or_dependency(self):
        main = (ROOT / "Sources/main.swift").read_text()
        self.assertNotIn("openCCVisualizer", main)
        self.assertNotIn("cc-visualizer 열기", main)


if __name__ == "__main__":
    unittest.main()
