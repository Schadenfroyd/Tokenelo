/**
 * Shared loopback Host/Origin validation — used by both the daemon's local read API
 * (daemon/http.ts) and the Ollama metering reverse proxy (collectors/ollama-proxy.ts) so the two
 * "is this request actually local?" checks can never drift apart.
 *
 * Host check: a request's `Host` header must name exactly this server's own loopback address —
 * `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>` — never a DNS-rebound name, a
 * different port, or a wildcard.
 *
 * Origin check (proxy only — daemon/http.ts rejects ANY Origin header outright, since it's never
 * a browser-fetch API): an `Origin` header, when present, must itself be a loopback origin
 * (`http(s)://127.0.0.1[:port]`, `http(s)://localhost[:port]`, `http(s)://[::1][:port]`) — this is
 * an allow-list, not a same-port check, since the Ollama proxy is a legitimate target for
 * browser-based local tools (e.g. a local web UI on some other port) making same-machine fetches.
 */

/** The exact set of `Host` header values a server bound to loopback on `port` should accept. */
export function allowedLoopbackHosts(port: number): Set<string> {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** True when `hostHeader` is exactly one of the loopback forms for `port`. */
export function isAllowedLoopbackHost(hostHeader: string, port: number): boolean {
  return allowedLoopbackHosts(port).has(hostHeader);
}

// http(s)://127.0.0.1[:port] | http(s)://localhost[:port] | http(s)://[::1][:port], no path/query
// (a browser's Origin header is always scheme://host[:port] with nothing else).
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

/** True when `origin` (an `Origin` header value) names a loopback address, any port. */
export function isAllowedLoopbackOrigin(origin: string): boolean {
  return LOOPBACK_ORIGIN_RE.test(origin);
}
