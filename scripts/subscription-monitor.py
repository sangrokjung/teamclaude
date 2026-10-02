#!/usr/bin/env python3
"""구독 메일을 읽어 표시용 상태만 저장한다. 인증·구독·UserDefaults는 변경하지 않는다."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
STATE = Path.home() / '.local/state/cc-menubar/subscription-monitor.json'
CONFIG = Path.home() / '.config/teamclaude.json'
LABEL = 'com.qjc.cc-subscription-monitor'
MICROSOFT_DOMAINS = ('outlook.kr', 'outlook.com', 'hotmail.com', 'live.com')


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError('invalid-time')
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('missing-timezone')
    return parsed


def identity(uuid):
    return hashlib.sha256(('anthropic:' + uuid).encode()).hexdigest()


def configured_accounts(config):
    rows = config.get('accounts', [])
    result = []
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict) or row.get('provider', 'anthropic') != 'anthropic' or row.get('type') != 'oauth':
            continue
        email, uuid = row.get('name'), row.get('accountUuid')
        if not isinstance(email, str) or '@' not in email or not isinstance(uuid, str) or not uuid:
            continue
        if sum(a.get('accountUuid') == uuid for a in rows if isinstance(a, dict)) != 1:
            continue
        if sum(str(a.get('name', '')).lower() == email.lower() for a in rows if isinstance(a, dict)) != 1:
            continue
        result.append({'index': index, 'email': email.lower(), 'hash': identity(uuid)})
    return result


def normalize_event(event, email, now):
    if not isinstance(event, dict) or event.get('kind') not in ('cancel', 'join'):
        raise ValueError('unknown-event')
    if event.get('senderVerified') is not True:
        raise ValueError('sender-unverified')
    sender = event.get('sender', '').lower()
    if not re.fullmatch(r'[a-z0-9._%+-]+@mail[.]anthropic[.]com', sender) or event.get('recipient', '').lower() != email:
        raise ValueError('identity-mismatch')
    at = timestamp(event.get('eventAt'))
    if at > now or at.year < 2020:
        raise ValueError('invalid-event-time')
    end = event.get('endsOn')
    if event['kind'] == 'cancel':
        if not isinstance(end, str) or dt.date.fromisoformat(end).isoformat() != end:
            raise ValueError('invalid-end-date')
    else:
        end = None
    return {'kind': event['kind'], 'eventAt': at.astimezone(dt.timezone.utc).isoformat(), 'endsOn': end}


def reconcile(config, collected, previous, now):
    accounts = configured_accounts(config)
    old = previous.get('accounts', {}) if isinstance(previous, dict) else {}
    output = {}
    for a in accounts:
        # 연결이 끊겨도 과거 성공 시각과 이벤트를 보존한다.
        prior = old.get(a['hash'], {})
        row = dict(prior) if isinstance(prior, dict) else {}
        row['status'] = 'unsupported' if a['email'].endswith('@nate.com') else 'login-required'
        matches = [r for r in collected if isinstance(r, dict) and r.get('email', '').lower() == a['email']]
        if len(matches) == 1:
            observed = matches[0]
            row['status'] = observed.get('status') if observed.get('status') in ('ok', 'error', 'busy', 'login-required') else 'error'
            if row['status'] == 'ok':
                try:
                    raw_events = observed.get('events')
                    if not isinstance(raw_events, list) or len(raw_events) > 100:
                        raise ValueError('invalid-events')
                    events = [normalize_event(e, a['email'], now) for e in raw_events]
                    if events:
                        events.sort(key=lambda e: (timestamp(e['eventAt']), e['kind']))
                        newest = events[-1]
                        if any(e['eventAt'] == newest['eventAt'] and e != newest for e in events):
                            raise ValueError('ambiguous-event')
                        prior_event = row.get('event')
                        if prior_event and timestamp(newest['eventAt']) == timestamp(prior_event['eventAt']) and newest != prior_event:
                            raise ValueError('conflicting-history')
                        if not prior_event or timestamp(newest['eventAt']) >= timestamp(prior_event['eventAt']):
                            row['event'] = newest
                        else:
                            raise ValueError('incomplete-history')
                    elif row.get('event'):
                        raise ValueError('missing-previous-event')
                    row['lastSuccessAt'] = now.isoformat()
                except (ValueError, TypeError, AttributeError, KeyError):
                    row['status'] = 'error'
        elif len(matches) > 1:
            row['status'] = 'error'
        else:
            domain = a['email'].rpartition('@')[2]
            failures = [r for r in collected if r.get('domain') == domain
                        or (r.get('domain') == 'outlook' and domain in MICROSOFT_DOMAINS)
                        or (r.get('domain') == 'google' and domain not in ('naver.com', 'nate.com', *MICROSOFT_DOMAINS))]
            if failures:
                states = {r.get('status') for r in failures}
                row['status'] = next(iter(states)) if len(states) == 1 and states <= {'busy', 'login-required'} else 'error'
        output[a['hash']] = row
    return {'version': 1, 'checkedAt': now.isoformat(), 'accounts': output}


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)



def collector_diagnostic(stderr, limit=400):
    """수집기 stderr를 진단용으로 줄인다 — 메일 주소는 가린다."""
    text = (stderr or '').strip()
    # 메일 주소 형태는 인용 local-part·IP 도메인·%40 인코딩까지 넓게 잡고,
    # 홈 경로의 사용자명과 토큰류도 함께 가린다(적대 리뷰 2026-09-24: 좁은 패턴은 전부 우회됐다).
    for pattern, mask in ((r'\S*@\S+', '<email>'),
                          (r'\S*%40\S+', '<email>'),
                          (r'/Users/[^/\s]+', '/Users/<user>'),
                          (r'(?i)\b(bearer|token|session|cookie)[=:\s]+\S+', r'\1=<redacted>')):
        text = re.sub(pattern, mask, text)
    lines = [line for line in text.splitlines() if line.strip()]
    return (' | '.join(lines[-4:]) or '(stderr 없음)')[:limit]

def collect(accounts, lock_fd=None):
    aside = shutil.which('aside')
    if not aside:
        raise RuntimeError('aside-unavailable')
    code = (ROOT / 'scripts/subscription-monitor-browser.js').read_text()
    code += '\nconsole.log("SUBSCRIPTION_RESULT="+JSON.stringify(await collectSubscriptionMail(' + json.dumps([a['email'] for a in accounts]) + ')));'
    process = subprocess.Popen([aside, 'repl'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True, pass_fds=(() if lock_fd is None else (lock_fd,)))
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)
    previous_sigterm = signal.signal(signal.SIGTERM, interrupted)
    try:
        stdout, stderr = process.communicate(input='await eval(' + json.dumps('(async()=>{' + code + '})()', ensure_ascii=False) + ');\n', timeout=130)
    except subprocess.TimeoutExpired:
        raise RuntimeError('collector-timeout') from None
    finally:
        try:
            # 리더가 먼저 종료했더라도 잠금 FD를 가진 같은 그룹의 자식을 회수한다.
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                if process.poll() is None:
                    process.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                pass
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if process.poll() is None:
                    process.communicate()
        finally:
            signal.signal(signal.SIGTERM, previous_sigterm)
    marker = 'SUBSCRIPTION_RESULT='
    lines = [line.split(marker, 1)[1] for line in stdout.splitlines() if marker in line and line.split(marker, 1)[1].startswith('[')]
    if process.returncode != 0 or len(lines) != 1:
        # 수집기 stderr를 버리면 실패 원인이 사라진다(2026-09-24: node 버전 차이로 난 실패를
        # 셸·호스트·타이밍 탓으로 세 번 오진했다). 메일 주소만 가리고 마지막 몇 줄을 남긴다.
        raise RuntimeError('collector-failed: rc=%s %s' % (process.returncode, collector_diagnostic(stderr)))
    value = json.loads(lines[0])
    if not isinstance(value, list) or len(value) > 64 or any(not isinstance(x, dict) for x in value):
        raise RuntimeError('collector-shape')
    return value


def run(dry_run=False):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    lock_path = STATE.with_suffix('.lock')
    with lock_path.open('a') as lock:
        os.chmod(lock_path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'already-running'})); return
        config = json.loads(CONFIG.read_text())
        accounts = configured_accounts(config)
        try:
            previous = json.loads(STATE.read_text()) if STATE.exists() else {}
        except (ValueError, OSError):
            previous = {}
        try:
            collected = collect(accounts, lock_fd=lock.fileno())
        except (RuntimeError, ValueError, OSError) as error:
            # 원인을 삼키면 'error' 한 글자만 남아 다음 조사가 처음부터 다시 시작된다.
            print('subscription-monitor: %s' % error, file=sys.stderr)
            collected = [{'email': a['email'], 'status': 'error'} for a in accounts]
        merged = reconcile(config, collected, previous, dt.datetime.now(dt.timezone.utc))
        if not dry_run:
            atomic_json(STATE, merged)
        rows = [{'index': a['index'], **merged['accounts'][a['hash']]} for a in accounts]
        if dry_run:
            for a, row in zip(accounts, rows):
                matches = [r for r in collected if r.get('email', '').lower() == a['email'] or r.get('domain') == a['email'].rpartition('@')[2]]
                row['diagnostic'] = [r.get('reason') for r in matches if r.get('status') == 'error']
        print(json.dumps({'dryRun': dry_run, 'checkedAt': merged['checkedAt'], 'accounts': rows}, ensure_ascii=False))


def install():
    # 설치는 사용자 요청에 따른 일회성 동작. 이후 수집기는 표시 캐시만 쓴다.
    plist = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
    qgate = Path.home() / '.claude/scripts/qgate.py'
    python = shutil.which('python3')
    if not python or not qgate.is_file():
        raise RuntimeError('scheduler-unavailable')
    data = {'Label': LABEL, 'ProgramArguments': [python, str(qgate), 'run', '--detach', '--follow', '--slot', 'heavy', '--label', 'subscription-monitor', '--', python, str(Path(__file__).resolve())],
            'RunAtLoad': True, 'StartInterval': 21600, 'ProcessType': 'Background',
            'WorkingDirectory': str(ROOT), 'EnvironmentVariables': {'PATH': os.environ.get('PATH', '')},
            'StandardOutPath': str(STATE.with_suffix('.log')), 'StandardErrorPath': str(STATE.with_suffix('.error.log'))}
    STATE.parent.mkdir(parents=True, exist_ok=True)
    for path in [STATE.with_suffix('.log'), STATE.with_suffix('.error.log')]:
        path.touch(mode=0o600, exist_ok=True);path.chmod(0o600)
    if plist.exists():
        if plistlib.loads(plist.read_bytes()) != data:
            raise RuntimeError('existing-agent-differs')
    else:
        plist.write_bytes(plistlib.dumps(data));plist.chmod(0o600)
    probe = subprocess.run(['launchctl', 'print', f'gui/{os.getuid()}/{LABEL}'], capture_output=True)
    if probe.returncode:
        subprocess.run(['launchctl', 'bootstrap', f'gui/{os.getuid()}', str(plist)], check=True, capture_output=True)
    print(json.dumps({'installed': True, 'intervalHours': 6, 'plist': str(plist)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    if args.install:
        install()
    else:
        run(args.dry_run)
