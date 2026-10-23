const PUBLIC_HOST = "tokenelo.eloai.co";
const PUBLIC_ORIGIN = "https://" + PUBLIC_HOST;
const PAGES_ORIGIN = "https://schadenfroyd.github.io";
const MAX_CACHE_SECONDS = 60;

const STATIC_FILES = new Map([
  ["/", { upstreamPath: "/Tokenelo/", contentType: "text/html; charset=utf-8" }],
  ["/index.html", { upstreamPath: "/Tokenelo/index.html", contentType: "text/html; charset=utf-8" }],
  ["/site.css", { upstreamPath: "/Tokenelo/site.css", contentType: "text/css; charset=utf-8" }],
  ["/site.js", { upstreamPath: "/Tokenelo/site.js", contentType: "text/javascript; charset=utf-8" }],
  ["/favicon.svg", { upstreamPath: "/Tokenelo/favicon.svg", contentType: "image/svg+xml" }],
  ["/social-card.svg", { upstreamPath: "/Tokenelo/social-card.svg", contentType: "image/svg+xml" }],
  ["/robots.txt", { upstreamPath: "/Tokenelo/robots.txt", contentType: "text/plain; charset=utf-8" }],
  ["/sitemap.xml", { upstreamPath: "/Tokenelo/sitemap.xml", contentType: "application/xml; charset=utf-8" }],
]);

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'none'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

function responseHeaders({ contentType, cacheControl, allow }) {
  const headers = new Headers({
    "Cache-Control": cacheControl,
    "Content-Security-Policy": CSP,
    "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Strict-Transport-Security": "max-age=31536000",
  });

  if (contentType) headers.set("Content-Type", contentType);
  if (allow) headers.set("Allow", allow);
  return headers;
}

function textResponse(request, status, message, { allow } = {}) {
  return new Response(request.method === "HEAD" ? null : message, {
    status,
    headers: responseHeaders({
      contentType: "text/plain; charset=utf-8",
      cacheControl: "no-store",
      allow,
    }),
  });
}

async function handleRequest(request, fetchImpl) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return textResponse(request, 404, "Not found.");
  }

  if (url.host !== PUBLIC_HOST || !["http:", "https:"].includes(url.protocol)) {
    return textResponse(request, 404, "Not found.");
  }

  const file = STATIC_FILES.get(url.pathname);
  if (!file) {
    return textResponse(request, 404, "Not found.");
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(request, 405, "Method not allowed.", { allow: "GET, HEAD" });
  }

  if (url.protocol === "http:") {
    const headers = responseHeaders({ cacheControl: "no-store" });
    headers.set("Location", PUBLIC_ORIGIN + url.pathname);
    return new Response(null, { status: 308, headers });
  }

  const upstreamUrl = new URL(file.upstreamPath, PAGES_ORIGIN);

  let upstream;
  try {
    upstream = await fetchImpl(upstreamUrl.toString(), {
      method: request.method,
      headers: new Headers(),
      redirect: "manual",
      cf: {
        cacheEverything: true,
        cacheTtl: MAX_CACHE_SECONDS,
      },
    });
  } catch {
    return textResponse(request, 502, "Upstream unavailable.");
  }

  if (
    upstream.type === "opaqueredirect" ||
    (upstream.status >= 300 && upstream.status < 400)
  ) {
    return textResponse(request, 502, "Upstream redirect refused.");
  }

  if (upstream.status === 404) {
    return textResponse(request, 404, "Not found.");
  }

  if (upstream.status !== 200) {
    return textResponse(request, 502, "Upstream unavailable.");
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: 200,
    headers: responseHeaders({
      contentType: file.contentType,
      cacheControl: "public, max-age=60, s-maxage=60",
    }),
  });
}

export function createHandler(fetchImpl) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("createHandler requires a fetch function.");
  }

  return {
    fetch(request) {
      return handleRequest(request, fetchImpl);
    },
  };
}

export default {
  fetch(request) {
    return handleRequest(request, fetch);
  },
};
