const http = require('node:http');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const PROFILE_LOCK = 'persistent-profile';
const sessions = new Map();

let browserPromise;

function getBrowser() {
  browserPromise ||= chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    viewport: {
      width: 1280,
      height: 800
    }
  });

  return browserPromise;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  response.end(JSON.stringify(value));
}

async function parseJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function serveFile(response, fileName, contentType, extraHeaders = {}) {
  response.writeHead(200, {
    'Content-Type': contentType,
    ...extraHeaders
  });

  fs.createReadStream(path.join(PUBLIC_DIR, fileName)).pipe(response);
}

function sessionFor(requestUrl) {
  const match = requestUrl.pathname.match(
    /^\/api\/session\/([a-f0-9-]+)(?:\/([^/]+))?$/
  );

  if (!match) {
    return null;
  }

  const session = sessions.get(match[1]);

  if (!session) {
    return null;
  }

  return {
    id: match[1],
    session,
    action: match[2] || ''
  };
}

async function sessionState(session) {
  return {
    url: session.page.url(),
    title: await session.page.title().catch(() => ''),
    width: 1280,
    height: 800
  };
}

async function handleBrowserApi(request, response, requestUrl) {
  if (requestUrl.pathname === '/api/session' && request.method === 'POST') {
    const body = await parseJson(request);
    const target = new URL(body.url);

    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('Only http:// and https:// URLs are supported.');
    }

    const context = await getBrowser();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const id = crypto.randomUUID();

    const session = {
      context,
      page,
      cdp,
      clients: new Set()
    };

    sessions.set(id, session);

    page.on('close', () => {
      sessions.delete(id);
    });

    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 85,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: 1
    });

    cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
      for (const client of session.clients) {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'frame',
            data
          }));
        }
      }

      await cdp
        .send('Page.screencastFrameAck', { sessionId })
        .catch(() => null);
    });

    await page.goto(target.href, {
      waitUntil: 'commit',
      timeout: 45000
    });

    return sendJson(response, 201, {
      id,
      ...(await sessionState(session))
    });
  }

  const located = sessionFor(requestUrl);

  if (!located) {
    return false;
  }

  const { id, session, action } = located;

  if (request.method === 'GET' && action === 'state') {
    return sendJson(response, 200, await sessionState(session));
  }

  if (request.method === 'GET' && action === 'screenshot') {
    const image = await session.page.screenshot({
      type: 'jpeg',
      quality: 82
    });

    response.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'no-store'
    });

    return response.end(image);
  }

  if (request.method === 'DELETE' && !action) {
    await session.page.close().catch(() => null);
    sessions.delete(id);

    return sendJson(response, 200, { ok: true });
  }

  const body = await parseJson(request);

  if (request.method === 'POST' && action === 'navigate') {
    await session.page.goto(new URL(body.url).href, {
      waitUntil: 'commit',
      timeout: 45000
    });
  }

  if (request.method === 'POST' && action === 'back') {
    await session.page
      .goBack({
        waitUntil: 'commit',
        timeout: 45000
      })
      .catch(() => null);
  }

  if (request.method === 'POST' && action === 'forward') {
    await session.page
      .goForward({
        waitUntil: 'commit',
        timeout: 45000
      })
      .catch(() => null);
  }

  if (request.method === 'POST' && action === 'reload') {
    await session.page.reload({
      waitUntil: 'commit',
      timeout: 45000
    });
  }

  if (request.method === 'POST' && action === 'click') {
    await session.page.mouse.click(
      Number(body.x),
      Number(body.y)
    );
  }

  if (request.method === 'POST' && action === 'type') {
    await session.page.keyboard.type(String(body.text || ''));
  }

  if (request.method === 'POST' && action === 'key') {
    await session.page.keyboard.press(String(body.key || 'Enter'));
  }

  return sendJson(response, 200, await sessionState(session));
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);

  return parts.length === 4 && (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

async function assertPublicTarget(target) {
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  if (target.username || target.password) {
    throw new Error('URLs with embedded credentials are not supported.');
  }

  const hostname = target.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '::1'
  ) {
    throw new Error('Local targets are not allowed.');
  }

  const addresses = await dns.lookup(hostname, { all: true });

  const privateAddress = addresses.some(({ address, family }) => {
    return (
      (family === 4 && isPrivateIpv4(address)) ||
      (
        family === 6 &&
        (
          address === '::1' ||
          address.startsWith('fc') ||
          address.startsWith('fd')
        )
      )
    );
  });

  if (privateAddress) {
    throw new Error('Private network targets are not allowed.');
  }
}

