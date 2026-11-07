(() => {
  const key = '__chromiumTabPickerV03';
  if (globalThis[key]) return;
  globalThis[key] = true;
  let host, frame, token, previousFocus;
  let visible = false, uiReady = false, revision = 0;

  function notify(type, version = revision) {
    return chrome.runtime.sendMessage({ type, token, revision: version }).catch(() => null);
  }
  function setHostVisible(show) {
    // `all: initial !important` overrides the UA's closed-popover display:none.
    // Set the real host visibility explicitly, including its hit-testing state.
    host?.style.setProperty('display', show ? 'block' : 'none', 'important');
    host?.style.setProperty('visibility', show ? 'visible' : 'hidden', 'important');
    host?.style.setProperty('pointer-events', show ? 'auto' : 'none', 'important');
  }
  function hide(restore = true) {
    visible = false;
    revision++;
    setHostVisible(false);
    if (host?.matches(':popover-open')) host.hidePopover();
    void notify('ui:hide');
    if (restore && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function reveal() {
    const version = ++revision;
    // Reset the cached UI before exposing it, never flash the previous search.
    void notify('ui:show', version).then(ready => {
      if (!ready?.ok || !visible || version !== revision || !host?.isConnected) return;
      setHostVisible(true);
      if (!host.matches(':popover-open')) host.showPopover();
      frame.focus();
      void notify('ui:focus', version);
    });
  }
  function show() {
    if (!visible) previousFocus = document.activeElement;
    visible = true;
    if (uiReady) reveal();
  }
  function mount(nextToken) {
    // Rebuild only if a site detached the host or its document was replaced.
    host?.remove();
    visible = false;
    uiReady = false;
    revision = 0;
    token = nextToken;
    host = document.createElement('div');
    host.setAttribute('popover', 'manual');
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;z-index:2147483647!important;';
    setHostVisible(false);
    const root = host.attachShadow({ mode: 'closed' });
    frame = document.createElement('iframe');
    frame.title = 'Chromium Tab Picker';
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;color-scheme:dark;background:transparent;';
    frame.src = chrome.runtime.getURL('picker.html') + '#token=' + encodeURIComponent(token);
    root.append(frame);
    document.documentElement.append(host);
  }
  function afterPaint(reply) {
    if (document.visibilityState !== 'visible') { reply({ ok: true }); return; }
    let animation;
    const timeout = setTimeout(done, 120);
    function done() { clearTimeout(timeout); cancelAnimationFrame(animation); reply({ ok: true }); }
    animation = requestAnimationFrame(() => { animation = requestAnimationFrame(done); });
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && visible) hide(false); });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || !message || typeof message.type !== 'string') return;
    if (message.type === 'host:connect' && message.token === token) {
      if (!uiReady) { uiReady = true; if (visible) reveal(); }
      reply({ ok: true });
    } else if (message.type === 'host:toggle') {
      if (!host?.isConnected) { reply({ mounted: false }); return; }
      if (visible) hide(); else show();
      reply({ mounted: true });
    } else if (message.type === 'host:show' && typeof message.token === 'string') {
      if (!host?.isConnected || token !== message.token) mount(message.token);
      show();
      reply({ ok: true });
    } else if (message.token === token && (message.type === 'host:close' || message.type === 'host:prepare-switch')) {
      hide(message.restore !== false);
      if (message.type === 'host:prepare-switch') { afterPaint(reply); return true; }
      reply({ ok: true });
    }
  });
})();
