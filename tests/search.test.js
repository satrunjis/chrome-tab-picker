import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyMatch, rankTabs } from '../search.js';

const tab = (id, title, url = 'https://example.org/', lastUsed = id) => ({ id, title, url, lastUsed, windowId: 1, index: id });
test('MRU order and duplicate titles retain distinct tab IDs', () => {
  assert.deepEqual(rankTabs([tab(1, 'Same'), tab(2, 'Same')], '').map(t => t.id), [2, 1]);
});
test('subsequence search supports case, Cyrillic, Unicode offsets and no matches', () => {
  assert.ok(fuzzyMatch('GitHub Pull Requests', 'ghpr'));
  assert.ok(fuzzyMatch('Привет мир', 'ПМ'));
  assert.deepEqual(fuzzyMatch('😀 alpha', 'a').positions, [3]);
  assert.equal(fuzzyMatch('abc', 'ca'), null);
});
test('consecutive matches outrank scattered matches', () => {
  assert.ok(fuzzyMatch('test', 'test').score > fuzzyMatch('t e s t', 'test').score);
});
test('every query token must match title or URL', () => {
  const tabs = [tab(1, 'Review', 'https://github.com/pull/42'), tab(2, 'Review', 'https://example.org')];
  assert.deepEqual(rankTabs(tabs, 'review gh').map(t => t.id), [1]);
  assert.equal(rankTabs(tabs, 'missing').length, 0);
});
test('matching an empty query does not highlight anything', () => {
  const [result] = rankTabs([tab(1, 'Something')], '  ');
  assert.equal(result.titlePositions.size, 0);
});
test('a chat title outranks a shared ChatGPT domain even when it is older', () => {
  const tabs = [tab(1, 'Other conversation', 'https://chatgpt.com/c/new', 100),
    tab(2, 'Архитектура ChatGPT и Codex', 'https://example.org', 1)];
  assert.deepEqual(rankTabs(tabs, 'chatgpt').map(t => t.id), [2, 1]);
});
test('equal relevance uses MRU, then stable ID/position ordering', () => {
  const tabs = [tab(3, 'Same', 'https://example.org', 1), tab(1, 'Same', 'https://example.org', 1), tab(2, 'Same', 'https://example.org', 5)];
  assert.deepEqual(rankTabs(tabs, 'same').map(t => t.id), [2, 1, 3]);
});
