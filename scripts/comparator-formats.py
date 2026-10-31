"""Reference normalizer, validator and comparator for the Tokenelo comparator interchange formats.

Specification: docs/reviews/2026-10-18-comparator-formats/FORMATS.md (schemas beside it).
Python 3.9+, standard library only. Reads only the files named on the command line; no network, no
database, no product imports, no model or vendor calls. Inputs must be synthetic or owned.

This module defines and checks data formats. It closes no acceptance gate: it does not establish the
original 1% count gate, exact native-50, per-thread or vendor baselines, or any real-data result.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True

FORMAT_RECORD = 'tokenelo/comparator-count-record@v1'
FORMAT_COHORT = 'tokenelo/comparator-cohort@v1'
FORMAT_RESULT = 'tokenelo/comparator-result@v1'
SAFE_MAX = 2 ** 53 - 1

LEAVES = ('cache_write_5m', 'cache_write_1h', 'cache_write_unassigned')
COMPONENTS = ('input_fresh', 'cache_write_5m', 'cache_write_1h', 'cache_write_unassigned',
              'cache_write_total', 'cache_read', 'output', 'reasoning')
TOTAL_PARTS = ('input_fresh', 'cache_write_total', 'cache_read', 'output')
UNITS = ('input_fresh', 'cache_write_total', 'cache_write_5m', 'cache_write_1h', 'cache_write_unassigned',
         'cache_read', 'output', 'reasoning', 'total')
MEASURED = ('measured', 'measured_zero')
QUALITY_RANK = {'complete': 0, 'unrecorded': 1, 'incomplete': 2, 'invalid': 3, 'conflict': 4}
UNREADABLE_DROPS = frozenset(['invalid-timestamp', 'no-identity'])
LOCAL_SOURCES = frozenset(['ollama'])
SCHEMA_DIR = Path(__file__).resolve().parent.parent / 'docs' / 'reviews' / '2026-10-18-comparator-formats' / 'schemas'
KEY_RE = re.compile(r'^[A-Za-z0-9._:+-]{1,200}$')
LABEL_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')
DATE_RE = re.compile(r'^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
TS_RE = re.compile(r'^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z$')


class FormatError(ValueError):
    """Carries only a fixed safe code. Input content is never placed in the message."""

    def __init__(self, code, problems=None):
        super().__init__(code)
        self.code = code
        self.problems = list(problems or [])


# ---------------------------------------------------------------------------------------------
# Serialization

def _reject_floats(value):
    if isinstance(value, float):
        raise FormatError('non-integer-number')
    if isinstance(value, dict):
        for item in value.values():
            _reject_floats(item)
    elif isinstance(value, list):
        for item in value:
            _reject_floats(item)


def _scalar(value):
    return not isinstance(value, (dict, list))


def _emit(value, depth):
    pad, inner = '  ' * depth, '  ' * (depth + 1)
    if isinstance(value, dict):
        if all(_scalar(v) for v in value.values()):
            return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(', ', ': '))
        members = ',\n'.join('%s%s: %s' % (inner, json.dumps(k, ensure_ascii=True), _emit(v, depth + 1))
                             for k, v in sorted(value.items()))
        return '{\n' + members + '\n' + pad + '}'
    if isinstance(value, list):
        if all(_scalar(v) for v in value):
            return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(', ', ': '))
        return '[\n' + ',\n'.join(inner + _emit(v, depth + 1) for v in value) + '\n' + pad + ']'
    return json.dumps(value, ensure_ascii=True, allow_nan=False)


def dumps(value):
    """Canonical bytes (FORMATS.md 6.1): keys sorted by code point, two-space indent, a container whose
    members are all scalars is written on one line with ', ' and ': ', ASCII escapes, integers only,
    exactly one final LF."""
    _reject_floats(value)
    return _emit(value, 0) + '\n'


def sha256_of(value):
    return hashlib.sha256(dumps(value).encode('utf-8')).hexdigest()


def parse_json(text):
    """Strict parse: duplicate object keys and NaN/Infinity are refused, not resolved."""
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise FormatError('duplicate-json-key')
            result[key] = item
        return result

    def constant(_name):
        raise FormatError('invalid-json-constant')
    try:
        return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)
    except FormatError:
        raise
    except (ValueError, RecursionError):
        raise FormatError('invalid-json')


def load_json_file(path):
    return parse_json(Path(path).read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------------------------
# Component constructors and shared primitives

def is_count(value):
    return type(value) is int and 0 <= value <= SAFE_MAX


def weakest(a, b):
    return a if QUALITY_RANK[a] >= QUALITY_RANK[b] else b


def measured(value, origin, **extra):
    result = {'presence': 'measured' if value > 0 else 'measured_zero', 'value': value, 'origin': origin}
    result.update(extra)
    return result


def missing(reason, **extra):
    result = {'presence': 'missing', 'value': None, 'reason': reason}
    result.update(extra)
    return result


def invalid(reason, **extra):
    result = {'presence': 'invalid', 'value': None, 'reason': reason}
    result.update(extra)
    return result


def not_applicable(reason='category-not-applicable'):
    return {'presence': 'not_applicable', 'value': None, 'reason': reason}


def observe(obj, key):
    """('reported', n) for a safe nonnegative integer, ('missing', None) for an absent key and
    ('invalid', None) for anything else, including null, booleans, floats and negatives."""
    if not isinstance(obj, dict) or key not in obj:
        return ('missing', None)
    value = obj[key]
    return ('reported', value) if is_count(value) else ('invalid', None)


def from_obs(obs, origin='reported', absent_reason='absent-in-source'):
    state, value = obs
    if state == 'reported':
        return measured(value, origin)
    if state == 'invalid':
        return invalid('invalid-count-value')
    return missing(absent_reason)


def merge_obs(a, b):
    """Field-wise maximum of reported values; invalid is absorbing; missing never becomes zero."""
    if a[0] == 'invalid' or b[0] == 'invalid':
        return ('invalid', None)
    if a[0] == 'reported' and b[0] == 'reported':
        return ('reported', max(a[1], b[1]))
    if a[0] == 'reported':
        return a
    if b[0] == 'reported':
        return b
    return ('missing', None)


def parse_timestamp(text):
    if not isinstance(text, str):
        return None
    m = TS_RE.match(text)
    if not m:
        return None
    year, month, day, hour, minute, second = (int(m.group(i)) for i in range(1, 7))
    millis = int((m.group(7) or '0').ljust(3, '0'))
    try:
        moment = dt.datetime(year, month, day, hour, minute, second, tzinfo=dt.timezone.utc)
    except ValueError:
        return None
    ms = (moment - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)) // dt.timedelta(milliseconds=1) + millis
    return ms if 0 <= ms <= SAFE_MAX else None


def tzinfo_for(name):
    if not isinstance(name, str):
        raise FormatError('invalid-timezone')
    if name == 'UTC':
        return dt.timezone.utc
    m = re.fullmatch(r'([+-])([0-9]{2}):([0-9]{2})', name)
    if m:
        hours, minutes = int(m.group(2)), int(m.group(3))
        if hours > 23 or minutes > 59:
            raise FormatError('invalid-timezone')
        delta = dt.timedelta(hours=hours, minutes=minutes)
        return dt.timezone(delta if m.group(1) == '+' else -delta)
    if not re.fullmatch(r'[A-Za-z_]+(/[A-Za-z0-9_+-]+)+', name):
        raise FormatError('invalid-timezone')
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception:
        raise FormatError('invalid-timezone')


def local_date(utc_ms, tz):
    moment = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(milliseconds=utc_ms)
    return moment.astimezone(tz).date().isoformat()


def valid_date(text):
    if not isinstance(text, str) or not DATE_RE.match(text):
        return None
    try:
        parsed = dt.date.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.isoformat() == text else None


# ---------------------------------------------------------------------------------------------
# Totals

def compute_total(components, quality):
    """The only place a total is formed. Returns (total, completeness)."""
    unresolved, subtotal = [], 0
    for name in TOTAL_PARTS:
        component = components[name]
        if component['presence'] in MEASURED:
            subtotal += component['value']
        elif component['presence'] == 'not_applicable':
            continue
        else:
            unresolved.append(name)
            if 'coverage' in component:
                subtotal += component['coverage']['resolved_subtotal']
            elif name == 'cache_write_total':
                subtotal += sum(components[leaf]['value'] for leaf in LEAVES
                                if components[leaf]['presence'] in MEASURED)
    total = {'measured_subtotal': subtotal, 'unresolved': unresolved}
    if unresolved:
        total.update(presence='missing', value=None, reason='component-unresolved')
    elif quality in ('incomplete', 'invalid', 'conflict'):
        total.update(presence='missing', value=None, reason='count-quality-not-complete')
    else:
        total.update(presence='measured' if subtotal > 0 else 'measured_zero', value=subtotal)
    return total, 'partial' if unresolved else 'complete'


def make_record(scope, source, identity, time, day, components, quality, evidence, flags, source_total=None):
    total, completeness = compute_total(components, quality)
    record = {'format': FORMAT_RECORD, 'scope': scope, 'source': dict(source), 'identity': identity,
              'time': time, 'day': day, 'components': components, 'total': total,
              'count_quality': quality, 'completeness': completeness, 'evidence': evidence,
              'flags': sorted(set(flags))}
    if source_total is not None:
        record['source_total'] = source_total
    return record


def blank_evidence(**given):
    evidence = dict.fromkeys(('lines_observed', 'distinct_snapshots', 'sessions_observed', 'members',
                              'members_complete'))
    evidence.update(given)
    return evidence


def make_source(family, kind, instance, tool_version=None):
    if not isinstance(instance, str) or not LABEL_RE.match(instance):
        raise FormatError('invalid-label')
    return {'family': family, 'kind': kind, 'instance': instance, 'tool_version': tool_version}


def make_cohort(label, scope, source, timezone, rng, records, dropped):
    if not isinstance(label, str) or not LABEL_RE.match(label):
        raise FormatError('invalid-label')
    keys = [record['identity']['key'] for record in records]
    if len(set(keys)) != len(keys):
        raise FormatError('duplicate-identity')
    records = sorted(records, key=lambda record: record['identity']['key'])
    drops = [{'reason': reason, 'count': count, 'unreadable': reason in UNREADABLE_DROPS}
             for reason, count in sorted(dropped.items()) if count]
    partial = any(r['completeness'] == 'partial' for r in records) or any(d['unreadable'] for d in drops)
    return {'format': FORMAT_COHORT, 'label': label, 'scope': scope, 'source': dict(source),
            'timezone': timezone, 'range': rng, 'completeness': 'partial' if partial else 'complete',
            'records': records, 'dropped': drops}


# ---------------------------------------------------------------------------------------------
# Aggregation of parts (iterations within a message, messages within a day)

def aggregate(parts):
    """Sum parts only when every part is measured. Otherwise the aggregate is missing/invalid and
    carries the subtotal of the measured parts as coverage, never as a value."""
    if len(parts) == 1:
        return dict(parts[0])
    presences = [p['presence'] for p in parts]
    if all(p == 'not_applicable' for p in presences):
        return not_applicable(parts[0]['reason'])
    if any(p == 'not_applicable' for p in presences):
        resolved = [p for p in parts if p['presence'] in MEASURED]
        return missing('mixed-applicability', coverage={
            'parts': len(parts), 'resolved': len(resolved),
            'resolved_subtotal': sum(p['value'] for p in resolved)})
    resolved = [p for p in parts if p['presence'] in MEASURED]
    coverage = {'parts': len(parts), 'resolved': len(resolved),
                'resolved_subtotal': sum(p['value'] for p in resolved)}
    if any(p == 'invalid' for p in presences):
        return invalid('member-invalid', coverage=coverage)
    if len(resolved) < len(parts):
        return missing('partial-members', coverage=coverage)
    extra = {}
    assumed = sum(p.get('assumed_part', 0) for p in parts)
    if assumed:
        extra['assumed_part'] = assumed
    return measured(coverage['resolved_subtotal'], 'aggregated', coverage=coverage, **extra)


# ---------------------------------------------------------------------------------------------
# Claude native lines

def container_state(slot):
    if 'cache_creation' not in slot:
        return 'absent'
    value = slot['cache_creation']
    if value is None:
        return 'null'
    return 'present' if isinstance(value, dict) else 'malformed'


CONTAINER_RANK = {'absent': 0, 'null': 1, 'present': 2, 'malformed': 3}


def slot_observation(slot):
    container = slot.get('cache_creation') if isinstance(slot.get('cache_creation'), dict) else {}
    return {'input': observe(slot, 'input_tokens'), 'cache_read': observe(slot, 'cache_read_input_tokens'),
            'output': observe(slot, 'output_tokens'), 'flat': observe(slot, 'cache_creation_input_tokens'),
            'five': observe(container, 'ephemeral_5m_input_tokens'),
            'hour': observe(container, 'ephemeral_1h_input_tokens'), 'container': container_state(slot)}


def merge_slot(a, b):
    merged = {key: merge_obs(a[key], b[key]) for key in ('input', 'cache_read', 'output', 'flat', 'five', 'hour')}
    merged['container'] = a['container'] if CONTAINER_RANK[a['container']] >= CONTAINER_RANK[b['container']] \
        else b['container']
    return merged


def slots_incomparable(a, b):
    """Opposing movement between two distinct snapshots of one component slot."""
    up = down = False
    for key in ('input', 'cache_read', 'output', 'flat', 'five', 'hour'):
        x, y = a[key], b[key]
        if x[0] != 'reported' or y[0] != 'reported':
            continue
        up = up or y[1] > x[1]
        down = down or y[1] < x[1]
    return up and down


def project_cache(flat, five, hour, container):
    """Cache-write group of one component slot, policy 'none' (no TTL is ever assumed).
    Returns {'components': {...four cache components}, 'quality': q, 'flags': set}."""
    flags = set()
    ttl_bad = five[0] == 'invalid' or hour[0] == 'invalid' or container == 'malformed'
    if ttl_bad:
        flags.add('cache-ttl-invalid')
    leaf5 = from_obs(five, absent_reason='ttl-not-reported')
    leaf1 = from_obs(hour, absent_reason='ttl-not-reported')
    reported = [obs[1] for obs in (five, hour) if obs[0] == 'reported']
    split = sum(reported) if reported else None
    if flat[0] == 'reported':
        if split is not None and split > flat[1]:
            flags.add('cache-split-exceeds-total')
            total = missing('cache-split-exceeds-total')
            unassigned = missing('cache-split-exceeds-total')
            quality = 'conflict'
        else:
            total = measured(flat[1], 'reported')
            quality = 'complete'
            if ttl_bad:
                unassigned = missing('ttl-evidence-unusable')
            else:
                residual = flat[1] - (split or 0)
                unassigned = measured(residual, 'derived')
                if residual == 0:
                    # Leaves are nonnegative and bounded by the reported total, so a zero residual
                    # forces any unreported leaf to zero. This is arithmetic, not an assumption.
                    if leaf5['presence'] == 'missing':
                        leaf5 = measured(0, 'derived')
                    if leaf1['presence'] == 'missing':
                        leaf1 = measured(0, 'derived')
    elif flat[0] == 'invalid':
        total = invalid('invalid-count-value')
        unassigned = missing('flat-total-unresolved')
        quality = 'invalid'
    else:
        total = missing('absent-in-source')
        unassigned = missing('flat-total-unresolved')
        quality = 'incomplete'
    return {'components': {'cache_write_total': total, 'cache_write_5m': leaf5, 'cache_write_1h': leaf1,
                           'cache_write_unassigned': unassigned}, 'quality': quality, 'flags': flags}


def field_quality(obs):
    return {'reported': 'complete', 'missing': 'incomplete', 'invalid': 'invalid'}[obs[0]]


def slot_components(obs):
    components = {'input_fresh': from_obs(obs['input']), 'cache_read': from_obs(obs['cache_read']),
                  'output': from_obs(obs['output'])}
    cache = project_cache(obs['flat'], obs['five'], obs['hour'], obs['container'])
    components.update(cache['components'])
    quality = cache['quality']
    for key in ('input', 'cache_read', 'output'):
        quality = weakest(quality, field_quality(obs[key]))
    return components, quality, cache['flags']


def read_native_line(line, index):
    """Returns ('drop', reason) or ('line', info)."""
    if not isinstance(line, dict):
        raise FormatError('invalid-line')
    message = line.get('message')
    usage = message.get('usage') if isinstance(message, dict) else None
    if line.get('type') != 'assistant' or not isinstance(usage, dict):
        return ('drop', 'not-usage-line')
    if message.get('model') == '<synthetic>':
        return ('drop', 'synthetic-model')
    ts = parse_timestamp(line.get('timestamp'))
    if ts is None:
        return ('drop', 'invalid-timestamp')
    message_id, request_id = message.get('id'), line.get('requestId')
    uuid, session = line.get('uuid'), line.get('sessionId')
    message_id = message_id if isinstance(message_id, str) and message_id else None
    request_id = request_id if isinstance(request_id, str) and request_id else None
    uuid = uuid if isinstance(uuid, str) and uuid else None
    session = session if isinstance(session, str) and session else None
    if message_id:
        basis, key = 'message-id', 'claude:' + message_id
    elif request_id:
        basis, key = 'request-id', 'claude:' + request_id
    elif uuid:
        basis, key = 'line-uuid-fallback', 'claude:%s+%s' % (session or '', uuid)
    else:
        return ('drop', 'no-identity')
    if not KEY_RE.match(key):
        return ('drop', 'no-identity')
    iterations = usage.get('iterations')
    raw_slots = iterations if isinstance(iterations, list) and iterations and all(isinstance(s, dict) for s in iterations) \
        else [usage]
    model = message.get('model') if isinstance(message.get('model'), str) else None
    slots = [slot_observation(s) for s in raw_slots]
    models = [s.get('model') if isinstance(s.get('model'), str) else model for s in raw_slots]
    details = usage.get('output_tokens_details')
    thinking = observe(details, 'thinking_tokens') if isinstance(details, dict) else ('missing', None)
    observed = [obs[1] for s in slots for k, obs in s.items() if k != 'container' and obs[0] == 'reported']
    any_invalid = any(obs[0] == 'invalid' for s in slots for k, obs in s.items() if k != 'container')
    if not any_invalid:
        if not observed:
            return ('drop', 'no-counters-observed')
        if all(v == 0 for v in observed):
            return ('drop', 'all-zero-usage')
    output_sum = sum(s['output'][1] for s in slots if s['output'][0] == 'reported')
    return ('line', {'key': key, 'basis': basis, 'request_id': request_id, 'session': session, 'ts': ts,
                     'slots': slots, 'models': models, 'thinking': thinking, 'output': output_sum})


def native_record(lines, source, tz, tz_name):
    first = lines[0]
    flags = set()
    request_ids = []
    for info in lines:
        if info['request_id'] and info['request_id'] not in request_ids:
            request_ids.append(info['request_id'])
    if len(request_ids) > 1:
        flags.add('request-id-conflict')
    # Snapshot identity covers counters, model labels and reasoning evidence, not timestamps.
    distinct = collections.OrderedDict()
    for info in lines:
        distinct.setdefault(json.dumps([info['slots'], info['models'], info['thinking']], sort_keys=True), info)
    snapshots = list(distinct.values())
    # Descriptive winner: the latest line whose event-level output is not below the running maximum.
    # Time owner: that same winner within the owning session, except that a duplicate claiming a
    # different session never moves the recorded time (store/ledger.ts mergeDuplicateEvent ownership),
    # and a first line without a session hands ownership to the first later line that has one.
    kept = ts_line = lines[0]
    owner, max_output = lines[0]['session'], lines[0]['output']
    for info in lines[1:]:
        wins = info['output'] >= max_output
        max_output = max(max_output, info['output'])
        if wins:
            kept = info
        incoming = info['session']
        if owner and incoming and owner != incoming:
            flags.add('session-attribution-conflict')
        elif owner and not incoming:
            pass
        elif not owner and incoming:
            owner, ts_line = incoming, info
        elif wins:
            ts_line = info
    shapes = {(len(s['slots']), tuple(s['models'])) for s in snapshots}
    aligned = len(shapes) == 1
    quality = 'complete'
    if aligned:
        count = len(first['slots'])
        merged = []
        for index in range(count):
            slot = snapshots[0]['slots'][index]
            for other in snapshots[1:]:
                slot = merge_slot(slot, other['slots'][index])
            merged.append(slot)
        incomparable = any(slots_incomparable(a['slots'][i], b['slots'][i])
                           for n, a in enumerate(snapshots) for b in snapshots[n + 1:] for i in range(count))
        per_slot = [slot_components(slot) for slot in merged]
        components = {name: aggregate([result[0][name] for result in per_slot]) for name in COMPONENTS
                      if name != 'reasoning'}
        for _components, slot_quality, slot_flags in per_slot:
            quality = weakest(quality, slot_quality)
            flags |= slot_flags
        thinking = ('missing', None)
        for info in snapshots:
            thinking = merge_obs(thinking, info['thinking'])
        last_output = per_slot[-1][0]['output']
        if thinking[0] == 'reported':
            if last_output['presence'] in MEASURED:
                value = min(thinking[1], last_output['value'])
                if value < thinking[1]:
                    flags.add('reasoning-clamped')
                reasoning = measured(value, 'reported')
            else:
                reasoning = missing('output-unresolved')
        else:
            reasoning = from_obs(thinking, absent_reason='source-does-not-report')
        if incomparable:
            quality = 'conflict'
            flags.add('snapshots-incomparable')
        iteration_count = count
    else:
        # Components cannot be aligned between snapshots: keep the field-wise maximum of each
        # snapshot's own event-level components and hold the quality as conflict.
        flags.add('components-misaligned')
        quality = 'conflict'
        per_snapshot = []
        for info in snapshots:
            results = [slot_components(slot) for slot in info['slots']]
            per_snapshot.append({name: aggregate([r[0][name] for r in results]) for name in COMPONENTS
                                 if name != 'reasoning'})
            for _components, _slot_quality, slot_flags in results:
                flags |= slot_flags
        components = {}
        for name in COMPONENTS:
            if name == 'reasoning':
                continue
            candidates = [snap[name] for snap in per_snapshot]
            values = [c['value'] for c in candidates if c['presence'] in MEASURED]
            if any(c['presence'] == 'invalid' for c in candidates):
                components[name] = invalid('invalid-count-value')
            elif values:
                components[name] = measured(max(values), 'aggregated')
            elif all(c['presence'] == 'not_applicable' for c in candidates):
                components[name] = not_applicable()
            else:
                components[name] = missing('snapshots-conflict')
        reasoning = missing('snapshots-conflict')
        iteration_count = len(kept['slots'])
    components['reasoning'] = reasoning
    sessions = {info['session'] for info in lines if info['session']}
    identity = {'key': first['key'], 'basis': first['basis'], 'request_id_present': bool(request_ids),
                'request_key': request_ids[0] if request_ids else None, 'iteration_count': iteration_count}
    evidence = blank_evidence(lines_observed=len(lines), distinct_snapshots=len(snapshots),
                              sessions_observed=len(sessions))
    return make_record('message', source, identity, {'utc_ms': ts_line['ts'], 'basis': 'winning-snapshot'},
                       {'date': local_date(ts_line['ts'], tz), 'timezone': tz_name}, components, quality,
                       evidence, flags)


def normalize_native_lines(document, instance, timezone):
    """Claude native assistant lines -> message cohort. Input order is part of the input."""
    if not isinstance(document, dict) or document.get('kind') != 'claude-native-lines' \
            or not isinstance(document.get('lines'), list):
        raise FormatError('invalid-input-shape')
    tz = tzinfo_for(timezone)
    source = make_source('native', 'claude-native-lines', instance)
    groups, dropped = collections.OrderedDict(), collections.Counter()
    for index, line in enumerate(document['lines']):
        kind, info = read_native_line(line, index)
        if kind == 'drop':
            dropped[info] += 1
        else:
            groups.setdefault(info['key'], []).append(info)
    records = [native_record(lines, source, tz, timezone) for lines in groups.values()]
    return make_cohort(instance, 'message', source, timezone, None, records, dropped)


# ---------------------------------------------------------------------------------------------
# Product ledger rows (event_projection shape)

LEDGER_COLUMNS = (('input_fresh', 'input_fresh'), ('cache_write_5m', 'cache_write_5m'),
                  ('cache_write_1h', 'cache_write_1h'), ('cache_read', 'cache_read'), ('output', 'output'))


def ledger_record(row, source, tz, tz_name):
    if not isinstance(row, dict):
        raise FormatError('invalid-row')
    row_id = row.get('id')
    if not isinstance(row_id, str) or not KEY_RE.match(row_id) or not is_count(row.get('ts')):
        raise FormatError('invalid-row')
    quality_in = row.get('count_quality')
    if quality_in is None:
        stored = 'unrecorded'
    elif quality_in in QUALITY_RANK:
        stored = quality_in
    else:
        raise FormatError('invalid-count-quality')
    local = row.get('source') in LOCAL_SOURCES
    flags = set()
    quality = stored
    reason = 'legacy-unrecorded' if stored == 'unrecorded' else 'row-count-quality-not-complete'
    components = {}
    if stored == 'complete':
        for name, column in LEDGER_COLUMNS:
            value = row.get(column)
            components[name] = measured(value, 'normalized') if is_count(value) else invalid('invalid-count-value')
        unassigned = row.get('cache_write_unassigned')
        if 'cache_write_unassigned' not in row or unassigned is None:
            components['cache_write_unassigned'] = missing('ledger-null-unrecorded')
        else:
            components['cache_write_unassigned'] = measured(unassigned, 'normalized') if is_count(unassigned) \
                else invalid('invalid-count-value')
        assumed = row.get('cache_write_assumed_1h')
        if assumed is not None and 'cache_write_assumed_1h' in row:
            one_hour = components['cache_write_1h']
            if not is_count(assumed) or one_hour['presence'] not in MEASURED or assumed > one_hour['value']:
                components['cache_write_1h'] = invalid('invalid-count-value')
            elif assumed > 0:
                components['cache_write_1h'] = dict(one_hour, assumed_part=assumed,
                                                    origin='assumed' if assumed == one_hour['value'] else one_hour['origin'])
        leaves = [components[leaf] for leaf in LEAVES]
        if any(c['presence'] == 'invalid' for c in leaves):
            components['cache_write_total'] = invalid('invalid-count-value')
        elif any(c['presence'] == 'missing' for c in leaves):
            components['cache_write_total'] = missing('flat-total-unresolved')
        else:
            components['cache_write_total'] = measured(sum(c['value'] for c in leaves), 'derived')
        reasoning = row.get('reasoning')
        if not is_count(reasoning):
            components['reasoning'] = invalid('invalid-count-value')
        elif reasoning == 0:
            # The ledger stores 0 both for "no reasoning" and for "not reported".
            components['reasoning'] = missing('ledger-zero-ambiguous')
        else:
            components['reasoning'] = measured(reasoning, 'normalized')
        if any(components[name]['presence'] == 'invalid' for name in COMPONENTS if name != 'reasoning'):
            quality = weakest(stored, 'invalid')
            flags.add('stored-quality-contradicted')
    else:
        def held(column):
            value = row.get(column)
            return missing(reason, inspection_value=value) if is_count(value) else missing(reason)
        for name, column in LEDGER_COLUMNS:
            components[name] = held(column)
        components['cache_write_unassigned'] = held('cache_write_unassigned')
        components['cache_write_total'] = missing(reason)
        components['reasoning'] = held('reasoning')
    if local:
        for name in LEAVES + ('cache_write_total',):
            components[name] = not_applicable()
        stored_writes = [row.get(c) for c in ('cache_write_5m', 'cache_write_1h', 'cache_write_unassigned')]
        if any(v not in (None, 0) for v in stored_writes) and stored == 'complete':
            quality = weakest(quality, 'invalid')
            flags.add('stored-quality-contradicted')
    iterations = row.get('iteration_count')
    identity = {'key': row_id, 'basis': 'ledger-id', 'request_id_present': None, 'request_key': None,
                'iteration_count': iterations if type(iterations) is int and iterations >= 1 else None}
    return make_record('message', source, identity, {'utc_ms': row['ts'], 'basis': 'ledger-ts'},
                       {'date': local_date(row['ts'], tz), 'timezone': tz_name}, components, quality,
                       blank_evidence(), flags)


def normalize_ledger_rows(document, instance, timezone, selected_source='claude'):
    """Event-projection rows -> message cohort. Schema version 10 and projection policy 7 only."""
    if not isinstance(document, dict) or document.get('kind') != 'tokenelo-event-projection' \
            or not isinstance(document.get('rows'), list):
        raise FormatError('invalid-input-shape')
    if document.get('schema_version') != 10:
        raise FormatError('unsupported-schema-version')
    if document.get('projection_policy') != 7:
        raise FormatError('unsupported-projection-policy')
    tz = tzinfo_for(timezone)
    selected_source = document.get('selected_source', selected_source)
    source = make_source('product', 'tokenelo-event-projection', instance)
    records, dropped = [], collections.Counter()
    for row in document['rows']:
        if isinstance(row, dict) and row.get('source') != selected_source:
            dropped['non-selected-source'] += 1
            continue
        records.append(ledger_record(row, source, tz, timezone))
    return make_cohort(instance, 'message', source, timezone, None, records, dropped)


# ---------------------------------------------------------------------------------------------
# Local-engine native counters

def local_record(event, source, tz, tz_name):
    if not isinstance(event, dict) or not isinstance(event.get('id'), str) or not KEY_RE.match(event['id']) \
            or not is_count(event.get('ts')) or not isinstance(event.get('snapshots'), list) \
            or not event['snapshots'] or not all(isinstance(s, dict) for s in event['snapshots']):
        raise FormatError('invalid-row')
    keys = ('prompt_eval_count', 'prompt_eval_cached_count', 'eval_count')
    snaps = [tuple(observe(s, k) for k in keys) for s in event['snapshots']]
    distinct = list(collections.OrderedDict((json.dumps(s), s) for s in snaps).values())
    gross = cached = out = ('missing', None)
    for g, c, o in distinct:
        gross, cached, out = merge_obs(gross, g), merge_obs(cached, c), merge_obs(out, o)
    quality = weakest(weakest(field_quality(gross), field_quality(cached)), field_quality(out))
    flags = set()
    exceeds = any(g[0] == 'reported' and c[0] == 'reported' and c[1] > g[1] for g, c, _o in distinct)
    if exceeds:
        input_fresh = invalid('cache-exceeds-prompt')
        quality = weakest(quality, 'invalid')
    elif gross[0] == 'invalid' or cached[0] == 'invalid':
        input_fresh = invalid('invalid-count-value')
    elif gross[0] == 'missing':
        input_fresh = missing('absent-in-source')
    elif cached[0] == 'missing':
        # The product's assume-zero policy is not promoted to a measurement here.
        input_fresh = missing('cache-counter-absent')
    else:
        input_fresh = measured(gross[1] - cached[1], 'derived')
    for n, a in enumerate(distinct):
        for b in distinct[n + 1:]:
            up = down = False
            for x, y in zip(a, b):
                if x[0] == 'reported' and y[0] == 'reported':
                    up, down = up or y[1] > x[1], down or y[1] < x[1]
            if up and down:
                quality = 'conflict'
                flags.add('snapshots-incomparable')
    components = {'input_fresh': input_fresh, 'cache_read': from_obs(cached), 'output': from_obs(out),
                  'cache_write_5m': not_applicable(), 'cache_write_1h': not_applicable(),
                  'cache_write_unassigned': not_applicable(), 'cache_write_total': not_applicable(),
                  'reasoning': missing('source-does-not-report')}
    identity = {'key': event['id'], 'basis': 'event-id', 'request_id_present': None, 'request_key': None,
                'iteration_count': None}
    return make_record('message', source, identity, {'utc_ms': event['ts'], 'basis': 'event-ts'},
                       {'date': local_date(event['ts'], tz), 'timezone': tz_name}, components, quality,
                       blank_evidence(lines_observed=len(snaps), distinct_snapshots=len(distinct)), flags)


def normalize_local_counters(document, instance, timezone):
    if not isinstance(document, dict) or document.get('kind') != 'local-engine-counters' \
            or not isinstance(document.get('events'), list):
        raise FormatError('invalid-input-shape')
    tz = tzinfo_for(timezone)
    source = make_source('native', 'local-engine-counters', instance)
    records = [local_record(event, source, tz, timezone) for event in document['events']]
    return make_cohort(instance, 'message', source, timezone, None, records, collections.Counter())


# ---------------------------------------------------------------------------------------------
# Vendor daily report (ccusage-style)

VENDOR_FIELDS = (('input_fresh', 'inputTokens'), ('cache_write_total', 'cacheCreationTokens'),
                 ('cache_read', 'cacheReadTokens'), ('output', 'outputTokens'))


def normalize_ccusage_daily(document, instance, timezone, first=None, last=None, tool_version=None):
    """ccusage-style daily report -> day cohort. Only date and the five token fields are read;
    cost and model fields are never read or carried."""
    if not isinstance(document, dict) or not isinstance(document.get('daily'), list):
        raise FormatError('daily-report-required')
    tzinfo_for(timezone)
    lo = valid_date(first) if first is not None else None
    hi = valid_date(last) if last is not None else None
    if (first is not None and lo is None) or (last is not None and hi is None):
        raise FormatError('invalid-date')
    if lo and hi and lo > hi:
        raise FormatError('reversed-date-range')
    source = make_source('vendor', 'ccusage-daily', instance, tool_version)
    records = []
    for row in document['daily']:
        if not isinstance(row, dict):
            raise FormatError('invalid-daily-row')
        date = row.get('date')
        parsed = valid_date(date)
        if parsed is None:
            raise FormatError('invalid-date')
        if (lo and parsed < lo) or (hi and parsed > hi):
            raise FormatError('out-of-range-date')
        components = {}
        quality = 'complete'
        for name, column in VENDOR_FIELDS:
            obs = observe(row, column)
            components[name] = from_obs(obs)
            quality = weakest(quality, field_quality(obs))
        for leaf in LEAVES:
            components[leaf] = missing('source-does-not-split-ttl')
        components['reasoning'] = missing('source-does-not-report')
        flags = set()
        total_obs = observe(row, 'totalTokens')
        source_total = from_obs(total_obs)
        parts = [components[n] for n, _c in VENDOR_FIELDS]
        if total_obs[0] == 'reported' and all(p['presence'] in MEASURED for p in parts) \
                and sum(p['value'] for p in parts) != total_obs[1]:
            flags.add('source-total-incoherent')
            quality = 'conflict'
        identity = {'key': date, 'basis': 'vendor-day', 'request_id_present': None, 'request_key': None,
                    'iteration_count': None}
        records.append(make_record('day', source, identity, None, {'date': date, 'timezone': timezone},
                                   components, quality, blank_evidence(), flags, source_total))
    rng = {'first': first, 'last': last} if lo and hi else None
    return make_cohort(instance, 'day', source, timezone, rng, records, collections.Counter())


# ---------------------------------------------------------------------------------------------
# Day rollup

def rollup_days(cohort, instance=None):
    """Message cohort -> day cohort. A day's component is a sum only if every member is measured."""
    if cohort['scope'] != 'message' or cohort['timezone'] is None:
        raise FormatError('rollup-requires-message-cohort-with-timezone')
    label = instance or cohort['label']
    source = dict(cohort['source'], instance=label)
    by_day = collections.OrderedDict()
    for record in cohort['records']:
        if record['day'] is None or record['day']['timezone'] != cohort['timezone']:
            raise FormatError('timezone-mismatch')
        by_day.setdefault(record['day']['date'], []).append(record)
    records = []
    for date, members in by_day.items():
        components = {name: aggregate([m['components'][name] for m in members]) for name in COMPONENTS}
        quality, flags = 'complete', set()
        for member in members:
            quality = weakest(quality, member['count_quality'])
            flags |= set(member['flags'])
        identity = {'key': date, 'basis': 'day-rollup', 'request_id_present': None, 'request_key': None,
                    'iteration_count': None}
        evidence = blank_evidence(members=len(members),
                                  members_complete=sum(m['completeness'] == 'complete' for m in members))
        record = make_record('day', source, identity, None, {'date': date, 'timezone': cohort['timezone']},
                             components, quality, evidence, flags)
        if record['completeness'] == 'partial' or evidence['members_complete'] < len(members):
            record['flags'] = sorted(set(record['flags']) | {'partial-cohort'})
        records.append(record)
    dropped = collections.Counter({d['reason']: d['count'] for d in cohort['dropped']})
    return make_cohort(label, 'day', source, cohort['timezone'], cohort['range'], records, dropped)


