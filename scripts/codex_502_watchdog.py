#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


EXACT_ERROR = (
    "unexpected status 502 Bad Gateway: Proxy worker failed after dispatch; "
    "request was not replayed"
)
# 같은 "일시적 프록시 경유 실패 → 사용자 입력 대기" 클래스의 변종들 (2026-08-14
# 스톰 실측). 셋 다 프록시/터널이 회복된 뒤에는 이어서 진행해도 안전하다:
# tunnel guard가 감싼 worker 사망 502 · 배포 드레인 503(lease 15s 자가해제) ·
# 죽은 터널 포트의 전송 실패(tunnel-reviver가 포트를 되살린 뒤 nudge 필요).
EXACT_ERRORS = (
    EXACT_ERROR,
    "unexpected status 502 Bad Gateway: TeamCodex tunnel disconnected after "
    "request dispatch; request was not replayed.",
    "unexpected status 503 Service Unavailable: Proxy is draining for a "
    "verified deployment",
    "unexpected status 502 Bad Gateway: Upstream connection failed after "
    "dispatch. Request was not replayed.",
    "unexpected status 504 Gateway Timeout: Upstream overloaded (HTTP 504). "
    "Request was not replayed.",
    "unexpected status 503 Service Unavailable: Upstream overloaded (HTTP 503). "
    "Request was not replayed.",
    # 이 문구는 reqwest 계열의 범용 표현이라 넷 중 오탐 표면이 가장 넓다.
    # 실제 발동은 같은 3줄 내 리터럴 http://127.0.0.1:PORT/codex/responses
    # error-block fullmatch + proxy_healthy + 빈 프롬프트 + send 직전 재검증까지 전부
    # 통과해야 하므로, teamcodex 고유 경로(/codex/responses) 동반 요건이
    # 실질 판별자다 (적대 리뷰 트레이드오프 문서화, 2026-08-14).
    "stream disconnected before completion: error sending request for url",
)
REQUEST_ID_ERROR_PREFIX = (
    "stream disconnected before completion: An error occurred while processing "
    "your request. You can retry your request, or contact us through our help "
    "center at help.openai.com if the error persists. Please include the request "
    "ID "
)
REQUEST_ID_ERROR_SUFFIX = " in your message."
REQUEST_ID_RE = re.compile(
    r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-"
    r"[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}"
)
CAPACITY_ERROR = "Selected model is at capacity. Please try a different model."
RECOVERY_MESSAGE = (
    "일시적 모델·프록시 오류로 turn이 중단되었습니다. 직전 사용자의 최신 유효 "
    "요청을 현재 상태에서 이어서 완료하세요. 이미 성공했을 수 있는 외부·비멱등 "
    "작업은 "
    "재실행하지 말고 먼저 실제 상태를 확인하세요. 직전 security hook 지시를 "
    "준수하고 도구 출력의 시크릿 후보는 마스킹하세요."
)
# cmux send는 리터럴 2문자 "\n"/"\r"을 Enter로 해석한다 — 메시지에 백슬래시가
# 섞이면 composer 조기 제출/분절이 일어날 수 있어 로드타임에 차단한다.
assert "\\" not in RECOVERY_MESSAGE, "RECOVERY_MESSAGE must not contain backslashes"
CMUX = os.environ.get(
    "CMUX_BIN", "/Applications/cmux.app/Contents/Resources/bin/cmux"
)
REMOTE_HOST = os.environ.get("QJC_WORKER_HOST", "studio2")
STATE_DIR = Path(
    os.environ.get("CODEX_WATCHDOG_STATE_DIR", str(Path.home() / ".codex" / "state"))
)
STATE_PATH = STATE_DIR / "codex-502-watchdog.json"
LOCK_PATH = STATE_DIR / "codex-502-watchdog.lock"
LOG_PATH = Path(
    os.environ.get(
        "CODEX_WATCHDOG_LOG_PATH", str(Path.home() / ".codex" / "log" / "codex-502-watchdog.log")
    )
)
MAX_FINGERPRINTS = 500
COOLDOWN_SECONDS = 120
RECOVERY_WINDOW_SECONDS = 30 * 60
RECOVERY_BACKOFF_SECONDS = (120, 300)
MAX_RECOVERY_ATTEMPTS = 3
INSPECTION_BACKOFF_SECONDS = (60, 120, 240, 480, 900)
HEALTH_CRITICAL_LOAD_RATIO = 2.5
HEALTH_CRITICAL_DISK_FREE = 20 * 1024**3
HEALTH_CRITICAL_LOG_DB = 12 * 1024**3
MAX_ERROR_WRAP_LINES = 6
SWAP_USAGE_RE = re.compile(
    r"total\s*=\s*(?P<total>[0-9.]+)M\s+used\s*=\s*(?P<used>[0-9.]+)M\s+free\s*=\s*(?P<free>[0-9.]+)M"
)
ANSI_RE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
CODEX_PLACEHOLDERS = frozenset(
    {
        "Ask Codex to do anything",
        "Explain this codebase",
        "Summarize recent commits",
        "Implement {feature}",
        "Find and fix a bug in @filename",
        "Write tests for @filename",
        "Improve documentation in @filename",
        "Run /review on my current changes",
        "Use /skills to list available skills",
        "Check recently modified functions for compatibility",
        "How many files have been modified?",
        "Will this algorithm scale well?",
    }
)
PROMPT_RE = re.compile(r"^\s*›(?P<body>.*)$")
STATUS_RE = re.compile(
    r"^\s*(?:gpt-[\w.-]+(?:\s+[\w.-]+)*\s+·\s+\S.*|\d+% context left)\s*$",
    re.IGNORECASE,
)
TMUX_STATUS_RE = re.compile(
    r"^\s*\S+\s+\|\s+\S+\s+\d+:\S+.*\b\d{2}/\d{2}\s+\d{2}:\d{2}\s*$"
)
# 에러와 프롬프트 사이에 떠도 "새 출력"이 아닌 codex TUI 상주 안내줄
# (2026-08-14 실측: background terminal 알림 때문에 실제 걸린 세션이 게이트됨).
# before_prompt에만 적용한다 — after_prompt는 STATUS_RE/TMUX_STATUS_RE가
# 이미 엄격한 상태줄 계약을 강제하므로 이 완화가 필요 없다(비대칭 의도).
AMBIENT_LINE_RE = re.compile(
    r"^\d+ background terminals? running · /ps to view · /stop to close$"
)
STATUS_ERROR_BLOCK_RE = re.compile(
    rf"^■\s*(?:{'|'.join(re.escape(error) for error in EXACT_ERRORS[:-1])}),\s*"
    r"url:\s*http://127\.0\.0\.1:(?P<port>\d{2,5})/codex/responses$"
)
STREAM_ERROR_BLOCK_RE = re.compile(
    rf"^■\s*{re.escape(EXACT_ERRORS[-1])}\s*\(\s*"
    r"http://127\.0\.0\.1:(?P<port>\d{2,5})/codex/responses\s*\)$"
)
STREAM_RETRY_ERROR_BLOCK_RE = re.compile(
    rf"^■\s*{re.escape(EXACT_ERRORS[-1])}\s*\(\s*"
    r"http://127\.0\.0\.1:\d{1,5}/codex/responses\)\s*retry url:\s*"
    r"http://127\.0\.0\.1:(?P<port>\d{2,5})/codex/responses$"
)
REQUEST_ID_ERROR_BLOCK_RE = re.compile(
    rf"^■\s*{re.escape(REQUEST_ID_ERROR_PREFIX)}"
    rf"(?P<request_id>{REQUEST_ID_RE.pattern})"
    rf"{re.escape(REQUEST_ID_ERROR_SUFFIX)}$"
)
CAPACITY_ERROR_BLOCK_RE = re.compile(rf"^⚠ {re.escape(CAPACITY_ERROR)}$")
UNSUPPORTED_MODEL_ERROR_BLOCK_RE = re.compile(
    r"^■ \{\"detail\":\"The '[A-Za-z0-9._:-]{1,128}' model is not supported "
    r"when using Codex with a ChatGPT account\.\"\}$"
)
ERROR_BLOCK_RES = (
    STATUS_ERROR_BLOCK_RE,
    STREAM_ERROR_BLOCK_RE,
    STREAM_RETRY_ERROR_BLOCK_RE,
    REQUEST_ID_ERROR_BLOCK_RE,
    CAPACITY_ERROR_BLOCK_RE,
    UNSUPPORTED_MODEL_ERROR_BLOCK_RE,
)
SEMANTIC_BLOCKER_RE = re.compile(
    r"\bUNVERIFIED\s*:",
    re.IGNORECASE,
)
UUID_RE = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-"
    r"[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$"
)
CHECKPOINT_RE = re.compile(
    r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-"
    r"[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$"
)
REMOTE_CHECKPOINT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


