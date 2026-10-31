"""Standalone tests for scripts/comparator-formats.py (not part of Vitest).

Run:  python3 -I -B scripts/test-comparator-formats.py
Everything here is synthetic. Hand arithmetic in the assertions is independent of the code under test;
golden fixture bytes are additionally compared so that serialization drift is caught.
"""
import sys

sys.dont_write_bytecode = True

import copy
import importlib.util
import json
import re
import sqlite3
import subprocess
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / 'scripts' / 'comparator-formats.py'
FIX = ROOT / 'test' / 'fixtures' / 'comparator-formats-2026-10-18'
CASES = FIX / 'cases'


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cf = load_module('comparator_formats', SCRIPT)
FormatError = cf.FormatError
T = cf.parse_timestamp
EXPECTED_CASES = sorted([
    'legacy-comparator-output', 'n01-native-iterations-shared-request', 'n02-native-snapshots-incomparable',
    'n03-native-requestless-messages', 'n03d-requestless-vendor-double-count', 'n04-native-resumed-session',
    'n05-native-cache-ttl-split', 'n06-native-missing-vs-zero-vs-invalid', 'n07-local-engine-counters',
    'v01-vendor-exact-match', 'v02-vendor-missing-vs-zero', 'v03-vendor-totals-equal-components-differ',
    'v04-vendor-partial-day'])
TZ = '-06:00'


# --------------------------------------------------------------------------------------- builders
def ledger(rows, **extra):
    doc = {'kind': 'tokenelo-event-projection', 'schema_version': 10, 'projection_policy': 7, 'rows': rows}
    doc.update(extra)
    return doc


def row(rid, ts, inp, w5, w1, un, rd, out, q='complete', reasoning=0, assumed=None, source='claude'):
    return {'id': rid, 'source': source, 'ts': T(ts), 'input_fresh': inp, 'cache_write_5m': w5,
            'cache_write_1h': w1, 'cache_write_unassigned': un, 'cache_write_assumed_1h': assumed,
            'cache_read': rd, 'output': out, 'reasoning': reasoning, 'count_quality': q}


def usage(inp=None, cc=None, cr=None, out=None, five=None, hour=None, **extra):
    u = {}
    for key, value in (('input_tokens', inp), ('cache_creation_input_tokens', cc),
                       ('cache_read_input_tokens', cr), ('output_tokens', out)):
        if value is not None:
            u[key] = value
    if five is not None or hour is not None:
        u['cache_creation'] = {}
        if five is not None:
            u['cache_creation']['ephemeral_5m_input_tokens'] = five
        if hour is not None:
            u['cache_creation']['ephemeral_1h_input_tokens'] = hour
    u.update(extra)
    return u


def line(ts, message_id, usage_, request='fab-req', session='fab-sess', uuid='fab-uuid', model='model-b'):
    message = {'model': model, 'role': 'assistant', 'usage': usage_}
    if message_id is not None:
        message['id'] = message_id
    out = {'type': 'assistant', 'timestamp': ts, 'sessionId': session, 'uuid': uuid, 'message': message}
    if request is not None:
        out['requestId'] = request
    return out


def native(lines):
    return {'kind': 'claude-native-lines', 'lines': lines}


def norm_native(lines, tz=TZ):
    return cf.normalize_native_lines(native(lines), 'fab-native', tz)


def one(cohort):
    assert len(cohort['records']) == 1, len(cohort['records'])
    return cohort['records'][0]


def pv(record, name):
    c = record['components'][name]
    return [c['presence'], c['value']]


def ccu(date, **fields):
    d = {'date': date}
    d.update(fields)
    return d


def full_day(date, inp, cc, cr, out):
    return ccu(date, inputTokens=inp, cacheCreationTokens=cc, cacheReadTokens=cr, outputTokens=out,
               totalTokens=inp + cc + cr + out)


def vendor(days, tz=TZ):
    return cf.normalize_ccusage_daily({'daily': days}, 'fab-ccusage', tz)


def golden_record():
    return copy.deepcopy(cf.load_json_file(CASES / 'n01-native-iterations-shared-request' / 'b.cohort.json')['records'][0])


def cohort_with(records, **over):
    base = cf.make_cohort('fab-test', 'message', records[0]['source'], TZ, None, records, {})
    base.update(over)
    return base


# --------------------------------------------------------------------------------------- tests
class Serialization(unittest.TestCase):
    def test_canonical_form_is_exact(self):
        value = {'b': [1, 2], 'a': {'x': 1, 'y': [{'p': 1}]}, 'c': {'q': None, 'r': True}, 'e': {}, 'f': [],
                 'g': 'café'}
        expected = ('{\n  "a": {\n    "x": 1,\n    "y": [\n      {"p": 1}\n    ]\n  },\n  "b": [1, 2],\n'
                    '  "c": {"q": null, "r": true},\n  "e": {},\n  "f": [],\n  "g": "caf\\u00e9"\n}\n')
        self.assertEqual(cf.dumps(value), expected)
        self.assertEqual(cf.dumps(value).encode('utf-8'), expected.encode('utf-8'))

    def test_floats_and_nan_are_refused_at_serialization(self):
        for bad in (1.0, 0.5, float('nan'), float('inf')):
            with self.subTest(bad=bad):
                with self.assertRaises(FormatError) as caught:
                    cf.dumps({'v': [bad]})
                self.assertEqual(caught.exception.code, 'non-integer-number')

    def test_strict_parse_refuses_duplicate_keys_constants_and_garbage(self):
        for text, code in (('{"a": 1, "a": 2}', 'duplicate-json-key'), ('{"a": NaN}', 'invalid-json-constant'),
                           ('{"a": Infinity}', 'invalid-json-constant'), ('{', 'invalid-json'), ('', 'invalid-json')):
            with self.subTest(text=text):
                with self.assertRaises(FormatError) as caught:
                    cf.parse_json(text)
                self.assertEqual(caught.exception.code, code)
        self.assertEqual(cf.parse_json('{"a": [1, {"b": null}]}'), {'a': [1, {'b': None}]})

    def test_percent_rounding_is_exact_half_up(self):
        # unit = 1e-6 percent of the reference
        for delta, reference, want in ((1, 3, 33333333), (-1, 3, 33333333), (2, 3, 66666667), (10, 8, 125000000),
                                       (1, 200000000, 1), (1, 400000000, 0), (3, 400000000, 1), (0, 7, 0),
                                       (1169, 100000, 1169000)):
            with self.subTest(delta=delta, reference=reference):
                self.assertEqual(cf.percent_micro(delta, reference), want)


class SchemaValidator(unittest.TestCase):
    def test_schemas_load_and_use_only_the_supported_keyword_subset(self):
        schemas = cf.load_schemas()
        self.assertEqual(sorted(schemas), ['cohort', 'comparison-result', 'count-record'])
        for schema in schemas.values():
            self.assertEqual(schema['$schema'], 'https://json-schema.org/draft/2020-12/schema')
        broken = copy.deepcopy(schemas['count-record'])
        broken['$defs']['count']['multipleOf'] = 1
        with self.assertRaises(FormatError) as caught:
            cf._check_keywords(broken)
        self.assertEqual(caught.exception.code, 'unsupported-schema-keyword')

    def test_every_golden_cohort_and_result_validates(self):
        count = 0
        for case in sorted(CASES.iterdir()):
            for name, kind in (('a.cohort.json', 'cohort'), ('b.cohort.json', 'cohort'), ('result.json', 'result')):
                with self.subTest(case=case.name, file=name):
                    document = cf.load_json_file(case / name)
                    self.assertEqual({'cohort': cf.validate_cohort, 'result': cf.validate_result}[kind](document), [])
                    count += 1
        self.assertEqual(count, 3 * len(EXPECTED_CASES))

    def test_counts_must_be_safe_nonnegative_json_integers(self):
        self.assertEqual(cf.validate_record(golden_record()), [])
        for bad in (1.0, 1.5, True, False, -1, 2 ** 53, '5', [5], None):
            with self.subTest(bad=bad):
                record = golden_record()
                record['components']['input_fresh']['value'] = bad
                self.assertTrue(cf.validate_record(record))
        # the largest safe integer passes the schema; only the (now wrong) stated total is refused
        record = golden_record()
        record['components']['input_fresh']['value'] = 2 ** 53 - 1
        record['components']['input_fresh']['coverage']['resolved_subtotal'] = 2 ** 53 - 1
        self.assertEqual(cf.validate_record(record), ['/total: recomputation'])

    def test_presence_and_value_must_agree(self):
        mutations = {
            'measured with null value': ('input_fresh', {'value': None}),
            'measured with zero value': ('input_fresh', {'value': 0}),
            'measured_zero with positive value': ('cache_write_1h', {'value': 1}),
            'missing with a value': ('reasoning', {'value': 3}),
            'missing without reason': ('reasoning', {'reason': None}),
            'invalid with a value': ('reasoning', {'presence': 'invalid', 'value': 0}),
            'not_applicable with a value': ('reasoning', {'presence': 'not_applicable', 'value': 0}),
            'measured without origin': ('input_fresh', {'origin': None}),
            'measured with a reason': ('input_fresh', {'reason': 'absent-in-source'}),
            'missing with an origin': ('reasoning', {'origin': 'reported'}),
            'measured with inspection value': ('input_fresh', {'inspection_value': 4}),
            'measured_zero with assumed part': ('cache_write_1h', {'assumed_part': 1}),
            'not_applicable with inspection value': ('reasoning', {'presence': 'not_applicable',
                                                                   'reason': 'category-not-applicable', 'inspection_value': 1}),
            'unknown presence': ('input_fresh', {'presence': 'unknown'}),
            'unknown reason': ('reasoning', {'reason': 'because'}),
            'unknown origin': ('input_fresh', {'origin': 'guessed'}),
        }
        self.assertEqual(cf.validate_record(golden_record()), [])
        for label, (name, change) in mutations.items():
            with self.subTest(label):
                record = golden_record()
                component = record['components'][name]
                for key, value in change.items():
                    if value is None:
                        component.pop(key, None)
                    else:
                        component[key] = value
                self.assertTrue(cf.validate_record(record), label)

    def test_semantic_rules_the_schema_cannot_express(self):
        self.assertEqual(cf.validate_record(golden_record()), [])

        def forge_missing_output(r):
            r['components']['output'].update(presence='missing', value=None, reason='absent-in-source')
            del r['components']['output']['origin'], r['components']['output']['coverage']

        def assumed_above_value(r):
            r['components']['cache_write_1h'].update(presence='measured', value=1, assumed_part=2)

        def reasoning_above_output(r):
            r['components']['reasoning'] = {'presence': 'measured', 'value': 27, 'origin': 'reported'}

        def to_day_scope(r):
            r['scope'], r['time'] = 'day', None
            r['identity']['key'] = '2026-01-01'

        cases = (
            ('stated total over a missing component', forge_missing_output, '/total: recomputation'),
            ('forged total value', lambda r: r['total'].update(value=78), '/total: recomputation'),
            ('forged subtotal', lambda r: r['total'].update(measured_subtotal=78), '/total: recomputation'),
            ('forged completeness', lambda r: r.update(completeness='partial'), '/completeness: recomputation'),
            ('unsorted flags', lambda r: r.update(flags=['reasoning-clamped', 'cache-ttl-invalid']), '/flags: order'),
            ('assumed part on a non-1h component', lambda r: r['components']['cache_write_5m'].update(
                presence='measured', value=1, assumed_part=1), 'cache_write_5m/assumed_part: rule'),
            ('assumed part above the 1h value', assumed_above_value, 'cache_write_1h/assumed_part: rule'),
            ('coverage resolves more than it has parts', lambda r: r['components']['input_fresh']['coverage'].update(resolved=3),
             'coverage: resolved-exceeds-parts'),
            ('measured sum disagrees with its coverage', lambda r: r['components']['input_fresh']['coverage'].update(resolved_subtotal=12),
             'coverage: measured-sum'),
            ('leaves exceed the group total', lambda r: r['components']['cache_write_total'].update(value=15),
             'cache_write_total: leaves-exceed-total'),
            ('unassigned resolved but partition broken', lambda r: r['components']['cache_write_unassigned'].update(
                presence='measured', value=1, origin='derived'), 'cache_write_total: partition'),
            ('reasoning above output', reasoning_above_output, 'reasoning: exceeds-output'),
            ('day key differs from the date', to_day_scope, '/identity/key: day-key'),
            ('local day contradicts the timestamp', lambda r: r['day'].update(date='2026-07-22'), '/day/date: time-mismatch'),
            ('unflagged source total mismatch', lambda r: r.update(source_total={'presence': 'measured', 'value': 5, 'origin': 'reported'}),
             '/source_total: incoherent-unflagged'),
        )
        for label, fn, want in cases:
            with self.subTest(label):
                record = golden_record()
                fn(record)
                problems = cf.validate_record(record)
                self.assertTrue(any(want in p for p in problems), (label, problems))
        flagged = golden_record()
        flagged['source_total'] = {'presence': 'measured', 'value': 5, 'origin': 'reported'}
        flagged['flags'] = ['source-total-incoherent']
        self.assertEqual(cf.validate_record(flagged), [])

    def test_unknown_missing_and_extra_keys_are_refused(self):
        self.assertEqual(cf.validate_record(golden_record()), [])
        for label, fn in (('extra record key', lambda r: r.update(extra=1)),
                          ('extra component key', lambda r: r['components']['output'].update(extra=1)),
                          ('extra total key', lambda r: r['total'].update(extra=1)),
                          ('missing flags', lambda r: r.pop('flags')),
                          ('missing components key', lambda r: r['components'].pop('reasoning')),
                          ('wrong format string', lambda r: r.update(format='tokenelo/comparator-count-record@v2'))):
            with self.subTest(label):
                record = golden_record()
                fn(record)
                self.assertTrue(cf.validate_record(record))

    def test_cohort_level_rules(self):
        base = cf.load_json_file(CASES / 'n04-native-resumed-session' / 'b.cohort.json')
        self.assertEqual(cf.validate_cohort(base), [])
        dup = copy.deepcopy(base)
        dup['records'].append(copy.deepcopy(dup['records'][0]))
        self.assertIn('/records: duplicate-identity', cf.validate_cohort(dup))
        unsorted = copy.deepcopy(base)
        unsorted['records'].reverse()
        self.assertIn('/records: order', cf.validate_cohort(unsorted))
        other_source = copy.deepcopy(base)
        other_source['records'][0]['source']['instance'] = 'fab-other'
        self.assertTrue(any('source: cohort-mismatch' in p for p in cf.validate_cohort(other_source)))
        wrong_scope = copy.deepcopy(base)
        wrong_scope['scope'] = 'day'
        self.assertTrue(cf.validate_cohort(wrong_scope))
        claims_complete = cf.load_json_file(CASES / 'n06-native-missing-vs-zero-vs-invalid' / 'b.cohort.json')
        self.assertEqual(claims_complete['completeness'], 'partial')
        claims_complete['completeness'] = 'complete'
        self.assertIn('/completeness: recomputation', cf.validate_cohort(claims_complete))
        misclassified = cf.load_json_file(CASES / 'n06-native-missing-vs-zero-vs-invalid' / 'b.cohort.json')
        for drop in misclassified['dropped']:
            if drop['reason'] == 'all-zero-usage':
                drop['unreadable'] = True
        self.assertTrue(any('unreadable: classification' in p for p in cf.validate_cohort(misclassified)))

    def test_result_level_rules(self):
        base = cf.load_json_file(CASES / 'v03-vendor-totals-equal-components-differ' / 'result.json')
        self.assertEqual(cf.validate_result(base), [])

        def mutate(label, fn, want=None):
            doc = copy.deepcopy(base)
            fn(doc)
            problems = cf.validate_result(doc)
            self.assertTrue(problems, label)
            if want:
                self.assertTrue(any(want in p for p in problems), (label, problems))
        unit = lambda d: d['pairs'][0]['units']['input_fresh']
        mutate('forged delta', lambda d: unit(d).update(delta=11), 'delta')
        mutate('forged percent', lambda d: unit(d).update(percent_micro=1), 'percent-value')
        mutate('forged summary', lambda d: d['summary'].update(identical=1), 'summary')
        mutate('forged outcome', lambda d: d['pairs'][0].update(outcome='identical'), 'outcome')
        mutate('tolerance verdict forged', lambda d: unit(d).update(within_tolerance=True), 'tolerance')
        mutate('equal relation with missing side', lambda d: unit(d)['a'].update(presence='missing', value=None, reason='absent-in-source'))
        mutate('reference side other than b', lambda d: d.update(reference_side='a'))
        mutate('percent present when quality is not complete', lambda d: d['pairs'][0]['a'].update(count_quality='conflict'),
               'percent-not-allowed')