# ---------------------------------------------------------------------------------------------
# Existing comparator output -> canonical day cohorts (documents what that output can express)

LEGACY_KEYS = (('input_fresh', 'inputTokens'), ('cache_write_total', 'cacheCreationTokens'),
               ('cache_read', 'cacheReadTokens'), ('output', 'outputTokens'))


def legacy_quality(report):
    counts = report.get('countQualityRows')
    if not isinstance(counts, dict) or not counts:
        return 'unrecorded'
    quality = 'complete'
    for key in counts:
        quality = weakest(quality, 'unrecorded' if key == 'None' else key if key in QUALITY_RANK else 'invalid')
    return quality


def from_legacy_output(report, instance_a, instance_b):
    """Output of scripts/compare-claude-ccusage.py -> (cohort A = currentProjection, cohort B = ccusage).
    The legacy output sums the cache TTL split before emitting it and zero-imputes days that a side did
    not have, so those facts are represented as missing, never recovered."""
    if not isinstance(report, dict) or not isinstance(report.get('dailyComparisons'), list):
        raise FormatError('invalid-input-shape')
    timezone = report.get('timezone')
    tzinfo_for(timezone)
    cohorts = []
    for instance, side, family, quality in ((instance_a, 'currentProjection', 'product', legacy_quality(report)),
                                            (instance_b, 'ccusage', 'vendor', 'complete')):
        source = make_source(family, 'legacy-comparator-output', instance)
        records, dropped = [], collections.Counter()
        for day in report['dailyComparisons']:
            comparison = day['comparison']
            values = {key: comparison[key][side] for key in dict(LEGACY_KEYS).values()}
            values['totalTokens'] = comparison['totalTokens'][side]
            other = comparison['totalTokens']['ccusage' if side == 'currentProjection' else 'currentProjection']
            if not all(is_count(v) for v in values.values()):
                raise FormatError('invalid-input-shape')
            date = day['date']
            if values['totalTokens'] == 0 and other == 0:
                dropped['legacy-empty-both-day'] += 1
                continue
            day_quality = quality
            if values['totalTokens'] == 0:
                day_quality = 'unrecorded'
                components = {name: missing('legacy-zero-total-may-be-absent', inspection_value=0)
                              for name, _c in LEGACY_KEYS}
                source_total = missing('legacy-zero-total-may-be-absent', inspection_value=0)
            else:
                components = {name: from_obs(('reported', values[column])) for name, column in LEGACY_KEYS}
                source_total = measured(values['totalTokens'], 'reported')
            for leaf in LEAVES + ('reasoning',):
                components[leaf] = missing('legacy-output-lacks-component')
            identity = {'key': date, 'basis': 'vendor-day' if family == 'vendor' else 'day-rollup',
                        'request_id_present': None, 'request_key': None, 'iteration_count': None}
            records.append(make_record('day', source, identity, None, {'date': date, 'timezone': timezone},
                                       components, day_quality, blank_evidence(), set(), source_total))
        rng = {'first': report.get('firstInclusiveDate'), 'last': report.get('lastInclusiveDate')}
        cohorts.append(make_cohort(instance, 'day', source, timezone, rng, records, dropped))
    return cohorts[0], cohorts[1]


