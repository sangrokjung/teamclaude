#!/usr/bin/env python3
"""대시보드 스냅샷용 픽스처를 실행 시각 기준으로 만든다.

시각을 파일에 고정해 두면 몇 시간 뒤 같은 픽스처가 "측정이 낡음" 상태로 뒤집혀,
디자인 변경 전후를 비교할 때 서로 다른 화면을 보게 된다(2026-09-24 실측: 두 시간
간격으로 렌더한 두 장에서 세션 열이 값에서 "-"로 바뀌어 회귀로 오인했다).
"""
import json
import pathlib
import sys
import time

HOUR_MS = 3_600_000
DAY_MS = 86_400_000


def account(name, status="active", usable=True, enabled=True, error=None,
            session=0.5, weekly=0.9, fable=0.1):
    now_ms = int(time.time() * 1000)
    return {
        "name": name, "type": "oauth", "provider": "anthropic",
        "status": status, "errorReason": error, "planType": None,
        "subscription": {"state": "active", "endsAt": None},
        "usable": usable, "enabled": enabled, "priority": None,
        "quota": {
            "unified5h": session, "unified7d": weekly,
            "unified5hReset": now_ms + 4 * HOUR_MS,
            "unified7dReset": now_ms + 6 * DAY_MS,
            "modelWeekly": {"7d_oi": {"utilization": fable, "reset": now_ms + 6 * DAY_MS}},
        },
        "usage": {"totalInputTokens": 1, "totalOutputTokens": 1, "totalRequests": 1, "lastUsed": None},
        "inflight": 0, "maxConcurrent": 3, "rateLimitedUntil": None, "unsupportedModels": [],
    }


def build():
    accounts = [
        account(f"acct-{i:02d}", session=0.2 + 0.04 * i, weekly=0.3 + 0.04 * i, fable=(0.1 * i) % 1)
        for i in range(1, 13)
    ]
    # 문제 상태 4종. 정상 행과 섞여도 눈에 띄는지가 이 픽스처의 목적이다.
    accounts.append(account("acct-13", status="error", usable=False, error="auth-rejected",
                            session=0.99, weekly=0.99))
    accounts.append(account("acct-14", status="error", usable=False, error="subscription-disabled"))
    accounts.append(account("acct-15", usable=False, enabled=False))
    accounts.append(account("acct-16", session=0.99, weekly=0.995, usable=False))
    accounts.append(account("acct-17", session=0.98, weekly=0.99, usable=False))
    fixture = {
        "teamclaude": {"accounts": accounts, "usableCount": 12, "totalCount": len(accounts)},
        "grok": "Grok 21%",
    }
    fixture["higgsfieldCredits"] = 1494
    fixture["higgsfieldPlan"] = "ultra"
    # 구독·소진 섹션. 단가는 기본이 비어 있다 — 금액을 지어내지 않는 화면을 먼저 본다.
    fixture["burn"] = {
        "usages": [
            # 실측(2026-09-27): 오류 6개가 전부 구독 종료였다. 지불은 11, 해지는 따로 센다.
            # 해지 4개가 enabled=false이기도 하다. 계정당 한 칸이라 꺼 둠은 0이다.
            {"lane": "claude", "paid": 11, "contributing": 11, "error": 0, "disabled": 0,
             "unsubscribed": 6, "weekly": 0.41, "session": 0.055, "blocked": 0},
            # Codex 2개는 subscription.state=end-date-reached. 서빙은 가능해도 결제는 끝났다.
            {"lane": "codex", "paid": 5, "contributing": 5, "error": 0, "disabled": 0,
             "unsubscribed": 2, "weekly": 0.365, "session": 0.0, "blocked": 0},
            {"lane": "agy", "paid": 1, "contributing": 1, "error": 0, "disabled": 0,
             "weekly": 0.03, "session": 0.0, "blocked": 0},
            {"lane": "grok", "paid": 1, "contributing": 1, "error": 0, "disabled": 0,
             "weekly": None, "session": None, "blocked": 0},
        ],
        "rates": {},
    }
    if "--blocked" in sys.argv:
        # 가용 0이 관측된 주기. 전망과 무관하게 부족이어야 한다.
        fixture["burn"]["usages"][0]["blocked"] = 2
    if "--rates" in sys.argv:
        fixture["burn"]["currency"] = "USD"
        fixture["burn"]["rates"] = {
            "claude": {"plan": "Max 20x", "monthly": 280000},
            "codex": {"plan": "Pro", "monthly": 290000},
            "grok": {"plan": "SuperGrok", "monthly": 45000},
        }
    if "--stale" in sys.argv:
        # 실패 화면은 실패했을 때만 나타나서 평소 스냅샷에 걸리지 않는다. 그래서 따로 그린다.
        fixture["staleNotes"] = {"grok": "12분째 갱신 없음", "agy": "31분째 갱신 없음",
                                 "higgsfield": "48분째 갱신 없음"}
    return fixture


if __name__ == "__main__":
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "menubar/Tests/fixtures-dash.json")
    out.write_text(json.dumps(build(), ensure_ascii=False, indent=2) + "\n")
    print(f"fixture: {out}")