class VendorNormalization(unittest.TestCase):
    def test_ccusage_fields_map_to_separate_components_and_cost_is_ignored(self):
        doc = {'daily': [ccu('2026-10-12', inputTokens=2, cacheCreationTokens=10, cacheReadTokens=30,
                             outputTokens=11, totalTokens=53, totalCost=1.5, modelsUsed=['model-a'],
                             modelBreakdowns=[{'modelName': 'model-a'}])]}
        cohort = cf.normalize_ccusage_daily(doc, 'fab-ccusage', TZ)
        record = one(cohort)
        self.assertEqual([pv(record, n) for n in ('input_fresh', 'cache_write_total', 'cache_read', 'output')],
                         [['measured', 2], ['measured', 10], ['measured', 30], ['measured', 11]])
        for leaf in cf.LEAVES:
            self.assertEqual(record['components'][leaf], {'presence': 'missing', 'value': None,
                                                          'reason': 'source-does-not-split-ttl'})
        self.assertEqual(record['components']['reasoning']['reason'], 'source-does-not-report')
        self.assertEqual(record['total']['value'], 53)
        self.assertEqual(record['source_total'], {'presence': 'measured', 'value': 53, 'origin': 'reported'})
        text = cf.dumps(cohort)
        for forbidden in ('totalCost', 'modelsUsed', 'modelBreakdowns', '1.5', 'model-a'):
            self.assertNotIn(forbidden, text)

    def test_absent_key_is_missing_and_explicit_zero_is_measured_zero(self):
        absent = one(vendor([ccu('2026-10-10', inputTokens=5, cacheCreationTokens=0, outputTokens=7, totalTokens=12)]))
        zero = one(vendor([ccu('2026-10-10', inputTokens=5, cacheCreationTokens=0, cacheReadTokens=0,
                               outputTokens=7, totalTokens=12)]))
        self.assertEqual(pv(absent, 'cache_read'), ['missing', None])
        self.assertEqual(absent['components']['cache_read']['reason'], 'absent-in-source')
        self.assertEqual(pv(zero, 'cache_read'), ['measured_zero', 0])
        self.assertEqual((absent['count_quality'], absent['completeness']), ('incomplete', 'partial'))
        self.assertEqual((zero['count_quality'], zero['completeness']), ('complete', 'complete'))
        self.assertIsNone(absent['total']['value'])
        self.assertEqual(absent['total']['measured_subtotal'], 12)
        self.assertEqual(absent['total']['unresolved'], ['cache_read'])
        self.assertEqual(zero['total']['value'], 12)
        # the vendor's own stated total must not fill the gap: no component is derived from it
        self.assertEqual(absent['source_total']['value'], 12)

    def test_unusable_values_are_invalid_never_zero(self):
        for bad in (None, -1, 1.5, True, '5', 2 ** 53, [1]):
            with self.subTest(bad=bad):
                day = ccu('2026-10-10', inputTokens=5, cacheCreationTokens=0, cacheReadTokens=bad,
                          outputTokens=7, totalTokens=12)
                record = one(vendor([day]))
                self.assertEqual(pv(record, 'cache_read'), ['invalid', None])
                self.assertEqual(record['count_quality'], 'invalid')
                self.assertIsNone(record['total']['value'])
                self.assertNotIn('inspection_value', record['components']['cache_read'])

    def test_incoherent_vendor_total_is_a_conflict_not_a_correction(self):
        record = one(vendor([ccu('2026-10-10', inputTokens=5, cacheCreationTokens=1, cacheReadTokens=2,
                                 outputTokens=7, totalTokens=99)]))
        self.assertEqual(record['count_quality'], 'conflict')
        self.assertIn('source-total-incoherent', record['flags'])
        self.assertIsNone(record['total']['value'])
        self.assertEqual(record['total']['measured_subtotal'], 15)
        self.assertEqual(record['source_total']['value'], 99)

    def test_missing_vendor_total_does_not_degrade_the_component_basis(self):
        record = one(vendor([ccu('2026-10-10', inputTokens=5, cacheCreationTokens=1, cacheReadTokens=2, outputTokens=7)]))
        self.assertEqual(record['count_quality'], 'complete')
        self.assertEqual(record['source_total']['presence'], 'missing')
        self.assertEqual(record['total']['value'], 15)

    def test_structural_refusals_use_fixed_codes(self):
        good = full_day('2026-10-10', 1, 1, 1, 1)
        for label, doc, kwargs, code in (
                ('duplicate date', {'daily': [good, good]}, {}, 'duplicate-identity'),
                ('not a date', {'daily': [ccu('2026-02-30')]}, {}, 'invalid-date'),
                ('date with time', {'daily': [ccu('2026-10-10T00:00:00')]}, {}, 'invalid-date'),
                ('non dict row', {'daily': [5]}, {}, 'invalid-daily-row'),
                ('no daily', {'rows': []}, {}, 'daily-report-required'),
                ('before range', {'daily': [good]}, {'first': '2026-10-11', 'last': '2026-10-12'}, 'out-of-range-date'),
                ('after range', {'daily': [good]}, {'first': '2026-10-01', 'last': '2026-10-09'}, 'out-of-range-date'),
                ('reversed range', {'daily': []}, {'first': '2026-10-12', 'last': '2026-10-01'}, 'reversed-date-range'),
                ('bad range date', {'daily': []}, {'first': 'x', 'last': '2026-10-01'}, 'invalid-date')):
            with self.subTest(label):
                with self.assertRaises(FormatError) as caught:
                    cf.normalize_ccusage_daily(doc, 'fab-ccusage', TZ, **kwargs)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(str(caught.exception), code)

    def test_vendor_input_order_does_not_change_bytes(self):
        days = [full_day('2026-10-10', 1, 2, 3, 4), full_day('2026-10-11', 5, 6, 7, 8), full_day('2026-10-09', 0, 0, 0, 1)]
        forward = cf.dumps(vendor(days))
        self.assertEqual(forward, cf.dumps(vendor(list(reversed(days)))))
        self.assertEqual([r['identity']['key'] for r in json.loads(forward)['records']],
                         ['2026-10-09', '2026-10-10', '2026-10-11'])


