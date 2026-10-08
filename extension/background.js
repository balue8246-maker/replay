// REPLAY Recorder — background service worker.
// Forwards content-script events, navigations, downloads and XHR/fetch calls to
// the local REPLAY daemon (http://127.0.0.1:47710) — but only while the daemon
// reports an active recording. When no daemon is running, events are dropped.

const DAEMON = 'http://127.0.0.1:47710';
const VERSION = chrome.runtime.getManifest().version;
const SECRET_QUERY = /token|key|sig|auth|secret|passw|session|code|csrf|jwt|ticket/i;

let status = { recording: false };
let statusAt = 0;
let pending = null;

async function getStatus(force = false) {
  if (!force && Date.now() - statusAt < 1500) return status;
  if (pending) return pending;
  pending = (async () => {
    try {
      const r = await fetch(`${DAEMON}/status?ext=${VERSION}`, { cache: 'no-store' });
      status = r.ok ? await r.json() : { recording: false };
    } catch {
      status = { recording: false };
    }
    statusAt = Date.now();
    pending = null;
    chrome.action.setBadgeText({ text: status.recording ? 'REC' : '' });
    chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
    return status;
  })();
  return pending;
}

function redactUrl(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (SECRET_QUERY.test(k)) u.searchParams.set(k, '[redacted]');
    return u.toString();
  } catch {
    return url;
  }
}

async function post(path, body) {
  try {
    await fetch(`${DAEMON}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch { /* daemon went away */ }
}

async function emit(evt) {
  const s = await getStatus();
  if (!s.recording) return false;
  await post('/event', evt);
  return true;
}

let lastShot = 0;
async function screenshot(windowId, reason) {
  // captureVisibleTab is quota-limited (~2/s); one per second is plenty.
  if (Date.now() - lastShot < 1000) return null;
  lastShot = Date.now();
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 45 });
    const id = `${Date.now()}`;
    await post('/shot', { id, reason, dataUrl });
    return id;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.__replayStatus) { getStatus().then((s) => sendResponse({ recording: !!s.recording })); return true; }
  if (!msg || !msg.__replay) return;
  const tab = sender.tab || {};
  (async () => {
    const s = await getStatus(msg.type === 'page');
    if (!s.recording) return;
    const { __replay, ...rest } = msg;
    const evt = {
      source: 'page',
      tabId: tab.id,
      windowId: tab.windowId,
      frameId: sender.frameId,
      tabUrl: tab.url ? redactUrl(tab.url) : undefined,
      ...rest,
      frameUrl: rest.frameUrl ? redactUrl(rest.frameUrl) : undefined,
    };
    if (s.screenshots !== false && ['click', 'dblclick'].includes(msg.type) && sender.frameId === 0 && tab.active) {
      evt.shot = await screenshot(tab.windowId, msg.type);
    }
    await post('/event', evt);
  })();
});

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  emit({ source: 'nav', type: 'navigate', tabId: d.tabId, url: redactUrl(d.url), transition: d.transitionType, qualifiers: d.transitionQualifiers });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0) return;
  emit({ source: 'nav', type: 'spa_navigate', tabId: d.tabId, url: redactUrl(d.url) });
});

chrome.tabs.onCreated.addListener((t) => emit({ source: 'tab', type: 'tab_created', tabId: t.id, openerTabId: t.openerTabId, url: t.pendingUrl ? redactUrl(t.pendingUrl) : undefined }));
chrome.tabs.onActivated.addListener((a) => emit({ source: 'tab', type: 'tab_activated', tabId: a.tabId }));
chrome.tabs.onRemoved.addListener((tabId) => emit({ source: 'tab', type: 'tab_closed', tabId }));

chrome.downloads.onCreated.addListener((d) => {
  emit({ source: 'download', type: 'download_started', downloadId: d.id, url: redactUrl(d.finalUrl || d.url), mime: d.mime, filename: d.filename, referrer: d.referrer ? redactUrl(d.referrer) : undefined });
});
chrome.downloads.onChanged.addListener((d) => {
  if (d.state && d.state.current === 'complete') {
    chrome.downloads.search({ id: d.id }, ([item]) => {
      emit({ source: 'download', type: 'download_complete', downloadId: d.id, filename: item?.filename, bytes: item?.fileSize, mime: item?.mime });
    });
  } else if (d.filename && d.filename.current) {
    emit({ source: 'download', type: 'download_named', downloadId: d.id, filename: d.filename.current });
  }
});

// API discovery: which XHR/fetch calls did the page make around each action?
// Metadata only (method, redacted URL, status, type) — never bodies or headers.
chrome.webRequest.onCompleted.addListener((d) => {
  if (d.tabId < 0 || d.url.startsWith(DAEMON)) return;
  if (!status.recording) return;
  emit({ source: 'net', type: 'request', tabId: d.tabId, method: d.method, url: redactUrl(d.url), status: d.statusCode, rtype: d.type, fromCache: d.fromCache });
}, { urls: ['<all_urls>'], types: ['xmlhttprequest', 'main_frame', 'sub_frame', 'other'] });

chrome.action.onClicked.addListener(async () => {
  const s = await getStatus(true);
  if (s.recording) {
    await post('/stop', { by: 'extension' });
    await getStatus(true);
  }
});

chrome.runtime.onInstalled.addListener(() => post('/hello', { version: VERSION, at: Date.now() }));
chrome.runtime.onStartup.addListener(() => post('/hello', { version: VERSION, at: Date.now() }));
getStatus(true);
