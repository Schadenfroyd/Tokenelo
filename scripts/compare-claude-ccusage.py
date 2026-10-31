"""Read-only, count-only comparison; no production collector/pricing imports."""
from pathlib import Path
import argparse
import collections
import datetime as dt
import hashlib
import json
import sqlite3
from zoneinfo import ZoneInfo

FIELDS = ('input_fresh', 'cache_write_5m', 'cache_write_1h', 'cache_write_unassigned', 'cache_read', 'output')
REPORTED = ('inputTokens', 'cacheCreationTokens', 'cacheReadTokens', 'outputTokens', 'totalTokens')


def count(value):
    if type(value) is not int or value < 0 or value > 2**53 - 1:
        raise ValueError('missing-invalid-or-unsafe-count')
    return value


def compare(database, independent_report, first, last, timezone):
    first, last = dt.date.fromisoformat(first), dt.date.fromisoformat(last)
    if first > last:
        raise ValueError('reversed-date-range')
    zone = ZoneInfo(timezone)
    start = int(dt.datetime.combine(first, dt.time(), zone).timestamp() * 1000)
    end = int(dt.datetime.combine(last + dt.timedelta(days=1), dt.time(), zone).timestamp() * 1000)
    raw = Path(independent_report).read_bytes()
    report = json.loads(raw)
    if not isinstance(report, dict) or not isinstance(report.get('daily'), list):
        raise ValueError('daily-report-required')
    reference = {}
    for row in report['daily']:
        if not isinstance(row, dict):
            raise ValueError('invalid-daily-row')
        day = row.get('date')
        parsed = dt.date.fromisoformat(day)
        if day != parsed.isoformat() or not first <= parsed <= last or day in reference:
            raise ValueError('duplicate-or-out-of-range-date')
        reference[day] = {key: count(row.get(key)) for key in REPORTED}
        if sum(reference[day][key] for key in REPORTED[:-1]) != reference[day]['totalTokens']:
            raise ValueError('incoherent-independent-total')

    conn = sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=5)
    try:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        if conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() != ('10',):
            raise ValueError('unsupported-schema-version')
        if conn.execute('SELECT policy FROM event_projection_basis WHERE singleton=1').fetchone() != (7,):
            raise ValueError('unsupported-projection-policy')
        if conn.execute("SELECT type FROM sqlite_master WHERE name='event_projection'").fetchone() != ('table',):
            raise ValueError('current-physical-projection-required')
        days, qualities, commitment, rows = {}, collections.Counter(), hashlib.sha256(), 0
        sql = 'SELECT id,ts,' + ','.join(FIELDS) + ",count_quality FROM main.event_projection WHERE source='claude' AND ts>=? AND ts<? ORDER BY id"
        for row in conn.execute(sql, (start, end)):
            rows += 1
            commitment.update((json.dumps(row, separators=(',', ':')) + '\n').encode())
            day = dt.datetime.fromtimestamp(row[1] / 1000, zone).date().isoformat()
            totals = days.setdefault(day, dict.fromkeys(FIELDS, 0))
            qualities[str(row[-1])] += 1
            for key, value in zip(FIELDS, row[2:-1]):
                totals[key] = count(totals[key] + count(value))
        conn.rollback()
    finally:
        conn.close()

    daily = []
    for offset in range((last - first).days + 1):
        date = (first + dt.timedelta(days=offset)).isoformat()
        quantities = days.get(date, dict.fromkeys(FIELDS, 0))
        values = dict(zip(REPORTED[:-1], (quantities['input_fresh'],
            sum(quantities[k] for k in ('cache_write_5m', 'cache_write_1h', 'cache_write_unassigned')),
            quantities['cache_read'], quantities['output'])))
        values['totalTokens'] = count(sum(values.values()))
        native = reference.get(date, dict.fromkeys(REPORTED, 0))
        comparisons = {}
        for key in REPORTED:
            delta = values[key] - native[key]
            percent = abs(delta) / native[key] * 100 if native[key] else 0 if values[key] == 0 else None
            comparisons[key] = {'currentProjection': values[key], 'ccusage': native[key], 'delta': delta,
                'absolutePercentOfCcusage': percent, 'withinOnePercent': percent is not None and percent <= 1}
        daily.append({'date': date, 'ccusageDatePresent': date in reference,
            'ccusageZeroDerivedFromOmission': date not in reference,
            'emptyBoth': values['totalTokens'] == native['totalTokens'] == 0, 'comparison': comparisons})
    return {'firstInclusiveDate': first.isoformat(), 'lastInclusiveDate': last.isoformat(), 'timezone': timezone,
        'startInclusiveMs': start, 'endExclusiveMs': end, 'schemaVersion': 10, 'projectionPolicy': 7,
        'physicalCurrentTable': 'main.event_projection', 'selectedRows': rows, 'countQualityRows': dict(qualities),
        'selectedCountProjectionSha256': commitment.hexdigest(), 'ccusageReportSha256': hashlib.sha256(raw).hexdigest(),
        'calendarDays': len(daily), 'nonemptyDays': sum(not x['emptyBoth'] for x in daily),
        'independentReportedDays': len(reference), 'independentOmittedDays': len(daily) - len(reference),
        'referenceOmissionRule': 'Missing daily records are represented as zero for comparison arithmetic only; omission does not establish zero activity or complete capture.',
        'allDailyTotalsWithinOnePercent': all(x['comparison']['totalTokens']['withinOnePercent'] for x in daily),
        'allDailyAllCategoriesExact': all(c['delta'] == 0 for x in daily for c in x['comparison'].values()),
        'dailyComparisons': daily, 'independentInputSnapshotValidatedByThisScript': False,
        'captureCompletenessEstablished': False,
        'scope': 'Finite current-projection aggregate comparison. Source roots/range/timezone and input immutability must be independently bound. Count quality is retained; pricing, capture freshness, UI and full acceptance are not established.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('database', 'ccusage-report', 'first', 'last', 'timezone'):
        parser.add_argument('--' + flag, required=True)
    args = parser.parse_args()
    try:
        result = compare(args.database, args.ccusage_report, args.first, args.last, args.timezone)
    except (ValueError, TypeError, KeyError, OverflowError, sqlite3.Error, OSError) as error:
        safe_codes = {'missing-invalid-or-unsafe-count', 'reversed-date-range', 'daily-report-required',
            'invalid-daily-row', 'duplicate-or-out-of-range-date', 'incoherent-independent-total',
            'unsupported-schema-version', 'unsupported-projection-policy', 'current-physical-projection-required'}
        code = str(error) if isinstance(error, ValueError) and str(error) in safe_codes else 'invalid-or-unavailable-input'
        print(json.dumps({'errorType': type(error).__name__, 'errorCode': code, 'comparisonAccepted': False}))
        raise SystemExit(2)
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result['allDailyTotalsWithinOnePercent'] else 1)
