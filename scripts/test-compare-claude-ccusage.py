import datetime as dt
from contextlib import closing
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).with_name('compare-claude-ccusage.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CurrentProjectionComparison(unittest.TestCase):
    def setUp(self):
        self.owned = tempfile.TemporaryDirectory(prefix='tokenelo-count-audit-')
        self.addCleanup(self.owned.cleanup)
        self.root = Path(self.owned.name)
        self.database = self.root / 'owned.sqlite'
        self.report = self.root / 'ccusage.json'
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.executescript('''CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('schema_version','10');
                CREATE TABLE event_projection_basis(singleton INTEGER, policy INTEGER); INSERT INTO event_projection_basis VALUES(1,7);
                CREATE TABLE event_projection(id TEXT, source TEXT, ts INTEGER, input_fresh INTEGER, cache_write_5m INTEGER,
                    cache_write_1h INTEGER, cache_write_unassigned INTEGER, cache_read INTEGER, output INTEGER, count_quality TEXT);
                CREATE TABLE events AS SELECT * FROM event_projection;''')
        self.native = {'date': '2026-10-12', 'inputTokens': 2, 'cacheCreationTokens': 10, 'cacheReadTokens': 30, 'outputTokens': 11, 'totalTokens': 53}
        self.save_report()
        self.insert('fixture', 1791784800000, 2, 3, 5, 2, 30, 11)

    def save_report(self, rows=None):
        self.report.write_text(json.dumps({'daily': rows if rows is not None else [self.native]}))

    def insert(self, identity, ts, *counts):
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.execute('INSERT INTO event_projection VALUES(?,?,?,?,?,?,?,?,?,?)', (identity, 'claude', ts, *counts, 'complete'))

    def check(self, first='2026-10-12', last='2026-10-12', timezone='America/Denver'):
        return module.compare(self.database, self.report, first, last, timezone)

    def test_uses_current_projection_even_when_historical_basis_differs(self):
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.execute("INSERT INTO events VALUES('old','claude',1791784800000,2,3,5,2,30,1,'complete')")
        before = hashlib.sha256(self.database.read_bytes()).hexdigest()
        self.assertTrue(self.check()['allDailyAllCategoriesExact'])
        self.assertEqual(before, hashlib.sha256(self.database.read_bytes()).hexdigest())

    def test_future_projection_policy_is_refused(self):
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.execute('UPDATE event_projection_basis SET policy=8')
        with self.assertRaisesRegex(ValueError, 'projection-policy'):
            self.check()

    def test_foreign_schema_is_refused(self):
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.execute("UPDATE meta SET value='9'")
        with self.assertRaisesRegex(ValueError, 'schema-version'):
            self.check()

    def test_duplicate_independent_days_are_refused(self):
        self.save_report([self.native, self.native])
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            self.check()

    def test_independent_reasoning_cannot_be_added_twice_to_total(self):
        self.native['totalTokens'] += 4
        self.save_report()
        with self.assertRaisesRegex(ValueError, 'incoherent'):
            self.check()

    def test_null_negative_and_unsafe_counts_are_refused(self):
        for value in (None, -1, 2**53):
            with self.subTest(value=value):
                with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
                    c.execute('UPDATE event_projection SET output=?', (value,))
                with self.assertRaisesRegex(ValueError, 'count'):
                    self.check()

    def test_timezone_boundaries_are_start_inclusive_end_exclusive(self):
        self.insert('before', 1791784799999, 1, 0, 0, 0, 0, 0)
        self.insert('after', 1791871200000, 1, 0, 0, 0, 0, 0)
        self.assertEqual(self.check()['selectedRows'], 1)

    def test_dst_transition_uses_calendar_days(self):
        self.save_report([])
        result = self.check('2026-03-08', '2026-03-08')
        self.assertEqual(result['endExclusiveMs'] - result['startInclusiveMs'], 23 * 3600000)

    def test_empty_days_are_not_capture_acceptance(self):
        result = self.check('2026-10-11', '2026-10-12')
        self.assertEqual(result['calendarDays'], 2)
        self.assertTrue(result['dailyComparisons'][0]['emptyBoth'])
        self.assertFalse(result['independentInputSnapshotValidatedByThisScript'])
        self.assertFalse(result['captureCompletenessEstablished'])
        self.assertEqual(result['independentReportedDays'], 1)
        self.assertEqual(result['independentOmittedDays'], 1)
        self.assertFalse(result['dailyComparisons'][0]['ccusageDatePresent'])
        self.assertTrue(result['dailyComparisons'][0]['ccusageZeroDerivedFromOmission'])

    def test_explicit_zero_and_omitted_independent_days_remain_distinct(self):
        zero = dict.fromkeys(module.REPORTED, 0)
        zero['date'] = '2026-10-11'
        self.save_report([zero, self.native])
        result = self.check('2026-10-10', '2026-10-12')
        omitted, explicit, populated = result['dailyComparisons']
        self.assertTrue(omitted['emptyBoth'])
        self.assertTrue(omitted['ccusageZeroDerivedFromOmission'])
        self.assertFalse(omitted['ccusageDatePresent'])
        self.assertTrue(explicit['emptyBoth'])
        self.assertFalse(explicit['ccusageZeroDerivedFromOmission'])
        self.assertTrue(explicit['ccusageDatePresent'])
        self.assertTrue(populated['ccusageDatePresent'])
        self.assertEqual(result['independentReportedDays'], 2)
        self.assertEqual(result['independentOmittedDays'], 1)

    def test_projection_activity_on_omitted_reference_day_is_not_a_match(self):
        self.save_report([])
        result = self.check()
        row = result['dailyComparisons'][0]
        self.assertTrue(row['ccusageZeroDerivedFromOmission'])
        self.assertFalse(row['emptyBoth'])
        self.assertIsNone(row['comparison']['totalTokens']['absolutePercentOfCcusage'])
        self.assertFalse(result['allDailyTotalsWithinOnePercent'])

    def test_large_output_difference_remains_visible_despite_total_tolerance(self):
        self.native.update(cacheReadTokens=100000, outputTokens=21, totalTokens=100033)
        self.save_report()
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.execute('UPDATE event_projection SET cache_read=100000')
        result = self.check()
        self.assertTrue(result['allDailyTotalsWithinOnePercent'])
        self.assertFalse(result['allDailyAllCategoriesExact'])
        self.assertEqual(result['dailyComparisons'][0]['comparison']['outputTokens']['delta'], -10)

    def invoke(self):
        return subprocess.run([sys.executable, str(Path(__file__).with_name('compare-claude-ccusage.py')),
            '--database', str(self.database), '--ccusage-report', str(self.report),
            '--first', '2026-10-12', '--last', '2026-10-12', '--timezone', 'America/Denver'],
            capture_output=True, timeout=10)

    def test_cli_refuses_unknown_legacy_counts_with_a_safe_specific_code(self):
        with closing(sqlite3.connect(self.database, isolation_level=None)) as c:
            c.execute('UPDATE event_projection SET cache_write_unassigned=NULL')
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)['errorCode'], 'missing-invalid-or-unsafe-count')

    def test_cli_does_not_echo_malformed_input_content(self):
        sentinel = 'private fixture text must never be echoed'
        self.report.write_text(sentinel)
        result = self.invoke()
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(sentinel.encode(), result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['errorCode'], 'invalid-or-unavailable-input')


if __name__ == '__main__':
    unittest.main()