class LedgerNormalization(unittest.TestCase):
    def norm(self, rows, **extra):
        return cf.normalize_ledger_rows(ledger(rows, **extra), 'fab-ledger', TZ)

    def test_complete_row_keeps_the_split_and_derives_the_group_total(self):
        record = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 3, 5, 2, 30, 11)]))
        self.assertEqual([pv(record, n) for n in ('cache_write_5m', 'cache_write_1h', 'cache_write_unassigned',
                                                  'cache_write_total')],
                         [['measured', 3], ['measured', 5], ['measured', 2], ['measured', 10]])
        self.assertEqual(record['components']['cache_write_total']['origin'], 'derived')
        self.assertEqual(record['components']['cache_write_5m']['origin'], 'normalized')
        self.assertEqual(record['total']['value'], 2 + 10 + 30 + 11)

    def test_null_unassigned_is_missing_and_blocks_the_group_total(self):
        r = row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 3, 5, None, 30, 11)
        record = one(self.norm([r]))
        self.assertEqual(record['components']['cache_write_unassigned']['reason'], 'ledger-null-unrecorded')
        self.assertEqual(pv(record, 'cache_write_total'), ['missing', None])
        self.assertEqual(record['count_quality'], 'complete')  # stored quality is carried verbatim
        self.assertEqual(record['completeness'], 'partial')    # ...and does not make the record complete
        self.assertIsNone(record['total']['value'])
        self.assertEqual(record['total']['measured_subtotal'], 2 + 3 + 5 + 30 + 11)
        # the key being absent entirely is the same state
        absent = dict(r)
        del absent['cache_write_unassigned']
        self.assertEqual(one(self.norm([absent]))['components']['cache_write_unassigned']['reason'], 'ledger-null-unrecorded')

    def test_ledger_reasoning_zero_is_ambiguous_not_a_measured_zero(self):
        zero = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 0, 5, reasoning=0)]))
        some = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 0, 5, reasoning=3)]))
        self.assertEqual(zero['components']['reasoning'], {'presence': 'missing', 'value': None,
                                                           'reason': 'ledger-zero-ambiguous'})
        self.assertEqual(pv(some, 'reasoning'), ['measured', 3])
        self.assertEqual(zero['total']['value'], 7)  # reasoning is a subset of output and never in a total
        self.assertEqual(some['total']['value'], 7)

    def test_rows_without_complete_quality_hold_numbers_as_inspection_only(self):
        for quality in (None, 'unrecorded', 'incomplete', 'invalid', 'conflict'):
            with self.subTest(quality=quality):
                record = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 100, 5, 0, 0, 3, 10,
                                            q=quality, reasoning=2)]))
                want = 'unrecorded' if quality is None else quality
                self.assertEqual(record['count_quality'], want)
                reason = 'legacy-unrecorded' if want == 'unrecorded' else 'row-count-quality-not-complete'
                for name, component in record['components'].items():
                    self.assertEqual((component['presence'], component['value'], component['reason']),
                                     ('missing', None, reason), name)
                self.assertEqual(record['components']['input_fresh']['inspection_value'], 100)
                self.assertEqual(record['components']['cache_write_5m']['inspection_value'], 5)
                self.assertEqual(record['components']['cache_write_1h']['inspection_value'], 0)
                self.assertNotIn('inspection_value', record['components']['cache_write_total'])
                self.assertIsNone(record['total']['value'])
                self.assertEqual(record['total']['measured_subtotal'], 0)

    def test_assumed_one_hour_is_marked_and_never_passes_as_reported_ttl(self):
        record = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 100, 0, 0, 1, assumed=100)]))
        one_hour = record['components']['cache_write_1h']
        self.assertEqual((one_hour['value'], one_hour['assumed_part'], one_hour['origin']), (100, 100, 'assumed'))
        partly = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 100, 0, 0, 1, assumed=40)]))
        self.assertEqual(partly['components']['cache_write_1h']['assumed_part'], 40)
        self.assertEqual(partly['components']['cache_write_1h']['origin'], 'normalized')
        self.assertEqual(pv(record, 'cache_write_total'), ['measured', 100])
        over = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 100, 0, 0, 1, assumed=101)]))
        self.assertEqual(pv(over, 'cache_write_1h'), ['invalid', None])
        self.assertEqual(over['count_quality'], 'invalid')
        self.assertIn('stored-quality-contradicted', over['flags'])
        none = one(self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 100, 0, 0, 1, assumed=0)]))
        self.assertNotIn('assumed_part', none['components']['cache_write_1h'])

    def test_invalid_column_in_a_complete_row_contradicts_the_stored_quality(self):
        r = row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 0, 5)
        for bad in (-1, 1.5, None, 'x', True):
            with self.subTest(bad=bad):
                broken = dict(r, output=bad)
                record = one(self.norm([broken]))
                self.assertEqual(pv(record, 'output'), ['invalid', None])
                self.assertEqual(record['count_quality'], 'invalid')
                self.assertIn('stored-quality-contradicted', record['flags'])

    def test_refusals_match_the_existing_comparator_vocabulary(self):
        good = row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 0, 0, 0, 1)
        for label, call, code in (
                ('schema 9', lambda: cf.normalize_ledger_rows(ledger([good], schema_version=9), 'x', TZ), 'unsupported-schema-version'),
                ('policy 8', lambda: cf.normalize_ledger_rows(ledger([good], projection_policy=8), 'x', TZ), 'unsupported-projection-policy'),
                ('unknown quality', lambda: self.norm([dict(good, count_quality='great')]), 'invalid-count-quality'),
                ('duplicate id', lambda: self.norm([good, dict(good)]), 'duplicate-identity'),
                ('bad id', lambda: self.norm([dict(good, id='has space')]), 'invalid-row'),
                ('bad ts', lambda: self.norm([dict(good, ts=-1)]), 'invalid-row'),
                ('non dict row', lambda: self.norm([5]), 'invalid-row'),
                ('wrong kind', lambda: cf.normalize_ledger_rows({'kind': 'x', 'rows': []}, 'x', TZ), 'invalid-input-shape')):
            with self.subTest(label):
                with self.assertRaises(FormatError) as caught:
                    call()
                self.assertEqual(caught.exception.code, code)

    def test_rows_of_other_sources_are_counted_and_never_mixed_in(self):
        cohort = self.norm([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 0, 0, 0, 1),
                            row('codex:fab-2', '2026-10-12T12:00:00.000Z', 9, 0, 0, 0, 0, 9, source='codex')])
        self.assertEqual([r['identity']['key'] for r in cohort['records']], ['claude:fab-1'])
        self.assertEqual(cohort['dropped'], [{'reason': 'non-selected-source', 'count': 1, 'unreadable': False}])
        self.assertEqual(cohort['completeness'], 'complete')

    def test_local_engine_rows_have_no_cache_write_categories(self):
        record = one(self.norm([row('fab-o-1', '2026-10-12T12:00:00.000Z', 17, 0, 0, 0, 3, 4, source='ollama')],
                               selected_source='ollama'))
        for name in cf.LEAVES + ('cache_write_total',):
            self.assertEqual(record['components'][name]['presence'], 'not_applicable', name)
        self.assertEqual(record['total']['value'], 24)
        self.assertEqual(record['completeness'], 'complete')
        contradicted = one(self.norm([row('fab-o-1', '2026-10-12T12:00:00.000Z', 17, 0, 9, 0, 3, 4, source='ollama')],
                                     selected_source='ollama'))
        self.assertEqual(contradicted['count_quality'], 'invalid')
        self.assertIn('stored-quality-contradicted', contradicted['flags'])


