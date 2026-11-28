"""Self-checks for scripts/cache-rewrite-rate.py (python3 -m unittest)."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / 'scripts' / 'cache-rewrite-rate.py'
SINCE = '2026-01-01T00:00:00+00:00'


def call(ts, model, cc, cr, mid, ttl='1h'):
    split = {'ephemeral_1h_input_tokens': cc if ttl == '1h' else 0,
             'ephemeral_5m_input_tokens': cc if ttl == '5m' else 0}
    return {'type': 'assistant', 'timestamp': ts, 'message': {
        'id': mid, 'model': model,
        'usage': {'input_tokens': 10, 'cache_creation_input_tokens': cc, 'cache_read_input_tokens': cr,
                  'cache_creation': split}}}


def run(root):
    out = subprocess.run([sys.executable, str(SCRIPT), '--since', SINCE, '--root', str(root)],
                         capture_output=True, text=True, check=False)
    return out.returncode, json.loads(out.stdout)


class CacheRewriteRateTest(unittest.TestCase):
    def write(self, root, rows, tail=''):
        d = Path(root) / 'proj'
        d.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps({'entrypoint': 'cli', 'type': 'user'})] + [json.dumps(r) for r in rows]
        (d / 's.jsonl').write_text('\n'.join(lines) + '\n' + tail)

    def test_rewrite_counted_against_same_model_only(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, [
                call('2026-06-01T00:00:00Z', 'A', 1000, 100_000, 'm1'),
                call('2026-06-01T00:01:00Z', 'B', 60_000, 0, 'm2'),       # first B call: excluded
                call('2026-06-01T00:02:00Z', 'A', 90_000, 20_000, 'm3'),  # A rewrite
                call('2026-06-01T00:03:00Z', 'A', 500, 110_000, 'm4'),    # A normal
            ])
            code, out = run(root)
            self.assertEqual(code, 0)
            self.assertEqual(out['main']['calls'], 2)
            self.assertEqual(out['main']['rewrites'], 1)

    def test_five_minute_cache_expiry_is_not_a_rewrite(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, [
                call('2026-06-01T00:00:00Z', 'A', 60_000, 0, 'm1', ttl='5m'),
                call('2026-06-01T00:10:00Z', 'A', 60_000, 0, 'm2', ttl='5m'),  # 10 min later: cache expired
            ])
            code, out = run(root)
            self.assertEqual(code, 0)
            self.assertEqual(out['main']['calls'], 0)

    def test_complete_json_without_newline_is_partial(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, [call('2026-06-01T00:00:00Z', 'A', 1, 1, 'm1')],
                       tail=json.dumps(call('2026-06-01T00:01:00Z', 'A', 1, 1, 'm2')))
            code, out = run(root)
            self.assertEqual(code, 5)
            self.assertEqual(out['partial_tail_lines'], 1)

    def test_call_without_id_or_timestamp_fails(self):
        with tempfile.TemporaryDirectory() as root:
            bad_id = call('2026-06-01T00:00:00Z', 'A', 1, 1, None)
            bad_ts = call('not-a-time', 'A', 1, 1, 'm2')
            self.write(root, [bad_id, bad_ts])
            code, out = run(root)
            self.assertEqual(code, 4)
            self.assertEqual(out['bad_calls'], 2)

    def test_partial_tail_is_reported_as_incomplete(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, [call('2026-06-01T00:00:00Z', 'A', 1, 1, 'm1')], tail='{"usage":')
            code, out = run(root)
            self.assertEqual(code, 5)
            self.assertEqual(out['partial_tail_lines'], 1)

    def test_malformed_complete_line_fails(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, [call('2026-06-01T00:00:00Z', 'A', 1, 1, 'm1')], tail='{"usage":\n')
            code, out = run(root)
            self.assertEqual(code, 4)
            self.assertEqual(out['bad_lines'], 1)

    def test_missing_root_fails(self):
        code, out = run('/nonexistent-transcript-root')
        self.assertEqual(code, 2)
        self.assertIn('error', out)

    @unittest.skipIf(not hasattr(os, 'geteuid') or os.geteuid() == 0, 'needs a non-root POSIX user')
    def test_unreadable_directory_fails(self):
        with tempfile.TemporaryDirectory() as root:
            self.write(root, [call('2026-06-01T00:00:00Z', 'A', 1, 1, 'm1')])
            locked = Path(root) / 'locked'
            locked.mkdir()
            locked.chmod(0)
            try:
                code, out = run(root)
            finally:
                locked.chmod(0o700)
            self.assertEqual(code, 3)
            self.assertEqual(out['dirs_unreadable'], 1)


if __name__ == '__main__':
    unittest.main()
