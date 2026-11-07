import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
function startWorker(storage, timers) {
  const chrome = {
    tabs: Object.fromEntries(['onActivated', 'onRemoved', 'onCreated', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced'].map(name => [name, event()])),
    windows: { onFocusChanged: event() },
    commands: { onCommand: event() },
    runtime: { onConnect: event() },
    storage: { session: {
      get: async key => ({ [key]: structuredClone(storage[key]) }),
      set: async data => Object.assign(storage, structuredClone(data)),
      remove: async keys => { for (const key of [].concat(keys)) delete storage[key]; }
    } }
  };
  chrome.tabs.query = async options => {
    const tabs = [{ id: 1, windowId: 1, index: 0, title: 'One', url: 'https://a.test', lastAccessed: 12345 },
      { id: 2, windowId: 2, index: 0, title: 'Two', url: 'https://b.test', lastAccessed: 67890 }];
    return options.windowId ? tabs.filter(tab => tab.windowId === options.windowId) : tabs;
  };
  const context = vm.createContext({ chrome, console, Date, URL, crypto: webcrypto,
    setTimeout: timers ? fn => { const id = Symbol(); timers.set(id, fn); return id; } : () => 0,
    clearTimeout: id => timers?.delete(id) });
  vm.runInContext(source, context);
  return { chrome, snapshot: () => vm.runInContext('snapshot()', context) };
}
test('activation history survives worker restart, follows window focus, and cleans up closed tabs', async () => {
  const storage = {};
  const first = startWorker(storage);
  let tabs = await first.snapshot();
  assert.equal(tabs[0].lastUsed, null, 'native lastAccessed must not fabricate observed history');
  first.chrome.tabs.onActivated.emit({ tabId: 1 });
  await settle();
  first.chrome.windows.onFocusChanged.emit(2);
  await settle();
  const stamps = { ...storage.mru };
  assert.ok(stamps[1] > 0);
  assert.ok(stamps[2] > stamps[1]);
  const restarted = startWorker(storage);
  tabs = await restarted.snapshot();
  assert.equal(tabs[0].lastUsed, stamps[1]);
  assert.equal(tabs[1].lastUsed, stamps[2]);
  restarted.chrome.tabs.onRemoved.emit(1);
  await settle();
  assert.equal(storage.mru[1], undefined);
  restarted.chrome.tabs.onReplaced.emit(3, 99);
  await settle();
  assert.equal(storage.mru[3], undefined, 'replacement of an unknown tab must not invent an activation');
});
test('source overlay is hidden and painted before activation, even if its UI port disconnects', async () => {
  const worker = startWorker({ 'overlay:1': 'token' });
  const { chrome } = worker;
  chrome.runtime.id = 'test';
  const calls = [];
  let acknowledgePaint;
  chrome.tabs.get = async id => ({ id, windowId: 2 });
  chrome.tabs.sendMessage = async (id, message) => {
    calls.push(message.type);
    await new Promise(resolve => { acknowledgePaint = resolve; });
  };
  chrome.tabs.update = async () => { calls.push('activate'); };
  chrome.windows.update = async () => { calls.push('focus-window'); };
  const port = {
    name: 'picker:v1',
    sender: { id: 'test', url: 'chrome-extension://test/picker.html', tab: { id: 1 }, frameId: 1 },
    onMessage: event(), onDisconnect: event(),
    postMessage() {}, disconnect() { this.onDisconnect.emit(); }
  };
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'hello', token: 'token' });
  await settle();
  port.onMessage.emit({ type: 'select', id: 2 });
  await settle();
  assert.deepEqual(calls, ['host:prepare-switch'], 'activation must wait for the clean source frame');
  port.disconnect();
  acknowledgePaint();
  await settle();
  assert.deepEqual(calls, ['host:prepare-switch', 'activate', 'focus-window']);
});
test('warm commands toggle the mounted host without reinjection or storage access', async () => {
  const { chrome } = startWorker({});
  const messages = [];
  chrome.tabs.sendMessage = async (id, message) => { messages.push(message.type); return { mounted: true }; };
  chrome.scripting = { executeScript: () => assert.fail('warm opening must not inject a script') };
  chrome.storage.session.set = () => assert.fail('warm opening must not write storage');
  for (let i = 0; i < 3; i++) {
    chrome.commands.onCommand.emit('open-picker', { id: 1, windowId: 1 });
    await settle();
  }
  assert.deepEqual(messages, ['host:toggle', 'host:toggle', 'host:toggle']);
});