# ---------------------------------------------------------------------------------------------
# Comparison

def side_view(component):
    view = {'presence': component['presence'], 'value': component['value']}
    for key in ('reason', 'inspection_value'):
        if key in component:
            view[key] = component[key]
    return view


def percent_micro(delta, reference):
    """Round-half-up of |delta| / reference * 100 in units of 1e-6 percent, exact integer arithmetic."""
    return (abs(delta) * 200_000_000 + reference) // (2 * reference)


def compare_unit(a, b, quality_a, quality_b, tolerance, forced=None):
    pa, pb = a['presence'], b['presence']
    unit = {'a': side_view(a), 'b': side_view(b), 'relation': 'not_comparable', 'delta': None,
            'percent_micro': None, 'within_tolerance': None}
    if forced:
        unit['reason'] = forced
    elif 'invalid' in (pa, pb):
        unit['reason'] = 'invalid-in-both' if pa == pb else 'invalid-in-a' if pa == 'invalid' else 'invalid-in-b'
    elif 'not_applicable' in (pa, pb):
        unit['reason'] = 'not-applicable-in-both' if pa == pb else \
            'not-applicable-in-a' if pa == 'not_applicable' else 'not-applicable-in-b'
    elif 'missing' in (pa, pb):
        unit['reason'] = 'missing-in-both' if pa == pb else 'missing-in-a' if pa == 'missing' else 'missing-in-b'
    else:
        delta = a['value'] - b['value']
        unit['delta'] = delta
        unit['relation'] = 'equal' if delta == 0 else 'differ'
        quality_ok = quality_a == 'complete' and quality_b == 'complete'
        if quality_ok and (b['value'] > 0 or delta == 0):
            unit['percent_micro'] = percent_micro(delta, b['value']) if b['value'] else 0
        if unit['relation'] == 'equal':
            unit['reason'] = 'exact-match' if quality_ok else 'equal-quality-not-complete'
        elif unit['percent_micro'] is not None:
            unit['reason'] = 'values-differ'
        else:
            unit['reason'] = 'differ-quality-not-complete' if not quality_ok else 'differ-reference-zero'
        if unit['percent_micro'] is not None and tolerance is not None:
            unit['within_tolerance'] = unit['percent_micro'] <= tolerance
    return unit


