import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  if (process.env.CHROME_BIN) return existsSync(process.env.CHROME_BIN) ? process.env.CHROME_BIN : null;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      for (const dir of dirs) candidates.push(path.join(dir, name));
    }
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function connect(url) {
  const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  });
  ws.on('close', () => {
    for (const p of pending.values()) p.reject(new Error(`${p.method}: connection closed`));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
    },
    once(method) {
      return new Promise((resolve) => {
        const fn = (params) => {
          listeners.set(method, listeners.get(method).filter((f) => f !== fn));
          resolve(params);
        };
        this.on(method, fn);
      });
    },
    close() {
      ws.terminate();
    },
  };
}

export async function launchChrome({ bin = findChrome(), width = 1280, height = 900 } = {}) {
  if (!bin) throw new Error('Chrome not found (set CHROME_BIN)');
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'tether-chrome-'));
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--mute-audio',
    'about:blank',
  ];
  if (process.platform === 'linux') args.push('--no-sandbox');

  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  let exited = false;
  const exit = new Promise((resolve) => proc.once('exit', () => { exited = true; resolve(); }));
  const killOnExit = () => { if (!exited) proc.kill('SIGKILL'); };
  process.once('exit', killOnExit);

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const readPortFile = () => {
    try {
      const lines = readFileSync(portFile, 'utf8').trim().split('\n');
      return lines.length >= 2 && lines[0] && lines[1] ? lines : null;
    } catch (err) {
      if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(err.code)) return null;
      throw err;
    }
  };

  let browser;
  let cdp;
  let page;
  try {
    const deadline = Date.now() + 20_000;
    let lines = readPortFile();
    while (!lines) {
      if (exited) throw new Error(`Chrome exited during startup:\n${stderr}`);
      if (Date.now() > deadline) throw new Error(`Chrome did not report a DevTools port within 20 s:\n${stderr}`);
      await sleep(50);
      lines = readPortFile();
    }
    const [port, browserPath] = lines;
    browser = await connect(`ws://127.0.0.1:${port}${browserPath}`);
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    cdp = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    page = createPage(cdp);
    await page.init();
  } catch (err) {
    cdp?.close();
    browser?.close();
    if (!exited) {
      proc.kill('SIGKILL');
      await Promise.race([exit, sleep(2000)]);
    }
    process.removeListener('exit', killOnExit);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    throw err;
  }

  return {
    page,
    async close() {
      cdp.close();
      if (!exited) {
        await browser.send('Browser.close').catch(() => {});
        await Promise.race([exit, sleep(5000)]);
        if (!exited) {
          proc.kill('SIGKILL');
          await Promise.race([exit, sleep(2000)]);
        }
      }
      browser.close();
      process.removeListener('exit', killOnExit);
      rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

function createPage(cdp) {
  const errors = [];

  const page = {
    cdp,
    errors,
    clearErrors() {
      errors.length = 0;
    },

    async init() {
      cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
        if (type === 'error' || type === 'assert') {
          errors.push(`console.${type}: ${args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
        }
      });
      cdp.on('Runtime.exceptionThrown', ({ exceptionDetails: d }) => {
        errors.push(`exception: ${d.exception?.description ?? d.text}`);
      });
      cdp.on('Log.entryAdded', ({ entry }) => {
        if (entry.level === 'error' || entry.source === 'security') errors.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ''}`);
      });
      await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Log.enable')]);
    },

    async navigate(url) {
      const loaded = cdp.once('Page.loadEventFired');
      const { errorText } = await cdp.send('Page.navigate', { url });
      if (errorText) throw new Error(`navigate ${url}: ${errorText}`);
      await Promise.race([loaded, sleep(20_000).then(() => { throw new Error(`load timeout: ${url}`); })]);
    },

    async evaluate(expression) {
      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      });
      if (exceptionDetails) throw new Error(`evaluate failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}\n  in: ${expression}`);
      return result.value;
    },

    async waitFor(check, { timeout = 15_000, interval = 50, label } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      for (;;) {
        try {
          last = typeof check === 'function' ? await check() : await page.evaluate(check);
          if (last) return last;
        } catch (err) {
          last = err.message;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out after ${timeout} ms waiting for ${label ?? check} (last: ${JSON.stringify(last)})`);
        }
        await sleep(interval);
      }
    },

    async centre(selector) {
      const box = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, width: r.width } : null;
      })()`);
      if (!box) throw new Error(`no visible element for ${selector}`);
      return box;
    },

    async mouse(type, x, y, extra = {}) {
      await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    },

    async click(selector) {
      const { x, y } = await page.centre(selector);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
      await page.mouse('mousePressed', x, y);
      await page.mouse('mouseReleased', x, y);
    },

    async drag(from, to, steps = 12) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, buttons: 0 });
      await page.mouse('mousePressed', from.x, from.y);
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await page.mouse('mouseMoved', x, y);
        await sleep(16);
      }
      await page.mouse('mouseReleased', to.x, to.y);
    },

    async type(selector, text, { enter = false, replace = true } = {}) {
      await page.click(selector);
      if (replace) await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
      await cdp.send('Input.insertText', { text });
      if (enter) {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...key });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
      }
    },

    async viewport(width, height, mobile = false) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    },

    async resetViewport() {
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    },

    async screenshot(file) {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    },
  };
  return page;
}
