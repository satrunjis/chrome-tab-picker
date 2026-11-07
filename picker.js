import { rankTabs } from './search.js';
import { withRecency, relativeTime, domainLabel, domainMatchPositions } from './recency.js';
import { KeepCommand, planKeepTabs } from './keep-tabs.js';
const query = document.querySelector('#query');
const list = document.querySelector('#results');
const status = document.querySelector('#status');
const parameters = new URLSearchParams(location.hash.slice(1));
const token = parameters.get('token');
const popup = !token;
document.body.classList.toggle('popup', popup);
let tabs = [], results = [], selectedId, busy = false, connected = false;
let port, hostTabId;
let lastRevision = -1;
let visible = popup;
let retryTimer;
let tabsDirty = false, selectedRow;
const keepCommand = new KeepCommand();
const rows = new Map();

function highlight(parent, text, positions) {
  // Tab titles and URLs are untrusted strings. Never interpret them as markup.
  if (!positions.size) { parent.textContent = text; return; }
  let offset = 0, run = '', matched;
  function flush() {
    if (!run) return;
    if (matched) {
      const mark = document.createElement('mark'); mark.textContent = run; parent.append(mark);
    } else parent.append(document.createTextNode(run));
    run = '';
  }
  for (const char of text) {
    const next = positions.has(offset);
    if (next !== matched) { flush(); matched = next; }
    run += char;
    offset += char.length;
  }
  flush();
}
function render(resetSelection = false) {
  if (tabsDirty) {
    tabs = withRecency(tabs); tabsDirty = false;
    const live = new Set(tabs.map(tab => tab.id));
    for (const id of rows.keys()) if (!live.has(id)) rows.delete(id);
  }
  const oldIndex = Math.max(0, results.findIndex(tab => tab.id === selectedId));
  results = rankTabs(tabs, query.value);
  if (resetSelection) selectedId = results[0]?.id;
  else if (!results.some(tab => tab.id === selectedId)) selectedId = results[Math.min(oldIndex, results.length - 1)]?.id;
  status.textContent = results.length ? '' : 'Ничего не найдено';
  let cursor = list.firstChild;
  for (const tab of results) {
    let entry = rows.get(tab.id);
    if (!entry) {
      const row = document.createElement('div');
      row.className = 'result'; row.id = `tab-${tab.id}`;
      row.setAttribute('role', 'option'); row.setAttribute('aria-selected', 'false');
      row.dataset.id = String(tab.id);
      const icon = document.createElement('img'); icon.alt = ''; icon.loading = 'lazy';
      const text = document.createElement('div'); text.className = 'text';
      const title = document.createElement('div'); title.className = 'title';
      const domain = document.createElement('div'); domain.className = 'domain';
      const time = document.createElement('span'); time.className = 'recency';
      text.append(title, domain); row.append(icon, text, time);
      entry = { row, icon, title, domain, time }; rows.set(tab.id, entry);
    }
    const { row, icon, title, domain, time } = entry;
    if (entry.primary !== tab.primaryColor) {
      row.style.setProperty('--primary', tab.primaryColor);
      row.style.setProperty('--secondary', tab.secondaryColor);
      row.style.setProperty('--recency', tab.brightness);
      entry.primary = tab.primaryColor;
    }
    if (entry.url !== tab.url) {
      const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
      favicon.searchParams.set('pageUrl', tab.url); favicon.searchParams.set('size', '32');
      icon.src = favicon.href; entry.domainText = domainLabel(tab.url);
      entry.url = tab.url; entry.domainMarks = undefined;
    }
    const domainMarks = [...tab.urlPositions].join(',');
    if (entry.domainMarks !== domainMarks) {
      domain.replaceChildren(); highlight(domain, entry.domainText, domainMatchPositions(tab.url, tab.urlPositions));
      entry.domainMarks = domainMarks;
    }
    const marks = [...tab.titlePositions].join(',');
    if (entry.text !== tab.title || entry.marks !== marks) {
      title.replaceChildren(); highlight(title, tab.title, tab.titlePositions);
      entry.text = tab.title; entry.marks = marks;
    }
    time.dataset.lastUsed = tab.lastUsed ?? '';
    const label = relativeTime(tab.lastUsed);
    if (time.textContent !== label) time.textContent = label;
    time.setAttribute('aria-label', tab.lastUsed ? `Последняя активация: ${label}` : 'Время последней активации неизвестно');
    // Move only rows whose position changed; preserve favicon and text nodes.
    if (row !== cursor) list.insertBefore(row, cursor);
    cursor = row.nextSibling;
  }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  updateSelection();
}
function updateSelection() {
  selectedRow?.setAttribute('aria-selected', 'false');
  selectedRow = selectedId === undefined ? undefined : document.getElementById(`tab-${selectedId}`);
  selectedRow?.setAttribute('aria-selected', 'true');
  if (selectedId !== undefined) {
    query.setAttribute('aria-activedescendant', `tab-${selectedId}`);
    selectedRow?.scrollIntoView({ block: 'nearest' });
  } else query.removeAttribute('aria-activedescendant');
}
function send(message) {
  if (!connected) return;
  try { port.postMessage(message); } catch { status.textContent = 'Связь прервана. Закройте и откройте пикер.'; }
}
function hideLocally(restore = true) {
  keepCommand.cancel();
  visible = false;
  // Hide in this key handler; don't wait for a worker or a DOM teardown.
  document.documentElement.style.visibility = 'hidden';
  if (Number.isInteger(hostTabId)) {
    void chrome.tabs.sendMessage(hostTabId, { type: 'host:close', token, restore }, { frameId: 0 }).catch(() => {});
  } else send({ type: 'close' });
}
function close() { if (popup) window.close(); else hideLocally(); }
function select() {
  if (selectedId === undefined || busy) return;
  busy = true;
  if (!popup) hideLocally(false);
  send({ type: 'select', id: selectedId });
}
function removeSelected() {
  if (selectedId === undefined || busy) return;
  busy = true; send({ type: 'remove-tab', id: selectedId });
}
function keepFirst(count) {
  if (busy || !connected) return;
  // Capture IDs from the exact displayed ordering, including a fuzzy filter.
  const plan = planKeepTabs(tabs, results, count);
  if (!plan) return;
  busy = true;
  if (!popup && plan.scopeIds.includes(hostTabId) && !plan.keepIds.includes(hostTabId)) hideLocally(false);
  send({ type: 'keep-tabs', ...plan });
}
query.addEventListener('input', () => { keepCommand.cancel(); render(true); });
document.addEventListener('keydown', event => {
  if (!visible || event.isComposing) return;
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
      (event.code === 'KeyW' || event.key.toLowerCase() === 'w')) {
    event.preventDefault();
    if (!event.repeat && !busy && connected && results.length) keepCommand.arm();
    return;
  }
  if (keepCommand.pending) {
    if (['Alt', 'Control', 'Shift', 'Meta'].includes(event.key)) return;
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && /^[1-9]$/.test(event.key)) {
      event.preventDefault();
      if (!event.repeat && keepCommand.consume()) keepFirst(Number(event.key));
      return;
    }
    keepCommand.cancel();
    if (event.key === 'Escape') { event.preventDefault(); return; }
  }
  let delta = 0;
  if (event.key === 'ArrowDown' || (event.ctrlKey && event.key.toLowerCase() === 'n')) delta = 1;
  if (event.key === 'ArrowUp' || (event.ctrlKey && event.key.toLowerCase() === 'p')) delta = -1;
  if (delta) {
    event.preventDefault();
    if (results.length) {
      const index = results.findIndex(tab => tab.id === selectedId);
      selectedId = results[(index + delta + results.length) % results.length].id;
      updateSelection();
    }
  } else if (event.key === 'Enter') { event.preventDefault(); select(); }
  else if (event.key === 'Escape') { event.preventDefault(); close(); }
  else if (event.ctrlKey && (event.code === 'KeyW' || event.key.toLowerCase() === 'w')) { event.preventDefault(); removeSelected(); }
  else if (event.ctrlKey && event.key === 'Backspace') { event.preventDefault(); query.value = ''; render(true); }
  else if (event.key === 'Tab') { event.preventDefault(); query.focus(); }
}, true);
list.addEventListener('mousedown', event => event.preventDefault());
list.addEventListener('click', event => {
  const row = event.target.closest('.result');
  if (row) { selectedId = Number(row.dataset.id); select(); }
});
document.body.addEventListener('click', event => { if (event.target === document.body) close(); });
// The parent focuses the iframe on load. Chromium may finish that operation
// after firing its focus event, so restore the input on the next frame too.
window.addEventListener('focus', () => requestAnimationFrame(() => { if (visible) query.focus(); }));
window.addEventListener('blur', () => keepCommand.cancel());

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (popup || sender.id !== chrome.runtime.id || sender.tab?.id !== hostTabId ||
      message?.token !== token || !Number.isInteger(message.revision)) return;
  if (message.revision < lastRevision) { reply({ ok: false }); return; }
  if (message.type === 'ui:show') {
    keepCommand.cancel();
    lastRevision = message.revision;
    visible = true; busy = false; query.value = ''; selectedId = undefined;
    document.documentElement.style.visibility = '';
    render(true);
    if (!connected) connect();
    reply({ ok: true });
  } else if (message.type === 'ui:hide') {
    keepCommand.cancel();
    lastRevision = message.revision;
    visible = false;
    document.documentElement.style.visibility = 'hidden';
    reply({ ok: true });
  } else if (message.type === 'ui:focus' && visible && message.revision === lastRevision) {
    query.focus();
    requestAnimationFrame(() => { if (visible) query.focus(); });
    reply({ ok: true });
  }
});

