#!/usr/bin/env python3
"""허브 메뉴바가 바뀌면 같은 바이너리를 fleet 노드 전부에 설치한다.

  fleet-propagate.py run --manifest <fleet manifest.json>      # 한 회차 (LaunchAgent가 부른다)
  fleet-propagate.py install --manifest <fleet manifest.json>  # 키트 복사 + LaunchAgent 등록

매니페스트 형식(기존 fleet 매니페스트를 그대로 읽는다):
  {"menubar": "<허브 설치 바이너리>", "nodes": [{"id", "host", "python", "menubar"?, "menubarAutoUpdate"?}]}

전파 조건: 허브 LaunchAgent가 그 바이너리로 실행 중이고, 교체 뒤 안정 시간을 넘겼고, --selftest가 통과해야 한다.
허브에서 깨진 판은 워커로 가지 않는다. 노드마다 마지막 성공 해시를 기록해 같은 판을 다시 보내지 않고,
실패한 노드는 다음 회차(WatchPaths 또는 StartInterval)에 다시 시도한다.
"""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time

MENU_LABEL = "com.qjc.cc-menubar"
LABEL = "com.qjc.cc-menubar-fleet"
KIT_FILES = ("fleet-propagate.py", "install.py", "com.qjc.cc-menubar.plist.template")
SSH = ["/usr/bin/ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
SCP = ["/usr/bin/scp", "-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]
STABLE_SECONDS = 20
STABLE_WAIT_LIMIT = 120
REMOTE_TIMEOUT = 240

# 노드에서 실행하는 설치 스크립트. 기존 LaunchAgent가 가리키는 폴더 그대로 교체한다.
# 교체 전: 후보가 이 맥의 아키텍처를 담고 있고 --selftest가 통과해야 한다(실패하면 기존 설치를 건드리지 않는다).
# 교체 후: 해시·실행 프로세스·--selftest를 확인하고, 실패하면 install.py가 남긴 백업으로 되돌린다.
REMOTE = r'''
import os, platform, plistlib, subprocess, sys, time, hashlib
from pathlib import Path
stage, want, fallback = Path(sys.argv[1]), sys.argv[2], sys.argv[3]

def fail(message):
    print("FAIL", message)
    sys.exit(1)

def selftest(binary):
    try:
        result = subprocess.run([str(binary), "--selftest"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as error:
        return "selftest-error %s" % type(error).__name__
    if result.returncode != 0 or not result.stdout.startswith("SELFTEST"):
        return "selftest-failed rc=%d" % result.returncode
    return None

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

plist = Path.home() / "Library/LaunchAgents/com.qjc.cc-menubar.plist"
try:
    current = plistlib.loads(plist.read_bytes())["ProgramArguments"][0]
except Exception:
    current = fallback or str(Path.home() / "Applications/cc-menubar/cc-menubar")
directory = Path(current).parent
target = directory / "cc-menubar"
candidate = stage / "cc-menubar"

def verify():
    if not target.exists() or digest(target) != want:
        return "hash-mismatch"
    service = "gui/%d/com.qjc.cc-menubar" % os.getuid()
    pid = None
    for _ in range(30):
        out = subprocess.run(["launchctl", "print", service], capture_output=True, text=True).stdout
        pid = next((l.split("=")[1].strip() for l in out.splitlines() if l.startswith("\tpid = ")), None)
        if pid:
            break
        time.sleep(1)
    if not pid:
        return "not-running"
    time.sleep(5)  # 바로 죽고 재시작을 반복하는 판을 거른다
    comm = subprocess.run(["ps", "-p", pid, "-o", "comm="], capture_output=True, text=True).stdout.strip()
    if comm != str(target):
        return "not-stable-or-unexpected-process " + comm
    return selftest(target)

installed_backup = None
if not (target.exists() and digest(target) == want):
    archs = subprocess.run(["lipo", "-archs", str(candidate)], capture_output=True, text=True)
    runnable = {platform.machine()} | ({"arm64e"} if platform.machine() == "arm64" else set())
    if archs.returncode != 0 or not runnable & set(archs.stdout.split()):
        fail("arch-mismatch machine=%s candidate=%s" % (platform.machine(), archs.stdout.strip() or "unknown"))
    problem = selftest(candidate)
    if problem:
        fail("candidate-" + problem)
    before = set(directory.glob("backup-*")) if directory.exists() else set()
    result = subprocess.run([sys.executable, str(stage / "install.py"), "--binary", str(candidate),
                             "--install-dir", str(directory)], capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        fail("install-py rc=%d %s" % (result.returncode, result.stderr.strip()[-200:]))
    created = sorted(set(directory.glob("backup-*")) - before)
    installed_backup = created[-1] if created else None
problem = verify()
if problem:
    previous = installed_backup / "cc-menubar" if installed_backup else None
    if previous and previous.exists():
        restored = subprocess.run([sys.executable, str(stage / "install.py"), "--binary", str(previous),
                                   "--install-dir", str(directory)], capture_output=True, text=True, timeout=120)
        fail("%s (rolled-back rc=%d)" % (problem, restored.returncode))
    fail(problem)
print("OK", want[:16])
'''


def now():
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def log(state_dir, message):
    line = "[%s] %s\n" % (now(), message)
    with open(state_dir / "propagate.log", "a") as handle:
        handle.write(line)
    sys.stdout.write(line)


def run(command, **kwargs):
    kwargs.setdefault("capture_output", True)
    kwargs.setdefault("text", True)
    return subprocess.run(command, **kwargs)


def menu_pid(runner=run):
    out = runner(["launchctl", "print", "gui/%d/%s" % (os.getuid(), MENU_LABEL)]).stdout
    return next((l.split("=")[1].strip() for l in out.splitlines() if l.startswith("\tpid = ")), None)


def elapsed_seconds(etime):
    """ps etime([[dd-]hh:]mm:ss)을 초로."""
    days, _, rest = etime.strip().rpartition("-")
    parts = [int(p) for p in rest.split(":")]
    while len(parts) < 3:
        parts.insert(0, 0)
    return int(days or 0) * 86400 + parts[0] * 3600 + parts[1] * 60 + parts[2]


def hub_ready(binary, runner=run, clock=time.time, sleep=time.sleep):
    """허브가 이 바이너리로 안정적으로 실행 중이면 None, 아니면 이유 문자열."""
    deadline = clock() + STABLE_WAIT_LIMIT
    while True:
        reason = _hub_reason(binary, runner, clock)
        if reason is None or not reason.startswith("settling") or clock() >= deadline:
            break
        sleep(5)
    if reason:
        return reason
    result = runner([str(binary), "--selftest"], timeout=60)
    if result.returncode != 0 or not result.stdout.startswith("SELFTEST"):
        return "hub-selftest-failed rc=%d" % result.returncode
    return None


def _hub_reason(binary, runner, clock):
    pid = menu_pid(runner)
    if not pid:
        return "settling: hub-menubar-not-running"
    comm = runner(["ps", "-p", pid, "-o", "comm="]).stdout.strip()
    if comm != str(binary):
        return "hub-menubar-runs-other-binary " + comm
    age = elapsed_seconds(runner(["ps", "-p", pid, "-o", "etime="]).stdout)
    started = clock() - age
    if started < Path(binary).stat().st_mtime - 2:
        return "settling: hub-process-older-than-binary"
    if age < STABLE_SECONDS:
        return "settling: hub-process-too-young"
    return None


def load_state(state_dir):
    try:
        return json.loads((state_dir / "state.json").read_text())
    except (OSError, ValueError):
        return {"nodes": {}}


def save_state(state_dir, state):
    fd, temporary = tempfile.mkstemp(dir=state_dir, prefix=".state-")
    with os.fdopen(fd, "w") as handle:
        json.dump(state, handle, indent=1, ensure_ascii=False)
    os.replace(temporary, state_dir / "state.json")


def targets(manifest):
    return [n for n in manifest.get("nodes", []) if n.get("menubarAutoUpdate", True) and n.get("host")]


def push(node, kit, binary_hash, runner=run):
    """노드 하나에 설치. 성공이면 None, 실패면 이유. 시간 초과도 이 노드의 실패로만 끝난다."""
    try:
        return _push(node, kit, binary_hash, runner)
    except subprocess.TimeoutExpired as error:
        return "timeout %ss %s" % (int(error.timeout), error.cmd[0] if error.cmd else "")
    except OSError as error:
        return "os-error %s" % error


def _push(node, kit, binary_hash, runner):
    host = node["host"]
    stage = ".cache/cc-menubar-fleet/" + binary_hash[:16]
    steps = [
        [*SSH, host, "mkdir -p " + shlex.quote(stage)],
        [*SCP, *[str(kit / name) for name in ("cc-menubar", "install.py", "com.qjc.cc-menubar.plist.template")],
         "%s:%s/" % (host, stage)],
    ]
    for command in steps:
        result = runner(command, timeout=REMOTE_TIMEOUT)
        if result.returncode != 0:
            return "copy-failed rc=%d %s" % (result.returncode, (result.stderr or "").strip()[-200:])
    python = node.get("python") or "python3"
    remote = " ".join([shlex.quote(python), "-", '"$HOME"/' + shlex.quote(stage), shlex.quote(binary_hash),
                       shlex.quote(node.get("menubar", ""))])
    result = runner([*SSH, host, remote], input=REMOTE, timeout=REMOTE_TIMEOUT)
    if result.returncode != 0 or not result.stdout.startswith("OK"):
        return "install-failed rc=%d %s" % (result.returncode, ((result.stderr or "") + (result.stdout or "")).strip()[-300:])
    try:  # 설치는 끝났다. 정리 실패는 결과를 바꾸지 않는다.
        runner([*SSH, host, "rm -rf " + shlex.quote(stage)], timeout=60)
    except (subprocess.TimeoutExpired, OSError):
        pass
    return None


def propagate(manifest, state_dir, kit_source, runner=run, clock=time.time, sleep=time.sleep):
    """한 회차. 종료 코드: 0 = 전 노드 최신이거나 대기, 1 = 실패 노드 있음."""
    binary = Path(manifest["menubar"]).resolve()
    marker = state_dir / "FAILED"
    reason = hub_ready(binary, runner, clock, sleep)
    if reason:
        log(state_dir, "대기: " + reason)
        if reason.startswith("settling"):
            return 0  # 허브가 막 바뀌는 중. 다음 회차가 다시 본다.
        marker.write_text(json.dumps({"at": now(), "hub": reason}, ensure_ascii=False, indent=1))
        return 1
    state = load_state(state_dir)
    with tempfile.TemporaryDirectory(prefix="cc-menubar-fleet-") as directory:
        kit = Path(directory)
        shutil.copy2(binary, kit / "cc-menubar")  # 회차 중 허브가 또 바뀌어도 한 판만 보낸다
        for name in ("install.py", "com.qjc.cc-menubar.plist.template"):
            shutil.copy2(kit_source / name, kit / name)
        binary_hash = sha256(kit / "cc-menubar")
        failures = {}
        for node in targets(manifest):
            record = state["nodes"].get(node["id"], {})
            if record.get("hash") == binary_hash:
                continue
            error = push(node, kit, binary_hash, runner)
            if error:
                # 실패한 시도 뒤에는 노드에 무엇이 남았는지 모른다. 옛 성공 해시를 지워 다음 회차가 반드시 다시 확인하게 한다.
                failures[node["id"]] = error
                state["nodes"][node["id"]] = {"lastError": error, "lastErrorAt": now()}
                log(state_dir, "실패 %s: %s" % (node["id"], error))
            else:
                state["nodes"][node["id"]] = {"hash": binary_hash, "at": now()}
                log(state_dir, "설치 %s: %s" % (node["id"], binary_hash[:16]))
            save_state(state_dir, state)  # 노드마다 바로 기록한다
        state["hub"] = {"hash": binary_hash, "checkedAt": now()}
        save_state(state_dir, state)
    if failures:
        marker.write_text(json.dumps({"at": now(), "hash": binary_hash, "nodes": failures}, ensure_ascii=False, indent=1))
        return 1
    if marker.exists():
        marker.unlink()
    (state_dir / "last-ok").write_text(now() + " " + binary_hash + "\n")
    return 0


def run_command(args):
    manifest_path = Path(args.manifest).expanduser()
    manifest = json.loads(manifest_path.read_text())
    state_dir = Path(args.state_dir).expanduser() if args.state_dir else Path(manifest["menubar"]).resolve().parent / "fleet"
    state_dir.mkdir(parents=True, exist_ok=True)
    with open(state_dir / ".lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # 앞 회차가 아직 돈다. 끝난 뒤 남은 노드는 다음 회차가 맡는다.
        try:
            return propagate(manifest, state_dir, Path(__file__).resolve().parent)
        except Exception as error:  # 감시 불능도 표식으로 남긴다
            (state_dir / "FAILED").write_text(json.dumps({"at": now(), "error": repr(error)}, ensure_ascii=False))
            log(state_dir, "오류: %r" % (error,))
            return 1


def install_command(args):
    manifest_path = Path(args.manifest).expanduser().resolve(strict=True)
    manifest = json.loads(manifest_path.read_text())
    binary = Path(manifest["menubar"]).resolve()
    kit = binary.parent / "fleet"
    kit.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    for name in KIT_FILES:  # 1) 스크립트 먼저
        shutil.copy2(source / name, kit / name)
    os.chmod(kit / "fleet-propagate.py", 0o755)
    if not os.access(kit / "fleet-propagate.py", os.X_OK):
        raise SystemExit("키트 복사 실패")
    plist = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    data = {
        "Label": LABEL,
        "ProgramArguments": ["/usr/bin/python3", str(kit / "fleet-propagate.py"), "run", "--manifest", str(manifest_path)],
        "WatchPaths": [str(binary)],
        "StartInterval": 600,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "StandardOutPath": str(kit / "launchd.log"),
        "StandardErrorPath": str(kit / "launchd.error.log"),
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": str(Path.home())},
    }
    fd, temporary = tempfile.mkstemp(dir=plist.parent, prefix=".cc-menubar-fleet-")
    with os.fdopen(fd, "wb") as handle:  # 2) plist는 그 다음
        handle.write(plistlib.dumps(data))
    os.chmod(temporary, 0o644)
    service = "gui/%d/%s" % (os.getuid(), LABEL)
    subprocess.run(["launchctl", "bootout", service], capture_output=True)
    os.replace(temporary, plist)
    for attempt in range(5):  # bootout 직후 bootstrap은 exit 5로 실패할 수 있다
        result = subprocess.run(["launchctl", "bootstrap", "gui/%d" % os.getuid(), str(plist)], capture_output=True, text=True)
        if result.returncode == 0:
            break
        time.sleep(1)
    else:
        raise SystemExit("bootstrap 실패: " + result.stderr.strip())
    print("키트:", kit)
    print("LaunchAgent:", plist)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("run", "install"):
        command = sub.add_parser(name)
        command.add_argument("--manifest", required=True)
        if name == "run":
            command.add_argument("--state-dir")
    args = parser.parse_args()
    sys.exit(run_command(args) if args.command == "run" else install_command(args) or 0)


if __name__ == "__main__":
    main()
