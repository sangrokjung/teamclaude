#!/usr/bin/env python3
import fcntl
import json
import os
import pathlib
import stat
import sys
import tempfile
import time

ROOT = pathlib.Path.home() / "Library" / "Application Support" / "cc-menubar" / "qa"
REQUEST = ROOT / "request.json"
OUT = ROOT / "out"


def ensure_root():
    if os.path.lexists(ROOT):
        root_stat = ROOT.lstat()
        if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != os.getuid():
            raise SystemExit(f"unsafe QA directory: {ROOT}")
    else:
        ROOT.mkdir(parents=True, mode=0o700)
    os.chmod(ROOT, 0o700)
    if os.path.lexists(OUT):
        out_stat = OUT.lstat()
        if not stat.S_ISDIR(out_stat.st_mode) or out_stat.st_uid != os.getuid():
            raise SystemExit(f"unsafe QA output directory: {OUT}")
    else:
        OUT.mkdir(mode=0o700)
    os.chmod(OUT, 0o700)


def is_enabled():
    if not os.path.lexists(ROOT) or not os.path.lexists(ROOT / "ENABLED"):
        return False
    root_stat = ROOT.lstat()
    enabled_stat = (ROOT / "ENABLED").lstat()
    return (stat.S_ISDIR(root_stat.st_mode) and root_stat.st_uid == os.getuid()
            and stat.S_IMODE(root_stat.st_mode) == 0o700
            and stat.S_ISREG(enabled_stat.st_mode) and enabled_stat.st_uid == os.getuid())


def path_exists_without_following(path):
    return os.path.lexists(path)


def default_steps():
    return [
        {"open": True},
        {"capture": "overview"},
        {"state": "overview"},
        {"key": "2"}, {"capture": "claude"},
        {"key": "3"}, {"capture": "codex"},
        {"key": "4"}, {"capture": "burn"},
        {"key": "5"}, {"capture": "cli"},
        {"key": "1"}, {"key": "r"}, {"wait": 2}, {"open": True},
        {"capture": "refreshed"}, {"key": "cmd+k"},
        {"capture": "actions"}, {"key": "escape"}, {"close": True},
        {"state": "closed"},
    ]


MAX_REQUEST_BYTES = 64 * 1024


def encode_request(request):
    """앱이 받는 것과 같은 상한·이름 규칙을 먼저 본다. 앱이 거부하면 결과를 기다리지 않고 바로 실패한다."""
    used = {"result"}
    for step in request["steps"]:
        if isinstance(step, dict):
            for kind in ("capture", "state"):
                name = step.get(kind)
                if isinstance(name, str):
                    if name in used:
                        raise SystemExit(f"output name used twice or reserved: {name}")
                    used.add(name)
    # id를 맨 앞에 둔다 — 앱이 잘린 요청에서도 id를 찾아 거부 결과를 돌려줄 수 있다.
    data = (json.dumps({"id": request["id"], "steps": request["steps"]}, separators=(",", ":")) + "\n").encode("utf-8")
    if len(data) > MAX_REQUEST_BYTES:
        raise SystemExit(f"request exceeds {MAX_REQUEST_BYTES} bytes ({len(data)})")
    return data


def write_request(request):
    ensure_root()
    if not is_enabled():
        raise SystemExit("QA is disabled; run 'menubar/qa.sh enable' first")
    data = encode_request(request)
    request_id = request["id"]
    destination = OUT / request_id
    # 검사와 발행을 잠금 하나로 묶고, 발행은 덮어쓰지 않는 link로 한다(동시 실행 두 개가 서로의 요청을 지우지 않게).
    lock_fd = os.open(ROOT / ".publish.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        if path_exists_without_following(destination):
            raise SystemExit(f"output already exists: {destination}")
        if path_exists_without_following(REQUEST):
            raise SystemExit(f"request already pending: {REQUEST}")
        fd, temporary = tempfile.mkstemp(prefix=".publish-", dir=ROOT)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            try:
                os.link(temporary, REQUEST)
            except FileExistsError:
                raise SystemExit(f"request already pending: {REQUEST}")
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
    finally:
        os.close(lock_fd)
    return destination


def run(argument=None):
    if argument:
        try:
            with open(argument, encoding="utf-8") as handle:
                steps = json.load(handle)
        except (OSError, json.JSONDecodeError) as error:
            raise SystemExit(f"could not read steps JSON: {error}")
    else:
        steps = default_steps()
    if not isinstance(steps, list):
        raise SystemExit("steps JSON must be an array")
    request_id = f"qa-{int(time.time())}-{os.getpid()}"
    destination = write_request({"id": request_id, "steps": steps})
    deadline = time.monotonic() + 150
    result = destination / "result.json"
    rejected = OUT / f"{request_id}.rejected.json"
    while time.monotonic() < deadline:
        if rejected.is_file() and not result.is_file():
            result = rejected
        if result.is_file():
            try:
                with result.open(encoding="utf-8") as handle:
                    payload = json.load(handle)
                print(destination)
                if payload.get("completed") and all(step.get("ok") for step in payload.get("steps", [])):
                    return 0
                return 1
            except (OSError, json.JSONDecodeError):
                pass
        time.sleep(0.25)
    print(destination)
    print(f"timed out waiting for {destination} (if the app could not write a result, the request is kept as {ROOT}/failed-*.json)", file=sys.stderr)
    return 1


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "enable":
        ensure_root()
        enabled = ROOT / "ENABLED"
        flags = os.O_CREAT | os.O_WRONLY
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(enabled, flags, 0o600)
        except OSError as error:
            raise SystemExit(f"unsafe ENABLED file: {error}")
        try:
            os.fchmod(fd, 0o600)
        finally:
            os.close(fd)
        print(ROOT)
        return 0
    if command == "disable":
        try:
            (ROOT / "ENABLED").unlink()
        except FileNotFoundError:
            pass
        return 0
    if command == "run":
        return run(sys.argv[2] if len(sys.argv) > 2 else None)
    print("usage: qa.sh enable|disable|run [steps-json-file]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