class NativeNormalization(unittest.TestCase):
    EARLY = {'type': 'message', 'model': 'model-a', 'input_tokens': 11, 'cache_creation_input_tokens': 13,
             'cache_read_input_tokens': 17, 'output_tokens': 19,
             'cache_creation': {'ephemeral_5m_input_tokens': 13, 'ephemeral_1h_input_tokens': 0}}
    FINAL = {'type': 'message', 'model': 'model-b', 'input_tokens': 2, 'cache_creation_input_tokens': 3,
             'cache_read_input_tokens': 5, 'output_tokens': 7,
             'cache_creation': {'ephemeral_5m_input_tokens': 3, 'ephemeral_1h_input_tokens': 0}}
    TS = '2026-07-21T12:00:00.000Z'

    def test_iterations_are_summed_and_the_mirroring_top_level_is_not_added_again(self):
        for top_five in (3, 9):  # 9 contradicts the final iteration's flat total and must be ignored
            with self.subTest(top_five=top_five):
                top = usage(2, 3, 5, 7, five=top_five, hour=0, iterations=[self.EARLY, self.FINAL])
                record = one(norm_native([line(self.TS, 'fab-m', top)]))
                # hand arithmetic: (11+13+17+19) + (2+3+5+7) = 60 + 17 = 77
                self.assertEqual([pv(record, n) for n in ('input_fresh', 'cache_write_total', 'cache_read', 'output')],
                                 [['measured', 13], ['measured', 16], ['measured', 22], ['measured', 26]])
                self.assertEqual(record['total']['value'], 77)
                self.assertNotEqual(record['total']['value'], 17)  # top-level alone would be 2+3+5+7
                self.assertEqual(record['identity']['iteration_count'], 2)
                self.assertEqual(record['components']['input_fresh']['coverage'], {'parts': 2, 'resolved': 2, 'resolved_subtotal': 13})
                self.assertEqual(record['count_quality'], 'complete')
                self.assertEqual(record['flags'], [])

    def test_one_unresolved_iteration_keeps_the_message_component_unresolved(self):
        early = dict(self.EARLY)
        del early['cache_read_input_tokens']
        top = usage(2, 3, 5, 7, five=3, hour=0, iterations=[early, self.FINAL])
        record = one(norm_native([line(self.TS, 'fab-m', top)]))
        read = record['components']['cache_read']
        self.assertEqual((read['presence'], read['value'], read['reason']), ('missing', None, 'partial-members'))
        self.assertEqual(read['coverage'], {'parts': 2, 'resolved': 1, 'resolved_subtotal': 5})
        self.assertEqual(record['count_quality'], 'incomplete')
        self.assertIsNone(record['total']['value'])
        self.assertEqual(record['total']['measured_subtotal'], 13 + 16 + 5 + 26)

    def test_opposing_snapshots_keep_per_field_maxima_as_held_conflict(self):
        record = one(norm_native([
            line('2026-07-21T12:00:00.000Z', 'fab-m', usage(100, 2, 3, 1, five=2, hour=0), uuid='u1'),
            line('2026-07-21T12:00:05.000Z', 'fab-m', usage(1, 5, 2, 10, five=5, hour=0), uuid='u2')]))
        self.assertEqual([pv(record, n) for n in ('input_fresh', 'cache_write_total', 'cache_read', 'output')],
                         [['measured', 100], ['measured', 5], ['measured', 3], ['measured', 10]])
        self.assertEqual(record['count_quality'], 'conflict')
        self.assertIn('snapshots-incomparable', record['flags'])
        self.assertIsNone(record['total']['value'])
        self.assertEqual(record['total']['measured_subtotal'], 118)  # 100 + 5 + 3 + 10
        self.assertEqual(record['total']['reason'], 'count-quality-not-complete')
        self.assertEqual(record['completeness'], 'complete')

    def test_monotone_snapshots_are_not_a_conflict(self):
        record = one(norm_native([
            line('2026-07-21T12:00:00.000Z', 'fab-m', usage(2, 0, 3, 3), uuid='u1'),
            line('2026-07-21T12:00:05.000Z', 'fab-m', usage(2, 0, 3, 8), uuid='u2')]))
        self.assertEqual(record['count_quality'], 'complete')
        self.assertEqual(pv(record, 'output'), ['measured', 8])
        self.assertEqual(record['evidence']['distinct_snapshots'], 2)

    def test_identical_requestless_snapshots_across_midnight_are_one_record_at_the_later_time(self):
        lines = [line('2026-07-21T05:59:59.000Z', 'fab-m', usage(2, 3, 5, 7, five=3, hour=0), request=None, uuid='u1'),
                 line('2026-07-21T06:00:01.000Z', 'fab-m', usage(2, 3, 5, 7, five=3, hour=0), request=None, uuid='u2')]
        record = one(norm_native(lines))
        self.assertEqual(record['total']['value'], 17)  # not 34
        self.assertEqual(record['time']['utc_ms'], T('2026-07-21T06:00:01.000Z'))
        self.assertEqual(record['day']['date'], '2026-07-21')  # 00:00:01 at -06:00
        self.assertEqual(norm_native([lines[0]])['records'][0]['day']['date'], '2026-07-20')  # 23:59:59 at -06:00
        self.assertFalse(record['identity']['request_id_present'])
        self.assertIsNone(record['identity']['request_key'])
        self.assertEqual((record['evidence']['lines_observed'], record['evidence']['distinct_snapshots']), (2, 1))

    def test_uuid_fallback_identity_is_labelled_and_replays_collapse(self):
        same = line(self.TS, None, usage(1, 0, 0, 1), request=None, session='fab-s', uuid='fab-u')
        cohort = norm_native([same, copy.deepcopy(same)])
        record = one(cohort)
        self.assertEqual(record['identity']['key'], 'claude:fab-s+fab-u')
        self.assertEqual(record['identity']['basis'], 'line-uuid-fallback')
        self.assertEqual(record['total']['value'], 2)
        other = line(self.TS, None, usage(1, 0, 0, 1), request=None, session='fab-s', uuid='fab-u2')
        self.assertEqual(len(norm_native([same, other])['records']), 2)

    def test_request_id_is_the_second_identity_choice(self):
        record = one(norm_native([line(self.TS, None, usage(1, 0, 0, 1), request='fab-req-9')]))
        self.assertEqual((record['identity']['key'], record['identity']['basis']), ('claude:fab-req-9', 'request-id'))
        self.assertEqual(norm_native([line(self.TS, None, usage(1, 0, 0, 1), request=None, uuid=None)])['dropped'],
                         [{'reason': 'no-identity', 'count': 1, 'unreadable': True}])

    def test_resumed_session_adds_nothing_for_replayed_messages(self):
        m1, m2a, m2b, m3 = usage(4, 0, 6, 5), usage(2, 0, 3, 3), usage(2, 0, 3, 8), usage(1, 0, 0, 2)
        cohort = norm_native([
            line('2026-10-12T10:00:00.000Z', 'fab-a', m1, session='sA', uuid='u1', request='r1'),
            line('2026-10-12T10:01:00.000Z', 'fab-b', m2a, session='sA', uuid='u2', request='r2'),
            line('2026-10-12T10:00:00.000Z', 'fab-a', m1, session='sB', uuid='u3', request='r1'),
            line('2026-10-12T10:01:30.000Z', 'fab-b', m2b, session='sB', uuid='u4', request='r2'),
            line('2026-10-12T10:02:00.000Z', 'fab-c', m3, session='sB', uuid='u5', request='r3')])
        self.assertEqual([r['total']['value'] for r in cohort['records']], [15, 13, 3])
        day = one(cf.rollup_days(cohort))
        self.assertEqual(day['total']['value'], 31)  # 15 + 13 + 3, not 15 + 15 + 3 + 13 + 8 ...
        self.assertEqual((day['evidence']['members'], day['evidence']['members_complete']), (3, 3))
        self.assertEqual(day['evidence']['lines_observed'], None)
        b = cohort['records'][1]
        # the replay claims another session: the first-seen time stays and the conflict is flagged
        self.assertEqual(b['time']['utc_ms'], T('2026-10-12T10:01:00.000Z'))
        self.assertEqual(b['flags'], ['session-attribution-conflict'])
        self.assertEqual(cohort['records'][2]['flags'], [])
        self.assertEqual(b['evidence']['sessions_observed'], 2)

    def test_earlier_line_with_the_larger_output_keeps_its_time(self):
        record = one(norm_native([line('2026-10-12T10:00:00.000Z', 'fab-a', usage(1, 0, 0, 10), uuid='u1'),
                                  line('2026-10-12T10:05:00.000Z', 'fab-a', usage(1, 0, 0, 5), uuid='u2')]))
        self.assertEqual(record['time']['utc_ms'], T('2026-10-12T10:00:00.000Z'))
        self.assertEqual(pv(record, 'output'), ['measured', 10])
        self.assertEqual(record['count_quality'], 'complete')  # a decrease in one field alone is comparable
        self.assertNotIn('snapshots-incomparable', record['flags'])

    def test_cache_write_evidence_matrix(self):
        cases = {
            'flat only': (usage(1, 100, 0, 1), 'complete', [],
                          {'cache_write_total': ('measured', 100), 'cache_write_5m': ('missing', None),
                           'cache_write_1h': ('missing', None), 'cache_write_unassigned': ('measured', 100)}),
            'full split': (usage(1, 100, 0, 1, five=60, hour=40), 'complete', [],
                           {'cache_write_total': ('measured', 100), 'cache_write_5m': ('measured', 60),
                            'cache_write_1h': ('measured', 40), 'cache_write_unassigned': ('measured_zero', 0)}),
            'partial split': (usage(1, 100, 0, 1, five=60), 'complete', [],
                              {'cache_write_5m': ('measured', 60), 'cache_write_1h': ('missing', None),
                               'cache_write_unassigned': ('measured', 40)}),
            'no flat total': (usage(1, None, 0, 1, five=60, hour=40), 'incomplete', [],
                              {'cache_write_total': ('missing', None), 'cache_write_5m': ('measured', 60),
                               'cache_write_1h': ('measured', 40), 'cache_write_unassigned': ('missing', None)}),
            'split above flat': (usage(1, 50, 0, 1, five=30, hour=40), 'conflict', ['cache-split-exceeds-total'],
                                 {'cache_write_total': ('missing', None), 'cache_write_unassigned': ('missing', None)}),
            'zero flat forces zero leaves': (usage(1, 0, 0, 1), 'complete', [],
                                             {'cache_write_total': ('measured_zero', 0), 'cache_write_5m': ('measured_zero', 0),
                                              'cache_write_1h': ('measured_zero', 0), 'cache_write_unassigned': ('measured_zero', 0)}),
            'invalid five minute field': (usage(1, 10, 0, 1, five='x', hour=4), 'complete', ['cache-ttl-invalid'],
                                          {'cache_write_total': ('measured', 10), 'cache_write_5m': ('invalid', None),
                                           'cache_write_1h': ('measured', 4), 'cache_write_unassigned': ('missing', None)}),
            'invalid flat total': (usage(1, -5, 0, 1), 'invalid', [],
                                   {'cache_write_total': ('invalid', None), 'cache_write_unassigned': ('missing', None)}),
            'malformed container': (usage(1, 10, 0, 1, cache_creation='x'), 'complete', ['cache-ttl-invalid'],
                                    {'cache_write_total': ('measured', 10), 'cache_write_5m': ('missing', None),
                                     'cache_write_unassigned': ('missing', None)}),
            'null container': (usage(1, 10, 0, 1, cache_creation=None), 'complete', [],
                               {'cache_write_5m': ('missing', None), 'cache_write_unassigned': ('measured', 10)}),
        }
        for label, (u, quality, flags, want) in cases.items():
            with self.subTest(label):
                record = one(norm_native([line(self.TS, 'fab-m', u)]))
                self.assertEqual(record['count_quality'], quality)
                self.assertEqual(record['flags'], flags)
                for name, expected in want.items():
                    self.assertEqual(tuple(pv(record, name)), expected, name)
                self.assertEqual(cf.validate_record(record), [])

    def test_zero_residual_only_forces_unreported_leaves_when_it_is_arithmetic(self):
        sure = one(norm_native([line(self.TS, 'fab-m', usage(1, 10, 0, 1, five=10))]))
        self.assertEqual(pv(sure, 'cache_write_1h'), ['measured_zero', 0])
        self.assertEqual(sure['components']['cache_write_1h']['origin'], 'derived')
        unsure = one(norm_native([line(self.TS, 'fab-m', usage(1, 10, 0, 1, five=4))]))
        self.assertEqual(pv(unsure, 'cache_write_1h'), ['missing', None])
        self.assertEqual(pv(unsure, 'cache_write_unassigned'), ['measured', 6])

    def test_each_counter_distinguishes_absent_zero_null_negative_fractional_and_boolean(self):
        fields = {'input_fresh': 'input_tokens', 'cache_read': 'cache_read_input_tokens', 'output': 'output_tokens'}
        for component, key in fields.items():
            base = {'input_tokens': 3, 'cache_read_input_tokens': 4, 'output_tokens': 5, 'cache_creation_input_tokens': 0}
            states = {'absent': (None, 'missing', 'incomplete'), 'zero': (0, 'measured_zero', 'complete'),
                      'null': ('NULL', 'invalid', 'invalid'), 'negative': (-1, 'invalid', 'invalid'),
                      'fraction': (2.5, 'invalid', 'invalid'), 'boolean': (True, 'invalid', 'invalid'),
                      'string': ('7', 'invalid', 'invalid')}
            for label, (value, presence, quality) in states.items():
                with self.subTest(component=component, state=label):
                    u = dict(base)
                    if label == 'absent':
                        del u[key]
                    else:
                        u[key] = None if value == 'NULL' else value
                    record = one(norm_native([line(self.TS, 'fab-m', u)]))
                    self.assertEqual(record['components'][component]['presence'], presence)
                    self.assertEqual(record['count_quality'], quality)
                    if presence in ('missing', 'invalid'):
                        self.assertIsNone(record['components'][component]['value'])
                        self.assertIsNone(record['total']['value'])

    def test_lines_that_become_no_record_are_counted_and_unreadable_ones_make_the_cohort_partial(self):
        lines = [line(self.TS, 'a1', usage(0, 0, 0, 0)), line(self.TS, 'a2', {}),
                 line(self.TS, 'a3', usage(5, 0, 0, 5), model='<synthetic>'),
                 dict(line(self.TS, 'a4', usage(5, 0, 0, 5)), type='user'),
                 line('2026-13-40T00:00:00Z', 'a5', usage(5, 0, 0, 5)),
                 line(self.TS, 'a6', usage(5, 0, 0, 5)), 'not a dict']
        with self.assertRaises(FormatError) as caught:
            norm_native(lines)
        self.assertEqual(caught.exception.code, 'invalid-line')
        cohort = norm_native(lines[:-1])
        self.assertEqual({d['reason']: d['count'] for d in cohort['dropped']},
                         {'all-zero-usage': 1, 'no-counters-observed': 1, 'synthetic-model': 1, 'not-usage-line': 1,
                          'invalid-timestamp': 1})
        self.assertEqual([d['unreadable'] for d in cohort['dropped'] if d['reason'] == 'invalid-timestamp'], [True])
        self.assertEqual(cohort['completeness'], 'partial')
        self.assertEqual(len(cohort['records']), 1)
        by_design = norm_native(lines[:4])
        self.assertEqual(by_design['completeness'], 'complete')

    def test_a_line_whose_only_counters_are_invalid_is_kept_as_an_invalid_record(self):
        record = one(norm_native([line(self.TS, 'fab-m', {'input_tokens': -1})]))
        self.assertEqual(pv(record, 'input_fresh'), ['invalid', None])
        self.assertEqual(record['count_quality'], 'invalid')

    def test_snapshots_with_different_component_shapes_are_held_as_misaligned(self):
        one_slot = line('2026-07-21T12:00:00.000Z', 'fab-m', usage(2, 3, 5, 7, five=3, hour=0), uuid='u1')
        two_slots = line('2026-07-21T12:00:05.000Z', 'fab-m',
                         usage(2, 3, 5, 7, five=3, hour=0, iterations=[self.EARLY, self.FINAL]), uuid='u2')
        record = one(norm_native([one_slot, two_slots]))
        self.assertEqual(record['count_quality'], 'conflict')
        self.assertIn('components-misaligned', record['flags'])
        # event-level maximum of each snapshot's own totals: input max(2, 13), output max(7, 26)
        self.assertEqual((pv(record, 'input_fresh'), pv(record, 'output')), (['measured', 13], ['measured', 26]))
        self.assertEqual(record['components']['reasoning']['reason'], 'snapshots-conflict')
        self.assertIsNone(record['total']['value'])
        self.assertEqual(record['identity']['iteration_count'], 2)  # the winning snapshot's shape is the one kept
        # a later line whose event output (7) is below the kept one (26) does not replace the kept shape
        later_smaller = one(norm_native([two_slots, dict(one_slot, timestamp='2026-07-21T12:00:09.000Z')]))
        self.assertEqual(later_smaller['identity']['iteration_count'], 2)
        self.assertEqual(later_smaller['time']['utc_ms'], T('2026-07-21T12:00:05.000Z'))
        same_shape_other_model = line('2026-07-21T12:00:05.000Z', 'fab-m', usage(2, 3, 5, 7, five=3, hour=0), uuid='u3',
                                      model='model-c')
        self.assertIn('components-misaligned', one(norm_native([one_slot, same_shape_other_model]))['flags'])

    def test_reasoning_is_a_clamped_subset_never_added_to_a_total(self):
        def reasoning(thinking, output=10):
            u = usage(1, 0, 0, output)
            if thinking is not None:
                u['output_tokens_details'] = {'thinking_tokens': thinking}
            return one(norm_native([line(self.TS, 'fab-m', u)]))
        clamped = reasoning(25)
        self.assertEqual(pv(clamped, 'reasoning'), ['measured', 10])
        self.assertIn('reasoning-clamped', clamped['flags'])
        self.assertEqual(clamped['total']['value'], 11)
        within = reasoning(4)
        self.assertEqual((pv(within, 'reasoning'), within['flags']), (['measured', 4], []))
        self.assertEqual(pv(reasoning(0), 'reasoning'), ['measured_zero', 0])
        absent = reasoning(None)
        self.assertEqual(absent['components']['reasoning'], {'presence': 'missing', 'value': None,
                                                             'reason': 'source-does-not-report'})
        invalid = reasoning(-3)
        self.assertEqual(pv(invalid, 'reasoning'), ['invalid', None])
        self.assertEqual(invalid['count_quality'], 'complete')  # reasoning never degrades the count basis
        self.assertEqual(invalid['total']['value'], 11)

    def test_conflicting_request_ids_for_one_message_are_flagged_not_resolved(self):
        record = one(norm_native([line(self.TS, 'fab-m', usage(1, 0, 0, 1), request='r1', uuid='u1'),
                                  line(self.TS, 'fab-m', usage(1, 0, 0, 1), request='r2', uuid='u2')]))
        self.assertIn('request-id-conflict', record['flags'])
        self.assertEqual(record['identity']['request_key'], 'r1')

    def test_message_order_does_not_change_bytes_but_line_order_within_a_message_is_input(self):
        a = [line('2026-10-12T10:00:00.000Z', 'fab-a', usage(4, 0, 6, 5), uuid='a1'),
             line('2026-10-12T10:01:00.000Z', 'fab-a', usage(4, 0, 6, 9), uuid='a2')]
        b = [line('2026-10-12T11:00:00.000Z', 'fab-b', usage(1, 0, 0, 2), uuid='b1')]
        self.assertEqual(cf.dumps(norm_native(a + b)), cf.dumps(norm_native(b + a)))
        interleaved = [a[0], b[0], a[1]]
        self.assertEqual(cf.dumps(norm_native(a + b)), cf.dumps(norm_native(interleaved)))


class LocalEngineCounters(unittest.TestCase):
    def norm(self, events):
        return cf.normalize_local_counters({'kind': 'local-engine-counters', 'events': events}, 'fab-local', TZ)

    @staticmethod
    def event(i, snapshots):
        return {'id': 'fab-o-%d' % i, 'ts': T('2026-10-12T12:00:00.000Z'), 'snapshots': snapshots}

    def test_repository_structure_only_fixture_shapes_map_to_the_same_observation_states(self):
        shapes = cf.load_json_file(ROOT / 'test' / 'fixtures' / 'claude-cloud-2026-10-17' / 'structure-only.json')['nativeCounterShapes']
        presence = {'reported': {'measured', 'measured_zero'}, 'missing': {'missing'}, 'invalid': {'invalid'}}
        checked = 0
        for n, shape in enumerate(shapes):
            if 'expectedObservationStates' in shape:
                record = one(self.norm([self.event(n, [shape['rawFields']])]))
                states = shape['expectedObservationStates']
                self.assertIn(record['components']['cache_read']['presence'], presence[states['prompt_eval_cached_count']], shape['case'])
                self.assertIn(record['components']['output']['presence'], presence[states['eval_count']], shape['case'])
                checked += 1
        self.assertEqual(checked, 3)
        by_case = {s['case']: s for s in shapes}
        replay = one(self.norm([self.event(1, by_case['same-native-snapshot-replayed']['rawSnapshots'])]))
        self.assertEqual((replay['evidence']['lines_observed'], replay['evidence']['distinct_snapshots']), (2, 1))
        separate = one(self.norm([self.event(2, by_case['separate-native-observations-are-not-collapsed']['rawSnapshots'])]))
        self.assertEqual(separate['evidence']['distinct_snapshots'], by_case['separate-native-observations-are-not-collapsed']['expectedSnapshotCount'])
        exceeds = one(self.norm([self.event(3, [by_case['cache-exceeds-gross-prompt']['rawFields']])]))
        self.assertEqual(exceeds['count_quality'], 'invalid')
        self.assertEqual(exceeds['components']['input_fresh']['reason'], 'cache-exceeds-prompt')

    def test_missing_cache_counter_is_not_promoted_to_the_assume_zero_policy(self):
        record = one(self.norm([self.event(1, [{'prompt_eval_count': 21, 'eval_count': 4}])]))
        self.assertEqual(pv(record, 'cache_read'), ['missing', None])
        self.assertEqual(record['components']['input_fresh']['reason'], 'cache-counter-absent')
        self.assertEqual(record['count_quality'], 'incomplete')
        zero = one(self.norm([self.event(2, [{'prompt_eval_count': 21, 'prompt_eval_cached_count': 0, 'eval_count': 4}])]))
        self.assertEqual((pv(zero, 'cache_read'), pv(zero, 'input_fresh')), (['measured_zero', 0], ['measured', 21]))
        self.assertEqual(zero['total']['value'], 25)

    def test_cache_write_categories_are_not_applicable_and_do_not_block_a_total(self):
        record = one(self.norm([self.event(1, [{'prompt_eval_count': 10, 'prompt_eval_cached_count': 4, 'eval_count': 2}])]))
        for name in cf.LEAVES + ('cache_write_total',):
            self.assertEqual(record['components'][name], {'presence': 'not_applicable', 'value': None,
                                                          'reason': 'category-not-applicable'})
        self.assertEqual((record['total']['value'], record['completeness']), (12, 'complete'))

    def test_opposing_local_snapshots_are_a_conflict(self):
        record = one(self.norm([self.event(1, [{'prompt_eval_count': 10, 'prompt_eval_cached_count': 5, 'eval_count': 9},
                                               {'prompt_eval_count': 30, 'prompt_eval_cached_count': 2, 'eval_count': 3}])]))
        self.assertEqual(record['count_quality'], 'conflict')
        self.assertIn('snapshots-incomparable', record['flags'])
        self.assertIsNone(record['total']['value'])

    def test_malformed_events_and_duplicates_are_refused(self):
        for events, code in (([{'id': 'x y', 'ts': 1, 'snapshots': [{}]}], 'invalid-row'),
                             ([{'id': 'fab-o-1', 'ts': -1, 'snapshots': [{}]}], 'invalid-row'),
                             ([{'id': 'fab-o-1', 'ts': 1, 'snapshots': []}], 'invalid-row'),
                             ([self.event(1, [{}]), self.event(1, [{}])], 'duplicate-identity')):
            with self.subTest(code=code):
                with self.assertRaises(FormatError) as caught:
                    self.norm(events)
                self.assertEqual(caught.exception.code, code)


class Rollup(unittest.TestCase):
    def test_a_day_is_a_sum_only_when_every_member_is_measured(self):
        rows = [row('claude:fab-1', '2026-10-12T12:00:00.000Z', 10, 2, 3, 0, 20, 5),
                row('claude:fab-2', '2026-10-12T13:00:00.000Z', 4, 0, 0, 0, 6, 1),
                row('claude:fab-3', '2026-10-12T14:00:00.000Z', 100, 50, 0, None, 0, 9, q=None)]
        day = one(cf.rollup_days(cf.normalize_ledger_rows(ledger(rows), 'fab-ledger', TZ)))
        input_fresh = day['components']['input_fresh']
        self.assertEqual((input_fresh['presence'], input_fresh['value']), ('missing', None))
        self.assertEqual(input_fresh['coverage'], {'parts': 3, 'resolved': 2, 'resolved_subtotal': 14})
        self.assertEqual(day['completeness'], 'partial')
        self.assertEqual(day['count_quality'], 'unrecorded')
        self.assertEqual(day['total']['measured_subtotal'], 14 + 5 + 26 + 6)
        self.assertIsNone(day['total']['value'])
        self.assertIn('partial-cohort', day['flags'])
        # the unreadable row's own numbers (100, 50, 9) are not folded into the day anywhere
        self.assertNotIn('inspection_value', input_fresh)
        for value in (100, 150, 9, 114, 109):
            self.assertNotIn(value, [day['total']['measured_subtotal']] + [
                c.get('coverage', {}).get('resolved_subtotal') for c in day['components'].values()])

    def test_fully_measured_members_sum_with_aggregated_origin(self):
        day = one(cf.rollup_days(cf.normalize_ledger_rows(ledger([
            row('claude:fab-1', '2026-10-12T12:00:00.000Z', 12, 4, 2, 0, 25, 18),
            row('claude:fab-2', '2026-10-12T13:00:00.000Z', 8, 0, 4, 0, 15, 12)]), 'fab-ledger', TZ)))
        self.assertEqual([pv(day, n) for n in ('input_fresh', 'cache_write_total', 'cache_read', 'output')],
                         [['measured', 20], ['measured', 10], ['measured', 40], ['measured', 30]])
        self.assertEqual(day['components']['input_fresh']['origin'], 'aggregated')
        self.assertEqual(day['total']['value'], 100)
        self.assertEqual(pv(day, 'cache_write_unassigned'), ['measured_zero', 0])

    def test_assumed_one_hour_sums_into_the_day(self):
        day = one(cf.rollup_days(cf.normalize_ledger_rows(ledger([
            row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 100, 0, 0, 1, assumed=100),
            row('claude:fab-2', '2026-10-12T13:00:00.000Z', 1, 0, 50, 0, 0, 1, assumed=20)]), 'fab-ledger', TZ)))
        self.assertEqual(day['components']['cache_write_1h']['assumed_part'], 120)
        self.assertEqual(cf.validate_record(day), [])

    def test_day_assignment_follows_the_local_calendar_and_the_winning_snapshot(self):
        for tz, before, after in (('-06:00', '2026-07-20', '2026-07-21'), ('America/Denver', '2026-07-20', '2026-07-21'),
                                  ('UTC', '2026-07-21', '2026-07-21'), ('+14:00', '2026-07-21', '2026-07-21')):
            with self.subTest(tz=tz):
                early = norm_native([line('2026-07-21T05:59:59.000Z', 'fab-m', usage(1, 0, 0, 1))], tz)
                late = norm_native([line('2026-07-21T06:00:01.000Z', 'fab-m', usage(1, 0, 0, 1))], tz)
                self.assertEqual((one(early)['day']['date'], one(late)['day']['date']), (before, after))

    def test_rollup_refuses_mixed_timezones_and_unsuitable_input(self):
        cohort = norm_native([line('2026-07-21T12:00:00.000Z', 'fab-m', usage(1, 0, 0, 1))])
        mixed = copy.deepcopy(cohort)
        mixed['records'][0]['day']['timezone'] = '+01:00'
        with self.assertRaises(FormatError) as caught:
            cf.rollup_days(mixed)
        self.assertEqual(caught.exception.code, 'timezone-mismatch')
        with self.assertRaises(FormatError) as caught:
            cf.rollup_days(cf.rollup_days(cohort))
        self.assertEqual(caught.exception.code, 'rollup-requires-message-cohort-with-timezone')
        for bad in ('', 'Mars/Olympus', '+25:00', '+01:60', 5):
            with self.subTest(tz=bad):
                with self.assertRaises(FormatError) as caught:
                    cf.tzinfo_for(bad)
                self.assertEqual(caught.exception.code, 'invalid-timezone')


