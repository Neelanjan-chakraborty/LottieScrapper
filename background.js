// Lottie Scraper — service worker
// * opens the side panel from the toolbar button
// * keeps the per-tab detector badge up to date
// * records JSON / .lottie network responses per tab so the scanner can re-check them

const BADGE_COLOR = '#14b8a6';
const NET_LIMIT = 400;

const frameCounts = new Map(); // tabId -> Map(frameId -> count)
const network = new Map(); // tabId -> Map(url -> {url, contentType, size})
let persistTimer = null;

chrome.runtime.onInstalled.addListener(() => setupPanel());
chrome.runtime.onStartup.addListener(() => setupPanel());

function setupPanel() {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
  try { chrome.action.setBadgeTextColor?.({ color: '#ffffff' }); } catch (_) {}
}

// ---------- badge ----------
function updateBadge(tabId) {
  const frames = frameCounts.get(tabId);
  let total = 0;
  if (frames) for (const n of frames.values()) total += n;
  chrome.action.setBadgeText({ tabId, text: total ? String(total > 999 ? '999+' : total) : '' }).catch(() => {});
  chrome.action.setTitle({
    tabId,
    title: total ? `Lottie Scraper — ${total} animation${total === 1 ? '' : 's'} detected` : 'Lottie Scraper'
  }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'detect' && sender.tab) {
    const tabId = sender.tab.id;
    if (!frameCounts.has(tabId)) frameCounts.set(tabId, new Map());
    frameCounts.get(tabId).set(sender.frameId ?? 0, Math.max(0, msg.count | 0));
    updateBadge(tabId);
    return;
  }
  if (msg?.type === 'getNetwork') {
    getNetwork(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg?.type === 'getDetected') {
    const frames = frameCounts.get(msg.tabId);
    let total = 0;
    if (frames) for (const n of frames.values()) total += n;
    sendResponse({ count: total });
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  frameCounts.delete(tabId);
  network.delete(tabId);
  chrome.storage.session.remove('net:' + tabId).catch(() => {});
});

// ---------- network capture ----------
const LOTTIE_EXT = /\.(json|lottie)(?:[?#]|$)/i;

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.type === 'main_frame') {
      network.set(details.tabId, new Map());
      frameCounts.delete(details.tabId);
      updateBadge(details.tabId);
      schedulePersist();
      return;
    }
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const headers = details.responseHeaders || [];
    const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value || '';
    const ct = get('content-type').toLowerCase();
    const size = parseInt(get('content-length'), 10) || 0;
    const looksJson = ct.includes('json') || ct.includes('lottie');
    const looksZip = ct.includes('zip') || ct.includes('octet-stream');
    const byExt = LOTTIE_EXT.test(details.url);
    if (!(looksJson || byExt || (looksZip && /\.lottie/i.test(details.url)))) return;
    if (details.url.startsWith('chrome-extension:')) return;
    if (!network.has(details.tabId)) network.set(details.tabId, new Map());
    const map = network.get(details.tabId);
    if (map.size >= NET_LIMIT || map.has(details.url)) return;
    map.set(details.url, { url: details.url, contentType: ct, size, byExt, kind: details.type });
    schedulePersist();
  },
  { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame', 'xmlhttprequest', 'other', 'script', 'media', 'object'] },
  ['responseHeaders']
);

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const data = {};
    for (const [tabId, map] of network) data['net:' + tabId] = [...map.values()];
    chrome.storage.session.set(data).catch(() => {});
  }, 800);
}

async function getNetwork(tabId) {
  if (network.has(tabId)) return [...network.get(tabId).values()];
  // service worker may have been restarted — fall back to session storage
  const key = 'net:' + tabId;
  const stored = (await chrome.storage.session.get(key).catch(() => ({})))[key] || [];
  network.set(tabId, new Map(stored.map((e) => [e.url, e])));
  return stored;
}

setupPanel();
