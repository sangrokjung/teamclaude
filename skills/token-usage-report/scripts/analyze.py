import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import time

HOME = Path(os.environ.get('TOKEN_REPORT_HOME', Path.home())).expanduser().resolve()
CODEX_HOME = HOME / '.codex'
CODEX_STATE_DB = None
CLAUDE_PROJECTS = Path(os.environ.get('CLAUDE_PROJECTS_DIR', HOME / '.claude' / 'projects')).expanduser().resolve()
NOW = time.time()
WINDOW_HOURS = (1, 24, 168, 720, 8760)
START = NOW - max(WINDOW_HOURS) * 3600
KST = dt.timezone(dt.timedelta(hours=9))
AUDIT = collections.Counter()
EVENTS = {}
SESSIONS = {}
RETENTION = {}


def timeline_bucket(ts, hours):
    local = dt.datetime.fromtimestamp(ts, KST)
    if hours >= 8760:
        return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    if hours >= 720:
        return local.replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    step = 300 if hours == 1 else 3600
    return int(ts // step) * step


def coverage_metadata(events, chosen, hours):
    start = NOW - hours * 3600
    def observed(rows):
        times = [e['ts'] for e in rows]
        return min(times) if times else None, max(times) if times else None
    first, last = observed(chosen)
    vendors = {}
    for vendor in ('Claude', 'Codex'):
        retained_first, retained_last = observed([e for e in events if e['vendor'] == vendor])
        vendor_first, vendor_last = observed([e for e in chosen if e['vendor'] == vendor])
        vendors[vendor] = dict(observedStart=vendor_first, observedEnd=vendor_last,
            retainedUsageStart=retained_first, retainedUsageEnd=retained_last,
            coverage='limited' if vendor_first is not None else 'none',
            missingRollouts=AUDIT['codex_missing_rollouts'] if vendor == 'Codex' else None)
    return dict(periodLabel={1:'최근 1시간', 24:'최근 24시간', 168:'최근 7일', 720:'최근 30일', 8760:'최근 1년'}[hours],
        periodDays=hours / 24, timezone='Asia/Seoul',
        timelineBucket='month' if hours >= 8760 else 'day' if hours >= 720 else '5minute' if hours == 1 else 'hour',
        requestedStart=start, requestedEnd=NOW, observedStart=first, observedEnd=last,
        availableHours=(last-first)/3600 if first is not None else 0,
        availableHoursMeaning='관측된 첫·마지막 사용 이벤트 사이의 시간이며 로그 연속 보존을 보장하지 않음',
        coverage='limited' if chosen else 'none', vendors=vendors,
        emptyBucketMeaning='보존된 로그에 관측 없음. 실제 미사용 또는 누락 여부를 판별할 수 없음',
        retention=RETENTION)


def timestamp(value):
    try:
        value = re.sub(r'\.(\d+)(?=Z|[+-]\d\d:\d\d|$)', lambda m: '.' + m[1][:6].ljust(6, '0'), value)
        return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError, AttributeError):
        return 0


def project(cwd):
    if not cwd:
        return '프로젝트 미상'
    path = Path(cwd).expanduser()
    if not path.is_absolute():
        return path.name or '프로젝트 미상'
    if path == HOME:
        return '홈 디렉터리'
    for parent in (path, *path.parents):
        marker = parent / '.git'
        if marker.is_file():
            try:
                target = marker.read_text(encoding='utf-8').strip().removeprefix('gitdir: ')
                gitdir = (parent / target).resolve()
                if gitdir.parent.name == 'worktrees':
                    return gitdir.parent.parent.parent.name
            except OSError:
                pass
        if marker.is_dir():
            return parent.name
        if parent == HOME:
            break
    if '/.claude/worktrees/' in str(path):
        return str(path).split('/.claude/worktrees/')[0].rsplit('/', 1)[-1]
    return path.name or '프로젝트 미상'


