/**
 * background.js — Service Worker for Badge Updates, Tab Change Notifications,
 *                 and Session / Activity Tracking
 *
 * Badge color coding:
 *   Green  (#3d7a4a) — 1–10 tabs (focused)
 *   Amber  (#b8892e) — 11–25 tabs (getting busy)
 *   Red    (#b35a5a) — 26+ tabs (time to clean up!)
 */

const INTERNAL_PREFIXES = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];

// ─── Session storage (replaces server /api/sessions) ─────────────────────────

async function recordSession({ domain, duration_s, date_key }) {
  if (!domain || !duration_s || duration_s < 2) return;
  const key = `stats_${date_key}`;
  const data = await chrome.storage.local.get(key);
  const stats = data[key] || { domains: {}, sessionCount: 0 };

  if (!stats.domains[domain]) {
    stats.domains[domain] = { totalTime: 0, sessionCount: 0 };
  }
  stats.domains[domain].totalTime    += duration_s;
  stats.domains[domain].sessionCount += 1;
  stats.sessionCount += 1;

  await chrome.storage.local.set({ [key]: stats });

  // Prune stats older than 30 days (run occasionally, not every session)
  if (Math.random() < 0.02) {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const all = await chrome.storage.local.get(null);
    const toRemove = Object.keys(all).filter(k => k.startsWith('stats_') && k.slice(6) < cutoff);
    if (toRemove.length > 0) await chrome.storage.local.remove(toRemove);
  }
}

// ─── Badge ───────────────────────────────────────────────────────────────────

async function updateBadge() {
  try {
    const tabs = await chrome.tabs.query({});
    const count = tabs.filter(t => {
      const url = t.url || '';
      return !INTERNAL_PREFIXES.some(p => url.startsWith(p));
    }).length;

    if (count === 0) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }

    chrome.action.setBadgeText({ text: String(count) });

    let badgeColor;
    if (count <= 10)      badgeColor = '#3d7a4a';
    else if (count <= 25) badgeColor = '#b8892e';
    else                  badgeColor = '#b35a5a';

    chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  } catch {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ─── Notify dashboard ────────────────────────────────────────────────────────

let notifyTimer = null;

function notifyTabSweepPages() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    chrome.runtime.sendMessage({ type: 'tabsChanged' }).catch(() => {});
  }, 500);
}

function onTabChange() {
  updateBadge();
  notifyTabSweepPages();
}

// ─── Session tracking ────────────────────────────────────────────────────────
// lastActivated is persisted to chrome.storage.session so idle timers survive
// MV3 service worker restarts (workers unload after ~30s idle). Without this,
// tabs could never accumulate enough idle time for stale thresholds > a few min.

let activeSession = null;   // { tabId, url, domain, activatedAt }
const lastActivated = {};   // tabId → timestamp (ms)
const LAST_ACTIVATED_KEY = 'lastActivatedMap';

let saveTimer = null;
function persistLastActivated() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    chrome.storage.session.set({ [LAST_ACTIVATED_KEY]: lastActivated }).catch(() => {});
  }, 500);
}

function touchTab(tabId, ts = Date.now()) {
  lastActivated[tabId] = ts;
  persistLastActivated();
}

function domainFrom(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function isTrackable(url) {
  if (!url) return false;
  return !INTERNAL_PREFIXES.some(p => url.startsWith(p));
}

function flushSession() {
  if (!activeSession) return;
  const now = Date.now();
  const durationS = Math.round((now - activeSession.activatedAt) / 1000);
  if (durationS >= 2 && activeSession.domain) {
    const dateKey = new Date(now).toISOString().slice(0, 10);
    recordSession({ domain: activeSession.domain, duration_s: durationS, date_key: dateKey });
  }
  activeSession = null;
}

async function startSession(tabId) {
  flushSession();
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !isTrackable(tab.url)) return;
    const domain = domainFrom(tab.url);
    activeSession = { tabId, url: tab.url, domain, activatedAt: Date.now() };
    touchTab(tabId);
  } catch { /* tab may have closed */ }
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  touchTab(tabId);
  startSession(tabId);
  onTabChange();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeSession && activeSession.tabId === tabId) flushSession();
  delete lastActivated[tabId];
  persistLastActivated();
  onTabChange();
});

chrome.tabs.onCreated.addListener((tab) => {
  touchTab(tab.id);
  onTabChange();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.title) {
    if (activeSession && activeSession.tabId === tabId && changeInfo.url) {
      flushSession();
      startSession(tabId);
    }
    if (changeInfo.url) touchTab(tabId);
    onTabChange();
  }
});

// Periodic flush every 60s so we don't lose the active session on crash/close
setInterval(flushSession, 60_000);

// ─── Message handler ─────────────────────────────────────────────────────────

async function buildTabActivity() {
  const stored = await chrome.storage.session.get(LAST_ACTIVATED_KEY);
  const merged = { ...(stored[LAST_ACTIVATED_KEY] || {}), ...lastActivated };

  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.active) {
        merged[tab.id] = Date.now();
      } else if (merged[tab.id] == null) {
        // Prefer chrome's native lastAccessed (Chrome 121+) so tabs the worker
        // hasn't yet seen since wake-up don't get fabricated fresh timestamps.
        merged[tab.id] = typeof tab.lastAccessed === 'number' ? tab.lastAccessed : Date.now();
      }
    }
    const openIds = new Set(tabs.map(t => t.id));
    for (const idStr of Object.keys(merged)) {
      if (!openIds.has(Number(idStr))) delete merged[idStr];
    }
  } catch {}

  return merged;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'getTabActivity') {
    buildTabActivity().then(map => sendResponse({ lastActivated: map }));
    return true;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => updateBadge());
chrome.runtime.onStartup.addListener(() => updateBadge());

async function initActivity() {
  const stored = await chrome.storage.session.get(LAST_ACTIVATED_KEY);
  const prior = stored[LAST_ACTIVATED_KEY] || {};

  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const openIds = new Set(tabs.map(t => t.id));

  for (const tab of tabs) {
    if (tab.active) {
      lastActivated[tab.id] = now;
    } else if (prior[tab.id] != null) {
      lastActivated[tab.id] = prior[tab.id];
    } else if (typeof tab.lastAccessed === 'number') {
      lastActivated[tab.id] = tab.lastAccessed;
    } else {
      lastActivated[tab.id] = now;
    }
  }
  for (const idStr of Object.keys(prior)) {
    if (!openIds.has(Number(idStr))) delete lastActivated[idStr];
  }
  persistLastActivated();

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (activeTab) startSession(activeTab.id);
}

updateBadge();
initActivity();
