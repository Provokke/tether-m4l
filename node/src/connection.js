import { nextDelay } from './backoff.js';

const OPEN = 1;

export function createConnection({
  url,
  token,
  ca,
  WebSocket,
  timers = globalThis,
  now = Date.now,
  heartbeatMs = 10_000,
  highWaterBytes = 1 << 20,
  maxPayloadBytes = 1 << 20,
  backoff = {},
  onOpen = () => {},
  onMessage = () => {},
  onStatus = () => {},
  onRtt = () => {},
  log = () => {},
}) {
  let running = false;
  let ws = null;
  let status = 'offline';
  let attempt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let missedPongs = 0;
  let pingSentAt = 0;

  function setStatus(next) {
    if (next === status) return;
    status = next;
    onStatus(next);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) timers.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function startHeartbeat(socket) {
    stopHeartbeat();
    missedPongs = 0;
    heartbeatTimer = timers.setInterval(() => {
      if (socket !== ws) return;
      if (missedPongs >= 2) {
        log('heartbeat lost, dropping connection');
        socket.terminate();
        return;
      }
      missedPongs++;
      pingSentAt = now();
      socket.ping();
    }, heartbeatMs);
  }

  function scheduleReconnect() {
    const delay = nextDelay(attempt++, backoff);
    log(`reconnecting in ${delay} ms`);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open() {
    if (!running) return;
    setStatus('connecting');
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        handshakeTimeout: 10_000,
        maxPayload: maxPayloadBytes,
        ...(ca ? { ca } : {}),
      });
    } catch (err) {
      log(`cannot connect to ${url}: ${err.message}`);
      running = false;
      setStatus('offline');
      return;
    }
    ws = socket;

    socket.on('open', () => {
      if (socket !== ws) return;
      attempt = 0;
      setStatus('online');
      startHeartbeat(socket);
      onOpen();
    });
    socket.on('message', (data, isBinary) => {
      if (socket !== ws || isBinary) return;
      onMessage(String(data));
    });
    socket.on('pong', () => {
      if (socket !== ws) return;
      missedPongs = 0;
      onRtt(now() - pingSentAt);
    });
    socket.on('error', (err) => {
      if (socket === ws) log(`socket error: ${err.message}`);
    });
    socket.on('close', (code) => {
      if (socket !== ws) return;
      ws = null;
      stopHeartbeat();
      if (!running) return;
      log(`connection closed (${code})`);
      setStatus('connecting');
      scheduleReconnect();
    });
  }

  return {
    start() {
      if (running) return;
      running = true;
      attempt = 0;
      open();
    },
    stop() {
      running = false;
      if (reconnectTimer !== null) timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      stopHeartbeat();
      const socket = ws;
      ws = null;
      if (socket) socket.close(1000, 'client stopping');
      setStatus('offline');
    },
    send(text) {
      if (!ws || ws.readyState !== OPEN || ws.bufferedAmount > highWaterBytes) return false;
      ws.send(text);
      return true;
    },
    get status() {
      return status;
    },
  };
}
