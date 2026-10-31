import { describe, expect, it } from 'vitest';
import {
  CLAUDE_OBSERVATION_CONTRACT_VERSION,
  CLAUDE_OBSERVATION_POLICIES,
  observeClaudeMessage,
  observeNormalizedLegacy,
} from '../../src/measurement/claude-observation.js';

const reported = (value: number | string) => ({ state: 'reported', value });
const missing = { state: 'missing', value: null };
const invalid = { state: 'invalid', value: null };

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

describe('counters: reported vs missing vs invalid (zero is a value, not a presence marker)', () => {
  it('zero is reported, absent is missing, unusable values are invalid with no value retained', () => {
    const obs = observeClaudeMessage({
      usage: {
        input_tokens: 0,
        output_tokens: -1,
        cache_read_input_tokens: '5',
        // cache_creation_input_tokens absent
      },
    });
    expect(obs.topLevel.inputTokens).toEqual(reported(0));
    expect(obs.topLevel.outputTokens).toEqual(invalid);
    expect(obs.topLevel.cacheReadInputTokens).toEqual(invalid);
    expect(obs.topLevel.cacheCreation.flatTotal).toEqual(missing);
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -3],
    ['null', null],
    ['boolean', true],
    ['numeric string', '12'],
    ['object', { value: 1 }],
    ['bigint', 5n],
  ])('%s is invalid, never coerced to 0 or a number', (_label, bad) => {
    const obs = observeClaudeMessage({ usage: { input_tokens: bad } });
    expect(obs.topLevel.inputTokens).toEqual(invalid);
  });

  it('-0 is reported as the value 0 and non-integer finite values are kept verbatim', () => {
    const obs = observeClaudeMessage({ usage: { input_tokens: -0, output_tokens: 1.5 } });
    expect(Object.is(obs.topLevel.inputTokens.value, 0)).toBe(true);
    expect(obs.topLevel.outputTokens).toEqual(reported(1.5));
  });
});

describe('containers: present / absent / null / malformed stay distinct', () => {
  it('message and usage container states', () => {
    expect(observeClaudeMessage(null).messageContainer).toBe('null');
    expect(observeClaudeMessage([]).messageContainer).toBe('malformed');
    expect(observeClaudeMessage('x').messageContainer).toBe('malformed');
    expect(observeClaudeMessage({}).topLevel.container).toBe('absent');
    expect(observeClaudeMessage({ usage: null }).topLevel.container).toBe('null');
    expect(observeClaudeMessage({ usage: [1, 2] }).topLevel.container).toBe('malformed');
    expect(observeClaudeMessage({ usage: 'u' }).topLevel.container).toBe('malformed');
    expect(observeClaudeMessage({ usage: {} }).topLevel.container).toBe('present');
  });

  it('a non-present usage yields all-missing fields and undetermined top-level role', () => {
    const obs = observeClaudeMessage({ usage: null });
    expect(obs.topLevelDescribes).toBe('undetermined');
    expect(obs.topLevel.inputTokens).toEqual(missing);
    expect(obs.iterations).toEqual({ container: 'absent', length: null, components: [] });
    expect(obs.thinking.detailsContainer).toBe('absent');
  });

  it.each([
    ['absent', {}, 'absent'],
    ['null', { cache_creation: null }, 'null'],
    ['array', { cache_creation: [40] }, 'malformed'],
    ['number', { cache_creation: 40 }, 'malformed'],
    ['empty object', { cache_creation: {} }, 'present'],
  ])('cache_creation %s', (_label, usage, state) => {
    const obs = observeClaudeMessage({ usage: { cache_creation_input_tokens: 9, ...usage } });
    expect(obs.topLevel.cacheCreation.container).toBe(state);
    expect(obs.topLevel.cacheCreation.ephemeral5m).toEqual(missing);
    expect(obs.topLevel.cacheCreation.flatTotal).toEqual(reported(9));
  });

  it.each([
    ['absent', {}, 'absent', null, 'whole-message'],
    ['null', { iterations: null }, 'null', null, 'undetermined'],
    ['object', { iterations: { 0: {} } }, 'malformed', null, 'undetermined'],
    ['empty array', { iterations: [] }, 'present', 0, 'whole-message'],
  ])('iterations %s', (_label, usage, state, length, describes) => {
    const obs = observeClaudeMessage({ usage });
    expect(obs.iterations.container).toBe(state);
    expect(obs.iterations.length).toBe(length);
    expect(obs.iterations.components).toEqual([]);
    expect(obs.topLevelDescribes).toBe(describes);
  });
});

