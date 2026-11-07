import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRecency, relativeTime, domainLabel, domainMatchPositions } from '../recency.js';
import { rankTabs } from '../search.js';

const tab = (id, lastUsed, title = 'ChatGPT') => ({ id, lastUsed, title, url: 'https://chatgpt.com/c/private-path', windowId: 1, index: id });
test('brightness spans all tabs evenly; relevance filtering preserves assigned colors', () => {
  const tabs = withRecency([tab(1, 30, 'New'), tab(2, 20, 'Elsewhere'), tab(3, 10, 'Needle'), tab(4, null)]);
  assert.equal(tabs[0].brightness, 1);
  assert.ok(Math.abs(tabs.at(-1).brightness - 0.65) < 1e-12);
  const [result] = rankTabs(tabs, 'needle');
  assert.equal(result.primaryColor, tabs[2].primaryColor);
  assert.equal(result.secondaryColor, tabs[2].secondaryColor);
  assert.equal(result.brightness, tabs[2].brightness);
  assert.equal(withRecency([tab(1, null)])[0].brightness, 1);
});
test('unknown timestamps use a deterministic fallback and never fabricate time', () => {
  const data = [tab(3, null), tab(1, null), tab(2, 10)];
  assert.deepEqual(withRecency(data).map(t => t.id), [2, 1, 3]);
  assert.equal(relativeTime(null), '—');
  assert.equal(relativeTime(0), '—');
});
test('relative activation age is compact and handles boundaries and Russian days', () => {
  const now = 1800000000000;
  const ago = minutes => relativeTime(now - minutes * 60000, now);
  assert.equal(ago(0), 'сейчас');
  assert.equal(ago(2), '2 мин');
  assert.equal(ago(59), '59 мин');
  assert.equal(ago(60), '1 ч');
  assert.equal(ago(300), '5 ч');
  assert.equal(ago(1440), 'вчера');
  assert.equal(ago(4320), '3 дня');
  assert.equal(ago(21 * 1440), '21 день');
  assert.equal(ago(12 * 1440), '12 дней');
});
test('display domains never reveal URL paths or query strings', () => {
  assert.equal(domainLabel('https://chatgpt.com/c/secret?token=private'), 'chatgpt.com');
  assert.equal(domainLabel('chrome://settings/privacy'), 'settings');
  assert.equal(domainLabel('file:///private/document.pdf'), 'Локальный файл');
  assert.equal(domainLabel('about:blank'), 'about');
});

test('domain highlights map only matched hostname characters, excluding credentials and paths', () => {
  for (const url of ['https://chatgpt.com/c/chat', 'https://chatgpt.com@CHATGPT.com:443/c/chat']) {
    const allPositions = new Set(Array.from({ length: url.length }, (_, i) => i));
    assert.deepEqual([...domainMatchPositions(url, allPositions)], Array.from({ length: 11 }, (_, i) => i));
    const start = url.lastIndexOf('/chat') + 1;
    assert.equal(domainMatchPositions(url, new Set([start, start + 1])).size, 0);
  }
  const url = 'https://chatgpt.com/c/id';
  assert.deepEqual([...domainMatchPositions(url, new Set([8, 9, 10, 11]))], [0, 1, 2, 3]);
  assert.equal(domainMatchPositions('file:///private/path', new Set([8])).size, 0);
  assert.equal(domainMatchPositions('invalid URL', new Set([0])).size, 0);
});
