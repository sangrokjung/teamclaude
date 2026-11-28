#!/usr/bin/env python3
"""Measure mid-conversation full prompt-cache rewrites from Claude Code transcripts.

Reads ~/.claude/projects/**.jsonl (interactive `entrypoint: cli` transcripts:
main conversations and subagent files), dedupes assistant `usage` by message
id, and reports, for calls whose start falls inside [--since, --until):

  calls         API calls that follow an earlier call of the SAME model in the
                same transcript within 55 minutes (that model's cache is still
                alive). The first call of each model is excluded: it has no
                cache to lose.
  rewrites      those whose cache_creation is >= half the input and the input
                is >= 50k tokens (the whole prompt was written again)
  cache_write   total cache_creation tokens over those calls
  rewrite_write cache_creation tokens of the rewrite calls

Run the same command over a window before and after a proxy change and compare
the two rates. Prints JSON only; no transcript content.

Completeness: the output reports files_scanned, files_unreadable,
dirs_unreadable, bad_lines and partial_tail_lines. An unterminated last line of
a file (a live session mid-write) is expected and only counted. Exit codes:
0 complete, 2 root missing or nothing scanned, 3 a file or directory could not
be read, 4 a malformed complete line was found. Any non-zero result is an
incomplete measurement and must not be compared as if it were clean.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

GAP_LIMIT_S = 55 * 60
MIN_INPUT = 50_000


def parse_ts(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def calls_in(path, counters):
    """(timestamp, model, cache_creation, input_total) per deduped assistant call."""
    seen = set()
    out = []
    interactive = False
    with open(path, 'rb') as fh:
        data = fh.read()
    lines = data.split(b'\n')
    terminated = data.endswith(b'\n')
    for n, raw in enumerate(lines):
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except ValueError:
            if n == len(lines) - 1 and not terminated:
                counters['partial_tail_lines'] += 1
            else:
                counters['bad_lines'] += 1
            continue
        if not isinstance(row, dict):
            counters['bad_lines'] += 1
            continue
        if row.get('entrypoint') == 'cli':
            interactive = True
        msg = row.get('message') or {}
        usage = msg.get('usage') if isinstance(msg, dict) else None
        if row.get('type') != 'assistant' or not usage or not row.get('timestamp'):
            continue
        mid = msg.get('id')
        if mid in seen:
            continue
        seen.add(mid)
        cr = usage.get('cache_read_input_tokens') or 0
        cc = usage.get('cache_creation_input_tokens') or 0
        it = usage.get('input_tokens') or 0
        out.append((parse_ts(row['timestamp']), msg.get('model'), cc, cr + cc + it))
    return out if interactive else []


def transcript_files(root, counters):
    def onerror(_err):
        counters['dirs_unreadable'] += 1
    for dirpath, _dirs, names in os.walk(root, onerror=onerror):
        for name in names:
            if name.endswith('.jsonl'):
                yield os.path.join(dirpath, name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True, help='ISO time, e.g. 2026-11-27T00:00:00+09:00')
    ap.add_argument('--until', default=None)
    ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
    args = ap.parse_args()
    since = parse_ts(args.since)
    until = parse_ts(args.until) if args.until else datetime.now(timezone.utc).timestamp()
    if not os.path.isdir(args.root):
        print(json.dumps({'error': f'transcript root not found: {args.root}'}))
        return 2
    counters = {'files_scanned': 0, 'files_unreadable': 0, 'dirs_unreadable': 0,
                'bad_lines': 0, 'partial_tail_lines': 0}
    stats = {k: {'calls': 0, 'rewrites': 0, 'cache_write': 0, 'rewrite_write': 0}
             for k in ('main', 'subagent')}
    for path in transcript_files(args.root, counters):
        try:
            if os.path.getmtime(path) < since:
                continue
            calls = sorted(calls_in(path, counters), key=lambda c: c[0])
        except OSError:
            counters['files_unreadable'] += 1
            continue
        counters['files_scanned'] += 1
        kind = 'subagent' if f'{os.sep}subagents{os.sep}' in path else 'main'
        last_by_model = {}
        for ts, model, cc, total in calls:
            prev = last_by_model.get(model)
            last_by_model[model] = ts
            if prev is None or ts - prev > GAP_LIMIT_S or not (since <= ts < until):
                continue
            s = stats[kind]
            s['calls'] += 1
            s['cache_write'] += cc
            if total >= MIN_INPUT and cc * 2 >= total:
                s['rewrites'] += 1
                s['rewrite_write'] += cc
    for s in stats.values():
        s['rewrite_rate'] = round(s['rewrites'] / s['calls'], 4) if s['calls'] else None
        s['rewrite_write_share'] = round(s['rewrite_write'] / s['cache_write'], 4) if s['cache_write'] else None
    print(json.dumps({'since': args.since, 'until': args.until, **counters, **stats}, indent=2))
    if counters['files_scanned'] == 0:
        return 2
    if counters['files_unreadable'] or counters['dirs_unreadable']:
        return 3
    if counters['bad_lines']:
        return 4
    return 0


if __name__ == '__main__':
    sys.exit(main())
