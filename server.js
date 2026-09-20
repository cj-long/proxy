const http = require('node:http');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { URL } = require('node:url');
const { chromium } = require('playwright');
const { WebSocketServer } = require('ws');
const Busboy = require('busboy');

const PORT = Number(process.env.PORT || 3000);
const HEADLESS = process.env.HEADLESS !== 'false';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROFILE_DIR = path.join(__dirname, '.browser-profile');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;

const sessions = new Map();

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

let browserContextPromise;
let audioModuleId = null;
let audioInputModuleId = null;
let audioInputSourceModuleId = null;
let audioCaptureProcess = null;
let audioInputProcess = null;
let microphoneBytesWritten = 0;
const AUDIO_SINK = 'relay_output';
const AUDIO_INPUT_SINK = 'relay_input';
const AUDIO_INPUT_SOURCE = 'relay_microphone';

const AUDIO_BRIDGE_SCRIPT = `
  (() => {
    let remoteStream = null;
    let audioPeer = null;
    const pendingAudioRequests = [];

    function sendSignal(signal) {
      window.relayAudioSignal(signal).catch(() => {});
    }

    function waitForIceGatheringComplete(peerConnection) {
      if (peerConnection.iceGatheringState === 'complete') {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        peerConnection.addEventListener('icegatheringstatechange', () => {
          if (peerConnection.iceGatheringState === 'complete') {
            resolve();
          }
        });
      });
    }

    function resolveAudioRequests() {
      if (!remoteStream) {
        return;
      }

      while (pendingAudioRequests.length > 0) {
        pendingAudioRequests.shift()(remoteStream);
      }
    }

    async function reportAudioStats() {
      if (!audioPeer) {
        return;
      }

      const reports = await audioPeer.getStats();
      let bytesReceived = 0;

      for (const report of reports.values()) {
        if (report.type === 'inbound-rtp' && report.kind === 'audio') {
          bytesReceived += report.bytesReceived || 0;
        }
      }

      sendSignal({
        kind: 'microphone-status',
        state: audioPeer.connectionState,
        bytesReceived
      });
    }

    window.__relayReceiveAudioSignal = async (signal) => {
      if (signal.kind !== 'microphone') {
        return;
      }

      audioPeer ??= new RTCPeerConnection();
      audioPeer.ontrack = (event) => {
        event.track.enabled = true;
        remoteStream = event.streams[0] || new MediaStream();

        if (remoteStream.getAudioTracks().length === 0) {
          remoteStream.addTrack(event.track);
        }

        resolveAudioRequests();
      };
      audioPeer.onconnectionstatechange = () => {
        sendSignal({
          kind: 'microphone-status',
          state: audioPeer.connectionState
        });
      };

      setInterval(() => {
        reportAudioStats().catch(() => {});
      }, 1000);

      await audioPeer.setRemoteDescription(signal.description);

      if (signal.description.type === 'offer') {
        const answer = await audioPeer.createAnswer();
        await audioPeer.setLocalDescription(answer);
        await waitForIceGatheringComplete(audioPeer);
        sendSignal({
          kind: 'microphone',
          description: audioPeer.localDescription
        });
      }
    };

    if (!navigator.mediaDevices?.getUserMedia) {
      return;
    }

    const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices
    );
    const originalEnumerateDevices =
      navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);

    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await originalEnumerateDevices();

      if (devices.some((device) => device.kind === 'audioinput')) {
        return devices;
      }

      return [
        {
          deviceId: 'relay-microphone',
          groupId: 'relay-audio',
          kind: 'audioinput',
          label: 'Relay Microphone'
        },
        ...devices
      ];
    };

    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (!constraints?.audio) {
        return originalGetUserMedia(constraints);
      }

      if (remoteStream) {
        return Promise.resolve(remoteStream);
      }

      return new Promise((resolve) => {
        pendingAudioRequests.push(resolve);
      });
    };
  })();
`;

function getBrowserContext() {
  browserContextPromise ||= chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS,
    env: {
      ...process.env,
      PULSE_SINK: AUDIO_SINK,
      PULSE_SOURCE: AUDIO_INPUT_SOURCE
    },
    viewport: {
      width: 1280,
      height: 800
    }
  });

  return browserContextPromise;
}

function writeMicrophoneAudio(chunk) {
  if (audioInputProcess?.stdin.writable) {
    if (audioInputProcess.stdin.write(chunk)) {
      microphoneBytesWritten += chunk.length;
    }
  }
}

function broadcastAudio(chunk) {
  for (const session of sessions.values()) {
    for (const client of session.clients) {
      if (client.readyState === 1) {
        client.send(chunk);
      }
    }
  }
}

