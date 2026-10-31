/**
 * Sanity checks on the known-agent catalog (build item 6's data file) — cheap structural
 * invariants that would otherwise only surface as a confusing coverage-tab bug.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG } from '../../src/core/agent-catalog.js';

describe('AGENT_CATALOG', () => {
  it('every id is unique and non-empty', () => {
    const ids = AGENT_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });

  it('an entry never declares both source (UsageEvent capture) and limitsSource (LimitSnapshot capture)', () => {
    for (const e of AGENT_CATALOG) {
      expect(e.source !== undefined && e.limitsSource !== undefined).toBe(false);
    }
  });

  it('a captured entry (source or limitsSource set) documents capturedVia; an uncaptured one may still be notCapturableReason\'d', () => {
    for (const e of AGENT_CATALOG) {
      if (e.source || e.eventSelectors?.length || e.limitsSource) expect(e.capturedVia).toBeTruthy();
    }
  });

  it('every processMatch regex actually compiles and is case-insensitive (agent binaries are matched by path, casing varies by OS)', () => {
    for (const e of AGENT_CATALOG) {
      if (!e.processMatch) continue;
      expect(e.processMatch).toBeInstanceOf(RegExp);
      expect(e.processMatch.flags).toContain('i');
    }
  });

  it('category is one of the four documented CoverageCategory values', () => {
    const valid = new Set(['cloud-agent-cli', 'cloud-agent-desktop', 'local-llm-server', 'other']);
    for (const e of AGENT_CATALOG) expect(valid.has(e.category)).toBe(true);
  });

  it('the explicitly-named build-item-5 tools are present: claude, codex, qwen, ollama, docker model runner, vllm, cursor', () => {
    const ids = new Set(AGENT_CATALOG.map((e) => e.id));
    for (const expected of ['claude-code-cli', 'codex-cli', 'qwen-code-cli', 'ollama', 'docker-model-runner', 'vllm', 'cursor']) {
      expect(ids.has(expected)).toBe(true);
    }
  });
});
