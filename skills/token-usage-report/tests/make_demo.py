import datetime as dt
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from run_report import main


def generate(root):
    home = root / 'fixture-home'
    claude = home / '.claude/projects/demo/events.jsonl'
    codex = home / '.codex/sessions/demo.jsonl'
    claude.parent.mkdir(parents=True, exist_ok=True)
    codex.parent.mkdir(parents=True, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    claude_rows = []
    codex_rows = [dict(type='session_meta', payload=dict(id='demo-codex', cwd='/synthetic/PRIVATE_PROJECT_SENTINEL', git=dict(branch='feat/demo'))),
                  dict(type='turn_context', payload=dict(model='gpt-6-astra'))]
    total = dict(input_tokens=0, cached_input_tokens=0, output_tokens=0, total_tokens=0)
    for index, hours in enumerate([0.01, 1, 6, 24, 100, 700, 1000, 5000, 8700]):
        stamp = (now - dt.timedelta(hours=hours)).isoformat()
        claude_rows.append(dict(type='assistant', timestamp=stamp, sessionId='demo-claude', cwd='/synthetic/PRIVATE_PROJECT_SENTINEL',
            gitBranch='feat/demo', message=dict(id='msg-' + str(index), model='claude-opus-5-5',
            usage=dict(input_tokens=1000, cache_creation_input_tokens=2000, cache_read_input_tokens=5000, output_tokens=1000))))
    for index, hours in enumerate([8700, 5000, 1000, 700, 100, 24, 6, 1, 0.01]):
        usage = dict(input_tokens=12000, cached_input_tokens=8000, output_tokens=1000, total_tokens=13000)
        total = {key: value + usage[key] for key, value in total.items()}
        codex_rows.append(dict(type='event_msg', timestamp=(now - dt.timedelta(hours=hours)).isoformat(),
            payload=dict(type='token_count', info=dict(total_token_usage=total.copy(), last_token_usage=usage))))
    claude.write_text('\n'.join(json.dumps(row) for row in claude_rows), encoding='utf-8')
    codex.write_text('\n'.join(json.dumps(row) for row in codex_rows), encoding='utf-8')
    return main(['--home', str(home), '--output', str(root / 'report')])


if __name__ == '__main__':
    raise SystemExit(generate(Path(sys.argv[1]).resolve()))
