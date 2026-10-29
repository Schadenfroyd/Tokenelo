/**
 * Generates the tray icon as a PNG entirely in code — no binary asset files (DESIGN §10/§15.7.5:
 * "generate PNGs in code via a tiny PNG encoder using node:zlib ... a simple meter/gauge glyph;
 * macOS template image for dark/light menu bar"). The glyph is a half-dial gauge with a needle,
 * drawn by direct pixel math (no canvas dependency), then encoded as an 8-bit RGBA PNG using
 * node:zlib for the DEFLATE stream and a small hand-rolled CRC32 for the chunk checksums.
 *
 * macOS: render as a black glyph on a transparent background and pass to
 * `nativeImage.setTemplateImage(true)` (done in main.ts) so the OS recolors it for the light/dark
 * menu bar. Windows/Linux: the same glyph, but main.ts uses an accent-colored variant (see
 * `renderGaugePng({ templateColor: false })`) since those trays render icons as-is.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Raw, uncompressed pixel buffer: `width*height` RGBA pixels, row-major, top-to-bottom. */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray; // length = width*height*4
}

export function createPixelBuffer(width: number, height: number): PixelBuffer {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function setPixel(buf: PixelBuffer, x: number, y: number, c: Rgba): void {
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return;
  const i = (y * buf.width + x) * 4;
  buf.data[i] = c.r;
  buf.data[i + 1] = c.g;
  buf.data[i + 2] = c.b;
  buf.data[i + 3] = c.a;
}

/**
 * Draws the meter/gauge glyph into a fresh `size`×`size` transparent buffer: an arc spanning
 * ~210° (a speedometer dial) plus a needle pointing to roughly the 65% mark, both antialiased by
 * coverage-based alpha so the glyph reads cleanly at menu-bar sizes (16–24px).
 */
export function drawGaugeGlyph(size: number, color: Rgba): PixelBuffer {
  const buf = createPixelBuffer(size, size);
  const cx = size / 2;
  const cy = size * 0.58; // dial center sits slightly below middle to leave room for the arc top
  const outerR = size * 0.42;
  const innerR = size * 0.30;
  const startDeg = -210; // sweep from lower-left...
  const endDeg = 30; // ...to lower-right, through the top (a gauge dial)
  const needleDeg = startDeg + (endDeg - startDeg) * 0.65; // needle at the 65% mark
  const needleLen = outerR * 0.95;
  const needleWidthPx = Math.max(1, size * 0.09);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.hypot(dx, dy);
      let coverage = 0;

      // Arc band.
      if (dist >= innerR && dist <= outerR) {
        let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
        // Normalize into [startDeg, startDeg+360) so the sweep test is a single range check.
        while (deg < startDeg) deg += 360;
        while (deg >= startDeg + 360) deg -= 360;
        if (deg <= endDeg) coverage = 1;
      }

      // Needle: distance from the pixel to the needle line segment (center → tip).
      const needleRad = (needleDeg * Math.PI) / 180;
      const tipX = cx + Math.cos(needleRad) * needleLen;
      const tipY = cy + Math.sin(needleRad) * needleLen;
      const distToNeedle = distToSegment(x + 0.5, y + 0.5, cx, cy, tipX, tipY);
      if (distToNeedle <= needleWidthPx / 2) coverage = Math.max(coverage, 1);

      // Hub dot.
      if (dist <= size * 0.06) coverage = Math.max(coverage, 1);

      if (coverage > 0) setPixel(buf, x, y, { ...color, a: Math.round(color.a * coverage) });
    }
  }
  return buf;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq === 0 ? 0 : Math.max(0, Math.min(1, (apx * abx + apy * aby) / abLenSq));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

// ── Minimal PNG encoder (8-bit RGBA, filter type 0 "none" per scanline) ────────────────────────

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let crcTable: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** Standard zlib/PNG CRC-32 (polynomial 0xEDB88320), computed over `data`. */
export function crc32(data: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** Encodes an RGBA pixel buffer as a PNG file (Buffer), using node:zlib for the IDAT deflate stream. */
export function encodePng(buf: PixelBuffer): Buffer {
  const { width, height, data } = buf;

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type 6 = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type "none"
    for (let x = 0; x < stride; x++) {
      raw[rowStart + 1 + x] = data[y * stride + x];
    }
  }
  const idatData = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Decodes a PNG produced by `encodePng` back into a PixelBuffer. Only supports the exact
 * subset this module emits (8-bit RGBA, filter 0, single IDAT); used by tests to round-trip
 * verify the encoder without depending on an external PNG library. */
export function decodePngForTests(png: Buffer): PixelBuffer {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG (bad signature)');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idatParts: Buffer[] = [];
  while (offset < png.length) {
    const len = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('unsupported IHDR (expected 8-bit RGBA)');
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset += 8 + len + 4; // length + type + data + crc
  }
  const inflated = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart];
    if (filter !== 0) throw new Error(`unsupported filter type ${filter}`);
    for (let x = 0; x < stride; x++) {
      pixels[y * stride + x] = inflated[rowStart + 1 + x];
    }
  }
  return { width, height, data: pixels };
}

/**
 * Builds the tray icon PNG at `size` px. `variant: 'template'` draws a solid black glyph
 * (alpha-only shape) for `nativeImage.setTemplateImage(true)` on macOS; `'accent'` draws it in
 * the app's accent color for Windows/Linux trays, which render icons as-is (no OS recoloring).
 */
export function renderTrayIconPng(size: number, variant: 'template' | 'accent' = 'template'): Buffer {
  const color: Rgba =
    variant === 'template' ? { r: 0, g: 0, b: 0, a: 255 } : { r: 60, g: 140, b: 240, a: 255 };
  const glyph = drawGaugeGlyph(size, color);
  return encodePng(glyph);
}

/** Convenience: renders both the standard and @2x (retina) sizes for a given base size. */
export function renderTrayIconSet(
  baseSize: number,
  variant: 'template' | 'accent' = 'template'
): { '1x': Buffer; '2x': Buffer } {
  return {
    '1x': renderTrayIconPng(baseSize, variant),
    '2x': renderTrayIconPng(baseSize * 2, variant),
  };
}