@dataclass(frozen=True)
class Match:
    fingerprint: str
    port: int | None


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def log_event(event: str, surface: str | None = None, detail: str | None = None) -> None:
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        fields = [now_iso(), event]
        if surface:
            fields.append(surface)
        if detail:
            fields.append(detail.replace("\n", " ")[:200])
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write("\t".join(fields) + "\n")
    except OSError:
        return


def run_cmux(*args: str, timeout: float = 12) -> str:
    completed = subprocess.run(
        [CMUX, *args],
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if completed.returncode != 0:
        error = completed.stderr.strip() or f"exit {completed.returncode}"
        raise RuntimeError(f"cmux {' '.join(args[:2])}: {error[:200]}")
    return completed.stdout


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text).replace("\r", "")


def is_empty_codex_prompt(line: str) -> bool:
    match = PROMPT_RE.match(line)
    if not match:
        return False
    body = match.group("body").strip()
    return not body or body in CODEX_PLACEHOLDERS


def _match_error_block(
    lines: list[str], index: int
) -> tuple[int | None, int] | None:
    # 좁은 pane에서 request-ID 오류가 여러 줄로 감길 수 있다. 최대 6개
    # continuation만 합치고, 그 뒤의 줄은 사용자 출력으로 취급한다.
    for extra in range(MAX_ERROR_WRAP_LINES + 1):
        segments = [lines[index].rstrip()] + [
            line.strip() for line in lines[index + 1 : index + extra + 1]
        ]
        for blob in ("".join(segments), " ".join(segments)):
            for pattern in ERROR_BLOCK_RES:
                found = pattern.fullmatch(blob.strip())
                if found:
                    port_value = found.groupdict().get("port")
                    if port_value is None:
                        return None, extra
                    port = int(port_value)
                    if 1024 <= port <= 65535:
                        return port, extra
    return None


