import argparse
import datetime
import fcntl
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile
import time

LABEL = "com.qjc.cc-menubar"
# 설치 전체(백업·bootout·교체·bootstrap·롤백)를 한 번에 하나만 돌게 하는 잠금 파일. 설치 폴더 안에 둔다.
LOCK_NAME = ".install.lock"
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


def wait_until_unloaded(service, timeout=10.0, interval=0.2):
    """bootout은 서비스가 사라지기 전에 돌아올 수 있다. 조회가 실패할 때(=내려감)까지 기다린다."""
    deadline = time.monotonic() + timeout
    while subprocess.run(["launchctl", "print", service], capture_output=True).returncode == 0:
        if time.monotonic() >= deadline:
            return False
        time.sleep(interval)
    return True


def bootstrap(domain, service, plist, attempts=5, interval=0.5):
    """내려가는 중인 서비스와 겹치면 bootstrap이 exit 5로 실패한다. 내려갈 때까지 기다리며 다시 시도한다."""
    for attempt in range(attempts):
        wait_until_unloaded(service)
        try:
            subprocess.run(["launchctl", "bootstrap", domain, str(plist)], check=True, capture_output=True)
            return
        except subprocess.CalledProcessError as error:
            if error.returncode != 5 or attempt == attempts - 1:
                raise
            time.sleep(interval)


def install(binary, directory, home=None):
    """동시에 두 설치가 돌면 서로의 파일을 덮고 진 쪽이 이긴 쪽 결과를 롤백할 수 있다. 잠금을 쥔 채 설치한다."""
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / LOCK_NAME, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        _install_locked(binary, directory, home)


def _install_locked(binary, directory, home=None):
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
        bootstrap(domain, service, plist)
    except Exception:
        subprocess.run(["launchctl", "bootout", service], capture_output=True)
        for path, saved, mode in existed:
            if saved.exists():
                atomic_copy(saved, path, mode)
            elif path.exists():
                path.unlink()
        if loaded and plist.exists():
            bootstrap(domain, service, plist)
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
