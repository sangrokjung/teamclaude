# menubar/Tests/snapshot_test_teamclaude_table.py
"""빌드된 cc-menubar로 TeamClaude 표를 오프스크린 렌더한다.
프록시 status 모양의 픽스처 5종이 NSException 없이 PNG를 내면 통과.
build.sh가 mv 직전의 후보 바이너리(CC_MENUBAR_BINARY)로 실행한다(러너의 test_*.py 글롭 밖).

픽스처의 reset 시각은 실행 시각 기준(+4h / +6d)이다. parseTeamClaudeHealth는 reset이 지난
창을 미측정(nil)으로 보므로, 고정 epoch를 쓰면 며칠 뒤 모든 픽스처가 미측정 모양으로 무너져
퍼센트 바·임계 색·리셋 카운트다운·Fbl 바 경로를 잃는다.
usable은 파서가 직접 계산한다(teamClaudeAccountIsUsable: enabled + active + 세션·주간 측정됨 +
둘 다 임계 미만). 행의 usable은 usableFromProxy로만 읽히고 최상위 usableCount/totalCount는
읽지 않는다 — 실제 status 모양을 맞추려고만 둔다."""
import json
import os
import pathlib
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEFAULT_BINARY = ROOT / "menubar" / ".build" / "cc-menubar"
# build.sh는 mv 전 후보 바이너리를 여기로 넘긴다. 스모크가 실패하면 set -e + trap이 후보를 버린다.
BINARY = pathlib.Path(os.environ.get("CC_MENUBAR_BINARY", str(DEFAULT_BINARY)))

HOUR_MS = 3_600_000
DAY_MS = 86_400_000


def account(status="active", usable=True, enabled=True, error=None,
            unified5h=0.5, unified7d=0.9, fable=0.1, name=None):
    now_ms = int(time.time() * 1000)
    session_reset = now_ms + 4 * HOUR_MS
    weekly_reset = now_ms + 6 * DAY_MS
    quota = {
        "unified5h": unified5h, "unified7d": unified7d,
        "unified5hReset": session_reset, "unified7dReset": weekly_reset,
        "modelWeekly": {"7d_oi": {"utilization": fable, "reset": weekly_reset}} if fable is not None else {},
    }
    row = {
        "type": "oauth", "provider": "anthropic", "status": status, "errorReason": error,
        "planType": None, "subscription": {"state": "active", "endsAt": None},
        "usable": usable, "enabled": enabled, "priority": None, "quota": quota,
        "usage": {"totalInputTokens": 1, "totalOutputTokens": 1, "totalRequests": 1, "lastUsed": None},
        "inflight": 0, "maxConcurrent": 3, "rateLimitedUntil": None, "unsupportedModels": [],
    }
    if name:
        row["name"] = name
    return row


FIXTURES = {
    "empty": [],
    "all-error": [account(status="error", usable=False, enabled=False, error="subscription-disabled",
                          unified5h=None, unified7d=None, fable=None) for _ in range(5)],
    "no-quota": [account(usable=False, unified5h=None, unified7d=None, fable=None)],
    # 주간 100% + Fable 100%로 측정된 행: 임계 도달 색·가득 찬 바 경로.
    "weekly-fable-full": [account(usable=False, unified5h=0, unified7d=1, fable=1)],
    "named-mixed": [
        account(name="a0"),                                      # 50/90, 임계(100%) 미만 → usable
        account(name="a1", usable=False, unified7d=1, fable=1),  # 주간 100% → not usable
        account(name="a2", status="error", usable=False, error="refresh-failed",
                unified5h=None, unified7d=None, fable=None),     # error → not usable
    ],
}

# CLI stdout에 찍히는 파서 산출과 대조한다(값은 위 docstring대로 파서가 계산한다).
EXPECTED_STDOUT = {"named-mixed": "accounts=3 usable=1"}


class TeamClaudeTableSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if BINARY.exists():
            return
        if "CC_MENUBAR_BINARY" in os.environ:
            raise FileNotFoundError(f"CC_MENUBAR_BINARY={BINARY} does not exist")
        subprocess.run(["bash", str(ROOT / "menubar" / "build.sh")], cwd=ROOT, check=True, timeout=900,
                       env={**os.environ, "CC_MENUBAR_SKIP_TESTS": "1", "CC_MENUBAR_SKIP_SNAPSHOT": "1"})

    def test_every_fixture_renders_without_an_uncaught_exception(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name, accounts in FIXTURES.items():
                with self.subTest(fixture=name):
                    fixture = pathlib.Path(tmp) / f"{name}.json"
                    fixture.write_text(json.dumps({
                        "accounts": accounts,
                        "usableCount": sum(1 for a in accounts if a["usable"]),
                        "totalCount": len(accounts),
                        "switchThreshold": 1,
                    }))
                    out = pathlib.Path(tmp) / f"{name}.png"
                    result = subprocess.run(
                        [str(BINARY), "--teamclaude-table-snapshot", str(fixture), str(out)],
                        cwd=ROOT, capture_output=True, text=True, timeout=60,
                    )
                    self.assertEqual(0, result.returncode, f"{name}: {result.stderr[-2000:]}")
                    self.assertNotIn("CRASH", result.stderr, name)
                    self.assertTrue(out.exists() and out.stat().st_size > 1000, name)
                    if name in EXPECTED_STDOUT:
                        self.assertIn(EXPECTED_STDOUT[name], result.stdout, f"{name}: {result.stdout!r}")


if __name__ == "__main__":
    unittest.main()
