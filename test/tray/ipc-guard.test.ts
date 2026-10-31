import { describe, expect, it } from 'vitest';
import {
  isReadRequestId,
  ipcRefusal,
  ALLOWED_RANGES,
  ALLOWED_SOURCES,
  isAllowedNavigation,
  isAllowedRange,
  isAllowedSource,
  isMainFrame,
  isReasonableSessionId,
  MAX_SESSION_ID_LEN,
} from '../../src/tray/ipc-guard.js';

describe('read request identity validation', () => {
  it('accepts a bounded opaque identity and refuses untrusted variants without a stack', () => {
    expect(isReadRequestId('a'.repeat(32))).toBe(true);
    for (const value of [undefined, null, 1, {}, 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), ' ' + 'a'.repeat(32), '../' + 'a'.repeat(32)]) expect(isReadRequestId(value)).toBe(false);
    const error = ipcRefusal('request'); expect(error.message).toBe('invalid read request'); expect(error.stack).toBeUndefined();
  });
});
describe('isAllowedRange', () => {
  it('accepts every value in ALLOWED_RANGES', () => {
    for (const r of ALLOWED_RANGES) {
      expect(isAllowedRange(r)).toBe(true);
    }
  });

  it('rejects an unknown string', () => {
    expect(isAllowedRange('bogus')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isAllowedRange('')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAllowedRange(undefined)).toBe(false);
  });

  it('rejects a number', () => {
    expect(isAllowedRange(123)).toBe(false);
  });

  it('rejects null', () => {
    expect(isAllowedRange(null)).toBe(false);
  });

  // Mutation check: a naive `ALLOWED_RANGES.includes(v as string)` cast with no type guard would
  // pass a non-string through to `.includes` after an implicit/forced cast in calling code, and a
  // naive case-insensitive or trimmed comparison would wrongly accept these near-misses. The real
  // implementation must reject them as distinct, disallowed values.
  it('rejects a valid range with different casing', () => {
    expect(isAllowedRange('Today')).toBe(false);
  });

  it('rejects a valid range with trailing whitespace', () => {
    expect(isAllowedRange('today ')).toBe(false);
  });
});

describe('isAllowedSource', () => {
  it('accepts the Qwen Code collector for session drill-down IPC', () => {
    expect(isAllowedSource('qwen-code')).toBe(true);
  });

  it('accepts every value in ALLOWED_SOURCES', () => {
    for (const s of ALLOWED_SOURCES) {
      expect(isAllowedSource(s)).toBe(true);
    }
  });

  it('rejects an unknown string, a number, null, and undefined', () => {
    expect(isAllowedSource('gemini')).toBe(false);
    expect(isAllowedSource(123)).toBe(false);
    expect(isAllowedSource(null)).toBe(false);
    expect(isAllowedSource(undefined)).toBe(false);
  });

  it('rejects a valid source with different casing', () => {
    expect(isAllowedSource('Claude')).toBe(false);
  });
});

describe('isReasonableSessionId', () => {
  it('accepts a normal non-empty string', () => {
    expect(isReasonableSessionId('abc-123')).toBe(true);
  });

  it('rejects an empty string, a non-string, null, and undefined', () => {
    expect(isReasonableSessionId('')).toBe(false);
    expect(isReasonableSessionId(42)).toBe(false);
    expect(isReasonableSessionId(null)).toBe(false);
    expect(isReasonableSessionId(undefined)).toBe(false);
  });

  it('accepts exactly MAX_SESSION_ID_LEN characters and rejects one more', () => {
    expect(isReasonableSessionId('a'.repeat(MAX_SESSION_ID_LEN))).toBe(true);
    expect(isReasonableSessionId('a'.repeat(MAX_SESSION_ID_LEN + 1))).toBe(false);
  });
});

describe('isMainFrame', () => {
  it('true when senderFrame is the same object as mainFrame', () => {
    const frameA = { id: 'a' };
    expect(isMainFrame(frameA, frameA)).toBe(true);
  });

  it('false when senderFrame and mainFrame are different objects', () => {
    const frameA = { id: 'a' };
    const frameB = { id: 'b' };
    expect(isMainFrame(frameA, frameB)).toBe(false);
  });

  it('false when senderFrame is null and mainFrame is a real frame', () => {
    const frameA = { id: 'a' };
    expect(isMainFrame(null, frameA)).toBe(false);
  });

  // Edge case pinned deliberately: production code never calls this with both sides undefined
  // (there is always a real popover mainFrame once handlers are registered), so this only exists
  // to document and lock in the `===` semantics rather than leaving it to guesswork.
  it('true when both senderFrame and mainFrame are undefined (pinned edge case, === semantics)', () => {
    expect(isMainFrame(undefined, undefined)).toBe(true);
  });
});