def detect_waiting_502(
    screen: str, checkpoint: str = "", surface: str = ""
) -> Match | None:
    normalized_screen = strip_ansi(screen)
    if SEMANTIC_BLOCKER_RE.search(normalized_screen):
        return None
    lines = normalized_screen.splitlines()
    error_blocks = [
        (index, matched)
        for index in range(len(lines))
        if (matched := _match_error_block(lines, index)) is not None
    ]
    if not error_blocks:
        return None

    error_index, (port, consumed) = error_blocks[-1]
    # 좁은 pane에서는 긴 에러 메시지의 URL이 다음 줄로 감긴다(실측 2026-08-14:
    # "…, url:" 뒤 줄바꿈 후 "http://127.0.0.1:PORT/…"). 에러 줄부터 최대 2개
    # 연속 줄을 이어붙여 포트를 찾고, 소비한 연속 줄은 에러 블록으로 취급해
    # 빈-프롬프트 검사 대상(trailing)에서 제외한다. 이어붙일 때 첫 줄은
    # rstrip, 연속 줄은 strip — 토큰 중간 랩(포트 숫자 분절)도 복원된다.
    trailing = lines[error_index + consumed + 1 :]
    prompt_indexes = [
        index for index, line in enumerate(trailing) if is_empty_codex_prompt(line)
    ]
    if not prompt_indexes:
        return None
    prompt_index = prompt_indexes[-1]

    before_prompt = [
        line.strip() for line in trailing[:prompt_index]
        if line.strip() and not AMBIENT_LINE_RE.fullmatch(line.strip())
    ]
    after_prompt = [line.strip() for line in trailing[prompt_index + 1 :] if line.strip()]
    if before_prompt:
        return None
    if not 1 <= len(after_prompt) <= 2:
        return None
    if not STATUS_RE.fullmatch(after_prompt[0]):
        return None
    if port is None and not after_prompt[0].lower().startswith("gpt-"):
        return None
    if len(after_prompt) == 2 and not TMUX_STATUS_RE.fullmatch(after_prompt[1]):
        return None

    context_start = max(0, error_index - 6)
    fingerprint_parts = [
        surface,
        checkpoint,
        *lines[context_start : error_index + consumed + 1],
        trailing[prompt_index],
    ]
    if port is None:
        fingerprint_parts.append(after_prompt[0])
    fingerprint_source = "\n".join(fingerprint_parts)
    fingerprint = hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()
    return Match(fingerprint=fingerprint, port=port)


def codex_surfaces(payload: dict[str, Any]) -> list[dict[str, str]]:
    candidates: list[dict[str, str]] = []
    for item in payload.get("surfaces", []):
        binding = item.get("resume_binding") or {}
        ref = item.get("ref")
        checkpoint = binding.get("checkpoint_id")
        if (
            ref
            and item.get("type") == "terminal"
            and binding.get("kind") == "codex"
            and isinstance(checkpoint, str)
            and CHECKPOINT_RE.fullmatch(checkpoint)
        ):
            candidates.append(
                {"ref": str(ref), "checkpoint": checkpoint}
            )
    return candidates


def terminal_surface_ids(payload: dict[str, Any]) -> list[str]:
    surface_ids: list[str] = []
    invalid_terminal_id = False
    for window in payload.get("windows", []):
        if not isinstance(window, dict):
            continue
        for workspace in window.get("workspaces", []):
            if not isinstance(workspace, dict):
                continue
            for pane in workspace.get("panes", []):
                if not isinstance(pane, dict):
                    continue
                for surface in pane.get("surfaces", []):
                    if not isinstance(surface, dict) or surface.get("type") != "terminal":
                        continue
                    surface_id = surface.get("id")
                    if isinstance(surface_id, str) and UUID_RE.fullmatch(surface_id):
                        surface_ids.append(surface_id)
                    else:
                        invalid_terminal_id = True
    if invalid_terminal_id:
        raise ValueError("cmux tree omitted a stable terminal surface id")
    return list(dict.fromkeys(surface_ids))