describe('cache creation: flat total and nested TTL split kept side by side, no clamp/fallback/residual', () => {
  it('partial split (5m only) keeps the flat 100, 5m 40, and 1h missing — no 60 is invented', () => {
    const obs = observeClaudeMessage({
      usage: { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 40 } },
    });
    expect(obs.topLevel.cacheCreation).toEqual({
      flatTotal: reported(100),
      container: 'present',
      ephemeral5m: reported(40),
      ephemeral1h: missing,
    });
  });

  it('explicit zero split keeps the flat total (the production branch would discard it)', () => {
    const obs = observeClaudeMessage({
      usage: { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } },
    });
    expect(obs.topLevel.cacheCreation).toEqual({
      flatTotal: reported(100),
      container: 'present',
      ephemeral5m: reported(0),
      ephemeral1h: reported(0),
    });
  });

  it('split above flat is retained verbatim (conflict is for reconciliation, not clamped here)', () => {
    const obs = observeClaudeMessage({
      usage: { cache_creation_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 40, ephemeral_1h_input_tokens: 5 } },
    });
    expect(obs.topLevel.cacheCreation.flatTotal).toEqual(reported(10));
    expect(obs.topLevel.cacheCreation.ephemeral5m).toEqual(reported(40));
    expect(obs.topLevel.cacheCreation.ephemeral1h).toEqual(reported(5));
  });

  it('split without flat total does not reconstruct the flat total; no split does not assume 1h', () => {
    const splitOnly = observeClaudeMessage({ usage: { cache_creation: { ephemeral_1h_input_tokens: 7 } } });
    expect(splitOnly.topLevel.cacheCreation.flatTotal).toEqual(missing);
    const flatOnly = observeClaudeMessage({ usage: { cache_creation_input_tokens: 30 } });
    expect(flatOnly.topLevel.cacheCreation).toEqual({ flatTotal: reported(30), container: 'absent', ephemeral5m: missing, ephemeral1h: missing });
  });

  it('flat cache_creation_5m/1h_input_tokens (Meter-style) are not mistaken for the nested split', () => {
    const obs = observeClaudeMessage({ usage: { cache_creation_5m_input_tokens: 40, cache_creation_1h_input_tokens: 60 } });
    expect(obs.topLevel.cacheCreation).toEqual({ flatTotal: missing, container: 'absent', ephemeral5m: missing, ephemeral1h: missing });
  });
});

describe('iterations: ordinals, roles, per-iteration model/speed; top-level is the final iteration, never summed', () => {
  const twoIterations = (top: { input_tokens: number; output_tokens: number }) => ({
    model: 'claude-opus-5-5',
    usage: {
      ...top,
      speed: 'fast',
      iterations: [
        { input_tokens: 80, output_tokens: 20, model: 'claude-sonnet-5', speed: 'standard' },
        { input_tokens: 100, output_tokens: 20, model: 'claude-opus-5-5' },
      ],
    },
  });

  it('records each iteration with its ordinal/final role and its OWN model/speed (no fallback)', () => {
    const obs = observeClaudeMessage(twoIterations({ input_tokens: 100, output_tokens: 20 }));
    expect(obs.topLevelDescribes).toBe('final-iteration');
    expect(obs.messageModel).toEqual(reported('claude-opus-5-5'));
    expect(obs.iterations.length).toBe(2);
    const [first, last] = obs.iterations.components;
    expect(first).toMatchObject({ role: 'iteration', ordinal: 0, final: false, container: 'present' });
    expect(first!.model).toEqual(reported('claude-sonnet-5'));
    expect(first!.speed).toEqual(reported('standard'));
    expect(last).toMatchObject({ role: 'iteration', ordinal: 1, final: true });
    expect(last!.speed).toEqual(missing); // not filled from top-level 'fast'
    expect(obs.topLevel).toMatchObject({ role: 'top-level', ordinal: null, final: true });
    expect(obs.topLevel.model).toEqual(missing); // message.model is recorded separately, not applied
    expect(obs.topLevel.speed).toEqual(reported('fast'));
  });

  it('top-level 100/20 vs iteration sum 180/40 is the normal shape: values kept, nothing summed or flagged', () => {
    const obs = observeClaudeMessage(twoIterations({ input_tokens: 100, output_tokens: 20 }));
    expect(obs.topLevel.inputTokens).toEqual(reported(100));
    expect(obs.iterations.components.map((c) => c.inputTokens.value)).toEqual([80, 100]);
    expect(Object.keys(obs).sort()).toEqual(
      ['iterations', 'kind', 'messageContainer', 'messageModel', 'provenance', 'thinking', 'topLevel', 'topLevelDescribes'].sort(),
    );
    expect(JSON.stringify(obs)).not.toMatch(/conflict|180|aggregate/i);
  });

  it('top-level 101/20 differing from the final iteration is retained as observed (reconciliation is deferred)', () => {
    const obs = observeClaudeMessage(twoIterations({ input_tokens: 101, output_tokens: 20 }));
    expect(obs.topLevel.inputTokens).toEqual(reported(101));
    expect(obs.iterations.components[1]!.inputTokens).toEqual(reported(100));
    expect(JSON.stringify(obs)).not.toMatch(/conflict/i);
  });

  it('null, non-object and sparse entries keep their ordinals with distinct container states', () => {
    // eslint-disable-next-line no-sparse-arrays
    const obs = observeClaudeMessage({ usage: { iterations: [null, 'x', , { output_tokens: 0 }] } });
    expect(obs.iterations.components.map((c) => [c.ordinal, c.container, c.final])).toEqual([
      [0, 'null', false],
      [1, 'malformed', false],
      [2, 'absent', false],
      [3, 'present', true],
    ]);
    expect(obs.iterations.components[3]!.outputTokens).toEqual(reported(0));
    expect(obs.iterations.components[0]!.outputTokens).toEqual(missing);
  });

  it('invalid speed/model strings are invalid; path-like model text is never retained', () => {
    const obs = observeClaudeMessage({
      model: 'C:\\Users\\someone\\secret-project',
      usage: { speed: 'turbo', iterations: [{ model: 'claude opus with spaces', speed: 7 }, { model: '<synthetic>' }] },
    });
    expect(obs.messageModel).toEqual(invalid);
    expect(obs.topLevel.speed).toEqual(invalid);
    expect(obs.iterations.components[0]!.model).toEqual(invalid);
    expect(obs.iterations.components[0]!.speed).toEqual(invalid);
    expect(obs.iterations.components[1]!.model).toEqual(reported('<synthetic>'));
    expect(JSON.stringify(obs)).not.toMatch(/someone|secret|turbo|spaces/);
  });
});

describe('thinking: content SIGNAL and details container presence, no mode claimed', () => {
  it('thinking block present with no output_tokens_details: signal present, container absent', () => {
    const obs = observeClaudeMessage({
      content: [{ type: 'thinking', thinking: 'PRIVATE REASONING', signature: 'SIG123' }, { type: 'text', text: 'PROMPT ECHO' }],
      usage: {},
    });
    expect(obs.thinking).toEqual({ contentSignal: 'present', detailsContainer: 'absent', thinkingTokens: missing });
    expect(JSON.stringify(obs)).not.toMatch(/PRIVATE|SIG123|PROMPT/);
  });

  it('redacted_thinking counts as signal; text-only content is absent; missing/non-array content is unobservable', () => {
    expect(observeClaudeMessage({ content: [{ type: 'redacted_thinking', data: 'x' }] }).thinking.contentSignal).toBe('present');
    expect(observeClaudeMessage({ content: [{ type: 'text', text: 'hi' }, null, 'str'] }).thinking.contentSignal).toBe('absent');
    expect(observeClaudeMessage({ content: [] }).thinking.contentSignal).toBe('absent');
    expect(observeClaudeMessage({}).thinking.contentSignal).toBe('unobservable');
    expect(observeClaudeMessage({ content: 'thinking' }).thinking.contentSignal).toBe('unobservable');
  });

  it('present details with explicit zero vs present details without the field vs null vs absent stay distinct', () => {
    const zero = observeClaudeMessage({ usage: { output_tokens_details: { thinking_tokens: 0 } } });
    expect(zero.thinking).toEqual({ contentSignal: 'unobservable', detailsContainer: 'present', thinkingTokens: reported(0) });
    const empty = observeClaudeMessage({ usage: { output_tokens_details: {} } });
    expect(empty.thinking).toMatchObject({ detailsContainer: 'present', thinkingTokens: missing });
    const nul = observeClaudeMessage({ usage: { output_tokens_details: null } });
    expect(nul.thinking).toMatchObject({ detailsContainer: 'null', thinkingTokens: missing });
    const absent = observeClaudeMessage({ usage: {} });
    expect(absent.thinking).toMatchObject({ detailsContainer: 'absent', thinkingTokens: missing });
    const positive = observeClaudeMessage({ usage: { output_tokens_details: { thinking_tokens: 12 } } });
    expect(positive.thinking.thinkingTokens).toEqual(reported(12));
  });

  it('exposes no resolved thinking mode or valuation eligibility', () => {
    const obs = observeClaudeMessage({ usage: {} });
    expect(Object.keys(obs.thinking).sort()).toEqual(['contentSignal', 'detailsContainer', 'thinkingTokens']);
  });
});

