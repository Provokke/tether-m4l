import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTetherServer } from '../server/src/server.js';
import { createSimDevice } from '../server/sim-device.js';
import { findChrome, launchChrome } from './helpers/cdp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'dist', 'e2e');
const TOKEN = 'e2e-token';
const chromeBin = findChrome();
const required = process.env.REQUIRE_CHROME === '1';

if (!chromeBin && required) {
  it('Chrome is available (REQUIRE_CHROME=1)', () => {
    assert.fail('REQUIRE_CHROME=1 but no Chrome was found; set CHROME_BIN');
  });
}

describe('dashboard in a real browser', { skip: chromeBin ? false : 'Chrome not found (set CHROME_BIN, or REQUIRE_CHROME=1 to fail instead)', timeout: 180_000 }, () => {
  let server;
  let sim;
  let chrome;
  let page;
  const fired = [];
  const simState = () => sim.bridge.state;

  const newestLog = (name) => page.evaluate(`(() => {
    for (const li of document.querySelectorAll('#log li')) {
      const text = li.children[1].textContent;
      if (text.startsWith(${JSON.stringify(name)} + ' ')) return { text, status: li.querySelector('.st').dataset.s };
    }
    return null;
  })()`);
  const logReaches = (name, status) => page.waitFor(async () => (await newestLog(name))?.status === status, { label: `${name} → ${status}` });

  const assertNoBrowserErrors = (ignore = []) => {
    const unexpected = page.errors.filter((e) => !ignore.some((re) => re.test(e)));
    assert.deepEqual(unexpected, [], 'browser console errors, exceptions or CSP violations');
  };

  before(async () => {
    server = await createTetherServer({ token: TOKEN, publicDir: path.join(root, 'server', 'public') });
    sim = createSimDevice({
      url: `ws://127.0.0.1:${server.port}/device`,
      token: TOKEN,
      deviceId: 'e2e-sim',
      log: (line) => {
        const m = /^fired clip (\d+):(\d+)$/.exec(line);
        if (m) fired.push([Number(m[1]), Number(m[2])]);
      },
    });
    chrome = await launchChrome({ bin: chromeBin });
    page = chrome.page;
  });

  after(async () => {
    await chrome?.close();
    sim?.stop();
    await server?.close();
  });

  it('loads and shows the connected Set', async () => {
    await page.navigate(`http://127.0.0.1:${server.port}/#token=${TOKEN}`);
    await page.waitFor(`!document.getElementById('app').hidden && document.getElementById('track-name').textContent === 'Drums'`, { label: 'app with Set state' });
    assert.equal(await page.evaluate(`document.getElementById('link').dataset.state`), 'online');
    assert.equal(await page.evaluate(`document.getElementById('set-size').textContent`), '6 tracks · 8 scenes');
    assert.equal(await page.evaluate(`document.querySelectorAll('.clip').length`), 48);
    assertNoBrowserErrors();
  });

  it('Play (mouse click) starts the Set and the position advances', async () => {
    await page.click('#play');
    await page.waitFor(() => simState().playing === true, { label: 'sim playing' });
    const first = await page.waitFor(`(() => { const p = document.getElementById('position').textContent; return p !== '1.1.1' && p; })()`, { label: 'position moves' });
    await page.waitFor(`document.getElementById('position').textContent !== ${JSON.stringify(first)}`, { label: 'position keeps advancing' });
    await logReaches('transport.play', 'applied');
    assert.equal(await page.evaluate(`document.getElementById('play').classList.contains('active')`), true);
  });

  it('typing a tempo and pressing Enter sets it', async () => {
    await page.type('#tempo', '140', { enter: true });
    await page.waitFor(() => simState().tempo === 140, { label: 'sim tempo 140' });
    await logReaches('tempo.set', 'applied');
    await page.waitFor(`document.getElementById('tempo').value === '140.00'`, { label: 'tempo field shows 140.00' });
  });

  it('the + nudge raises the tempo by one', async () => {
    await page.click('[data-nudge="1"]');
    await page.waitFor(() => simState().tempo === 141, { label: 'sim tempo 141' });
    await logReaches('tempo.set', 'applied');
    await page.waitFor(`document.getElementById('tempo').value === '141.00'`, { label: 'tempo field shows 141.00' });
  });

  it('dragging the volume slider sets the selected track volume', async () => {
    const box = await page.centre('#volume');
    const thumb = { x: box.left + box.width * 0.85, y: box.y };
    const target = { x: box.left + box.width * 0.4, y: box.y };
    await page.drag(thumb, target);
    const value = Number(await page.evaluate(`document.getElementById('volume').value`));
    assert.ok(value > 0.3 && value < 0.5, `slider ended at ${value}`);
    await page.waitFor(() => Math.abs(simState()['track.volume'] - value) < 0.0005, { label: `sim volume ${value}` });
    await logReaches('track.volume', 'applied');
    assert.equal(await page.evaluate(`document.getElementById('volume-out').textContent`), value.toFixed(2));
  });

  it('clicking a track header selects that track', async () => {
    await page.click('.col-head[data-track="3"]');
    await page.waitFor(() => simState()['track.index'] === 3, { label: 'sim track 3 selected' });
    await page.waitFor(`document.getElementById('track-name').textContent === 'Lead' && document.getElementById('track-index').textContent === '#4'`, { label: 'track card shows Lead #4' });
    await logReaches('track.select', 'applied');
    assert.equal(await page.evaluate(`document.querySelector('.col-head[data-track="3"]').classList.contains('selected')`), true);
  });

  it('firing a clip reaches the device', async () => {
    await page.click('[aria-label="Fire clip on track 2, scene 3"]');
    await page.waitFor(() => fired.some(([t, s]) => t === 1 && s === 2), { label: 'sim fired clip 1:2' });
    await logReaches('clip.fire', 'dispatched');
    await page.screenshot(path.join(shots, 'dashboard.png'));
    assertNoBrowserErrors();
  });

  it('fits a 400 px phone viewport without horizontal page scroll', async () => {
    await page.viewport(400, 900, true);
    try {
      await page.waitFor(`window.innerWidth === 400`, { label: 'viewport 400' });
      const width = await page.evaluate(`document.documentElement.scrollWidth`);
      assert.ok(width <= 400, `page is ${width} px wide at a 400 px viewport`);
      await page.screenshot(path.join(shots, 'dashboard-phone.png'));
    } finally {
      await page.resetViewport();
    }
  });

  it('shows the empty state when the device goes away', async () => {
    sim.stop();
    await page.waitFor(`!document.getElementById('empty').hidden && document.getElementById('app').hidden`, { label: 'empty state' });
    assert.match(await page.evaluate(`document.querySelector('#empty h1').textContent`), /No device connected/);
    await page.screenshot(path.join(shots, 'empty.png'));
    assertNoBrowserErrors();
  });

  it('a wrong token brings up the token form', async () => {
    await page.navigate('about:blank');
    page.clearErrors();
    await page.navigate(`http://127.0.0.1:${server.port}/#token=wrong`);
    await page.waitFor(`!document.getElementById('token-form').hidden`, { label: 'token form' });
    assert.equal(await page.evaluate(`document.getElementById('link').dataset.state`), 'offline');
    await page.screenshot(path.join(shots, 'token-form.png'));
    assertNoBrowserErrors([/WebSocket connection to .* failed/]);
  });
});