def terminal_surface_refs(payload: dict[str, Any]) -> dict[str, str]:
    refs: dict[str, str] = {}
    surface_ids_by_ref: dict[str, str] = {}
    for window in payload.get("windows", []):
        if not isinstance(window, dict):
            continue
        for workspace in window.get("workspaces", []):
            if not isinstance(workspace, dict):
                continue
            for pane in workspace.get("panes", []):
                if not isinstance(pane, dict):
                    continue
                for surface in pane.get("surfaces", []):
                    if not isinstance(surface, dict) or surface.get("type") != "terminal":
                        continue
                    surface_id = surface.get("id")
                    surface_ref = surface.get("ref")
                    if (
                        isinstance(surface_id, str)
                        and UUID_RE.fullmatch(surface_id)
                        and isinstance(surface_ref, str)
                        and re.fullmatch(r"surface:\d+", surface_ref)
                    ):
                        existing_ref = refs.get(surface_id)
                        existing_id = surface_ids_by_ref.get(surface_ref)
                        if (
                            existing_ref is not None
                            and existing_ref != surface_ref
                        ) or (
                            existing_id is not None
                            and existing_id != surface_id
                        ):
                            raise ValueError("cmux tree contains ambiguous surface identity")
                        refs[surface_id] = surface_ref
                        surface_ids_by_ref[surface_ref] = surface_id
    return refs


def resume_candidate(
    surface: str, payload: dict[str, Any]
) -> dict[str, str] | None:
    binding = payload.get("resume_binding")
    if not isinstance(binding, dict):
        return None
    command = binding.get("command")
    if isinstance(command, list) and all(isinstance(part, str) for part in command):
        command_tokens = command
    elif isinstance(command, str):
        try:
            command_tokens = shlex.split(command)
        except ValueError:
            command_tokens = []
    else:
        command_tokens = []
    kind = binding.get("kind")
    checkpoint = binding.get("checkpoint_id")
    if not isinstance(checkpoint, str):
        return None
    if kind == "tmux":
        attach_command = (
            len(command_tokens) == 3
            and Path(command_tokens[0]).name == "qjc-agent"
            and command_tokens[1:] == ["attach", checkpoint]
        )
        qjc_agent_command = (
            len(command_tokens) == 2
            and Path(command_tokens[0]).name == "qjc-agent"
            and command_tokens[1] == "codex"
        )
        qjc_worker_command = (
            len(command_tokens) == 3
            and Path(command_tokens[0]).name == "qjc-worker"
            and command_tokens[1:] == ["agent", "codex"]
        )
        if not REMOTE_CHECKPOINT_RE.fullmatch(checkpoint) or not (
            attach_command or qjc_agent_command or qjc_worker_command
        ):
            return None
        remote = "true"
    elif kind == "codex":
        resume_targets = [
            index
            for index in range(len(command_tokens) - 2)
            if Path(command_tokens[index]).name == "codex"
            and command_tokens[index + 1 : index + 3] == ["resume", checkpoint]
        ]
        direct_start = (
            0
            if len(command_tokens) >= 3
            and Path(command_tokens[0]).name == "codex"
            and command_tokens[1:3] == ["resume", checkpoint]
            else None
        )
        cmux_start = None
        if isinstance(command, str) and len(command_tokens) >= 14:
            cwd = command_tokens[2]
            if (
                command_tokens[:2] == ["cd", "--"]
                and command_tokens[3:11]
                == ["2>/dev/null", "||", "[", "!", "-d", cwd, "]", "&&"]
                and Path(command_tokens[11]).name == "codex"
                and command_tokens[12:14] == ["resume", checkpoint]
            ):
                cmux_start = 11
        command_start = direct_start if direct_start is not None else cmux_start
        suffix = (
            command_tokens[command_start + 3 :]
            if command_start is not None
            else []
        )
        if command_start == 0:
            suffix_valid = not suffix
        elif command_start == 11:
            has_final_yolo = bool(suffix) and suffix[-1] == "--yolo"
            if has_final_yolo:
                suffix = suffix[:-1]
            suffix_valid = has_final_yolo and (
                len(suffix) % 2 == 0
                and all(
                    suffix[index] == "-c"
                    and suffix[index + 1] not in {"&&", "||", ";", "|", "&"}
                    for index in range(0, len(suffix), 2)
                )
            )
        else:
            suffix_valid = False
        if (
            not CHECKPOINT_RE.fullmatch(checkpoint)
            or resume_targets != [command_start]
            or not suffix_valid
            or (isinstance(command, str) and ("\n" in command or "\r" in command))
        ):
            return None
        remote = "false"
    else:
        return None
    return {
        "ref": surface,
        "checkpoint": checkpoint,
        "remote": remote,
        "command_ref": binding_command_ref(command_tokens),
    }


