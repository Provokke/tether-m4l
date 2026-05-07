const $ = (id) => document.getElementById(id);
const PROTOCOL_VERSION = 1;
const CONFIRM_MS = 2000;

const devices = new Map();
let current = null;
let socket = null;
let seq = 0;
let cmdCounter = 0;
let retry = 0;
const pending = new Map();

function token() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) sessionStorage.setItem('tether-token', fromHash);
  return fromHash ?? sessionStorage.getItem('tether-token');
}

function connect() {
  const t = token();
  if (!t) {
    $('token-form').hidden = false;
    return;
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${scheme}://${location.host}/dashboard?token=${encodeURIComponent(t)}`);
  setLink('connecting');
  socket.onopen = () => {
    retry = 0;
    setLink('online');
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.v === PROTOCOL_VERSION) handle(msg);
  };
  socket.onclose = (ev) => {
    setLink('offline');
    if (ev.code === 1006 && retry === 0 && !devices.size) $('token-form').hidden = false;
    const delay = Math.min(15000, 500 * 2 ** retry++) * Math.random() + 250;
    setTimeout(connect, delay);
  };
}

function send(type, payload) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, seq: seq++, ts: Date.now(), payload }));
  return true;
}

function handle({ type, payload }) {
  switch (type) {
    case 'snapshot':
      devices.clear();
      for (const d of payload.devices) devices.set(d.deviceId, d);
      break;
    case 'device.up':
      devices.set(payload.deviceId, payload);
      break;
    case 'device.down':
      devices.delete(payload.deviceId);
      break;
    case 'state': {
      const d = devices.get(payload.deviceId);
      if (d) d.state = payload.state;
      break;
    }
    case 'patch': {
      const d = devices.get(payload.deviceId);
      if (!d) return;
      Object.assign(d.state, payload.changes);
      if (payload.deviceId === current) {
        render(payload.changes);
        confirmPending();
      }
      return;
    }
    case 'ack':
      return onAck(payload);
    case 'error':
      return logLine(`server: ${payload.code}`, payload.message, 'failed');
    default:
      return;
  }
  syncDevices();
}

function syncDevices() {
  const select = $('device');
  if (!devices.has(current)) current = devices.keys().next().value ?? null;
  select.replaceChildren(...[...devices].map(([id, d]) => new Option(`${d.name} (${id})`, id, false, id === current)));
  select.hidden = devices.size < 2;
  $('empty').hidden = devices.size > 0;
  $('app').hidden = devices.size === 0;
  if (current) {
    buildClipGrid();
    render(null);
  }
}

$('device').addEventListener('change', (e) => {
  current = e.target.value;
  syncDevices();
});

const S = () => devices.get(current)?.state ?? {};
const changed = (changes, ...keys) => changes === null || keys.some((k) => k in changes);

function render(changes) {
  const s = S();
  if (changed(changes, 'songTime', 'sigNum', 'sigDen')) $('position').textContent = formatPosition(s);
  if (changed(changes, 'sigNum', 'sigDen')) $('signature').textContent = `${s.sigNum ?? 4}/${s.sigDen ?? 4}`;
  if (changed(changes, 'playing')) $('play').classList.toggle('active', s.playing === true);
  if (changed(changes, 'tempo') && document.activeElement !== $('tempo') && typeof s.tempo === 'number') {
    $('tempo').value = s.tempo.toFixed(2);
  }
  if (changed(changes, 'track.name')) $('track-name').textContent = s['track.name'] ?? '—';
  if (changed(changes, 'track.color')) {
    $('track-color').style.setProperty('background', typeof s['track.color'] === 'number' ? colorHex(s['track.color']) : '');
  }
  if (changed(changes, 'track.index', 'track.kind')) {
    $('track-index').textContent = s['track.kind'] === 'track' ? `#${s['track.index'] + 1}` : (s['track.kind'] ?? '');
    for (const el of document.querySelectorAll('.col-head')) {
      el.classList.toggle('selected', Number(el.dataset.track) === s['track.index'] && s['track.kind'] === 'track');
    }
  }
  if (changed(changes, 'track.meter')) {
    $('meter').style.setProperty('transform', `scaleX(${Math.max(0, Math.min(1, s['track.meter'] ?? 0))})`);
  }
  if (changed(changes, 'track.volume') && typeof s['track.volume'] === 'number') {
    if (!volumeDragging) $('volume').value = s['track.volume'];
    $('volume-out').textContent = s['track.volume'].toFixed(2);
  }
  if (changed(changes, 'trackCount', 'sceneCount')) buildClipGrid();
}

function formatPosition(s) {
  const beats = s.songTime ?? 0;
  const num = s.sigNum ?? 4;
  const den = s.sigDen ?? 4;
  const beatLen = 4 / den;
  const barLen = num * beatLen;
  const bar = Math.floor(beats / barLen) + 1;
  const inBar = beats - (bar - 1) * barLen;
  const beat = Math.floor(inBar / beatLen) + 1;
  const sixteenth = Math.floor(((inBar % beatLen) / beatLen) * 4) + 1;
  return `${bar}.${beat}.${sixteenth}`;
}