def classify_task(text):
    text = text.lower()
    rules = [
        ('하네스·자동화', r'harness|agent-routing|handoff-verify|teamclaude|teamcodex|claude-md'),
        ('검토·검증', r'review|검증|리뷰|checker|adversarial|verify|\bqa\b|audit'),
        ('콘텐츠 제작', r'ffmpeg|remotion|hyperframes|영상|썸네일|shortform|imagegen|렌더|릴스|카드뉴스|유튜브'),
        ('개발·구현', r'bug|debug|fix|오류|버그|장애|고쳐|수정|hardening'),
        ('조사·분석', r'research|조사|분석|리서치|찾아|insight'),
        ('개발·구현', r'implement|개발|구현|만들|build|feature|sequence|\bapi\b|component'),
        ('문서·운영', r'문서|동기화|sync|보고|정리|readme|운영|회의록'),
    ]
    for name, pattern in rules:
        if re.search(pattern, text):
            return name, pattern
    return '분류 미확정', 'no_matching_metadata'


def task_category(text):
    return classify_task(text)[0]



def register_session(sid, vendor, cwd, branch='', hint='', model='', source=''):
    if sid not in SESSIONS:
        branch = re.sub(r'[\w.+-]+@[\w.-]+', '[비공개]', branch or '')[:100]
        category, basis = classify_task(' '.join([hint, branch, project(cwd)]))
        SESSIONS[sid] = dict(id=sid, vendor=vendor, project=project(cwd),
                            branch=branch, task=category, category=category,
                            categoryBasis=basis, model=model, source=source)
    return SESSIONS[sid]


def add_event(key, event):
    if not START <= event['ts'] <= NOW:
        return
    previous = EVENTS.get(key)
    if previous:
        AUDIT['duplicate_usage_records'] += 1
        if event['total'] > previous['total']:
            EVENTS[key] = event
    else:
        EVENTS[key] = event


def numeric(usage, key):
    if not isinstance(usage, dict):
        return 0
    value = usage.get(key, 0) or 0
    return max(0, int(value)) if isinstance(value, (int, float)) and math.isfinite(value) else 0


def scan_claude():
    paths = sorted(CLAUDE_PROJECTS.glob('**/*.jsonl'))
    mtimes = [p.stat().st_mtime for p in paths]
    RETENTION['Claude'] = dict(filesAvailable=len(paths), oldestFileModifiedAt=min(mtimes) if mtimes else None,
        newestFileModifiedAt=max(mtimes) if mtimes else None, scope='로컬 .claude/projects JSONL, 파일 수정시각은 사용 관측 시작시각과 다름',
        deletedLogsDetectable=False)
    for path in paths:
        if path.stat().st_mtime < START:
            continue
        AUDIT['claude_files_scanned'] += 1
        sid, cwd, branch, hint = '', '', '', ''
        with path.open(errors='replace') as stream:
            for line in stream:
                if '"usage"' not in line and '"type":"user"' not in line and '"type": "user"' not in line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    AUDIT['malformed_claude_lines'] += 1
                    continue
                if not isinstance(item, dict):
                    AUDIT['malformed_claude_lines'] += 1
                    continue
                sid = item.get('sessionId') or sid or path.stem
                cwd = item.get('cwd') or cwd
                branch = item.get('gitBranch') or branch
                message = item.get('message') or {}
                if not isinstance(message, dict):
                    continue
                if item.get('type') == 'user' and not hint:
                    content = message.get('content', '')
                    if isinstance(content, str) and not content.startswith(('<', '# AGENTS')):
                        hint = content[:1500]
                usage = message.get('usage')
                if item.get('type') != 'assistant' or not isinstance(usage, dict) or not isinstance(message.get('id'), str):
                    continue
                ts = timestamp(item.get('timestamp'))
                if not START <= ts <= NOW:
                    continue
                leaf = 'claude:' + str(sid) + ('/' + path.stem if path.stem.startswith('agent-') else '')
                register_session(leaf, 'Claude', cwd, branch, hint, message.get('model', ''),
                                 'subagent' if '/subagents/' in str(path) else item.get('entrypoint', 'cli'))
                fresh = numeric(usage, 'input_tokens')
                write = numeric(usage, 'cache_creation_input_tokens')
                cached = numeric(usage, 'cache_read_input_tokens')
                output = numeric(usage, 'output_tokens')
                add_event('claude:' + message['id'], dict(ts=ts, sid=leaf, vendor='Claude',
                          fresh=fresh, write=write, cached=cached, output=output,
                          total=fresh + write + cached + output, model=message.get('model', 'unknown')))
    print('Claude scan complete', AUDIT['claude_files_scanned'], flush=True)