def binding_command_ref(command_tokens: list[str]) -> str:
    encoded = json.dumps(
        command_tokens, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def lookup_resume_candidate(
    surface: str,
) -> tuple[dict[str, str] | None, bool]:
    try:
        payload = json.loads(
            run_cmux(
                "--json",
                "surface",
                "resume",
                "get",
                "--surface",
                surface,
                timeout=8,
            )
        )
        if not isinstance(payload, dict):
            return None, True
        return resume_candidate(surface, payload), False
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        return None, True


def lookup_surface_ref(surface: str) -> tuple[str | None, bool]:
    try:
        payload = json.loads(
            run_cmux("--json", "--id-format", "both", "tree", "--all", timeout=8)
        )
        if not isinstance(payload, dict):
            return None, True
        return terminal_surface_refs(payload).get(surface), False
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        return None, True


def cached_surface_ids(candidates: list[dict[str, str]]) -> list[str]:
    return [
        candidate["ref"]
        for candidate in candidates
        if isinstance(candidate, dict)
        and isinstance(candidate.get("ref"), str)
        and UUID_RE.fullmatch(candidate["ref"])
    ]


def process_codex_ttys(process_output: str) -> tuple[set[str], set[str]]:
    local_ttys: set[str] = set()
    remote_ttys: set[str] = set()
    for line in process_output.splitlines():
        fields = line.strip().split(maxsplit=2)
        if len(fields) != 3 or fields[0] == "??":
            continue
        tty, command, arguments = fields
        executable = arguments.split(maxsplit=1)[0]
        if Path(executable).name == "codex":
            local_ttys.add(tty)
        if (
            re.search(r"\bqjc-agent\s+(?:codex|attach\s+qjc-codex\S*)\b", arguments)
            or re.search(r"\bqjc-worker\s+agent\s+codex\b", arguments)
        ):
            remote_ttys.add(tty)
    return local_ttys, remote_ttys


def surface_tty_map(tree_output: str) -> dict[str, str]:
    mapping: dict[str, str] = {}
    pattern = re.compile(r"\bsurface (surface:\d+)\b.*\btty=(\S+)")
    for line in tree_output.splitlines():
        match = pattern.search(line)
        if match:
            mapping[match.group(2)] = match.group(1)
    return mapping


def discover_candidates(
    cached_candidates: list[dict[str, str]] | None = None,
) -> tuple[list[dict[str, str]], bool]:
    complete = True
    try:
        tree_payload = json.loads(
            run_cmux("--json", "--id-format", "both", "tree", "--all")
        )
        if not isinstance(tree_payload, dict):
            raise ValueError("cmux tree payload must be an object")
        surface_ids = terminal_surface_ids(tree_payload)
        surface_refs = terminal_surface_refs(tree_payload)
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        complete = False
        surface_ids = cached_surface_ids(cached_candidates or [])
        surface_refs = {
            candidate["ref"]: candidate["surface_ref"]
            for candidate in cached_candidates or []
            if isinstance(candidate, dict)
            and isinstance(candidate.get("ref"), str)
            and isinstance(candidate.get("surface_ref"), str)
            and re.fullmatch(r"surface:\d+", candidate["surface_ref"])
        }
        if not surface_ids:
            try:
                surface_payload = json.loads(run_cmux("rpc", "surface.list", "{}"))
                if not isinstance(surface_payload, dict):
                    return [], False
                return (
                    [
                        candidate
                        for item in surface_payload.get("surfaces", [])
                        if isinstance(item, dict)
                        and item.get("type") == "terminal"
                        and isinstance(item.get("id"), str)
                        and UUID_RE.fullmatch(item["id"])
                        if (
                            candidate := resume_candidate(item["id"], item)
                        )
                        is not None
                    ],
                    False,
                )
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
                return [], False

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(4, len(surface_ids) or 1)
    ) as pool:
        looked_up = list(pool.map(lookup_resume_candidate, surface_ids))
    if any(error for _candidate, error in looked_up):
        complete = False
    candidates = []
    for candidate, _error in looked_up:
        if candidate is None:
            continue
        surface_ref = surface_refs.get(candidate["ref"])
        if surface_ref:
            candidate["surface_ref"] = surface_ref
        candidates.append(candidate)
    return candidates, complete


def inspect_surface(
    candidate: dict[str, str],
) -> tuple[str, Match | None, str | None, str]:
    surface = candidate["ref"]
    if UUID_RE.fullmatch(surface) and "surface_ref" not in candidate:
        return surface, None, "surface-ref-missing", candidate.get("remote", "unknown")
    surface_ref = candidate.get("surface_ref", surface)
    remote = candidate.get("remote", "unknown")
    try:
        screen = run_cmux(
            "read-screen", "--surface", surface_ref, "--lines", "80", timeout=8
        )
        return (
            surface,
            detect_waiting_502(screen, candidate["checkpoint"], surface),
            None,
            remote,
        )
    except subprocess.TimeoutExpired:
        return surface, None, "screen-timeout", remote
    except RuntimeError as exc:
        error = "screen-internal-error" if "internal_error" in str(exc) else "screen-error"
        return surface, None, error, remote
    except OSError:
        return surface, None, "screen-os-error", remote


def valid_proxy_status(body: bytes) -> bool:
    if len(body) > 131_072:
        return False
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, ValueError):
        return False
    return isinstance(payload, dict) and isinstance(payload.get("accounts"), list)