async function connectPicker(chrome, tabId = 11) {
  chrome.runtime.id = 'test';
  const messages = [];
  let disconnected = false;
  const port = {
    name: 'picker:v1',
    sender: { id: 'test', url: 'chrome-extension://test/picker.html', tab: { id: tabId }, frameId: 1 },
    onMessage: event(), onDisconnect: event(),
    postMessage(message) { if (disconnected) throw new Error('Disconnected'); messages.push(message); },
    disconnect() { disconnected = true; this.onDisconnect.emit(); }
  };
  chrome.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'hello', token: 'token' });
  await settle();
  return { port, messages };
}
test('keep-tabs uses exact filtered IDs across windows and finishes after the source UI closes', async () => {
  const { chrome } = startWorker({ 'overlay:11': 'token' });
  let live = [11, 12, 13, 14, 15, 16, 17].map(id => ({ id, windowId: id >= 15 ? 2 : 1, index: id, title: `Tab ${id}`, url: 'https://test/' }));
  chrome.tabs.query = async () => live;
  const calls = [];
  chrome.tabs.sendMessage = async () => { calls.push('hide'); };
  chrome.tabs.update = async id => { calls.push(`activate:${id}`); };
  chrome.windows.update = async id => { calls.push(`focus:${id}`); };
  const { port } = await connectPicker(chrome);
  const batches = [];
  chrome.tabs.remove = async ids => {
    assert.ok(Array.isArray(ids), 'bulk close must use the array form of tabs.remove');
    batches.push([...ids]);
    live = live.filter(tab => !ids.includes(tab.id));
    if (ids.includes(11)) port.disconnect();
  };
  port.onMessage.emit({ type: 'keep-tabs', scopeIds: [11, 12, 13, 14, 15, 16], keepIds: [15, 12] });
  await settle();
  assert.deepEqual(live.map(tab => tab.id), [12, 15, 17], 'new tab 17 was never part of the displayed scope');
  assert.deepEqual(calls, ['hide', 'activate:15', 'focus:2']);
  assert.deepEqual(batches, [[11, 13, 14, 16]], 'all requested tabs must close in one API call');
});
test('a concurrent close retries only the remaining batch', async () => {
  const { chrome } = startWorker({ 'overlay:11': 'token' });
  let live = [11, 12, 13, 14, 17].map(id => ({ id, title: `Tab ${id}`, url: 'https://test/', index: id, windowId: 1 }));
  chrome.tabs.query = async () => live;
  const { port, messages } = await connectPicker(chrome);
  const batches = [];
  chrome.tabs.remove = async ids => {
    assert.ok(Array.isArray(ids));
    batches.push([...ids]);
    if (batches.length === 1) {
      live = live.filter(tab => tab.id !== 14);
      throw new Error('Tab 14 concurrently closed');
    }
    live = live.filter(tab => !ids.includes(tab.id));
  };
  port.onMessage.emit({ type: 'keep-tabs', scopeIds: [11, 12, 13, 14], keepIds: [11] });
  await settle();
  assert.deepEqual(batches, [[12, 13, 14], [12, 13]]);
  assert.deepEqual(live.map(tab => tab.id), [11, 17]);
  assert.equal(messages.at(-1).type, 'kept');
});
test('keep-tabs rejects empty/foreign keep sets and missing survivors without deleting tabs', async () => {
  for (const keepIds of [[], [99], [11, 11], [1.5]]) {
    const { chrome } = startWorker({ 'overlay:11': 'token' });
    chrome.tabs.remove = () => assert.fail('invalid plan must not close a tab');
    const { port, messages } = await connectPicker(chrome);
    port.onMessage.emit({ type: 'keep-tabs', scopeIds: [11, 12], keepIds });
    await settle();
    assert.equal(messages.at(-1).type, 'error');
  }
  const { chrome } = startWorker({ 'overlay:11': 'token' });
  chrome.tabs.remove = () => assert.fail('do not close others after all retained tabs disappeared');
  const { port, messages } = await connectPicker(chrome);
  port.onMessage.emit({ type: 'keep-tabs', scopeIds: [11, 12], keepIds: [11] });
  await settle();
  assert.equal(messages.at(-1).type, 'error');
});


