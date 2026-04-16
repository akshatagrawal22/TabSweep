/* ================================================================
   TabSweep — Dashboard App

   This file is the brain of the dashboard. It:
   1. Talks to the Chrome extension (to read/close actual browser tabs)
   2. Groups open tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus)
   ================================================================ */

'use strict';

// Hide broken favicon images without inline event handlers (CSP-safe)
document.addEventListener('error', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('favicon-img')) {
    e.target.style.display = 'none';
  }
}, true);

/* ----------------------------------------------------------------
   CHROME API LAYER

   This page runs directly as the new-tab extension page, so we can
   call chrome.tabs.* APIs directly without any postMessage bridge.
   ---------------------------------------------------------------- */

const INTERNAL_PREFIXES = ['chrome://', 'chrome-extension://', 'about:', 'edge://', 'brave://'];

let openTabs = [];

/**
 * fetchOpenTabs()
 * Reads all open tabs directly via chrome.tabs.query, enriched with
 * lastActivated timestamps from the background service worker.
 */
async function fetchOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    // Get lastActivated map from background
    let lastActivated = {};
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'getTabActivity' });
      if (resp && resp.lastActivated) lastActivated = resp.lastActivated;
    } catch {}

    openTabs = tabs
      .filter(t => {
        const url = t.url || '';
        if (url === 'chrome://newtab/' || url === 'edge://newtab/' || url === 'about:newtab') return true;
        if (url === 'chrome://extensions/' || url === 'edge://extensions/') return true;
        if (url === 'chrome://newtab/' || url === 'edge://newtab/' || url === 'about:newtab') return true;
        if (url === 'chrome://extensions/' || url === 'edge://extensions/') return true;
        return !INTERNAL_PREFIXES.some(p => url.startsWith(p));
      })
      .map(t => ({ ...t, lastActivated: lastActivated[t.id] || null }));

  } catch {
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls, exact)
 * Closes all tabs whose URL matches the given list.
 */
async function closeTabsByUrls(urls, exact = false) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const all = await chrome.tabs.query({});
  const ids = all
    .filter(t => exact ? urlSet.has(t.url) : urls.some(u => t.url && t.url.startsWith(u.replace(/\/$/, ''))))
    .map(t => t.id);
  if (ids.length > 0) await chrome.tabs.remove(ids);
  await fetchOpenTabs();
}

/**
 * focusTabsByUrls(urls)
 * Switches to the first tab matching one of the given URLs.
 */
async function focusTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;
  const all = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  for (const url of urls) {
    // Prefer tabs in other windows first (not behind this new tab page)
    let match = all.find(t => t.url === url && t.windowId !== currentWindow.id);
    if (!match) match = all.find(t => t.url === url);
    if (!match) match = all.find(t => { try { return new URL(t.url).hostname === new URL(url).hostname; } catch { return false; } });
    if (match) {
      await chrome.tabs.update(match.id, { active: true });
      await chrome.windows.update(match.windowId, { focused: true });
      return;
    }
  }
}

/**
 * closeDuplicates(urls, keepOne)
 * For each URL, closes duplicate tabs (optionally keeping one).
 */
async function closeDuplicates(urls, keepOne = true) {
  const all = await chrome.tabs.query({});
  const ids = [];
  for (const url of urls) {
    const matching = all.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const t of matching) { if (t.id !== keep.id) ids.push(t.id); }
    } else {
      matching.forEach(t => ids.push(t.id));
    }
  }
  if (ids.length > 0) await chrome.tabs.remove(ids);
  await fetchOpenTabs();
}

// Listen for tab-change notifications from the background service worker.
let refreshTimer = null;
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'tabsChanged') {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      renderDashboard();
    }, 300);
  }
});


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * showToast(message)
 *
 * Shows a brief pop-up notification at the bottom of the screen.
 * Like the little notification that pops up when you send a message.
 */
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