describe('privacy, purity and own-property reads', () => {
  const rich = () => ({
    id: 'msg_01SECRETID',
    model: 'claude-opus-5-5',
    role: 'assistant',
    content: [{ type: 'text', text: 'patient record 4411' }, { type: 'tool_use', input: { path: 'C:/Users/x/creds.env' } }],
    usage: {
      input_tokens: 3,
      output_tokens: 4,
      service_tier: 'standard',
      inference_geo: 'us',
      request_id: 'req_SECRET',
      api_key: 'sk-ant-SECRET',
      cache_creation: { ephemeral_5m_input_tokens: 1, extra: 'EXTRA_NESTED' },
      iterations: [{ input_tokens: 3, output_tokens: 4, session_id: 'sess_SECRET' }],
      output_tokens_details: { thinking_tokens: 0, note: 'NOTE_SECRET' },
    },
  });

  it('no unrelated property, id, content, path or credential escapes', () => {
    const json = JSON.stringify(observeClaudeMessage(rich(), { dedupKeyClass: 'message-id' }));
    for (const s of ['SECRET', 'patient', 'creds', 'EXTRA_NESTED', 'inference_geo', 'service_tier', 'tool_use', 'assistant', '"us"']) {
      expect(json).not.toContain(s);
    }
    expect(json).toContain('"dedupKeyClass":"message-id"');
  });

  it('does not mutate input and works on deeply frozen input', () => {
    const input = rich();
    const before = structuredClone(input);
    observeClaudeMessage(input);
    expect(input).toEqual(before);
    expect(() => observeClaudeMessage(deepFreeze(rich()))).not.toThrow();
  });

  it('returns fresh objects: mutating one result does not affect another', () => {
    const a = observeClaudeMessage({ usage: {} });
    (a.topLevel.inputTokens as { state: string }).state = 'tampered';
    const b = observeClaudeMessage({ usage: {} });
    expect(b.topLevel.inputTokens).toEqual(missing);
  });

  it('inherited properties are missing, not reported', () => {
    const usage = Object.create({ input_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 1 } }) as object;
    const message = Object.create({ usage: { input_tokens: 9 } }) as object;
    expect(observeClaudeMessage({ usage }).topLevel.inputTokens).toEqual(missing);
    expect(observeClaudeMessage({ usage }).topLevel.cacheCreation.container).toBe('absent');
    expect(observeClaudeMessage(message).topLevel.container).toBe('absent');
  });

  it('accessor properties are never invoked and count as invalid/malformed', () => {
    let calls = 0;
    const usage = {};
    Object.defineProperty(usage, 'input_tokens', { enumerable: true, get: () => (calls++, 5) });
    Object.defineProperty(usage, 'cache_creation', { enumerable: true, get: () => (calls++, {}) });
    const obs = observeClaudeMessage({ usage });
    expect(calls).toBe(0);
    expect(obs.topLevel.inputTokens).toEqual(invalid);
    expect(obs.topLevel.cacheCreation.container).toBe('malformed');
  });
});