test('cold opening starts injection and token storage together, but waits for both before show', async () => {
  const { chrome } = startWorker({});
  const calls = [];
  let finishInjection, finishStorage;
  chrome.tabs.sendMessage = async (_id, message) => { calls.push(message.type); return null; };
  chrome.scripting = { executeScript: () => { calls.push('inject'); return new Promise(resolve => { finishInjection = resolve; }); } };
  chrome.storage.session.set = () => { calls.push('store'); return new Promise(resolve => { finishStorage = resolve; }); };
  chrome.commands.onCommand.emit('open-picker', { id: 1, windowId: 1 });
  await settle();
  assert.deepEqual(calls, ['host:toggle', 'inject', 'store']);
  finishInjection(); await settle();
  assert.equal(calls.includes('host:show'), false);
  finishStorage(); await settle();
  assert.equal(calls.at(-1), 'host:show');
});

test('broadcast skips absent clients and irrelevant updates; an event burst uses one snapshot', async () => {
  const timers = new Map();
  const { chrome } = startWorker({ 'overlay:11': 'token' }, timers);
  let queries = 0;
  const original = chrome.tabs.query;
  chrome.tabs.query = async options => { queries++; return original(options); };
  chrome.tabs.onCreated.emit();
  await settle();
  assert.equal(queries, 0); assert.equal(timers.size, 0);
  const { messages } = await connectPicker(chrome);
  assert.equal(queries, 1);
  chrome.tabs.onUpdated.emit(1, { status: 'complete', audible: true });
  assert.equal(timers.size, 0);
  chrome.tabs.onUpdated.emit(1, { title: 'New title' });
  chrome.tabs.onUpdated.emit(1, { url: 'https://new.test' });
  assert.equal(timers.size, 1);
  const callbacks = [...timers.values()]; timers.clear();
  await callbacks[0]();
  assert.equal(queries, 2);
  assert.equal(messages.length, 2);
});

test('MRU storage coalesces a burst and writes the latest state after an in-flight write', async () => {
  const storage = {};
  const { chrome } = startWorker(storage);
  const writes = [];
  let release;
  chrome.storage.session.set = async data => {
    writes.push(structuredClone(data));
    if (writes.length === 1) await new Promise(resolve => { release = resolve; });
    Object.assign(storage, structuredClone(data));
  };
  chrome.tabs.onActivated.emit({ tabId: 1 });
  chrome.tabs.onActivated.emit({ tabId: 2 });
  await settle();
  assert.equal(writes.length, 1);
  assert.ok(writes[0].mru[1] && writes[0].mru[2]);
  chrome.tabs.onActivated.emit({ tabId: 3 });
  await settle();
  assert.equal(writes.length, 1);
  release(); await settle();
  assert.equal(writes.length, 2);
  assert.ok(storage.mru[3]);
});

test('bulk closing shares one final snapshot and batches overlay storage cleanup', async () => {
  const timers = new Map();
  const { chrome } = startWorker({ 'overlay:11': 'token' }, timers);
  let live = [11, 12, 13].map(id => ({ id, windowId: 1, index: id, title: `Tab ${id}`, url: 'https://test/' }));
  let queries = 0;
  chrome.tabs.query = async () => { queries++; return live; };
  const cleanup = [];
  chrome.storage.session.remove = async keys => cleanup.push(Array.from(keys));
  const { port, messages } = await connectPicker(chrome);
  chrome.tabs.remove = async ids => {
    live = live.filter(tab => !ids.includes(tab.id));
    for (const id of ids) chrome.tabs.onRemoved.emit(id);
  };
  port.onMessage.emit({ type: 'keep-tabs', scopeIds: [11, 12, 13], keepIds: [11] });
  await settle();
  assert.equal(queries, 3, 'hello, live validation, and one shared final snapshot');
  assert.equal(timers.size, 0, 'no duplicate delayed broadcast after final snapshot');
  assert.equal(messages.at(-1).type, 'kept');
  assert.deepEqual(cleanup, [['overlay:12', 'overlay:13']]);
});

test('a slow older broadcast cannot overwrite a newer snapshot', async () => {
  const timers = new Map();
  const { chrome } = startWorker({ 'overlay:11': 'token' }, timers);
  const { messages } = await connectPicker(chrome);
  let finishOld;
  chrome.tabs.query = () => new Promise(resolve => { finishOld = resolve; });
  chrome.tabs.onUpdated.emit(1, { title: 'Old' });
  const oldCallback = [...timers.values()][0]; timers.clear();
  const pending = oldCallback();
  chrome.tabs.onUpdated.emit(1, { title: 'New' });
  chrome.tabs.query = async () => [{ id: 1, title: 'New' }];
  const newCallback = [...timers.values()][0]; timers.clear();
  await newCallback();
  finishOld([{ id: 1, title: 'Old' }]); await pending;
  assert.equal(messages.length, 2, 'hello and only the newest broadcast');
  assert.equal(messages.at(-1).tabs[0].title, 'New');
});
