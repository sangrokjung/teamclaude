#!/usr/bin/env python3
"""본체 수집기: 머신마다 메뉴바가 쓰는 Grok·agy 상태 스냅샷을 한 파일로 모은다.

각 머신의 cc-menubar는 60초마다 ~/.cache/cc-menubar/cli-status.json을 쓴다(schema 1).
이 스크립트는 fleet 매니페스트(nodes[].host, nodes[].menubarOfflineOk)의 호스트마다
`ssh -o BatchMode=yes -o ConnectTimeout=5 <host> head -c 262145 ~/.cache/cc-menubar/cli-status.json`을
병렬(최대 8, 호스트당 20초)로 읽고(출력은 256KiB+1바이트까지만 받는다), 본체 자기 파일("hub")과 함께
~/.claude/cache/fleet-cli.json에 원자적으로(임시 파일 → rename) 쓴다.

    {"collected_at": <epoch>, "hosts": [{"name", "ok", "error", "status"}]}

error: "ssh"(연결 실패) · "offline"(menubarOfflineOk 노드의 연결 실패) · "timeout" · "missing"(파일 없음)
       · "oversize"(256KiB 초과)
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
import signal
import subprocess
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

SCHEMA = 1
REMOTE_PATH = "~/.cache/cc-menubar/cli-status.json"
DEFAULT_LOCAL = os.path.expanduser("~/.cache/cc-menubar/cli-status.json")
DEFAULT_OUT = os.path.expanduser("~/.claude/cache/fleet-cli.json")
MAX_JOBS = 8
HOST_TIMEOUT = 20.0
MAX_BYTES = 256 * 1024
MAX_GROUPS = 32  # 호스트당 agy 레인 상한. 넘으면 그 호스트를 "parse"로 둔다(조용히 자르지 않는다)
MAX_OUTPUT_BYTES = 2 * 1024 * 1024  # 모은 파일 전체 상한. 넘으면 쓰지 않는다(메뉴바도 2MiB 넘는 파일은 읽지 않는다)
GROK_AUTH = {"ok", "expired", "login", "unavailable"}
AGY_AUTH = {"ok", "login", "error"}


class _BadType(Exception):
    """필드 타입이 틀렸다. 그 호스트만 "parse"로 둔다."""


def _number(value: Any) -> Optional[float]:
    """없으면 None. 수가 아니면(불리언 포함) 타입 오류. NaN·무한은 값만 비운다."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _BadType()
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
    if value is None:
        return None
    if not isinstance(value, str):
        raise _BadType()
    return value[:limit] if value else None


def _flag(value: Any) -> bool:
    if value is None:
        return False
    if not isinstance(value, bool):
        raise _BadType()
    return value


def _section(raw: Any, auth_values: set) -> Dict[str, Any]:
    if not isinstance(raw, dict) or not isinstance(raw.get("installed"), bool):
        raise _BadType()
    auth = raw.get("auth")
    if not isinstance(auth, str) or auth not in auth_values:
        raise _BadType()
    return raw


def _groups(raw: Any) -> List[Dict[str, Any]]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > MAX_GROUPS:
        raise _BadType()
    groups = []
    for group in raw:  # 레인은 자르지 않는다(상한을 넘으면 위에서 호스트째 거부).
        if not isinstance(group, dict) or _text(group.get("name")) is None:
            raise _BadType()
        groups.append({
            "name": _text(group.get("name")),
            "weekly_remaining_pct": _percent(group.get("weekly_remaining_pct")),
            "weekly_reset": _text(group.get("weekly_reset")),
            "five_hour_remaining_pct": _percent(group.get("five_hour_remaining_pct")),
            "five_hour_reset": _text(group.get("five_hour_reset")),
        })
    return groups


def sanitize_status(raw: Any) -> Optional[Dict[str, Any]]:
    """schema 1 스냅샷을 검사해 알려진 키만 담은 사본을 돌려준다. 모양·타입이 틀리면 None."""
    if not isinstance(raw, dict) or raw.get("schema") != SCHEMA or isinstance(raw.get("schema"), bool):
        return None
    try:
        host = _text(raw.get("host"))
        written = _number(raw.get("written_at"))
        if host is None or written is None or not (0 < written < 10_000_000_000):
            return None
        grok = _section(raw.get("grok"), GROK_AUTH)
        agy = _section(raw.get("agy"), AGY_AUTH)
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
                "sessions_today_partial": _flag(grok.get("sessions_today_partial")),
                "last_ok_at": _text(grok.get("last_ok_at")),
                "fetch_failed": _flag(grok.get("fetch_failed")),
            },
            "agy": {
                "installed": agy["installed"],
                "auth": agy["auth"],
                "groups": _groups(agy.get("groups")),
                "last_used": _text(agy.get("last_used")),
                "conversations_today": _count(agy.get("conversations_today")),
                "conversations_today_partial": _flag(agy.get("conversations_today_partial")),
                "last_ok_at": _text(agy.get("last_ok_at")),
                "fetch_failed": _flag(agy.get("fetch_failed")),
            },
        }
    except _BadType:
        return None


