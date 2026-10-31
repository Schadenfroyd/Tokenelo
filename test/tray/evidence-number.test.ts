import { describe, expect, it } from 'vitest';
import { evidenceNumber } from '../../src/tray/renderer/evidence-number.js';
import { usdWithinTolerance } from '../../src/tray/renderer/response-evidence.js';

describe('compact response evidence with inspectable exact values', () => {
  it('keeps known zero distinct from unknown and tiny nonzero', () => {
    expect(evidenceNumber(0, 'usd')).toEqual({ text: '$0', exact: '0', rounded: false });
    expect(evidenceNumber(null, 'usd')).toEqual({ text: 'Unknown', exact: null, rounded: false });
    expect(evidenceNumber(2e-8, 'usd')).toEqual({ text: '$2e-8', exact: '2e-8', rounded: false });
  });
  it('shortens historical floating-point noise and retains both exact values', () => {
    for (const value of [281.9460422999998, 281.9460423000004]) {
      expect(evidenceNumber(value, 'usd')).toEqual({ text: '≈$281.946', exact: String(value), rounded: true });
      expect(Number(evidenceNumber(value, 'usd').exact)).toBe(value);
    }
    expect(usdWithinTolerance(281.9460422999998, 281.9460423000004)).toBe(true);
  });
  it('a display collision never changes a real comparison mismatch', () => {
    const left = 50.0000001, right = 50.0000005;
    expect(evidenceNumber(left, 'usd').text).toBe(evidenceNumber(right, 'usd').text);
    expect(evidenceNumber(left, 'usd').exact).not.toBe(evidenceNumber(right, 'usd').exact);
    expect(usdWithinTolerance(left, right)).toBe(false);
  });
  it('retains the sign for rounded negative amounts', () => {
    expect(evidenceNumber(-281.9460422999998, 'usd')).toMatchObject({ text: '≈-$281.946', rounded: true });
    expect(evidenceNumber(-2e-8, 'usd')).toMatchObject({ text: '-$2e-8', rounded: false });
  });
  it('extreme finite numbers have compact finite text and round-trip exact evidence', () => {
    for (const value of [Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, 1.23456789e-100]) {
      const result = evidenceNumber(value, 'usd');
      expect(result.text).not.toMatch(/Infinity|NaN|Unknown/);
      expect(result.text.length).toBeLessThanOrEqual(12);
      expect(Number(result.exact)).toBe(value);
    }
  });
  it('large event counts remain exact in the separate comparison disclosure', () => {
    expect(evidenceNumber(999999, 'count')).toEqual({ text: '999999', exact: '999999', rounded: false });
    expect(evidenceNumber(Number.MAX_SAFE_INTEGER, 'count')).toEqual({ text: '≈9.01e+15', exact: '9007199254740991', rounded: true });
  });
  it('invalid values never acquire known number display', () => {
    for (const value of [NaN, Infinity, -Infinity]) expect(evidenceNumber(value, 'usd').exact).toBeNull();
    for (const value of [-1, 1.5, 2 ** 53]) expect(evidenceNumber(value, 'count').text).toBe('Unknown');
  });
});
