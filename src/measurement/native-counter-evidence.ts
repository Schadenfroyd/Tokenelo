import type { TokenCounts } from '../core/types.js';

/** Fixed numeric fields only. Missing, invalid, and reported zero remain distinct. */
export type NativeCounterObservation =
  | { state: 'reported'; value: number }
  | { state: 'missing' | 'invalid'; value: null };
export interface NativeCounterSnapshot {
  prompt_eval_count: NativeCounterObservation;
  prompt_eval_cached_count: NativeCounterObservation;
  eval_count: NativeCounterObservation;
}
export interface NativeCounterEvidence {
  policy: 'tokenelo/ollama-native-counters@v1';
  /** DESIGN 15.3.2 compatibility, explicitly a policy rather than a reported zero. */
  missingCachePolicy: 'assume-zero';
  snapshots: NativeCounterSnapshot[];
  historyCapped?: true;
  /** Field-wise maxima of actually reported integers, retained after vector capping. */
  largestReported?: Partial<Record<keyof NativeCounterSnapshot, number>>;
  historyInvalid?: true;
  historyConflict?: true;
  legacyMixed?: true;
}
export const NATIVE_COUNTER_POLICY = 'tokenelo/ollama-native-counters@v1';
const KEYS = ['prompt_eval_count', 'prompt_eval_cached_count', 'eval_count'] as const;
const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

function observe(raw: Record<string, unknown>, key: typeof KEYS[number]): NativeCounterObservation {
  const descriptor = Object.getOwnPropertyDescriptor(raw, key);
  if (!descriptor) return { state: 'missing', value: null };
  return 'value' in descriptor && valid(descriptor.value)
    ? { state: 'reported', value: descriptor.value }
    : { state: 'invalid', value: null };
}
export function captureNativeCounters(raw: Record<string, unknown>): NativeCounterEvidence {
  return { policy: NATIVE_COUNTER_POLICY, missingCachePolicy: 'assume-zero', snapshots: [{
    prompt_eval_count: observe(raw, 'prompt_eval_count'),
    prompt_eval_cached_count: observe(raw, 'prompt_eval_cached_count'),
    eval_count: observe(raw, 'eval_count'),
  }] };
}
export function supportedNativeCounters(e: NativeCounterEvidence): boolean {
  return e?.policy === NATIVE_COUNTER_POLICY && e.missingCachePolicy === 'assume-zero'
    && Array.isArray(e.snapshots) && e.snapshots.length > 0 && e.snapshots.length <= 64
    && (!e.largestReported || KEYS.every(k => e.largestReported![k] === undefined || valid(e.largestReported![k])))
    && e.snapshots.every(s => s && KEYS.every(k => {
      const f = s[k];
      return f && (f.state === 'reported' ? valid(f.value)
        : (f.state === 'missing' || f.state === 'invalid') && f.value === null);
    }));
}
/** Raw reports may enrich missing fields, but conflicting terminal vectors remain held. */
export function nativeCounterProjection(e: NativeCounterEvidence): TokenCounts {
  const result: TokenCounts = { inputFresh: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, reasoning: 0, countQuality: 'incomplete' };
  if (!supportedNativeCounters(e)) return result;
  const field = (key: typeof KEYS[number]) => {
    const observations = e.snapshots.map(s => s[key]);
    const reported = observations.filter((f): f is { state: 'reported'; value: number } => f.state === 'reported');
    const retained = e.largestReported?.[key];
    return { value: Math.max(0, retained ?? 0, ...reported.map(f => f.value)), known: reported.length > 0 || retained !== undefined,
      invalid: observations.some(f => f.state === 'invalid') };
  };
  const input = field('prompt_eval_count'), cache = field('prompt_eval_cached_count'), output = field('eval_count');
  // Numeric placeholders support old storage columns. Their raw evidence and quality
  // never permit an absent field to become a reported zero or a complete valuation.
  result.inputFresh = input.known && !cache.invalid ? Math.max(0, input.value - cache.value) : 0;
  result.cacheRead = cache.value;
  result.output = output.value;
  const invalid = e.historyInvalid || input.invalid || cache.invalid || output.invalid
    || input.known && cache.known && cache.value > input.value || e.snapshots.some(s =>
    s.prompt_eval_count.state === 'reported' && s.prompt_eval_cached_count.state === 'reported'
      && s.prompt_eval_cached_count.value > s.prompt_eval_count.value);
  let conflict = e.historyConflict ?? false;
  for (let a = 0; a < e.snapshots.length; a++) for (let b = a + 1; b < e.snapshots.length; b++) {
    let up = false, down = false;
    for (const key of KEYS) {
      const x = e.snapshots[a]![key], y = e.snapshots[b]![key];
      if (x.state !== 'reported' || y.state !== 'reported') continue;
      up ||= y.value > x.value; down ||= y.value < x.value;
    }
    conflict ||= up && down;
  }
  result.countQuality = conflict ? 'conflict' : invalid ? 'invalid'
    : !input.known || !output.known || e.historyCapped || e.legacyMixed ? 'incomplete' : 'complete';
  if (!Number.isSafeInteger(result.inputFresh + result.cacheRead + result.output)) result.countQuality = 'invalid';
  return result;
}
export function mergeNativeCounters(a: NativeCounterEvidence, b: NativeCounterEvidence): NativeCounterEvidence | null {
  if (!supportedNativeCounters(a) || !supportedNativeCounters(b)) return null;
  const all = [...a.snapshots, ...b.snapshots];
  const unique = [...new Map(all.map(s => [JSON.stringify(s), s])).values()];
  const largestReported: Partial<Record<keyof NativeCounterSnapshot, number>> = {};
  for (const key of KEYS) {
    const values = [a.largestReported?.[key], b.largestReported?.[key],
      ...all.map(s => s[key].state === 'reported' ? s[key].value : undefined)].filter(valid);
    if (values.length) largestReported[key] = Math.max(...values);
  }
  const historyInvalid = a.historyInvalid || b.historyInvalid || all.some(s => KEYS.some(k => s[k].state === 'invalid')
    || s.prompt_eval_count.state === 'reported' && s.prompt_eval_cached_count.state === 'reported'
      && s.prompt_eval_cached_count.value > s.prompt_eval_count.value)
    || largestReported.prompt_eval_count !== undefined && largestReported.prompt_eval_cached_count !== undefined
      && largestReported.prompt_eval_cached_count > largestReported.prompt_eval_count;
  let historyConflict: boolean = !!(a.historyConflict || b.historyConflict);
  for (const x of a.snapshots) for (const y of b.snapshots) {
    let up = false, down = false;
    for (const key of KEYS) {
      if (x[key].state !== 'reported' || y[key].state !== 'reported') continue;
      up ||= y[key].value! > x[key].value!; down ||= y[key].value! < x[key].value!;
    }
    historyConflict ||= up && down;
  }
  const capped = a.historyCapped || b.historyCapped || unique.length > 64;
  return { policy: NATIVE_COUNTER_POLICY, missingCachePolicy: 'assume-zero',
    snapshots: unique.slice(0, 64),
    ...(capped ? { historyCapped: true as const, largestReported } : {}),
    ...(historyInvalid ? { historyInvalid: true as const } : {}),
    ...(historyConflict ? { historyConflict: true as const } : {}),
    ...(a.legacyMixed || b.legacyMixed ? { legacyMixed: true as const } : {}) };
}
