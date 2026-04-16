/**
 * storage.js — chrome.storage.local adapter replacing the SQLite/Express backend.
 *
 * Data layout in chrome.storage.local:
 *
 *   deferred_tabs  → Array of tab objects:
 *     { id, url, title, favicon_url, source_mission, deferred_at,
 *       checked, checked_at, dismissed, archived, archived_at }
 *
 *   stats_<YYYY-MM-DD> → Object:
 *     { domains: { [domain]: { totalTime, sessionCount } }, sessionCount }
 *
 * IDs for deferred tabs are generated as incrementing integers stored in
 *   deferred_next_id → Number
 */

'use strict';

function _storage() {
  if (!chrome || !chrome.storage || !chrome.storage.local) {
    throw new Error('chrome.storage.local is not available');
  }
  return chrome.storage.local;
}

// ── Deferred tabs ─────────────────────────────────────────────────────────────

async function _loadDeferred() {
  const data = await _storage().get(['deferred_tabs', 'deferred_next_id']);
  return {
    tabs: data.deferred_tabs || [],
    nextId: data.deferred_next_id || 1,
  };
}

async function _saveDeferred(tabs, nextId) {
  await _storage().set({ deferred_tabs: tabs, deferred_next_id: nextId });
}

/**
 * getDeferred()
 * Returns { active: [...], archived: [...] }
 * Also ages out tabs older than 30 days into archive.
 */
async function getDeferred() {
  const { tabs, nextId } = await _loadDeferred();
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();

  let changed = false;
  for (const tab of tabs) {
    if (!tab.archived && tab.deferred_at < cutoff) {
      tab.archived = true;
      tab.archived_at = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) await _saveDeferred(tabs, nextId);

  const active   = tabs.filter(t => !t.archived).sort((a, b) => b.deferred_at.localeCompare(a.deferred_at));
  const archived = tabs.filter(t =>  t.archived).sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));
  return { active, archived };
}

/**
 * insertDeferred({ url, title, favicon_url, source_mission })
 * Adds a new deferred tab and returns it.
 */
async function insertDeferred({ url, title, favicon_url = null, source_mission = null }) {
  const { tabs, nextId } = await _loadDeferred();
  const tab = {
    id: nextId,
    url,
    title,
    favicon_url,
    source_mission,
    deferred_at: new Date().toISOString(),
    checked: false,
    checked_at: null,
    dismissed: false,
    archived: false,
    archived_at: null,
  };
  tabs.push(tab);
  await _saveDeferred(tabs, nextId + 1);
  return tab;
}

/**
 * updateDeferred(id, { checked } | { dismissed })
 * Archives the tab and marks it checked or dismissed.
 */
async function updateDeferred(id, patch) {
  const { tabs, nextId } = await _loadDeferred();
  const tab = tabs.find(t => t.id === Number(id));
  if (!tab) return;

  if (patch.checked) {
    tab.checked = true;
    tab.checked_at = new Date().toISOString();
  } else if (patch.dismissed) {
    tab.dismissed = true;
  }
  tab.archived = true;
  tab.archived_at = new Date().toISOString();

  await _saveDeferred(tabs, nextId);
}

/**
 * searchDeferred(q)
 * Client-side substring search of archived tabs. Returns up to 50 results.
 */
async function searchDeferred(q) {
  const { tabs } = await _loadDeferred();
  const lower = q.toLowerCase();
  return tabs
    .filter(t => t.archived && (
      (t.title || '').toLowerCase().includes(lower) ||
      (t.url  || '').toLowerCase().includes(lower)
    ))
    .sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''))
    .slice(0, 50);
}

// ── Session stats ─────────────────────────────────────────────────────────────

function _dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function _loadStats(dateKey) {
  const key = `stats_${dateKey}`;
  const data = await _storage().get(key);
  return data[key] || { domains: {}, sessionCount: 0 };
}

async function _saveStats(dateKey, stats) {
  await _storage().set({ [`stats_${dateKey}`]: stats });
}


/**
 * getStatsToday(dateKey?)
 * Returns { totalTime, domainCount, sessionCount }
 */
async function getStatsToday(dateKey) {
  const key = dateKey || _dateKey();
  const stats = await _loadStats(key);
  const totalTime = Object.values(stats.domains).reduce((s, d) => s + d.totalTime, 0);
  return {
    totalTime,
    domainCount: Object.keys(stats.domains).length,
    sessionCount: stats.sessionCount,
  };
}

/**
 * getStatsDomains(dateKey?)
 * Returns { domains: [{ domain, totalTime, sessionCount }] } sorted by totalTime desc, top 10.
 */
async function getStatsDomains(dateKey) {
  const key = dateKey || _dateKey();
  const stats = await _loadStats(key);
  const domains = Object.entries(stats.domains)
    .map(([domain, d]) => ({ domain, totalTime: d.totalTime, sessionCount: d.sessionCount }))
    .sort((a, b) => b.totalTime - a.totalTime)
    .slice(0, 10);
  return { domains };
}

/**
 * getStatsTrends()
 * Returns { trends: [{ date, totalTime, sessionCount }] } for last 7 days.
 */
async function getStatsTrends() {
  const keys = [];
  for (let i = 6; i >= 0; i--) {
    keys.push(_dateKey(new Date(Date.now() - i * 86400000)));
  }
  const storageKeys = keys.map(k => `stats_${k}`);
  const data = await _storage().get(storageKeys);
  const trends = keys.map(date => {
    const stats = data[`stats_${date}`] || { domains: {}, sessionCount: 0 };
    const totalTime = Object.values(stats.domains).reduce((s, d) => s + d.totalTime, 0);
    return { date, totalTime, sessionCount: stats.sessionCount };
  });
  return { trends };
}