class Comparison(unittest.TestCase):
    def cmp(self, a_rows, b_days, tolerance=None):
        a = cf.rollup_days(cf.normalize_ledger_rows(ledger(a_rows), 'fab-ledger', TZ))
        return cf.compare(a, vendor(b_days), tolerance)

    R = row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 3, 5, 2, 30, 11)

    def unit(self, result, name, key='2026-10-12'):
        return {p['key']: p for p in result['pairs']}[key]['units'][name]

    def test_measured_zero_against_missing_is_never_equal(self):
        zero_row = row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 0, 11)
        result = self.cmp([zero_row], [ccu('2026-10-12', inputTokens=2, cacheCreationTokens=0, outputTokens=11)])
        unit = self.unit(result, 'cache_read')
        self.assertEqual((unit['relation'], unit['delta'], unit['percent_micro'], unit['reason']),
                         ('not_comparable', None, None, 'missing-in-b'))
        self.assertEqual(unit['a'], {'presence': 'measured_zero', 'value': 0})
        self.assertEqual(unit['b'], {'presence': 'missing', 'value': None, 'reason': 'absent-in-source'})
        explicit = self.cmp([zero_row], [full_day('2026-10-12', 2, 0, 0, 11)])
        self.assertEqual(self.unit(explicit, 'cache_read')['relation'], 'equal')

    def test_zero_against_zero_is_equal_and_zero_reference_blocks_the_percentage(self):
        equal = self.cmp([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 0, 11)],
                         [full_day('2026-10-12', 2, 0, 0, 11)])
        unit = self.unit(equal, 'cache_read')
        self.assertEqual((unit['relation'], unit['delta'], unit['percent_micro'], unit['reason']),
                         ('equal', 0, 0, 'exact-match'))
        differ = self.cmp([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 7, 11)],
                          [full_day('2026-10-12', 2, 0, 0, 11)])
        unit = self.unit(differ, 'cache_read')
        self.assertEqual((unit['relation'], unit['delta'], unit['percent_micro'], unit['reason']),
                         ('differ', 7, None, 'differ-reference-zero'))

    def test_percentage_requires_complete_quality_on_both_sides(self):
        subject = [row('claude:fab-1', '2026-10-12T12:00:00.000Z', 3, 0, 0, 0, 0, 1)]
        both_complete = self.unit(self.cmp(subject, [full_day('2026-10-12', 2, 0, 0, 1)]), 'input_fresh')
        self.assertEqual((both_complete['delta'], both_complete['percent_micro'], both_complete['reason']),
                         (1, 50000000, 'values-differ'))
        # reference side: a vendor day without its cache-read key has quality incomplete
        ref_incomplete = self.cmp(subject, [ccu('2026-10-12', inputTokens=2, cacheCreationTokens=0, outputTokens=1)], 1000000)
        unit = self.unit(ref_incomplete, 'input_fresh')
        self.assertEqual((unit['relation'], unit['delta'], unit['percent_micro'], unit['within_tolerance'], unit['reason']),
                         ('differ', 1, None, None, 'differ-quality-not-complete'))
        # subject side: same measured numbers, quality unrecorded
        a = cf.rollup_days(cf.normalize_ledger_rows(ledger(subject), 'fab-ledger', TZ))
        a['records'][0]['count_quality'] = 'unrecorded'
        b = vendor([full_day('2026-10-12', 3, 0, 0, 1)])
        result = cf.compare(a, b, 1000000)
        unit = self.unit(result, 'input_fresh')
        self.assertEqual((unit['relation'], unit['delta'], unit['percent_micro'], unit['within_tolerance'], unit['reason']),
                         ('equal', 0, None, None, 'equal-quality-not-complete'))
        self.assertEqual(result['pairs'][0]['outcome'], 'unresolved')  # equal values under unverified quality are not identical
        self.assertEqual(cf.validate_result(result), [])

    def test_tolerance_is_per_unit_and_never_true_without_a_percentage(self):
        result = self.cmp([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 2, 0, 0, 0, 0, 11)],
                          [full_day('2026-10-12', 3, 0, 0, 11)], tolerance=1000000)
        self.assertIs(self.unit(result, 'input_fresh')['within_tolerance'], False)  # 33.33% > 1%
        self.assertIs(self.unit(result, 'output')['within_tolerance'], True)
        self.assertIsNone(self.unit(result, 'reasoning')['within_tolerance'])
        self.assertIsNone(self.unit(result, 'cache_write_5m')['within_tolerance'])
        self.assertEqual(cf.validate_result(result), [])

    def test_tolerance_boundary_is_inclusive_on_the_rounded_micro_percentage(self):
        subject = [row('claude:fab-1', '2026-10-12T12:00:00.000Z', 100, 0, 0, 0, 0, 0)]
        for tolerance, want in ((990099, True), (990098, False), (1000000, True)):
            with self.subTest(tolerance=tolerance):
                result = self.cmp(subject, [full_day('2026-10-12', 101, 0, 0, 0)], tolerance=tolerance)
                unit = self.unit(result, 'input_fresh')
                self.assertEqual((unit['delta'], unit['percent_micro']), (-1, 990099))  # 1/101 = 0.990099...%
                self.assertIs(unit['within_tolerance'], want)
        with self.assertRaises(FormatError) as caught:
            cf.compare(cf.normalize_ledger_rows(ledger([]), 'x', TZ), cf.normalize_ledger_rows(ledger([]), 'y', TZ), -1)
        self.assertEqual(caught.exception.code, 'invalid-tolerance')

    def test_reference_side_is_b_for_delta_and_percentage(self):
        def input_unit(subject_input, reference_input):
            result = self.cmp([row('claude:fab-1', '2026-10-12T12:00:00.000Z', subject_input, 0, 0, 0, 0, 1)],
                              [full_day('2026-10-12', reference_input, 0, 0, 1)])
            return self.unit(result, 'input_fresh')
        forward, backward = input_unit(3, 2), input_unit(2, 3)
        self.assertEqual((forward['delta'], forward['percent_micro']), (1, 50000000))     # +1 relative to 2
        self.assertEqual((backward['delta'], backward['percent_micro']), (-1, 33333333))  # -1 relative to 3

    def test_count_quality_not_complete_withholds_the_total_though_every_component_is_measured(self):
        stored = cf.load_json_file(CASES / 'legacy-comparator-output' / 'legacy-output.json')
        for quality, withheld in (('complete', False), ('unrecorded', False), ('incomplete', True),
                                  ('invalid', True), ('conflict', True)):
            with self.subTest(quality=quality):
                report = copy.deepcopy(stored)
                report['countQualityRows'] = {'None' if quality == 'unrecorded' else quality: 3}
                record = [r for r in cf.from_legacy_output(report, 'fab-a', 'fab-b')[0]['records']
                          if r['identity']['key'] == '2026-10-10'][0]
                self.assertEqual(record['count_quality'], quality)
                self.assertEqual([pv(record, n)[0] for n in cf.TOTAL_PARTS], ['measured'] * 4)
                self.assertEqual(record['completeness'], 'complete')
                self.assertEqual(record['total']['measured_subtotal'], 25)
                if withheld:
                    self.assertEqual((record['total']['value'], record['total']['reason']),
                                     (None, 'count-quality-not-complete'))
                else:
                    self.assertEqual(record['total']['value'], 25)
                self.assertEqual(cf.validate_record(record), [])
                forged = copy.deepcopy(record)
                forged['total'] = dict(record['total'], presence='measured', value=25)
                forged['total'].pop('reason', None)
                self.assertEqual(bool(cf.validate_record(forged)), withheld)

    def test_totals_equal_components_differ_is_flagged_and_not_identical(self):
        result = self.cmp([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 20, 5, 5, 0, 40, 30)],
                          [full_day('2026-10-12', 10, 20, 30, 40)])
        pair = result['pairs'][0]
        self.assertEqual(self.unit(result, 'total')['relation'], 'equal')
        self.assertEqual((pair['outcome'], pair['flags']), ('differs', ['totals-equal-components-differ']))
        self.assertEqual(result['summary']['totals_equal_components_differ'], 1)

    def test_a_day_on_one_side_only_is_reported_as_such_not_as_a_zero_day(self):
        result = self.cmp([row('claude:fab-1', '2026-10-11T12:00:00.000Z', 1, 0, 0, 0, 0, 1)],
                          [full_day('2026-10-12', 1, 0, 0, 1)])
        self.assertEqual({p['key']: p['outcome'] for p in result['pairs']}, {'2026-10-11': 'only_in_a', '2026-10-12': 'only_in_b'})
        self.assertTrue(all(p['units'] is None for p in result['pairs']))
        self.assertEqual((result['summary']['matched'], result['summary']['only_in_a'], result['summary']['only_in_b']), (0, 1, 1))

    def test_a_partial_day_whose_subtotal_equals_the_reference_total_is_not_a_match(self):
        result = cf.load_json_file(CASES / 'v04-vendor-partial-day' / 'result.json')
        day = {p['key']: p for p in result['pairs']}['2026-10-12']
        self.assertEqual(day['outcome'], 'unresolved')
        self.assertEqual(day['units']['total']['relation'], 'not_comparable')
        self.assertIsNone(day['units']['total']['a']['value'])
        cohort = cf.load_json_file(CASES / 'v04-vendor-partial-day' / 'a.cohort.json')
        self.assertEqual(cohort['records'][0]['total']['measured_subtotal'], 51)  # equals the vendor day total
        self.assertEqual(cohort['completeness'], 'partial')

    def test_policy_assigned_one_hour_makes_only_the_ttl_leaves_incomparable(self):
        a = cf.normalize_ledger_rows(ledger([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 0, 100, 0, 0, 1, assumed=100)]), 'x', TZ)
        b = norm_native([line('2026-10-12T12:00:00.000Z', 'fab-1', usage(1, 100, 0, 1))])
        result = cf.compare(a, b)
        units = result['pairs'][0]['units']
        for leaf in cf.LEAVES:
            self.assertEqual((units[leaf]['relation'], units[leaf]['reason']), ('not_comparable', 'cache-ttl-assumed'), leaf)
        self.assertEqual((units['cache_write_total']['relation'], units['total']['relation']), ('equal', 'equal'))
        self.assertEqual(result['pairs'][0]['outcome'], 'identical')
        self.assertEqual(cf.validate_result(result), [])

    def test_unknown_leaf_comparison_without_assumption_is_by_value(self):
        a = cf.normalize_ledger_rows(ledger([row('claude:fab-1', '2026-10-12T12:00:00.000Z', 1, 60, 40, 0, 0, 1)]), 'x', TZ)
        b = norm_native([line('2026-10-12T12:00:00.000Z', 'fab-1', usage(1, 100, 0, 1, five=50, hour=50))])
        result = cf.compare(a, b)
        units = result['pairs'][0]['units']
        self.assertEqual((units['cache_write_5m']['delta'], units['cache_write_1h']['delta']), (10, -10))
        self.assertEqual(units['cache_write_total']['relation'], 'equal')
        self.assertEqual(result['pairs'][0]['outcome'], 'differs')
        self.assertEqual(result['pairs'][0]['flags'], ['totals-equal-components-differ'])

    def test_not_applicable_on_both_sides_does_not_block_an_identical_outcome(self):
        cohorts = {k: cf.load_json_file(CASES / 'n07-local-engine-counters' / k) for k in ('a.cohort.json', 'b.cohort.json')}
        result = cf.compare(cohorts['a.cohort.json'], cohorts['b.cohort.json'])
        first = {p['key']: p for p in result['pairs']}['fab-ollama-01']
        self.assertEqual(first['outcome'], 'identical')
        self.assertEqual(first['units']['cache_write_total']['reason'], 'not-applicable-in-both')
        one_sided = copy.deepcopy(cohorts['a.cohort.json'])
        record = one_sided['records'][0]
        record['components']['cache_write_total'] = {'presence': 'measured_zero', 'value': 0, 'origin': 'normalized'}
        record['total'], record['completeness'] = cf.compute_total(record['components'], record['count_quality'])
        again = cf.compare(one_sided, cohorts['b.cohort.json'])
        self.assertEqual({p['key']: p for p in again['pairs']}['fab-ollama-01']['units']['cache_write_total']['reason'],
                         'not-applicable-in-b')
        self.assertEqual({p['key']: p for p in again['pairs']}['fab-ollama-01']['outcome'], 'unresolved')

    def test_invalid_inputs_are_refused_before_comparing(self):
        a = cf.rollup_days(cf.normalize_ledger_rows(ledger([self.R]), 'x', TZ))
        message = cf.normalize_ledger_rows(ledger([self.R]), 'x', TZ)
        with self.assertRaises(FormatError) as caught:
            cf.compare(a, message)
        self.assertEqual(caught.exception.code, 'scope-mismatch')
        other_tz = cf.rollup_days(cf.normalize_ledger_rows(ledger([self.R]), 'x', '+01:00'))
        with self.assertRaises(FormatError) as caught:
            cf.compare(a, other_tz)
        self.assertEqual(caught.exception.code, 'timezone-mismatch')
        broken = copy.deepcopy(a)
        broken['records'][0]['total']['value'] = 1
        with self.assertRaises(FormatError) as caught:
            cf.compare(a, broken)
        self.assertEqual(caught.exception.code, 'invalid-cohort')
        self.assertTrue(caught.exception.problems)

    def test_result_records_cohort_digests_that_bind_it_to_its_inputs(self):
        a = cf.rollup_days(cf.normalize_ledger_rows(ledger([self.R]), 'fab-ledger', TZ))
        b = vendor([full_day('2026-10-12', 2, 10, 30, 11)])
        result = cf.compare(a, b)
        self.assertEqual(result['a']['sha256'], cf.sha256_of(a))
        self.assertEqual(result['b']['sha256'], cf.sha256_of(b))
        changed = vendor([full_day('2026-10-12', 2, 10, 30, 12)])
        self.assertNotEqual(cf.compare(a, changed)['b']['sha256'], result['b']['sha256'])


