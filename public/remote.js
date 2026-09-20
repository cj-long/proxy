const address = document.querySelector('#address');
const form = document.querySelector('#navigate-form');
const state = document.querySelector('#state');
const screen = document.querySelector('#screen');
const empty = document.querySelector('#empty');
const localFilePicker = document.querySelector('#local-file-picker');
const soundButton = document.querySelector('#sound');
const microphoneButton = document.querySelector('#microphone');
const stopMicrophoneButton = document.querySelector('#stop-microphone');
const micStatus = document.querySelector('#mic-status');
const micLevel = document.querySelector('#mic-level');

const canvas = screen;
const context = canvas.getContext('2d');

let pendingUpload = false;
let sessionId = null;
let refreshTimer = null;
let viewport = { width: 1280, height: 800 };
let stream = null;
let audioContext = null;
let soundEnabled = false;
let microphoneStream = null;
let microphoneContext = null;
let microphoneAnalyser = null;
let microphoneMeterFrame = null;
let microphoneProcessor = null;
let microphoneMuteGain = null;
let audioPeerConnection = null;
let remoteAudioTime = 0;
let audioStatsTimer = null;
let microphoneFrameCount = 0;
let microphoneRms = 0;

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

async function startAudioBridge() {
  if (audioPeerConnection) {
    audioPeerConnection.close();
  }

  audioPeerConnection = new RTCPeerConnection();
  audioPeerConnection.onconnectionstatechange = () => {
    const connectionState = audioPeerConnection.connectionState;

    micStatus.textContent = connectionState === 'connected'
      ? 'Mic connected'
      : `Mic ${connectionState}`;
  };

  for (const track of microphoneStream.getTracks()) {
    track.enabled = true;
    track.contentHint = 'speech';
    audioPeerConnection.addTrack(track, microphoneStream);
  }

  audioStatsTimer = setInterval(async () => {
    if (!audioPeerConnection) {
      return;
    }

    const reports = await audioPeerConnection.getStats();
    let bytesSent = 0;

    for (const report of reports.values()) {
      if (report.type === 'outbound-rtp' && report.kind === 'audio') {
        bytesSent += report.bytesSent || 0;
      }
    }

    if (bytesSent > 0) {
      micStatus.textContent = 'Mic audio flowing';
    }
  }, 1000);

  const offer = await audioPeerConnection.createOffer();
  await audioPeerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(audioPeerConnection);

  sendStreamEvent({
    type: 'audio-signal',
    signal: {
      kind: 'microphone',
      description: audioPeerConnection.localDescription
    }
  });
}

function playAlertTone() {
  if (!soundEnabled || !audioContext) {
    return;
  }

  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(740, now);
  oscillator.frequency.setValueAtTime(1047, now + 0.13);

  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

  oscillator.connect(gain);
  gain.connect(audioContext.destination);

  oscillator.start(now);
  oscillator.stop(now + 0.31);
}

async function playRemoteAudio(data) {
  if (!soundEnabled || !audioContext) {
    return;
  }

  const arrayBuffer = await data.arrayBuffer();
  const sampleCount = Math.floor(arrayBuffer.byteLength / 2);
  const samples = new Int16Array(arrayBuffer, 0, sampleCount);
  const frameCount = Math.floor(samples.length / 2);
  const audioBuffer = audioContext.createBuffer(2, frameCount, 48000);

  for (let channel = 0; channel < 2; channel += 1) {
    const output = audioBuffer.getChannelData(channel);

    for (let frame = 0; frame < frameCount; frame += 1) {
      output[frame] = samples[frame * 2 + channel] / 32768;
    }
  }

  const source = audioContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioContext.destination);

  remoteAudioTime = Math.max(
    remoteAudioTime,
    audioContext.currentTime + 0.03
  );
  source.start(remoteAudioTime);
  remoteAudioTime += audioBuffer.duration;
}

function stopMicrophone() {
  if (microphoneMeterFrame) {
    cancelAnimationFrame(microphoneMeterFrame);
    microphoneMeterFrame = null;
  }

  if (microphoneStream) {
    for (const track of microphoneStream.getTracks()) {
      track.stop();
    }
  }

  microphoneStream = null;

  microphoneProcessor?.disconnect();
  microphoneMuteGain?.disconnect();
  microphoneProcessor = null;
  microphoneMuteGain = null;

  if (audioPeerConnection) {
    audioPeerConnection.close();
    audioPeerConnection = null;
  }

  if (audioStatsTimer) {
    clearInterval(audioStatsTimer);
    audioStatsTimer = null;
  }

  microphoneAnalyser = null;

  if (microphoneContext) {
    microphoneContext.close().catch(() => {});
  }

  microphoneContext = null;
  micLevel.value = 0;
  micStatus.textContent = 'Mic off';
  micStatus.classList.remove('live');
  microphoneButton.hidden = false;
  stopMicrophoneButton.hidden = true;
}