def pair_outcome(units, quality_a, quality_b):
    """differs: some unit differs. unresolved: nothing differs but a primary unit cannot be compared or
    a side's count quality is not complete. identical: every primary unit equal under complete quality."""
    if any(unit['relation'] == 'differ' for unit in units.values()):
        return 'differs'
    if quality_a != 'complete' or quality_b != 'complete':
        return 'unresolved'
    if any(units[name]['relation'] == 'not_comparable' and units[name]['reason'] != 'not-applicable-in-both'
           for name in TOTAL_PARTS + ('total',)):
        return 'unresolved'
    return 'identical'


def compare_records(ra, rb, tolerance):
    qa, qb = ra['count_quality'], rb['count_quality']
    assumed = ra['components']['cache_write_1h'].get('assumed_part', 0) > 0 \
        or rb['components']['cache_write_1h'].get('assumed_part', 0) > 0
    units = {}
    for name in UNITS:
        if name == 'total':
            ca = dict(ra['total'])
            cb = dict(rb['total'])
        else:
            ca, cb = ra['components'][name], rb['components'][name]
        units[name] = compare_unit(ca, cb, qa, qb, tolerance,
                                   'cache-ttl-assumed' if assumed and name in LEAVES else None)
    relations = {name: units[name]['relation'] for name in UNITS}
    outcome = pair_outcome(units, qa, qb)
    flags = []
    if relations['total'] == 'equal' and any(relations[n] == 'differ' for n in UNITS if n != 'total'):
        flags.append('totals-equal-components-differ')
    return {'key': ra['identity']['key'], 'outcome': outcome,
            'a': {'count_quality': qa, 'completeness': ra['completeness']},
            'b': {'count_quality': qb, 'completeness': rb['completeness']}, 'units': units, 'flags': flags}