const colorHex = (n) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;

function buildClipGrid() {
  const s = S();
  const grid = $('clip-grid');
  const tracks = Math.min(s.trackCount ?? 0, 16);
  const scenes = Math.min(s.sceneCount ?? 0, 12);
  $('set-size').textContent = s.trackCount === undefined ? '' : `${s.trackCount} tracks · ${s.sceneCount ?? 0} scenes`;
  grid.style.setProperty('grid-template-columns', `repeat(${tracks}, minmax(64px, 1fr))`);
  const cells = [];
  for (let t = 0; t < tracks; t++) {
    const head = document.createElement('button');
    head.className = 'col-head';
    head.dataset.track = t;
    head.textContent = `Track ${t + 1}`;
    head.title = 'Select track';
    head.addEventListener('click', () => command('track.select', { index: t }));
    cells.push(head);
  }
  for (let sc = 0; sc < scenes; sc++) {
    for (let t = 0; t < tracks; t++) {
      const clip = document.createElement('button');
      clip.className = 'clip';
      clip.textContent = '▶';
      clip.setAttribute('aria-label', `Fire clip on track ${t + 1}, scene ${sc + 1}`);
      clip.addEventListener('click', () => {
        clip.classList.remove('flash');
        void clip.offsetWidth;
        clip.classList.add('flash');
        command('clip.fire', { track: t, slot: sc });
      });
      cells.push(clip);
    }
  }
  grid.replaceChildren(...cells);
  render({ 'track.index': true });
}

const CONFIRMERS = {
  'tempo.set': (a, s) => Math.abs((s.tempo ?? NaN) - Math.min(999, Math.max(20, a.bpm))) < 0.01,
  'track.volume': (a, s) => Math.abs((s['track.volume'] ?? NaN) - a.value) < 0.005,
  'track.select': (a, s) => s['track.index'] === a.index,
  'transport.play': (_, s) => s.playing === true,
  'transport.stop': (_, s) => s.playing === false,
};

function command(name, args) {
  if (!current) return;
  const id = `ui${++cmdCounter}`;
  const li = logLine(name, JSON.stringify(args), 'pending');
  pending.set(id, { name, args, li, confirm: CONFIRMERS[name] });
  if (!send('cmd', { deviceId: current, id, name, args })) setStatus(id, 'failed', 'not connected');
}

function onAck({ id, ok, error }) {
  const p = pending.get(id);
  if (!p) return;
  if (!ok) return setStatus(id, 'failed', error.code);
  if (!p.confirm) return setStatus(id, 'dispatched');
  setStatus(id, 'dispatched', null, false);
  confirmPending();
  if (pending.has(id)) {
    setTimeout(() => pending.has(id) && setStatus(id, 'unconfirmed'), CONFIRM_MS);
  }
}

function confirmPending() {
  const s = S();
  for (const [id, p] of pending) {
    if (p.dispatched && p.confirm?.(p.args, s)) setStatus(id, 'applied');
  }
}

function setStatus(id, status, detail = null, done = true) {
  const p = pending.get(id);
  if (!p) return;
  const st = p.li.querySelector('.st');
  st.dataset.s = status;
  st.textContent = detail ? `${status}: ${detail}` : status;
  if (status === 'dispatched') p.dispatched = true;
  if (done) pending.delete(id);
}

function logLine(what, detail, status) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const text = document.createElement('span');
  text.textContent = `${what} ${detail}`;
  const st = document.createElement('span');
  st.className = 'st';
  st.dataset.s = status;
  st.textContent = status;
  li.append(time, text, st);
  const log = $('log');
  log.prepend(li);
  while (log.children.length > 100) log.lastChild.remove();
  return li;
}

$('play').addEventListener('click', () => command('transport.play', {}));
$('stop').addEventListener('click', () => command('transport.stop', {}));

$('tempo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const bpm = Number($('tempo').value);
  if (Number.isFinite(bpm)) command('tempo.set', { bpm });
  $('tempo').blur();
});
for (const b of document.querySelectorAll('[data-nudge]')) {
  b.addEventListener('click', () => {
    const bpm = (S().tempo ?? 120) + Number(b.dataset.nudge);
    command('tempo.set', { bpm: Math.round(bpm * 100) / 100 });
  });
}

let volumeDragging = false;
let volumeFrame = 0;
$('volume').addEventListener('pointerdown', () => (volumeDragging = true));
$('volume').addEventListener('input', () => {
  $('volume-out').textContent = Number($('volume').value).toFixed(2);
  if (volumeFrame) return;
  volumeFrame = requestAnimationFrame(() => {
    volumeFrame = 0;
    command('track.volume', { value: Number($('volume').value) });
  });
});
$('volume').addEventListener('change', () => {
  volumeDragging = false;
  command('track.volume', { value: Number($('volume').value) });
});

$('token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  location.hash = `token=${encodeURIComponent($('token-input').value)}`;
  $('token-form').hidden = true;
  if (!socket || socket.readyState === WebSocket.CLOSED) connect();
});

function setLink(state) {
  $('link').dataset.state = state;
  $('link').textContent = state;
}

connect();
