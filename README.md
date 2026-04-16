<h1 align="left"><img src="extension/icons/icon.svg" width="32" valign="middle" /> Swoosh</h1>

**Keep tabs on your tabs.**

Swoosh replaces your Chrome new tab page with a dashboard that shows everything you have open -- grouped by domain, with landing pages (Gmail, X, LinkedIn, etc.) pulled into their own group for easy cleanup. Close tabs with a satisfying swoosh + confetti.

Built for people who open too many tabs and never close them.

---

## Install

### Option 1: Download Release (Recommended)
1. Download the latest `Swoosh.zip` from the [Releases page](https://github.com/akshatagrawal22/Swoosh/releases)
2. Unzip the file
3. Go to `chrome://extensions` in Chrome
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked**
6. Select the `extension/` folder from the unzipped directory

### Option 2: From Source
1. Clone this repository
2. Go to `chrome://extensions` in Chrome
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder from this repo

Open a new tab — you'll see Swoosh.

---

## Features

- **All tabs, one view** -- grouped by domain on a clean grid
- **Universal search** -- `/` or `Cmd+K` to find tabs and search Google
- **Landing pages** -- Gmail, YouTube, LinkedIn grouped together
- **Duplicate cleanup** -- one-click to close extra copies
- **Stale tabs** -- tabs idle 4+ hours surfaced for cleanup
- **Save for later** -- bookmark tabs to a checklist before closing
- **Light + dark mode** -- with cool and warm color palettes

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT
