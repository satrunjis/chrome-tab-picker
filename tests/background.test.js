import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../background.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
function startWorker(storage) {
  const chrome = {
    tabs: Object.fromEntries(['onActivated', 'onRemoved', 'onCreated', 'onUpdated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced'].map(name => [name, event()])),
    windows: { onFocusChanged: event() },
    commands: { onCommand: event() },
    runtime: { onConnect: event() },
    storage: { session: {
      get: async key => ({ [key]: structuredClone(storage[key]) }),
      set: async data => Object.assign(storage, structuredClone(data)),
      remove: async key => { delete storage[key]; }
    } }
  };
  chrome.tabs.query = async options => {
    const tabs = [{ id: 1, windowId: 1, index: 0, title: 'One', url: 'https://a.test', lastAccessed: 12345 },
      { id: 2, windowId: 2, index: 0, title: 'Two', url: 'https://b.test', lastAccessed: 67890 }];
    return options.windowId ? tabs.filter(tab => tab.windowId === options.windowId) : tabs;
  };
  const context = vm.createContext({ chrome, console, Date, URL, setTimeout: () => 0, clearTimeout: () => {} });
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
