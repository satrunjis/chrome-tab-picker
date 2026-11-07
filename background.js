const clients = new Set();
const locks = new Set();
let mru = {};
const ready = chrome.storage.session.get('mru').then(data => { mru = data.mru || {}; });
let clock = Date.now();
let saveQueue = Promise.resolve();
function persistMRU() {
  saveQueue = saveQueue.then(() => chrome.storage.session.set({ mru: { ...mru } })).catch(console.error);
}
async function touch(id) {
  await ready;
  clock = Math.max(Date.now(), clock + 1);
  mru[id] = clock;
  persistMRU();
  broadcast();
}
async function snapshot() {
  await ready;
  return (await chrome.tabs.query({})).map(tab => ({
    id: tab.id, windowId: tab.windowId, index: tab.index,
    title: tab.title || tab.pendingUrl || tab.url || 'Untitled',
    url: tab.url || tab.pendingUrl || '',
    // Unknown history must not masquerade as an observed activation timestamp.
    lastUsed: Number.isFinite(mru[tab.id]) && mru[tab.id] > 0 ? mru[tab.id] : null
  }));
}
async function hostMessage(client, type, restore = true) {
  if (client.tabId === undefined) return;
  await chrome.tabs.sendMessage(client.tabId, { type, token: client.token, restore }, { frameId: 0 }).catch(() => {});
}
let broadcastTimer;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    try {
      const tabs = await snapshot();
      for (const client of clients) {
        try { client.port.postMessage({ type: 'tabs', tabs }); } catch { clients.delete(client); }
      }
    } catch (error) { console.error(error); }
  }, 40);
}
chrome.tabs.onActivated.addListener(({ tabId }) => { void touch(tabId); });
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId < 0) return;
  chrome.tabs.query({ windowId, active: true }).then(tabs => {
    if (tabs[0]) void touch(tabs[0].id);
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener(id => {
  ready.then(() => { delete mru[id]; persistMRU(); });
  chrome.storage.session.remove(`overlay:${id}`).catch(console.error);
  broadcast();
});
chrome.tabs.onCreated.addListener(broadcast);
chrome.tabs.onUpdated.addListener(broadcast);
chrome.tabs.onMoved.addListener(broadcast);
chrome.tabs.onAttached.addListener(broadcast);
chrome.tabs.onDetached.addListener(broadcast);
chrome.tabs.onReplaced.addListener((added, removed) => {
  ready.then(() => {
    if (mru[removed]) mru[added] = mru[removed];
    delete mru[removed]; persistMRU(); broadcast();
  });
});

async function openPicker(tab) {
  if (!tab?.id || locks.has(tab.id)) return;
  locks.add(tab.id);
  try {
    // Warm path: no script injection, storage read, iframe load or parsing.
    const mounted = await chrome.tabs.sendMessage(tab.id, { type: 'host:toggle' }, { frameId: 0 }).catch(() => null);
    if (mounted?.mounted) return;
    // Executing a command grants activeTab. No persistent host permissions.
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    const token = crypto.randomUUID();
    await chrome.storage.session.set({ [`overlay:${tab.id}`]: token });
    await chrome.tabs.sendMessage(tab.id, { type: 'host:show', token }, { frameId: 0 });
  } catch {
    // Internal pages, store pages, PDF viewer, or an unavailable document.
    try { await chrome.action.openPopup({ windowId: tab.windowId }); }
    catch { /* The toolbar button remains available if the window lost focus. */ }
  } finally { locks.delete(tab.id); }
}
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'open-picker') void (tab ? openPicker(tab) : chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => openPicker(active)));
});

chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  // Only our packaged picker document may read tabs or activate them.
  // Dynamic web-accessible URLs may have a different hostname, but the runtime
  // supplies sender.id and the privileged chrome-extension scheme.
  let url;
  try { url = new URL(sender?.url); } catch { port.disconnect(); return; }
  if (port.name !== 'picker:v1' || sender.id !== chrome.runtime.id ||
      url.protocol !== 'chrome-extension:' || url.pathname !== '/picker.html') { port.disconnect(); return; }
  let client;
  let queue = Promise.resolve();
  port.onMessage.addListener(message => {
    queue = queue.then(async () => {
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'hello' && !client) {
        const tabId = sender.tab?.id;
        if (tabId !== undefined) {
          const data = await chrome.storage.session.get(`overlay:${tabId}`);
          if (typeof message.token !== 'string' || data[`overlay:${tabId}`] !== message.token) { port.disconnect(); return; }
        } else if (sender.frameId > 0 || message.token) { port.disconnect(); return; }
        client = { port, tabId, token: message.token };
        clients.add(client);
        port.postMessage({ type: 'tabs', tabs: await snapshot(), hostTabId: tabId ?? null });
      } else if (client && message.type === 'close') {
        await hostMessage(client, 'host:close');
        port.postMessage({ type: 'closed' });
      } else if (client && message.type === 'remove-tab' && Number.isInteger(message.id)) {
        try {
          await chrome.tabs.remove(message.id);
          port.postMessage({ type: 'removed', id: message.id });
          broadcast();
        } catch {
          port.postMessage({ type: 'error', text: 'Не удалось закрыть вкладку.' });
          broadcast();
        }
      } else if (client && message.type === 'select' && Number.isInteger(message.id)) {
        try {
          const target = await chrome.tabs.get(message.id);
          // Hide and paint the source, retaining its iframe for the next use.
          await hostMessage(client, 'host:prepare-switch', false);
          await chrome.tabs.update(target.id, { active: true });
          await chrome.windows.update(target.windowId, { focused: true });
          try { port.postMessage({ type: 'closed' }); } catch { /* Navigated source. */ }
        } catch {
          try { port.postMessage({ type: 'error', text: 'Вкладка недоступна. Выберите другую.' }); } catch { /* Source was closed. */ }
          broadcast();
        }
      }
    }).catch(() => { try { port.disconnect(); } catch {} });
  });
  port.onDisconnect.addListener(() => { if (client) clients.delete(client); });
});
