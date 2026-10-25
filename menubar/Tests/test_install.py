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

            loaded = {"value": True}

            def launch(args, **kwargs):
                calls.append(args)
                if args[1] == "print":
                    return subprocess.CompletedProcess(args, 0 if loaded["value"] else 113)
                if args[1] == "bootout":
                    loaded["value"] = False
                if args[1] == "bootstrap":
                    # 1은 내려가는 중 겹침(5)이 아닌 실제 실패라 재시도하지 않고 원복해야 한다.
                    if fail and sum(a[1] == "bootstrap" for a in calls) == 1:
                        raise subprocess.CalledProcessError(1, args)
                    loaded["value"] = True
                return subprocess.CompletedProcess(args, 0)

            with patch.object(installer.subprocess, "run", side_effect=launch), \
                    patch.object(installer.time, "sleep", lambda _: None):
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

    def test_waits_for_bootout_before_bootstrap(self):
        # 실측(2026-10-25): bootout 직후 서비스가 잠깐 남아 있으면 bootstrap이 exit 5로 실패했고,
        # 롤백의 재bootstrap도 같은 이유로 실패해 메뉴바가 꺼진 채 남았다.
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            directory = home / "apps"
            directory.mkdir(parents=True)
            (directory / "cc-menubar").write_bytes(b"old-binary")
            plist = home / "Library/LaunchAgents/com.qjc.cc-menubar.plist"
            plist.parent.mkdir(parents=True)
            plist.write_bytes(plistlib.dumps({"Label": installer.LABEL}))
            candidate = home / "candidate"
            candidate.write_bytes(b"new-binary")
            candidate.chmod(0o700)
            state = {"loaded": True, "lingering": 0}

            def launch(args, **kwargs):
                verb = args[1]
                if verb == "print":
                    if state["lingering"] > 0:
                        state["lingering"] -= 1
                        return subprocess.CompletedProcess(args, 0)
                    return subprocess.CompletedProcess(args, 0 if state["loaded"] else 113)
                if verb == "bootout":
                    state["loaded"] = False
                    state["lingering"] = 3  # 서비스가 세 번 조회되는 동안 아직 남아 있다
                    return subprocess.CompletedProcess(args, 0)
                if verb == "bootstrap":
                    if state["loaded"] or state["lingering"] > 0:
                        raise subprocess.CalledProcessError(5, args)
                    state["loaded"] = True
                    return subprocess.CompletedProcess(args, 0)
                return subprocess.CompletedProcess(args, 0)

            with patch.object(installer.subprocess, "run", side_effect=launch), \
                    patch.object(installer.time, "sleep", lambda _: None):
                installer.install(candidate, directory, home)
            self.assertEqual((directory / "cc-menubar").read_bytes(), b"new-binary")
            self.assertTrue(state["loaded"])

    def test_no_desktop_launcher_or_dependency(self):
        main = (ROOT / "Sources/main.swift").read_text()
        self.assertNotIn("openCCVisualizer", main)
        self.assertNotIn("cc-visualizer 열기", main)


if __name__ == "__main__":
    unittest.main()