function setupAudioOutput() {
  if (process.env.AUDIO_CAPTURE === 'false') {
    return;
  }

  try {
    execFileSync('pulseaudio', [
      '--start',
      '--exit-idle-time=-1'
    ], { stdio: 'ignore' });
    execFileSync('pactl', ['info'], { stdio: 'ignore' });

    const sinks = execFileSync('pactl', ['list', 'short', 'sinks'], {
      encoding: 'utf8'
    });

    if (!sinks.split('\n').some((line) => line.includes(AUDIO_SINK))) {
      audioModuleId = execFileSync('pactl', [
        'load-module',
        'module-null-sink',
        `sink_name=${AUDIO_SINK}`,
        `sink_properties=device.description=RelayOutput`
      ], { encoding: 'utf8' }).trim();
    }

    const inputSinks = execFileSync('pactl', ['list', 'short', 'sinks'], {
      encoding: 'utf8'
    });
    if (!inputSinks.split('\n').some((line) => line.includes(AUDIO_INPUT_SINK))) {
      audioInputModuleId = execFileSync('pactl', [
        'load-module',
        'module-null-sink',
        `sink_name=${AUDIO_INPUT_SINK}`,
        'sink_properties=device.description=RelayMicrophoneInput'
      ], { encoding: 'utf8' }).trim();
    }

    const sources = execFileSync('pactl', ['list', 'short', 'sources'], {
      encoding: 'utf8'
    });

    if (!sources.split('\n').some((line) => line.includes(AUDIO_INPUT_SOURCE))) {
      audioInputSourceModuleId = execFileSync('pactl', [
        'load-module',
        'module-remap-source',
        `master=${AUDIO_INPUT_SINK}.monitor`,
        `source_name=${AUDIO_INPUT_SOURCE}`,
        'source_properties=device.description=RelayMicrophone',
        'remix=no'
      ], { encoding: 'utf8' }).trim();
    }

    execFileSync('pactl', [
      'set-default-sink',
      AUDIO_SINK
    ], { stdio: 'ignore' });
    execFileSync('pactl', [
      'set-default-source',
      AUDIO_INPUT_SOURCE
    ], { stdio: 'ignore' });
    execFileSync('pactl', [
      'set-source-mute',
      AUDIO_INPUT_SOURCE,
      '0'
    ], { stdio: 'ignore' });
    execFileSync('pactl', [
      'set-source-volume',
      AUDIO_INPUT_SOURCE,
      '100%'
    ], { stdio: 'ignore' });

    audioInputProcess = spawn('pacat', [
      `--device=${AUDIO_INPUT_SINK}`,
      '--format=s16le',
      '--rate=48000',
      '--channels=1',
      '--latency-msec=20',
      '--raw'
    ], {
      stdio: ['pipe', 'ignore', 'ignore'],
      env: process.env
    });

    audioInputProcess.on('error', () => {
      audioInputProcess = null;
    });
    audioInputProcess.stdin.on('error', () => {
      audioInputProcess = null;
    });

    audioCaptureProcess = spawn('parec', [
      `--device=${AUDIO_SINK}.monitor`,
      '--format=s16le',
      '--rate=48000',
      '--channels=2',
      '--latency-msec=20',
      '--raw'
    ], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env
    });

    audioCaptureProcess.stdout.on('data', broadcastAudio);
    audioCaptureProcess.on('error', () => {
      audioCaptureProcess = null;
    });
    console.log('Remote audio capture enabled.');
  } catch {
    console.warn(
      'Remote audio capture unavailable. Install PulseAudio tools or set AUDIO_CAPTURE=false.'
    );
  }
}

function stopAudioOutput() {
  audioCaptureProcess?.kill();
  audioInputProcess?.kill();

  for (const moduleId of [
    audioModuleId,
    audioInputModuleId,
    audioInputSourceModuleId
  ]) {
    if (!moduleId) {
      continue;
    }

    try {
      execFileSync('pactl', ['unload-module', moduleId], {
        stdio: 'ignore'
      });
    } catch {
      // The audio server may already be gone during process shutdown.
    }
  }
}

function sendJson(response, status, value) {
  if (response.headersSent) {
    return;
  }

  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  response.end(JSON.stringify(value));
}

function serveFile(response, fileName, contentType, extraHeaders = {}) {
  response.writeHead(200, {
    'Content-Type': contentType,
    ...extraHeaders
  });

  fs.createReadStream(path.join(PUBLIC_DIR, fileName)).pipe(response);
}

function safeUploadName(name) {
  return path.basename(name || 'upload');
}

function deleteTemporaryUploads(files) {
  for (const file of files) {
    if (file?.path) {
      fs.unlink(file.path, () => {});
    }
  }
}