describe('isAllowedNavigation', () => {
  const allowedFilePath = '/app/dist/tray/renderer/index.html';

  it('true for the allowed file URL with a query string', () => {
    expect(isAllowedNavigation('file:///app/dist/tray/renderer/index.html?tab=now', allowedFilePath)).toBe(true);
  });

  it('true for the allowed file URL with no query string', () => {
    expect(isAllowedNavigation('file:///app/dist/tray/renderer/index.html', allowedFilePath)).toBe(true);
  });

  it('accepts the native Windows drive path used by production main, with range and theme query values', () => {
    const windowsPath = String.raw`C:\Temp\Tokenelo\dist\tray\renderer\index.html`;
    const target = 'file:///C:/Temp/Tokenelo/dist/tray/renderer/index.html?tab=usage&range=7d&theme=dark';
    expect(isAllowedNavigation(target, windowsPath)).toBe(true);
  });

  it('preserves a Windows URL-path caller and the previous POSIX pathname form', () => {
    const windowsUrlPath = '/C:/Temp/Tokenelo/dist/tray/renderer/index.html';
    const windowsUrl = 'file:///C:/Temp/Tokenelo/dist/tray/renderer/index.html';
    expect(isAllowedNavigation(windowsUrl, windowsUrlPath)).toBe(true);
    expect(isAllowedNavigation('file:///app/dist/tray/renderer/index.html', allowedFilePath)).toBe(true);
  });

  it('accepts localhost file URLs but rejects nonlocal and UNC file URL hosts', () => {
    expect(isAllowedNavigation('file://localhost/app/dist/tray/renderer/index.html', allowedFilePath)).toBe(true);
    expect(isAllowedNavigation('file://evil.example.com/app/dist/tray/renderer/index.html', allowedFilePath)).toBe(false);
    expect(isAllowedNavigation('file://server/share/renderer/index.html', String.raw`\\server\share\renderer\index.html`)).toBe(false);
  });

  it('false for a remote https URL', () => {
    expect(isAllowedNavigation('https://evil.example.com/', allowedFilePath)).toBe(false);
  });

  it('false for an unrelated local file', () => {
    expect(isAllowedNavigation('file:///etc/passwd', allowedFilePath)).toBe(false);
  });

  // Mutation check: verifies a `..`-relative file URL can't sneak past the pathname comparison.
  it('false for a ../-traversal file URL that resolves outside the allowed file', () => {
    const traversal = 'file:///app/dist/tray/renderer/../../../etc/passwd';
    expect(isAllowedNavigation(traversal, allowedFilePath)).toBe(false);
  });

  it('false for encoded dot-segment traversal outside the allowed Windows file', () => {
    const windowsPath = String.raw`C:\Temp\Tokenelo\dist\tray\renderer\index.html`;
    const traversal = 'file:///C:/Temp/Tokenelo/dist/tray/renderer/%2e%2e/%2e%2e/%2e%2e/secret/index.html';
    expect(isAllowedNavigation(traversal, windowsPath)).toBe(false);
  });

  it('false for a malformed percent escape instead of throwing', () => {
    const malformed = 'file:///app/dist/tray/renderer/%E0%A4%A';
    expect(isAllowedNavigation(malformed, allowedFilePath)).toBe(false);
  });

  // Empirical check (see ipc-guard.ts's isAllowedNavigation doc comment): WHATWG `URL`'s path
  // parser already resolves `.`/`..` dot-segments into a file: URL's `.pathname` on its own, so
  // this asserts the ACTUAL resolved value rather than assuming the raw string survives unchanged.
  it('empirical check: URL resolves ".." dot-segments in a file: URL pathname on its own', () => {
    const traversal = 'file:///app/dist/tray/renderer/../../../etc/passwd';
    expect(new URL(traversal).pathname).toBe('/app/etc/passwd');
  });

  it('true for a ../-traversal file URL that resolves back onto the allowed path itself', () => {
    const traversal = 'file:///app/dist/tray/renderer/../renderer/index.html';
    expect(isAllowedNavigation(traversal, allowedFilePath)).toBe(true);
  });

  it('false for a malformed URL', () => {
    expect(isAllowedNavigation('not a url at all', allowedFilePath)).toBe(false);
  });
});
