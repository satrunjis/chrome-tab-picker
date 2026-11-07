import { rankTabs } from './search.js';
import { withRecency, relativeTime, domainLabel } from './recency.js';
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

function highlight(parent, text, positions) {
  // Tab titles and URLs are untrusted strings. Never interpret them as markup.
  let offset = 0;
  for (const char of text) {
    if (positions.has(offset)) {
      const mark = document.createElement('mark'); mark.textContent = char; parent.append(mark);
    } else parent.append(document.createTextNode(char));
    offset += char.length;
  }
}
function render(resetSelection = false) {
  const oldIndex = Math.max(0, results.findIndex(tab => tab.id === selectedId));
  results = rankTabs(tabs, query.value);
  if (resetSelection) selectedId = results[0]?.id;
  else if (!results.some(tab => tab.id === selectedId)) selectedId = results[Math.min(oldIndex, results.length - 1)]?.id;
  list.replaceChildren();
  status.textContent = results.length ? '' : 'Ничего не найдено';
  const fragment = document.createDocumentFragment();
  for (const tab of results) {
    const row = document.createElement('div');
    row.className = 'result'; row.id = `tab-${tab.id}`;
    row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(tab.id === selectedId));
    row.dataset.id = String(tab.id);
    row.style.setProperty('--primary', tab.primaryColor);
    row.style.setProperty('--secondary', tab.secondaryColor);
    row.style.setProperty('--recency', tab.brightness);
    const icon = document.createElement('img'); icon.alt = ''; icon.loading = 'lazy';
    const favicon = new URL(chrome.runtime.getURL('/_favicon/'));
    favicon.searchParams.set('pageUrl', tab.url); favicon.searchParams.set('size', '32');
    icon.src = favicon.href;
    const text = document.createElement('div'); text.className = 'text';
    const title = document.createElement('div'); title.className = 'title'; highlight(title, tab.title, tab.titlePositions);
    const domain = document.createElement('div'); domain.className = 'domain'; domain.textContent = domainLabel(tab.url);
    text.append(title, domain);
    const time = document.createElement('span'); time.className = 'recency';
    time.dataset.lastUsed = tab.lastUsed ?? '';
    time.textContent = relativeTime(tab.lastUsed);
    time.setAttribute('aria-label', tab.lastUsed ? `Последняя активация: ${time.textContent}` : 'Время последней активации неизвестно');
    row.append(icon, text, time); fragment.append(row);
  }
  list.append(fragment); updateSelection();
}
function updateSelection() {
  for (const row of list.children) row.setAttribute('aria-selected', String(Number(row.dataset.id) === selectedId));
  if (selectedId !== undefined) {
    query.setAttribute('aria-activedescendant', `tab-${selectedId}`);
    document.getElementById(`tab-${selectedId}`)?.scrollIntoView({ block: 'nearest' });
  } else query.removeAttribute('aria-activedescendant');
}
function send(message) {
  if (!connected) return;
  try { port.postMessage(message); } catch { status.textContent = 'Связь прервана. Закройте и откройте пикер.'; }
}
function hideLocally(restore = true) {
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
query.addEventListener('input', () => render(true));
document.addEventListener('keydown', event => {
  if (event.isComposing) return;
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

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (popup || sender.id !== chrome.runtime.id || sender.tab?.id !== hostTabId ||
      message?.token !== token || !Number.isInteger(message.revision)) return;
  if (message.revision < lastRevision) { reply({ ok: false }); return; }
  if (message.type === 'ui:show') {
    lastRevision = message.revision;
    visible = true; busy = false; query.value = ''; selectedId = undefined;
    document.documentElement.style.visibility = '';
    render(true);
    if (!connected) connect();
    reply({ ok: true });
  } else if (message.type === 'ui:hide') {
    lastRevision = message.revision;
    visible = false;
    document.documentElement.style.visibility = 'hidden';
    reply({ ok: true });
  } else if (message.type === 'ui:focus' && visible && message.revision === lastRevision) {
    query.focus();
    updateSelection();
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
      tabs = withRecency(message.tabs);
      if (visible) render();
      if (Number.isInteger(message.hostTabId)) {
        hostTabId = message.hostTabId;
        void chrome.tabs.sendMessage(hostTabId, { type: 'host:connect', token }, { frameId: 0 }).catch(() => {});
      }
    }
    else if (message.type === 'removed' && Number.isInteger(message.id)) {
      busy = false; tabs = withRecency(tabs.filter(tab => tab.id !== message.id)); if (visible) render();
    }
    else if (message.type === 'closed') { if (popup) window.close(); }
    else if (message.type === 'error') { busy = false; status.textContent = message.text; }
  });
  port.onDisconnect.addListener(() => {
    // Read lastError to avoid an unchecked runtime.lastError on worker restart.
    void chrome.runtime.lastError;
    connected = false; busy = false;
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
