import http from 'node:http';
import { brotliCompressSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { fetchWithoutContentDecoding } from '../../src/core/no-compression-fetch.js';

async function withLoopback(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
  test: (url: string) => Promise<void>
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback listener unavailable');
  try {
    await test(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

it('requests identity encoding and preserves a plain JSON response', async () => {
  let acceptedEncoding: string | string[] | undefined;
  let connection: string | undefined;
  await withLoopback((request, response) => {
    acceptedEncoding = request.headers['accept-encoding'];
    connection = request.headers.connection;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'fixture' }));
  }, async (url) => {
    const response = await fetchWithoutContentDecoding(`${url}/health`);
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ status: 'fixture' });
    expect(acceptedEncoding).toBe('identity');
    expect(connection).toBe('close');
  });
});

it('refuses a valid Brotli response from an owned loopback fixture before parsing it', async () => {
  const compressed = brotliCompressSync(Buffer.from(JSON.stringify({ proof: 'fixture' }), 'utf8'));
  let requestCount = 0;
  await withLoopback((_request, response) => {
    requestCount++;
    response.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
    response.end(compressed);
  }, async (url) => {
    await expect(fetchWithoutContentDecoding(`${url}/v1/hello`)).rejects.toThrow('compressed HTTP response refused');
    expect(requestCount).toBe(1);
  });
});

it('forwards a JSON POST body without enabling response decompression', async () => {
  let received = '';
  await withLoopback((request, response) => {
    request.setEncoding('utf8');
    request.on('data', chunk => { received += chunk; });
    request.on('end', () => {
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ accepted: JSON.parse(received) }));
    });
  }, async (url) => {
    const response = await fetchWithoutContentDecoding(`${url}/v1/read`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lease: 'fixture' }),
    });
    await expect(response.json()).resolves.toEqual({ accepted: { lease: 'fixture' } });
  });
});

it('replays a string body for a same-origin 307 without forwarding it cross-origin', async () => {
  const bodies: string[] = [];
  await withLoopback((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      bodies.push(body);
      if (request.url === '/start') {
        response.writeHead(307, { location: '/retry' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ body }));
    });
  }, async (url) => {
    const response = await fetchWithoutContentDecoding(`${url}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'fixture-only' }),
    });
    const expected = JSON.stringify({ prompt: 'fixture-only' });
    await expect(response.json()).resolves.toEqual({ body: expected });
    expect(bodies).toEqual([expected, expected]);
  });
});

it('refuses noncanonical numeric IPv4 string inputs before opening a socket', async () => {
  let requestCount = 0;
  const hosts = [
    '0127.0.0.1',
    '0177.0.0.1',
    '0x7f.0.0.1',
    '2130706433',
    '127.1',
    '127.00.0.1',
    '127.0.0.1.',
    '１２７.0.0.1',
  ];
  await withLoopback((_request, response) => {
    requestCount++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'unexpectedly-reached-server' }));
  }, async (url) => {
    const port = new URL(url).port;
    for (const host of hosts) {
      await expect(fetchWithoutContentDecoding(`http://${host}:${port}/health`))
        .rejects.toThrow('non-canonical IPv4 URL hostname refused');
    }
    expect(requestCount).toBe(0);
  });
});

it('refuses noncanonical numeric IPv4 redirect targets before following them', async () => {
  let requestCount = 0;
  let baseUrl = '';
  await withLoopback((request, response) => {
    requestCount++;
    if (request.url === '/start') {
      const port = new URL(baseUrl).port;
      response.writeHead(302, { location: `http://0177.0.0.1:${port}/redirected` });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'unexpectedly-followed-redirect' }));
  }, async (url) => {
    baseUrl = url;
    await expect(fetchWithoutContentDecoding(`${url}/start`))
      .rejects.toThrow('non-canonical IPv4 URL hostname refused');
    expect(requestCount).toBe(1);
  });
});

it('follows a loopback redirect but strips sensitive headers across origins', async () => {
  let redirectedCalls = 0;
  let redirectedAuthorization: string | undefined;
  const destination = http.createServer((_request, response) => {
    redirectedCalls++;
    redirectedAuthorization = _request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'redirected-fixture' }));
  });
  await new Promise<void>((resolve, reject) => {
    destination.once('error', reject);
    destination.listen(0, '127.0.0.1', resolve);
  });
  const address = destination.address();
  if (!address || typeof address === 'string') throw new Error('redirect destination unavailable');
  try {
    await withLoopback((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${address.port}/attacker` });
      response.end();
    }, async (url) => {
      const response = await fetchWithoutContentDecoding(`${url}/v1/hello`, {
        headers: { authorization: 'Bearer fixture-only' },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: 'redirected-fixture' });
      expect(redirectedCalls).toBe(1);
      expect(redirectedAuthorization).toBeUndefined();
    });
  } finally {
    destination.closeAllConnections();
    await new Promise<void>((resolve) => destination.close(() => resolve()));
  }
});