def proxy_healthy(port: int, remote: str) -> bool:
    url = f"http://127.0.0.1:{port}/teamclaude/status"
    if remote == "unknown":
        return False
    if remote == "true":
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,255}", REMOTE_HOST):
            return False
        try:
            completed = subprocess.run(
                [
                    "/usr/bin/ssh",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=4",
                    REMOTE_HOST,
                    "/usr/bin/curl",
                    "-fsS",
                    "--max-time",
                    "2",
                    url,
                ],
                check=False,
                capture_output=True,
                timeout=8,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return completed.returncode == 0 and valid_proxy_status(completed.stdout)
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            if response.status != 200:
                return False
            body = response.read(131_073)
            return valid_proxy_status(body)
    except (OSError, ValueError, urllib.error.URLError):
        return False


def load_state() -> dict[str, Any]:
    try:
        data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {"version": 1, "fingerprints": [], "last_recovery": {}}


def recovery_gate(
    state: dict[str, Any], surface: str, timestamp: float
) -> tuple[bool, str]:
    raw_history = state.get("recovery_history", {})
    values = raw_history.get(surface, []) if isinstance(raw_history, dict) else []
    recent: list[float] = []
    for value in values if isinstance(values, list) else []:
        try:
            item = float(value)
        except (TypeError, ValueError):
            continue
        if timestamp - item < RECOVERY_WINDOW_SECONDS:
            recent.append(item)
    recent.sort()
    if len(recent) >= MAX_RECOVERY_ATTEMPTS:
        return False, "circuit-open"
    if not recent:
        return True, "ready"
    delay = RECOVERY_BACKOFF_SECONDS[
        min(len(recent) - 1, len(RECOVERY_BACKOFF_SECONDS) - 1)
    ]
    if timestamp - recent[-1] < delay:
        return False, "backoff"
    return True, "ready"


def record_recovery_attempt(
    state: dict[str, Any], surface: str, timestamp: float
) -> None:
    history = state.setdefault("recovery_history", {})
    if not isinstance(history, dict):
        history = {}
        state["recovery_history"] = history
    values = history.get(surface, [])
    if not isinstance(values, list):
        values = []
    recent: list[float] = []
    for value in values:
        try:
            item = float(value)
        except (TypeError, ValueError):
            continue
        if timestamp - item < RECOVERY_WINDOW_SECONDS:
            recent.append(item)
    recent.append(timestamp)
    history[surface] = recent[-MAX_RECOVERY_ATTEMPTS:]


def inspection_allowed(
    state: dict[str, Any], surface: str, timestamp: float
) -> bool:
    raw = state.get("inspect_backoff", {})
    item = raw.get(surface) if isinstance(raw, dict) else None
    if not isinstance(item, dict):
        return True
    try:
        next_at = float(item.get("next_at", 0))
    except (TypeError, ValueError):
        return True
    return timestamp >= next_at


def record_inspection_result(
    state: dict[str, Any], surface: str, timestamp: float, error: str | None
) -> None:
    backoff = state.setdefault("inspect_backoff", {})
    if not isinstance(backoff, dict):
        backoff = {}
        state["inspect_backoff"] = backoff
    if error is None:
        backoff.pop(surface, None)
        return
    previous = backoff.get(surface)
    failures = 0
    if isinstance(previous, dict):
        try:
            failures = int(previous.get("failures", 0))
        except (TypeError, ValueError):
            failures = 0
    index = min(failures, len(INSPECTION_BACKOFF_SECONDS) - 1)
    backoff[surface] = {
        "failures": failures + 1,
        "last_at": timestamp,
        "next_at": timestamp + INSPECTION_BACKOFF_SECONDS[index],
        "error": error,
    }


def health_snapshot(
    loadavg: tuple[float, float, float] | None = None,
    cpu_count: int | None = None,
    disk_free_bytes: int | None = None,
    database_sizes: dict[str, int] | None = None,
) -> dict[str, Any]:
    if loadavg is None:
        try:
            loadavg = os.getloadavg()
        except (AttributeError, OSError):
            loadavg = (0.0, 0.0, 0.0)
    if cpu_count is None:
        cpu_count = max(1, os.cpu_count() or 1)
    if disk_free_bytes is None:
        try:
            stats = os.statvfs(Path.home())
            disk_free_bytes = stats.f_bavail * stats.f_frsize
        except OSError:
            disk_free_bytes = 0
    if database_sizes is None:
        database_sizes = {}
        for name in ("logs_2.sqlite", "thread_history_1.sqlite", "state_5.sqlite"):
            path = Path.home() / ".codex" / name
            try:
                database_sizes[name] = path.stat().st_size
            except OSError:
                database_sizes[name] = 0
    swap_usage: dict[str, int] = {}
    try:
        completed = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "vm.swapusage"],
            check=False,
            capture_output=True,
            text=True,
            timeout=2,
        )
        match = SWAP_USAGE_RE.search(completed.stdout)
        if match:
            swap_usage = {
                key: int(float(value) * 1024**2)
                for key, value in match.groupdict().items()
            }
    except (OSError, subprocess.TimeoutExpired):
        swap_usage = {}
    ratio = float(loadavg[0]) / max(1, cpu_count)
    recommendations: list[str] = []
    if ratio >= HEALTH_CRITICAL_LOAD_RATIO:
        recommendations.append("reduce_concurrency")
    if disk_free_bytes < HEALTH_CRITICAL_DISK_FREE:
        recommendations.append("free_disk_space")
    if database_sizes.get("logs_2.sqlite", 0) >= HEALTH_CRITICAL_LOG_DB:
        recommendations.append("rotate_or_archive_logs")
    if swap_usage.get("total", 0) and swap_usage.get("used", 0) / swap_usage["total"] >= 0.8:
        recommendations.append("reduce_memory_pressure")
    status = "critical" if recommendations else ("degraded" if ratio >= 1.5 else "ok")
    return {
        "checked_at": now_iso(),
        "status": status,
        "cpu_count": cpu_count,
        "loadavg": [round(float(value), 2) for value in loadavg],
        "load_ratio_1m": round(ratio, 3),
        "disk_free_bytes": int(disk_free_bytes),
        "database_sizes": {
            key: int(value) for key, value in database_sizes.items()
        },
        "swap_usage": swap_usage,
        "recommendations": recommendations,
    }