def read_expectations(name):
    return cf.load_json_file(CASES / name / 'case.json')['expect']


class FixtureCases(unittest.TestCase):
    """Generated below: one golden-bytes test and one hand-expectation test per case directory."""

    def test_the_case_inventory_is_exactly_the_declared_set(self):
        found = sorted(p.name for p in CASES.iterdir() if p.is_dir())
        self.assertEqual(found, EXPECTED_CASES)
        for name in found:
            self.assertEqual(sorted(p.name for p in (CASES / name).iterdir()),
                             sorted(['case.json', 'a.cohort.json', 'b.cohort.json', 'result.json'] +
                                    (['legacy-output.json'] if name.startswith('legacy') else ['a.input.json', 'b.input.json'])), name)

    def test_fixtures_are_lf_utf8_without_bom_and_hold_no_environment_text(self):
        pattern = re.compile(r'(/home/|/Users/|/tmp/|[A-Za-z]:\\|https?://|@[A-Za-z0-9-]+\.|BEGIN [A-Z ]*KEY|sk-[A-Za-z0-9]{8})')
        for path in sorted(FIX.rglob('*')):
            if path.is_file():
                data = path.read_bytes()
                self.assertFalse(data.startswith(b'\xef\xbb\xbf'), path.name)
                self.assertNotIn(b'\r', data, path.name)
                self.assertTrue(data.endswith(b'\n') and not data.endswith(b'\n\n'), path.name)
                text = data.decode('utf-8')
                self.assertIsNone(pattern.search(text), path.name)

    def test_readme_declares_every_value_fabricated(self):
        text = (FIX / 'README.md').read_text(encoding='utf-8')
        self.assertIn('fabricated', text.lower())
        for name in EXPECTED_CASES:
            self.assertIn(name, text)


def check_expectations(test, name, a, b, result):
    exp = read_expectations(name)
    for key, value in exp['summary'].items():
        test.assertEqual(result['summary'][key], value, (name, 'summary', key))
    pairs = {p['key']: p for p in result['pairs']}
    for key, want in exp['pairs'].items():
        pair = pairs[key]
        test.assertEqual(pair['outcome'], want['outcome'], (name, key))
        if 'flags' in want:
            test.assertEqual(pair['flags'], want['flags'], (name, key))
        for unit, expected in want.get('units', {}).items():
            got = pair['units'][unit]
            test.assertEqual([got['relation'], got['delta'], got['percent_micro'], got['reason']], expected[:4], (name, key, unit))
            if len(expected) > 4:
                test.assertEqual(got['within_tolerance'], expected[4], (name, key, unit))
    for side, cohort in (('a', a), ('b', b)):
        records = {r['identity']['key']: r for r in cohort['records']}
        for key, want in exp.get('records', {}).get(side, {}).items():
            record = records[key]
            where = (name, side, key)
            for field in ('count_quality', 'completeness'):
                if field in want:
                    test.assertEqual(record[field], want[field], where + (field,))
            if 'total' in want:
                test.assertEqual(record['total']['value'], want['total'], where)
            for field in ('measured_subtotal', 'unresolved'):
                if field in want:
                    test.assertEqual(record['total'][field], want[field], where + (field,))
            if 'flags' in want:
                test.assertEqual(record['flags'], want['flags'], where)
            for field, sub in (('evidence', record['evidence']), ('identity', record['identity'])):
                for k, v in want.get(field, {}).items():
                    test.assertEqual(sub[k], v, where + (field, k))
            if 'time' in want:
                test.assertEqual(record['time']['utc_ms'], want['time'], where)
            if 'day' in want:
                test.assertEqual(record['day']['date'], want['day'], where)
            for component, (presence, value) in want.get('components', {}).items():
                test.assertEqual(pv(record, component), [presence, value], where + (component,))
            for component, triple in want.get('coverage', {}).items():
                c = record['components'][component]['coverage']
                test.assertEqual([c['parts'], c['resolved'], c['resolved_subtotal']], triple, where + (component,))
            for component, value in want.get('assumed_part', {}).items():
                test.assertEqual(record['components'][component]['assumed_part'], value, where)
            for component, value in want.get('inspection', {}).items():
                test.assertEqual(record['components'][component]['inspection_value'], value, where + (component,))
    for side, cohort in (('a', a), ('b', b)):
        if side in exp.get('dropped', {}):
            test.assertEqual({d['reason']: d['count'] for d in cohort['dropped']}, exp['dropped'][side], (name, side))
        if side + '_completeness' in exp.get('dropped', {}):
            test.assertEqual(cohort['completeness'], exp['dropped'][side + '_completeness'], (name, side))


def add_case_tests():
    def make(name):
        def golden(self):
            outputs = cf.build_case(CASES / name)
            self.assertEqual(sorted(outputs), ['a.cohort.json', 'b.cohort.json', 'result.json'])
            for filename, text in outputs.items():
                self.assertEqual((CASES / name / filename).read_bytes(), text.encode('utf-8'), (name, filename))

        def hand(self):
            outputs = cf.build_case(CASES / name)
            a, b, result = (json.loads(outputs[k]) for k in ('a.cohort.json', 'b.cohort.json', 'result.json'))
            check_expectations(self, name, a, b, result)
        return golden, hand
    for name in EXPECTED_CASES:
        golden, hand = make(name)
        safe = name.replace('-', '_')
        setattr(FixtureCases, 'test_golden_bytes_' + safe, golden)
        setattr(FixtureCases, 'test_hand_expectations_' + safe, hand)


add_case_tests()


class Refusals(unittest.TestCase):
    def test_every_refusal_fixture_is_refused_with_its_declared_fixed_code(self):
        folder = FIX / 'refusals'
        manifest = cf.load_json_file(folder / 'manifest.json')
        self.assertEqual(sorted(e['file'] for e in manifest['refusals']),
                         sorted(p.name for p in folder.iterdir() if p.name != 'manifest.json'))
        for entry in manifest['refusals']:
            with self.subTest(entry['file']):
                document = cf.load_json_file(folder / entry['file'])
                if entry['via'] == 'normalize':
                    with self.assertRaises(FormatError) as caught:
                        cf.normalize_document(document, 'fab-refusal', TZ)
                    self.assertEqual(caught.exception.code, entry['code'])
                else:
                    self.assertIn(entry['code'], cf.validate_cohort(document))

    def test_a_refused_duplicate_is_never_resolved_by_keeping_one_row(self):
        document = cf.load_json_file(FIX / 'refusals' / 'ledger-duplicate-id.json')
        self.assertEqual(len(document['rows']), 2)
        for rows in (document['rows'], list(reversed(document['rows'])), document['rows'][:1] * 2):
            with self.assertRaises(FormatError) as caught:
                cf.normalize_ledger_rows(dict(document, rows=rows), 'fab-ledger', TZ)
            self.assertEqual(caught.exception.code, 'duplicate-identity')


