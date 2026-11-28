#!/usr/bin/env python3
"""Measure mid-conversation full prompt-cache rewrites from Claude Code transcripts.

Reads ~/.claude/projects/**.jsonl (interactive `entrypoint: cli` transcripts:
main conversations and subagent files), dedupes assistant `usage` by message
id, and reports, for calls whose start falls inside [--since, --until):

  calls         API calls that follow an earlier call of the SAME model in the
                same transcript while that model's cache is still alive: within
                90% of the TTL the previous call wrote with (1 h or 5 min, from
                usage.cache_creation.ephemeral_1h/5m_input_tokens). When the
                TTL is unknown, 55 minutes is assumed and the call is counted in
                ttl_unknown_calls. The first call of each model is excluded: it
                has no cache to lose.
  rewrites      those whose cache_creation is >= half the input and the input
                is >= 50k tokens (the whole prompt was written again)
  cache_write   total cache_creation tokens over those calls
  rewrite_write cache_creation tokens of the rewrite calls

Run the same command over a window before and after a proxy change and compare
the two rates. Prints JSON only; no transcript content.

Completeness: the output reports files_scanned, files_unreadable,
dirs_unreadable, bad_lines, bad_calls and partial_tail_lines. Exit codes:
0 complete, 2 root missing or nothing scanned, 3 a file or directory could not
be read, 4 a malformed complete line or an assistant call without a valid id /
timestamp was found, 5 only an unterminated last line (a live session
mid-write) was seen. Any non-zero result is an
incomplete measurement: compare windows that are closed (until in the past),
or re-run until it exits 0.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

DEFAULT_GAP_S = 55 * 60
TTL_SAFETY = 0.9
TTL_1H_S = 3600
TTL_5M_S = 300
MIN_INPUT = 50_000


def parse_ts(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def calls_in(path, counters):
    """(timestamp, model, cache_creation, input_total, ttl_s|None) per deduped assistant call."""
    seen = set()
    out = []
    interactive = False
    with open(path, 'rb') as fh:  # streamed line by line: memory stays per-line
        for raw in fh:
            if not raw.endswith(b'\n'):
                # Only the last line can lack its newline: a live session
                # mid-write. Even if it parses, it may not be complete.
                if raw.strip():
                    counters['partial_tail_lines'] += 1
                continue
            if not raw.strip():
                continue
            try:
                row = json.loads(raw)
            except ValueError:
                counters['bad_lines'] += 1
                continue
            if not isinstance(row, dict):
                counters['bad_lines'] += 1
                continue
            interactive = interactive or row.get('entrypoint') == 'cli'
            call = assistant_call(row, seen, counters)
            if call:
                out.append(call)
    return out if interactive else []


def assistant_call(row, seen, counters):
    msg = row.get('message')
    usage = msg.get('usage') if isinstance(msg, dict) else None
    if row.get('type') != 'assistant' or not isinstance(usage, dict):
        return None
    mid = msg.get('id')
    try:
        ts = parse_ts(row['timestamp'])
    except (KeyError, TypeError, ValueError, AttributeError):
        ts = None
    if not isinstance(mid, str) or not mid or ts is None:
        counters['bad_calls'] += 1  # cannot be deduped or ordered: incomplete
        return None
    if mid in seen:
        return None
    seen.add(mid)
    cr = usage.get('cache_read_input_tokens') or 0
    cc = usage.get('cache_creation_input_tokens') or 0
    it = usage.get('input_tokens') or 0
    return (ts, msg.get('model'), cc, cr + cc + it, written_ttl_s(usage))


def written_ttl_s(usage):
    """TTL the call wrote its cache with, or None when unknown / nothing written."""
    split = usage.get('cache_creation')
    if not isinstance(split, dict):
        return None
    if (split.get('ephemeral_1h_input_tokens') or 0) > 0:
        return TTL_1H_S
    if (split.get('ephemeral_5m_input_tokens') or 0) > 0:
        return TTL_5M_S
    return None


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
                'bad_lines': 0, 'bad_calls': 0, 'partial_tail_lines': 0, 'ttl_unknown_calls': 0}
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
        last_by_model = {}  # model -> (last call ts, TTL of the cache it relies on)
        for ts, model, cc, total, ttl in calls:
            prev = last_by_model.get(model)
            prev_ts, prev_ttl = prev if prev else (None, None)
            last_by_model[model] = (ts, ttl if ttl is not None else prev_ttl)
            if prev_ts is None or not (since <= ts < until):
                continue
            gap_limit = prev_ttl * TTL_SAFETY if prev_ttl else DEFAULT_GAP_S
            if ts - prev_ts > gap_limit:
                continue
            if prev_ttl is None:
                counters['ttl_unknown_calls'] += 1
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
    if counters['bad_lines'] or counters['bad_calls']:
        return 4
    if counters['partial_tail_lines']:
        return 5
    return 0


if __name__ == '__main__':
    sys.exit(main())
