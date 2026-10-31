import { describe, expect, it } from 'vitest';
import { limitSubjectLabel } from '../../src/tray/renderer/limit-subject.js';

describe('limit subject labels', () => {
  it('labels a configured account as an account', () => {
    expect(limitSubjectLabel({ account: 'A', host: 'B' })).toBe('Account A');
  });

  it('labels an unmapped host as a host rather than implying it is an account', () => {
    expect(limitSubjectLabel({ host: 'A' })).toBe('Host A');
  });

  it('does not present an explicitly empty account ID as an unmapped host', () => {
    expect(limitSubjectLabel({ account: '', host: 'A' })).toBe('Account ID missing · observed on Host A');
  });

  it('treats whitespace-only account IDs as missing', () => {
    expect(limitSubjectLabel({ account: '   ', host: 'A' })).toBe('Account ID missing · observed on Host A');
  });
});
