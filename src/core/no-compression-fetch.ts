import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

/**
 * Node-side JSON requests for the tray, local Ollama probe, and optional benchmark clients.
 * The packaged Electron runtime is independently held on Node 24.22.0 while upstream fixes are
 * pending. Do not let an untrusted local or tailnet response enter Node's automatic Brotli,
 * gzip, or deflate decoder before Tokenelo authenticates or validates it. Request identity
 * encoding, reject any encoded response at the headers, and use a one-shot socket so an old
 * runtime cannot reuse a keep-alive socket carrying unsolicited bytes.
 *
 * Identity responses retain normal Fetch redirect behavior for GETs. Redirects requiring replay
 * of a streamed request body are refused rather than buffering potentially large prompt data.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SENSITIVE_CROSS_ORIGIN_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

/**
 * Compare the original URL authority spelling with WHATWG IPv4 normalization before transport.
 * URL and Request objects have already discarded the original spelling.
 */
function rawAuthorityHostname(raw: string): string | undefined {
  const value = raw.trim();
  const schemeDelimiter = value.indexOf('://');
  const scheme = schemeDelimiter >= 0 ? value.slice(0, schemeDelimiter) : '';
  const hasAbsoluteAuthority = /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme);
  const start = hasAbsoluteAuthority
    ? schemeDelimiter + 3
    : value.startsWith('//')
      ? 2
      : -1;
  if (start < 0) return undefined;

  let end = value.length;
  for (const delimiter of ['/', '?', '#', String.fromCharCode(92)]) {
    const index = value.indexOf(delimiter, start);
    if (index >= 0 && index < end) end = index;
  }
  const authority = value.slice(start, end);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  if (hostPort.startsWith('[')) return undefined;
  const colon = hostPort.lastIndexOf(':');
  return colon < 0 ? hostPort : hostPort.slice(0, colon);
}

function assertCanonicalIpv4UrlHost(raw: string, url: URL, relativeTo?: URL): void {
  if (isIP(url.hostname) !== 4) return;
  const rawHost = rawAuthorityHostname(raw);
  if (rawHost === undefined) {
    if (relativeTo && url.origin === relativeTo.origin) return;
    throw new TypeError('non-canonical IPv4 URL hostname refused');
  }
  if (rawHost !== url.hostname) throw new TypeError('non-canonical IPv4 URL hostname refused');
}

async function sendWithoutContentDecoding(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('unsupported HTTP protocol');
  if (url.username || url.password) throw new TypeError('embedded URL credentials are not accepted');
  const requestHeaders: Record<string, string> = {};
  request.headers.forEach((value, name) => { requestHeaders[name] = value; });
  requestHeaders['accept-encoding'] = 'identity';
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (response: Response): void => {
      if (settled) return;
      settled = true;
      resolve(response);
    };

    const outgoing = transport.request(url, {
      method: request.method,
      headers: requestHeaders,
      signal: request.signal,
      agent: false,
    }, (incoming) => {
      const contentEncoding = incoming.headers['content-encoding'];
      const encoding = Array.isArray(contentEncoding) ? contentEncoding.join(',') : contentEncoding;
      if (encoding !== undefined && encoding.trim().toLowerCase() !== 'identity') {
        incoming.destroy();
        fail(new TypeError('compressed HTTP response refused'));
        return;
      }

      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 599) {
        incoming.destroy();
        fail(new TypeError('unsupported HTTP response status'));
        return;
      }

      const responseHeaders = new Headers();
      const contentType = incoming.headers['content-type'];
      if (typeof contentType === 'string') responseHeaders.set('content-type', contentType);
      const location = incoming.headers.location;
      if (typeof location === 'string') responseHeaders.set('location', location);
      const bodyless = request.method === 'HEAD' || status === 204 || status === 205 || status === 304;
      const body = bodyless ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
      if (bodyless) incoming.resume();
      succeed(new Response(body, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
    });

    outgoing.on('error', fail);
    outgoing.on('upgrade', (_response, socket) => {
      socket.destroy();
      fail(new TypeError('unexpected HTTP protocol upgrade'));
    });

    if (request.body) {
      const body = Readable.fromWeb(request.body as ReadableStream<Uint8Array>);
      body.on('error', (error) => outgoing.destroy(error));
      body.pipe(outgoing);
    } else {
      outgoing.end();
    }
  });
}

/**
 * Fetch-compatible for Tokenelo's HTTP JSON requests, except it refuses automatic content
 * decoding and follows redirects with Fetch's method rewrite and sensitive-header stripping.
 * Redirects that require replaying a streamed request body are refused rather than buffering or
 * replaying potentially large prompt data.
 */
export const fetchWithoutContentDecoding: typeof fetch = async (input, init) => {
  if (typeof input === 'string') assertCanonicalIpv4UrlHost(input, new URL(input));
  const originalStringBody = typeof init?.body === 'string' ? init.body : null;
  let request = new Request(input, init);
  for (let redirects = 0; ; redirects++) {
    const response = await sendWithoutContentDecoding(request);
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location || request.redirect === 'manual') return response;
    if (request.redirect === 'error') {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('HTTP redirect refused');
    }
    if (redirects >= 20) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('too many HTTP redirects');
    }

    const currentUrl = new URL(request.url);
    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.username || nextUrl.password || (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:')) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('redirect target refused');
    }
    try {
      assertCanonicalIpv4UrlHost(location, nextUrl, currentUrl);
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }

    let method = request.method;
    const rewriteToGet = (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST');
    const crossOrigin = currentUrl.origin !== nextUrl.origin;
    if (!rewriteToGet && request.body !== null && (originalStringBody === null || crossOrigin)) {
      await response.body?.cancel().catch(() => {});
      throw new TypeError('redirect with request body refused');
    }
    if (rewriteToGet) method = 'GET';

    const headers = new Headers(request.headers);
    if (rewriteToGet) {
      headers.delete('content-encoding');
      headers.delete('content-language');
      headers.delete('content-length');
      headers.delete('content-location');
      headers.delete('content-type');
      headers.delete('transfer-encoding');
    }
    if (crossOrigin) {
      for (const name of SENSITIVE_CROSS_ORIGIN_HEADERS) headers.delete(name);
    }
    const signal = request.signal;
    const redirectMode = request.redirect;
    await response.body?.cancel().catch(() => {});
    request = new Request(nextUrl, {
      method,
      headers,
      signal,
      redirect: redirectMode,
      ...(rewriteToGet || originalStringBody === null ? {} : { body: originalStringBody }),
    });
  }
};
