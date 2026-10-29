import { createHash } from 'node:crypto';
import { CODEX_PREFIX_CHUNK_BYTES as CHUNK } from '../core/codex-prefix-witness.js';

export interface CodexParsedPrefixDigest { bytes: number; chunks: string[]; tail: string }

/** Hash the original byte chunks consumed by the parser, before CRLF stripping or JSON decoding. */
export class CodexPrefixStreamDigest {
  private bytes = 0;
  private inChunk = 0;
  private readonly chunks: string[] = [];
  private hash = createHash('sha256');

  push(data: Buffer): void {
    for (let start = 0; start < data.length;) {
      const take = Math.min(CHUNK - this.inChunk, data.length - start);
      this.hash.update(data.subarray(start, start + take));
      start += take;this.inChunk += take;this.bytes += take;
      if (this.inChunk === CHUNK) {
        this.chunks.push(this.hash.digest('hex'));
        this.hash = createHash('sha256');this.inChunk = 0;
      }
    }
  }

  snapshot(): CodexParsedPrefixDigest {
    return { bytes: this.bytes, chunks: [...this.chunks], tail: this.hash.copy().digest('hex') };
  }
}

export function sameCodexPrefixContent(a: CodexParsedPrefixDigest, b: CodexParsedPrefixDigest): boolean {
  return a.bytes === b.bytes && a.tail === b.tail && a.chunks.length === b.chunks.length
    && a.chunks.every((value, index) => value === b.chunks[index]);
}