def parse_status(text: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    try:
        status = sanitize_status(json.loads(text))
    except Exception:  # 예상 못 한 모양도 그 호스트만 "parse"다. 전체 수집을 멈추지 않는다.
        return None, "parse"
    return (status, None) if status is not None else (None, "parse")


def entry(name: str, status: Optional[Dict[str, Any]], error: Optional[str]) -> Dict[str, Any]:
    return {"name": name, "ok": error is None, "error": error, "status": status if error is None else None}


def read_local(name: str, path: str) -> Dict[str, Any]:
    try:
        with open(path, "rb") as handle:
            data = handle.read(MAX_BYTES + 1)  # 상한까지만 읽는다
    except OSError:
        return entry(name, None, "missing")
    if len(data) > MAX_BYTES:
        return entry(name, None, "oversize")
    status, error = parse_status(data.decode("utf-8", "replace"))
    return entry(name, status, error)


def remote_command(ssh: str, host: str) -> List[str]:
    # 원격에서도 상한+1바이트까지만 보낸다. 넘쳤는지는 받은 길이로 판정한다.
    return [ssh, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host,
            "head", "-c", str(MAX_BYTES + 1), REMOTE_PATH]


def _bounded_read(stream: Any, limit: int, sink: List[bytes]) -> None:
    total = 0
    while total <= limit:
        chunk = stream.read(min(65536, limit + 1 - total))
        if not chunk:
            break
        sink.append(chunk)
        total += len(chunk)


def _stop(process: "subprocess.Popen[bytes]") -> None:
    # 프로세스 묶음 전체를 끊는다. ssh가 남긴 자식이 파이프를 붙잡아 읽기가 끝나지 않는 일을 막는다.
    try:
        os.killpg(process.pid, signal.SIGKILL)  # 묶음 우두머리가 이미 끝났어도 남은 자식까지
    except OSError:
        if process.poll() is None:
            process.kill()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def read_remote(host: str, offline_ok: bool, ssh: str = "ssh", timeout: float = HOST_TIMEOUT) -> Dict[str, Any]:
    """출력은 MAX_BYTES+1바이트까지만 메모리에 담는다. 넘치거나 시간을 넘기면 프로세스를 끊는다."""
    deadline = time.monotonic() + timeout
    try:
        process = subprocess.Popen(remote_command(ssh, host), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return entry(host, None, "ssh")
    chunks: List[bytes] = []
    reader = threading.Thread(target=_bounded_read, args=(process.stdout, MAX_BYTES, chunks), daemon=True)
    reader.start()
    reader.join(max(0.0, deadline - time.monotonic()))
    try:
        if reader.is_alive():
            _stop(process)
            reader.join(2)
            return entry(host, None, "timeout")
        data = b"".join(chunks)
        if len(data) > MAX_BYTES:
            _stop(process)
            return entry(host, None, "oversize")
        try:
            returncode = process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            _stop(process)
            return entry(host, None, "timeout")
    finally:
        if process.stdout:
            process.stdout.close()
    if returncode == 255:
        # ssh 자체 실패(연결·인증). 꺼질 수 있는 노드(노트북)는 꺼짐으로 둔다.
        return entry(host, None, "offline" if offline_ok else "ssh")
    if returncode != 0:
        return entry(host, None, "missing")
    status, error = parse_status(data.decode("utf-8", "replace"))
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


class OutputTooLarge(Exception):
    pass


def write_atomic(path: str, payload: Dict[str, Any]) -> None:
    data = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    if len(data.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise OutputTooLarge()
    folder = os.path.dirname(path) or "."
    os.makedirs(folder, exist_ok=True)
    temp = os.path.join(folder, ".%s.%d.tmp" % (os.path.basename(path), os.getpid()))
    try:
        with open(temp, "w", encoding="utf-8") as handle:
            handle.write(data)
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
    try:
        write_atomic(args.out, payload)
    except OutputTooLarge:
        print("fleet-cli-collect: output over %d bytes, not written" % MAX_OUTPUT_BYTES, file=sys.stderr)
        return 3
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
