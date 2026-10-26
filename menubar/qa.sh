#!/usr/bin/env python3
import json
import os
import pathlib
import sys
import tempfile
import time

ROOT = pathlib.Path.home() / "Library" / "Application Support" / "cc-menubar" / "qa"
REQUEST = ROOT / "request.json"
OUT = ROOT / "out"


def ensure_root():
    ROOT.mkdir(parents=True, exist_ok=True)
    os.chmod(ROOT, 0o700)
    OUT.mkdir(exist_ok=True)
    os.chmod(OUT, 0o700)


def default_steps():
    return [
        {"open": True},
        {"capture": "overview"},
        {"state": "overview"},
        {"key": "2"}, {"capture": "claude"},
        {"key": "3"}, {"capture": "codex"},
        {"key": "4"}, {"capture": "burn"},
        {"key": "5"}, {"capture": "cli"},
        {"key": "1"}, {"key": "r"}, {"wait": 2},
        {"capture": "refreshed"}, {"key": "cmd+k"},
        {"capture": "actions"}, {"key": "escape"}, {"close": True},
        {"state": "closed"},
    ]


def write_request(request):
    ensure_root()
    if not (ROOT / "ENABLED").is_file():
        raise SystemExit("QA is disabled; run 'menubar/qa.sh enable' first")
    request_id = request["id"]
    destination = OUT / request_id
    if destination.exists():
        raise SystemExit(f"output already exists: {destination}")
    fd, temporary = tempfile.mkstemp(prefix=".request-", dir=ROOT)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(request, handle, separators=(",", ":"))
            handle.write("\n")
        os.chmod(temporary, 0o600)
        os.replace(temporary, REQUEST)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return destination


def run(argument=None):
    if argument:
        with open(argument, encoding="utf-8") as handle:
            steps = json.load(handle)
    else:
        steps = default_steps()
    if not isinstance(steps, list):
        raise SystemExit("steps JSON must be an array")
    request_id = f"qa-{int(time.time())}-{os.getpid()}"
    destination = write_request({"id": request_id, "steps": steps})
    deadline = time.monotonic() + 150
    result = destination / "result.json"
    while time.monotonic() < deadline:
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
    print(f"timed out waiting for {destination}", file=sys.stderr)
    return 1


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "enable":
        ensure_root()
        enabled = ROOT / "ENABLED"
        enabled.touch(exist_ok=True)
        os.chmod(enabled, 0o600)
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
