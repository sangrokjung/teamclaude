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
OUTPUT_DAYS = 70          # JSON에 싣는 날짜 범위(10주)
SEEN_KEEP_DAYS = 120      # 중복 제거 키를 기억하는 기간
DEFAULT_RETENTION = 30    # Claude Code cleanupPeriodDays 기본값
TOKENS_RE = re.compile(r'tokens used\s*\n\s*([\d,]+)')


# ---------- 상태 DB ----------

def open_state(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(mode=0o600, exist_ok=True)  # 로그 파일 경로가 들어 있어 본인만 읽게 둔다
    db = sqlite3.connect(path)
    db.executescript("""
    create table if not exists meta (key text primary key, value text);
    create table if not exists files (path text primary key, ino integer, size integer, mtime real, offset integer, ctx text);
    create table if not exists seen (key text primary key, day text);
    create table if not exists daily (date text, lane text, model text, source text,
        input integer, output integer, cache_read integer, cache_write integer, calls integer,
        primary key (date, lane, model, source));
    create table if not exists windows (path text, reset integer, first_pct real, max_pct real, tokens integer, last_ts integer,
        primary key (path, reset));
    create table if not exists receipt_files (path text primary key, mtime real);
    create table if not exists receipts (run_id text primary key, canonical integer, date text, tokens integer, review_sec real);
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


def jsonl_files(root: Path):
    if not root.is_dir():
        return []
    return sorted(p for p in root.rglob('*.jsonl') if p.is_file())


def read_new_lines(db, path: Path, scan: Scan, handle_line, ctx_default):
    """붙은 줄만 handle_line(line, ctx)로 넘긴다. 파일이 줄었거나 바뀌었으면 처음부터(중복 키가 막는다)."""
    try:
        st = path.stat()
    except OSError:
        return
    scan.files += 1
    row = db.execute('select ino, size, mtime, offset, ctx from files where path = ?', (str(path),)).fetchone()
    offset, ctx = 0, dict(ctx_default)
    if row:
        ino, size, mtime, prev_offset, prev_ctx = row
        if ino == st.st_ino and st.st_size >= prev_offset:
            if st.st_size == size and st.st_mtime == mtime:
                return
            offset, ctx = prev_offset, json.loads(prev_ctx or '{}')
    if st.st_size <= offset:
        db.execute('insert or replace into files values (?,?,?,?,?,?)', (str(path), st.st_ino, st.st_size, st.st_mtime, offset, json.dumps(ctx)))
        return
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
    db.execute('insert or replace into files values (?,?,?,?,?,?)', (str(path), st.st_ino, st.st_size, st.st_mtime, offset, json.dumps(ctx)))


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


def collect_claude(db, home, tz, now, scan):
    def handle(line, _ctx):
        if '"assistant"' not in line or '"usage"' not in line:
            return
        try:
            o = json.loads(line)
        except ValueError:
            return
        msg = o.get('message') if isinstance(o, dict) else None
        if o.get('type') != 'assistant' or not isinstance(msg, dict) or not isinstance(msg.get('usage'), dict):
            return
        model = msg.get('model')
        ts = parse_ts(o.get('timestamp'))
        if not model or model == '<synthetic>' or ts is None or ts > now:
            return
        day = local_day(ts, tz)
        if not first_seen(db, f"c:{msg.get('id')}:{o.get('requestId') or ''}", day):
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

def codex_handle(db, tz, now, path):
    windows = {}

    def window_for(ctx, rl, ts):
        weekly = next((w for w in (rl.get('primary'), rl.get('secondary'))
                       if isinstance(w, dict) and w.get('window_minutes') == 10080), None) if isinstance(rl, dict) else None
        if not weekly or not weekly.get('resets_at') or not isinstance(weekly.get('used_percent'), (int, float)):
            return None
        reset = int(weekly['resets_at'])
        win = windows.get(reset)
        if win is None:
            row = db.execute('select first_pct, max_pct, tokens, last_ts from windows where path = ? and reset = ?', (str(path), reset)).fetchone()
            win = {'first': row[0], 'max': row[1], 'tokens': row[2], 'last': row[3]} if row else \
                {'first': weekly['used_percent'], 'max': weekly['used_percent'], 'tokens': 0, 'last': 0}
            windows[reset] = win
        win['max'] = max(win['max'], weekly['used_percent'])
        win['last'] = int(ts.timestamp() * 1000)
        return win

    def handle(line, ctx):
        if '"turn_context"' not in line and '"token_count"' not in line and '"session_meta"' not in line:
            return
        try:
            o = json.loads(line)
        except ValueError:
            return
        p = o.get('payload') or {}
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
        win = window_for(ctx, p.get('rate_limits'), ts)
        info = p.get('info') or {}
        total = info.get('total_token_usage')
        if not isinstance(total, dict):
            return
        prev = ctx.get('prev')
        delta = total
        if prev:
            delta = {k: (total.get(k) or 0) - (prev.get(k) or 0) for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}
            if delta['input_tokens'] < 0 or delta['output_tokens'] < 0:  # 압축·새 스레드: 마지막 호출 값
                delta = info.get('last_token_usage') or total
        ctx['prev'] = {k: total.get(k) or 0 for k in ('input_tokens', 'cached_input_tokens', 'output_tokens')}
        if ts > now or ((delta.get('input_tokens') or 0) == 0 and (delta.get('output_tokens') or 0) == 0):
            return
        key = f"x:{ctx.get('session', path.name)}:{o.get('timestamp')}:{total.get('input_tokens')}:{total.get('output_tokens')}"
        day = local_day(ts, tz)
        if not first_seen(db, key, day):
            return
        cached = max(0, delta.get('cached_input_tokens') or 0)
        inp = max(0, (delta.get('input_tokens') or 0) - cached)
        out = max(0, delta.get('output_tokens') or 0)
        if win is not None:
            win['tokens'] += max(0, delta.get('input_tokens') or 0) + out
        add_daily(db, day, 'codex', ctx.get('model', 'unknown'), 'codex-cli', inp, out, cached, 0)

    def flush():
        for reset, w in windows.items():
            db.execute('insert or replace into windows values (?,?,?,?,?,?)', (str(path), reset, w['first'], w['max'], w['tokens'], w['last']))
    return handle, flush


def collect_codex(db, home, tz, now, scan):
    for root in (home / '.codex' / 'sessions', home / '.codex' / 'archived_sessions'):
        for path in jsonl_files(root):
            handle, flush = codex_handle(db, tz, now, path)
            read_new_lines(db, path, scan, handle, {'model': 'unknown'})
            flush()


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
        old = db.execute('select canonical from receipts where run_id = ?', (run_id,)).fetchone()
        if old and old[0] >= canonical:
            continue
        base = path.with_suffix('')
        tokens = sum(t for t in (tail_tokens(Path(f'{base}.{lane}.log')) for lane in ('codex-astra', 'codex-sol')) if t)
        db.execute('insert or replace into receipts values (?,?,?,?,?)',
                   (run_id, canonical, local_day(ts, tz), tokens, float(d.get('review_duration_sec') or 0)))


def receipts_report(db, since):
    files = db.execute('select count(*) from receipt_files where path like ?', ('%.json',)).fetchone()[0]
    unique = db.execute('select count(*) from receipts').fetchone()[0]
    daily = [{'date': d, 'runs': r, 'tokens': t, 'reviewSec': round(s)} for d, r, t, s in db.execute(
        'select date, count(*), sum(tokens), sum(review_sec) from receipts where date >= ? group by date order by date', (since,))]
    return {'audit': {'jsonFiles': files, 'uniqueRuns': unique, 'dupRunId': max(0, files - unique)}, 'daily': daily}


# ---------- 구현 루프·Hermes·주기 이력 ----------

def collect_impl(home, since, today):
    folder = home / '.claude' / 'cache' / 'codex-impl-loop'
    by_day = {}
    if not folder.is_dir():
        return []
    for entry in sorted(folder.iterdir()):
        m = re.match(r'^(\d{4})(\d{2})(\d{2})-\d{6}', entry.name)
        if not m:
            continue
        day = f'{m[1]}-{m[2]}-{m[3]}'  # 폴더 이름은 로컬 시각
        if day < since or day > today:
            continue
        try:
            ledger = json.loads((entry / 'ledger.json').read_text())
        except (OSError, ValueError):
            continue
        rounds = ledger.get('rounds') if isinstance(ledger, dict) else None
        row = by_day.setdefault(day, {'date': day, 'runs': 0, 'rounds': 0})
        row['runs'] += 1
        row['rounds'] += len(rounds) if isinstance(rounds, list) else 0
    return [by_day[k] for k in sorted(by_day)]


def hermes_lane(url: str) -> str:
    if ':3457' in url or 'chatgpt.com' in url:
        return 'codex'
    return 'claude' if ':3456' in url else 'other'


def collect_hermes(home, tz, now):
    rows = {}
    try:
        names = sorted(n for n in os.listdir(home) if re.fullmatch(r'\.hermes(-[a-z0-9]+)?', n))
    except OSError:
        return []
    for name in names:
        db_path = home / name / 'state.db'
        if not db_path.is_file():
            continue
        try:
            con = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            found = con.execute("""select u.model, u.billing_base_url, u.api_call_count, u.input_tokens, u.output_tokens,
                u.cache_read_tokens, u.cache_write_tokens, coalesce(u.last_seen, s.started_at)
                from session_model_usage u join sessions s on s.id = u.session_id where u.api_call_count > 0""").fetchall()
            con.close()
        except sqlite3.Error:
            continue
        for model, url, calls, inp, out, cr, cw, ts in found:
            if ts is None:
                continue
            moment = dt.datetime.fromtimestamp(float(ts), dt.timezone.utc)
            if moment > now:
                continue
            key = (local_day(moment, tz), hermes_lane(url or ''), model or 'unknown')
            r = rows.setdefault(key, {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'calls': 0})
            for field, value in (('input', inp), ('output', out), ('cacheRead', cr), ('cacheWrite', cw), ('calls', calls)):
                r[field] += value or 0
    return [{'date': d, 'lane': lane, 'model': m, 'source': 'hermes', **v} for (d, lane, m), v in rows.items()]


def collect_cycles(home, tz):
    try:
        history = json.loads((home / '.codex' / 'cache' / 'cc-menubar-quota-history-v1.json').read_text())
    except (OSError, ValueError):
        return {'since': None, 'daily': []}
    rows = {}
    for c in history.get('cycles', []) if isinstance(history, dict) else []:
        ts = parse_ts(c.get('endedAt')) if isinstance(c, dict) else None
        if ts is None or c.get('lane') != 'claude':
            continue
        key = (local_day(ts, tz), str(c.get('window')))
        r = rows.setdefault(key, {'date': key[0], 'window': key[1], 'cycles': 0, 'exhausted': 0})
        r['cycles'] += 1
        r['exhausted'] += 1 if (c.get('exhaustedAccounts') or 0) > 0 else 0
    daily = [rows[k] for k in sorted(rows)]
    return {'since': daily[0]['date'] if daily else None, 'daily': daily}


# ---------- 풀 ----------

def fetch_proxy_status(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/teamclaude/status', timeout=3) as resp:
            return json.loads(resp.read())
    except (OSError, ValueError):
        return None


def pool_report(status, prefix):
    if not isinstance(status, dict) or not isinstance(status.get('accounts'), list):
        return {'available': False, 'threshold': None, 'accounts': []}
    accounts = []
    for i, a in enumerate(status['accounts'], 1):
        q = a.get('quota') if isinstance(a, dict) and isinstance(a.get('quota'), dict) else {}
        accounts.append({'label': f'{prefix}{i:02d}', 'util7d': q.get('unified7d'), 'reset7d': q.get('unified7dReset'),
                         'usable': bool(a.get('usable')), 'enabled': a.get('enabled') is not False})
    return {'available': True, 'threshold': status.get('switchThreshold'), 'accounts': accounts}


# ---------- Pro 200 환산 기준값 ----------

def pro200_estimate(daily, windows, tz):
    """Pro 200 1주 ≈ 비캐시 토큰 N(추정). 7일 창을 시 단위로 묶어 계정-주로 보고, 창 소진 %p와 그 주 세션 토큰으로 나눈다.
    비캐시 5천만 토큰이 넘는 주의 값으로 중앙(mid)·최소(lo)·최대(hi)를 낸다. 관측이 없으면 None."""
    clusters = {}
    for w in windows:
        c = clusters.setdefault(int(w['reset']) // 3600, {'tokens': 0, 'min': float('inf'), 'max': float('-inf'), 'ts': []})
        c['tokens'] += w['tokens']
        c['min'] = min(c['min'], w['firstPct'])
        c['max'] = max(c['max'], w['maxPct'])
        c['ts'].append(w['lastTs'])
    by_week = {}
    for c in clusters.values():
        consumed = c['max'] - c['min']
        if consumed <= 0:
            continue
        ts = sorted(c['ts'])[len(c['ts']) // 2]
        week = iso_week(local_day(dt.datetime.fromtimestamp(ts / 1000, dt.timezone.utc), tz))
        b = by_week.setdefault(week, {'pro': 0.0, 'tokens': 0})
        b['pro'] += consumed / 100
        b['tokens'] += c['tokens']
    sessions = {}
    for r in daily:
        if r.get('source') != 'codex-cli':
            continue
        s = sessions.setdefault(iso_week(r['date']), {'total': 0, 'noncache': 0})
        s['total'] += r['input'] + r['cacheRead'] + r['output']
        s['noncache'] += r['input'] + r['output']
    per_week = []
    for week, b in by_week.items():
        s = sessions.get(week)
        if not s or s['noncache'] <= 50_000_000 or b['pro'] <= 0:
            continue
        per_week.append(round(s['noncache'] * (b['tokens'] / max(s['total'], 1)) / b['pro']))
    if not per_week:
        return None
    return {'mid': round(statistics.median(per_week)), 'lo': min(per_week), 'hi': max(per_week), 'weeks': len(per_week)}


# ---------- 조립 ----------

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
    since = since or (dt.date.fromisoformat(today) - dt.timedelta(days=OUTPUT_DAYS - 1)).isoformat()
    scan = Scan()
    db = open_state(state_path)
    try:
        first_run = meta_get(db, 'firstRun') or today
        meta_set(db, 'firstRun', first_run)
        retention = collect_claude(db, home, tz, now, scan)
        collect_codex(db, home, tz, now, scan)
        collect_receipts(db, home, tz, scan)
        db.execute('delete from seen where day < ?', ((dt.date.fromisoformat(today) - dt.timedelta(days=SEEN_KEEP_DAYS)).isoformat(),))
        db.commit()
        stored = daily_rows(db, since)
        windows = [{'reset': r, 'firstPct': f, 'maxPct': m, 'tokens': t, 'lastTs': ts}
                   for r, f, m, t, ts in db.execute('select reset, first_pct, max_pct, tokens, last_ts from windows')]
        all_cli = [r for r in daily_rows(db, '0000') if r['source'] == 'codex-cli']
        receipts = receipts_report(db, since)
        receipt_first = db.execute('select min(date) from receipts').fetchone()[0]
        cli_last = db.execute("select max(date) from daily where source = 'codex-cli' and calls > 0").fetchone()[0]
    finally:
        db.close()
    complete_from = (dt.date.fromisoformat(first_run) - dt.timedelta(days=retention - 1)).isoformat()
    hermes = sorted(collect_hermes(home, tz, now), key=lambda r: (r['date'], r['lane'], r['model']))
    report = {
        'schema': SCHEMA,
        'generatedAt': now.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z'),
        'today': today,
        'since': since,
        'coverage': {'claudeCompleteFrom': complete_from, 'claudeRetentionDays': retention,
                     'codexCliLastDay': cli_last, 'receiptFirstDay': receipt_first},
        'daily': stored + [r for r in hermes if r['date'] >= since],
        'receipts': receipts,
        'implLoop': {'daily': collect_impl(home, since, today)},
        'pro200': pro200_estimate(all_cli, windows, tz),
        'quotaCycles': collect_cycles(home, tz),
        'pools': {'claude': pool_report(fetch_status(3456), 'C'), 'codex': pool_report(fetch_status(3457), 'X')},
        'scan': {'bytesRead': scan.bytes_read, 'files': scan.files},
    }
    atomic_write(out_path, report)
    return report


def install():
    """구독 수집기와 같은 방식: qgate 경유 LaunchAgent(1시간). 사람이 실행할 때만 만든다."""
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    qgate = Path.home() / '.claude/scripts/qgate.py'
    python = shutil.which('python3')
    if not python or not qgate.is_file():
        raise RuntimeError('scheduler-unavailable')
    log = DEFAULT_OUT.with_suffix('.log')
    data = {'Label': LABEL, 'ProgramArguments': [python, str(qgate), 'run', '--detach', '--follow', '--slot', 'default',
                                                 '--label', 'model-usage', '--', python, str(Path(__file__).resolve())],
            'RunAtLoad': True, 'StartInterval': 3600, 'ProcessType': 'Background', 'LowPriorityIO': True, 'Nice': 10,
            'WorkingDirectory': str(Path(__file__).resolve().parents[1]), 'EnvironmentVariables': {'PATH': os.environ.get('PATH', '')},
            'StandardOutPath': str(log), 'StandardErrorPath': str(DEFAULT_OUT.with_suffix('.error.log'))}
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    for path in (log, DEFAULT_OUT.with_suffix('.error.log')):
        path.touch(mode=0o600, exist_ok=True)
        path.chmod(0o600)
    if plist.exists():
        if plistlib.loads(plist.read_bytes()) != data:
            raise RuntimeError('existing-agent-differs')
    else:
        plist.write_bytes(plistlib.dumps(data))
        plist.chmod(0o600)
    if subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/{LABEL}'], capture_output=True).returncode:
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True, capture_output=True)
    print(json.dumps({'installed': True, 'intervalHours': 1, 'plist': str(plist)}))


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
