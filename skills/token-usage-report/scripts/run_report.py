import argparse
import datetime as dt
import json
import math
import os
from pathlib import Path
import re
import urllib.request

import analyze as a
from attach_models import attach

ASSETS = Path(__file__).resolve().parent.parent / 'assets'


def safe_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c').replace('>', '\\u003e').replace('&', '\\u0026')


def render_html(data, prices, fx):
    html = (ASSETS / 'report.html').read_text(encoding='utf-8')
    payload = '<script>window.REPORT_DATA=' + safe_json(data) + ';window.REPORT_PRICING=' + safe_json(prices) + ';window.REPORT_FX=' + safe_json(fx) + ';</script>'
    html = html.replace('<head>', '<head>\n' + payload, 1)
    html = re.sub(r'<script src="([\w.-]+)"></script>', lambda m: '<script>\n' + (ASSETS / m[1]).read_text(encoding='utf-8') + '\n</script>', html)
    return re.sub(r'<link rel="stylesheet" href="([\w.-]+)">', lambda m: '<style>\n' + (ASSETS / m[1]).read_text(encoding='utf-8') + '\n</style>', html)


def fx_snapshot(manual=None, fetch=False):
    if manual is not None:
        return dict(rate=manual, asOf=dt.datetime.now(dt.timezone.utc).isoformat(), source='manual')
    if fetch:
        try:
            request = urllib.request.Request('https://open.er-api.com/v6/latest/USD', headers={'User-Agent': 'token-usage-report/1.0'})
            with urllib.request.urlopen(request, timeout=10) as response:
                payload = json.load(response)
            rate = payload['rates']['KRW']
            if not isinstance(rate, (int, float)) or not math.isfinite(rate) or not 0 < rate <= 1e6:
                raise ValueError('invalid rate')
            return dict(rate=rate, asOf=payload['time_last_update_utc'], source='https://open.er-api.com/v6/latest/USD')
        except (OSError, ValueError, KeyError, TypeError):
            return dict(rate=None, asOf=None, source='unavailable')
    return dict(rate=None, asOf=None, source='not-requested')


def main(argv=None):
    parser = argparse.ArgumentParser(description='Claude/Codex 로컬 기록으로 서버 없는 토큰 리포트를 생성합니다. Python 3.10+')
    parser.add_argument('--output', type=Path, default=Path.cwd() / 'token-report-output')
    parser.add_argument('--home', type=Path, default=Path.home())
    parser.add_argument('--claude-projects', type=Path, help='Claude projects 폴더')
    parser.add_argument('--codex-home', type=Path, help='Codex sessions/archived_sessions를 포함한 폴더')
    parser.add_argument('--codex-db', type=Path, help='선택적 state_*.sqlite 색인 (읽기 전용)')
    parser.add_argument('--fx', type=float, help='1 USD당 KRW. 지정하지 않으면 UI에서 입력')
    parser.add_argument('--fetch-fx', action='store_true', help='공개 USD/KRW 환율 조회. 사용 기록은 전송하지 않음')
    parser.add_argument('--prices', type=Path, help='사용자 가격표 JSON; assets/pricing.json 형식')
    args = parser.parse_args(argv)
    if args.fx is not None and (not math.isfinite(args.fx) or not 0 < args.fx <= 1e6):
        parser.error('--fx는 0 초과 1000000 이하의 유한한 숫자여야 합니다.')
    output = args.output.expanduser().resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('출력 디렉터리가 비어 있지 않습니다. 새 출력 디렉터리를 지정하세요.')
    a.HOME = args.home.expanduser().resolve()
    a.CLAUDE_PROJECTS = (args.claude_projects or a.HOME / '.claude' / 'projects').expanduser().resolve()
    a.CODEX_HOME = (args.codex_home or a.HOME / '.codex').expanduser().resolve()
    a.CODEX_STATE_DB = args.codex_db.expanduser().resolve() if args.codex_db else None
    if args.codex_db and not a.CODEX_STATE_DB.is_file():
        parser.error('--codex-db 파일이 없습니다.')
    a.NOW = __import__('time').time()
    a.START = a.NOW - 8760 * 3600
    a.EVENTS.clear(); a.SESSIONS.clear(); a.AUDIT.clear(); a.RETENTION.clear()
    prices = json.loads((args.prices or ASSETS / 'pricing.json').read_text(encoding='utf-8'))
    if not isinstance(prices, dict) or not isinstance(prices.get('models'), dict):
        parser.error('가격표에 models 객체가 필요합니다.')
    for rate in prices['models'].values():
        if not isinstance(rate, dict):
            parser.error('각 모델 가격은 객체여야 합니다.')
        for candidate in [rate, rate.get('long', rate)]:
            if not isinstance(candidate, dict) or not all(isinstance(candidate.get(k), (int, float)) and math.isfinite(candidate[k]) and 0 <= candidate[k] <= 1e6 for k in ('fresh', 'write', 'cached', 'output')):
                parser.error('모델 단가 4개는 0 이상 유한한 숫자여야 합니다.')
            if 'write1h' in candidate and (not isinstance(candidate['write1h'], (int, float)) or not math.isfinite(candidate['write1h']) or not 0 <= candidate['write1h'] <= 1e6):
                parser.error('1시간 캐시 생성 단가가 유효하지 않습니다.')
    data, events = a.collect()
    attach(data, events)
    fx = fx_snapshot(args.fx, args.fetch_fx)
    html = render_html(data, prices, fx)
    output.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(output, 0o700)
    for name, content in [('report.html', html), ('data.json', json.dumps(data, ensure_ascii=False)), ('.gitignore', '*\n')]:
        path = output / name
        with path.open('w', encoding='utf-8') as stream:
            stream.write(content)
        os.chmod(path, 0o600)
    print(json.dumps(dict(report=str(output / 'report.html'), events=len(events), audit=data['audit'], fxSource=fx['source']), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
