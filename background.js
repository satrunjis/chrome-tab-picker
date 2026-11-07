const clients = new Set();
const locks = new Set();
let mru = {};
const ready = chrome.storage.session.get('mru').then(data => { mru = data.mru || {}; });
let clock = Date.now();
let savingMRU = false, mruDirty = false;
let bulkDepth = 0;
function persistMRU() {
  mruDirty = true;
  if (bulkDepth || savingMRU) return;
  savingMRU = true;
  void Promise.resolve().then(async () => {
    try {
      while (mruDirty && !bulkDepth) {
        mruDirty = false;
        await chrome.storage.session.set({ mru: { ...mru } });
      }
    } catch (error) { console.error(error); }
    finally { savingMRU = false; }
  });
}
async function touch(id) {
  await ready;
  clock = Math.max(Date.now(), clock + 1);
  mru[id] = clock;
  persistMRU();
  broadcast();
}
async function snapshot() {
  const [, tabs] = await Promise.all([ready, chrome.tabs.query({})]);
  return tabs.map(tab => ({
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
let broadcastTimer, broadcastRevision = 0;
function publish(tabs, acknowledgedClient) {
  for (const client of clients) {
    try { client.port.postMessage({ type: client === acknowledgedClient ? 'kept' : 'tabs', tabs }); }
    catch { clients.delete(client); }
  }
}
function broadcast() {
  broadcastRevision++;
  if (bulkDepth || !clients.size || broadcastTimer !== undefined) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = undefined;
    if (bulkDepth || !clients.size) return;
    const version = broadcastRevision;
    try {
      const tabs = await snapshot();
      if (!bulkDepth && version === broadcastRevision) publish(tabs);
    } catch (error) { console.error(error); }
  }, 40);
}
const removedOverlayKeys = new Set();
let removingOverlays = false;
function removeOverlay(id) {
  if (Number.isInteger(id)) removedOverlayKeys.add(`overlay:${id}`);
  if (bulkDepth || removingOverlays || !removedOverlayKeys.size) return;
  removingOverlays = true;
  void Promise.resolve().then(async () => {
    try {
      while (removedOverlayKeys.size) {
        const keys = [...removedOverlayKeys]; removedOverlayKeys.clear();
        await chrome.storage.session.remove(keys);
      }
    } catch (error) { console.error(error); }
    finally { removingOverlays = false; }
  });
}
async function removeBatch(ids) {
  let pending = ids;
  for (let attempt = 0; pending.length; attempt++) {
    try { await chrome.tabs.remove(pending); return; }
    catch (error) {
      // A concurrent close can invalidate one ID. Retry the surviving part of
      // the same batch, never fall back to one awaited call for every tab.
      const live = new Set((await chrome.tabs.query({})).map(tab => tab.id));
      const remaining = pending.filter(id => live.has(id));
      if (!remaining.length) return;
      if (remaining.length === pending.length || attempt >= 2) throw error;
      pending = remaining;
    }
  }
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
  removeOverlay(id);
  broadcast();
});
chrome.tabs.onCreated.addListener(broadcast);
chrome.tabs.onUpdated.addListener((_id, change) => {
  if ('title' in change || 'url' in change) broadcast();
});
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
    const token = crypto.randomUUID();
    await Promise.all([
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }),
      chrome.storage.session.set({ [`overlay:${tab.id}`]: token })
    ]);
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
      } else if (client && message.type === 'keep-tabs') {
        bulkDepth++;
        let completed = false;
        try {
          const { scopeIds, keepIds } = message;
          if (!Array.isArray(scopeIds) || !Array.isArray(keepIds) || !keepIds.length || keepIds.length > 9 ||
              !scopeIds.every(Number.isInteger) || !keepIds.every(Number.isInteger) ||
              new Set(scopeIds).size !== scopeIds.length || new Set(keepIds).size !== keepIds.length ||
              !keepIds.every(id => scopeIds.includes(id))) throw new Error('Invalid keep plan');
          const live = await chrome.tabs.query({});
          const survivors = keepIds.map(id => live.find(tab => tab.id === id)).filter(Boolean);
          if (!survivors.length) throw new Error('Kept tabs were closed');
          const keep = new Set(keepIds), scope = new Set(scopeIds);
          const remove = live.filter(tab => scope.has(tab.id) && !keep.has(tab.id)).map(tab => tab.id);
          if (remove.includes(client.tabId)) {
            await hostMessage(client, 'host:prepare-switch', false);
            await chrome.tabs.update(survivors[0].id, { active: true });
            await chrome.windows.update(survivors[0].windowId, { focused: true });
          }
          // One browser request for the captured scope; new tabs are untouched.
          await removeBatch(remove);
          // One final snapshot serves both the initiating UI and other clients.
          const tabs = clients.size ? await snapshot() : [];
          clearTimeout(broadcastTimer); broadcastTimer = undefined;
          broadcastRevision++;
          publish(tabs, client);
          completed = true;
        } catch {
          try { port.postMessage({ type: 'error', text: 'Не удалось закрыть остальные вкладки.' }); } catch { /* Source was closed. */ }
        } finally {
          bulkDepth--;
          persistMRU();
          removeOverlay();
          if (!completed) broadcast();
        }
      } else if (client && message.type === 'select' && Number.isInteger(message.id)) {
        try {
          // Fetch the destination while the source paints its hidden state.
          const [target] = await Promise.all([
            chrome.tabs.get(message.id),
            hostMessage(client, 'host:prepare-switch', false)
          ]);
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