def compare(cohort_a, cohort_b, tolerance_percent_micro=None):
    for cohort in (cohort_a, cohort_b):
        problems = validate_cohort(cohort)
        if problems:
            raise FormatError('invalid-cohort', problems)
    if cohort_a['scope'] != cohort_b['scope']:
        raise FormatError('scope-mismatch')
    if cohort_a['timezone'] != cohort_b['timezone']:
        raise FormatError('timezone-mismatch')
    if tolerance_percent_micro is not None and not is_count(tolerance_percent_micro):
        raise FormatError('invalid-tolerance')
    by_a = {r['identity']['key']: r for r in cohort_a['records']}
    by_b = {r['identity']['key']: r for r in cohort_b['records']}
    pairs = []
    for key in sorted(set(by_a) | set(by_b)):
        if key in by_a and key in by_b:
            pairs.append(compare_records(by_a[key], by_b[key], tolerance_percent_micro))
        elif key in by_a:
            r = by_a[key]
            pairs.append({'key': key, 'outcome': 'only_in_a', 'b': None, 'units': None, 'flags': [],
                          'a': {'count_quality': r['count_quality'], 'completeness': r['completeness']}})
        else:
            r = by_b[key]
            pairs.append({'key': key, 'outcome': 'only_in_b', 'a': None, 'units': None, 'flags': [],
                          'b': {'count_quality': r['count_quality'], 'completeness': r['completeness']}})
    count = collections.Counter(p['outcome'] for p in pairs)
    summary = {'matched': count['identical'] + count['differs'] + count['unresolved'],
               'only_in_a': count['only_in_a'], 'only_in_b': count['only_in_b'],
               'identical': count['identical'], 'differs': count['differs'], 'unresolved': count['unresolved'],
               'totals_equal_components_differ': sum('totals-equal-components-differ' in p['flags'] for p in pairs),
               'partial_in_a': sum(1 for r in cohort_a['records'] if r['completeness'] == 'partial'),
               'partial_in_b': sum(1 for r in cohort_b['records'] if r['completeness'] == 'partial')}

    def ref(cohort):
        return {'label': cohort['label'], 'source': cohort['source'], 'records': len(cohort['records']),
                'completeness': cohort['completeness'], 'sha256': sha256_of(cohort)}
    return {'format': FORMAT_RESULT, 'scope': cohort_a['scope'], 'timezone': cohort_a['timezone'],
            'reference_side': 'b', 'tolerance_percent_micro': tolerance_percent_micro,
            'a': ref(cohort_a), 'b': ref(cohort_b), 'summary': summary, 'pairs': pairs}


