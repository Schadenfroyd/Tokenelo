/**
 * src/tray/renderer/detail-context.ts — the exact header/title strings detail.ts renders while a
 * load is pending or after it failed. They come from the requested source alone, so nothing from a
 * previously shown session can appear in them.
 */
import { describe, expect, it } from 'vitest';
import type { Source } from '../../src/tray/renderer/api-types.js';
import { failureContext, pendingContext, sourceLabel } from '../../src/tray/renderer/detail-context.js';

const SOURCES: Source[] = ['claude', 'codex', 'ollama-proxy', 'ollama-log', 'bench', 'qwen-code'];
// What a previously shown session would have contributed: project, host, model, metrics.
const PREVIOUS = ['parent-app', 'HOST-1', 'claude-opus-5-5', '$', 'elapsed', 'active', 'LIVE', 'ENDED'];

describe('pending and failure header context', () => {
  for (const source of SOURCES) {
    it(`${source}: pending and failure name only the source`, () => {
      for (const ctx of [pendingContext(source), failureContext(source)]) {
        const text = `${ctx.title} ${ctx.subtitle} ${ctx.documentTitle}`;
        for (const leak of PREVIOUS) expect(text).not.toContain(leak);
        expect(ctx.subtitle).toBe(sourceLabel(source));
      }
    });
  }

  it('the strings are fixed and the failure reason is not in them', () => {
    expect(pendingContext('claude')).toEqual({ title: 'Loading session…', subtitle: 'Claude', documentTitle: 'Tokenelo — Loading session' });
    expect(failureContext('codex')).toEqual({ title: 'Session unavailable', subtitle: 'Codex', documentTitle: 'Tokenelo — Session unavailable' });
  });

  it('an unrecognized source from the URL gets a neutral label', () => {
    expect(pendingContext('nonsense' as Source).subtitle).toBe('Unknown source');
  });
});