def codex_sources():
    sources = {}
    if CODEX_STATE_DB and CODEX_STATE_DB.is_file():
        try:
            conn = sqlite3.connect(CODEX_STATE_DB.as_uri() + '?mode=ro', uri=True)
            try:
                conn.row_factory = sqlite3.Row
                columns = {row[1] for row in conn.execute('PRAGMA table_info(threads)')}
                if {'id', 'rollout_path'} <= columns:
                    for raw in conn.execute('SELECT * FROM threads'):
                        row = dict(raw)
                        name = row.get('rollout_path')
                        if not name:
                            continue
                        path = Path(name).expanduser()
                        if not path.is_absolute():
                            path = CODEX_STATE_DB.parent / path
                        sources[str(path.resolve())] = row
                else:
                    AUDIT['codex_unsupported_index'] += 1
            finally:
                conn.close()
        except sqlite3.Error:
            AUDIT['codex_unreadable_index'] += 1
    for folder in ('sessions', 'archived_sessions'):
        for path in (CODEX_HOME / folder).glob('**/*.jsonl'):
            if path.stat().st_mtime >= START:
                sources.setdefault(str(path.resolve()), {})
    rows = []
    for name, info in sources.items():
        path = Path(name)
        if not path.is_file():
            AUDIT['codex_missing_rollouts'] += 1
            continue
        defaults = dict(id=path.stem, cwd='', git_branch='', title='', model='unknown', model_provider='')
        defaults.update({k: v for k, v in info.items() if v is not None})
        try:
            with path.open(encoding='utf-8', errors='replace') as stream:
                for _ in range(20):
                    line = stream.readline()
                    if not line:
                        break
                    try:
                        item = json.loads(line)
                        if item.get('type') == 'session_meta':
                            meta = item.get('payload') or {}
                            defaults.update(id=meta.get('id') or defaults['id'],
                                cwd=meta.get('cwd') or defaults['cwd'],
                                git_branch=(meta.get('git') or {}).get('branch') or defaults['git_branch'],
                                model_provider=meta.get('model_provider') or defaults['model_provider'])
                            break
                    except (ValueError, AttributeError):
                        continue
        except OSError:
            AUDIT['codex_unreadable_files'] += 1
            continue
        defaults['rollout_path'] = name
        rows.append(defaults)
    RETENTION['Codex'] = dict(candidateThreads=len(rows),
        scope='로컬 sessions·archived_sessions JSONL 및 선택적 SQLite 색인',
        deletedLogsDetectable='색인에 남아 있으나 rollout 파일이 없는 경우만 검출')
    return rows


