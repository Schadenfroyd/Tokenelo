import { describe, expect, it } from 'vitest';
import type { LocalValue, ModelRow, SessionRow, SessionTelemetryFeed } from '../../src/tray/renderer/api-types.js';
import { localModelSessionDrilldownAllowed, localModelSessionMatches } from '../../src/tray/renderer/local-model-sessions.js';

const model: Pick<ModelRow, 'model' | 'source' | 'provider'> = { model: 'qwen3:8b', source: 'ollama-proxy', provider: 'local' };

function feed(overrides: Partial<SessionTelemetryFeed> = {}): SessionTelemetryFeed {
  return {
    host: 'peer-box', source: 'ollama-proxy', provider: 'local', models: ['qwen3:8b'], events: 2,
    tokens: {} as SessionTelemetryFeed['tokens'], apiEquivUsd: 0, unpricedEvents: 0,
    firstEventAt: 10, lastEventAt: 20, flags: {}, ...overrides,
  };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'ollama-proxy', sessionId: 'session-1', host: 'peer-box', models: ['qwen3:8b'],
    start: 0, end: 10, activeMs: 10, live: false, subagents: 0,
    tokens: {} as SessionRow['tokens'], apiEquivUsd: 0, burn: null,
    ...overrides,
  };
}

describe('local model session drilldown permission', () => {
  it('keeps the session drilldown unavailable for malformed component evidence', () => {
    const malformed: Pick<LocalValue, 'readEvidence'> = { readEvidence: { version: 1, state: 'malformed-components', captureMode: 'proxy', events: 2, readableEvents: 1, malformedComponentEvents: 1 } };
    expect(localModelSessionDrilldownAllowed(malformed)).toBe(false);
  });

  it('allows the drilldown when the model evidence is not held', () => {
    expect(localModelSessionDrilldownAllowed({})).toBe(true);
  });
});

describe('local model session drilldown matching', () => {
  it('does not match a nonlocal model row', () => {
    const candidate = session({ telemetry: [feed()] });
    expect(localModelSessionMatches({ ...model, provider: 'openai' }, [candidate])).toEqual([]);
  });

  it('matches exact source/model presence in local telemetry without splitting session totals', () => {
    const candidate = session({ telemetry: [feed({ models: ['llama3:8b', 'qwen3:8b'] })] });
    expect(localModelSessionMatches(model, [candidate])).toEqual([{ session: candidate, evidence: 'telemetry' }]);
  });

  it('requires local provider, exact host/source/model, and positive event count in telemetry', () => {
    const candidates = [
      session({ sessionId: 'api', telemetry: [feed({ provider: 'openai' })] }),
      session({ sessionId: 'wrong-source', telemetry: [feed({ source: 'claude' })] }),
      session({ sessionId: 'wrong-host', telemetry: [feed({ host: 'A2000' })] }),
      session({ sessionId: 'zero', telemetry: [feed({ events: 0 })] }),
      session({ sessionId: 'wrong-model', telemetry: [feed({ models: ['llama3:8b'] })] }),
    ];
    expect(localModelSessionMatches(model, candidates)).toEqual([]);
  });

  it('does not fall back to legacy model names when telemetry is present but has no match', () => {
    const candidate = session({ models: ['qwen3:8b'], telemetry: [] });
    expect(localModelSessionMatches(model, [candidate])).toEqual([]);
  });

  it('uses source/model metadata only when older session responses omit telemetry', () => {
    const legacy = session({ telemetry: undefined });
    const wrongSource = session({ source: 'codex', telemetry: undefined });
    expect(localModelSessionMatches(model, [legacy, wrongSource])).toEqual([{ session: legacy, evidence: 'legacy-model-list' }]);
  });

  it('orders matched summaries newest first with a stable session-id tie break', () => {
    const older = session({ sessionId: 'z', end: 10, telemetry: [feed()] });
    const tied = session({ sessionId: 'b', end: 20, telemetry: [feed()] });
    const newest = session({ sessionId: 'a', end: 20, telemetry: [feed()] });
    expect(localModelSessionMatches(model, [older, tied, newest]).map((match) => match.session.sessionId)).toEqual(['a', 'b', 'z']);
  });
});