# ---------------------------------------------------------------------------------------------
# Schema validator (a small subset of draft 2020-12; unsupported keywords are refused, not ignored)

SUPPORTED_KEYWORDS = frozenset([
    '$schema', '$id', '$defs', '$ref', '$comment', 'title', 'description', 'type', 'enum', 'const',
    'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
    'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'if', 'then', 'else', 'allOf', 'anyOf',
    'oneOf', 'not'])
_registry = {}


def _check_keywords(schema, path='#'):
    if not isinstance(schema, dict):
        return
    for key, value in schema.items():
        if key not in SUPPORTED_KEYWORDS:
            raise FormatError('unsupported-schema-keyword', [path + '/' + key])
        if key in ('properties', '$defs'):
            for name, sub in value.items():
                _check_keywords(sub, '%s/%s/%s' % (path, key, name))
        elif key in ('items', 'additionalProperties', 'if', 'then', 'else', 'not'):
            _check_keywords(value, path + '/' + key)
        elif key in ('allOf', 'anyOf', 'oneOf'):
            for n, sub in enumerate(value):
                _check_keywords(sub, '%s/%s/%d' % (path, key, n))


def load_schemas(directory=None):
    """Loads and registers the three schema files by $id."""
    directory = Path(directory) if directory else SCHEMA_DIR
    schemas = {}
    for name in ('count-record', 'cohort', 'comparison-result'):
        schema = load_json_file(directory / (name + '.schema.json'))
        if schema.get('$schema') != 'https://json-schema.org/draft/2020-12/schema':
            raise FormatError('unsupported-schema-dialect')
        _check_keywords(schema)
        _registry[schema['$id']] = schema
        schemas[name] = schema
    return schemas


