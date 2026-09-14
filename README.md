# Relay web proxy

A small, dependency-free web proxy that runs in Node and is controlled from a browser. It fetches public `http://` and `https://` URLs server-side, rewrites common HTML links and resources through the proxy, and returns other assets unchanged.

## Run

```bash
npm start
```

Then open <http://localhost:3000>.

For sites with origin-bound authentication such as Xbox, open <http://localhost:3000/remote> (or select **Use real browser mode**). This uses a real Playwright Chromium session with its own cookies, JavaScript, redirects, and a live WebSocket viewport.

Set `PORT` to use another port:

```bash
PORT=8080 npm start
```

## Boundaries

This is intended for local use or a trusted environment. It allows public targets only and rejects obvious local/private network destinations, but it is not a complete production SSRF defense. HTML rewriting is deliberately lightweight; sites that depend heavily on client-side routing, signed requests, or complex security policies may not work correctly.

## Loading metrics

Every proxied response includes diagnostic headers:

- `X-Proxy-Metrics`: JSON timings for DNS validation, upstream fetch, headers, body processing, total duration, byte count, and redirects.
- `X-Proxy-Upstream`: the final URL after redirects.
- `X-Proxy-Bytes`: the size of the rewritten response body.
- `Server-Timing` is not required; the JSON header is available directly in browser network tools and scripts.

HTML `href`, `src`, `srcset`, form targets, and CSS `url(...)` references are rewritten to stay inside the proxy. This improves compatibility with large sites such as Microsoft and Xbox, while highly dynamic authenticated applications may still require a full browser automation proxy.

The remote browser uses Chromium CDP screencasting over WebSockets. Mouse, wheel, double-click, drag, and keyboard events are dispatched directly to Chromium, so the page is interactive without screenshot polling. It requires the `playwright` and `ws` packages plus the installed Chromium runtime.

JavaScript responses also rewrite absolute URLs belonging to the current proxied site to local paths. This keeps single-page application API and route requests inside Relay while leaving third-party service URLs unchanged.

For single-page applications, Relay also mirrors the upstream pathname into the browser history and remembers the upstream origin for same-origin route requests. This prevents client-side routers from interpreting `/proxy?url=...` as their application path.

Opening `/` always returns the Relay homepage and clears the previous site routing cookie, so an old asset or Azure error cannot hijack a new session.

Upstream session cookies are copied to the local browser origin and forwarded on later requests, which helps refreshes on sites that use session-based routing or bot protection. Non-2xx upstream responses are returned with their original status and body so the upstream diagnostic page remains visible instead of being replaced by a Relay error.

Known-invalid empty Azure `comp` query parameters are removed before forwarding, including on redirect hops; valid query parameters are preserved.