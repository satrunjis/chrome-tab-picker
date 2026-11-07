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
test('the same domain match uses MRU rather than favoring short Settings URLs', () => {
  const tabs = [
    tab(1, 'Settings', 'https://chatgpt.com/#settings', null),
    tab(2, 'Settings', 'https://chatgpt.com/settings', null),
    tab(3, 'Редакторы Markdown Neovim', 'https://chatgpt.com/c/6aef080d-7680-83ed-9613-24da63b8d476', 100),
    tab(4, 'Настройка редактора', 'https://chatgpt.com/c/another-long-conversation-identifier', 50)
  ];
  const results = rankTabs(tabs, 'chat');
  assert.deepEqual(results.map(tab => tab.id), [3, 4, 1, 2]);
  assert.ok(results.every(tab => tab.score === results[0].score));
});

test('literal ChatGPT domain outranks scattered chat letters in GitHub titles', () => {
  const tabs = [
    tab(1, 'markdown-table-mode.nvim/Screenshot.gif at main · Kicamon/markdown-table-mode.nvim',
      'https://github.com/Kicamon/markdown-table-mode.nvim/blob/main/Screenshot.gif', null),
    tab(2, 'Kicamon/markdown-table-mode.nvim: A lightweight markdown format plugin like...',
      'https://github.com/Kicamon/markdown-table-mode.nvim', 200),
    tab(3, 'Редакторы Markdown Neovim', 'https://chatgpt.com/c/6aef080d-7680-83ed-9613-24da63b8d476', 100)
  ];
  assert.equal(rankTabs(tabs, 'chat')[0].id, 3);
});

test('contiguous URL matches beat scattered title matches even with a large title bonus', () => {
  const tabs = [
    tab(1, 'c h a t', 'https://example.org/', 100),
    tab(2, 'Нужный разговор', 'https://chatgpt.com/c/id', 1),
    tab(3, 'Chat notes', 'https://example.org/', 0)
  ];
  assert.deepEqual(rankTabs(tabs, 'chat').map(tab => tab.id), [3, 2, 1]);
});

test('multi-token search prefers more contiguous tokens and still accepts fuzzy abbreviations', () => {
  const tabs = [
    tab(1, 'c h a t Review', 'https://example.org/', 100),
    tab(2, 'Review', 'https://chatgpt.com/c/id', 1)
  ];
  assert.deepEqual(rankTabs(tabs, 'chat review').map(tab => tab.id), [2, 1]);
  assert.equal(rankTabs([tab(3, 'GitHub Pull Requests')], 'ghpr')[0].id, 3);
});
