"""scripts/model-usage-collector.py 회귀 테스트(표준 라이브러리 unittest).

실행: python3 -m unittest test/test_model_usage_collector.py
가짜 HOME에 Claude·Codex·영수증·구현 루프·Hermes·주기 이력 기록을 만들어 수집기를 두 번 이상 돌린다.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from zoneinfo import ZoneInfo

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts/model-usage-collector.py"
SPEC = importlib.util.spec_from_file_location("model_usage_collector", MODULE_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector
SPEC.loader.exec_module(collector)

TZ = ZoneInfo("Asia/Seoul")
NOW = dt.datetime(2026, 11, 2, 12, 0, tzinfo=TZ)
EMAIL = "someone@example.test"
UUID = "0f0f0f0f-1111-2222-3333-444444444444"
SECRET = "sk-ant-oat01-SECRETVALUE"


def claude_line(msg_id, req, ts, model="claude-opus-5", out=10, inp=5, cr=100, cw=7, prompt="hello"):
    return json.dumps({
        "type": "assistant", "timestamp": ts, "requestId": req, "sessionId": "s1",
        "message": {"id": msg_id, "model": model, "content": [{"type": "text", "text": prompt}],
                    "usage": {"input_tokens": inp, "output_tokens": out,
                              "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw}},
    }) + "\n"


def codex_token(ts, inp, cached, out, resets_at=1794000000, pct=10.0):
    return json.dumps({"timestamp": ts, "type": "event_msg", "payload": {
        "type": "token_count",
        "info": {"total_token_usage": {"input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out}},
        "rate_limits": {"secondary": {"window_minutes": 10080, "used_percent": pct, "resets_at": resets_at}},
    }}) + "\n"


class Fixture:
    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.state = Path(self.tmp.name) / "state" / "model-usage.sqlite"
        self.out = Path(self.tmp.name) / "state" / "model-usage.json"
        proj = self.home / ".claude" / "projects" / "p"
        proj.mkdir(parents=True)
        (self.home / ".claude" / "settings.json").write_text(json.dumps({"cleanupPeriodDays": 14}))
        self.claude_a = proj / "a.jsonl"
        self.claude_b = proj / "b.jsonl"
        self.claude_a.write_text(
            claude_line("msg_1", "req_1", "2026-11-01T01:00:00Z")
            + claude_line("msg_2", "req_2", "2026-11-01T02:00:00Z", model="claude-sonnet-5")
            + json.dumps({"type": "user", "message": {"content": SECRET}}) + "\n")
        # 이어 하기(resume)가 같은 응답을 다른 파일에 복사한 경우
        self.claude_b.write_text(claude_line("msg_1", "req_1", "2026-11-01T01:00:00Z"))
        sess = self.home / ".codex" / "sessions" / "2026" / "11" / "01"
        sess.mkdir(parents=True)
        self.codex = sess / "rollout-2026-11-01T10-00-00-abc.jsonl"
        self.codex.write_text(
            json.dumps({"timestamp": "2026-11-01T01:00:00Z", "type": "session_meta",
                        "payload": {"id": "sess-1", "model_provider": "teamcodex", "cwd": "/private/work"}}) + "\n"
            + json.dumps({"timestamp": "2026-11-01T01:00:01Z", "type": "turn_context", "payload": {"model": "gpt-6.1-sol"}}) + "\n"
            + codex_token("2026-11-01T01:00:02Z", 100, 40, 20)
            + codex_token("2026-11-01T01:00:03Z", 250, 90, 50, pct=12.0))
        review = self.home / ".claude" / "cache" / "codex-review"
        review.mkdir(parents=True)
        run_id = "20261101T030000Z-abcd1234"
        for name in ("20261101T030000Z-abcd1234", "latest", "copy-2"):
            (review / f"{name}.json").write_text(json.dumps({
                "run_id": run_id, "started_at": "2026-11-01T03:00:00Z", "lane": "codex-astra",
                "model": "gpt-6-astra", "verdict": "APPROVE", "review_duration_sec": 120}))
        (review / "20261101T030000Z-abcd1234.codex-astra.log").write_text("...\ntokens used\n1,234\n")
        (review / "other.json").write_text(json.dumps({
            "run_id": "20261031T030000Z-ffff0000", "started_at": "2026-10-31T03:00:00Z", "lane": "codex-sol", "verdict": "REQUEST_CHANGES"}))
        impl = self.home / ".claude" / "cache" / "codex-impl-loop" / "20261101-120000-x"
        impl.mkdir(parents=True)
        (impl / "ledger.json").write_text(json.dumps({"rounds": [{"engine": "codex"}, {"engine": "codex"}], "summary": {"status": "approved"}}))
        hist = self.home / ".codex" / "cache"
        hist.mkdir(parents=True)
        (hist / "cc-menubar-quota-history-v1.json").write_text(json.dumps({"version": 1, "cycles": [
            {"lane": "claude", "window": "5h", "endedAt": "2026-11-01T05:00:00Z", "exhaustedAccounts": 2},
            {"lane": "claude", "window": "5h", "endedAt": "2026-11-01T10:00:00Z", "exhaustedAccounts": 0},
            {"lane": "codex", "window": "5h", "endedAt": "2026-11-01T10:00:00Z", "exhaustedAccounts": 1},
        ]}))
        hermes = self.home / ".hermes"
        hermes.mkdir()
        db = sqlite3.connect(hermes / "state.db")
        db.execute("create table sessions (id text primary key, started_at real)")
        db.execute("""create table session_model_usage (session_id text, model text, billing_base_url text,
            api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer,
            cache_write_tokens integer, reasoning_tokens integer, last_seen real)""")
        db.execute("insert into sessions values ('h1', ?)", (dt.datetime(2026, 11, 1, 3, tzinfo=dt.timezone.utc).timestamp(),))
        db.execute("insert into session_model_usage values ('h1','gpt-6.1-sol','http://127.0.0.1:3457/v1',4,1000,200,0,0,0,?)",
                   (dt.datetime(2026, 11, 1, 4, tzinfo=dt.timezone.utc).timestamp(),))
        db.commit()
        db.close()

    def status(self, port):
        if port == 3457:
            return None
        return {"switchThreshold": 0.995, "accounts": [
            {"name": EMAIL, "accountUuid": UUID, "enabled": True, "usable": True, "status": "active",
             "quota": {"unified7d": 0.42, "unified7dReset": 1794078000000}},
            {"name": "x@example.test", "enabled": False, "usable": False, "status": "active",
             "quota": {"unified7d": 0.99, "unified7dReset": 1794078000000}},
        ]}

    def run(self, now=NOW):
        return collector.collect(home=self.home, state_path=self.state, out_path=self.out, now=now, tz=TZ,
                                 fetch_status=self.status)

    def cleanup(self):
        self.tmp.cleanup()


def rows(report, source):
    return [r for r in report["daily"] if r["source"] == source]


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.fx = Fixture()

    def tearDown(self):
        self.fx.cleanup()

    def test_claude_dedupes_same_message_across_files(self):
        report = self.fx.run()
        claude = rows(report, "claude-code")
        self.assertEqual(2, sum(r["calls"] for r in claude))
        opus = [r for r in claude if r["model"] == "claude-opus-5"][0]
        self.assertEqual({"date": "2026-11-01", "lane": "claude", "input": 5, "output": 10, "cacheRead": 100, "cacheWrite": 7, "calls": 1},
                         {k: opus[k] for k in ("date", "lane", "input", "output", "cacheRead", "cacheWrite", "calls")})

    def test_second_run_reads_no_log_bytes_and_keeps_totals(self):
        first = self.fx.run()
        second = self.fx.run()
        self.assertGreater(first["scan"]["bytesRead"], 0)
        self.assertEqual(0, second["scan"]["bytesRead"])
        self.assertEqual(first["daily"], second["daily"])
        self.assertEqual(first["receipts"], second["receipts"])

    def test_appended_lines_only_are_read_and_partial_line_waits(self):
        self.fx.run()
        extra = claude_line("msg_3", "req_3", "2026-11-02T01:00:00Z")
        with self.fx.claude_a.open("a") as f:
            f.write(extra[:20])  # 아직 쓰는 중인 줄
        partial = self.fx.run()
        self.assertEqual(2, sum(r["calls"] for r in rows(partial, "claude-code")))
        with self.fx.claude_a.open("a") as f:
            f.write(extra[20:])
        done = self.fx.run()
        self.assertEqual(len(extra.encode()), done["scan"]["bytesRead"])
        self.assertEqual(3, sum(r["calls"] for r in rows(done, "claude-code")))

    def test_rewritten_file_is_reread_without_double_count(self):
        self.fx.run()
        self.fx.claude_b.write_text("")  # 줄어든 파일(교체·정리)
        self.fx.claude_b.write_text(claude_line("msg_1", "req_1", "2026-11-01T01:00:00Z"))
        report = self.fx.run()
        self.assertEqual(2, sum(r["calls"] for r in rows(report, "claude-code")))

    def test_deleted_logs_keep_collected_days(self):
        first = self.fx.run()
        self.fx.claude_a.unlink()
        self.fx.claude_b.unlink()
        later = self.fx.run()
        self.assertEqual(rows(first, "claude-code"), rows(later, "claude-code"))

    def test_codex_counts_cumulative_token_deltas(self):
        report = self.fx.run()
        codex = rows(report, "codex-cli")
        self.assertEqual(1, len(codex))
        r = codex[0]
        # 첫 보고 100/40/20 + 증분 150/50/30 → 비캐시 입력 60+100, 캐시 90, 출력 50
        self.assertEqual(("codex", "gpt-6.1-sol", 2, 160, 90, 50), (r["lane"], r["model"], r["calls"], r["input"], r["cacheRead"], r["output"]))
        self.assertEqual("2026-11-01", report["coverage"]["codexCliLastDay"])

    def test_receipts_dedupe_by_run_id_and_read_tokens(self):
        report = self.fx.run()
        audit = report["receipts"]["audit"]
        self.assertEqual((4, 2, 2), (audit["jsonFiles"], audit["uniqueRuns"], audit["dupRunId"]))
        by_day = {r["date"]: r for r in report["receipts"]["daily"]}
        self.assertEqual((1, 1234, 120), (by_day["2026-11-01"]["runs"], by_day["2026-11-01"]["tokens"], by_day["2026-11-01"]["reviewSec"]))
        self.assertEqual(1, by_day["2026-10-31"]["runs"])
        self.assertEqual("2026-10-31", report["coverage"]["receiptFirstDay"])

    def test_impl_loop_hermes_and_cycles(self):
        report = self.fx.run()
        self.assertEqual([{"date": "2026-11-01", "runs": 1, "rounds": 2}], report["implLoop"]["daily"])
        hermes = rows(report, "hermes")
        self.assertEqual([("codex", "gpt-6.1-sol", 4, 1000, 200)], [(r["lane"], r["model"], r["calls"], r["input"], r["output"]) for r in hermes])
        self.assertEqual([{"date": "2026-11-01", "window": "5h", "cycles": 2, "exhausted": 1}], report["quotaCycles"]["daily"])

    def test_coverage_marks_claude_gap_before_first_run(self):
        report = self.fx.run()
        # 첫 실행 11/2, 보존 14일 → 10/19까지는 지워졌을 수 있고 10/20부터 온전
        self.assertEqual("2026-10-20", report["coverage"]["claudeCompleteFrom"])
        self.assertEqual(14, report["coverage"]["claudeRetentionDays"])
        later = self.fx.run(now=NOW + dt.timedelta(days=30))
        self.assertEqual("2026-10-20", later["coverage"]["claudeCompleteFrom"], "첫 실행일 기준은 바뀌지 않는다")

    def test_pools_use_sequence_labels_only(self):
        report = self.fx.run()
        claude = report["pools"]["claude"]
        self.assertTrue(claude["available"])
        self.assertEqual(["C01", "C02"], [a["label"] for a in claude["accounts"]])
        self.assertEqual((0.42, True, True), (claude["accounts"][0]["util7d"], claude["accounts"][0]["usable"], claude["accounts"][0]["enabled"]))
        self.assertFalse(report["pools"]["codex"]["available"])

    def test_output_has_no_identity_or_content(self):
        self.fx.run()
        text = self.fx.out.read_text()
        for needle in (EMAIL, "x@example.test", UUID, SECRET, "hello", "/private/work", "sess-1", str(self.fx.home)):
            self.assertNotIn(needle, text)
        self.assertEqual(0o600, os.stat(self.fx.out).st_mode & 0o777)
        self.assertEqual(1, json.loads(text)["schema"])
        self.assertEqual("2026-11-02T03:00:00Z", json.loads(text)["generatedAt"])

    def test_pro200_estimate_uses_window_consumption(self):
        daily = [{"date": "2026-10-20", "source": "codex-cli", "input": 60_000_000, "cacheRead": 40_000_000, "output": 10_000_000}]
        ms = int(dt.datetime(2026, 10, 21, tzinfo=TZ).timestamp() * 1000)
        windows = [{"reset": 1793000000, "firstPct": 0.0, "maxPct": 50.0, "tokens": 110_000_000, "lastTs": ms}]
        est = collector.pro200_estimate(daily, windows, TZ)
        # 비캐시 7천만 × (창 1.1억 / 세션 1.1억) ÷ 0.5 Pro-주 = 1.4억
        self.assertEqual((140_000_000, 140_000_000, 140_000_000), (est["mid"], est["lo"], est["hi"]))
        self.assertIsNone(collector.pro200_estimate([], [], TZ))


if __name__ == "__main__":
    unittest.main()
