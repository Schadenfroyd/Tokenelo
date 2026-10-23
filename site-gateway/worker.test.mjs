import test from "node:test";
import assert from "node:assert/strict";
import worker, { createHandler } from "./worker.mjs";

const EXPECTED_UPSTREAM = "https://schadenfroyd.github.io";
const STATIC_PATHS = [
  ["/", "/Tokenelo/", "text/html; charset=utf-8"],
  ["/index.html", "/Tokenelo/index.html", "text/html; charset=utf-8"],
  ["/site.css", "/Tokenelo/site.css", "text/css; charset=utf-8"],
  ["/site.js", "/Tokenelo/site.js", "text/javascript; charset=utf-8"],
  ["/favicon.svg", "/Tokenelo/favicon.svg", "image/svg+xml"],
  ["/social-card.svg", "/Tokenelo/social-card.svg", "image/svg+xml"],
  ["/robots.txt", "/Tokenelo/robots.txt", "text/plain; charset=utf-8"],
  ["/sitemap.xml", "/Tokenelo/sitemap.xml", "application/xml; charset=utf-8"],
];

function request(path, options = {}) {
  return new Request("https://tokenelo.eloai.co" + path, options);
}

function securityHeaders(response) {
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
}

test("module import has no fetch side effect", () => {
  assert.equal(typeof worker.fetch, "function");
});

test("HTTP redirects only approved paths to HTTPS without query or upstream access", async () => {
  let calls = 0;
  const handler = createHandler(async () => { calls += 1; throw new Error("unexpected"); });
  const response = await handler.fetch(new Request("http://tokenelo.eloai.co/site.css?private=discard"));
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://tokenelo.eloai.co/site.css");
  assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  assert.equal((await handler.fetch(new Request("http://tokenelo.eloai.co/private"))).status, 404);
  assert.equal((await handler.fetch(new Request("http://tokenelo.eloai.co/", { method: "POST" }))).status, 405);
  assert.equal(calls, 0);
});

test("allowlisted paths map to fixed Pages paths and strip incoming data", async () => {
  for (const [path, upstreamPath, contentType] of STATIC_PATHS) {
    const calls = [];
    const handler = createHandler(async (url, init) => {
      calls.push({ url, init });
      return new Response("public asset", {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream",
          "Set-Cookie": "upstream=private",
          "X-Upstream-Private": "discard",
        },
      });
    });

    const response = await handler.fetch(
      request(path + "?token=must-not-forward&campaign=private", {
        headers: {
          Authorization: "Bearer test-only",
          Cookie: "session=test-only",
          Host: "incoming.example",
          Origin: "https://incoming.example",
          Referer: "https://incoming.example/private",
          "CF-Connecting-IP": "192.0.2.10",
          "X-Forwarded-For": "192.0.2.10",
        },
      }),
    );

    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), "public asset", path);
    assert.equal(calls.length, 1, path);
    assert.equal(calls[0].url, EXPECTED_UPSTREAM + upstreamPath, path);
    assert.equal(new URL(calls[0].url).search, "", path);
    assert.equal(calls[0].init.method, "GET", path);
    assert.equal(calls[0].init.redirect, "manual", path);
    assert.equal(Array.from(calls[0].init.headers.entries()).length, 0, path);
    assert.equal(calls[0].init.cf.cacheTtl, 60, path);
    assert.equal(calls[0].init.cf.cacheEverything, true, path);
    assert.equal(response.headers.get("content-type"), contentType, path);
    assert.match(response.headers.get("cache-control"), /max-age=60/);
    assert.match(response.headers.get("cache-control"), /s-maxage=60/);
    assert.match(response.headers.get("cache-control"), /(?:^|,\s*)no-transform(?:,|$)/i);
    assert.equal(response.headers.get("set-cookie"), null, path);
    assert.equal(response.headers.get("x-upstream-private"), null, path);
    securityHeaders(response);
  }
});

test("unknown paths and hostnames return 404 without fetching", async () => {
  const calls = [];
  const handler = createHandler(async (...args) => {
    calls.push(args);
    return new Response("unexpected");
  });

  const unknownPath = await handler.fetch(request("/private.env"));
  assert.equal(unknownPath.status, 404);
  assert.equal(await unknownPath.text(), "Not found.");
  assert.equal(unknownPath.headers.get("cache-control"), "no-store");
  securityHeaders(unknownPath);

  const escapedPath = await handler.fetch(request("/%252e%252e/private.env"));
  assert.equal(escapedPath.status, 404);

  const wrongHost = await handler.fetch(
    new Request("https://tokenelo.eloai.co.evil.example/"),
  );
  assert.equal(wrongHost.status, 404);
  assert.equal(calls.length, 0);
});

test("unsupported methods return 405 and do not fetch", async () => {
  const calls = [];
  const handler = createHandler(async (...args) => {
    calls.push(args);
    return new Response("unexpected");
  });

  const response = await handler.fetch(
    request("/site.js", { method: "POST", body: "must-not-forward" }),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls.length, 0);
  securityHeaders(response);
});

test("HEAD is forwarded without a body and response cookies are discarded", async () => {
  const calls = [];
  const handler = createHandler(async (url, init) => {
    calls.push({ url, init });
    return new Response("must-not-return", {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Set-Cookie": "session=private",
      },
    });
  });

  const response = await handler.fetch(request("/index.html?ignored=yes", { method: "HEAD" }));

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "HEAD");
  assert.equal(new URL(calls[0].url).search, "");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("cache-control"), /max-age=60/);
  securityHeaders(response);
});

test("upstream redirects are refused without forwarding Location", async () => {
  let calls = 0;
  const handler = createHandler(async (_url, init) => {
    calls += 1;
    assert.equal(init.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://untrusted.example/redirect" },
    });
  });

  const response = await handler.fetch(request("/"));

  assert.equal(calls, 1);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), "Upstream redirect refused.");
  securityHeaders(response);
});

test("upstream transport failure returns a generic 502", async () => {
  const handler = createHandler(async () => {
    throw new Error("private network detail must not escape");
  });

  const response = await handler.fetch(request("/site.css"));

  assert.equal(response.status, 502);
  const body = await response.text();
  assert.equal(body, "Upstream unavailable.");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(body, /private network detail/);
  securityHeaders(response);
});
