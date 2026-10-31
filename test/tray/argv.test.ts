import { describe, expect, it } from 'vitest';
import { parseArgv, type TrayArgv } from '../../src/tray/argv.js';

/** The parse of an argv with no snapshot request. Each expectation lists only the fields that differ from it. */
const NOT_SNAPSHOT: TrayArgv = {
  snapshotRequested: false,
  snapshotPath: null,
  snapshotError: null,
  tab: 'now',
  theme: null,
  session: null,
  data: 'fixtures',
  dataError: null,
  rangeRequested: false,
  range: 'today',
  rangeError: null,
};

describe('parseArgv', () => {
  it('defaults: no snapshot request, tab "now", theme null, session null, fixtures', () => {
    expect(parseArgv([])).toEqual(NOT_SNAPSHOT);
  });

  it('parses --snapshot <path>', () => {
    expect(parseArgv(['--snapshot', 'out.png'])).toEqual({ ...NOT_SNAPSHOT, snapshotRequested: true, snapshotPath: 'out.png' });
  });

  it('parses --snapshot, --tab and --theme together, in any order', () => {
    expect(parseArgv(['--snapshot', 'out.png', '--tab', 'limits', '--theme', 'dark'])).toEqual({
      ...NOT_SNAPSHOT,
      snapshotRequested: true,
      snapshotPath: 'out.png',
      tab: 'limits',
      theme: 'dark',
    });
    expect(parseArgv(['--theme', 'light', '--tab', 'coverage', '--snapshot', 'a/b.png'])).toEqual({
      ...NOT_SNAPSHOT,
      snapshotRequested: true,
      snapshotPath: 'a/b.png',
      tab: 'coverage',
      theme: 'light',
    });
  });

  it('ignores an invalid --theme value (keeps null)', () => {
    expect(parseArgv(['--theme', 'blue'])).toEqual(NOT_SNAPSHOT);
  });

  it('unrecognized flags are ignored', () => {
    expect(parseArgv(['--foo', 'bar', '--snapshot', 'x.png'])).toEqual({ ...NOT_SNAPSHOT, snapshotRequested: true, snapshotPath: 'x.png' });
  });
});

describe('--snapshot without a usable path is a refused request, never a normal start', () => {
  it('a bare --snapshot requests a snapshot and refuses it, with no path', () => {
    const parsed = parseArgv(['--snapshot']);
    expect(parsed.snapshotRequested).toBe(true);
    expect(parsed.snapshotPath).toBeNull();
    expect(parsed.snapshotError).toMatch(/needs an output image path/);
  });

  it('an empty path is refused', () => {
    const parsed = parseArgv(['--snapshot', '']);
    expect(parsed.snapshotRequested).toBe(true);
    expect(parsed.snapshotError).not.toBeNull();
  });

  it('a following flag is never read as the path: --snapshot --data live refuses, and --data live still applies', () => {
    const parsed = parseArgv(['--snapshot', '--data', 'live']);
    expect(parsed.snapshotRequested).toBe(true);
    expect(parsed.snapshotPath).toBeNull();
    expect(parsed.snapshotError).not.toBeNull();
    expect(parsed.data).toBe('live');
  });

  it('a following --tab is not the path either', () => {
    const parsed = parseArgv(['--snapshot', '--tab', 'limits']);
    expect(parsed.snapshotPath).toBeNull();
    expect(parsed.snapshotError).not.toBeNull();
    expect(parsed.tab).toBe('limits');
  });

  it('a valid path after an earlier refused --snapshot clears the refusal (the last request wins)', () => {
    const parsed = parseArgv(['--snapshot', '--tab', 'coverage', '--snapshot', 'ok.png']);
    expect(parsed.snapshotPath).toBe('ok.png');
    expect(parsed.snapshotError).toBeNull();
  });

  it('a path that starts with a dash is refused, so a flag can never be taken as a path', () => {
    const parsed = parseArgv(['--snapshot', '-out.png']);
    expect(parsed.snapshotPath).toBeNull();
    expect(parsed.snapshotError).not.toBeNull();
  });
});

describe('a value flag never consumes the next flag', () => {
  it('--tab followed by --snapshot keeps the default tab and still requests the snapshot', () => {
    expect(parseArgv(['--tab', '--snapshot', 'x.png'])).toEqual({ ...NOT_SNAPSHOT, snapshotRequested: true, snapshotPath: 'x.png' });
  });

  it('--theme followed by --snapshot keeps the theme null and still requests the snapshot', () => {
    expect(parseArgv(['--theme', '--snapshot', 'x.png']).snapshotPath).toBe('x.png');
  });

  it('--session followed by --snapshot keeps the session null and still requests the snapshot', () => {
    const parsed = parseArgv(['--session', '--snapshot', 'x.png']);
    expect(parsed.session).toBeNull();
    expect(parsed.snapshotPath).toBe('x.png');
  });

  it('a trailing value flag with no value does not crash and yields its default', () => {
    expect(parseArgv(['--tab'])).toEqual(NOT_SNAPSHOT);
    expect(parseArgv(['--theme'])).toEqual(NOT_SNAPSHOT);
    expect(parseArgv(['--session'])).toEqual(NOT_SNAPSHOT);
  });
});

describe('--data', () => {
  it('accepts live and fixtures explicitly, and defaults to fixtures', () => {
    expect(parseArgv(['--snapshot', 'a.png', '--data', 'live']).data).toBe('live');
    expect(parseArgv(['--snapshot', 'a.png', '--data', 'fixtures']).data).toBe('fixtures');
    expect(parseArgv(['--snapshot', 'a.png']).data).toBe('fixtures');
  });

  it('an unknown or missing value is an error, never a silent default', () => {
    expect(parseArgv(['--snapshot', 'a.png', '--data', 'LIVE']).dataError).not.toBeNull();
    expect(parseArgv(['--snapshot', 'a.png', '--data']).dataError).not.toBeNull();
    const later = parseArgv(['--snapshot', 'a.png', '--data', 'bogus', '--data', 'live']);
    expect(later.data).toBe('live');
    expect(later.dataError).toBeNull();
  });
});

describe('--session <source>:<id>', () => {
  it('splits on the first ":" into {source, sessionId}', () => {
    expect(parseArgv(['--session', 'claude:abc-123']).session).toEqual({ source: 'claude', sessionId: 'abc-123' });
  });

  it('a sessionId containing further ":" characters is kept whole (split on the FIRST ":" only)', () => {
    expect(parseArgv(['--session', 'ollama-proxy:ollama:M4a:gemma4:26b:2026-09-26']).session).toEqual({
      source: 'ollama-proxy',
      sessionId: 'ollama:M4a:gemma4:26b:2026-09-26',
    });
  });

  it('a value with no ":" at all, or a leading/trailing ":" with nothing on one side, is ignored (session stays null)', () => {
    expect(parseArgv(['--session', 'no-colon-here']).session).toBeNull();
    expect(parseArgv(['--session', ':no-source']).session).toBeNull();
    expect(parseArgv(['--session', 'no-id:']).session).toBeNull();
  });

  it('combines with --snapshot/--tab/--theme', () => {
    expect(parseArgv(['--snapshot', 'd.png', '--session', 'codex:thread_1', '--theme', 'dark'])).toEqual({
      ...NOT_SNAPSHOT,
      snapshotRequested: true,
      snapshotPath: 'd.png',
      theme: 'dark',
      session: { source: 'codex', sessionId: 'thread_1' },
    });
  });
});
