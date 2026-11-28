#!/usr/bin/env python3
"""Measure mid-conversation full prompt-cache rewrites from Claude Code transcripts.

Reads ~/.claude/projects/*/*.jsonl (interactive `entrypoint: cli` sessions,
main conversation and subagent files), dedupes assistant `usage` by message id,
and reports, for calls whose start falls inside [--since, --until):

  calls         main-conversation API calls that follow another call in the
                same transcript within 55 minutes (cache still alive)
  rewrites      those whose cache_creation is >= half the input and the input
                is >= 50k tokens (the whole prompt was written again)
  cache_write   total cache_creation tokens over those calls
  rewrite_write cache_creation tokens of the rewrite calls

Run the same command over a window before and after a proxy change and compare
the two rates. Prints JSON only; no transcript content.
"""
import argparse
import glob
import json
import os
from datetime import datetime, timezone

GAP_LIMIT_S = 55 * 60
MIN_INPUT = 50_000


def parse_ts(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def calls_in(path):
    seen = set()
    out = []
    interactive = False
    with open(path, errors='replace') as fh:
        for line in fh:
            if '"usage"' not in line and '"entrypoint"' not in line:
                continue
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get('entrypoint') == 'cli':
                interactive = True
            msg = row.get('message') or {}
            usage = msg.get('usage')
            if row.get('type') != 'assistant' or not usage or not row.get('timestamp'):
                continue
            mid = msg.get('id')
            if mid in seen:
                continue
            seen.add(mid)
            cr = usage.get('cache_read_input_tokens') or 0
            cc = usage.get('cache_creation_input_tokens') or 0
            it = usage.get('input_tokens') or 0
            out.append((parse_ts(row['timestamp']), cr, cc, cr + cc + it))
    return out if interactive else []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', required=True, help='ISO time, e.g. 2026-11-27T00:00:00+09:00')
    ap.add_argument('--until', default=None)
    ap.add_argument('--root', default=os.path.expanduser('~/.claude/projects'))
    args = ap.parse_args()
    since = parse_ts(args.since)
    until = parse_ts(args.until) if args.until else datetime.now(timezone.utc).timestamp()
    stats = {k: {'calls': 0, 'rewrites': 0, 'cache_write': 0, 'rewrite_write': 0}
             for k in ('main', 'subagent')}
    files = glob.glob(os.path.join(args.root, '*', '*.jsonl'))
    files += glob.glob(os.path.join(args.root, '*', '*', 'subagents', '*.jsonl'))
    for path in files:
        try:
            if os.path.getmtime(path) < since:
                continue
            calls = sorted(calls_in(path))
        except OSError:
            continue
        kind = 'subagent' if '/subagents/' in path else 'main'
        for prev, cur in zip(calls, calls[1:]):
            ts, _cr, cc, total = cur
            if not (since <= ts < until) or ts - prev[0] > GAP_LIMIT_S:
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
    print(json.dumps({'since': args.since, 'until': args.until, **stats}, indent=2))


if __name__ == '__main__':
    main()