def scan_codex():
    rows = codex_sources()
    for row in rows:
        path = Path(row['rollout_path'])
        if not path.is_file():
            AUDIT['codex_missing_rollouts'] += 1
            continue
        sid = 'codex:' + str(row['id'])
        hint = row['title']
        AUDIT['codex_files_scanned'] += 1
        previous = None
        records = {}
        counts = []
        model = row['model'] or 'unknown'
        with path.open(errors='replace') as stream:
            for line in stream:
                if not any(word in line for word in ['"token_count"', '"token_usage_record"', '"turn_context"', '"user_message"', '"response_item"']):
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    AUDIT['malformed_codex_lines'] += 1
                    continue
                if not isinstance(item, dict):
                    AUDIT['malformed_codex_lines'] += 1
                    continue
                payload = item.get('payload', {})
                if not isinstance(payload, dict):
                    AUDIT['malformed_codex_lines'] += 1
                    continue
                if not hint:
                    content = payload.get('message', '') if payload.get('type') == 'user_message' else ''
                    if item.get('type') == 'response_item' and payload.get('role') == 'user':
                        parts = payload.get('content', [])
                        if isinstance(parts, list):
                            content = ' '.join(p.get('text', '') for p in parts if isinstance(p, dict) and isinstance(p.get('text'), str))
                    if isinstance(content, str) and content.strip() and not content.lstrip().startswith(('<', '# AGENTS')):
                        hint = content[:1500]
                if item.get('type') == 'turn_context':
                    model = payload.get('model') or model
                elif item.get('type') == 'token_usage_record':
                    u = payload.get('usage', {})
                    rkey = payload.get('response_id')
                    if rkey:
                        thread_usage = payload.get('thread_token_usage') or {}
                        cumulative = thread_usage.get('total_tokens') if isinstance(thread_usage, dict) else None
                        if not isinstance(cumulative, (int, float)) or not math.isfinite(cumulative):
                            AUDIT['codex_response_missing_cumulative'] += 1
                        if isinstance(u, dict):
                            records[str(rkey)] = (u, timestamp(item.get('timestamp')), 'codex:' + str(payload['thread_id']) if payload.get('thread_id') else sid, model)
                elif payload.get('type') == 'token_count':
                    info = payload.get('info') or {}
                    if not isinstance(info, dict):
                        continue
                    u = info.get('total_token_usage')
                    if not isinstance(u, dict) or not u:
                        continue
                    total = numeric(u, 'total_tokens')
                    ts = timestamp(item.get('timestamp'))
                    if previous is None:
                        delta = info.get('last_token_usage') or {}
                        if total > numeric(delta, 'total_tokens'):
                            AUDIT['codex_initial_inherited_or_missing_baseline'] += 1
                    elif total == numeric(previous, 'total_tokens'):
                        AUDIT['codex_repeated_counter'] += 1
                        previous = u
                        continue
                    elif total < numeric(previous, 'total_tokens'):
                        AUDIT['codex_counter_resets'] += 1
                        delta = info.get('last_token_usage') or {}
                    else:
                        delta = {k: max(0, numeric(u, k) - numeric(previous, k)) for k in u}
                    previous = u
                    counts.append((total, delta, ts, model))
        register_session(sid, 'Codex', row['cwd'], row['git_branch'], hint, row['model'], row['model_provider'])
        if records:
            if counts:
                AUDIT['codex_mixed_source_files_response_only'] += 1
                AUDIT['codex_counter_records_omitted_for_response_source'] += len(counts)
            for key, (usage, ts, owner, model) in records.items():
                emit_codex('codex-response:' + key, usage, ts, owner if owner in SESSIONS else sid, model)
                AUDIT['codex_response_records_used'] += 1
        else:
            for total, delta, ts, model in counts:
                key = 'codex-event:' + hashlib.sha256(json.dumps([sid, ts, total, delta], sort_keys=True).encode()).hexdigest()
                emit_codex(key, delta, ts, sid, model)
                AUDIT['codex_delta_records_used'] += 1
    print('Codex scan complete', AUDIT['codex_files_scanned'], flush=True)


def emit_codex(key, usage, ts, sid, model):
    inp, cached = numeric(usage, 'input_tokens'), numeric(usage, 'cached_input_tokens')
    output = numeric(usage, 'output_tokens')
    if cached > inp:
        AUDIT['codex_cached_exceeds_input'] += 1
    if inp + output != numeric(usage, 'total_tokens'):
        AUDIT['codex_total_component_mismatch'] += 1
    cached = min(cached, inp)
    add_event(key, dict(ts=ts, sid=sid, vendor='Codex', fresh=inp - cached,
                       write=0, cached=cached, output=output, total=inp + output, model=model))


