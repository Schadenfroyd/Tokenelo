import fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { yieldToEventLoop } from '../core/event-loop.js';
import { CODEX_PREFIX_CHUNK_BYTES as CHUNK, isCodexPrefixWitness } from '../core/codex-prefix-witness.js';
import type { CodexPrefixWitness } from '../core/codex-prefix-witness.js';

export { isCodexPrefixWitness } from '../core/codex-prefix-witness.js';
export type { CodexPrefixWitness } from '../core/codex-prefix-witness.js';
export const codexObjectId = (s: BigIntStats) => ({
  dev:String(s.dev), ino:String(s.ino), birthNs:String(s.birthtimeNs),
});
export const sameCodexObject = (a: CodexPrefixWitness['object'], b: CodexPrefixWitness['object']) => a.dev === b.dev && a.ino === b.ino && a.birthNs === b.birthNs;

/** Snapshot the committed prefix in fixed chunks. Append work rereads only the
 * previous partial chunk plus new bytes. An archive/copy verifies EVERY chunk.
 * Hashes prove the inspected prefix, not historical ledger correctness or a
 * filesystem snapshot against an adversarial writer after this read. */
export async function codexPrefixWitness(file: string, bytes: number, previous?: CodexPrefixWitness, verify = false, expected?: CodexPrefixWitness['object']): Promise<CodexPrefixWitness> {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid Codex prefix length');
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat({bigint:true});
    if (before.size < BigInt(bytes)) throw new Error('Codex prefix shortened');
    const object = codexObjectId(before);
    if (expected && !sameCodexObject(expected, object)) throw new Error('Codex opened prefix object differs from discovered file');
    if (previous && !verify && !sameCodexObject(previous.object, object))
      throw new Error('Codex consumed prefix object changed before append');
    const reuse = !verify && previous && isCodexPrefixWitness(previous) && previous.bytes <= bytes && sameCodexObject(previous.object, object);
    const chunks = reuse ? [...previous.chunks] : [];
    let position = chunks.length * CHUNK;
    let tail = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    const data = Buffer.alloc(CHUNK);
    let readBytes = 0;
    while (position < bytes) {
      const wanted = Math.min(CHUNK, bytes - position); let got = 0;
      while (got < wanted) {
        const part = await handle.read(data, got, wanted - got, position + got);
        if (!part.bytesRead) throw new Error('Codex prefix ended early');
        got += part.bytesRead;
        readBytes += part.bytesRead;
      }
      if (reuse && position === previous.chunks.length * CHUNK && previous.bytes % CHUNK > 0) {
        const oldTail = createHash('sha256').update(data.subarray(0, previous.bytes % CHUNK)).digest('hex');
        if (oldTail !== previous.tail) throw new Error('Codex partial consumed prefix changed before append');
      }
      const hash = createHash('sha256').update(data.subarray(0, wanted)).digest('hex');
      if (wanted === CHUNK) chunks.push(hash); else tail = hash;
      position += wanted;
      await yieldToEventLoop();
    }
    const after = await handle.stat({bigint:true});
    if (!sameCodexObject(object, codexObjectId(after)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs)
      throw new Error('Codex file changed during prefix inspection');
    // No pathname swap may bind a witness to another object at commit time.
    const current = await fs.stat(file,{bigint:true});
    if (!sameCodexObject(object, codexObjectId(current)) || current.size !== after.size || current.mtimeNs !== after.mtimeNs)
      throw new Error('Codex pathname changed during prefix inspection');
    const result: CodexPrefixWitness = {v:1,bytes,chunks,tail,object,establishedAt:Date.now(),readBytes};
    if (verify && previous && (previous.bytes !== bytes || previous.tail !== tail || previous.chunks.length !== chunks.length
      || previous.chunks.some((hash,index) => hash !== chunks[index]))) throw new Error('Codex archive prefix does not match its checkpoint');
    return result;
  } finally { await handle.close(); }
}