function normalizeTarget(target) {
  const normalized = new URL(target.href);
  const compValues = normalized.searchParams.getAll('comp');

  if (compValues.length > 0 && compValues.every((value) => value === '')) {
    normalized.searchParams.delete('comp');
  }

  return normalized;
}

function proxyUrl(target) {
  return `/proxy?url=${encodeURIComponent(normalizeTarget(target).href)}`;
}

function restoreAuthReturnUrl(target) {
  const restored = new URL(target.href);

  for (const parameter of ['returnUrl', 'ru']) {
    const value = restored.searchParams.get(parameter);

    if (!value) {
      continue;
    }

    try {
      const returnTarget = new URL(value);

      if (
        returnTarget.hostname === 'localhost' ||
        returnTarget.hostname === '127.0.0.1'
      ) {
        restored.searchParams.set(
          parameter,
          `${restored.origin}${returnTarget.pathname}${returnTarget.search}`
        );
      }
    } catch {
      continue;
    }
  }

  return restored;
}

function isLoginNavigation(target) {
  return (
    target.pathname.toLowerCase().includes('/auth/msa') &&
    target.searchParams.get('action') === 'logIn'
  );
}

function rewriteResource(value, baseUrl) {
  const decodedValue = value.replace(/&amp;|&#38;|&#x26;/gi, '&');

  if (
    !decodedValue ||
    decodedValue.startsWith('#') ||
    decodedValue.startsWith('data:') ||
    decodedValue.startsWith('javascript:') ||
    decodedValue.startsWith('mailto:') ||
    decodedValue.startsWith('tel:')
  ) {
    return value;
  }

  try {
    const resolved = new URL(decodedValue, baseUrl);

    return ['http:', 'https:'].includes(resolved.protocol)
      ? proxyUrl(resolved)
      : value;
  } catch {
    return value;
  }
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(',')
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);

      if (!parts[0]) {
        return candidate;
      }

      parts[0] = rewriteResource(parts[0], baseUrl);

      return parts.join(' ');
    })
    .join(', ');
}

