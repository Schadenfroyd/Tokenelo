import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { CodexPrefixStreamDigest, sameCodexPrefixContent } from '../../src/collectors/codex-prefix-stream.js';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

it('binds raw CRLF, bare CR, UTF-8 and trailing bytes before line decoding', () => {
  const data = Buffer.from('{"text":"café"}\r\n{\r"trailing":"unfinished');
  const digest = new CodexPrefixStreamDigest();
  for (let index = 0; index < data.length; index++) digest.push(data.subarray(index, index + 1));
  expect(digest.snapshot()).toEqual({ bytes: data.length, chunks: [], tail: sha(data) });
  expect(sameCodexPrefixContent(digest.snapshot(), { bytes: data.length, chunks: [], tail: sha(Buffer.from(data.toString().replace(/\r/g, ''))) })).toBe(false);
});

it.each([0, 1024 * 1024, 2 * 1024 * 1024 + 31])('keeps fixed one-MiB boundaries across arbitrary stream chunks (%i bytes)', bytes => {
  const data = Buffer.alloc(bytes, 0xa5);const digest = new CodexPrefixStreamDigest();
  for (let index = 0; index < data.length; index += 7777) digest.push(data.subarray(index, index + 7777));
  const chunks = [];
  for (let index = 0; index + 1024 * 1024 <= bytes; index += 1024 * 1024) chunks.push(sha(data.subarray(index, index + 1024 * 1024)));
  const expected = { bytes, chunks, tail: sha(data.subarray(chunks.length * 1024 * 1024)) };
  expect(digest.snapshot()).toEqual(expected);
  expect(sameCodexPrefixContent(digest.snapshot(), expected)).toBe(true);
  expect(digest.snapshot()).toEqual(expected); // Finalization must not consume or alter the observer.
});
