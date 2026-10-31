import { expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { onceEnd } from '../../src/collectors/ollama-proxy.js';

it('an actual readable close without end or error settles the proxy observation', async () => {
  const stream = new PassThrough();
  const finished = onceEnd(stream);
  stream.destroy();
  await finished;
  expect(stream.closed).toBe(true);
  expect(stream.readableEnded).toBe(false);
});

it('a readable that already closed does not leave a later observer waiting', async () => {
  const stream = new PassThrough(), closed = once(stream, 'close');
  stream.destroy(); await closed;
  await onceEnd(stream);
  expect(stream.listenerCount('end')).toBe(0);
  expect(stream.listenerCount('error')).toBe(0);
  expect(stream.listenerCount('close')).toBe(0);
});
