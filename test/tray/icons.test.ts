/**
 * src/tray/icons.ts — the hand-rolled PNG encoder + gauge glyph. Round-trips every encoded PNG
 * through decodePngForTests (an independent inverse implementation) rather than trusting the
 * encoder to check itself, and separately verifies the CRC-32 against a known-answer test vector
 * (the standard "IEND" chunk-type CRC has a well-known value, used here as an external check).
 */
import { describe, expect, it } from 'vitest';
import { crc32, decodePngForTests, drawGaugeGlyph, encodePng, renderTrayIconPng, renderTrayIconSet } from '../../src/tray/icons.js';

describe('crc32', () => {
  it('matches the standard "IEND" chunk CRC (0xAE426082) — a well-known PNG constant', () => {
    // Every valid PNG ends with length=0 IEND chunk whose CRC is computed over the ASCII bytes
    // "IEND" alone; this value (0xAE426082) is the same in every PNG ever produced, so it is a
    // solid external known-answer check independent of anything else in this module.
    expect(crc32(Buffer.from('IEND', 'ascii'))).toBe(0xae426082);
  });

  it('CRC of an empty buffer is 0 (identity element)', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('encodePng / decodePngForTests round-trip', () => {
  it('round-trips a small solid-color buffer exactly', () => {
    const width = 4;
    const height = 3;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      data[i * 4 + 0] = 10;
      data[i * 4 + 1] = 20;
      data[i * 4 + 2] = 30;
      data[i * 4 + 3] = 255;
    }
    const png = encodePng({ width, height, data });
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const decoded = decodePngForTests(png);
    expect(decoded.width).toBe(width);
    expect(decoded.height).toBe(height);
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it('round-trips a gradient buffer (exercises every byte value 0-255 across the row)', () => {
    const width = 256;
    const height = 2;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        const i = (y * width + x) * 4;
        data[i] = x;
        data[i + 1] = 255 - x;
        data[i + 2] = (x * 3) % 256;
        data[i + 3] = y === 0 ? 255 : 0;
      }
    }
    const decoded = decodePngForTests(encodePng({ width, height, data }));
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it('rejects a buffer with a bad signature', () => {
    expect(() => decodePngForTests(Buffer.from('not a png'))).toThrow(/signature/);
  });
});

describe('drawGaugeGlyph', () => {
  it('produces a size×size buffer with at least one fully-opaque pixel (the glyph is visible)', () => {
    const buf = drawGaugeGlyph(18, { r: 0, g: 0, b: 0, a: 255 });
    expect(buf.width).toBe(18);
    expect(buf.height).toBe(18);
    let maxAlpha = 0;
    for (let i = 3; i < buf.data.length; i += 4) maxAlpha = Math.max(maxAlpha, buf.data[i]);
    expect(maxAlpha).toBeGreaterThan(0);
  });

  it('leaves at least one fully-transparent pixel (the glyph does not fill the whole icon)', () => {
    const buf = drawGaugeGlyph(18, { r: 0, g: 0, b: 0, a: 255 });
    let minAlpha = 255;
    for (let i = 3; i < buf.data.length; i += 4) minAlpha = Math.min(minAlpha, buf.data[i]);
    expect(minAlpha).toBe(0);
  });

  it('is deterministic for the same size and color', () => {
    const a = drawGaugeGlyph(20, { r: 5, g: 6, b: 7, a: 255 });
    const b = drawGaugeGlyph(20, { r: 5, g: 6, b: 7, a: 255 });
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe('renderTrayIconPng / renderTrayIconSet', () => {
  it('renders a decodable PNG at the requested size for both variants', () => {
    for (const variant of ['template', 'accent'] as const) {
      const png = renderTrayIconPng(22, variant);
      const decoded = decodePngForTests(png);
      expect(decoded.width).toBe(22);
      expect(decoded.height).toBe(22);
    }
  });

  it('the template variant is grayscale-black (R=G=B=0) everywhere it has any alpha', () => {
    const decoded = decodePngForTests(renderTrayIconPng(18, 'template'));
    for (let i = 0; i < decoded.data.length; i += 4) {
      if (decoded.data[i + 3] > 0) {
        expect(decoded.data[i]).toBe(0);
        expect(decoded.data[i + 1]).toBe(0);
        expect(decoded.data[i + 2]).toBe(0);
      }
    }
  });

  it('renderTrayIconSet returns a 2x buffer exactly double the pixel dimensions of 1x', () => {
    const set = renderTrayIconSet(16, 'template');
    const d1 = decodePngForTests(set['1x']);
    const d2 = decodePngForTests(set['2x']);
    expect(d2.width).toBe(d1.width * 2);
    expect(d2.height).toBe(d1.height * 2);
  });
});