function connect() {
  clearTimeout(retryTimer);
  port = chrome.runtime.connect({ name: 'picker:v1' });
  connected = true;
  port.onMessage.addListener(message => {
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'tabs' && Array.isArray(message.tabs)) {
      tabs = message.tabs; tabsDirty = true;
      if (visible) render();
      if (Number.isInteger(message.hostTabId)) {
        hostTabId = message.hostTabId;
        void chrome.tabs.sendMessage(hostTabId, { type: 'host:connect', token }, { frameId: 0 }).catch(() => {});
      }
    }
    else if (message.type === 'removed' && Number.isInteger(message.id)) {
      busy = false; tabs = tabs.filter(tab => tab.id !== message.id); tabsDirty = true; if (visible) render();
    }
    else if (message.type === 'kept' && Array.isArray(message.tabs)) {
      busy = false; tabs = message.tabs; tabsDirty = true; if (visible) render();
    }
    else if (message.type === 'closed') { if (popup) window.close(); }
    else if (message.type === 'error') { busy = false; status.textContent = message.text; }
  });
  port.onDisconnect.addListener(() => {
    // Read lastError to avoid an unchecked runtime.lastError on worker restart.
    void chrome.runtime.lastError;
    connected = false; busy = false;
    keepCommand.cancel();
    status.textContent = 'Связь прервана. Переподключение…';
    retryTimer = setTimeout(() => { if (visible && document.visibilityState !== 'hidden') connect(); }, 300);
  });
  port.postMessage({ type: 'hello', token });
}
connect();
if (visible) query.focus();
// Refresh labels only: no reordering or focus changes while typing.
setInterval(() => {
  if (!visible) return;
  for (const time of list.querySelectorAll('.recency')) {
    const stamp = Number(time.dataset.lastUsed) || null;
    time.textContent = relativeTime(stamp);
    time.setAttribute('aria-label', stamp ? `Последняя активация: ${time.textContent}` : 'Время последней активации неизвестно');
  }
}, 30000);