class Determinism(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)] + list(args), capture_output=True, timeout=30)

    def test_two_complete_builds_are_byte_identical(self):
        first = {n: cf.build_case(CASES / n) for n in EXPECTED_CASES}
        second = {n: cf.build_case(CASES / n) for n in EXPECTED_CASES}
        self.assertEqual(first, second)

    def test_cli_normalize_and_compare_reproduce_the_golden_bytes_in_separate_processes(self):
        case = CASES / 'v03-vendor-totals-equal-components-differ'
        with tempfile.TemporaryDirectory() as tmp:
            outputs = []
            for run in (1, 2):
                a = self.run_cli('normalize', '--input', str(case / 'a.input.json'), '--instance', 'fab-ledger-v03',
                                 '--timezone=' + TZ, '--rollup-days')
                b = self.run_cli('normalize', '--input', str(case / 'b.input.json'), '--instance', 'fab-ccusage-v03',
                                 '--timezone=' + TZ)
                self.assertEqual((a.returncode, b.returncode, a.stderr, b.stderr), (0, 0, b'', b''))
                pa, pb = Path(tmp) / ('a%d.json' % run), Path(tmp) / ('b%d.json' % run)
                pa.write_bytes(a.stdout)
                pb.write_bytes(b.stdout)
                c = self.run_cli('compare', '--a', str(pa), '--b', str(pb), '--tolerance-percent-micro', '1000000')
                self.assertEqual((c.returncode, c.stderr), (0, b''))
                outputs.append((a.stdout, b.stdout, c.stdout))
            self.assertEqual(outputs[0], outputs[1])
            self.assertEqual(outputs[0][0], (case / 'a.cohort.json').read_bytes())
            self.assertEqual(outputs[0][1], (case / 'b.cohort.json').read_bytes())
            self.assertEqual(outputs[0][2], (case / 'result.json').read_bytes())
            valid = self.run_cli('validate', '--kind', 'result', '--input', str(case / 'result.json'))
            self.assertEqual((valid.returncode, valid.stdout), (0, b'valid\n'))

    def test_cli_failures_are_fixed_codes_that_never_echo_input(self):
        sentinel = 'private fixture text must never be echoed'
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / 'bad.json'
            for content, args in ((sentinel, ['normalize', '--instance', 'fab', '--timezone=' + TZ]),
                                  (json.dumps({'daily': [{'date': sentinel}]}), ['normalize', '--instance', 'fab', '--timezone=' + TZ]),
                                  (json.dumps({'kind': sentinel, 'rows': []}), ['normalize', '--instance', 'fab', '--timezone=' + TZ]),
                                  (json.dumps({sentinel: 1}), ['validate', '--kind', 'record'])):
                with self.subTest(args=args[0], content=content[:12]):
                    bad.write_text(content, encoding='utf-8')
                    result = self.run_cli(*(args + ['--input', str(bad)]))
                    self.assertEqual(result.returncode, 2)
                    self.assertNotIn(sentinel.encode(), result.stdout + result.stderr)
                    report = json.loads(result.stderr)
                    self.assertIs(report['accepted'], False)
                    self.assertRegex(report['errorCode'], r'^[a-z0-9-]+$')
            missing = self.run_cli('validate', '--kind', 'record', '--input', str(Path(tmp) / 'absent.json'))
            self.assertEqual((missing.returncode, json.loads(missing.stderr)['errorCode']), (2, 'unreadable-input'))

    def test_importing_and_running_leaves_no_bytecode_next_to_the_script(self):
        self.assertEqual(list((ROOT / 'scripts').glob('__pycache__/comparator-formats*')), [])
        self.assertEqual(list((ROOT / 'scripts').glob('__pycache__/test-comparator-formats*')), [])


class LegacyComparatorMapping(unittest.TestCase):
    """Characterizes what the output of scripts/compare-claude-ccusage.py can and cannot express.
    These tests pass on the current script; they describe it and do not assert that it is defective."""

    @classmethod
    def setUpClass(cls):
        cls.legacy = load_module('legacy_comparison', ROOT / 'scripts' / 'compare-claude-ccusage.py')

    def run_legacy(self, rows, report_days, first='2026-10-09', last='2026-10-12'):
        with tempfile.TemporaryDirectory(prefix='tokenelo-comparator-formats-') as tmp:
            database, report = Path(tmp) / 'owned.sqlite', Path(tmp) / 'ccusage.json'
            with closing(sqlite3.connect(database, isolation_level=None)) as c:
                c.executescript('''CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('schema_version','10');
                    CREATE TABLE event_projection_basis(singleton INTEGER, policy INTEGER); INSERT INTO event_projection_basis VALUES(1,7);
                    CREATE TABLE event_projection(id TEXT, source TEXT, ts INTEGER, input_fresh INTEGER, cache_write_5m INTEGER,
                        cache_write_1h INTEGER, cache_write_unassigned INTEGER, cache_read INTEGER, output INTEGER, count_quality TEXT);''')
                for rid, ts, values, quality in rows:
                    c.execute('INSERT INTO event_projection VALUES(?,?,?,?,?,?,?,?,?,?)', (rid, 'claude', T(ts), *values, quality))
            report.write_text(json.dumps({'daily': report_days}))
            return self.legacy.compare(database, report, first, last, 'America/Denver')

    def test_the_checked_in_legacy_output_is_what_the_current_script_produces(self):
        rows = [('fab-leg-1', '2026-10-10T12:00:00.000Z', (5, 2, 3, 1, 10, 4), 'complete'),
                ('fab-leg-2', '2026-10-11T12:00:00.000Z', (7, 0, 0, 0, 0, 3), 'complete'),
                ('fab-leg-3', '2026-10-12T12:00:00.000Z', (20, 4, 2, 0, 40, 30), 'complete')]
        days = [{'date': '2026-10-10', 'inputTokens': 5, 'cacheCreationTokens': 6, 'cacheReadTokens': 10, 'outputTokens': 4, 'totalTokens': 25},
                {'date': '2026-10-12', 'inputTokens': 10, 'cacheCreationTokens': 16, 'cacheReadTokens': 30, 'outputTokens': 40, 'totalTokens': 96}]
        live = self.run_legacy(rows, days)
        stored = cf.parse_json((CASES / 'legacy-comparator-output' / 'legacy-output.json').read_text(encoding='utf-8'))
        self.assertEqual(json.loads(json.dumps(live)), stored)

    def test_legacy_output_carries_five_sums_and_nothing_finer(self):
        stored = cf.load_json_file(CASES / 'legacy-comparator-output' / 'legacy-output.json')
        for day in stored['dailyComparisons']:
            self.assertEqual(sorted(day['comparison']), ['cacheCreationTokens', 'cacheReadTokens', 'inputTokens',
                                                         'outputTokens', 'totalTokens'])
        a, b = cf.from_legacy_output(stored, 'fab-a', 'fab-b')
        for cohort in (a, b):
            for record in cohort['records']:
                for name in cf.LEAVES + ('reasoning',):
                    self.assertEqual(record['components'][name]['reason'], 'legacy-output-lacks-component', name)

    def test_different_cache_ttl_splits_with_the_same_sum_give_identical_legacy_day_output(self):
        day = [{'date': '2026-10-12', 'inputTokens': 2, 'cacheCreationTokens': 10, 'cacheReadTokens': 30, 'outputTokens': 11, 'totalTokens': 53}]
        split = self.run_legacy([('x', '2026-10-12T12:00:00.000Z', (2, 3, 5, 2, 30, 11), 'complete')], day)
        one_bucket = self.run_legacy([('y', '2026-10-12T12:00:00.000Z', (2, 10, 0, 0, 30, 11), 'complete')], day)
        self.assertEqual(split['dailyComparisons'], one_bucket['dailyComparisons'])
        a1, _ = cf.from_legacy_output(json.loads(json.dumps(split)), 'fab-a', 'fab-b')
        a2, _ = cf.from_legacy_output(json.loads(json.dumps(one_bucket)), 'fab-a', 'fab-b')
        self.assertEqual(cf.dumps(a1), cf.dumps(a2))  # the split is gone before the canonical format sees it
        canonical = [one(cf.normalize_ledger_rows(ledger([row('claude:x', '2026-10-12T12:00:00.000Z', 2, *v, 30, 11)]), 'fab', TZ))
                     for v in ((3, 5, 2), (10, 0, 0))]
        # the canonical ledger mapping keeps what the legacy day output has already lost
        self.assertEqual([r['components']['cache_write_5m']['value'] for r in canonical], [3, 10])
        self.assertEqual([r['components']['cache_write_total']['value'] for r in canonical], [10, 10])

    def test_an_absent_reference_day_and_an_explicit_all_zero_day_are_indistinguishable_in_legacy_output(self):
        rows = [('x', '2026-10-12T12:00:00.000Z', (2, 3, 5, 2, 30, 11), 'complete')]
        absent = self.run_legacy(rows, [])
        zero_day = self.run_legacy(rows, [{'date': '2026-10-12', 'inputTokens': 0, 'cacheCreationTokens': 0,
                                           'cacheReadTokens': 0, 'outputTokens': 0, 'totalTokens': 0}])
        self.assertEqual(absent['dailyComparisons'], zero_day['dailyComparisons'])
        _, b = cf.from_legacy_output(json.loads(json.dumps(absent)), 'fab-a', 'fab-b')
        day = [r for r in b['records'] if r['identity']['key'] == '2026-10-12'][0]
        self.assertEqual(pv(day, 'input_fresh'), ['missing', None])
        self.assertEqual(day['components']['input_fresh']['reason'], 'legacy-zero-total-may-be-absent')
        self.assertEqual(day['components']['input_fresh']['inspection_value'], 0)

    def test_per_day_output_does_not_say_which_count_quality_the_numbers_have(self):
        day = [{'date': '2026-10-12', 'inputTokens': 2, 'cacheCreationTokens': 10, 'cacheReadTokens': 30, 'outputTokens': 11, 'totalTokens': 53}]
        values = (2, 3, 5, 2, 30, 11)
        complete = self.run_legacy([('x', '2026-10-12T12:00:00.000Z', values, 'complete')], day)
        conflict = self.run_legacy([('x', '2026-10-12T12:00:00.000Z', values, 'conflict')], day)
        self.assertEqual(complete['dailyComparisons'], conflict['dailyComparisons'])
        self.assertTrue(conflict['allDailyTotalsWithinOnePercent'])
        self.assertNotEqual(complete['countQualityRows'], conflict['countQualityRows'])
        a_conflict, _ = cf.from_legacy_output(json.loads(json.dumps(conflict)), 'fab-a', 'fab-b')
        self.assertEqual(a_conflict['records'][0]['count_quality'], 'conflict')
        a_complete, _ = cf.from_legacy_output(json.loads(json.dumps(complete)), 'fab-a', 'fab-b')
        self.assertEqual(a_complete['records'][0]['count_quality'], 'complete')

    def test_legacy_quality_summary_maps_to_the_weakest_present_quality(self):
        for counts, want in (({'complete': 3}, 'complete'), ({'complete': 2, 'None': 1}, 'unrecorded'),
                             ({'complete': 2, 'conflict': 1}, 'conflict'), ({}, 'unrecorded'),
                             ({'complete': 1, 'incomplete': 1, 'invalid': 1}, 'invalid'), ({'mystery': 1}, 'invalid')):
            with self.subTest(counts=counts):
                self.assertEqual(cf.legacy_quality({'countQualityRows': counts}), want)

    def test_mapped_legacy_days_agree_with_the_legacy_deltas_and_percentages(self):
        stored = cf.load_json_file(CASES / 'legacy-comparator-output' / 'legacy-output.json')
        a, b = cf.from_legacy_output(stored, 'fab-a', 'fab-b')
        result = cf.compare(a, b)
        pairs = {p['key']: p for p in result['pairs']}
        legacy_names = {'input_fresh': 'inputTokens', 'cache_write_total': 'cacheCreationTokens',
                        'cache_read': 'cacheReadTokens', 'output': 'outputTokens', 'total': 'totalTokens'}
        checked = 0
        for day in stored['dailyComparisons']:
            pair = pairs.get(day['date'])
            if pair is None or pair['units'] is None or pair['outcome'] == 'unresolved':
                continue
            for unit, legacy_name in legacy_names.items():
                legacy = day['comparison'][legacy_name]
                got = pair['units'][unit]
                self.assertEqual(got['delta'], legacy['delta'], (day['date'], unit))
                self.assertAlmostEqual(got['percent_micro'] / 1e6, legacy['absolutePercentOfCcusage'], places=5)
                checked += 1
        self.assertEqual(checked, 10)  # two comparable days x five units
        self.assertEqual({d['reason'] for d in a['dropped']} | {d['reason'] for d in b['dropped']}, {'legacy-empty-both-day'})
        self.assertNotIn('2026-10-09', pairs)

    def test_the_comparison_result_carries_no_pass_or_fail_verdict(self):
        stored = cf.load_json_file(CASES / 'legacy-comparator-output' / 'legacy-output.json')
        self.assertIn('allDailyTotalsWithinOnePercent', stored)  # the legacy output has such a verdict
        result = cf.compare(*cf.from_legacy_output(stored, 'fab-a', 'fab-b'))
        self.assertEqual(sorted(result), ['a', 'b', 'format', 'pairs', 'reference_side', 'scope', 'summary',
                                          'timezone', 'tolerance_percent_micro'])
        self.assertIsNone(result['tolerance_percent_micro'])


if __name__ == '__main__':
    unittest.main()
