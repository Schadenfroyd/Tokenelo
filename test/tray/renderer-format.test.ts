/**
 * src/tray/renderer/format.ts — the popover's own formatters (kept separate from
 * src/tray/format.ts for the rootDir reason documented at the top of that file). Hand-computed
 * expected values throughout.
 */
import { describe, expect, it } from 'vitest';
import {
  formatClock,
  formatCompactNumber,
  formatDuration,
  formatMoney,
  formatPercent,
  formatTokPerSec,
  projectBasename,
  sessionDisplayName,
  statusTone,
} from '../../src/tray/renderer/format.js';

describe('formatMoney / formatCompactNumber (renderer copy)', () => {
  it('matches the main-process formatter for the same inputs', () => {
    expect(formatMoney(184.3)).toBe('$184.30');
    expect(formatCompactNumber(2143)).toBe('2.1k');
  });
});

describe('formatPercent', () => {
  it('0.953 -> "95.3%"', () => {
    expect(formatPercent(0.953)).toBe('95.3%');
  });
  it('0 -> "0.0%"', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });
  it('1 -> "100.0%"', () => {
    expect(formatPercent(1)).toBe('100.0%');
  });
});

describe('formatDuration (renderer copy matches main-process rule)', () => {
  it('83 minutes -> "1h 23m"', () => {
    expect(formatDuration(83 * 60_000)).toBe('1h 23m');
  });
});

describe('formatClock', () => {
  it('0ms -> "00:00:00"', () => {
    expect(formatClock(0)).toBe('00:00:00');
  });
  it('negative ms clamps to "00:00:00"', () => {
    expect(formatClock(-1000)).toBe('00:00:00');
  });
  it('3661 seconds (1h 1m 1s) -> "01:01:01"', () => {
    expect(formatClock(3_661_000)).toBe('01:01:01');
  });
  it('96 minutes -> "01:36:00"', () => {
    expect(formatClock(96 * 60_000)).toBe('01:36:00');
  });
});

describe('formatTokPerSec', () => {
  it('0 tokens -> "0"', () => {
    expect(formatTokPerSec(0, 1000)).toBe('0');
  });
  it('0 duration -> "0" (never Infinity/NaN)', () => {
    expect(formatTokPerSec(500, 0)).toBe('0');
  });
  it('420 tokens over 1000ms -> "420" tok/s', () => {
    expect(formatTokPerSec(420, 1000)).toBe('420');
  });
  it('123 tokens over 2000ms -> 61.5 tok/s', () => {
    expect(formatTokPerSec(123, 2000)).toBe('61.5');
  });
});

describe('projectBasename', () => {
  it('undefined -> "(unknown)"', () => {
    expect(projectBasename(undefined)).toBe('(unknown)');
  });
  it('posix path -> last segment', () => {
    expect(projectBasename('/fixture/tokenelo')).toBe('tokenelo');
  });
  it('windows-style path -> last segment', () => {
    expect(projectBasename('C:\\Temp\\kf-dispatches\\alpha-5cc12')).toBe('alpha-5cc12');
  });
  it('trailing slash is ignored', () => {
    expect(projectBasename('/fixture/tokenelo/')).toBe('tokenelo');
  });
});

describe('sessionDisplayName — recorded server-log UTC day', () => {
  it('shows the UTC day of an Ollama server-log bucket, keeping its route identity intact', () => {
    const session = { source: 'ollama-log', sessionId: 'serverlog:llama3.2:3b:2026-09-19' };
    expect(sessionDisplayName(session)).toBe('2026-09-19 UTC');
    expect(session.sessionId).toBe('serverlog:llama3.2:3b:2026-09-19');
  });

  it('keeps workspace labels ahead of the fallback bucket label', () => {
    expect(sessionDisplayName({ source: 'ollama-log', sessionId: 'serverlog:model:2026-09-19', project: 'C:\\work\\rates' })).toBe('rates');
    expect(sessionDisplayName({ source: 'ollama-log', sessionId: 'serverlog:model:2026-09-19', repoRoot: '/work/vendor-check' })).toBe('vendor-check');
  });

  it('accepts a real leap day without converting the stored day to local time', () => {
    expect(sessionDisplayName({ source: 'ollama-log', sessionId: 'serverlog:model:2024-02-29' })).toBe('2024-02-29 UTC');
  });

  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00'])('does not invent a date for invalid bucket day %s', day => {
    expect(sessionDisplayName({ source: 'ollama-log', sessionId: `serverlog:model:${day}` })).toBe('Session serverlo…');
  });

  it.each(['serverlog:model:2026-9-19', 'serverlog::2026-09-19', 'serverlog:model:2026-09-19:extra', 'unrelated:model:2026-09-19'])('leaves an unknown server-log identity %s as an identity preview', sessionId => {
    expect(sessionDisplayName({ source: 'ollama-log', sessionId })).toBe(`Session ${sessionId.slice(0, 8)}…`);
  });

  it('does not interpret a lookalike identity belonging to another collector or legacy unknown source', () => {
    const sessionId = 'serverlog:model:2026-09-19';
    expect(sessionDisplayName({ source: 'ollama-cli', sessionId })).toBe('Session serverlo…');
    expect(sessionDisplayName({ sessionId })).toBe('Session serverlo…');
  });

  it('preserves ordinary and missing identity labels', () => {
    expect(sessionDisplayName({ sessionId: 'abc123' })).toBe('Session abc123');
    expect(sessionDisplayName({ sessionId: '' })).toBe('Session identity unavailable');
  });
});

describe('statusTone', () => {
  it('maps strong-evidence statuses to good', () => {
    expect(statusTone('MEASURED')).toBe('good');
    expect(statusTone('LIST')).toBe('good');
  });
  it('maps provisional/estimate statuses to warn', () => {
    expect(statusTone('PROVISIONAL-MEASURED')).toBe('warn');
    expect(statusTone('ESTIMATE')).toBe('warn');
  });
  it('maps filed-example/placeholder/unpriced to bad', () => {
    expect(statusTone('FILED-EXAMPLE')).toBe('bad');
    expect(statusTone('PLACEHOLDER')).toBe('bad');
    expect(statusTone('UNPRICED')).toBe('bad');
  });
  it('maps NONE (and unknown strings) to neutral', () => {
    expect(statusTone('NONE')).toBe('neutral');
    expect(statusTone('anything-else')).toBe('neutral');
  });
});
