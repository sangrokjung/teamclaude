#!/usr/bin/env python3
"""모델 사용량 증분 수집기. 메뉴바 "모델" 탭이 읽는 JSON 한 장을 만든다(Python 표준 라이브러리만).

읽는 곳(읽기만 한다):
  - Claude Code 세션 로그  ~/.claude*/projects/**/*.jsonl  (assistant 응답의 model·usage)
  - Codex CLI 세션 로그    ~/.codex/sessions/**/*.jsonl, ~/.codex/archived_sessions
  - 적대 검증 영수증       ~/.claude/cache/codex-review/*.json (run_id로 한 번만) + 같은 이름 *.codex-{astra,sol}.log의 "tokens used"
  - 구현 루프 원장         ~/.claude/cache/codex-impl-loop/<YYYYMMDD-HHMMSS-…>/ledger.json (토큰 없음, 실행·라운드 수)
  - Hermes                ~/.hermes*/state.db (sqlite 읽기 전용)
  - 메뉴바 주기 이력       ~/.codex/cache/cc-menubar-quota-history-v1.json
  - 프록시 status          http://127.0.0.1:3456|3457/teamclaude/status

증분: 상태 sqlite에 파일별 (inode, 크기, mtime, 오프셋)을 두고 붙은 줄만 읽는다. 끝나지 않은 마지막 줄은 다음 회차로 미룬다.
한번 모은 날짜별 합계는 원본 로그가 지워져도 남는다.
내보내지 않는 것: 이메일, 계정 이름·UUID, 토큰, 프롬프트·응답 내용, 작업 경로. 계정은 C01·X01 순번으로만 쓴다.

사용법: python3 scripts/model-usage-collector.py [--out PATH] [--state PATH] [--since YYYY-MM-DD] [--install]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import plistlib
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

STATE_DIR = Path.home() / '.local/state/cc-menubar'
DEFAULT_OUT = STATE_DIR / 'model-usage.json'
DEFAULT_STATE = STATE_DIR / 'model-usage.sqlite'
LABEL = 'com.qjc.cc-model-usage'
SCHEMA = 1
# 새로 세는 범위(일). 이 범위 안 기록만 세고 그 중복 키만 기억한다. 범위 밖으로 밀려난 키는 지우되, 범위 밖 기록은
# 다시 만나도(폴더 이동·재작성) 세지 않으므로 이미 센 날짜를 두 번 더하지 않는다. 한번 센 날짜별 합계는 범위 밖이 돼도 남는다.
SEEN_KEEP_DAYS = 120
DEFAULT_RETENTION = 30    # Claude Code cleanupPeriodDays 기본값
TOKENS_RE = re.compile(r'tokens used\s*\n\s*([\d,]+)')
STATE_VERSION = '4'
# 메뉴바(main.swift recordQuotaObservation)는 주기 이력을 레인·창마다 최근 256개만 남긴다. 그만큼 찬 파일은 앞이 잘렸을 수 있다.
HISTORY_KEEP_PER_WINDOW = 256
# windows는 2형식의 표다(재구성 때 지운다).
STATE_TABLES = ('meta', 'files', 'seen', 'daily', 'windows', 'codex_obs', 'receipt_files', 'receipt_logs', 'receipts',
                'hermes_seen', 'undated', 'cycles', 'impl_runs')
FINGERPRINT_BYTES = 4096  # 오프셋 바로 앞 몇 바이트로 같은 inode 재작성을 알아챈다
PRO_MIN_PCT_DELTA = 5.0   # 표본 창의 최소 사용률 변화(%p). 사용률이 정수 단위라 작은 변화는 잡음이다
PRO_MIN_SAMPLES = 3       # 이보다 적으면 기준값을 내지 않는다(산출 불가)
# 같은 계정의 resets_at은 응답마다 몇 초씩 흔들린다(실측: 한 계정이 …794~…800, 다른 계정이 …813~…823).
# 이 간격 안의 이웃 값은 한 창으로 잇는다. 더 가까운 두 계정은 섞이지만 아래 되돌림 검사가 그 창을 뺀다.
PRO_RESET_JITTER_SEC = 5
# 동시 요청은 응답 순서와 기록 순서가 어긋나 사용률이 1~3%p 되돌아 보일 수 있다(실측 최대 3). 그보다 크게 되돌아가면
# 다른 계정이 섞인 것으로 본다.
PRO_MIX_DROP_PCT = 5.0
# 한 주의 표본 토큰이 이보다 적으면 그 주는 뺀다. 이 맥 CLI가 거의 안 쓴 주의 사용률은 다른 소비자(Hermes·임시 CODEX_HOME
# 검토 등)가 같은 계정을 쓴 몫이라, 로컬 토큰으로 나누면 기준값이 한두 자리 작게 나온다(실측 W38·W44 약 100만).
PRO_MIN_WEEK_TOKENS = 50_000_000


# ---------- 상태 DB ----------

def open_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)  # 로그 파일 경로가 들어 있어 본인만 읽게 둔다
    db = sqlite3.connect(path)
    db.execute('create table if not exists meta (key text primary key, value text)')
    used_before = meta_get(db, 'firstRun') is not None or meta_get(db, 'stateVersion') is not None
    if used_before and meta_get(db, 'stateVersion') != STATE_VERSION:
        # 출시 전 상태 형식이 바뀌었다. 남은 로그로 다시 모은다(지워진 로그 몫은 기록 공백으로 표시된다).
        for table in STATE_TABLES:
            db.execute(f'drop table if exists {table}')
        db.execute('create table meta (key text primary key, value text)')
    meta_set(db, 'stateVersion', STATE_VERSION)
    db.executescript("""
    create table if not exists meta (key text primary key, value text);
    create table if not exists files (path text primary key, ino integer, size integer, mtime real, offset integer, ctx text, fp text);
    create table if not exists seen (key text primary key, day text);
    create table if not exists daily (date text, lane text, model text, source text,
        input integer, output integer, cache_read integer, cache_write integer, calls integer,
        primary key (date, lane, model, source));
    create table if not exists codex_obs (reset integer, ts integer, pct real, noncache integer);
    create index if not exists codex_obs_reset on codex_obs (reset, ts);
    create table if not exists receipt_files (path text primary key, mtime real);
    create table if not exists receipt_logs (path text primary key, mtime real);
    create table if not exists receipts (run_id text primary key, canonical integer, base text, date text, tokens integer, review_sec real);
    create table if not exists hermes_seen (key text primary key, calls integer, input integer, output integer,
        cache_read integer, cache_write integer, observed_at real);
    create table if not exists undated (lane text, model text, source text, input integer, output integer,
        cache_read integer, cache_write integer, calls integer, primary key (lane, model, source));
    create table if not exists cycles (key text primary key, window text, date text, exhausted integer);
    create table if not exists impl_runs (run text primary key, date text, rounds integer);
    create table if not exists claude_gaps (from_day text primary key, to_day text);
    """)
    return db


def meta_get(db, key):
    row = db.execute('select value from meta where key = ?', (key,)).fetchone()
    return row[0] if row else None


def meta_set(db, key, value):
    db.execute('insert or replace into meta values (?, ?)', (key, value))


def add_daily(db, date, lane, model, source, inp=0, out=0, cr=0, cw=0, calls=1):
    db.execute("""insert into daily values (?,?,?,?,?,?,?,?,?)
        on conflict(date, lane, model, source) do update set input = input + excluded.input,
        output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write, calls = calls + excluded.calls""",
               (date, lane, model, source, inp, out, cr, cw, calls))


def first_seen(db, key, day) -> bool:
    """처음 보는 키면 기록하고 True. 같은 응답을 두 번 세지 않는다."""
    cur = db.execute('insert or ignore into seen values (?, ?)', (key, day))
    return cur.rowcount == 1


# ---------- 시간 ----------

def parse_ts(value):
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def local_day(moment: dt.datetime, tz) -> str:
    return moment.astimezone(tz).date().isoformat()


def iso_week(day: str) -> str:
    year, week, _ = dt.date.fromisoformat(day).isocalendar()
    return f'{year}-W{week:02d}'


# ---------- jsonl 증분 리더 ----------

class Scan:
    def __init__(self):
        self.bytes_read = 0
        self.files = 0
        # 모양이 예상과 다른 외부 기록(건너뛴 수). 출처별로 결과 JSON에 싣는다.
        self.malformed = {'claude': 0, 'codex': 0, 'status': 0}


def jsonl_files(root: Path):
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob('*.jsonl') if p.is_file())


def prefix_fingerprint(path: Path, offset: int):
    """오프셋 바로 앞 FINGERPRINT_BYTES의 지문. 같은 inode에서 다른 내용으로 다시 써졌는지 본다."""
    if offset <= 0:
        return ''
    try:
        with path.open('rb') as f:
            f.seek(max(0, offset - FINGERPRINT_BYTES))
            return hashlib.sha256(f.read(min(offset, FINGERPRINT_BYTES))).hexdigest()
    except OSError:
        return None


def read_new_lines(db, path: Path, scan: Scan, handle_line, ctx_default):
    """붙은 줄만 handle_line(line, ctx)로 넘긴다. 파일이 줄었거나, inode가 바뀌었거나, 이미 읽은 끝부분이 달라졌으면
    (같은 inode 재작성) 처음부터 다시 읽는다. 다시 읽어도 중복 키가 같은 응답을 두 번 세지 않게 막는다."""
    try:
        st = path.stat()
    except OSError:
        return
    scan.files += 1
    row = db.execute('select ino, size, mtime, offset, ctx, fp from files where path = ?', (str(path),)).fetchone()
    offset, ctx = 0, dict(ctx_default)
    if row:
        ino, size, mtime, prev_offset, prev_ctx, fp = row
        if ino == st.st_ino and st.st_size >= prev_offset:
            if st.st_size == size and st.st_mtime == mtime:
                return
            if prefix_fingerprint(path, prev_offset) == fp:
                offset, ctx = prev_offset, json.loads(prev_ctx or '{}')
    if st.st_size > offset:
        try:
            with path.open('rb') as f:
                f.seek(offset)
                for raw in f:
                    if not raw.endswith(b'\n'):
                        break  # 아직 쓰는 중인 줄은 다음 회차에
                    offset += len(raw)
                    scan.bytes_read += len(raw)
                    handle_line(raw.decode('utf-8', 'replace'), ctx)
        except OSError:
            return
    db.execute('insert or replace into files values (?,?,?,?,?,?,?)',
               (str(path), st.st_ino, st.st_size, st.st_mtime, offset, json.dumps(ctx), prefix_fingerprint(path, offset)))

# ---------- Claude Code ----------

def claude_roots(home: Path):
    try:
        names = sorted(n for n in os.listdir(home) if n.startswith('.claude'))
    except OSError:
        return []
    return [home / n / 'projects' for n in names if (home / n / 'projects').is_dir()]


def retention_days(root: Path) -> int:
    try:
        value = json.loads((root.parent / 'settings.json').read_text()).get('cleanupPeriodDays')
    except (OSError, ValueError, AttributeError):
        return DEFAULT_RETENTION
    return int(value) if isinstance(value, (int, float)) and value > 0 else DEFAULT_RETENTION


def collect_claude(db, home, tz, scan, counted_from):
    def handle(line, _ctx):
        if '"assistant"' not in line or '"usage"' not in line:
            return
        try:
            o = json.loads(line)
        except ValueError:
            scan.malformed['claude'] += 1  # 걸러진 줄(assistant·usage 글자가 든 줄)인데 JSON이 깨졌다
            return
        if not isinstance(o, dict):
            scan.malformed['claude'] += 1
            return
        if o.get('type') != 'assistant':
            return
        msg = o.get('message')
        if not isinstance(msg, dict) or not isinstance(msg.get('usage'), dict):
            scan.malformed['claude'] += 1
            return
        model = msg.get('model')
        ts = parse_ts(o.get('timestamp'))
        # 수집 도중 붙은 줄도 센다. 시작 시각(now)으로 거르면 오프셋만 넘어가 그 줄이 영영 빠진다.
        if not model or model == '<synthetic>' or ts is None:
            return
        day = local_day(ts, tz)
        if day < counted_from or not first_seen(db, f"c:{msg.get('id')}:{o.get('requestId') or ''}", day):
            return
        u = msg['usage']
        add_daily(db, day, 'claude', model, 'claude-code', u.get('input_tokens') or 0, u.get('output_tokens') or 0,
                  u.get('cache_read_input_tokens') or 0, u.get('cache_creation_input_tokens') or 0)

    roots = claude_roots(home)
    for root in roots:
        for path in jsonl_files(root):
            read_new_lines(db, path, scan, handle, {})
    return min((retention_days(r) for r in roots), default=DEFAULT_RETENTION)


# ---------- Codex CLI ----------

def weekly_window(rate_limits):
    """7일 창(resets_at 초, 사용률). 없거나 모양이 다르면 None."""
    if not isinstance(rate_limits, dict):
        return None
    weekly = next((w for w in (rate_limits.get('primary'), rate_limits.get('secondary'))
                   if isinstance(w, dict) and w.get('window_minutes') == 10080), None)
    if not weekly or not weekly.get('resets_at') or not isinstance(weekly.get('used_percent'), (int, float)):
        return None
    return int(weekly['resets_at']), float(weekly['used_percent'])


def codex_handle(db, tz, path, scan, counted_from):
    def handle(line, ctx):
        if '"turn_context"' not in line and '"token_count"' not in line and '"session_meta"' not in line:
            return
        try:
            o = json.loads(line)
        except ValueError:
            scan.malformed['codex'] += 1
            return
        p = o.get('payload') if isinstance(o, dict) else None
        if not isinstance(p, dict):
            scan.malformed['codex'] += 1
            return
        if o.get('type') == 'session_meta':
            if p.get('id'):
                ctx['session'] = p['id']
            return
        if o.get('type') == 'turn_context':
            if p.get('model'):
                ctx['model'] = p['model']
            return
        if o.get('type') != 'event_msg' or p.get('type') != 'token_count':
            return
        ts = parse_ts(o.get('timestamp'))
        if ts is None:
            return
        info = p.get('info')
        total = info.get('total_token_usage') if isinstance(info, dict) else None
        if not isinstance(total, dict):
            if info is not None:
                scan.malformed['codex'] += 1
            return
        prev = ctx.get('prev')
        delta = total
        if prev:
            delta = {k: (total.get(k) or 0) - (prev.get(k) or 0) for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}
            if delta['input_tokens'] < 0 or delta['output_tokens'] < 0:  # 압축·새 스레드: 마지막 호출 값
                last = info.get('last_token_usage')
                delta = last if isinstance(last, dict) else total
        ctx['prev'] = {k: total.get(k) or 0 for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}
        # prev와 센 값이 늘 함께 움직인다(늦은 줄을 버리면서 prev만 옮기면 다음 차분도 틀린다).
        if (delta.get('input_tokens') or 0) == 0 and (delta.get('output_tokens') or 0) == 0:
            return
        key = f"x:{ctx.get('session', path.name)}:{o.get('timestamp')}:{total.get('input_tokens')}:{total.get('output_tokens')}"
        day = local_day(ts, tz)
        if day < counted_from or not first_seen(db, key, day):
            return
        cached = max(0, delta.get('cached_input_tokens') or 0)
        inp = max(0, (delta.get('input_tokens') or 0) - cached)
        out = max(0, delta.get('output_tokens') or 0)
        add_daily(db, day, 'codex', ctx.get('model', 'unknown'), 'codex-cli', inp, out, cached, 0)
        # 같은 응답의 사용률(응답 뒤 상태)과 그 응답의 비캐시 토큰을 한 관측으로 남긴다. 계정 구분은 정확한 resets_at 초다.
        window = weekly_window(p.get('rate_limits'))
        if window is not None:
            db.execute('insert into codex_obs values (?,?,?,?)', (window[0], int(ts.timestamp() * 1000), window[1], inp + out))

    return handle


def collect_codex(db, home, tz, scan, counted_from):
    for root in (home / '.codex' / 'sessions', home / '.codex' / 'archived_sessions'):
        for path in jsonl_files(root):
            read_new_lines(db, path, scan, codex_handle(db, tz, path, scan, counted_from), {'model': 'unknown'})


# ---------- 적대 검증 영수증 ----------

def tail_tokens(path: Path):
    try:
        with path.open('rb') as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 16384))
            text = f.read().decode('utf-8', 'replace')
    except OSError:
        return None
    found = TOKENS_RE.findall(text)
    return int(found[-1].replace(',', '')) if found else None


def receipt_time(d):
    ts = parse_ts(d.get('started_at')) or parse_ts(d.get('finished_at'))
    if ts:
        return ts
    m = re.match(r'^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z', str(d.get('run_id', '')))
    return dt.datetime(*map(int, m.groups()), tzinfo=dt.timezone.utc) if m else None


def collect_receipts(db, home, tz, scan):
    folder = home / '.claude' / 'cache' / 'codex-review'
    if not folder.is_dir():
        return
    for path in sorted(folder.glob('*.json')):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        row = db.execute('select mtime from receipt_files where path = ?', (str(path),)).fetchone()
        if row and row[0] == mtime:
            continue
        db.execute('insert or replace into receipt_files values (?, ?)', (str(path), mtime))
        try:
            d = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        scan.bytes_read += path.stat().st_size
        run_id = d.get('run_id') if isinstance(d, dict) else None
        ts = receipt_time(d) if run_id else None
        if not run_id or ts is None:
            continue
        canonical = 1 if str(run_id).split('-')[-1] in path.stem else 0
        base = str(path.with_suffix(''))
        old = db.execute('select canonical, base from receipts where run_id = ?', (run_id,)).fetchone()
        # 더 나은 사본(이름에 run_id 꼬리가 든 것)이 이미 있으면 둔다. 같은 파일이 고쳐졌으면 덮어쓴다(실행 수는 run_id 하나).
        if old and (old[0] > canonical or (old[0] == canonical and old[1] != base)):
            continue
        db.execute('insert or replace into receipts values (?,?,?,?,?,?)',
                   (run_id, canonical, base, local_day(ts, tz), receipt_tokens(base), float(d.get('review_duration_sec') or 0)))
    refresh_receipt_logs(db, folder)


def receipt_tokens(base: str) -> int:
    return sum(t for t in (tail_tokens(Path(f'{base}.{lane}.log')) for lane in ('codex-astra', 'codex-sol')) if t)


def refresh_receipt_logs(db, folder: Path):
    """영수증 JSON보다 로그가 늦게 끝나면 그때 tokens used를 다시 읽는다. 실행 수는 그대로다(run_id 한 줄)."""
    for log in sorted(folder.glob('*.codex-*.log')):
        try:
            mtime = log.stat().st_mtime
        except OSError:
            continue
        row = db.execute('select mtime from receipt_logs where path = ?', (str(log),)).fetchone()
        if row and row[0] == mtime:
            continue
        db.execute('insert or replace into receipt_logs values (?, ?)', (str(log), mtime))
        base = str(log)[:-len(''.join(log.suffixes[-2:]))]
        db.execute('update receipts set tokens = ? where base = ?', (receipt_tokens(base), base))


def receipts_report(db, since):
    files = db.execute('select count(*) from receipt_files where path like ?', ('%.json',)).fetchone()[0]
    unique = db.execute('select count(*) from receipts').fetchone()[0]
    daily = [{'date': d, 'runs': r, 'tokens': t, 'reviewSec': round(s)} for d, r, t, s in db.execute(
        'select date, count(*), sum(tokens), sum(review_sec) from receipts where date >= ? group by date order by date', (since,))]
    return {'audit': {'jsonFiles': files, 'uniqueRuns': unique, 'dupRunId': max(0, files - unique)}, 'daily': daily}


# ---------- 구현 루프·Hermes·주기 이력 ----------

def collect_impl(db, home):
    """구현 루프 실행(폴더)마다 날짜와 라운드 수를 상태 DB에 남긴다. 원장이 지워져도 남긴 집계는 그대로다.
    같은 실행의 라운드가 늘면 그 값으로 바꾼다(실행 수는 폴더 하나)."""
    folder = home / '.claude' / 'cache' / 'codex-impl-loop'
    if not folder.is_dir():
        return
    for entry in sorted(folder.iterdir()):
        m = re.match(r'^(\d{4})(\d{2})(\d{2})-\d{6}', entry.name)
        if not m:
            continue
        try:
            ledger = json.loads((entry / 'ledger.json').read_text())
        except (OSError, ValueError):
            continue
        rounds = ledger.get('rounds') if isinstance(ledger, dict) else None
        count = len(rounds) if isinstance(rounds, list) else 0
        db.execute("""insert into impl_runs values (?,?,?) on conflict(run) do update set
            rounds = max(rounds, excluded.rounds)""", (entry.name, f'{m[1]}-{m[2]}-{m[3]}', count))  # 폴더 이름은 로컬 시각


def impl_report(db, since, today):
    return [{'date': d, 'runs': r, 'rounds': n} for d, r, n in db.execute(
        'select date, count(*), sum(rounds) from impl_runs where date >= ? and date <= ? group by date order by date', (since, today))]

def hermes_lane(url: str) -> str:
    if ':3457' in url or 'chatgpt.com' in url:
        return 'codex'
    return 'claude' if ':3456' in url else 'other'


def hermes_rows(db_path: Path):
    """세션·모델·주소별 누적값. 공급자·모드·작업으로 나뉜 줄은 합친다."""
    con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
    try:
        return con.execute("""select u.session_id, u.model, u.billing_base_url, sum(u.api_call_count), sum(u.input_tokens),
            sum(u.output_tokens), sum(u.cache_read_tokens), sum(u.cache_write_tokens), max(u.last_seen), min(s.started_at)
            from session_model_usage u join sessions s on s.id = u.session_id
            group by u.session_id, u.model, u.billing_base_url having sum(u.api_call_count) > 0""").fetchall()
    finally:
        con.close()


def add_undated(db, lane, model, values):
    db.execute("""insert into undated values (?,?,'hermes',?,?,?,?,?) on conflict(lane, model, source) do update set
        input = input + excluded.input, output = output + excluded.output, cache_read = cache_read + excluded.cache_read,
        cache_write = cache_write + excluded.cache_write, calls = calls + excluded.calls""", (lane, model, *values))


def collect_hermes(db, home, tz, observed_at: float):
    """Hermes state.db는 세션·모델별 누적값만 준다. 직전 누적값과 그것을 본 수집 시각을 기억해 늘어난 몫만 쌓는다.
    늘어난 구간(직전 수집 시각 → 이번 last_seen, 처음 보면 세션 시작 → last_seen)이 하루 안이면 그날로,
    자정을 넘으면 날마다 나눌 수 없어 '날짜 불명'으로 따로 둔다.
    observed_at은 이번 수집의 시작 시각이다. state.db를 읽기 전 시각이라 그 스냅샷보다 늦지 않고, 누적값이 그대로여도
    매번 갱신한다(자정 뒤 무변화 수집이 있었다면 다음 증분은 그날 몫으로 확정된다)."""
    try:
        names = sorted(n for n in os.listdir(home) if re.fullmatch(r'\.hermes(-[a-z0-9]+)?', n))
    except OSError:
        return
    for name in names:
        db_path = home / name / 'state.db'
        if not db_path.is_file():
            continue
        try:
            found = hermes_rows(db_path)
        except sqlite3.Error:
            continue
        for sid, model, url, calls, inp, out, cr, cw, last_seen, started in found:
            seen_at = last_seen if last_seen is not None else started
            if seen_at is None:
                continue
            key = f'{name}|{sid}|{model}|{url}'
            now_vals = [calls or 0, inp or 0, out or 0, cr or 0, cw or 0]
            row = db.execute('select calls, input, output, cache_read, cache_write, observed_at from hermes_seen where key = ?', (key,)).fetchone()
            prev, prev_observed = (row[:5], row[5]) if row else (None, None)
            db.execute('insert or replace into hermes_seen values (?,?,?,?,?,?,?)', (key, *now_vals, observed_at))
            delta = [a - b for a, b in zip(now_vals, prev)] if prev else now_vals
            if any(v < 0 for v in delta):
                delta = now_vals  # 세션이 다시 시작됐다(누적이 줄었다): 지금 값이 새 몫
            if not any(delta):
                continue
            day = local_day(dt.datetime.fromtimestamp(float(seen_at), dt.timezone.utc), tz)
            lane, model = hermes_lane(url or ''), model or 'unknown'
            # 이 증분이 생긴 구간의 시작: 처음 보는 세션이면 세션 시작, 아니면 직전 수집 시각. 그 구간에 자정이 끼면
            # 호출별 시각이 없어 날마다 나눌 수 없으므로 날짜 불명으로 둔다.
            span_start = started if prev is None else prev_observed
            first_day = local_day(dt.datetime.fromtimestamp(float(span_start), dt.timezone.utc), tz) if span_start is not None else None
            if first_day != day:
                add_undated(db, lane, model, [delta[1], delta[2], delta[3], delta[4], delta[0]])
                continue
            add_daily(db, day, lane, model, 'hermes', delta[1], delta[2], delta[3], delta[4], delta[0])


def undated_rows(db):
    return [{'lane': lane, 'model': m, 'source': src, 'input': i, 'output': o, 'cacheRead': cr, 'cacheWrite': cw, 'calls': c}
            for lane, m, src, i, o, cr, cw, c in db.execute('select * from undated order by lane, model')]


def cycle_keys(cycles):
    """주기마다 안정 식별자. 같은 폴링에서 닫힌 두 계정의 주기는 값이 같을 수 있어 같은 값 안의 순번을 붙인다."""
    counts, out = {}, []
    for c in cycles:
        base = '|'.join(str(c.get(k)) for k in ('lane', 'window', 'endedAt', 'exhaustedAccounts', 'meanUtilization',
                                                'maxUtilization', 'blockedMoments', 'contributing'))
        counts[base] = counts.get(base, 0) + 1
        out.append(f'{base}#{counts[base]}')
    return out


def collect_cycles(db, home, tz):
    """메뉴바 주기 이력을 상태 DB에 쌓는다(원본은 창마다 256개만 남긴다). 원본이 상한까지 찼는데 가장 오래된 주기를
    처음 보면 그 앞은 이미 잘려 나간 것이라, 창마다 '온전한 첫날'(completeFrom)을 그 다음 날로 올린다."""
    try:
        history = json.loads((home / '.codex' / 'cache' / 'cc-menubar-quota-history-v1.json').read_text())
    except (OSError, ValueError):
        return
    entries = [c for c in (history.get('cycles', []) if isinstance(history, dict) else [])
               if isinstance(c, dict) and c.get('lane') == 'claude' and parse_ts(c.get('endedAt'))]
    entries.sort(key=lambda c: parse_ts(c['endedAt']))
    by_window = {}
    for c, key in zip(entries, cycle_keys(entries)):
        by_window.setdefault(str(c.get('window')), []).append((c, key))
    for window, items in by_window.items():
        oldest_known = db.execute('select 1 from cycles where key = ?', (items[0][1],)).fetchone() is not None
        if len(items) >= HISTORY_KEEP_PER_WINDOW and not oldest_known:
            cut = dt.date.fromisoformat(local_day(parse_ts(items[0][0]['endedAt']), tz)) + dt.timedelta(days=1)
            meta_key = f'cyclesCompleteFrom:{window}'
            meta_set(db, meta_key, max(meta_get(db, meta_key) or '', cut.isoformat()))
        for c, key in items:
            db.execute('insert or ignore into cycles values (?,?,?,?)',
                       (key, window, local_day(parse_ts(c['endedAt']), tz), 1 if (c.get('exhaustedAccounts') or 0) > 0 else 0))


def cycles_report(db, since):
    daily = [{'date': d, 'window': w, 'cycles': n, 'exhausted': e} for d, w, n, e in db.execute(
        'select date, window, count(*), sum(exhausted) from cycles where date >= ? group by date, window order by date, window', (since,))]
    first = db.execute('select min(date) from cycles').fetchone()[0]
    # 창마다 잘린 날이 다르면 늦은 쪽(보수적인 쪽)을 낸다.
    cuts = [v for (v,) in db.execute("select value from meta where key like 'cyclesCompleteFrom:%'")]
    return {'since': first, 'completeFrom': max(cuts) if cuts else None, 'daily': daily}


# ---------- 풀 ----------

def fetch_proxy_status(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/teamclaude/status', timeout=3) as resp:
            return json.loads(resp.read())
    except (OSError, ValueError):
        return None


def pool_report(status, prefix, scan):
    if not isinstance(status, dict) or not isinstance(status.get('accounts'), list):
        return {'available': False, 'threshold': None, 'accounts': []}
    accounts = []
    for a in status['accounts']:
        if not isinstance(a, dict):
            scan.malformed['status'] += 1
            continue
        q = a.get('quota') if isinstance(a.get('quota'), dict) else {}
        accounts.append({'label': f'{prefix}{len(accounts) + 1:02d}', 'util7d': q.get('unified7d'), 'reset7d': q.get('unified7dReset'),
                         'usable': bool(a.get('usable')), 'enabled': a.get('enabled') is not False})
    return {'available': True, 'threshold': status.get('switchThreshold'), 'accounts': accounts}


# ---------- Pro 200 환산 기준값 ----------

def pro200_estimate(observations, tz):
    """Pro 200 1주(사용률 100%) ≈ 비캐시 토큰 N(추정).

    observations: (resets_at, 시각 ms, 사용률 %, 그 응답의 비캐시 토큰). resets_at이 PRO_RESET_JITTER_SEC 안으로 이어지는
    값들을 한 계정의 한 창으로 본다. 창마다 첫 관측 뒤에 쓴 토큰 ÷ (최고 − 첫 사용률)만 표본으로 쓴다(첫 관측 이전 몫은
    그 사용률에 이미 들었다). 사용률이 PRO_MIX_DROP_PCT보다 크게 되돌아가는 창은 리셋 시각이 가까운 다른 계정이 섞인
    것이라 계정을 가릴 수 없어 뺀다.
    변화가 PRO_MIN_PCT_DELTA보다 작은 창도 뺀다. 표본은 마지막 관측의 ISO 주로 묶어 주마다 합친 토큰 ÷ 합친 사용률을 내고
    (표본 토큰이 PRO_MIN_WEEK_TOKENS보다 적은 주는 뺀다),
    주 값들의 중앙(mid)·최소(lo)·최대(hi)를 낸다. 표본 창이 PRO_MIN_SAMPLES보다 적으면 None(산출 불가).
    한계: 같은 계정을 이 맥 밖(다른 기기·임시 CODEX_HOME)에서 쓴 몫은 사용률에만 들어가 기준값을 낮게 만든다."""
    windows, last_reset = [], None
    for reset, ts, pct, noncache in sorted(observations):
        if last_reset is None or reset - last_reset > PRO_RESET_JITTER_SEC:
            windows.append([])
        windows[-1].append((ts, pct, noncache))
        last_reset = reset
    weeks, excluded, singles = {}, 0, 0
    for obs in windows:
        obs.sort()
        pcts = [o[1] for o in obs]
        consumed = max(pcts) - pcts[0]
        mixed = any(b < a - PRO_MIX_DROP_PCT for a, b in zip(pcts, pcts[1:]))
        if len(obs) < 2:
            singles += 1
            continue
        if mixed or consumed < PRO_MIN_PCT_DELTA:
            excluded += 1
            continue
        week = iso_week(local_day(dt.datetime.fromtimestamp(obs[-1][0] / 1000, dt.timezone.utc), tz))
        b = weeks.setdefault(week, [0, 0.0, 0])
        b[0] += sum(o[2] for o in obs[1:])
        b[1] += consumed / 100
        b[2] += 1
    kept = {week: b for week, b in weeks.items() if b[0] >= PRO_MIN_WEEK_TOKENS}
    excluded += sum(b[2] for week, b in weeks.items() if week not in kept)
    samples = sum(b[2] for b in kept.values())
    if samples < PRO_MIN_SAMPLES:
        return None
    values = [round(tokens / pro) for tokens, pro, _ in kept.values()]
    return {'mid': round(statistics.median(values)), 'lo': min(values), 'hi': max(values),
            'weeks': len(values), 'samples': samples, 'excluded': excluded, 'singleObservation': singles}


# ---------- 조립 ----------

def record_claude_gap(db, last_run_day, today, retention):
    """직전 수집일과 오늘 사이가 Claude 보존 기간(retention일)보다 길면, 그 사이에 생겼다 지워진 기록이 있을 수 있다.
    오늘 남아 있는 로그는 today − (retention − 1)부터라, 공백 가능 구간은 직전 수집일 ~ today − retention이다."""
    if not last_run_day:
        return
    gap_to = (dt.date.fromisoformat(today) - dt.timedelta(days=retention)).isoformat()
    if last_run_day <= gap_to:
        db.execute('insert or replace into claude_gaps values (?, ?)', (last_run_day, gap_to))


def first_kept_day(db):
    """상태 DB에 남은 가장 이른 날짜(일별·영수증·구현 루프·주기 이력 중)."""
    days = [db.execute(sql).fetchone()[0] for sql in ('select min(date) from daily', 'select min(date) from receipts',
                                                      'select min(date) from impl_runs', 'select min(date) from cycles')]
    days = [d for d in days if d]
    return min(days) if days else None


def daily_rows(db, since):
    return [{'date': d, 'lane': lane, 'model': m, 'source': s, 'input': i, 'output': o, 'cacheRead': cr, 'cacheWrite': cw, 'calls': c}
            for d, lane, m, s, i, o, cr, cw, c in db.execute(
                'select * from daily where date >= ? order by date, lane, model, source', (since,))]


def atomic_write(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.model-usage.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def collect(home: Path, state_path: Path, out_path: Path, now=None, tz=None, since=None, fetch_status=fetch_proxy_status):
    tz = tz or dt.datetime.now().astimezone().tzinfo
    now = now or dt.datetime.now(dt.timezone.utc)
    today = local_day(now, tz)
    scan = Scan()
    db = open_state(state_path)
    try:
        first_run = meta_get(db, 'firstRun') or today
        meta_set(db, 'firstRun', first_run)
        counted_from = (dt.date.fromisoformat(today) - dt.timedelta(days=SEEN_KEEP_DAYS)).isoformat()
        retention = collect_claude(db, home, tz, scan, counted_from)
        collect_codex(db, home, tz, scan, counted_from)
        collect_receipts(db, home, tz, scan)
        collect_hermes(db, home, tz, now.timestamp())
        collect_cycles(db, home, tz)
        collect_impl(db, home)
        record_claude_gap(db, meta_get(db, 'lastRunDay'), today, retention)
        meta_set(db, 'lastRunDay', today)
        db.execute('delete from seen where day < ?', (counted_from,))  # 이 날짜보다 앞 기록은 위에서 세지 않는다
        keep_ms = int(dt.datetime.combine(dt.date.fromisoformat(counted_from), dt.time(), tzinfo=dt.timezone.utc).timestamp() * 1000)
        db.execute('delete from codex_obs where ts < ?', (keep_ms,))  # 기준값 표본도 같은 기간만 둔다
        db.commit()
        # 기본은 보존한 범위 전체를 싣는다(화면의 '전체'가 실제 보존 시작일부터). --since를 주면 그날부터만.
        since = since or first_kept_day(db) or today
        stored = daily_rows(db, since)
        pro200 = pro200_estimate(db.execute('select reset, ts, pct, noncache from codex_obs').fetchall(), tz)
        receipts = receipts_report(db, since)
        receipt_first = db.execute('select min(date) from receipts').fetchone()[0]
        cli_last = db.execute("select max(date) from daily where source = 'codex-cli' and calls > 0").fetchone()[0]
        undated = undated_rows(db)
        gaps = [{'from': f, 'to': t} for f, t in db.execute('select from_day, to_day from claude_gaps order by from_day')]
        cycles = cycles_report(db, since)
        impl = impl_report(db, since, today)
    finally:
        db.close()
    complete_from = (dt.date.fromisoformat(first_run) - dt.timedelta(days=retention - 1)).isoformat()
    report = {
        'schema': SCHEMA,
        'generatedAt': now.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'today': today,
        'since': since,
        'coverage': {'claudeCompleteFrom': complete_from, 'claudeRetentionDays': retention,
                     'codexCliLastDay': cli_last, 'receiptFirstDay': receipt_first,
                     # Claude·Codex 세션 로그는 이 날짜부터의 기록만 새로 센다(그 앞은 이미 센 합계만 남는다).
                     'countedFrom': counted_from,
                     # 수집이 Claude 보존 기간보다 오래 멈췄던 구간. 그 사이 생겼다 지워진 기록이 있을 수 있다.
                     'claudeGaps': gaps},
        'daily': stored,
        # 날짜를 알 수 없는 Hermes 몫(처음 볼 때 이미 여러 날에 걸친 세션). 일별 막대에 넣지 않는다.
        'undated': undated,
        'receipts': receipts,
        'implLoop': {'daily': impl},
        'pro200': pro200,
        'quotaCycles': cycles,
        'pools': {'claude': pool_report(fetch_status(3456), 'C', scan), 'codex': pool_report(fetch_status(3457), 'X', scan)},
        'scan': {'bytesRead': scan.bytes_read, 'files': scan.files, 'malformed': scan.malformed},
    }
    atomic_write(out_path, report)
    return report


def install(home: Path = None, python: str = None, runner=subprocess.run):
    """구독 수집기와 같은 방식: qgate 경유 LaunchAgent(1시간). 사람이 실행할 때만 만든다.
    home·python·runner는 테스트가 바꾼다(실제 launchctl을 부르지 않게)."""
    home = home or Path.home()
    plist = home / 'Library/LaunchAgents' / (LABEL + '.plist')
    qgate = home / '.claude/scripts/qgate.py'
    python = python or shutil.which('python3')
    if not python or not qgate.is_file():
        raise RuntimeError('scheduler-unavailable')
    state_dir = home / '.local/state/cc-menubar'
    log, error_log = state_dir / 'model-usage.log', state_dir / 'model-usage.error.log'
    data = {'Label': LABEL, 'ProgramArguments': [python, str(qgate), 'run', '--detach', '--follow', '--slot', 'default',
                                                 '--label', 'model-usage', '--', python, str(Path(__file__).resolve())],
            'RunAtLoad': True, 'StartInterval': 3600, 'ProcessType': 'Background', 'LowPriorityIO': True, 'Nice': 10,
            'WorkingDirectory': str(Path(__file__).resolve().parents[1]), 'EnvironmentVariables': {'PATH': os.environ.get('PATH', '')},
            'StandardOutPath': str(log), 'StandardErrorPath': str(error_log)}
    state_dir.mkdir(parents=True, exist_ok=True)
    for path in (log, error_log):
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
    if plist.exists():
        if plistlib.loads(plist.read_bytes()) != data:
            raise RuntimeError('existing-agent-differs')
    else:
        plist.parent.mkdir(parents=True, exist_ok=True)  # 새 계정에는 ~/Library/LaunchAgents가 아직 없다
        plist.write_bytes(plistlib.dumps(data))
        plist.chmod(0o600)
    if runner(['launchctl', 'print', f'gui/{os.getuid()}/{LABEL}'], capture_output=True).returncode:
        runner(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True, capture_output=True)
    result = {'installed': True, 'intervalHours': 1, 'plist': str(plist)}
    print(json.dumps(result))
    return result

def main(argv=None):
    parser = argparse.ArgumentParser(description='모델 사용량 증분 수집기(메뉴바 모델 탭)')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT)
    parser.add_argument('--state', type=Path, default=DEFAULT_STATE)
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--since', help='JSON에 실을 첫 날짜(YYYY-MM-DD)')
    parser.add_argument('--install', action='store_true', help='1시간 주기 LaunchAgent 등록(qgate 경유)')
    args = parser.parse_args(argv)
    if args.install:
        install()
        return 0
    report = collect(args.home, args.state, args.out, since=args.since)
    print(json.dumps({'out': str(args.out), 'rows': len(report['daily']), **report['scan']}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
