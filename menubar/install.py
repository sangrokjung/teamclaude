import argparse
import datetime
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

LABEL = "com.qjc.cc-menubar"
ROOT = Path(__file__).resolve().parent


def atomic_copy(source, target, mode):
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".cc-menubar-", dir=target.parent)
    try:
        os.close(fd)
        shutil.copyfile(source, temporary)
        os.chmod(temporary, mode)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(binary, directory, home=None):
    home = Path.home() if home is None else home
    binary = binary.resolve(strict=True)
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError("실행 가능한 메뉴바 바이너리가 필요합니다")
    target = directory / "cc-menubar"
    plist = home / "Library/LaunchAgents" / (LABEL + ".plist")
    domain = "gui/" + str(os.getuid())
    service = domain + "/" + LABEL
    data = plistlib.loads((ROOT / "com.qjc.cc-menubar.plist.template").read_bytes())
    data["ProgramArguments"] = [str(target)]
    data["StandardOutPath"] = str(directory / "cc-menubar.log")
    data["StandardErrorPath"] = str(directory / "cc-menubar.error.log")
    data["EnvironmentVariables"]["HOME"] = str(home)
    directory.mkdir(parents=True, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime("backup-%Y%m%d-%H%M%S-"), dir=directory))
    existed = [(target, backup / "cc-menubar", 0o700), (plist, backup / "com.qjc.cc-menubar.plist", 0o600)]
    for path, saved, _ in existed:
        if path.exists():
            shutil.copy2(path, saved)
    loaded = subprocess.run(["launchctl", "print", service], capture_output=True).returncode == 0
    staged_plist = backup / "candidate.plist"
    staged_plist.write_bytes(plistlib.dumps(data))
    os.chmod(staged_plist, 0o600)
    try:
        if loaded:
            subprocess.run(["launchctl", "bootout", service], check=True, capture_output=True)
        atomic_copy(binary, target, 0o700)
        atomic_copy(staged_plist, plist, 0o600)
        subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True, capture_output=True)
    except Exception:
        subprocess.run(["launchctl", "bootout", service], capture_output=True)
        for path, saved, mode in existed:
            if saved.exists():
                atomic_copy(saved, path, mode)
            elif path.exists():
                path.unlink()
        if loaded and plist.exists():
            subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True, capture_output=True)
        raise
    print("설치:", target)
    print("LaunchAgent:", plist)
    print("복원용 백업:", backup)


def main():
    parser = argparse.ArgumentParser(description="검증한 cc-menubar 설치 및 LaunchAgent 등록")
    parser.add_argument("--install-dir", type=Path, default=Path.home() / "Applications/cc-menubar")
    parser.add_argument("--binary", type=Path, help="이미 테스트·빌드한 바이너리 (없으면 전체 빌드)")
    args = parser.parse_args()
    if platform.system() != "Darwin":
        parser.error("macOS에서만 설치할 수 있습니다")
    binary = args.binary
    if binary is None:
        subprocess.run(["bash", str(ROOT / "build.sh")], check=True)
        binary = ROOT / ".build/cc-menubar"
    install(binary, args.install_dir.expanduser().resolve())


if __name__ == "__main__":
    main()