def build_resume_command(checkpoint: str) -> str:
    if not CHECKPOINT_RE.fullmatch(checkpoint):
        raise ValueError("invalid checkpoint")
    return f"codex resume {checkpoint}"


def save_state(state: dict[str, Any]) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=STATE_PATH.name + ".", dir=STATE_PATH.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temp_name, STATE_PATH)
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def is_duplicate(state: dict[str, Any], surface: str, match: Match, timestamp: float) -> bool:
    if f"{surface}:{match.fingerprint}" in set(state.get("fingerprints", [])):
        return True
    last = state.get("last_recovery", {}).get(surface, {})
    return timestamp - float(last.get("at", 0)) < COOLDOWN_SECONDS


def remember_attempt(
    state: dict[str, Any], surface: str, match: Match, timestamp: float, result: str
) -> None:
    fingerprints = list(state.get("fingerprints", []))
    key = f"{surface}:{match.fingerprint}"
    if key not in fingerprints:
        fingerprints.append(key)
    state["fingerprints"] = fingerprints[-MAX_FINGERPRINTS:]
    state.setdefault("last_recovery", {})[surface] = {
        "at": timestamp,
        "at_iso": now_iso(),
        "result": result,
    }


def submit_recovery(surface: str) -> tuple[bool, str]:
    try:
        # cmux send의 Enter는 이스케이프 시퀀스 리터럴 "\n"(백슬래시+n)이다.
        # 실제 개행 문자는 composer에 줄바꿈으로만 들어가 제출되지 않는다
        # (2026-08-14 라이브 실증: 실개행 → 미제출, 리터럴 \n → 즉시 제출).
        run_cmux("send", "--surface", surface, RECOVERY_MESSAGE + "\\n")
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return False, f"send-{type(exc).__name__}"
    return True, "submitted"


def attempt_recovery(
    state: dict[str, Any],
    surface: str,
    match: Match,
    timestamp: float,
    target_surface: str | None = None,
    pre_submit: Callable[[], bool] | None = None,
) -> tuple[bool, str]:
    previous_fingerprints = list(state.get("fingerprints", []))
    previous_last_recovery = dict(state.get("last_recovery", {}))
    previous_recovery_history = dict(state.get("recovery_history", {}))
    remember_attempt(state, surface, match, timestamp, "pending")
    record_recovery_attempt(state, surface, timestamp)
    save_state(state)
    if pre_submit is not None and not pre_submit():
        state["fingerprints"] = previous_fingerprints
        state["last_recovery"] = previous_last_recovery
        if previous_recovery_history:
            state["recovery_history"] = previous_recovery_history
        else:
            state.pop("recovery_history", None)
        save_state(state)
        return False, "stale"
    ok, result = submit_recovery(target_surface or surface)
    remember_attempt(state, surface, match, timestamp, result)
    save_state(state)
    return ok, result


