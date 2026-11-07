// Synthetic UI benchmark: isolated headless browser, stub APIs, no user tabs.
// Compare the current renderer with the initial release (866d348).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const baseline = execFileSync('git', ['show', '866d348:picker.js'], { cwd: root, encoding: 'utf8' });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.includes('_favicon')) { res.writeHead(204); res.end(); return; }
  const file = path.split('/').pop();
  if (!['picker.html', 'picker.js', 'picker.css', 'search.js', 'recency.js', 'keep-tabs.js'].includes(file)) {
    res.writeHead(404); res.end(); return;
  }
  res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
  res.end(path === '/baseline/picker.js' ? baseline : await readFile(resolve(root, file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: '/usr/lib/chromium/chromium', headless: true });
  const output = {};
  for (const variant of ['baseline', 'current']) {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.addInitScript(() => {
      const tabs = Array.from({ length: 40 }, (_, id) => ({
        id: id + 1, windowId: 1, index: id, lastUsed: Date.now() - id * 60000,
        title: `ChatGPT — Архитектура расширения и асинхронная обработка вкладок ${id}`,
        url: `https://chatgpt.com/c/example-conversation-${id}`
      }));
      globalThis.chrome = { runtime: {
        getURL: path => location.origin + path,
        onMessage: { addListener() {} },
        connect() {
          const port = { onMessage: { addListener(fn) { port.receive = fn; } }, onDisconnect: { addListener() {} },
            postMessage() { setTimeout(() => port.receive({ type: 'tabs', tabs }), 0); } };
          return port;
        }
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/${variant}/picker.html`);
    await page.waitForFunction(() => document.querySelectorAll('.result').length === 40);
    output[variant] = await page.evaluate(() => {
      const input = document.querySelector('#query');
      const samples = { empty: [], chat: [] };
      function update(value) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
      for (let i = 0; i < 100; i++) {
        for (const [name, previous, value] of [['empty', 'chat', ''], ['chat', 'cha', 'chat']]) {
          update(previous);
          const start = performance.now(); update(value);
          if (i >= 20) samples[name].push(performance.now() - start);
        }
      }
      const result = {};
      for (const [name, values] of Object.entries(samples)) {
        values.sort((a, b) => a - b);
        result[name] = { median: values[Math.floor(values.length / 2)], p95: values[Math.floor(values.length * .95)] };
      }
      const titles = [...document.querySelectorAll('.title')];
      result.titleTextNodes = titles.reduce((count, title) => {
        const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) count++;
        return count;
      }, 0);
      result.rows = titles.length;
      return result;
    });
    assert.equal(output[variant].rows, 40);
    await page.close();
  }
  assert.ok(output.current.titleTextNodes < output.baseline.titleTextNodes);
  await mkdir(resolve(root, 'test-results'), { recursive: true });
  await writeFile(resolve(root, 'test-results/performance.json'), JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
} finally { await browser?.close(); server.close(); }
