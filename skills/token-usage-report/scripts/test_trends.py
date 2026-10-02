import datetime as dt
import json
import unittest
import tempfile
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import analyze as a
from attach_models import attach
from run_report import main, safe_json

GROUPS = ('vendors', 'projects', 'sessions', 'models', 'categories', 'timeline', 'dailyHours', 'hourOfDay')


class TrendsTest(unittest.TestCase):
    def test_codex_missing_cumulative_keeps_distinct_response_ids(self):
        old_home, old_codex_home, old_db, old_sessions, old_events, old_audit = a.HOME, a.CODEX_HOME, a.CODEX_STATE_DB, a.SESSIONS, a.EVENTS, a.AUDIT.copy()
        try:
            with tempfile.TemporaryDirectory() as directory:
                a.HOME, a.CODEX_HOME, a.CODEX_STATE_DB, a.SESSIONS, a.EVENTS = Path(directory), Path(directory) / '.codex', Path(directory) / '.codex/state_5.sqlite', {}, {}
                (a.HOME / '.codex').mkdir()
                rollout = a.HOME / 'fixture.jsonl'
                stamp = dt.datetime.fromtimestamp(a.NOW-1, dt.timezone.utc).isoformat()
                usage = dict(input_tokens=8, cached_input_tokens=3, output_tokens=2, total_tokens=10)
                rows = [dict(timestamp=stamp, type='token_usage_record', payload=dict(response_id='r1', usage=usage)),
                        dict(timestamp=stamp, type='token_usage_record', payload=dict(response_id='r2', usage=usage)),
                        dict(timestamp=stamp, type='event_msg', payload=dict(type='token_count', info=dict(total_token_usage=usage, last_token_usage=usage)))]
                rollout.write_text('\n'.join(json.dumps(r) for r in rows))
                conn = sqlite3.connect(a.HOME / '.codex/state_5.sqlite')
                conn.execute('CREATE TABLE threads (id,cwd,rollout_path,git_branch,title,model,source,model_provider,created_at,updated_at)')
                conn.execute('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)', ('fixture', directory, str(rollout), '', '', 'fixture-model', 'cli', 'fixture', a.NOW-10, a.NOW))
                conn.commit()
                conn.close()
                before = a.AUDIT['codex_response_missing_cumulative']
                a.scan_codex()
                self.assertEqual(sum(e['total'] for e in a.EVENTS.values()), 20)
                self.assertEqual(a.AUDIT['codex_response_missing_cumulative']-before, 2)
        finally:
            a.HOME, a.CODEX_HOME, a.CODEX_STATE_DB, a.SESSIONS, a.EVENTS = old_home, old_codex_home, old_db, old_sessions, old_events
            a.AUDIT.clear()
            a.AUDIT.update(old_audit)

    def test_kst_calendar_boundaries(self):
        stamp = dt.datetime(2026, 9, 30, 15, 10, tzinfo=dt.timezone.utc).timestamp()
        midnight = dt.datetime(2026, 10, 1, tzinfo=a.KST).timestamp()
        self.assertEqual(a.timeline_bucket(stamp, 720), midnight)
        self.assertEqual(a.timeline_bucket(stamp, 8760), midnight)
        previous = midnight - 1
        self.assertEqual(a.timeline_bucket(previous, 8760), dt.datetime(2026, 9, 1, tzinfo=a.KST).timestamp())

    def test_all_dimensions_model_components_and_window_boundaries(self):
        old_now, old_sessions = a.NOW, a.SESSIONS
        try:
            a.NOW = dt.datetime(2026, 10, 2, 12, tzinfo=a.KST).timestamp()
            a.SESSIONS = {'s': dict(id='s', vendor='Claude', project='fixture', task='검토·검증', category='검토·검증')}
            events = [dict(ts=a.NOW-offset, sid='s', vendor='Claude', model=model,
                fresh=2, write=3, cached=5, output=7, total=17)
                for offset, model in [(0, 'a'), (1800, 'b'), (720*3600, 'a'), (8760*3600, 'b'), (8760*3600+1, 'a')]]
            data = attach({'windows': {str(h): a.aggregate(events, h) for h in a.WINDOW_HOURS}}, events)
            for hours, expected in [('1', 34), ('24', 34), ('168', 34), ('720', 51), ('8760', 68)]:
                window = data['windows'][hours]
                for group in GROUPS:
                    self.assertEqual(sum(r['total'] for r in window[group]), expected, (hours, group))
                    for row in window[group]:
                        for field in ('total', 'fresh', 'write', 'cached', 'output'):
                            if field in row:
                                self.assertEqual(sum(m[field] for m in row['modelUsage']), row[field])
                self.assertLessEqual(len(window['timeline']), 13 if hours == '8760' else 100)
            empty = a.aggregate([], 8760)
            self.assertEqual(empty['metadata']['coverage'], 'none')
            self.assertIsNone(empty['metadata']['observedStart'])
            self.assertTrue(all(r['observation'] != 'observed' for r in empty['dailyHours']))
        finally:
            a.NOW, a.SESSIONS = old_now, old_sessions

    def test_generated_report(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'home'
            output = Path(directory) / 'output'
            claude = home / '.claude/projects/fixture/log.jsonl'
            claude.parent.mkdir(parents=True)
            stamp = dt.datetime.now(dt.timezone.utc).isoformat()
            secret = 'PRIVATE_PROMPT_SENTINEL'
            rows = [dict(type='user', sessionId='same-id', cwd='/private/project', message={'content': '개발 ' + secret}),
                    dict(type='assistant', sessionId='same-id', cwd='/private/project', timestamp=stamp,
                         gitBranch='feat/</script><x>', message={'id': 'msg1', 'model': 'claude-opus-4-6', 'usage': {'input_tokens': 8, 'cache_creation_input_tokens': 2, 'cache_read_input_tokens': 5, 'output_tokens': 3}})]
            claude.write_text('\n'.join(json.dumps(r) for r in rows + rows[-1:]))
            codex = home / '.codex/sessions/fixture.jsonl'
            codex.parent.mkdir(parents=True)
            usage = dict(input_tokens=10, cached_input_tokens=5, output_tokens=2, total_tokens=12)
            codex.write_text('\n'.join(json.dumps(r) for r in [
                dict(type='session_meta', payload=dict(id='same-id', cwd='/private/project')),
                dict(type='turn_context', payload=dict(model='gpt-5')),
                dict(type='event_msg', timestamp=stamp, payload=dict(type='token_count', info=dict(total_token_usage=usage, last_token_usage=usage))),
            ]))
            self.assertEqual(main(['--home', str(home), '--output', str(output)]), 0)
            data = json.loads((output / 'data.json').read_text())
            html = (output / 'report.html').read_text()
            self.assertNotIn(secret, html)
            self.assertNotIn('/private/project', html)
            self.assertNotIn('feat/</script>', html)
            self.assertNotIn('<script src=', html)
            self.assertNotIn('<link rel="stylesheet"', html)
            self.assertNotIn('url(fonts/', html)
            self.assertEqual(len(data['windows']['24']['sessions']), 2)
            self.assertEqual(sum(r['total'] for r in data['windows']['24']['vendors']), 30)
            self.assertEqual((output / 'report.html').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(SystemExit):
                main(['--home', str(home), '--output', str(output)])
        self.assertEqual(set(data['windows']), {'1', '24', '168', '720', '8760'})
        for hours, window in data['windows'].items():
            expected = 30
            self.assertEqual(window['events'], 2)
            for group in GROUPS:
                self.assertEqual(sum(r['total'] for r in window[group]), expected, (hours, group))
                for row in window[group]:
                    self.assertEqual(sum(m['total'] for m in row['modelUsage']), row['total'])
            for vendor in ('Claude', 'Codex'):
                n = len([r for r in window['timeline'] if r['vendor'] == vendor])
                if hours == '8760': self.assertLessEqual(n, 13)
                if hours == '720': self.assertLessEqual(n, 31)
        self.assertEqual(data['windows']['720']['metadata']['timelineBucket'], 'day')
        self.assertEqual(data['windows']['8760']['metadata']['timelineBucket'], 'month')

    def test_empty_home_and_invalid_fx(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(main(['--home', directory, '--output', directory + '/out']), 0)
            for rate in ['nan', 'inf', '0', '-1']:
                with self.assertRaises(SystemExit):
                    main(['--home', directory, '--output', directory + '/invalid', '--fx', rate])

    def test_json_roundtrip_and_nonfinite_usage(self):
        value = '</script><img src=x onerror=alert(1)>&'
        self.assertEqual(json.loads(safe_json(value)), value)
        self.assertNotIn('<', safe_json(value))
        for value in [None, [], {'n': float('nan')}, {'n': float('inf')}]:
            self.assertEqual(a.numeric(value, 'n'), 0)

    def test_classification_does_not_match_api_in_rapid(self):
        self.assertEqual(a.task_category('rapid'), '분류 미확정')

    def test_codex_mixed_sources_and_first_request_without_database(self):
        for cumulative in [999, None]:
            with self.subTest(cumulative=cumulative), tempfile.TemporaryDirectory() as directory:
                home = Path(directory)
                log = home / '.codex/sessions/mixed.jsonl'
                log.parent.mkdir(parents=True)
                stamp = dt.datetime.now(dt.timezone.utc).isoformat()
                usage = dict(input_tokens=8, cached_input_tokens=3, output_tokens=2, total_tokens=10)
                rows = [dict(type='session_meta', payload=dict(id='mixed', cwd='/synthetic/neutral')),
                        dict(type='response_item', payload=dict(role='user', content=[dict(type='input_text', text='콘텐츠 영상 제작 PRIVATE_HINT_SENTINEL')]))]
                for index in range(2):
                    rows.append(dict(type='token_usage_record', timestamp=stamp, payload=dict(response_id='r' + str(index), usage=usage, thread_token_usage=dict(total_tokens=cumulative if index else 10))))
                    rows.append(dict(type='event_msg', timestamp=stamp, payload=dict(type='token_count', info=dict(total_token_usage=dict(input_tokens=8*(index+1), output_tokens=2*(index+1), total_tokens=10*(index+1)), last_token_usage=usage))))
                log.write_text('\n'.join(json.dumps(row) for row in rows))
                main(['--home', str(home), '--output', directory + '/out'])
                self.assertEqual(sum(e['total'] for e in a.EVENTS.values()), 20)
                self.assertEqual(a.SESSIONS['codex:mixed']['category'], '콘텐츠 제작')
                self.assertNotIn('PRIVATE_HINT_SENTINEL', (home / 'out/report.html').read_text())

    def test_timestamp_fractional_precision(self):
        base = '2026-10-02T12:00:00'
        for digits in ['1', '12', '123', '1234', '12345', '123456', '123456789']:
            value = a.timestamp(base + '.' + digits + 'Z')
            expected = dt.datetime(2026, 10, 2, 12, 0, 0, int(digits[:6].ljust(6, '0')), tzinfo=dt.timezone.utc).timestamp()
            self.assertEqual(value, expected)

    def test_codex_response_counter_reset_preserves_each_response(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            log = home / '.codex/sessions/reset.jsonl'
            log.parent.mkdir(parents=True)
            rows = [dict(type='session_meta', payload=dict(id='reset', cwd='/synthetic/reset'))]
            for index, (cumulative, amount) in enumerate([(10, 10), (30, 20), (10, 10)]):
                stamp = dt.datetime.fromtimestamp(a.NOW - 10 + index, dt.timezone.utc).isoformat()
                usage = dict(input_tokens=amount, cached_input_tokens=0, output_tokens=0, total_tokens=amount)
                rows.extend([
                    dict(type='token_usage_record', timestamp=stamp, payload=dict(response_id='r' + str(index), usage=usage, thread_token_usage=dict(total_tokens=cumulative))),
                    dict(type='event_msg', timestamp=stamp, payload=dict(type='token_count', info=dict(total_token_usage=dict(input_tokens=cumulative, total_tokens=cumulative), last_token_usage=usage))),
                ])
            log.write_text('\n'.join(json.dumps(row) for row in rows))
            main(['--home', str(home), '--output', directory + '/out'])
            self.assertEqual(sum(e['total'] for e in a.EVENTS.values()), 40)
            self.assertEqual(len(a.EVENTS), 3)


if __name__ == '__main__':
    unittest.main(verbosity=2)