def aggregate(events, hours):
    chosen = [e for e in events if NOW - hours * 3600 <= e['ts'] <= NOW]
    projects, sessions, timeline, vendors, models, categories = {}, {}, {}, {}, {}, {}
    daily_hours = {}
    fields = ['total', 'fresh', 'write', 'cached', 'output']
    def update(target, key, e, identity):
        if key not in target:
            target[key] = dict(identity, **{f: 0 for f in fields}, requests=0, first=e['ts'], last=e['ts'])
        value = target[key]
        for f in fields:
            value[f] += e[f]
        value['requests'] += 1
        value['first'], value['last'] = min(value['first'], e['ts']), max(value['last'], e['ts'])
    for e in chosen:
        s = SESSIONS[e['sid']]
        update(projects, (e['vendor'], s['project']), e, dict(vendor=e['vendor'], project=s['project']))
        update(sessions, e['sid'], e, s)
        bucket = timeline_bucket(e['ts'], hours)
        update(timeline, (e['vendor'], bucket), e, dict(vendor=e['vendor'], ts=bucket))
        update(vendors, e['vendor'], e, dict(vendor=e['vendor']))
        update(models, (e['vendor'], e['model']), e, dict(vendor=e['vendor'], model=e['model']))
        category = s.get('category', s.get('task', '분류 미확정'))
        update(categories, (e['vendor'], category), e, dict(vendor=e['vendor'], category=category, projects={}))
        categories[(e['vendor'], category)]['projects'].setdefault(s['project'], {'project': s['project'], 'total': 0, 'noncached': 0})
        categories[(e['vendor'], category)]['projects'][s['project']]['total'] += e['total']
        categories[(e['vendor'], category)]['projects'][s['project']]['noncached'] += e['total'] - e['cached']
        local = dt.datetime.fromtimestamp(e['ts'], KST)
        dkey = (e['vendor'], local.date().isoformat(), local.hour)
        daily_hours.setdefault(dkey, dict(vendor=e['vendor'], date=local.date().isoformat(), hour=local.hour,
                                          total=0, noncached=0, requests=0, exposureHours=0))
        daily_hours[dkey]['total'] += e['total']
        daily_hours[dkey]['noncached'] += e['total'] - e['cached']
        daily_hours[dkey]['requests'] += 1
    window_start, window_end = NOW - hours * 3600, NOW
    first_date = dt.datetime.fromtimestamp(window_start, KST).date()
    last_date = dt.datetime.fromtimestamp(window_end, KST).date()
    dates = []
    cursor = first_date
    while cursor <= last_date:
        dates.append(cursor.isoformat())
        cursor += dt.timedelta(days=1)
    daily_rows = []
    for vendor in ['Claude', 'Codex']:
        for date_text in dates:
            date = dt.date.fromisoformat(date_text)
            for hour in range(24):
                slot_start = dt.datetime.combine(date, dt.time(hour), KST).timestamp()
                overlap = max(0, min(window_end, slot_start + 3600) - max(window_start, slot_start)) / 3600
                row = daily_hours.get((vendor, date_text, hour), dict(vendor=vendor, date=date_text, hour=hour,
                    total=0, noncached=0, requests=0))
                row['exposureHours'] = overlap
                row['observation'] = 'outside_window' if overlap == 0 else 'observed' if row['requests'] else 'no_record'
                daily_rows.append(row)
    hour_rows = []
    for vendor in ['Claude', 'Codex']:
        for hour in range(24):
            rows = [x for x in daily_rows if x['vendor'] == vendor and x['hour'] == hour]
            hour_rows.append(dict(vendor=vendor, hour=hour, total=sum(x['total'] for x in rows),
                noncached=sum(x['noncached'] for x in rows), requests=sum(x['requests'] for x in rows),
                exposureHours=sum(x['exposureHours'] for x in rows)))
    for target in [projects, sessions, timeline, vendors, models, categories]:
        for value in target.values():
            value['noncached'] = value['total'] - value['cached']
            value['perHour'] = value['total'] / hours
            value['noncachedPerHour'] = value['noncached'] / hours
            value['cacheShare'] = value['cached'] / value['total'] if value['total'] else 0
    category_rows = []
    for row in categories.values():
        row['sessions'] = sum(1 for s in sessions.values() if s['vendor'] == row['vendor'] and s.get('category', s.get('task', '분류 미확정')) == row['category'])
        row['projects'] = sorted(row['projects'].values(), key=lambda x: -x['total'])
        category_rows.append(row)
    return dict(hours=hours, start=NOW-hours*3600, end=NOW, events=len(chosen),
                metadata=coverage_metadata(events, chosen, hours),
                projects=sorted(projects.values(), key=lambda x: -x['total']),
                sessions=sorted(sessions.values(), key=lambda x: -x['total']),
                timeline=sorted(timeline.values(), key=lambda x: x['ts']),
                vendors=list(vendors.values()), models=sorted(models.values(), key=lambda x: -x['total']),
                categories=sorted(category_rows, key=lambda x: -x['total']),
                hourOfDay=hour_rows, dailyHours=daily_rows)


