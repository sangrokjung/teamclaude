import datetime as dt
from analyze import timeline_bucket

FIELDS = ('fresh', 'write', 'cached', 'output', 'total')

def attach(data, events):
    for w in data['windows'].values():
        indexes = {group: {} for group in ('vendors', 'projects', 'sessions', 'models', 'categories', 'timeline', 'dailyHours', 'hourOfDay')}
        for group, idx in indexes.items():
            for r in w[group]:
                r['modelUsage'] = {}
                key = {'vendors': (r['vendor'],), 'projects': (r['vendor'], r.get('project')),
                       'sessions': (r.get('id'),), 'models': (r['vendor'], r.get('model')),
                       'categories': (r['vendor'], r.get('category')), 'timeline': (r['vendor'], r.get('ts')),
                       'dailyHours': (r['vendor'], r.get('date'), r.get('hour')), 'hourOfDay': (r['vendor'], r.get('hour'))}[group]
                idx[key] = r
        for e in events:
            if not w['start'] <= e['ts'] <= w['end']: continue
            s = indexes['sessions'][(e['sid'],)]
            local = dt.datetime.fromtimestamp(e['ts'], dt.timezone(dt.timedelta(hours=9)))
            keys = {'vendors': (e['vendor'],), 'projects': (e['vendor'], s['project']),
                    'sessions': (e['sid'],), 'models': (e['vendor'], e['model']),
                    'categories': (e['vendor'], s.get('category', s['task'])),
                    'timeline': (e['vendor'], timeline_bucket(e['ts'], w['hours'])),
                    'dailyHours': (e['vendor'], local.date().isoformat(), local.hour),
                    'hourOfDay': (e['vendor'], local.hour)}
            for group, key in keys.items():
                row = indexes[group][key]
                usage = row['modelUsage'].setdefault(e['model'], dict(model=e['model'], vendor=e['vendor'], **dict.fromkeys(FIELDS, 0)))
                for field in FIELDS: usage[field] += e[field]
        for group in indexes:
            for row in w[group]:
                row['modelUsage'] = list(row['modelUsage'].values())
                for usage in row['modelUsage']:
                    assert sum(usage[field] for field in ('fresh', 'write', 'cached', 'output')) == usage['total'], (group, usage)
                for field in FIELDS:
                    if field in row:
                        assert sum(x[field] for x in row['modelUsage']) == row[field], (group, field, row)
                if 'noncached' in row:
                    assert sum(x['total']-x['cached'] for x in row['modelUsage']) == row['noncached'], (group, row)
    return data