def _resolve(ref, root):
    target, _, pointer = ref.partition('#')
    base = _registry[target] if target else root
    node = base
    for part in [p for p in pointer.split('/') if p]:
        node = node[part.replace('~1', '/').replace('~0', '~')]
    return node, base


def _is_type(value, name):
    if name == 'null':
        return value is None
    if name == 'boolean':
        return type(value) is bool
    if name == 'integer':
        return type(value) is int
    if name == 'number':
        return type(value) in (int, float)
    if name == 'string':
        return isinstance(value, str)
    if name == 'array':
        return isinstance(value, list)
    if name == 'object':
        return isinstance(value, dict)
    raise FormatError('unsupported-schema-type')


def _same(a, b):
    if isinstance(a, (list, dict)) or isinstance(b, (list, dict)):
        return json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    return type(a) is type(b) and a == b


def validate_schema(instance, schema, root=None, path=''):
    """Returns a sorted list of problem strings 'path: keyword'. Values are never echoed."""
    root = root if root is not None else schema
    problems = []
    if '$ref' in schema:
        target, base = _resolve(schema['$ref'], root)
        problems += validate_schema(instance, target, base, path)
    if 'type' in schema:
        names = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if not any(_is_type(instance, n) for n in names):
            return sorted(set(problems + ['%s: type' % path]))
    if 'const' in schema and not _same(instance, schema['const']):
        problems.append('%s: const' % path)
    if 'enum' in schema and not any(_same(instance, option) for option in schema['enum']):
        problems.append('%s: enum' % path)
    if type(instance) is int:
        if 'minimum' in schema and instance < schema['minimum']:
            problems.append('%s: minimum' % path)
        if 'maximum' in schema and instance > schema['maximum']:
            problems.append('%s: maximum' % path)
    if isinstance(instance, str):
        if 'minLength' in schema and len(instance) < schema['minLength']:
            problems.append('%s: minLength' % path)
        if 'maxLength' in schema and len(instance) > schema['maxLength']:
            problems.append('%s: maxLength' % path)
        if 'pattern' in schema and not re.search(schema['pattern'], instance):
            problems.append('%s: pattern' % path)
    if isinstance(instance, list):
        if 'minItems' in schema and len(instance) < schema['minItems']:
            problems.append('%s: minItems' % path)
        if 'maxItems' in schema and len(instance) > schema['maxItems']:
            problems.append('%s: maxItems' % path)
        if schema.get('uniqueItems'):
            seen = [json.dumps(item, sort_keys=True) for item in instance]
            if len(set(seen)) != len(seen):
                problems.append('%s: uniqueItems' % path)
        if 'items' in schema:
            for n, item in enumerate(instance):
                problems += validate_schema(item, schema['items'], root, '%s/%d' % (path, n))
    if isinstance(instance, dict):
        for name in schema.get('required', []):
            if name not in instance:
                problems.append('%s/%s: required' % (path, name))
        properties = schema.get('properties', {})
        for name, value in instance.items():
            if name in properties:
                problems += validate_schema(value, properties[name], root, '%s/%s' % (path, name))
            elif schema.get('additionalProperties') is False:
                problems.append('%s/*: additionalProperties' % path)  # input key names are never echoed
            elif isinstance(schema.get('additionalProperties'), dict):
                problems += validate_schema(value, schema['additionalProperties'], root, '%s/*' % path)
    for sub in schema.get('allOf', []):
        problems += validate_schema(instance, sub, root, path)
    if 'anyOf' in schema and not any(not validate_schema(instance, s, root, path) for s in schema['anyOf']):
        problems.append('%s: anyOf' % path)
    if 'oneOf' in schema and sum(not validate_schema(instance, s, root, path) for s in schema['oneOf']) != 1:
        problems.append('%s: oneOf' % path)
    if 'not' in schema and not validate_schema(instance, schema['not'], root, path):
        problems.append('%s: not' % path)
    if 'if' in schema:
        branch = 'then' if not validate_schema(instance, schema['if'], root, path) else 'else'
        if branch in schema:
            problems += validate_schema(instance, schema[branch], root, path)
    return sorted(set(problems))


def _schema(name):
    if not _registry:
        load_schemas()
    ids = {'record': 'count-record', 'cohort': 'cohort', 'result': 'comparison-result'}
    for schema in _registry.values():
        if schema['$id'].endswith(':' + ids[name]):
            return schema
    raise FormatError('unknown-schema')


# ---------------------------------------------------------------------------------------------
# Semantic validators (rules JSON Schema cannot express)

def validate_record(record):
    problems = validate_schema(record, _schema('record'))
    if problems:
        return problems
    out = []
    components = record['components']
    total, completeness = compute_total(components, record['count_quality'])
    if record['total'] != total:
        out.append('/total: recomputation')
    if record['completeness'] != completeness:
        out.append('/completeness: recomputation')
    if record['flags'] != sorted(record['flags']):
        out.append('/flags: order')
    for name, component in components.items():
        if 'assumed_part' in component and (name != 'cache_write_1h' or component['assumed_part'] > component['value']):
            out.append('/components/%s/assumed_part: rule' % name)
        coverage = component.get('coverage')
        if coverage:
            if coverage['resolved'] > coverage['parts']:
                out.append('/components/%s/coverage: resolved-exceeds-parts' % name)
            if component['presence'] in MEASURED and (coverage['resolved'] != coverage['parts']
                                                     or coverage['resolved_subtotal'] != component['value']):
                out.append('/components/%s/coverage: measured-sum' % name)
            if component['presence'] == 'missing' and component.get('reason') == 'partial-members' \
                    and coverage['resolved'] >= coverage['parts']:
                out.append('/components/%s/coverage: partial-but-resolved' % name)
    # Cache partition: resolved leaves never exceed a measured group total, and equal it when the
    # unassigned residual is resolved.
    group = components['cache_write_total']
    if group['presence'] in MEASURED:
        resolved = [components[l]['value'] for l in LEAVES if components[l]['presence'] in MEASURED]
        if sum(resolved) > group['value']:
            out.append('/components/cache_write_total: leaves-exceed-total')
        if components['cache_write_unassigned']['presence'] in MEASURED and sum(resolved) != group['value']:
            out.append('/components/cache_write_total: partition')
    if components['reasoning']['presence'] in MEASURED and components['output']['presence'] in MEASURED \
            and components['reasoning']['value'] > components['output']['value']:
        out.append('/components/reasoning: exceeds-output')
    identity, day = record['identity'], record['day']
    if record['scope'] == 'day':
        if day is None or identity['key'] != day['date']:
            out.append('/identity/key: day-key')
    if day is not None:
        if valid_date(day['date']) is None:
            out.append('/day/date: calendar')
        if record['time'] is not None:
            try:
                if local_date(record['time']['utc_ms'], tzinfo_for(day['timezone'])) != day['date']:
                    out.append('/day/date: time-mismatch')
            except FormatError:
                out.append('/day/timezone: unusable')
    source_total = record.get('source_total')
    if source_total and source_total['presence'] in MEASURED and total['presence'] in MEASURED \
            and source_total['value'] != total['value'] and 'source-total-incoherent' not in record['flags']:
        out.append('/source_total: incoherent-unflagged')
    return sorted(set(out))


def validate_cohort(cohort):
    problems = validate_schema(cohort, _schema('cohort'))
    if problems:
        return problems
    out = []
    keys = []
    for index, record in enumerate(cohort['records']):
        found = validate_record(record)
        out += ['/records/%d%s' % (index, p) for p in found]
        keys.append(record['identity']['key'])
        if record['scope'] != cohort['scope']:
            out.append('/records/%d/scope: cohort-mismatch' % index)
        if record['source'] != cohort['source']:
            out.append('/records/%d/source: cohort-mismatch' % index)
        if record['day'] is not None and record['day']['timezone'] != cohort['timezone']:
            out.append('/records/%d/day/timezone: cohort-mismatch' % index)
    if len(set(keys)) != len(keys):
        out.append('/records: duplicate-identity')
    if keys != sorted(keys):
        out.append('/records: order')
    reasons = [d['reason'] for d in cohort['dropped']]
    if reasons != sorted(reasons) or len(set(reasons)) != len(reasons):
        out.append('/dropped: order')
    for index, drop in enumerate(cohort['dropped']):
        if drop['unreadable'] != (drop['reason'] in UNREADABLE_DROPS):
            out.append('/dropped/%d/unreadable: classification' % index)
    partial = any(r['completeness'] == 'partial' for r in cohort['records']) \
        or any(d['unreadable'] for d in cohort['dropped'])
    if cohort['completeness'] != ('partial' if partial else 'complete'):
        out.append('/completeness: recomputation')
    if cohort['range'] is not None:
        lo, hi = valid_date(cohort['range']['first']), valid_date(cohort['range']['last'])
        if lo is None or hi is None or lo > hi:
            out.append('/range: calendar')
    return sorted(set(out))