function receiveUpload(request) {
  return new Promise((resolve, reject) => {
    const contentType = request.headers['content-type'] || '';

    if (!contentType.startsWith('multipart/form-data')) {
      reject(new Error('Expected a multipart file upload.'));
      return;
    }

    const busboy = Busboy({
      headers: request.headers,
      limits: {
        fileSize: MAX_UPLOAD_SIZE,
        files: MAX_UPLOAD_FILES
      }
    });

    const files = [];
    const pendingPaths = new Set();

    let settled = false;
    let parsingFinished = false;
    let pendingWrites = 0;

    function cleanup() {
      deleteTemporaryUploads(files);

      for (const filePath of pendingPaths) {
        fs.unlink(filePath, () => {});
      }
    }

    function fail(error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function finishIfReady() {
      if (!settled && parsingFinished && pendingWrites === 0) {
        settled = true;
        resolve(files);
      }
    }

    busboy.on('file', (fieldName, file, info) => {
      if (fieldName !== 'files') {
        file.resume();
        return;
      }

      pendingWrites += 1;

      const originalName = safeUploadName(info.filename);
      const filePath = path.join(
        UPLOAD_DIR,
        `${crypto.randomUUID()}-${originalName}`
      );

      pendingPaths.add(filePath);

      const output = fs.createWriteStream(filePath);

      let size = 0;
      let exceededLimit = false;

      file.on('data', (chunk) => {
        size += chunk.length;
      });

      file.on('limit', () => {
        exceededLimit = true;
      });

      file.on('error', fail);
      output.on('error', fail);

      output.on('finish', () => {
        pendingWrites -= 1;
        pendingPaths.delete(filePath);

        if (settled) {
          fs.unlink(filePath, () => {});
          return;
        }

        if (exceededLimit) {
          fs.unlink(filePath, () => {});
          fail(
            new Error(
              `A selected file exceeds the ${MAX_UPLOAD_SIZE / 1024 / 1024} MB limit.`
            )
          );
          return;
        }

        files.push({
          path: filePath,
          name: originalName,
          size
        });

        finishIfReady();
      });

      file.pipe(output);
    });

    busboy.on('filesLimit', () => {
      fail(new Error(`Select no more than ${MAX_UPLOAD_FILES} files.`));
    });

    busboy.on('error', fail);

    busboy.on('finish', () => {
      parsingFinished = true;
      finishIfReady();
    });

    request.on('error', fail);
    request.pipe(busboy);
  });
}

async function parseJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
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

function broadcast(session, value) {
  const message = JSON.stringify(value);

  for (const client of session.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

async function createBrowserSession(target) {
  const context = await getBrowserContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const id = crypto.randomUUID();

  const session = {
    context,
    page,
    cdp,
    clients: new Set(),
    pendingFileChooser: null,
    uploadedFiles: []
  };

  sessions.set(id, session);

  await context.grantPermissions(['microphone']);

  page.on('filechooser', (fileChooser) => {
    session.pendingFileChooser = fileChooser;
    broadcast(session, { type: 'fileChooser' });
  });

  page.on('close', () => {
    deleteTemporaryUploads(session.uploadedFiles);
    sessions.delete(id);
  });

  page.on('requestfailed', (request) => {
    console.log(
      `[network failed] ${request.resourceType()} ${request.url()} :: ${
        request.failure()?.errorText || 'unknown error'
      }`
    );
  });

  page.on('response', (response) => {
    const type = response.request().resourceType();

    if (response.status() >= 400 || type === 'image') {
      console.log(
        `[network] ${response.status()} ${type} ${response.url()}`
      );
    }
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 65,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1
  });

  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    await cdp
      .send('Page.screencastFrameAck', { sessionId })
      .catch(() => null);

    broadcast(session, {
      type: 'frame',
      data
    });
  });

  await page.goto(target.href, {
    waitUntil: 'commit',
    timeout: 45000
  });

  return {
    id,
    session
  };
}

async function handleBrowserApi(request, response, requestUrl) {
  if (requestUrl.pathname === '/api/session' && request.method === 'POST') {
    const body = await parseJson(request);
    const target = new URL(body.url);

    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new Error('Only http:// and https:// URLs are supported.');
    }

    const { id, session } = await createBrowserSession(target);

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

function proxyUrl(target) {
  return `/proxy?url=${encodeURIComponent(normalizeTarget(target).href)}`;
}

function normalizeTarget(target) {
  const normalized = new URL(target.href);
  const compValues = normalized.searchParams.getAll('comp');

  if (compValues.length > 0 && compValues.every((value) => value === '')) {
    normalized.searchParams.delete('comp');
  }

  return normalized;
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

function rewriteHtml(html, baseUrl) {
  const attributePattern =
    /\b(href|src|action|poster|data|srcset)\s*=\s*(["'])(.*?)\2/gi;

  return html.replace(
    attributePattern,
    (match, attribute, quote, value) => {
      const rewritten =
        attribute.toLowerCase() === 'srcset'
          ? rewriteSrcset(value, baseUrl)
          : rewriteResource(value, baseUrl);

      return rewritten === value
        ? match
        : `${attribute}=${quote}${rewritten}${quote}`;
    }
  );
}

async function fetchUpstream(request, target) {
  let currentTarget = normalizeTarget(target);
  let redirectCount = 0;

  while (true) {
    await assertPublicTarget(currentTarget);

    const upstream = await fetch(currentTarget, {
      redirect: 'manual',
      headers: {
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (compatible; Relay/1.0)'
      }
    });

    const location = upstream.headers.get('location');

    if (
      ![301, 302, 303, 307, 308].includes(upstream.status) ||
      !location
    ) {
      return {
        upstream,
        target: currentTarget,
        redirectCount
      };
    }

    if (redirectCount >= 10) {
      throw new Error('The upstream site redirected too many times.');
    }

    currentTarget = normalizeTarget(
      new URL(location, currentTarget)
    );

    redirectCount += 1;
  }
}

async function handleProxy(request, response, target) {
  const fetched = await fetchUpstream(request, target);
  const { upstream, target: finalTarget } = fetched;

  const contentType =
    upstream.headers.get('content-type') ||
    'application/octet-stream';

  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  };

  let body;

  if (contentType.includes('text/html')) {
    body = Buffer.from(
      rewriteHtml(await upstream.text(), finalTarget.href)
    );
  } else if (contentType.includes('text/css')) {
    body = Buffer.from(
      rewriteCss(await upstream.text(), finalTarget.href)
    );
  } else {
    body = Buffer.from(await upstream.arrayBuffer());
  }

  response.writeHead(upstream.status, headers);
  response.end(body);
}

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
  ContextMenu: 93,
  NumLock: 144,
  ScrollLock: 145
};

function virtualKeyCode(event) {
  return VIRTUAL_KEY_CODES[event.key] ??
    Number(event.keyCode || event.which || 0);
}

async function handleUpload(request, response, session) {
  let files = [];

  try {
    files = await receiveUpload(request);

    if (files.length === 0) {
      return sendJson(response, 400, {
        error: 'Choose at least one file.'
      });
    }

    const chooser = session.pendingFileChooser;
    session.pendingFileChooser = null;

    if (!chooser) {
      deleteTemporaryUploads(files);

      return sendJson(response, 409, {
        error: 'The remote site is not currently requesting a file.'
      });
    }

    await chooser.setFiles(files.map((file) => file.path));

    /*
     * Keep files while the remote page processes/uploads them.
     * They are removed when its remote tab closes.
     */
    session.uploadedFiles.push(...files);

    return sendJson(response, 200, {
      ok: true,
      files: files.map((file) => ({
        name: file.name,
        size: file.size
      }))
    });
  } catch (error) {
    deleteTemporaryUploads(files);

    return sendJson(response, 400, {
      error: error.message || 'File upload failed.'
    });
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url,
      `http://${request.headers.host}`
    );

    const uploadMatch = requestUrl.pathname.match(
      /^\/api\/session\/([a-f0-9-]+)\/upload$/
    );

    if (request.method === 'POST' && uploadMatch) {
      const session = sessions.get(uploadMatch[1]);

      if (!session) {
        return sendJson(response, 404, {
          error: 'Browser session not found.'
        });
      }

      if (!session.pendingFileChooser) {
        return sendJson(response, 409, {
          error: 'The remote site is not currently requesting a file.'
        });
      }

      return handleUpload(request, response, session);
    }

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

      return handleProxy(
        request,
        response,
        new URL(rawTarget)
      );
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
        'text/html; charset=utf-8'
      );
    }

    return serveFile(
      response,
      'index.html',
      'text/html; charset=utf-8'
    );
  } catch (error) {
    console.error(error);

    if (!response.headersSent) {
      sendJson(response, 400, {
        error: error.message || 'Request failed.'
      });
    }
  }
});

const streamServer = new WebSocketServer({ noServer: true });

streamServer.on('connection', (socket, request, session) => {
  session.clients.add(socket);

  socket.on('close', () => {
    session.clients.delete(socket);
  });

  socket.on('message', async (message, isBinary) => {
    try {
      if (isBinary) {
        writeMicrophoneAudio(message);
        return;
      }

      const event = JSON.parse(message.toString());

      if (event.type === 'audio-signal') {
        await session.page.evaluate(async (signal) => {
          await window.__relayReceiveAudioSignal?.(signal);
        }, event.signal);

        return;
      }

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
         * Printable characters use CDP's "char" event. That prevents
         * punctuation such as "." from colliding with Delete's virtual
         * key code (46).
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

        if (!keyDown && isPrintable) {
          return;
        }

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
      }
    } catch (error) {
      console.error('Input event failed:', error.message);

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
  setupAudioOutput();
  console.log(`Web proxy running at http://localhost:${PORT}`);
});

process.on('exit', stopAudioOutput);