def collect():
    scan_claude()
    scan_codex()
    events = sorted(EVENTS.values(), key=lambda x: x['ts'])
    result = dict(generatedAt=NOW, generatedKst=dt.datetime.fromtimestamp(NOW, KST).isoformat(),
        audit=dict(AUDIT), quota={'pools': []},
        windows={str(h): aggregate(events, h) for h in WINDOW_HOURS},
        methodology=[
            '이 기기의 로컬 로그 기준. 다른 기기·삭제된 기록은 포함하지 않습니다.',
            '프록시 경유 여부와 실제 구독 한도는 로그만으로 확정하지 않습니다.',
            '처리 토큰 = 일반 입력 + 캐시 생성 + 캐시 읽기 + 출력. Codex 캐시는 입력에 이미 포함되므로 별도 중복 합산하지 않습니다.',
            '캐시 제외 = 처리 토큰 − 캐시 읽기. 과금 토큰·구독 한도 소진율과 동일하지 않습니다.',
            '시간당 속도 = 관측 토큰 ÷ 선택 기간 전체 시간. 기록이 없는 시간도 분모에 포함됩니다.',
            'Claude message.id 중복 제거; Codex response_id 우선, 구형 이벤트는 누적 차분. reasoning은 출력에 포함되어 별도 합산하지 않습니다.',
            '작업 유형은 첫 요청·제목·브랜치·저장소 이름의 키워드 기반 추정. 원문 프롬프트·제목은 내보내지 않습니다.',
            '1h/24h/7d/30d/365d의 이동 구간. KST 30일=일별,365일=월별. 처음·마지막은 부분 기간입니다.',
            '빈 칸은 기록 없음이며 실제 미사용 0으로 확정하지 않습니다. 보존 범위 내에도 로그가 누락될 수 있습니다.',
            'Codex 파일에 response_id 사용량이 있으면 응답 기록만 집계합니다. 없을 때만 누적 차분을 사용합니다. 혼합 파일의 응답 기록 누락분은 추정 합산하지 않으며 실제보다 적을 수 있습니다.',
            f'Codex 혼합 소스 파일 {AUDIT["codex_mixed_source_files_response_only"]}개에서 차분 {AUDIT["codex_counter_records_omitted_for_response_source"]}개를 제외했습니다. 이 경우 응답 기록에 남은 사용량만 반영합니다.',
            '가격은 저장된 API 정가 스냅샷 또는 직접 입력한 단가의 비교용 추정액이며 실제 청구액이 아닙니다.',
        ])
    return result, events