def validate_result(result):
    problems = validate_schema(result, _schema('result'))
    if problems:
        return problems
    out = []
    keys = [p['key'] for p in result['pairs']]
    if keys != sorted(keys) or len(set(keys)) != len(keys):
        out.append('/pairs: order')
    count = collections.Counter(p['outcome'] for p in result['pairs'])
    summary = result['summary']
    expected = {'matched': count['identical'] + count['differs'] + count['unresolved'],
                'only_in_a': count['only_in_a'], 'only_in_b': count['only_in_b'], 'identical': count['identical'],
                'differs': count['differs'], 'unresolved': count['unresolved'],
                'totals_equal_components_differ': sum('totals-equal-components-differ' in p['flags']
                                                      for p in result['pairs'])}
    for name, value in expected.items():
        if summary[name] != value:
            out.append('/summary/%s: recomputation' % name)
    tolerance = result['tolerance_percent_micro']
    for index, pair in enumerate(result['pairs']):
        if pair['units'] is None:
            continue
        if pair['outcome'] != pair_outcome(pair['units'], pair['a']['count_quality'], pair['b']['count_quality']):
            out.append('/pairs/%d/outcome: recomputation' % index)
        for name, unit in pair['units'].items():
            where = '/pairs/%d/units/%s' % (index, name)
            a, b = unit['a'], unit['b']
            both = a['presence'] in MEASURED and b['presence'] in MEASURED
            if unit['reason'] == 'cache-ttl-assumed':
                if unit['relation'] != 'not_comparable' or name not in LEAVES:
                    out.append(where + ': relation-presence')
                continue
            if (unit['relation'] != 'not_comparable') != both:
                out.append(where + ': relation-presence')
            if both:
                if unit['delta'] != a['value'] - b['value']:
                    out.append(where + ': delta')
                if unit['relation'] != ('equal' if unit['delta'] == 0 else 'differ'):
                    out.append(where + ': relation-delta')
                quality_ok = pair['a']['count_quality'] == 'complete' and pair['b']['count_quality'] == 'complete'
                if unit['percent_micro'] is not None:
                    if not quality_ok or (b['value'] == 0 and unit['delta'] != 0):
                        out.append(where + ': percent-not-allowed')
                    elif unit['percent_micro'] != (percent_micro(unit['delta'], b['value']) if b['value'] else 0):
                        out.append(where + ': percent-value')
                elif quality_ok and (b['value'] > 0 or unit['delta'] == 0):
                    out.append(where + ': percent-missing')
                if unit['percent_micro'] is not None and tolerance is not None \
                        and unit['within_tolerance'] != (unit['percent_micro'] <= tolerance):
                    out.append(where + ': tolerance')
                if (unit['percent_micro'] is None or tolerance is None) and unit['within_tolerance'] is not None:
                    out.append(where + ': tolerance-without-percent')
    return sorted(set(out))


def require_valid(kind, document):
    problems = {'record': validate_record, 'cohort': validate_cohort, 'result': validate_result}[kind](document)
    if problems:
        raise FormatError('schema-violation', problems)
    return document


# ---------------------------------------------------------------------------------------------
# Command line

NORMALIZERS = {'claude-native-lines': normalize_native_lines, 'tokenelo-event-projection': normalize_ledger_rows,
               'local-engine-counters': normalize_local_counters}


def normalize_document(document, instance, timezone, first=None, last=None, rollup=False, tool_version=None):
    if isinstance(document, dict) and 'daily' in document and 'kind' not in document:
        cohort = normalize_ccusage_daily(document, instance, timezone, first, last, tool_version)
    elif isinstance(document, dict) and document.get('kind') in NORMALIZERS:
        cohort = NORMALIZERS[document['kind']](document, instance, timezone)
    else:
        raise FormatError('invalid-input-shape')
    if rollup and cohort['scope'] == 'message':
        cohort = rollup_days(cohort)
    return cohort


def build_case(case_dir):
    """Computes the three expected outputs of a fixture case directory; returns {filename: text}."""
    case_dir = Path(case_dir)
    case = load_json_file(case_dir / 'case.json')
    cohorts = []
    if 'legacy_output' in case:
        cohorts = list(from_legacy_output(load_json_file(case_dir / case['legacy_output']),
                                          case['a']['instance'], case['b']['instance']))
        for cohort in cohorts:
            require_valid('cohort', cohort)
    for side in ('a', 'b') if not cohorts else ():
        spec = case[side]
        document = load_json_file(case_dir / spec['input'])
        cohort = normalize_document(document, spec['instance'], case['timezone'], spec.get('first'),
                                    spec.get('last'), spec.get('rollup_days', False), spec.get('tool_version'))
        require_valid('cohort', cohort)
        cohorts.append(cohort)
    result = compare(cohorts[0], cohorts[1], case.get('tolerance_percent_micro'))
    require_valid('result', result)
    return {'a.cohort.json': dumps(cohorts[0]), 'b.cohort.json': dumps(cohorts[1]), 'result.json': dumps(result)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    n = sub.add_parser('normalize')
    n.add_argument('--input', required=True)
    n.add_argument('--instance', required=True)
    n.add_argument('--timezone', required=True)
    n.add_argument('--first')
    n.add_argument('--last')
    n.add_argument('--tool-version')
    n.add_argument('--rollup-days', action='store_true')
    c = sub.add_parser('compare')
    c.add_argument('--a', required=True)
    c.add_argument('--b', required=True)
    c.add_argument('--tolerance-percent-micro', type=int)
    v = sub.add_parser('validate')
    v.add_argument('--kind', required=True, choices=('record', 'cohort', 'result'))
    v.add_argument('--input', required=True)
    b = sub.add_parser('build-case')
    b.add_argument('--case-dir', required=True)
    b.add_argument('--write', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.command == 'normalize':
            cohort = normalize_document(load_json_file(args.input), args.instance, args.timezone, args.first,
                                        args.last, args.rollup_days, args.tool_version)
            sys.stdout.write(dumps(require_valid('cohort', cohort)))
        elif args.command == 'compare':
            a, b_ = load_json_file(args.a), load_json_file(args.b)
            sys.stdout.write(dumps(require_valid('result', compare(a, b_, args.tolerance_percent_micro))))
        elif args.command == 'validate':
            require_valid(args.kind, load_json_file(args.input))
            sys.stdout.write('valid\n')
        else:
            outputs = build_case(args.case_dir)
            for name, text in outputs.items():
                if args.write:
                    with open(Path(args.case_dir) / name, 'w', encoding='utf-8', newline='\n') as handle:
                        handle.write(text)
            sys.stdout.write('\n'.join(sorted(outputs)) + '\n')
    except FormatError as error:
        sys.stderr.write(json.dumps({'errorCode': error.code, 'accepted': False, 'problems': error.problems[:50]},
                                    sort_keys=True) + '\n')
        return 2
    except (OSError, UnicodeDecodeError):
        sys.stderr.write(json.dumps({'errorCode': 'unreadable-input', 'accepted': False}) + '\n')
        return 2
    return 0


if __name__ == '__main__':
    # Comparator output is a UTF-8/LF byte contract. Windows text streams otherwise
    # translate '\n' to CRLF even when the canonical serializer emits LF.
    sys.stdout.reconfigure(encoding='utf-8', newline='\n')
    sys.stderr.reconfigure(encoding='utf-8', newline='\n')
    raise SystemExit(main())