function updateMicrophoneLevel() {
  if (!microphoneAnalyser) {
    return;
  }

  const samples = new Uint8Array(microphoneAnalyser.fftSize);
  microphoneAnalyser.getByteTimeDomainData(samples);

  let total = 0;

  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    total += normalized * normalized;
  }

  micLevel.value = Math.min(1, Math.sqrt(total / samples.length) * 3);
  microphoneMeterFrame = requestAnimationFrame(updateMicrophoneLevel);
}

soundButton.addEventListener('click', async () => {
  audioContext ??= new AudioContext();

  await audioContext.resume();

  soundEnabled = true;
  soundButton.textContent = 'Sound enabled';

  playAlertTone();
});

microphoneButton.addEventListener('click', async () => {
  try {
    micStatus.textContent = 'Requesting mic…';
    microphoneFrameCount = 0;

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: true
    });

    microphoneContext = new AudioContext({ sampleRate: 48000 });
    await microphoneContext.resume();
    const source = microphoneContext.createMediaStreamSource(
      microphoneStream
    );

    microphoneAnalyser = microphoneContext.createAnalyser();
    microphoneAnalyser.fftSize = 1024;
    microphoneProcessor = microphoneContext.createScriptProcessor(4096, 1, 1);
    microphoneMuteGain = microphoneContext.createGain();
    microphoneMuteGain.gain.value = 0;

    source.connect(microphoneAnalyser);
    source.connect(microphoneProcessor);
    microphoneProcessor.connect(microphoneMuteGain);
    microphoneMuteGain.connect(microphoneContext.destination);

    microphoneProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const samples = new Int16Array(input.length);
      let energy = 0;

      for (let index = 0; index < input.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, input[index]));
        energy += sample * sample;
        samples[index] = sample < 0 ? sample * 32768 : sample * 32767;
      }

      sendStreamAudio(samples.buffer);
      microphoneFrameCount += 1;
      microphoneRms = Math.sqrt(energy / input.length);

      if (microphoneFrameCount % 10 === 0) {
        micStatus.textContent = `Mic streaming (${microphoneFrameCount} frames, RMS ${microphoneRms.toFixed(3)})`;
      }
    };

    micStatus.textContent = 'Mic streaming';
    micStatus.classList.add('live');
    microphoneButton.hidden = true;
    stopMicrophoneButton.hidden = false;

    updateMicrophoneLevel();
  } catch (error) {
    console.error(error);
    micStatus.textContent = 'Mic blocked or unavailable';
  }
});

stopMicrophoneButton.addEventListener('click', stopMicrophone);

window.addEventListener('pagehide', stopMicrophone);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json'
    },
    ...options
  });

  const body = await response.json();

  if (!response.ok) {
    throw new Error(body.error || 'Browser session request failed.');
  }

  return body;
}

async function refresh() {
  if (!sessionId) {
    return;
  }

  const current = await api(`/api/session/${sessionId}/state`);

  viewport = {
    width: current.width,
    height: current.height
  };

  address.value = current.url;
  state.textContent = current.title || current.url;
}

function openLocalFilePicker() {
  pendingUpload = true;
  localFilePicker.value = '';
  localFilePicker.click();
}

async function openBrowser(url) {
  state.textContent = 'Loading…';

  try {
    if (stream) {
      stream.close();
      stream = null;
    }

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

    stream.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') {
        playRemoteAudio(event.data).catch((error) => console.error(error));
        return;
      }

      const message = JSON.parse(event.data);

      if (message.type === 'frame') {
        const image = new Image();

        image.onload = () => {
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
        };

        image.src = `data:image/jpeg;base64,${message.data}`;
        return;
      }

      if (message.type === 'fileChooser') {
        openLocalFilePicker();
        return;
      }

      if (
        message.type === 'audio-signal' &&
        audioPeerConnection
      ) {
        if (message.signal.description?.type === 'answer') {
          audioPeerConnection
            .setRemoteDescription(message.signal.description)
            .catch((error) => {
              console.error(error);
              micStatus.textContent = 'Mic negotiation failed';
            });
        }

        if (message.signal.kind === 'microphone-status') {
          micStatus.textContent = message.signal.bytesReceived > 0
            ? 'Mic audio received'
            : `Mic ${message.signal.state}`;
        }

        return;
      }

      if (message.type === 'error') {
        state.textContent = message.message;
      }
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
    refreshTimer = setInterval(() => {
      refresh().catch((error) => {
        console.error(error);
      });
    }, 1400);
  } catch (error) {
    state.textContent = `Could not load site: ${error.message}`;
    console.error(error);
    throw error;
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    await openBrowser(address.value.trim());
  } catch (error) {
    state.textContent = error.message;
  }
});

