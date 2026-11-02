"""scripts/model-usage-collector.py 회귀 테스트(표준 라이브러리 unittest).

실행: python3 menubar/Tests/test_model_usage_collector.py (menubar/run-tests.sh가 함께 돌린다)
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

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts/model-usage-collector.py"
SPEC = importlib.util.spec_from_file_location("model_usage_collector", MODULE_PATH)
assert SPEC and SPEC.loader
collector = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = collector
SPEC.loader.exec_module(collector)

TZ = ZoneInfo("Asia/Seoul")
NOW = dt.datetime(2026, 11, 2, 12, 0, tzinfo=TZ)
EMAIL = "someone@example.test"
UUID = "0f0f0f0f-1111-2222-3333-444444444444"
SECRET = "USER-PROMPT-TEXT-MARKER"  # 사용자 메시지 내용이 결과에 새지 않는지 보는 표지


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
        self.assertEqual(("2026-11-01", None), (report["quotaCycles"]["since"], report["quotaCycles"]["completeFrom"]),
                         "a history below the 256 cap is complete from its first cycle")
        self.assertEqual([], report["undated"])

    # ---- 2라운드(적대 검증 지적) 회귀 ----

    def test_lines_written_after_the_run_started_are_not_lost(self):
        """수집 시작 시각보다 늦은 줄(동시 append)을 버리면서 오프셋·prev만 앞으로 옮기면 영구 누락된다."""
        self.fx.run()
        late = "2026-11-02T03:00:05Z"  # NOW(03:00Z) 5초 뒤에 쓰인 응답
        with self.fx.claude_a.open("a") as f:
            f.write(claude_line("msg_late", "req_late", late))
        with self.fx.codex.open("a") as f:
            f.write(codex_token(late, 400, 100, 80))
        report = self.fx.run()
        self.assertEqual(3, sum(r["calls"] for r in rows(report, "claude-code")))
        codex = {r["date"]: r for r in rows(report, "codex-cli")}
        self.assertEqual((1, 140, 10, 30), (codex["2026-11-02"]["calls"], codex["2026-11-02"]["input"],
                                             codex["2026-11-02"]["cacheRead"], codex["2026-11-02"]["output"]))
        with self.fx.codex.open("a") as f:
            f.write(codex_token("2026-11-02T03:00:06Z", 500, 100, 100))
        again = {r["date"]: r for r in rows(self.fx.run(), "codex-cli")}
        self.assertEqual((2, 240, 50), (again["2026-11-02"]["calls"], again["2026-11-02"]["input"], again["2026-11-02"]["output"]),
                         "prev must match what was counted, so the next delta is exact")

    def hermes_db(self):
        return sqlite3.connect(self.fx.home / ".hermes" / "state.db")

    def test_hermes_counts_increments_on_the_day_they_were_seen(self):
        self.fx.run()
        utc = dt.timezone.utc
        db = self.hermes_db()
        # 같은 세션이 다음 날(11/2 KST) 다섯 번 더 호출. 직전 관측(11/1)과 이번 관측 사이에 자정이 껴서
        # 다섯 번이 어느 날 몫인지 알 수 없다 → 날짜 불명
        db.execute("update session_model_usage set api_call_count = 9, input_tokens = 1500, output_tokens = 300, last_seen = ? where session_id = 'h1'",
                   (dt.datetime(2026, 11, 2, 1, tzinfo=utc).timestamp(),))
        # 처음 보는데 이미 여러 날에 걸친 세션 → 날짜 불명
        db.execute("insert into sessions values ('h2', ?)", (dt.datetime(2026, 10, 29, 3, tzinfo=utc).timestamp(),))
        db.execute("insert into session_model_usage values ('h2','gpt-6.1-sol','http://127.0.0.1:3457/v1',7,700,70,0,0,0,?)",
                   (dt.datetime(2026, 11, 1, 3, tzinfo=utc).timestamp(),))
        # 처음 보지만 하루 안에 끝난 세션 → 그날로
        db.execute("insert into sessions values ('h3', ?)", (dt.datetime(2026, 11, 2, 0, tzinfo=utc).timestamp(),))
        db.execute("insert into session_model_usage values ('h3','claude-opus-5','http://127.0.0.1:3456/v1',2,20,2,0,0,0,?)",
                   (dt.datetime(2026, 11, 2, 1, tzinfo=utc).timestamp(),))
        db.commit()
        db.close()
        report = self.fx.run()
        got = sorted((r["date"], r["lane"], r["calls"], r["input"], r["output"]) for r in rows(report, "hermes"))
        self.assertEqual([("2026-11-01", "codex", 4, 1000, 200), ("2026-11-02", "claude", 2, 20, 2)], got)
        self.assertEqual([("codex", "gpt-6.1-sol", "hermes", 12, 1200, 170)],
                         [(r["lane"], r["model"], r["source"], r["calls"], r["input"], r["output"]) for r in report["undated"]],
                         "h2 first seen spanning days (7) + h1 increment across midnight (5)")
        self.assertEqual(report["daily"], self.fx.run()["daily"], "a rerun without changes adds nothing")
        # 같은 날 안의 다음 증분은 그날로 확정한다
        db = self.hermes_db()
        db.execute("update session_model_usage set api_call_count = 10, input_tokens = 1600, output_tokens = 310, last_seen = ? where session_id = 'h1'",
                   (dt.datetime(2026, 11, 2, 2, tzinfo=utc).timestamp(),))
        db.commit()
        db.close()
        same_day = {(r["date"], r["lane"]): r for r in rows(self.fx.run(), "hermes")}
        self.assertEqual((1, 100, 10), (same_day[("2026-11-02", "codex")]["calls"], same_day[("2026-11-02", "codex")]["input"],
                                        same_day[("2026-11-02", "codex")]["output"]))

    def test_hermes_increment_across_midnight_is_undated(self):
        """23:30 수집 → 23:45·00:15 호출 → 00:30 재수집. 차분 2를 다음 날에 몰아 넣지 않는다."""
        utc = dt.timezone.utc
        db = self.hermes_db()
        db.execute("update session_model_usage set last_seen = ? where session_id = 'h1'",
                   (dt.datetime(2026, 11, 1, 14, 20, tzinfo=utc).timestamp(),))  # 11/1 23:20 KST
        db.commit()
        db.close()
        self.fx.run(now=dt.datetime(2026, 11, 1, 23, 30, tzinfo=TZ))
        db = self.hermes_db()
        db.execute("update session_model_usage set api_call_count = 6, input_tokens = 1200, output_tokens = 240, last_seen = ? where session_id = 'h1'",
                   (dt.datetime(2026, 11, 1, 15, 15, tzinfo=utc).timestamp(),))  # 11/2 00:15 KST
        db.commit()
        db.close()
        report = self.fx.run(now=dt.datetime(2026, 11, 2, 0, 30, tzinfo=TZ))
        self.assertEqual([("2026-11-01", 4)], [(r["date"], r["calls"]) for r in rows(report, "hermes")])
        self.assertEqual([("codex", 2, 200, 40)], [(r["lane"], r["calls"], r["input"], r["output"]) for r in report["undated"]])

    def write_cycles(self, start, count):
        cycles = [{"lane": "claude", "window": "5h", "endedAt": (start + dt.timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                   "exhaustedAccounts": i % 2, "meanUtilization": 0.5, "maxUtilization": 0.5} for i in range(count)]
        path = self.fx.home / ".codex" / "cache" / "cc-menubar-quota-history-v1.json"
        path.write_text(json.dumps({"version": 1, "cycles": cycles}))

    def test_cycle_history_trimmed_at_256_is_kept_and_marked_partial(self):
        start = dt.datetime(2026, 10, 22, 0, tzinfo=dt.timezone.utc)
        self.write_cycles(start, 256)  # 생산자 상한(레인·창마다 256)까지 찬 파일 → 첫날 앞은 이미 잘렸을 수 있다
        first = self.fx.run()["quotaCycles"]
        self.assertEqual(256, sum(r["cycles"] for r in first["daily"]))
        self.assertEqual(("2026-10-22", "2026-10-23"), (first["since"], first["completeFrom"]))
        self.write_cycles(start + dt.timedelta(hours=20), 256)  # 생산자가 오래된 20개를 잘라내고 새 20개를 붙였다
        second = self.fx.run()["quotaCycles"]
        self.assertEqual(276, sum(r["cycles"] for r in second["daily"]), "earlier cycles survive the producer trim")
        self.assertEqual("2026-10-23", second["completeFrom"], "no gap: the file still overlaps what was kept")
        self.write_cycles(start + dt.timedelta(days=30), 256)  # 수집이 멈춘 사이 통째로 밀렸다 → 그 사이는 공백
        third = self.fx.run()["quotaCycles"]
        self.assertEqual("2026-11-22", third["completeFrom"])

    def test_old_state_format_is_rebuilt_from_the_remaining_logs(self):
        self.fx.state.parent.mkdir(parents=True, exist_ok=True)
        old = sqlite3.connect(self.fx.state)  # 1라운드 형식: stateVersion 없음, receipts에 base 열 없음
        old.executescript("""create table meta (key text primary key, value text);
            insert into meta values ('firstRun', '2026-10-01');
            create table receipts (run_id text primary key, canonical integer, date text, tokens integer, review_sec real);""")
        old.commit()
        old.close()
        report = self.fx.run()
        self.assertEqual(2, report["receipts"]["audit"]["uniqueRuns"])
        self.assertEqual("2026-10-20", report["coverage"]["claudeCompleteFrom"], "first run restarts with the rebuild")

    def test_receipt_tokens_update_when_the_log_completes_later(self):
        review = self.fx.home / ".claude" / "cache" / "codex-review"
        (review / "20261101T050000Z-bbbb2222.json").write_text(json.dumps({
            "run_id": "20261101T050000Z-bbbb2222", "started_at": "2026-11-01T05:00:00Z", "lane": "codex-sol", "verdict": "APPROVE"}))
        log = review / "20261101T050000Z-bbbb2222.codex-sol.log"
        log.write_text("running\n")
        first = {r["date"]: r for r in self.fx.run()["receipts"]["daily"]}
        self.assertEqual((2, 1234), (first["2026-11-01"]["runs"], first["2026-11-01"]["tokens"]))
        log.write_text("running\ntokens used\n500\n")
        os.utime(log, (log.stat().st_atime, log.stat().st_mtime + 5))
        later = {r["date"]: r for r in self.fx.run()["receipts"]["daily"]}
        self.assertEqual((2, 1734), (later["2026-11-01"]["runs"], later["2026-11-01"]["tokens"]), "tokens refresh, runs do not double")

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

    def write_codex_session(self, name, events):
        """events: (시각, 누적 비캐시 입력, 누적 출력, resets_at, 주간 사용률). 캐시 입력은 0."""
        path = self.fx.home / ".codex" / "sessions" / "2026" / "10" / "20" / f"rollout-{name}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = json.dumps({"timestamp": events[0][0], "type": "session_meta", "payload": {"id": name}}) + "\n"
        lines += json.dumps({"timestamp": events[0][0], "type": "turn_context", "payload": {"model": "gpt-6.1-sol"}}) + "\n"
        for ts, inp, out, reset, pct in events:
            lines += codex_token(ts, inp, 0, out, resets_at=reset, pct=pct)
        path.write_text(lines)

    def test_pro200_samples_only_token_and_usage_deltas_of_one_account_window(self):
        m = 1_000_000
        # 리뷰 지적 예: 6천만씩 두 응답, 사용률 10% → 20%. 첫 응답 토큰은 첫 관측 전 몫이라 뺀다 → 6천만 ÷ 0.10 = 6억.
        self.write_codex_session("a", [("2026-10-20T01:00:00Z", 50 * m, 10 * m, 1793100000, 10.0),
                                       ("2026-10-20T02:00:00Z", 100 * m, 20 * m, 1793100000, 20.0)])
        # 같은 주 다른 계정(다른 리셋 시각) 하나 더: 3천만 ÷ 0.05 = 6억 → 그 주(W43) 합산 9천만 ÷ 0.15 = 6억
        self.write_codex_session("b", [("2026-10-20T03:00:00Z", 10 * m, 0, 1793100500, 30.0),
                                       ("2026-10-20T04:00:00Z", 40 * m, 0, 1793100500, 35.0)])
        # 다음 주 계정: 3천만 ÷ 0.10 = 3억
        self.write_codex_session("c", [("2026-10-27T01:00:00Z", 10 * m, 0, 1793700000, 40.0),
                                       ("2026-10-27T02:00:00Z", 40 * m, 0, 1793700000, 50.0)])
        # 같은 리셋 초를 가진 두 계정이 섞인 창(사용률이 왔다 갔다) → 어느 계정 몫인지 알 수 없어 뺀다
        self.write_codex_session("d", [("2026-10-28T01:00:00Z", 10 * m, 0, 1793800000, 10.0),
                                       ("2026-10-28T02:00:00Z", 900 * m, 0, 1793800000, 60.0),
                                       ("2026-10-28T03:00:00Z", 901 * m, 0, 1793800000, 11.0),
                                       ("2026-10-28T04:00:00Z", 902 * m, 0, 1793800000, 61.0)])
        # 표본이 되기엔 사용률 변화가 작은 창(1%p) → 뺀다
        self.write_codex_session("e", [("2026-10-28T05:00:00Z", 10 * m, 0, 1793900000, 5.0),
                                       ("2026-10-28T06:00:00Z", 900 * m, 0, 1793900000, 6.0)])
        pro = self.fx.run()["pro200"]
        self.assertEqual((450 * m, 300 * m, 600 * m), (pro["mid"], pro["lo"], pro["hi"]), pro)
        self.assertEqual((3, 3, 2), (pro["samples"], pro["excluded"], pro["weeks"]), pro)  # 제외: d(섞임)·e(1%p)·기본 픽스처(2%p)

    def test_pro200_is_unavailable_without_enough_samples(self):
        m = 1_000_000
        self.write_codex_session("a", [("2026-10-20T01:00:00Z", 50 * m, 10 * m, 1793100000, 10.0),
                                       ("2026-10-20T02:00:00Z", 100 * m, 20 * m, 1793100000, 20.0)])
        self.assertIsNone(self.fx.run()["pro200"], "one window is not a baseline")

    # ---- 3라운드 ----

    def test_impl_loop_days_survive_ledger_cleanup(self):
        impl = self.fx.home / ".claude" / "cache" / "codex-impl-loop"
        late = impl / "20261102-090000-y"
        late.mkdir()
        (late / "ledger.json").write_text(json.dumps({"rounds": [{"engine": "codex"}]}))
        self.assertEqual(2, len(self.fx.run()["implLoop"]["daily"]))
        (late / "ledger.json").write_text(json.dumps({"rounds": [{"engine": "codex"}, {"engine": "codex"}, {"engine": "codex"}]}))
        grown = {r["date"]: r for r in self.fx.run()["implLoop"]["daily"]}
        self.assertEqual((1, 3), (grown["2026-11-02"]["runs"], grown["2026-11-02"]["rounds"]), "the same run grows, not doubles")
        for folder in impl.iterdir():
            (folder / "ledger.json").unlink()
            folder.rmdir()
        kept = self.fx.run()["implLoop"]["daily"]
        self.assertEqual([{"date": "2026-11-01", "runs": 1, "rounds": 2}, {"date": "2026-11-02", "runs": 1, "rounds": 3}], kept)

    def test_same_inode_rewrite_with_different_content_is_reread(self):
        self.fx.run()
        with self.fx.claude_b.open("r+") as f:  # 같은 inode에서 내용을 바꿔 다시 쓴다
            f.seek(0)
            f.truncate()
            f.write(claude_line("msg_9", "req_9", "2026-11-02T01:00:00Z", model="claude-sonnet-5")
                    + claude_line("msg_1", "req_1", "2026-11-01T01:00:00Z"))
        report = self.fx.run()
        self.assertEqual(3, sum(r["calls"] for r in rows(report, "claude-code")), "msg_9 counted once, msg_1 not twice")


if __name__ == "__main__":
    unittest.main()