function rewriteCss(css, baseUrl) {
  return css.replace(
    /url\(\s*(["']?)([^\)"']+)\1\s*\)/gi,
    (match, quote, value) => {
      const rewritten = rewriteResource(value.trim(), baseUrl);

      return rewritten === value.trim()
        ? match
        : `url(${quote}${rewritten}${quote})`;
    }
  );
}

function rewriteScript(script, baseUrl, pageOrigin = baseUrl) {
  const origin = new URL(pageOrigin).origin;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const rewriteModuleReference = (match, prefix, value, suffix) => {
    return `${prefix}${rewriteResource(value, baseUrl)}${suffix}`;
  };

  let rewritten = script
    .replace(new RegExp(escapedOrigin, 'g'), '')
    .replace(new RegExp(escapedOrigin.replaceAll('/', '\\/'), 'g'), '')
    .replace(
      /(\bimport\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
      rewriteModuleReference
    )
    .replace(
      /(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
      rewriteModuleReference
    )
    .replace(
      /(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
      rewriteModuleReference
    );

  if (script.includes('MsaAuthPage')) {
    rewritten = rewritten.replace(
      'const e="https:"',
      'const e=window.location.protocol'
    );
  }

  return rewritten;
}

function browserPath(target, request) {
  const browserTarget = new URL(target.href);

  if (browserTarget.pathname.includes('/auth/msa')) {
    const localOrigin = `http://${request.headers.host}`;

    for (const parameter of ['returnUrl', 'ru']) {
      const value = browserTarget.searchParams.get(parameter);

      if (!value) {
        continue;
      }

      try {
        const nestedTarget = new URL(value, target.href);

        browserTarget.searchParams.set(
          parameter,
          `${localOrigin}${nestedTarget.pathname}${nestedTarget.search}`
        );
      } catch {
        continue;
      }
    }
  }

  return (
    `${browserTarget.pathname}${browserTarget.search}${browserTarget.hash}` ||
    '/'
  );
}

function rewriteHtml(html, baseUrl) {
  const attributePattern =
    /\b(href|src|action|poster|data|srcset)\s*=\s*(["'])(.*?)\2/gi;

  const rewritten = html.replace(
    attributePattern,
    (match, attribute, quote, value) => {
      const rewrittenValue =
        attribute.toLowerCase() === 'srcset'
          ? rewriteSrcset(value, baseUrl)
          : rewriteResource(value, baseUrl);

      return rewrittenValue === value
        ? match
        : `${attribute}=${quote}${rewrittenValue}${quote}`;
    }
  );

  return rewritten
    .replace(
      /(<(?:a|area)\b[^>]*\bhref=["'])(\/proxy\?url=[^"']+)/gi,
      (match, prefix, value) => {
        return `${prefix}${value.includes('reset=1') ? value : `${value}&reset=1`}`;
      }
    )
    .replace(
      /(<form\b[^>]*\baction=["'])(\/proxy\?url=[^"']+)/gi,
      (match, prefix, value) => {
        return `${prefix}${value.includes('reset=1') ? value : `${value}&reset=1`}`;
      }
    );
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || '';

  const entry = cookies
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  return entry
    ? decodeURIComponent(entry.slice(name.length + 1))
    : null;
}

function upstreamCookieHeader(request) {
  return (request.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('relay-target='))
    .join('; ');
}

function localSetCookies(upstream) {
  const cookies =
    typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];

  return cookies.map((cookie) => {
    return cookie
      .replace(/;\s*Domain=[^;]*/ig, '')
      .replace(/;\s*Secure/ig, '');
  });
}

async function fetchUpstream(request, target) {
  let currentTarget = normalizeTarget(target);
  const cookieHeader = upstreamCookieHeader(request);
  const relayHost = request.headers.host || `localhost:${PORT}`;

  let redirectCount = 0;
  let upstream;

  while (true) {
    upstream = await fetch(currentTarget, {
      redirect: 'manual',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': `Mozilla/5.0 (compatible; Relay/1.0; +http://${relayHost})`,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      }
    });

    const location = upstream.headers.get('location');

    if (
      ![301, 302, 303, 307, 308].includes(upstream.status) ||
      !location
    ) {
      break;
    }

    if (redirectCount >= 10) {
      throw new Error('The upstream site redirected too many times.');
    }

    const nextTarget = normalizeTarget(
      new URL(location, currentTarget)
    );

    await assertPublicTarget(nextTarget);

    currentTarget = nextTarget;
    redirectCount += 1;
  }

  return {
    upstream,
    target: currentTarget,
    redirectCount
  };
}

async function handleProxy(request, response, target, resetRoute = false) {
  target = normalizeTarget(target);

  if (isLoginNavigation(target)) {
    response.writeHead(302, {
      Location: `/remote?url=${encodeURIComponent(
        restoreAuthReturnUrl(target).href
      )}`,
      'Cache-Control': 'no-store'
    });

    response.end();
    return;
  }

  const startedAt = performance.now();
  const metrics = {};

  const mark = (name) => {
    metrics[name] =
      Math.round((performance.now() - startedAt) * 100) / 100;
  };

  await assertPublicTarget(target);
  mark('dns');

  const fetchStartedAt = performance.now();
  const fetched = await fetchUpstream(request, target);
  const upstream = fetched.upstream;

  metrics.fetch =
    Math.round((performance.now() - fetchStartedAt) * 100) / 100;

  const finalTarget = fetched.target;

  await assertPublicTarget(finalTarget);
  mark('headers');

  const contentType =
    upstream.headers.get('content-type') ||
    'application/octet-stream';

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Timing-Allow-Origin': '*',
    'X-Proxy-Upstream': finalTarget.href
  };

  let body;

  if (contentType.includes('text/html')) {
    const html = await upstream.text();

    const bridge = `<script>history.replaceState(null, document.title, ${JSON.stringify(
      browserPath(finalTarget, request)
    )});</script>`;

    const rewritten = rewriteHtml(html, finalTarget.href);

    body = Buffer.from(
      rewritten.replace(/<\/head>/i, `${bridge}</head>`)
    );
  } else if (contentType.includes('text/css')) {
    const css = await upstream.text();
    body = Buffer.from(rewriteCss(css, finalTarget.href));
  } else if (contentType.includes('javascript')) {
    const script = await upstream.text();

    const pageOrigin =
      cookieValue(request, 'relay-target') ||
      finalTarget.origin;

    body = Buffer.from(
      rewriteScript(script, finalTarget.href, pageOrigin)
    );
  } else {
    body = Buffer.from(await upstream.arrayBuffer());
  }

  mark('body');

  metrics.bytes = body.length;
  mark('total');

  headers['X-Proxy-Bytes'] = String(body.length);

  headers['X-Proxy-Metrics'] = JSON.stringify({
    ...metrics,
    status: upstream.status,
    redirects: fetched.redirectCount
  });

  const routeOrigin = resetRoute
    ? finalTarget.origin
    : (cookieValue(request, 'relay-target') || finalTarget.origin);

  headers['Set-Cookie'] = [
    `relay-target=${encodeURIComponent(
      routeOrigin
    )}; Path=/; SameSite=Lax`,
    ...localSetCookies(upstream)
  ];

  response.writeHead(upstream.status, headers);
  response.end(body);

  console.log(
    `[proxy] ${request.method} ${target.href} -> ${upstream.status} ${contentType} ${headers['X-Proxy-Metrics']}`
  );
}

/*
 * CDP/Chromium virtual key codes.
 *
 * These make non-text keys—including Backspace, Delete, Tab, Enter,
 * and the cursor-arrow keys—operate normally in the remote page.
 */
const VIRTUAL_KEY_CODES = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93
};

function virtualKeyCode(event) {
  if (VIRTUAL_KEY_CODES[event.key] !== undefined) {
    return VIRTUAL_KEY_CODES[event.key];
  }

  if (/^F([1-9]|1[0-2])$/.test(event.key)) {
    return 111 + Number(event.key.slice(1));
  }

  if (event.key.length === 1) {
    return event.key.toUpperCase().charCodeAt(0);
  }

  return Number(event.keyCode || event.which || 0);
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host}`
    );

    if (requestUrl.pathname === '/remote') {
      return serveFile(
        response,
        'remote.html',
        'text/html; charset=utf-8',
        { 'Cache-Control': 'no-store' }
      );
    }

    if (requestUrl.pathname === '/remote.js') {
      return serveFile(
        response,
        'remote.js',
        'text/javascript; charset=utf-8',
        { 'Cache-Control': 'no-store' }
      );
    }

    if (requestUrl.pathname === '/remote.css') {
      return serveFile(
        response,
        'remote.css',
        'text/css; charset=utf-8',
        { 'Cache-Control': 'no-store' }
      );
    }

    if (
      requestUrl.pathname === '/api/session' ||
      requestUrl.pathname.startsWith('/api/session/')
    ) {
      const handled = await handleBrowserApi(
        request,
        response,
        requestUrl
      );

      if (handled === false) {
        return sendJson(response, 404, {
          error: 'Browser session not found.'
        });
      }

      return;
    }

    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      return response.end('Method Not Allowed');
    }

    if (requestUrl.pathname === '/proxy') {
      const rawTarget = requestUrl.searchParams.get('url');

      if (!rawTarget) {
        throw new Error('Add a URL to proxy.');
      }

      const resetRoute =
        requestUrl.searchParams.get('reset') === '1' ||
        !cookieValue(request, 'relay-target');

      await handleProxy(
        request,
        response,
        new URL(rawTarget),
        resetRoute
      );

      return;
    }

    if (requestUrl.pathname === '/app.js') {
      return serveFile(
        response,
        'app.js',
        'text/javascript; charset=utf-8'
      );
    }

    if (requestUrl.pathname === '/styles.css') {
      return serveFile(
        response,
        'styles.css',
        'text/css; charset=utf-8'
      );
    }

    if (requestUrl.pathname === '/') {
      return serveFile(
        response,
        'index.html',
        'text/html; charset=utf-8',
        {
          'Set-Cookie':
            'relay-target=; Max-Age=0; Path=/; SameSite=Lax'
        }
      );
    }

    const relayTarget = cookieValue(request, 'relay-target');

    if (relayTarget) {
      await handleProxy(
        request,
        response,
        new URL(
          `${requestUrl.pathname}${requestUrl.search}`,
          relayTarget
        )
      );

      return;
    }

    return serveFile(
      response,
      'index.html',
      'text/html; charset=utf-8'
    );
  } catch (error) {
    response.writeHead(400, {
      'Content-Type': 'application/json; charset=utf-8'
    });

    response.end(JSON.stringify({
      error: error.message
    }));
  }
});

const streamServer = new WebSocketServer({ noServer: true });

streamServer.on('connection', (socket, request, session) => {
  session.clients.add(socket);

  socket.on('close', () => {
    session.clients.delete(socket);
  });

  socket.on('message', async (message) => {
    try {
      const event = JSON.parse(message.toString());

      if (event.type === 'mouse') {
        await session.cdp.send('Input.dispatchMouseEvent', {
          type: event.action,
          x: Number(event.x),
          y: Number(event.y),
          button: event.button || 'none',
          clickCount: Number(event.clickCount || 1),
          buttons: Number(event.buttons || 0)
        });

        return;
      }

      if (event.type === 'wheel') {
        await session.cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: Number(event.x),
          y: Number(event.y),
          deltaX: Number(event.deltaX),
          deltaY: Number(event.deltaY)
        });

        return;
      }

      if (event.type === 'key') {
        const modifiers =
        (event.altKey ? 1 : 0) |
        (event.ctrlKey ? 2 : 0) |
        (event.metaKey ? 4 : 0) |
        (event.shiftKey ? 8 : 0);

        const keyDown = event.action === 'keyDown';

        const isPrintable =
        typeof event.key === 'string' &&
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey;

  /*
   * Text characters—including punctuation such as "."—are sent with
   * CDP's `char` event. Do not assign them a Windows virtual-key code:
   * ASCII "." is 46, which CDP interprets as the Delete key.
   */
          if (keyDown && isPrintable) {
            await session.cdp.send('Input.dispatchKeyEvent', {
              type: 'char',
              text: event.key,
              unmodifiedText: event.key,
              modifiers
            });

          return;
        }

  /*
   * A printable key-up has no remote editing work to perform. The text
   * was already inserted by its `char` event above.
   */
        if (!keyDown && isPrintable) {
          return;
        }

  /*
   * Non-printing keys need CDP's low-level event path so controls,
   * text fields, cursor navigation, and deletion behave normally.
   */
        const virtualKey = virtualKeyCode(event);

        await session.cdp.send('Input.dispatchKeyEvent', {
          type: keyDown ? 'rawKeyDown' : 'keyUp',
          key: String(event.key || ''),
          code: String(event.code || ''),
          windowsVirtualKeyCode: virtualKey,
          nativeVirtualKeyCode: virtualKey,
          location: Number(event.location || 0),
          modifiers,
          autoRepeat: Boolean(event.repeat)
        });

        return;
      }

    } catch {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Input event failed.'
        }));
      }
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(
    request.url,
    `http://${request.headers.host}`
  );

  const match = requestUrl.pathname.match(
    /^\/stream\/([a-f0-9-]+)$/
  );

  const session = match && sessions.get(match[1]);

  if (!session) {
    socket.destroy();
    return;
  }

  streamServer.handleUpgrade(
    request,
    socket,
    head,
    (client) => {
      streamServer.emit(
        'connection',
        client,
        request,
        session
      );
    }
  );
});

server.listen(PORT, () => {
  console.log(`Web proxy running at http://localhost:${PORT}`);
});