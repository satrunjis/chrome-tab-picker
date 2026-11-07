// Isolated profile only. Never connects to or modifies the user's Chromium.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'tab-picker-test-'));
await mkdir(join(root, 'test-results'), { recursive: true });
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>Fixture ${req.url}</title><style>body{background:#f4f4f4} iframe{opacity:.01} *{font-family:serif}</style><input id="previous" value="Keep focus"><button id="page-action" onclick="this.dataset.clicks=String(+(this.dataset.clicks||0)+1)">Click page</button><h1>Host page</h1>`);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
const errors = [];
const timings = { opens: [], closes: [] };
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || '/usr/lib/chromium/chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    headless: false,
    viewport: { width: 1100, height: 900 },
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-first-run', '--no-default-browser-check']
  });
  context.setDefaultTimeout(10000);
  context.on('weberror', error => errors.push(error.error().message));
  context.on('console', message => {
    if (message.type() === 'error' && message.location().url.startsWith('chrome-extension://')) errors.push(message.text());
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  console.log('Extension service worker loaded');
  worker.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const home = await context.newPage();
  await home.goto(`${base}/home`);
  await home.locator('#previous').focus();
  const tabs = await worker.evaluate(async base => {
    const result = [];
    for (let i = 0; i < 34; i++) result.push(await chrome.tabs.create({ url: `${base}/tab-${i}`, active: false }));
    const other = await chrome.windows.create({ url: `${base}/other-window`, focused: false });
    return { ids: result.map(tab => tab.id), otherId: other.tabs[0].id, otherWindow: other.id };
  }, base);
  const homeId = await worker.evaluate(async base => (await chrome.tabs.query({})).find(tab => tab.url === `${base}/home`).id, base);
  async function focusTarget(target) {
    await target.bringToFront();
    const windows = JSON.parse(execFileSync('hyprctl', ['clients', '-j'], { encoding: 'utf8' }));
    const title = await target.title();
    const hostWindow = windows.find(window => window.title.startsWith(title));
    assert.ok(hostWindow, 'test host window must be mapped');
    execFileSync('hyprctl', ['eval', `hl.dispatch(hl.dsp.focus({window="address:${hostWindow.address}"}))`]);
    await new Promise(r => setTimeout(r, 150));
  }
  async function open(target = home, targetId = homeId) {
    await worker.evaluate(async id => {
      await chrome.tabs.update(id, { active: true });
      await chrome.windows.update((await chrome.tabs.get(id)).windowId, { focused: true });
    }, targetId);
    await focusTarget(target);
    const webPage = /^https?:/.test(target.url());
    if (webPage) await startToggleTiming(target, true);
    await systemKey('ALT', 'q');
    if (webPage) {
      await target.waitForFunction(() => !!document.querySelector(':popover-open'));
      const picker = target.frames().find(frame => frame.url().includes('/picker.html#token='));
      await picker.waitForFunction(() => document.activeElement.id === 'query' && document.documentElement.style.visibility !== 'hidden');
      timings.opens.push(await target.evaluate(() => globalThis.testToggleTiming));
    }
  }
  async function startToggleTiming(target, expected) {
    await target.evaluate(expected => {
      const start = performance.now();
      globalThis.testToggleTiming = new Promise(resolve => {
        function observe() {
          if (!!document.querySelector(':popover-open') === expected) resolve(performance.now() - start);
          else requestAnimationFrame(observe);
        }
        requestAnimationFrame(observe);
      });
    }, expected);
  }
  async function systemKey(mods, key) {
    // Physical XKB keycodes work even when the desktop layout is Cyrillic.
    key = { q: 'code:24', w: 'code:25' }[key] ?? key;
    execFileSync('hyprctl', ['eval', `hl.dispatch(hl.dsp.send_key_state({mods="${mods}",key="${key}",state="down"}))`]);
    await new Promise(r => setTimeout(r, 50));
    execFileSync('hyprctl', ['eval', `hl.dispatch(hl.dsp.send_key_state({mods="${mods}",key="${key}",state="up"}))`]);
  }
  async function waitForActivation(id) {
    return worker.evaluate(async id => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const tab = await chrome.tabs.get(id);
        const window = await chrome.windows.get(tab.windowId);
        if (tab.active && window.focused) return { tab, window };
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Selected tab/window did not become active');
    }, id);
  }
  async function assertPageClickable(page) {
    const target = page.locator('#page-action');
    assert.equal(await target.evaluate(element => {
      const box = element.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === element;
    }), true, 'hidden picker must not intercept hit testing on the host page');
    const before = Number(await target.getAttribute('data-clicks') || 0);
    await target.click();
    assert.equal(Number(await target.getAttribute('data-clicks')), before + 1, 'host page must receive actual clicks after hiding');
    await page.locator('#previous').focus();
  }
  await open();
  const frame = () => home.frames().find(f => f.url().includes('/picker.html#token='));
  await home.waitForFunction(() => document.activeElement?.hasAttribute('popover') || document.activeElement?.tagName === 'DIV');
  for (let i = 0; i < 60 && !frame(); i++) await new Promise(r => setTimeout(r, 100));
  assert.ok(frame(), 'command must inject the iframe');
  const ui = frame();
  const instance = await ui.evaluate(() => { globalThis.testInstance = crypto.randomUUID(); return globalThis.testInstance; });
  await ui.locator('.result').first().waitFor();
  await ui.waitForFunction(() => document.activeElement.id === 'query');
  assert.ok(await ui.locator('.result').count() >= 36);
  assert.equal(await ui.evaluate(() => document.activeElement.id), 'query');
  assert.equal(await ui.locator('#picker').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(24, 24, 24)');
  assert.equal(await ui.locator('#picker').evaluate(el => el.getBoundingClientRect().width), 760);
  assert.equal(await ui.locator('#results').evaluate(el => el.clientHeight), 600);
  assert.equal(await ui.locator('footer, #count, .prompt, .location, .url').count(), 0);
  assert.equal(await ui.locator('#query').inputValue(), '');
  assert.equal(await ui.locator('.domain').first().textContent(), '127.0.0.1');
  assert.ok(await ui.locator('.recency').filter({ hasText: '—' }).count() > 0);
  const allColors = await ui.locator('.result').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.id, row.style.getPropertyValue('--primary')])));
  const allIconFilters = await ui.locator('.result').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.dataset.id, getComputedStyle(row.querySelector('img')).filter])));
  // All results stay reachable with a hidden scrollbar, through both keyboard
  // navigation and a real wheel event inside the scrolling list.
  await home.keyboard.press('ArrowUp');
  const list = ui.locator('#results');
  const lastRow = ui.locator('.result').last();
  assert.equal(await lastRow.getAttribute('aria-selected'), 'true');
  assert.ok(await lastRow.evaluate(el => el.getBoundingClientRect().bottom <= el.parentElement.getBoundingClientRect().bottom + 1));
  const scrollBefore = await list.evaluate(el => el.scrollTop);
  assert.ok(scrollBefore > 0);
  const box = await list.boundingBox();
  // Keep the pointer in the native visible part of a tiled test window, even
  // when Playwright emulates a viewport larger than that window's surface.
  await home.mouse.move(box.x + 40, box.y + 25);
  await home.mouse.wheel(0, -300);
  await ui.waitForFunction(before => document.querySelector('#results').scrollTop < before, scrollBefore);
  await home.keyboard.press('ArrowDown');
  assert.equal(await list.evaluate(el => el.scrollTop), 0);
  const panelTop = await ui.locator('#picker').evaluate(el => el.getBoundingClientRect().top);
  await ui.locator('#query').fill('tab-2');
  assert.ok(await ui.locator('mark').count() > 0);
  const initial = await ui.locator('[aria-selected="true"]').getAttribute('data-id');
  await home.keyboard.press('Control+n');
  assert.notEqual(await ui.locator('[aria-selected="true"]').getAttribute('data-id'), initial);
  await home.keyboard.press('Control+p');
  assert.equal(await ui.locator('[aria-selected="true"]').getAttribute('data-id'), initial);
  await ui.locator('#query').fill('tab-33');
  const filteredRow = ui.locator('.result').first();
  assert.equal(await filteredRow.evaluate(el => el.style.getPropertyValue('--primary')), allColors[await filteredRow.getAttribute('data-id')]);
  assert.equal(await filteredRow.locator('img').evaluate(el => getComputedStyle(el).filter), allIconFilters[await filteredRow.getAttribute('data-id')]);
  assert.equal(await ui.locator('#picker').evaluate(el => el.getBoundingClientRect().top), panelTop);
  await home.keyboard.press('Control+a');
  assert.equal(await ui.locator('#query').evaluate(el => el.selectionEnd - el.selectionStart), 6);
  // Filter updates reset selection to the first result.
  await ui.locator('#query').fill('tab');
  assert.equal(await ui.locator('[aria-selected="true"]').getAttribute('data-id'), await ui.locator('.result').first().getAttribute('data-id'));
  await ui.locator('#query').fill('nothing-will-match-xyz');
  assert.equal(await ui.locator('.result').count(), 0);
  await home.keyboard.press('Control+Backspace');
  assert.equal(await ui.locator('#query').inputValue(), '');
  const stable = await ui.locator('[aria-selected="true"]').getAttribute('data-id');
  await worker.evaluate(async base => chrome.tabs.create({ url: `${base}/new-live`, active: false }), base);
  await ui.locator('.title', { hasText: 'new-live' }).waitFor();
  assert.equal(await ui.locator('[aria-selected="true"]').getAttribute('data-id'), stable);
  // Removing a highlighted tab must select a surviving row, never a stale ID.
  await ui.locator('#query').fill('tab-33');
  await ui.locator('.result').first().waitFor();
  const removed = Number(await ui.locator('[aria-selected="true"]').getAttribute('data-id'));
  // Native Ctrl+Alt+W reaches the iframe on Linux; plain Ctrl+W is reserved.
  await focusTarget(home);
  await ui.locator('#query').focus();
  await systemKey('CTRL ALT', 'w');
  await ui.locator('#status').filter({ hasText: 'Ничего не найдено' }).waitFor();
  assert.equal(await worker.evaluate(async id => (await chrome.tabs.query({})).some(tab => tab.id === id), removed), false);
  assert.equal(await worker.evaluate(async id => (await chrome.storage.session.get('mru')).mru?.[id] ?? null, removed), null);
  await home.keyboard.press('Control+Backspace');
  assert.notEqual(await ui.locator('[aria-selected="true"]').getAttribute('data-id'), String(removed));
  await home.screenshot({ path: join(root, 'test-results/overlay.png') });
  await ui.locator('#query').fill('tab-2');
  await startToggleTiming(home, false);
  await home.keyboard.press('Escape');
  await home.waitForFunction(() => !document.querySelector(':popover-open'));
  timings.closes.push(await home.evaluate(() => globalThis.testToggleTiming));
  await home.waitForFunction(() => document.activeElement?.id === 'previous');
  await assertPageClickable(home);
  assert.equal(home.frames().length, 2);
  await ui.evaluate(() => {
    globalThis.hiddenMutations = 0;
    new MutationObserver(() => globalThis.hiddenMutations++).observe(document.querySelector('#results'), { childList: true, subtree: true });
  });
  await worker.evaluate(base => chrome.tabs.create({ url: `${base}/cached-while-hidden`, active: false }), base);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await ui.evaluate(() => globalThis.hiddenMutations), 0, 'hidden UI must cache updates without rebuilding its DOM');
  // A narrow, short viewport must keep the input and scroll its list.
  await home.setViewportSize({ width: 360, height: 420 });
  await open();
  for (let i = 0; i < 60 && !frame(); i++) await new Promise(r => setTimeout(r, 100));
  await frame().locator('.result').first().waitFor();
  assert.equal(await frame().evaluate(() => globalThis.testInstance), instance, 'warm reopening must retain the same iframe document');
  assert.equal(await frame().locator('#query').inputValue(), '');
  assert.equal(await frame().locator('.title').filter({ hasText: 'cached-while-hidden' }).count(), 1, 'warm display must include tabs added while hidden');
  assert.ok(await frame().locator('#picker').evaluate(el => el.getBoundingClientRect().width) <= 344);
  assert.ok(await frame().locator('#picker').evaluate(el => el.getBoundingClientRect().bottom) <= 420);
  await focusTarget(home);
  await systemKey('ALT', 'q');
  await home.waitForFunction(() => !document.querySelector(':popover-open'));
  await home.waitForFunction(() => document.activeElement?.id === 'previous');
  assert.equal(home.frames().length, 2, 'toggle must retain exactly one reusable iframe');
  await assertPageClickable(home);
  await home.setViewportSize({ width: 1100, height: 900 });
  await home.evaluate(() => {
    globalThis.pickerAtVisibilityChange = [];
    document.addEventListener('visibilitychange', () => {
      globalThis.pickerAtVisibilityChange.push({ hidden: document.hidden, overlay: !!document.querySelector(':popover-open') });
    });
  });
  await open();
  for (let i = 0; i < 60 && !frame(); i++) await new Promise(r => setTimeout(r, 100));
  await frame().locator('#query').fill('other-window');
  await frame().locator('.result').first().waitFor();
  await home.keyboard.press('Enter');
  await home.waitForFunction(() => !document.querySelector(':popover-open'));
  const active = await waitForActivation(tabs.otherId);
  assert.equal(active.tab.active, true);
  assert.equal(active.window.focused, true);
  assert.equal(home.frames().length, 2);
  assert.equal(await home.evaluate(() => globalThis.pickerAtVisibilityChange.some(event => event.hidden && event.overlay)), false,
    'the source must have no overlay when it becomes hidden');
  // User regression: A -> B with the picker, then B -> A with another picker.
  const otherPage = context.pages().find(page => page.url() === `${base}/other-window`);
  await otherPage.evaluate(() => {
    globalThis.pickerAtVisibilityChange = [];
    document.addEventListener('visibilitychange', () => {
      globalThis.pickerAtVisibilityChange.push({ hidden: document.hidden, overlay: !!document.querySelector(':popover-open') });
    });
  });
  await open(otherPage, tabs.otherId);
  // The iframe is in a closed shadow root; access its extension frame directly.
  for (let i = 0; i < 60 && otherPage.frames().length < 2; i++) await new Promise(r => setTimeout(r, 100));
  const otherPicker = otherPage.frames().find(frame => frame.url().includes('/picker.html#token='));
  await otherPicker.locator('#query').fill('Fixture /home');
  await otherPicker.locator('.result').first().waitFor();
  await otherPage.keyboard.press('Enter');
  await waitForActivation(homeId);
  await home.waitForFunction(() => !document.hidden);
  assert.equal(await home.locator(':popover-open').count(), 0, 'returning to A must not reveal its previous picker');
  await assertPageClickable(home);
  assert.equal(await otherPage.evaluate(() => globalThis.pickerAtVisibilityChange.some(event => event.hidden && event.overlay)), false,
    'B must also be painted without the picker before it becomes hidden');
  const sameWindowPage = context.pages().find(page => page.url() === `${base}/tab-0`);
  await open();
  for (let i = 0; i < 60 && !frame(); i++) await new Promise(r => setTimeout(r, 100));
  await frame().locator('#query').fill('Fixture /tab-0');
  await frame().locator('.result').first().waitFor();
  await home.keyboard.press('Enter');
  await waitForActivation(tabs.ids[0]);
  await sameWindowPage.waitForFunction(() => !document.hidden);
  await open(sameWindowPage, tabs.ids[0]);
  for (let i = 0; i < 60 && sameWindowPage.frames().length < 2; i++) await new Promise(r => setTimeout(r, 100));
  const sameWindowPicker = sameWindowPage.frames().find(frame => frame.url().includes('/picker.html#token='));
  await sameWindowPicker.locator('#query').fill('Fixture /home');
  await sameWindowPicker.locator('.result').first().waitFor();
  await sameWindowPage.keyboard.press('Enter');
  await waitForActivation(homeId);
  await home.waitForFunction(() => !document.hidden);
  assert.equal(await home.locator(':popover-open').count(), 0, 'same-window round trip must not reveal a cached picker');
  await assertPageClickable(home);
  assert.equal(await home.evaluate(() => globalThis.pickerAtVisibilityChange.some(event => event.hidden && event.overlay)), false);
  assert.equal((await worker.evaluate(() => chrome.windows.getAll())).length, 2, 'picker must never create windows');
  // Probe real Ctrl+W in a disposable host. Synthetic CDP keys bypass browser
  // accelerators and would incorrectly claim that this shortcut is supported.
  const probe = await context.newPage();
  await probe.goto(`${base}/native-key-probe`);
  const probeId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, probe.url());
  await open(probe, probeId);
  for (let i = 0; i < 60 && probe.frames().length < 2; i++) await new Promise(r => setTimeout(r, 100));
  const probeUI = probe.frames().find(f => f.url().includes('/picker.html#token='));
  await probeUI.locator('#query').fill('tab-32');
  await probeUI.locator('.result').first().waitFor();
  const selectedBeforeNativeClose = Number(await probeUI.locator('.result').first().getAttribute('data-id'));
  await focusTarget(probe);
  await probeUI.locator('#query').focus();
  await systemKey('CTRL', 'w');
  await new Promise(r => setTimeout(r, 250));
  const nativeCtrlWReserved = probe.isClosed();
  if (nativeCtrlWReserved) {
    assert.equal(await worker.evaluate(async id => (await chrome.tabs.query({})).some(tab => tab.id === id), selectedBeforeNativeClose), true);
    console.log('CONFIRMED: native Ctrl+W closes the host browser tab; Ctrl+Alt+W closes the selected result');
  } else {
    await probeUI.locator('#status').filter({ hasText: 'Ничего не найдено' }).waitFor();
    await probe.close();
  }
  // Native popup fallback on a restricted page: no extra browser window/tab.
  await home.goto('chrome://version');
  await open();
  await worker.evaluate(async () => {
    for (let i = 0; i < 40; i++) {
      if ((await chrome.runtime.getContexts({ contextTypes: ['POPUP'] })).length) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('Restricted-page command did not open the toolbar popup');
  });
  assert.equal((await worker.evaluate(() => chrome.windows.getAll())).length, 2);
  // Public sites are optional because network/challenges are outside the test fixture.
  if (process.env.LIVE_SITES === '1') {
    for (const site of ['https://github.com/fwextensions/QuicKey', 'https://chatgpt.com/']) {
      await home.goto(site, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await open();
      for (let i = 0; i < 60 && !frame(); i++) await new Promise(r => setTimeout(r, 100));
      assert.ok(frame(), `iframe on ${site}`);
      await frame().locator('.result').first().waitFor();
      await frame().waitForFunction(() => document.activeElement.id === 'query');
      assert.equal(await frame().evaluate(() => document.activeElement.id), 'query');
      await home.keyboard.press('Escape');
      console.log(`PASS public site: ${site} (${await home.title()})`);
    }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(root, 'test-results/results.json'), JSON.stringify({ passed: true, nativeCtrlWReserved, timings, errors, tabCount: await worker.evaluate(async () => (await chrome.tabs.query({})).length) }, null, 2));
  console.log('Open/close timings (ms):', JSON.stringify(timings));
  console.log('PASS: retained iframe, warm reopening, immediate close, 30+ tabs, windows, shortcut, iframe focus/isolation, fuzzy highlights, navigation, live updates/removal, Escape restoration, toggle, narrow viewport, activation, restricted-page popup, no extra windows/errors');
} catch (error) {
  console.log('Fixture frame URLs:', context?.pages().flatMap(page => page.frames().map(frame => frame.url())));
  console.log('Extension errors:', errors);
  const host = context?.pages().find(page => page.url() === `${base}/home`);
  await host?.screenshot({ path: join(root, 'test-results/failure.png') }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