function streamPoint(event) {
  const bounds = canvas.getBoundingClientRect();

  return {
    x: ((event.clientX - bounds.left) / bounds.width) * viewport.width,
    y: ((event.clientY - bounds.top) / bounds.height) * viewport.height
  };
}

function sendStreamEvent(value) {
  if (!stream || stream.readyState !== WebSocket.OPEN) {
    return;
  }

  stream.send(JSON.stringify(value));
}

function sendStreamAudio(value) {
  if (!stream || stream.readyState !== WebSocket.OPEN) {
    return;
  }

  stream.send(value);
}

canvas.addEventListener('mousedown', (event) => {
  const point = streamPoint(event);

  sendStreamEvent({
    type: 'mouse',
    action: 'mousePressed',
    ...point,
    button: event.button === 2 ? 'right' : 'left',
    clickCount: event.detail,
    buttons: event.buttons
  });

  canvas.focus();
});

canvas.addEventListener('mouseup', (event) => {
  const point = streamPoint(event);

  sendStreamEvent({
    type: 'mouse',
    action: 'mouseReleased',
    ...point,
    button: event.button === 2 ? 'right' : 'left',
    clickCount: event.detail,
    buttons: event.buttons
  });
});

canvas.addEventListener('mousemove', (event) => {
  if (!event.buttons) {
    return;
  }

  sendStreamEvent({
    type: 'mouse',
    action: 'mouseMoved',
    ...streamPoint(event),
    buttons: event.buttons
  });
});

canvas.addEventListener('wheel', (event) => {
  if (!stream || stream.readyState !== WebSocket.OPEN) {
    return;
  }

  event.preventDefault();

  sendStreamEvent({
    type: 'wheel',
    ...streamPoint(event),
    deltaX: event.deltaX,
    deltaY: event.deltaY
  });
}, { passive: false });

screen.tabIndex = 0;

function sendKeyEvent(event, action) {
  if (
    !stream ||
    stream.readyState !== WebSocket.OPEN ||
    document.activeElement !== screen
  ) {
    return;
  }

  event.preventDefault();

  sendStreamEvent({
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
  });
}

screen.addEventListener('keydown', (event) => {
  sendKeyEvent(event, 'keyDown');
});

screen.addEventListener('keyup', (event) => {
  sendKeyEvent(event, 'keyUp');
});

for (const [name, action] of [
  ['back', 'back'],
  ['forward', 'forward'],
  ['reload', 'reload']
]) {
  document.querySelector(`#${name}`).addEventListener('click', async () => {
    if (!sessionId) {
      return;
    }

    try {
      await api(`/api/session/${sessionId}/${action}`, {
        method: 'POST',
        body: '{}'
      });

      await refresh();
    } catch (error) {
      state.textContent = error.message;
    }
  });
}

document.querySelector('#fullscreen').addEventListener('click', () => {
  document.querySelector('.browser-shell').requestFullscreen?.();
});

localFilePicker.addEventListener('change', async () => {
  if (!pendingUpload || !sessionId) {
    return;
  }

  const files = [...localFilePicker.files];
  pendingUpload = false;

  if (files.length === 0) {
    state.textContent = 'File selection cancelled.';
    return;
  }

  try {
    state.textContent = `Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`;

    const formData = new FormData();

    for (const file of files) {
      formData.append('files', file, file.name);
    }

    const response = await fetch(`/api/session/${sessionId}/upload`, {
      method: 'POST',
      body: formData
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Upload failed.');
    }

    state.textContent =
      `Selected ${files.length} file${files.length === 1 ? '' : 's'} for upload.`;
  } catch (error) {
    state.textContent = `Upload failed: ${error.message}`;
    console.error(error);
  }
});

const initialUrl = new URLSearchParams(window.location.search).get('url');

if (initialUrl) {
  openBrowser(initialUrl).catch((error) => {
    state.textContent = error.message;
  });
}