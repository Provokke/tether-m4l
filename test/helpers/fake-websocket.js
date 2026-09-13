import { EventEmitter } from 'node:events';

export function createFakeWebSocketClass() {
  const instances = [];

  class FakeWebSocket extends EventEmitter {
    constructor(url, options) {
      super();
      if (!/^wss?:\/\//.test(url)) throw new SyntaxError(`Invalid URL: ${url}`);
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.bufferedAmount = 0;
      this.sent = [];
      this.pings = 0;
      this.closed = null;
      this.terminated = false;
      instances.push(this);
    }
    send(data) {
      this.sent.push(String(data));
    }
    ping() {
      this.pings++;
    }
    close(code = 1000, reason = '') {
      this.closed = { code, reason };
      this.serverClose(code);
    }
    terminate() {
      this.terminated = true;
      this.serverClose(1006);
    }
    serverOpen() {
      this.readyState = 1;
      this.emit('open');
    }
    serverClose(code = 1006) {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', code);
    }
    serverSend(text) {
      this.emit('message', Buffer.from(text), false);
    }
    serverPong() {
      this.emit('pong');
    }
  }

  return { FakeWebSocket, instances, last: () => instances[instances.length - 1] };
}
