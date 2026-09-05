#!/usr/bin/env python3
"""Path B manual staging/rollout for the TeamCodex runtime (runbook:
docs/runbooks/teamcodex-runtime-deployment.md). Reuses the deployer's own
materialize/validate/plist/verify functions.

  stage   <commit>   git-archive the commit, materialize + validate the artifact, print its hash
  rollout <hash>     back up plist, wait for idle, drain, repoint plist, bootout/bootstrap
                     (waiting for launchd teardown), verify, approve hash, update deploy state
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
from pathlib import Path

DEPLOYER = os.environ.get(
    "TEAMCODEX_DEPLOYER",
    os.path.expanduser("~/.local/bin/teamcodex_runtime_deployer.py"))
SPEC = importlib.util.spec_from_file_location("dep", DEPLOYER)
dep = importlib.util.module_from_spec(SPEC)
sys.modules["dep"] = dep
SPEC.loader.exec_module(dep)

WT = Path(os.environ.get("TEAMCODEX_SOURCE_ROOT", str(Path(__file__).resolve().parent.parent)))
DOMAIN = f"gui/{os.getuid()}"


def sh(*args, timeout=20):
    return subprocess.run(list(args), check=False, capture_output=True, text=True, timeout=timeout)


def stage(commit: str) -> str:
    tmp = Path(tempfile.mkdtemp(prefix="teamcodex-stage-"))
    try:
        archive = subprocess.run(["git", "-C", str(WT), "archive", commit], check=True, capture_output=True)
        subprocess.run(["tar", "-x", "-C", str(tmp)], input=archive.stdout, check=True)
        h = dep.runtime_source_hash(tmp)
        existing = dep.artifact_entry(h)
        if existing is None:
            entry = dep.materialize_approved_artifact(tmp, dep.ARTIFACTS_DIR, h)
        else:
            entry = existing
        dep.validate_artifact_entry(entry, h)
        print(json.dumps({"hash": h, "entry": str(entry), "reused": existing is not None}))
        return h
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def runtime_state():
    state = dep.load_json(dep.STATE_FILE, {})
    pid, port = state.get("pid"), state.get("port")
    lifecycle = state.get("lifecycle") or {}
    lifecycle_id = lifecycle.get("id") if isinstance(lifecycle, dict) else None
    if not isinstance(pid, int) or not isinstance(port, int):
        raise SystemExit("runtime state file has no pid/port")
    return pid, port, (lifecycle_id if isinstance(lifecycle_id, str) and len(lifecycle_id) >= 16 else None)


def wait_idle(pid, port, max_seconds=2400):
    deadline = time.monotonic() + max_seconds
    last = None
    while time.monotonic() < deadline:
        try:
            active, live_hash = dep.status_snapshot(port, pid)
        except (OSError, ValueError, urllib.error.URLError) as exc:
            print(f"status unavailable: {exc}", flush=True)
            time.sleep(2)
            continue
        if active != last:
            print(f"active requests: {active} (live {str(live_hash)[:8]})", flush=True)
            last = active
        if active == 0:
            return live_hash
        time.sleep(2)
    raise SystemExit("proxy never went idle")


def proxy_api_key() -> str:
    cfg = json.loads(Path(os.path.expanduser("~/.config/teamcodex.json")).read_text())
    key = (cfg.get("proxy") or {}).get("apiKey")
    if not isinstance(key, str) or not key:
        raise SystemExit("teamcodex.json has no proxy.apiKey")
    return key


def set_drain(port: int, lifecycle_id: str, enabled: bool) -> int:
    import urllib.request
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{dep.DEPLOYMENT_DRAIN_PATH}",
        data=b"",
        method="POST" if enabled else "DELETE",
        headers={dep.LIFECYCLE_ID_HEADER: lifecycle_id, "x-api-key": proxy_api_key(), "content-length": "0"},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.loads(response.read(4097))
        if response.status != 200 or payload.get("draining") is not enabled \
                or not isinstance(payload.get("activeRequests"), int):
            raise ValueError(f"invalid drain response: {payload}")
        return payload["activeRequests"]


def launchd_job_present() -> bool:
    return sh("/bin/launchctl", "print", f"{DOMAIN}/{dep.LAUNCHD_LABEL}").returncode == 0


def bootout_and_bootstrap(entry: Path) -> bool:
    dep.write_launchd_plist(entry)
    lint = sh("/usr/bin/plutil", "-lint", str(dep.LAUNCHD_PLIST))
    if lint.returncode != 0:
        raise SystemExit(f"plist lint failed: {lint.stdout}{lint.stderr}")
    out = sh("/bin/launchctl", "bootout", f"{DOMAIN}/{dep.LAUNCHD_LABEL}")
    print(f"bootout rc={out.returncode} {out.stderr.strip()}", flush=True)
    # Wait for launchd to finish tearing the job down (the stock deployer
    # bootstraps immediately and races this — 2026-09-05 rollout note).
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and launchd_job_present():
        time.sleep(0.5)
    for attempt in range(1, 31):
        res = sh("/bin/launchctl", "bootstrap", DOMAIN, str(dep.LAUNCHD_PLIST))
        print(f"bootstrap attempt {attempt} rc={res.returncode} {res.stderr.strip()}", flush=True)
        if res.returncode == 0:
            return True
        time.sleep(1)
    return False


def rollout(target_hash: str):
    target_entry = dep.artifact_entry(target_hash)
    if target_entry is None:
        raise SystemExit("target artifact missing; run stage first")
    dep.validate_artifact_entry(target_entry, target_hash)
    old_pid, port, lifecycle_id = runtime_state()
    if dep.launchd_pid() != old_pid:
        raise SystemExit("state file pid is not the launchd-managed pid")
    live_entry = dep.active_runtime_entry(old_pid)
    if live_entry is None or not dep.expected_supervisor(old_pid, live_entry):
        raise SystemExit("live runtime entry could not be verified")
    live_hash = wait_idle(old_pid, port)
    if live_hash is None:
        raise SystemExit("live runtime reports no source hash")
    rollback_entry = dep.artifact_entry(live_hash)
    dep.validate_artifact_entry(rollback_entry, live_hash)
    backup = dep.LAUNCHD_PLIST.with_name(
        f"{dep.LAUNCHD_PLIST.name}.pre-{target_hash[:8]}-{time.strftime('%Y%m%dT%H%M')}")
    shutil.copy2(dep.LAUNCHD_PLIST, backup)
    print(f"plist backup: {backup}", flush=True)

    if lifecycle_id:
        for attempt in range(1, 61):
            active = set_drain(port, lifecycle_id, True)
            print(f"drain engaged (attempt {attempt}), active={active}", flush=True)
            if active == 0:
                break
            set_drain(port, lifecycle_id, False)
            wait_idle(old_pid, port)
        else:
            raise SystemExit("could not drain to zero active requests")
    ok = bootout_and_bootstrap(target_entry)
    if ok and dep.wait_for_new_runtime(old_pid, target_hash, port, target_entry):
        dep.save_hash(dep.APPROVED_HASH_FILE, target_hash)
        state = dep.load_json(dep.DEPLOY_STATE, {})
        state.update({
            "active_hash": target_hash,
            "rollback_hash": live_hash,
            "candidate_hash": state.get("candidate_hash"),
            "idle_streak": 0,
        })
        dep.save_json(dep.DEPLOY_STATE, state)
        dep.log(f"deployed-manual {target_hash}")
        print(json.dumps({"deployed": target_hash, "rollback": live_hash, "approved": True}), flush=True)
        return
    print("target rollout failed — rolling back", flush=True)
    dep.validate_artifact_entry(rollback_entry, live_hash)
    if not bootout_and_bootstrap(rollback_entry) or not dep.wait_for_new_runtime(old_pid, live_hash, port, rollback_entry):
        raise SystemExit("ROLLBACK NOT HEALTHY — inspect launchctl/logs immediately")
    dep.log(f"deploy-manual-failed {target_hash} rolled-back {live_hash}")
    raise SystemExit("rolled back to the previous artifact")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("stage", "rollout"):
        raise SystemExit(__doc__)
    if sys.argv[1] == "stage":
        stage(sys.argv[2])
    else:
        rollout(sys.argv[2])