describe('provenance: static policy identities vs unknown historical provenance', () => {
  it('raw observation names this seam\'s policies and marks unapplied policies not-applied', () => {
    const obs = observeClaudeMessage({ usage: {} }, { sourceBuild: '2.1.40' });
    expect(obs.provenance).toEqual({
      contractVersion: CLAUDE_OBSERVATION_CONTRACT_VERSION,
      normalization: 'none',
      parser: CLAUDE_OBSERVATION_POLICIES.parser,
      thinkingSignal: CLAUDE_OBSERVATION_POLICIES.thinkingSignal,
      componentSelection: 'not-applied',
      dedup: 'not-applied',
      merge: 'not-applied',
      ttlFallback: 'not-applied',
      sourceBuild: reported('2.1.40'),
      dedupKeyClass: 'unknown',
    });
  });

  it('sourceBuild: omitted is missing, path-like or non-string is invalid and not retained', () => {
    expect(observeClaudeMessage({}).provenance.sourceBuild).toEqual(missing);
    const bad = observeClaudeMessage({}, { sourceBuild: 'C:/Users/x/claude' });
    expect(bad.provenance.sourceBuild).toEqual(invalid);
    expect(JSON.stringify(bad)).not.toContain('Users');
    expect(observeClaudeMessage({}, { sourceBuild: 2 }).provenance.sourceBuild).toEqual(invalid);
  });

  it('rejects an unrecognized dedupKeyClass (no actual key is ever accepted)', () => {
    expect(() => observeClaudeMessage({}, { dedupKeyClass: 'msg_01ABC' as never })).toThrow(TypeError);
  });
});

describe('normalized legacy rows: provenance unknown, presence never invented', () => {
  const row = { inputFresh: 5, cacheWrite5m: 0, cacheWrite1h: 100, cacheRead: 0, output: 20, reasoning: 0 };

  it('values are retained as unknown-after-normalization; containers, policies and flat total are unknown', () => {
    const obs = observeNormalizedLegacy(row, ['cacheSplitAssumed', 'thinkingUnknown']);
    expect(obs.provenance).toEqual({
      contractVersion: CLAUDE_OBSERVATION_CONTRACT_VERSION,
      normalization: 'tokenelo-normalized',
      parser: 'unknown',
      thinkingSignal: 'unknown',
      componentSelection: 'unknown',
      dedup: 'unknown',
      merge: 'unknown',
      ttlFallback: 'unknown',
    });
    expect(obs.normalized.reasoning).toEqual({ state: 'unknown-after-normalization', normalizedValue: 0 });
    expect(obs.normalized.cacheWrite1h).toEqual({ state: 'unknown-after-normalization', normalizedValue: 100 });
    expect(obs.cacheCreationFlatTotal).toEqual({ state: 'unknown-after-normalization', value: null });
    expect(obs.containers).toEqual({ cacheCreation: 'unknown', outputTokensDetails: 'unknown', iterations: 'unknown' });
    expect(obs.recordedFlags).toEqual(['cacheSplitAssumed', 'thinkingUnknown']);
    expect(JSON.stringify(obs)).not.toMatch(/"reported"|"present"|"missing"/);
  });

  it('a normalized reasoning zero does not establish output_tokens_details presence', () => {
    const obs = observeNormalizedLegacy(row);
    expect(obs.containers.outputTokensDetails).toBe('unknown');
    expect(obs.recordedFlags).toEqual([]);
  });

  it('invalid or absent normalized values are invalid; unrecognized flags and non-object rows are handled', () => {
    const obs = observeNormalizedLegacy({ ...row, output: -1, reasoning: undefined }, ['mergedComponentsMisaligned', 'reasoningClamped', 7]);
    expect(obs.normalized.output).toEqual({ state: 'invalid', normalizedValue: null });
    expect(obs.normalized.reasoning).toEqual({ state: 'invalid', normalizedValue: null });
    expect(obs.recordedFlags).toEqual(['reasoningClamped']);
    expect(observeNormalizedLegacy(null).normalized.inputFresh).toEqual({ state: 'invalid', normalizedValue: null });
  });
});
