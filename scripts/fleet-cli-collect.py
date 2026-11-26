#!/usr/bin/env python3
"""본체 수집기: 머신마다 메뉴바가 쓰는 Grok·agy 상태 스냅샷을 한 파일로 모은다.

각 머신의 cc-menubar는 60초마다 ~/.cache/cc-menubar/cli-status.json을 쓴다(schema 1).
이 스크립트는 fleet 매니페스트(nodes[].host, nodes[].menubarOfflineOk)의 호스트마다
`ssh -o BatchMode=yes -o ConnectTimeout=5 <host> cat ~/.cache/cc-menubar/cli-status.json`을
병렬(최대 8, 호스트당 20초)로 읽고, 본체 자기 파일("hub")과 함께
~/.claude/cache/fleet-cli.json에 원자적으로(임시 파일 → rename) 쓴다.

    {"collected_at": <epoch>, "hosts": [{"name", "ok", "error", "status"}]}

error: "ssh"(연결 실패) · "offline"(menubarOfflineOk 노드의 연결 실패) · "timeout" · "missing"(파일 없음)
       · "parse"(JSON이 아니거나 schema·필수 키가 틀림). 실패한 호스트만 ok=false다.
status는 알려진 키만 다시 담는다(원격 파일의 다른 내용을 옮기지 않는다). 토큰·키 값은 다루지 않는다.

파이썬 3.9 호환, 표준 라이브러리만 쓴다. launchd 등록은 하지 않는다(설치하는 쪽이 한다).
    python3 scripts/fleet-cli-collect.py --manifest <매니페스트> --once
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, List, Optional, Tuple

SCHEMA = 1
REMOTE_PATH = "~/.cache/cc-menubar/cli-status.json"
DEFAULT_LOCAL = os.path.expanduser("~/.cache/cc-menubar/cli-status.json")
DEFAULT_OUT = os.path.expanduser("~/.claude/cache/fleet-cli.json")
MAX_JOBS = 8
HOST_TIMEOUT = 20.0
MAX_BYTES = 256 * 1024
GROK_AUTH = {"ok", "expired", "login", "unavailable"}
AGY_AUTH = {"ok", "login", "error"}


def _number(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return float(value)


def _percent(value: Any) -> Optional[float]:
    number = _number(value)
    return number if number is not None and 0 <= number <= 100 else None


def _count(value: Any) -> Optional[int]:
    number = _number(value)
    return int(number) if number is not None and 0 <= number < 1_000_000 else None


def _text(value: Any, limit: int = 64) -> Optional[str]:
    return value[:limit] if isinstance(value, str) and value else None


def sanitize_status(raw: Any) -> Optional[Dict[str, Any]]:
    """schema 1 스냅샷을 검사해 알려진 키만 담은 사본을 돌려준다. 틀리면 None."""
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA or isinstance(raw.get("schema"), bool):
        return None
    host = _text(raw.get("host"))
    written = _number(raw.get("written_at"))
    grok, agy = raw.get("grok"), raw.get("agy")
    if host is None or written is None or not (0 < written < 10_000_000_000):
        return None
    if not isinstance(grok, dict) or not isinstance(agy, dict):
        return None
    if not isinstance(grok.get("installed"), bool) or grok.get("auth") not in GROK_AUTH:
        return None
    if not isinstance(agy.get("installed"), bool) or agy.get("auth") not in AGY_AUTH:
        return None
    groups = []
    for group in agy.get("groups") or []:
        if not isinstance(group, dict) or _text(group.get("name")) is None:
            continue
        groups.append({
            "name": _text(group.get("name")),
            "weekly_remaining_pct": _percent(group.get("weekly_remaining_pct")),
            "weekly_reset": _text(group.get("weekly_reset")),
            "five_hour_remaining_pct": _percent(group.get("five_hour_remaining_pct")),
            "five_hour_reset": _text(group.get("five_hour_reset")),
        })
    return {
        "schema": SCHEMA,
        "host": host,
        "written_at": int(written),
        "grok": {
            "installed": grok["installed"],
            "auth": grok["auth"],
            "usage_pct": _percent(grok.get("usage_pct")),
            "period_end": _text(grok.get("period_end")),
            "last_used": _text(grok.get("last_used")),
            "sessions_today": _count(grok.get("sessions_today")),
        },
        "agy": {
            "installed": agy["installed"],
            "auth": agy["auth"],
            "groups": groups[:8],
            "last_used": _text(agy.get("last_used")),
            "conversations_today": _count(agy.get("conversations_today")),
        },
    }


def parse_status(text: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    try:
        raw = json.loads(text)
    except (ValueError, TypeError):
        return None, "parse"
    status = sanitize_status(raw)
    return (status, None) if status is not None else (None, "parse")


def entry(name: str, status: Optional[Dict[str, Any]], error: Optional[str]) -> Dict[str, Any]:
    return {"name": name, "ok": error is None, "error": error, "status": status if error is None else None}


def read_local(name: str, path: str) -> Dict[str, Any]:
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_BYTES + 1)
    except FileNotFoundError:
        return entry(name, None, "missing")
    except OSError:
        return entry(name, None, "missing")
    if len(data) > MAX_BYTES:
        return entry(name, None, "parse")
    status, error = parse_status(data.decode("utf-8", "replace"))
    return entry(name, status, error)


def read_remote(host: str, offline_ok: bool, ssh: str = "ssh", timeout: float = HOST_TIMEOUT) -> Dict[str, Any]:
    command = [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, "cat", REMOTE_PATH]
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return entry(host, None, "timeout")
    except OSError:
        return entry(host, None, "ssh")
    if result.returncode == 255:
        # ssh 자체 실패(연결·인증). 꺼질 수 있는 노드(노트북)는 꺼짐으로 둔다.
        return entry(host, None, "offline" if offline_ok else "ssh")
    if result.returncode != 0:
        return entry(host, None, "missing")
    if len(result.stdout) > MAX_BYTES:
        return entry(host, None, "parse")
    status, error = parse_status(result.stdout.decode("utf-8", "replace"))
    return entry(host, status, error)


def load_nodes(manifest_path: str) -> List[Tuple[str, bool]]:
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    nodes = manifest.get("nodes") if isinstance(manifest, dict) else None
    if not isinstance(nodes, list):
        raise ValueError("manifest has no nodes list")
    seen = set()
    out: List[Tuple[str, bool]] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        host = node.get("host")
        if not isinstance(host, str) or not host or host.startswith("-") or host in seen:
            continue
        seen.add(host)
        out.append((host, node.get("menubarOfflineOk") is True))
    return out


def collect(nodes: List[Tuple[str, bool]], local_path: str, ssh: str = "ssh",
            jobs: int = MAX_JOBS, timeout: float = HOST_TIMEOUT, now: Optional[float] = None) -> Dict[str, Any]:
    hosts = [read_local("hub", local_path)]
    workers = max(1, min(jobs, MAX_JOBS))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(read_remote, host, offline_ok, ssh, timeout) for host, offline_ok in nodes]
        hosts.extend(future.result() for future in futures)  # 매니페스트 순서를 지킨다
    return {"collected_at": int(now if now is not None else time.time()), "hosts": hosts}


def write_atomic(path: str, payload: Dict[str, Any]) -> None:
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    temp = os.path.join(folder, ".%s.%d.tmp" % (os.path.basename(path), os.getpid()))
    try:
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def run_once(args: argparse.Namespace) -> int:
    try:
        nodes = load_nodes(args.manifest)
    except (OSError, ValueError) as error:
        print("fleet-cli-collect: manifest error: %s" % type(error).__name__, file=sys.stderr)
        return 2
    payload = collect(nodes, args.local, ssh=args.ssh, jobs=args.jobs, timeout=args.timeout)
    write_atomic(args.out, payload)
    failed = [host["name"] for host in payload["hosts"] if not host["ok"]]
    print("fleet-cli-collect: hosts=%d failed=%d%s" % (
        len(payload["hosts"]), len(failed), (" (" + ",".join(failed) + ")") if failed else ""))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--manifest", required=True, help="fleet 매니페스트 JSON(nodes[].host)")
    parser.add_argument("--out", default=DEFAULT_OUT)
    parser.add_argument("--local", default=DEFAULT_LOCAL, help="본체 자기 스냅샷 경로")
    parser.add_argument("--ssh", default="ssh", help="ssh 실행 파일(테스트용)")
    parser.add_argument("--jobs", type=int, default=MAX_JOBS)
    parser.add_argument("--timeout", type=float, default=HOST_TIMEOUT)
    parser.add_argument("--once", action="store_true", help="한 번 모으고 끝낸다")
    parser.add_argument("--interval", type=float, default=60.0, help="--once가 아닐 때 주기(초)")
    args = parser.parse_args(argv)
    if args.once:
        return run_once(args)
    while True:
        started = time.time()
        run_once(args)
        time.sleep(max(5.0, args.interval - (time.time() - started)))


if __name__ == "__main__":
    sys.exit(main())