def scan(dry_run: bool) -> dict[str, Any]:
    state = load_state()
    cached_candidates = state.get("candidate_cache", [])
    if not isinstance(cached_candidates, list):
        cached_candidates = []
    candidates, discovery_complete = discover_candidates(cached_candidates)
    checkpoints = {
        candidate["ref"]: candidate["checkpoint"] for candidate in candidates
    }
    remotes = {candidate["ref"]: candidate["remote"] for candidate in candidates}
    bindings = {
        candidate["ref"]: {
            key: candidate.get(key)
            for key in ("ref", "checkpoint", "remote", "command_ref")
        }
        for candidate in candidates
    }
    surface_refs = {
        candidate["ref"]: candidate.get("surface_ref", candidate["ref"])
        for candidate in candidates
    }
    timestamp = time.time()
    inspect_candidates = [
        candidate
        for candidate in candidates
        if inspection_allowed(state, candidate["ref"], timestamp)
    ]
    inspect_deferred = len(candidates) - len(inspect_candidates)
    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(3, len(inspect_candidates) or 1)
    ) as pool:
        inspected = list(pool.map(inspect_surface, inspect_candidates))

    health = health_snapshot()
    summary: dict[str, Any] = {
        "checked_at": now_iso(),
        "dry_run": dry_run,
        "discovery_complete": discovery_complete,
        "candidates": len(candidates),
        "matches": 0,
        "submitted": 0,
        "duplicates": 0,
        "unhealthy": 0,
        "topology_unknown": 0,
        "stale": 0,
        "inspect_errors": 0,
        "inspect_deferred": inspect_deferred,
        "backoff": 0,
        "circuit_open": 0,
        "resource_status": health["status"],
    }
    for surface, match, error, remote in inspected:
        record_inspection_result(state, surface, timestamp, error)
        if error:
            summary["inspect_errors"] += 1
            log_event("inspect-error", surface, error)
            continue
        if match is None:
            continue
        summary["matches"] += 1
        if remote == "unknown":
            summary["topology_unknown"] += 1
            log_event("topology-unknown", surface)
            continue
        if is_duplicate(state, surface, match, timestamp):
            summary["duplicates"] += 1
            continue
        recovery_allowed, recovery_reason = recovery_gate(
            state, surface, timestamp
        )
        if not recovery_allowed:
            if recovery_reason == "circuit-open":
                summary["circuit_open"] += 1
            else:
                summary["backoff"] += 1
            continue
        if match.port is not None and not proxy_healthy(match.port, remote):
            summary["unhealthy"] += 1
            log_event("proxy-unhealthy", surface)
            continue
        if dry_run:
            continue

        expected_surface_ref = surface_refs.get(surface, surface)
        if expected_surface_ref != surface:
            current_surface_ref, ref_error = lookup_surface_ref(surface)
            if ref_error or current_surface_ref != expected_surface_ref:
                summary["stale"] += 1
                continue

        refreshed_surface, refreshed_match, refreshed_error, refreshed_remote = inspect_surface(
            {
                "ref": surface,
                "surface_ref": expected_surface_ref,
                "checkpoint": checkpoints.get(surface, ""),
                "remote": remotes.get(surface, "unknown"),
            }
        )
        if (
            refreshed_error
            or refreshed_surface != surface
            or refreshed_match is None
            or refreshed_match.fingerprint != match.fingerprint
            or refreshed_remote != remote
        ):
            summary["stale"] += 1
            continue

        current_candidate, binding_error = lookup_resume_candidate(surface)
        if binding_error or current_candidate != bindings.get(surface):
            summary["stale"] += 1
            continue

        final_surface, final_match, final_error, final_remote = inspect_surface(
            {**current_candidate, "surface_ref": expected_surface_ref}
        )
        if (
            final_error
            or final_surface != surface
            or final_match is None
            or final_match.fingerprint != match.fingerprint
            or final_remote != remote
        ):
            summary["stale"] += 1
            continue


        def pre_submit_current() -> bool:
            if expected_surface_ref != surface:
                current_surface_ref, ref_error = lookup_surface_ref(surface)
                if ref_error or current_surface_ref != expected_surface_ref:
                    return False
            final_candidate, binding_error = lookup_resume_candidate(surface)
            if binding_error or final_candidate != bindings.get(surface):
                return False
            final_surface, final_match, final_error, final_remote = inspect_surface(
                {**final_candidate, "surface_ref": expected_surface_ref}
            )
            screen_is_current = (
                not final_error
                and final_surface == surface
                and final_match is not None
                and final_match.fingerprint == match.fingerprint
                and final_remote == remote
            )
            if not screen_is_current:
                return False
            if expected_surface_ref != surface:
                current_surface_ref, ref_error = lookup_surface_ref(surface)
                if ref_error or current_surface_ref != expected_surface_ref:
                    return False
            return True

        ok, result = attempt_recovery(
            state,
            surface,
            match,
            timestamp,
            expected_surface_ref,
            pre_submit_current,
        )
        if result == "stale":
            summary["stale"] += 1
            continue
        if ok:
            summary["submitted"] += 1
            log_event("submitted", surface)
        else:
            log_event("submit-error", surface, result)

    state["last_scan"] = summary
    if not dry_run:
        if discovery_complete:
            state["candidate_cache"] = candidates
        save_state(state)
    return summary


def show_status() -> int:
    print(json.dumps(load_state(), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="대상을 찾되 입력하지 않는다")
    parser.add_argument("--status", action="store_true", help="최근 상태만 출력한다")
    parser.add_argument("--health", action="store_true", help="비파괴 자원 진단을 출력한다")
    parser.add_argument(
        "--resume-command", metavar="CHECKPOINT", help="검증된 checkpoint의 재개 명령을 출력한다"
    )
    parser.add_argument("--quiet", action="store_true", help="정상 스캔 결과를 출력하지 않는다")
    args = parser.parse_args()
    if args.status:
        return show_status()
    if args.health:
        print(json.dumps(health_snapshot(), ensure_ascii=False, sort_keys=True))
        return 0
    if args.resume_command:
        try:
            print(build_resume_command(args.resume_command))
        except ValueError:
            return 2
        return 0

    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with LOCK_PATH.open("a+", encoding="utf-8") as lock:
            try:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0
            try:
                summary = scan(args.dry_run)
                if not args.quiet:
                    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
                return 0
            except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
                log_event("scan-deferred", detail=type(exc).__name__)
                return 0
    except OSError as exc:
        log_event("scan-deferred", detail=type(exc).__name__)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
