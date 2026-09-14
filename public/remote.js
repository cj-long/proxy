const address = document.querySelector('#address');
const form = document.querySelector('#navigate-form');
const state = document.querySelector('#state');
const screen = document.querySelector('#screen');
const empty = document.querySelector('#empty');
let sessionId = null;
let refreshTimer = null;
let viewport = { width: 1280, height: 800 };
let stream = null;
const canvas = screen;
const context = canvas.getContext('2d');

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Browser session request failed.');
  return body;
}

async function refresh() {
  if (!sessionId) return;
  const current = await api(`/api/session/${sessionId}/state`);
  viewport = { width: current.width, height: current.height };
  address.value = current.url;
  state.textContent = current.title || current.url;
}

async function openBrowser(url) {
  state.textContent = 'Loading…';

  try {
    const current = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ url })
    });

    sessionId = current.id;
    empty.hidden = true;
    screen.hidden = false;

    canvas.width = current.width;
    canvas.height = current.height;

    stream = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/stream/${sessionId}`
    );

    stream.addEventListener('message', async (event) => {
      const message = JSON.parse(event.data);

      if (message.type === 'error') {
        state.textContent = message.message;
        return;
      }

      if (message.type !== 'frame') {
        return;
      }

      const image = new Image();

      image.onload = () => {
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
      };

      image.src = `data:image/jpeg;base64,${message.data}`;
    });

    stream.addEventListener('error', () => {
      state.textContent = 'The remote-browser input connection failed.';
    });

    stream.addEventListener('close', () => {
      if (sessionId) {
        state.textContent = 'The remote browser connection closed.';
      }
    });

    await refresh();

    clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 1400);
  } catch (error) {
    state.textContent = `Could not load site: ${error.message}`;
    console.error(error);
    throw error;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await openBrowser(address.value.trim()); } catch (error) { state.textContent = error.message; }
});

function streamPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return { x: (event.clientX - bounds.left) / bounds.width * viewport.width, y: (event.clientY - bounds.top) / bounds.height * viewport.height };
}

canvas.addEventListener('mousedown', (event) => {
  if (!stream) return;
  const point = streamPoint(event);
  stream.send(JSON.stringify({ type: 'mouse', action: 'mousePressed', ...point, button: event.button === 2 ? 'right' : 'left', clickCount: event.detail, buttons: event.buttons }));
  canvas.focus();
});
canvas.addEventListener('mouseup', (event) => {
  if (!stream) return;
  const point = streamPoint(event);
  stream.send(JSON.stringify({ type: 'mouse', action: 'mouseReleased', ...point, button: event.button === 2 ? 'right' : 'left', clickCount: event.detail, buttons: event.buttons }));
});
canvas.addEventListener('mousemove', (event) => {
  if (!stream || !event.buttons) return;
  stream.send(JSON.stringify({ type: 'mouse', action: 'mouseMoved', ...streamPoint(event), buttons: event.buttons }));
});
canvas.addEventListener('wheel', (event) => {
  if (!stream) return;
  event.preventDefault();
  stream.send(JSON.stringify({ type: 'wheel', ...streamPoint(event), deltaX: event.deltaX, deltaY: event.deltaY }));
}, { passive: false });

screen.tabIndex = 0;

function sendKeyEvent(event, action) {
  if (!stream || stream.readyState !== WebSocket.OPEN) {
    return;
  }

  // Only intercept keyboard input when the remote browser canvas
  // actually has focus. This keeps the local address bar editable.
  if (document.activeElement !== screen) {
    return;
  }

  event.preventDefault();

  stream.send(JSON.stringify({
    type: 'key',
    action,
    key: event.key,
    code: event.code,
    keyCode: event.keyCode,
    which: event.which,
    location: event.location,
    repeat: event.repeat,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey
  }));
}

screen.addEventListener('keydown', (event) => {
  sendKeyEvent(event, 'keyDown');
});

screen.addEventListener('keyup', (event) => {
  sendKeyEvent(event, 'keyUp');
});

for (const [name, action] of [['back', 'back'], ['forward', 'forward'], ['reload', 'reload']]) {
  document.querySelector(`#${name}`).addEventListener('click', async () => {
    if (!sessionId) return;
    await api(`/api/session/${sessionId}/${action}`, { method: 'POST', body: '{}' });
    await refresh();
  });
}

document.querySelector('#fullscreen').addEventListener('click', () => {
  document.querySelector('.browser-shell').requestFullscreen?.();
});

const initialUrl = new URLSearchParams(window.location.search).get('url');
if (initialUrl) openBrowser(initialUrl).catch((error) => { state.textContent = error.message; });