function playCloseSound() {
  try {
    const ctx = getAudioCtx();
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;

    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);
  } catch {
    // Audio not supported
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 *
 * Each particle:
 * - Is either a circle or a square (randomly chosen)
 * - Uses the dashboard's color palette: amber, sage, slate, with some light variants
 * - Flies outward in a random direction with a gravity arc
 * - Fades out over ~800ms, then is removed from the DOM
 *
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  // Color palette drawn from the dashboard's CSS variables
  const colors = [
    '#4149d8', // primary
    '#8a92f0', // primary light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    // Randomly decide: circle or square
    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px

    // Pick a random color from the palette
    const color = colors[Math.floor(Math.random() * colors.length)];

    // Style the particle
    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle  = Math.random() * Math.PI * 2;           // random direction (radians)
    const speed  = 60 + Math.random() * 120;              // px/second
    const vx     = Math.cos(angle) * speed;               // horizontal velocity
    const vy     = Math.sin(angle) * speed - 80;          // vertical: bias upward a bit
    const gravity = 200;                                   // downward pull (px/s²)

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200;          // 700–900ms

    // Animate with requestAnimationFrame for buttery-smooth motion
    function frame(now) {
      const elapsed = (now - startTime) / 1000; // seconds
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) {
        el.remove();
        return;
      }

      // Position: initial velocity + gravity arc
      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;

      // Fade out during the second half of the animation
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;

      // Slight rotation for realism
      const rotate = elapsed * 200 * (isCircle ? 0 : 1); // squares spin, circles don't

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card in two phases:
 * 1. Fade out + scale down (GPU-accelerated, smooth)
 * 2. After fade completes, remove from DOM
 *
 * Also fires confetti from the card's center for a satisfying "done!" moment.
 */
function animateCardOut(card) {
  if (!card) return;

  // Get the card's center position on screen for the confetti origin
  const rect = card.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;

  // Shoot confetti from the card's center
  shootConfetti(cx, cy);

  // Phase 1: fade + scale down
  card.classList.add('closing');
  // Phase 2: remove from DOM after animation
  setTimeout(() => {
    card.remove();
    // After card is gone, check if the missions grid is now empty
    // and show the empty state if so
    checkAndShowEmptyState();
  }, 300);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Called after each card is removed from the DOM. If all mission cards
 * are gone (the grid is empty), we swap in a fun empty state instead of
 * showing a blank, lifeless grid.
 *
 */
function checkAndShowEmptyState() {

  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  // Count remaining mission cards (excludes anything already animating out)
  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  // All missions are gone — show the empty state
  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  // Update the section count to reflect the clear state
  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 missions';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * e.g. "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';

  const then = new Date(dateStr);
  const now = new Date();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting()
 *
 * Returns an appropriate greeting based on the current hour.
 * Morning = before noon, Afternoon = noon–5pm, Evening = after 5pm.
 * No name — TabSweep is for everyone now.
 */
function getGreeting() {
  const hour = new Date().getHours();
  const morning   = ['Good morning', 'Rise and shine', 'Hello, sunshine', 'Morning!'];
  const afternoon = ['Good afternoon', 'Hope your day\'s going well', 'Afternoon!', 'Keep it up'];
  const evening   = ['Good evening', 'Wind down time', 'Evening!', 'Almost there'];
  const pool = hour < 12 ? morning : hour < 17 ? afternoon : evening;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * getDateDisplay()
 *
 * Returns a formatted date string like "Friday, April 4, 2026".
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

function startClock() {
  const el = document.getElementById('clockDisplay');
  if (!el) return;
  function tick() {
    const now = new Date();
    const h = now.getHours() % 12 || 12;
    const m = String(now.getMinutes()).padStart(2, '0');
    const ampm = now.getHours() < 12 ? 'AM' : 'PM';
    el.textContent = `${h}:${m} ${ampm}`;
  }
  tick();
  setInterval(tick, 1000);
}

/* ----------------------------------------------------------------
   FREQUENT SITES + QUOTE + GOOGLE SEARCH
   ---------------------------------------------------------------- */

const QUOTES = [
  { text: 'Perfection is achieved not when there is nothing more to add, but when there is nothing left to take away.', author: 'Antoine de Saint-Exupéry' },
  { text: 'The best way to predict the future is to invent it.', author: 'Alan Kay' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'A place for everything, everything in its place.', author: 'Benjamin Franklin' },
  { text: 'The ability to simplify means to eliminate the unnecessary so that the necessary may speak.', author: 'Hans Hofmann' },
  { text: 'Focus is a matter of deciding what things you\'re not going to do.', author: 'John Carmack' },
  { text: 'It is not enough to be busy. The question is: what are we busy about?', author: 'Henry David Thoreau' },
  { text: 'Less is more.', author: 'Ludwig Mies van der Rohe' },
  { text: 'Clarity is the counterbalance of profound thoughts.', author: 'Luc de Clapiers' },
  { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
  { text: 'You can do anything, but not everything.', author: 'David Allen' },
  { text: 'Absorb what is useful, discard what is useless.', author: 'Bruce Lee' },
];

function renderQuote() {
  const el = document.getElementById('dailyQuote');
  if (!el) return;
  const q = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  el.innerHTML = `\u201C${q.text}\u201D<span class="quote-author">\u2014 ${q.author}</span>`;
}

async function renderFrequentSites() {
  const el = document.getElementById('frequentSites');
  if (!el) return;
  try {
    const sites = await chrome.topSites.get();
    const publicSites = sites.filter(s => {
      try {
        const h = new URL(s.url).hostname;
        return h && h !== 'localhost' && !h.startsWith('127.') && !h.startsWith('192.168.') && !h.startsWith('10.');
      } catch { return false; }
    });
    el.innerHTML = publicSites.slice(0, 5).map(site => {
      const domain = new URL(site.url).hostname;
      const favicon = site.favIconUrl || `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      return `<a href="${site.url}" title="${site.title}" class="freq-site-icon"><img src="${favicon}" width="24" height="24" alt="${site.title}" class="favicon-img"></a>`;
    }).join('');
  } catch { el.style.display = 'none'; }
}

/* ----------------------------------------------------------------
   SVG ICON STRINGS

   We store these as a constant so we can reuse them in buttons
   without writing raw SVG every time. Each value is an HTML string
   ready to be injected with innerHTML.
   ---------------------------------------------------------------- */
/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS

   Make domain names and tab titles more readable.
   - friendlyDomain() turns "github.com" into "GitHub"
   - cleanTitle() strips redundant site names from the end of titles
   ---------------------------------------------------------------- */

// Map of known domains → friendly display names.
// Covers the most common sites; everything else gets a smart fallback.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

/**
 * friendlyDomain(hostname)
 *
 * Turns a raw hostname into a human-readable name.
 * 1. Check the lookup map for known domains
 * 2. For subdomains of known domains, check if the parent matches
 *    (e.g. "docs.github.com" → "GitHub Docs")
 * 3. Fallback: strip "www.", strip TLD, capitalize
 *    (e.g. "minttr.com" → "Minttr", "blog.example.co.uk" → "Blog Example")
 */
function friendlyDomain(hostname) {
  if (!hostname) return '';

  // Direct lookup
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  // Check for *.substack.com pattern (e.g. "lenny.substack.com" → "Lenny's Substack")
  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    const sub = hostname.replace('.substack.com', '');
    return capitalize(sub) + "'s Substack";
  }

  // Check for *.github.io pattern
  if (hostname.endsWith('.github.io')) {
    const sub = hostname.replace('.github.io', '');
    return capitalize(sub) + ' (GitHub Pages)';
  }

  // Fallback: strip www, strip common TLDs, capitalize each word
  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  // If it's a subdomain like "blog.example", keep it readable
  return clean
    .split('.')
    .map(part => capitalize(part))
    .join(' ');
}

/**
 * capitalize(str)
 * "github" → "GitHub" (okay, just "Github" — but close enough for fallback)
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * stripTitleNoise(title)
 *
 * Removes common noise from browser tab titles:
 * - Leading notification counts: "(2) Vibe coding ideas" → "Vibe coding ideas"
 * - Trailing email addresses: "Subject - user@gmail.com" → "Subject"
 * - X/Twitter cruft: "Name on X: \"quote\" / X" → "Name: \"quote\""
 * - Trailing "/ X" or "| LinkedIn" etc (handled by cleanTitle, but the
 *   "on X:" pattern needs special handling here)
 */
function stripTitleNoise(title) {
  if (!title) return '';

  // 1. Strip leading notification count: "(2) Title" or "(99+) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');

  // 1b. Strip inline counts like "Inbox (16,359)" or "Messages (42)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');

  // 2. Strip email addresses anywhere in the title (privacy + cleaner display)
  //    Catches patterns like "Subject - user@example.com - Gmail"
  //    First remove "- email@domain.com" segments (with separator)
  title = title.replace(/\s*[\-\u2010\u2011\u2012\u2013\u2014\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  //    Then catch any remaining bare email addresses
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');

  // 3. Clean up X/Twitter title format: "Name on X: \"quote text\"" → "Name: \"quote text\""
  title = title.replace(/\s+on X:\s*/, ': ');

  // 4. Strip trailing "/ X" (X/Twitter appends this)
  title = title.replace(/\s*\/\s*X\s*$/, '');

  return title.trim();
}

/**
 * cleanTitle(title, hostname)
 *
 * Strips redundant site name suffixes from tab titles.
 * Many sites append their name: "Article Title - Medium" or "Post | Reddit"
 * If the suffix matches the domain, we remove it for a cleaner look.
 */
function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain = hostname.replace(/^www\./, '');

  // Common separator patterns at the end of titles
  // "Article Title - Site Name", "Article Title | Site Name", "Article Title — Site Name"
  const separators = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of separators) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;

    const suffix = title.slice(idx + sep.length).trim();
    const suffixLower = suffix.toLowerCase();

    // Check if the suffix matches the domain name, friendly name, or common variations
    if (
      suffixLower === domain.toLowerCase() ||
      suffixLower === friendly.toLowerCase() ||
      suffixLower === domain.replace(/\.\w+$/, '').toLowerCase() || // "github" from "github.com"
      domain.toLowerCase().includes(suffixLower) ||
      friendly.toLowerCase().includes(suffixLower)
    ) {
      const cleaned = title.slice(0, idx).trim();
      // Only strip if we're left with something meaningful (at least 5 chars)
      if (cleaned.length >= 5) return cleaned;
    }
  }

  return title;
}

/**
 * smartTitle(title, url)
 *
 * When the tab title is useless (just the URL, or a generic site name),
 * try to extract something meaningful from the URL itself.
 * Works for X/Twitter posts, GitHub repos, YouTube videos, Reddit threads, etc.
 */
function smartTitle(title, url) {
  if (!url) return title || '';

  let pathname = '';
  let hostname = '';
  try {
    const u = new URL(url);
    pathname = u.pathname;
    hostname = u.hostname;
  } catch {
    return title || '';
  }

  // Check if the title is basically just the URL (useless)
  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  // X / Twitter — extract @username from /username/status/123456 URLs
  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) {
      // If the title has actual content (not just URL), clean it and keep it
      if (!titleIsUrl) return title;
      return `Post by @${username}`;
    }
  }

  // GitHub — extract owner/repo or owner/repo/path context
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      if (parts[2] === 'issues' && parts[3]) return `${owner}/${repo} Issue #${parts[3]}`;
      if (parts[2] === 'pull' && parts[3]) return `${owner}/${repo} PR #${parts[3]}`;
      if (parts[2] === 'blob' || parts[2] === 'tree') return `${owner}/${repo} — ${parts.slice(4).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  // YouTube — if title is just a URL, at least say "YouTube Video"
  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  // Reddit — extract subreddit and post hint from URL
  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      const sub = parts[subIdx + 1];
      if (titleIsUrl) return `r/${sub} post`;
    }
  }

  return title || url;
}


const ICONS = {
  // Tab/browser icon — used in the "N tabs open" badge
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,

  // X / close icon — used in "Close N tabs" button
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,

  // Archive / trash icon — used in "Close & archive" button
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,

  // Arrow up-right — used in "Focus on this" button
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,

  pin: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25v3.75m0 0H18a2.25 2.25 0 0 1 0 4.5h-1.5m-2.25-8.25H8.25m7.5 0v-1.5A1.5 1.5 0 0 0 14.25 2.25h-4.5A1.5 1.5 0 0 0 8.25 3.75v1.5m0 0v3.75m0 0H6a2.25 2.25 0 0 0 0 4.5h2.25m3.75 0v7.5m0-7.5h-3.75m3.75 0h3.75" /></svg>`
};


/* ----------------------------------------------------------------
   DOMAIN CATEGORY COLOR-CODING
   Maps hostname patterns to categories for the colored top bar on cards.
   ---------------------------------------------------------------- */
const DOMAIN_CATEGORIES = {
  work: [
    'docs.google.com', 'drive.google.com', 'sheets.google.com', 'slides.google.com',
    'notion.so', 'slack.com', 'teams.microsoft.com', 'office.com',
    'sharepoint.com', 'rilcloud-my.sharepoint.com',
    'outlook.office.com', 'outlook.live.com',
  ],
  work_partial: ['jira', 'confluence', 'azure', 'atlassian'],
  social: [
    'twitter.com', 'x.com', 'linkedin.com', 'facebook.com',
    'reddit.com', 'instagram.com', 'threads.net',
  ],
  dev: [
    'github.com', 'gitlab.com', 'stackoverflow.com', 'npmjs.com',
    'localhost', 'codepen.io', 'codesandbox.io',
  ],
  media: [
    'youtube.com', 'netflix.com', 'spotify.com', 'twitch.tv',
    'music.youtube.com', 'podcasts.apple.com',
  ],
};

function getDomainCategory(domain) {
  if (!domain || domain.startsWith('__')) return 'default';
  const d = domain.toLowerCase();
  for (const [cat, hosts] of Object.entries(DOMAIN_CATEGORIES)) {
    if (cat.endsWith('_partial')) {
      const baseCat = cat.replace('_partial', '');
      if (hosts.some(h => d.includes(h))) return baseCat;
    } else {
      if (hosts.includes(d)) return cat;
    }
  }
  return 'default';
}

/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS

   domainGroups is populated by renderStaticDashboard().
   ---------------------------------------------------------------- */
let domainGroups    = [];

const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
let currentStaleTabs = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   We call this in multiple places, so it lives in one spot.
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns all open tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc. We only want to show and manage actual websites.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    if (url.startsWith('chrome://extensions') || url.startsWith('edge://extensions')) return true;
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabSweepDupes()
 *
 * Counts how many TabSweep new-tab pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabSweepDupes() {
  const tabSweepTabs = openTabs.filter(t =>
    t.url === 'chrome://newtab/' || t.url === 'edge://newtab/' || t.url === 'about:newtab'
  );

  const banner  = document.getElementById('tabSweepDupeBanner');
  const countEl = document.getElementById('tabSweepDupeCount');
  if (!banner) return;

  if (tabSweepTabs.length > 1) {
    if (countEl) countEl.textContent = tabSweepTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER (for static default view)

   Groups open tabs by domain (e.g. all github.com tabs together)
   and renders a card per domain.
   ---------------------------------------------------------------- */

/**
 * buildOverflowChips(hiddenTabs, urlCounts)
 *
 * Builds the expandable "+N more" section for tab lists that exceed 8 items.
 * Returns HTML string with hidden chips and a clickable expand button.
 * Used by domain cards when there are more than 8 tabs.
 */
function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label   = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count   = urlCounts[tab.url] || 1;
    const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = (count > 1 ? ' chip-has-dupes' : '') + (tab.pinned ? ' chip-pinned' : '');
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const faviconUrl = tab.favIconUrl || (tab.url ? `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32` : '');
    const pinTag = tab.pinned ? `<span class="chip-pin-icon">${ICONS.pin}</span>` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${pinTag}${faviconUrl ? `<img class="chip-favicon favicon-img" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card in the static view.
 * "group" is: { domain, tabs: [{ url, title, tabId }] }
 *
 * Visually similar to renderOpenTabsMissionCard() but with a neutral
 * gray status bar (amber if duplicates exist).
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Detect duplicates within this domain group (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  // Tab count badge
  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  // Duplicate warning badge
  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color: var(--accent-amber); background: rgba(var(--accent-amber-rgb), 0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once with (Nx) badge if duplicated
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    }
  }
  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;
  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend the port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) {
        label = `${parsed.port} ${label}`;
      }
    } catch {}
    const count   = urlCounts[tab.url];
    const dupeTag = count > 1
      ? ` <span class="chip-dupe-badge">(${count}x)</span>`
      : '';
    const chipClass = (count > 1 ? ' chip-has-dupes' : '') + (tab.pinned ? ' chip-pinned' : '');
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    const faviconUrl = tab.favIconUrl || (tab.url ? `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32` : '');
    const pinTag = tab.pinned ? `<span class="chip-pin-icon">${ICONS.pin}</span>` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${pinTag}${faviconUrl ? `<img class="chip-favicon favicon-img" src="${faviconUrl}" alt="">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  const statusBarStyle = hasDupes ? ' style="background: var(--accent-amber);"' : '';

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  const cardName = isLanding ? 'Homepages' : friendlyDomain(group.domain);
  const category = getDomainCategory(group.domain);
  const catClass = category !== 'default' ? ` category-${category}` : '';
  const cardClass = (hasDupes ? 'has-amber-bar' : 'has-neutral-bar') + catClass;

  return `
    <div class="mission-card domain-card ${cardClass}" data-domain-id="${stableId}">
      <div class="status-bar"${statusBarStyle}></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${cardName}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   DEFERRED TABS — "Saved for Later" checklist column

   Fetches deferred tabs from the server and renders:
   1. Active items as a checklist (checkbox + title + dismiss)
   2. Archived items in a collapsible section with search
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Fetches all deferred tabs (active + archived) from the API and
 * renders them into the right-side column. Called on every dashboard
 * load.
 */
async function renderDeferredColumn() {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const archiveEl = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const data = await getDeferred();

    const active   = data.active || [];
    const archived = data.archived || [];

    if (active.length === 0) {
      if (column.style.display !== 'none') {
        column.classList.add('hiding');
        column.addEventListener('transitionend', function handler(evt) {
          if (evt.target !== column) return;
          column.removeEventListener('transitionend', handler);
          column.style.display = 'none';
          column.classList.remove('hiding');
        });
        setTimeout(() => {
          if (column.classList.contains('hiding')) {
            column.style.display = 'none';
            column.classList.remove('hiding');
          }
        }, 500);
      }
      return;
    }

    const wasHidden = column.style.display === 'none';
    column.classList.remove('hiding');
    if (wasHidden) {
      column.style.width = '0';
      column.style.opacity = '0';
      column.style.transform = 'translateY(8px)';
      column.style.display = 'block';
      void column.offsetWidth;
      column.style.width = '';
      column.style.opacity = '';
      column.style.transform = '';
    } else {
      column.style.display = 'block';
    }

    countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
    list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
    list.style.display = 'block';
    empty.style.display = 'none';

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tabsweep] Could not load deferred tabs:', err);
    if (column.style.display !== 'none') {
      column.classList.add('hiding');
      column.addEventListener('transitionend', function handler(evt) {
        if (evt.target !== column) return;
        column.removeEventListener('transitionend', handler);
        column.style.display = 'none';
        column.classList.remove('hiding');
      });
      setTimeout(() => {
        if (column.classList.contains('hiding')) {
          column.style.display = 'none';
          column.classList.remove('hiding');
        }
      }, 500);
    }
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds the HTML for a single checklist item in the Saved for Later column.
 * Each item has: checkbox, title (clickable link), domain, time ago, dismiss X.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = item.favicon_url || '';
  const ago = timeAgo(item.deferred_at);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          ${faviconUrl ? `<img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" class="favicon-img">` : ''}${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds the HTML for a single item in the collapsed archive list.
 * Simpler than active items — just title link + date.
 */
function renderArchiveItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = item.archived_at ? timeAgo(item.archived_at) : '';

  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER

   renderStaticDashboard() — groups open tabs by domain.
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main view. Loads instantly:
 * 1. Paint greeting + date
 * 2. Fetch open tabs from the extension
 * 3. Group tabs by domain (with landing pages pulled out)
 * 4. Render domain cards
 * 5. Update footer stats
 */
let lastTabSnapshot = '';
async function renderStaticDashboard() {
  // --- Header: greeting + date ---
  const greetingEl = document.getElementById('greeting');
  const dateEl     = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl)     dateEl.textContent     = getDateDisplay();

  renderQuote();
  renderFrequentSites(); // fire-and-forget, doesn't block tab rendering

  // ── Step 1: Fetch open tabs ───────────────────────────────────────────────
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  const snapshot = JSON.stringify(realTabs.map(t => t.url + '\t' + t.title).sort());
  if (snapshot === lastTabSnapshot) {
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    checkTabSweepDupes();
    return;
  }
  lastTabSnapshot = snapshot;

  // ── Step 3: Group open tabs by domain ────────────────────────────────────
  // This is pure JavaScript — no AI, no API calls. We extract the hostname
  // from each tab URL and group them together.
  //
  // Special case: "landing pages" — homepages / inboxes / feeds that you
  // keep open out of habit. These get pulled into their own group so you
  // can close them all at once instead of hunting across domain cards.
  // Landing pages are homepages, inboxes, and feeds. A specific email thread
  // or a specific tweet is NOT a landing page — those belong with their domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com',  test: (p, h) => {
      // Only the inbox itself, not individual emails.
      // Gmail inbox URLs end with #inbox (no message ID after it)
      // Individual emails look like #inbox/FMfcgz...
      return !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/');
    }},
    { hostname: 'x.com',                       pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',            pathExact: ['/'] },
    { hostname: 'github.com',                  pathExact: ['/'] },
    { hostname: 'www.youtube.com',             pathExact: ['/'] },
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        if (parsed.hostname !== p.hostname) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap = {};
  const landingTabs = [];

  for (const tab of realTabs) {
    try {
      // Check if this tab is a landing page first
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // file:// URLs have no hostname — group them under "Local Files"
      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue; // skip if still empty
      if (!groupMap[hostname]) {
        groupMap[hostname] = { domain: hostname, tabs: [] };
      }
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  // Add landing pages as a special group at the end (if any)
  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // ── Extract stale tabs into their own group ────────────────────────────
  const now = Date.now();
  const staleTabs = [];
  const staleUrlSet = new Set();
  for (const key of Object.keys(groupMap)) {
    const group = groupMap[key];
    const fresh = [];
    for (const tab of group.tabs) {
      const idle = tab.lastActivated ? (now - tab.lastActivated) : Infinity;
      if (idle >= STALE_THRESHOLD_MS && !tab.active && !tab.pinned) {
        staleTabs.push(tab);
        staleUrlSet.add(tab.url);
      } else {
        fresh.push(tab);
      }
    }
    group.tabs = fresh;
  }
  // Remove groups that became empty after extracting stale tabs
  for (const key of Object.keys(groupMap)) {
    if (groupMap[key].tabs.length === 0) delete groupMap[key];
  }
  currentStaleTabs = staleTabs;

  // Sort groups: landing pages first, then priority domains, then the rest by tab count
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname));
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = landingHostnames.has(a.domain);
    const bIsPriority = landingHostnames.has(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // ── Step 4: Render domain cards ───────────────────────────────────────────
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  const hasContent = domainGroups.length > 0 || staleTabs.length > 0;
  if (hasContent && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    if (domainGroups.length > 0) {
      const staleDomains = new Set(staleTabs.map(t => { try { return new URL(t.url).hostname; } catch { return t.url; } }));
      const totalDomains = domainGroups.length + staleDomains.size;
      openTabsSectionCount.innerHTML = `${totalDomains} domain${totalDomains !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
      openTabsMissionsEl.innerHTML = domainGroups
        .map((g, idx) => renderDomainCard(g, idx))
        .join('');
    } else {
      openTabsSectionCount.innerHTML = '';
      openTabsMissionsEl.innerHTML = '';
    }
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // ── Stale tabs banner ──────────────────────────────────────────────────
  const staleBanner = document.getElementById('staleBanner');
  if (staleBanner) {
    if (staleTabs.length > 0) {
      const label = document.getElementById('staleBannerLabel');
      const list  = document.getElementById('staleBannerList');
      const btn   = document.getElementById('staleBannerBtn');
      if (label) label.innerHTML = `You have <strong>${staleTabs.length}</strong> stale tab${staleTabs.length !== 1 ? 's' : ''} idle for a while. Close them? <span class="stale-info-icon" data-tip="Tabs with no activity for 4+ hours">?</span>`;
      if (btn) btn.textContent = `Close all`;
      if (list) list.innerHTML = staleTabs.map(t => {
        const encoded = encodeURIComponent(t.url);
        const faviconUrl = t.favIconUrl || (t.url ? `https://www.google.com/s2/favicons?domain=${new URL(t.url).hostname}&sz=32` : '');
        const favicon = faviconUrl
          ? `<img src="${faviconUrl}" width="14" height="14" style="border-radius:2px;" class="favicon-img">`
          : '';
        return `<span class="stale-tab-chip" data-action="focus-tab" data-tab-url="${t.url}">${favicon}<span class="stale-tab-title">${t.title || 'Untitled'}</span><span class="stale-tab-x" data-action="close-stale-tab" data-stale-url="${encoded}">&times;</span></span>`;
      }).join('');
      staleBanner.style.display = 'block';
    } else {
      staleBanner.style.display = 'none';
    }
  }

  // ── Footer stats ──────────────────────────────────────────────────────────
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;
  const statStale = document.getElementById('statStale');
  if (statStale) statStale.textContent = staleTabs.length;

  // ── Check for duplicate TabSweep tabs ────────────────────────────────────
  checkTabSweepDupes();

  // ── Step 9: Render the "Saved for Later" checklist column ────────────────
  await renderDeferredColumn();

  // ── Step 10: Render usage stats section ─────────────────────────────────
  renderStatsSection();
}


/* ----------------------------------------------------------------
   USAGE STATS — fetches session data from the server and renders
   summary tiles, domain breakdown, and 7-day trend chart.
   ---------------------------------------------------------------- */

function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return '<1m';
}

async function renderStatsSection() {
  const section = document.getElementById('statsSection');
  const grid    = document.getElementById('statsGrid');
  if (!section || !grid) return;

  try {
    const [today, { domains }, { trends }] = await Promise.all([
      getStatsToday(),
      getStatsDomains(),
      getStatsTrends(),
    ]);

    if (today.sessionCount === 0 && trends.length === 0) {
      section.style.display = 'none';
      return;
    }

    // Update footer "Active today" stat
    const statActiveTime = document.getElementById('statActiveTime');
    if (statActiveTime) statActiveTime.textContent = formatDuration(today.totalTime);

    // ── Summary tiles ──────────────────────────────────────────────────────
    const tilesHtml = `
      <div class="stats-tiles">
        <div class="stat-tile">
          <div class="stat-tile-num">${formatDuration(today.totalTime)}</div>
          <div class="stat-tile-label">Active time</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-num">${today.domainCount}</div>
          <div class="stat-tile-label">Domains visited</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-num">${today.sessionCount}</div>
          <div class="stat-tile-label">Sessions</div>
        </div>
      </div>`;

    // ── Top domains bar chart ──────────────────────────────────────────────
    const topDomains = domains.slice(0, 5);
    const maxTime = topDomains.length > 0 ? topDomains[0].totalTime : 1;
    const domainBarsHtml = topDomains.length > 0 ? `
      <div class="stats-panel">
        <div class="stats-panel-title">Top domains</div>
        ${topDomains.map(d => {
          const pct = Math.max(5, Math.round((d.totalTime / maxTime) * 100));
          return `<div class="domain-bar-row">
            <span class="domain-bar-label">${d.domain}</span>
            <div class="domain-bar-track">
              <div class="domain-bar-fill" style="width:${pct}%"></div>
            </div>
            <span class="domain-bar-time">${formatDuration(d.totalTime)}</span>
          </div>`;
        }).join('')}
      </div>` : '';

    // ── 7-day trend chart ──────────────────────────────────────────────────
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const entry = trends.find(t => t.date === key);
      last7.push({
        label: dayNames[d.getDay()],
        time: entry ? entry.totalTime : 0,
        isToday: i === 0,
      });
    }
    const trendMax = Math.max(...last7.map(d => d.time), 1);
    const trendHtml = `
      <div class="stats-panel">
        <div class="stats-panel-title">This week</div>
        <div class="trend-chart">
          ${last7.map(d => {
            const pct = Math.max(2, Math.round((d.time / trendMax) * 100));
            return `<div class="trend-col${d.isToday ? ' trend-today' : ''}">
              <div class="trend-bar" style="height:${pct}%" title="${formatDuration(d.time)}"></div>
              <div class="trend-label">${d.label}</div>
            </div>`;
          }).join('')}
        </div>
      </div>`;

    grid.innerHTML = tilesHtml + domainBarsHtml + trendHtml;
    section.style.display = 'block';
  } catch {
    section.style.display = 'none';
  }
}


/**
 * renderDashboard()
 *
 * Entry point — just calls renderStaticDashboard().
 * Guards against concurrent renders and coalesces back-to-back requests.
 */
let _renderInFlight = false;
let _renderQueued   = false;
async function renderDashboard() {
  if (_renderInFlight) {
    _renderQueued = true;
    return;
  }
  _renderInFlight = true;
  try {
    await renderStaticDashboard();
  } finally {
    _renderInFlight = false;
    if (_renderQueued) {
      _renderQueued = false;
      renderDashboard();
    }
  }
}


/* ----------------------------------------------------------------
   EVENT HANDLERS (using event delegation)

   Instead of attaching a listener to every button, we attach ONE
   listener to the whole document and check what was clicked.
   This is more efficient and works even after we re-render cards.

   Think of it like one security guard watching the whole building
   instead of one guard per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM from the clicked element to find the nearest
  // element with a data-action attribute
  const actionEl = e.target.closest('[data-action]');

  if (!actionEl) return; // click wasn't on an action button

  const action = actionEl.dataset.action;

  // --- Close duplicate TabSweep tabs ---
  if (action === 'close-tabsweep-dupes') {
    // Close all TabSweep new-tab pages except this one
    const all = await chrome.tabs.query({});
    const newTabUrls = ['chrome://newtab/', 'edge://newtab/', 'about:newtab'];
    const current = await chrome.tabs.getCurrent();
    const toClose = all.filter(t => t.id !== current?.id && newTabUrls.includes(t.url)).map(t => t.id);
    if (toClose.length > 0) await chrome.tabs.remove(toClose);
    await fetchOpenTabs();
    playCloseSound();
    const banner = document.getElementById('tabSweepDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra TabSweep tabs');
    return;
  }

  // Find the card element so we can animate it
  const card = actionEl.closest('.mission-card');

  // ---- expand-chips: show the hidden tabs in a card ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- focus-tab: switch to a specific open tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) {
      await focusTabsByUrls([tabUrl]);
    }
    return;
  }

  // ---- close-single-tab: close one specific tab by URL ----
  if (action === 'close-single-tab') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    await closeTabsByUrls([tabUrl], true);
    playCloseSound();

    // Remove the chip from the DOM with confetti
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If this was the last tab in the card, remove the whole card
        const card = document.querySelector(`.mission-card:has(.mission-pages:empty)`);
        if (card) {
          animateCardOut(card);
        }
        // Also check for cards where only overflow/non-tab chips remain
        document.querySelectorAll('.mission-card').forEach(c => {
          const remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
          if (remainingTabs.length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    showToast('Tab closed');
    return;
  }

  // ---- defer-single-tab: save one tab for later, then close it ----
  if (action === 'defer-single-tab') {
    e.stopPropagation(); // don't trigger the parent chip's focus-tab
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    const matchingTab = openTabs.find(t => t.url === tabUrl);
    const faviconUrl = matchingTab ? matchingTab.favIconUrl : null;

    // Save to the deferred list in storage
    try {
      await insertDeferred({ url: tabUrl, title: tabTitle, favicon_url: faviconUrl });
    } catch (err) {
      console.error('[tabsweep] Failed to defer tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in the browser
    await closeTabsByUrls([tabUrl], true);

    // Animate the chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    // Refresh the deferred column to show the new item
    await renderDeferredColumn();
    return;
  }

  // ---- check-deferred: check off a deferred tab (mark as read) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    try {
      await updateDeferred(id, { checked: true });
    } catch (err) {
      console.error('[tabsweep] Failed to check deferred tab:', err);
      return;
    }

    // Animate the item: add strikethrough, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh to update counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- dismiss-deferred: dismiss a deferred tab without reading ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    try {
      await updateDeferred(id, { dismissed: true });
    } catch (err) {
      console.error('[tabsweep] Failed to dismiss deferred tab:', err);
      return;
    }

    // Animate the item out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn(); // refresh counts and archive
      }, 300);
    }
    return;
  }

  // ---- close-stale-tab: close a single stale tab ----
  if (action === 'close-stale-tab') {
    e.stopPropagation();
    const url = decodeURIComponent(actionEl.dataset.staleUrl || '');
    if (!url) return;
    await closeTabsByUrls([url], true);
    playCloseSound();
    currentStaleTabs = currentStaleTabs.filter(t => t.url !== url);
    const chip = actionEl.closest('.stale-tab-chip') || actionEl;
    chip.style.transition = 'opacity 0.3s, transform 0.3s';
    chip.style.opacity = '0';
    chip.style.transform = 'scale(0.8)';
    setTimeout(() => chip.remove(), 300);
    const label = document.getElementById('staleBannerLabel');
    if (label) label.innerHTML = `You have <strong>${currentStaleTabs.length}</strong> stale tab${currentStaleTabs.length !== 1 ? 's' : ''} idle for a while. Close them? <span class="stale-info-icon" data-tip="Tabs with no activity for 4+ hours">?</span>`;
    if (currentStaleTabs.length === 0) {
      const staleBanner = document.getElementById('staleBanner');
      if (staleBanner) {
        staleBanner.style.transition = 'opacity 0.4s';
        staleBanner.style.opacity = '0';
        setTimeout(() => { staleBanner.style.display = 'none'; staleBanner.style.opacity = '1'; staleBanner.style.transition = ''; }, 400);
      }
    }
    showToast('Closed stale tab');
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    const statStale = document.getElementById('statStale');
    if (statStale) statStale.textContent = String(currentStaleTabs.length);
    return;
  }

  // ---- save-and-close-stale-tabs: bookmark all stale tabs, then close them ----
  if (action === 'save-and-close-stale-tabs') {
    if (currentStaleTabs.length === 0) return;
    const closable = currentStaleTabs.filter(t => !t.pinned);
    const skipped  = currentStaleTabs.length - closable.length;
    if (closable.length === 0) {
      showToast('No stale tabs to save (all pinned)');
      return;
    }

    const now = new Date();
    const dateLabel = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const timeLabel = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const folderTitle = `TabSweep — Stale ${dateLabel} ${timeLabel}`;

    // Save to bookmarks FIRST. If anything fails, abort and leave tabs open.
    try {
      const folder = await chrome.bookmarks.create({ parentId: '2', title: folderTitle });
      for (const tab of closable) {
        await chrome.bookmarks.create({
          parentId: folder.id,
          title: tab.title || tab.url,
          url: tab.url,
        });
      }
    } catch (err) {
      console.error('[tabsweep] Failed to save bookmarks:', err);
      showToast('Failed to save bookmarks — tabs not closed');
      return;
    }

    const urls = closable.map(t => t.url);
    await closeTabsByUrls(urls, true);
    playCloseSound();

    currentStaleTabs = currentStaleTabs.filter(t => t.pinned);
    if (currentStaleTabs.length === 0) {
      const staleBanner = document.getElementById('staleBanner');
      if (staleBanner) {
        staleBanner.style.transition = 'opacity 0.4s';
        staleBanner.style.opacity = '0';
        setTimeout(() => { staleBanner.style.display = 'none'; staleBanner.style.opacity = '1'; staleBanner.style.transition = ''; }, 400);
      }
    }

    let msg = `Saved ${urls.length} tab${urls.length !== 1 ? 's' : ''} to bookmarks & closed`;
    if (skipped > 0) msg += ` (skipped ${skipped} pinned)`;
    showToast(msg);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    const statStale = document.getElementById('statStale');
    if (statStale) statStale.textContent = String(currentStaleTabs.length);
    return;
  }

  // ---- close-stale-tabs: close all idle/stale tabs at once ----
  if (action === 'close-stale-tabs') {
    if (currentStaleTabs.length === 0) return;
    const closable = currentStaleTabs.filter(t => !t.pinned);
    const skipped  = currentStaleTabs.length - closable.length;
    const urls = closable.map(t => t.url);
    if (urls.length > 0) {
      await closeTabsByUrls(urls, true);
      playCloseSound();
    }
    currentStaleTabs = currentStaleTabs.filter(t => t.pinned);
    if (currentStaleTabs.length === 0) {
      const staleBanner = document.getElementById('staleBanner');
      if (staleBanner) {
        staleBanner.style.transition = 'opacity 0.4s';
        staleBanner.style.opacity = '0';
        setTimeout(() => { staleBanner.style.display = 'none'; staleBanner.style.opacity = '1'; staleBanner.style.transition = ''; }, 400);
      }
    }
    let msg = `Closed ${urls.length} stale tab${urls.length !== 1 ? 's' : ''}`;
    if (skipped > 0) msg += ` (skipped ${skipped} pinned)`;
    showToast(msg);
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    const statStale = document.getElementById('statStale');
    if (statStale) statStale.textContent = String(currentStaleTabs.length);
    return;
  }

  // ---- close-domain-tabs: close all tabs in a static domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    // Find the group by its stable ID
    const group = domainGroups.find(g => {
      const id = 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-');
      return id === domainId;
    });
    if (!group) return;

    const closable = group.tabs.filter(t => !t.pinned);
    const skipped  = group.tabs.length - closable.length;
    const urls = closable.map(t => t.url);
    const useExact = group.domain === '__landing-pages__';
    if (urls.length > 0) {
      await closeTabsByUrls(urls, useExact);
    }

    if (card) {
      playCloseSound();
      if (skipped === 0) animateCardOut(card);
    }

    if (skipped === 0) {
      const idx = domainGroups.indexOf(group);
      if (idx !== -1) domainGroups.splice(idx, 1);
    }

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain);
    let msg = `Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`;
    if (skipped > 0) msg += ` (skipped ${skipped} pinned)`;
    showToast(msg);

    // Update footer tab count
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- close-all-dupes: close every duplicate tab ----

  // ---- dedup-keep-one: close extras but keep one copy of each ----
  if (action === 'dedup-keep-one') {
    // URLs come from the button's data attribute (per-mission duplicates)
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicates(urls, true);
    playCloseSound();
    await fetchOpenTabs();

    // Remove the dupe button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove all (2x) badges and the "N duplicates" header badge from this card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity = '0';
        setTimeout(() => b.remove(), 200);
      });
      // Remove the amber "N duplicates" badge from the card header
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      // Remove amber highlight from the card border
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
      const statusBar = card.querySelector('.status-bar');
      if (statusBar) statusBar.style.background = '';
    }

    showToast(`Closed duplicates, kept one copy each`);
    return;
  }

  // ---- close-all-open-tabs: close every open tab (with confirmation) ----
  if (action === 'close-all-open-tabs') {
    if (!actionEl.dataset.confirmed) {
      const originalHtml = actionEl.innerHTML;
      actionEl.dataset.confirmed = 'pending';
      actionEl.innerHTML = `${ICONS.close} Sure? Click again`;
      actionEl.style.color = 'var(--accent-rose)';
      setTimeout(() => {
        delete actionEl.dataset.confirmed;
        actionEl.innerHTML = originalHtml;
        actionEl.style.color = '';
      }, 3000);
      return;
    }

    delete actionEl.dataset.confirmed;
    const allTabs = getRealTabs();
    const closable = allTabs.filter(t => !t.pinned);
    const skipped  = allTabs.length - closable.length;
    const allUrls = closable.map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    let msg = 'All tabs closed. Fresh start.';
    if (skipped > 0) msg = `Closed ${closable.length} tabs (skipped ${skipped} pinned)`;
    showToast(msg);
    return;
  }

});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.classList.toggle('open');
  }
});

// ---- Archive search — filter archived items as user types (debounced) ----
let archiveSearchTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id !== 'archiveSearch') return;

  if (archiveSearchTimer) clearTimeout(archiveSearchTimer);
  archiveSearchTimer = setTimeout(async () => {
    const q = e.target.value.trim();
    const archiveList = document.getElementById('archiveList');
    if (!archiveList) return;

    if (q.length < 2) {
      try {
        const data = await getDeferred();
        archiveList.innerHTML = (data.archived || []).map(item => renderArchiveItem(item)).join('');
      } catch {}
      return;
    }

    try {
      const results = await searchDeferred(q);
      archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
        || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
    } catch (err) {
      console.warn('[tabsweep] Archive search failed:', err);
    }
  }, 300);
});


/* ----------------------------------------------------------------
   UNIVERSAL SEARCH DROPDOWN (tabs + Google suggestions)
   Hotkeys: `/` or Cmd/Ctrl+K focuses the search input.
   Reuses: openTabs (app.js:29), focusTabsByUrls (app.js:79)
   ---------------------------------------------------------------- */

const USD_MAX_TAB_RESULTS    = 4;
const USD_MAX_GOOGLE_RESULTS = 6;
const USD_DEBOUNCE_MS        = 180;

const USD_SEARCH_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" /></svg>`;

let usdItems      = [];
let usdActiveIdx  = -1;
let usdFetchTimer = null;
let usdFetchSeq   = 0;

function usdEscapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function usdEl() { return document.getElementById('universalSearchDropdown'); }
function usdInputEl() { return document.getElementById('googleSearchInput'); }

function usdIsGoogleSearchResultTab(url) {
  try {
    const u = new URL(url);
    // Skip google.* search pages — matching a search box query against a prior
    // Google search tab almost always produces noise (the tab's ?q= parameter
    // will coincidentally include the typed substring).
    if (!/(^|\.)google\./i.test(u.hostname)) return false;
    return u.pathname === '/search' || u.pathname === '/imgres' || u.pathname.startsWith('/search/');
  } catch { return false; }
}

function usdIsNewTabPage(url) {
  if (!url) return true;
  if (url === 'chrome://newtab/' || url === 'edge://newtab/' || url === 'about:newtab') return true;
  // TabSweep's own override page lives at chrome-extension://<id>/newtab.html
  if (url.startsWith('chrome-extension://') && url.includes('/newtab.html')) return true;
  return false;
}

// Match on hostname + pathname so the match is always visible in the rendered
// row. Matching the raw query string surfaced tabs whose ?q= parameter just
// happened to contain the substring.
function usdUrlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).toLowerCase();
  } catch {
    return (url || '').toLowerCase();
  }
}

function usdEligibleTabs() {
  return openTabs.filter(t =>
    t.url && !usdIsGoogleSearchResultTab(t.url) && !usdIsNewTabPage(t.url)
  );
}

function usdSearchTabs(query) {
  const q = query.toLowerCase();
  const matches = usdEligibleTabs().filter(t => {
    const title = (t.title || '').toLowerCase();
    return title.includes(q) || usdUrlKey(t.url).includes(q);
  });
  matches.sort((a, b) => {
    const at = (a.title || '').toLowerCase().includes(q) ? 0 : 1;
    const bt = (b.title || '').toLowerCase().includes(q) ? 0 : 1;
    if (at !== bt) return at - bt;
    return (b.lastActivated || 0) - (a.lastActivated || 0);
  });
  return matches.slice(0, USD_MAX_TAB_RESULTS);
}

function usdRecentTabs() {
  return usdEligibleTabs()
    .slice()
    .sort((a, b) => (b.lastActivated || 0) - (a.lastActivated || 0))
    .slice(0, USD_MAX_TAB_RESULTS);
}

async function usdFetchGoogleSuggestions(query, seq) {
  try {
    const url = `https://suggestqueries.google.com/complete/search?client=chrome&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url);
    if (seq !== usdFetchSeq) return null;
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data) && Array.isArray(data[1])
      ? data[1].slice(0, USD_MAX_GOOGLE_RESULTS)
      : [];
  } catch {
    return [];
  }
}

function usdRender(tabs, suggestions) {
  usdItems = [
    ...tabs.map(t => ({ type: 'tab', tab: t })),
    ...suggestions.map(s => ({ type: 'google', query: s })),
  ];

  const el = usdEl();
  const input = usdInputEl();
  if (!el || !input) return;

  if (usdItems.length === 0) {
    el.hidden = true;
    el.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
    return;
  }

  const html = usdItems.map((item, idx) => {
    if (item.type === 'tab') {
      const t = item.tab;
      const favicon = t.favIconUrl
        ? `<img src="${usdEscapeHtml(t.favIconUrl)}" alt="">`
        : USD_SEARCH_ICON_SVG;
      let hostPath = '';
      try {
        const u = new URL(t.url);
        hostPath = u.hostname + (u.pathname && u.pathname !== '/' ? u.pathname : '');
      } catch {}
      return `<div class="usd-row usd-row-tab" role="option" data-usd-idx="${idx}">`
           +   `<span class="usd-row-icon">${favicon}</span>`
           +   `<span class="usd-row-text">${usdEscapeHtml(t.title || t.url)}`
           +     (hostPath ? `<span class="usd-row-url">— ${usdEscapeHtml(hostPath)}</span>` : '')
           +   `</span>`
           +   `<span class="usd-row-switch">Switch to Tab<span class="usd-row-switch-arrow">→</span></span>`
           + `</div>`;
    }
    return `<div class="usd-row usd-row-google" role="option" data-usd-idx="${idx}">`
         +   `<span class="usd-row-icon">${USD_SEARCH_ICON_SVG}</span>`
         +   `<span class="usd-row-text">${usdEscapeHtml(item.query)}</span>`
         + `</div>`;
  }).join('');

  el.innerHTML = html;
  el.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  usdActiveIdx = 0;
  usdUpdateActive();
}

function usdUpdateActive() {
  const el = usdEl();
  if (!el) return;
  el.querySelectorAll('.usd-row').forEach((row, i) => {
    const active = i === usdActiveIdx;
    row.classList.toggle('is-active', active);
    if (active) row.scrollIntoView({ block: 'nearest' });
  });
}

function usdHide() {
  const el = usdEl();
  const input = usdInputEl();
  if (el) { el.hidden = true; el.innerHTML = ''; }
  if (input) input.setAttribute('aria-expanded', 'false');
  usdItems = [];
  usdActiveIdx = -1;
}

function usdShowRecent() {
  if (usdFetchTimer) { clearTimeout(usdFetchTimer); usdFetchTimer = null; }
  usdRender(usdRecentTabs(), []);
}

function usdOnInput(e) {
  const query = e.target.value.trim();
  if (!query) { usdShowRecent(); return; }

  const tabs = usdSearchTabs(query);
  usdRender(tabs, []);

  if (usdFetchTimer) clearTimeout(usdFetchTimer);
  usdFetchTimer = setTimeout(async () => {
    usdFetchTimer = null;
    const seq = ++usdFetchSeq;
    const suggestions = await usdFetchGoogleSuggestions(query, seq);
    if (suggestions === null) return;
    if (e.target.value.trim() !== query) return;
    usdRender(tabs, suggestions);
  }, USD_DEBOUNCE_MS);
}

function usdCommit(item) {
  if (!item) return;
  if (item.type === 'tab') {
    focusTabsByUrls([item.tab.url]);
    usdHide();
  } else {
    const input = usdInputEl();
    const form  = document.getElementById('googleSearchForm');
    if (!input || !form) return;
    input.value = item.query;
    form.submit();
  }
}

document.addEventListener('input', (e) => {
  if (e.target.id === 'googleSearchInput') usdOnInput(e);
});

document.addEventListener('focusin', (e) => {
  if (e.target.id !== 'googleSearchInput') return;
  const val = e.target.value.trim();
  if (val) {
    usdOnInput({ target: e.target });
  } else {
    usdShowRecent();
  }
});

document.addEventListener('keydown', (e) => {
  const input = usdInputEl();
  if (!input) return;

  if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && document.activeElement !== input) {
    e.preventDefault();
    input.focus();
    input.select();
    return;
  }

  if (document.activeElement !== input) return;

  if (e.key === 'Escape') {
    const el = usdEl();
    if (el && !el.hidden) { usdHide(); e.preventDefault(); return; }
    input.value = '';
    input.blur();
    return;
  }

  const el = usdEl();
  if (!el || el.hidden || usdItems.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    usdActiveIdx = (usdActiveIdx + 1) % usdItems.length;
    usdUpdateActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    usdActiveIdx = (usdActiveIdx - 1 + usdItems.length) % usdItems.length;
    usdUpdateActive();
  } else if (e.key === 'Enter') {
    if (usdActiveIdx >= 0 && usdItems[usdActiveIdx]) {
      e.preventDefault();
      usdCommit(usdItems[usdActiveIdx]);
    }
  }
});

document.addEventListener('click', (e) => {
  const row = e.target.closest('.usd-row');
  if (row) {
    const idx = Number(row.dataset.usdIdx);
    if (Number.isFinite(idx)) usdCommit(usdItems[idx]);
    return;
  }
  if (!e.target.closest('.universal-search-wrap')) usdHide();
});


/* ----------------------------------------------------------------
   THEME + PALETTE TOGGLES
   theme: 'light' | 'dark' (null = system default)
   palette: 'cool' | 'warm' (default cool)
   Persisted in localStorage.
   ---------------------------------------------------------------- */

function applyTheme(theme) {
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');
}

function getEffectiveTheme() {
  const stored = localStorage.getItem('tabsweep-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyPalette(palette) {
  const root = document.documentElement;
  root.classList.remove('palette-cool', 'palette-warm');
  root.classList.add(palette === 'warm' ? 'palette-warm' : 'palette-cool');
}

function getEffectivePalette() {
  const stored = localStorage.getItem('tabsweep-palette');
  return stored === 'warm' ? 'warm' : 'cool';
}

applyTheme(getEffectiveTheme());
applyPalette(getEffectivePalette());

document.getElementById('themeToggle')?.addEventListener('click', () => {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem('tabsweep-theme', next);
  applyTheme(next);
});

document.getElementById('paletteToggle')?.addEventListener('click', () => {
  const next = getEffectivePalette() === 'warm' ? 'cool' : 'warm';
  localStorage.setItem('tabsweep-palette', next);
  applyPalette(next);
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  localStorage.removeItem('tabsweep-theme');
  applyTheme(e.matches ? 'dark' : 'light');
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
startClock();
renderDashboard();
