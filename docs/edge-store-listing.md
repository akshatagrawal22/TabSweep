# Swoosh — Microsoft Edge Add-ons Store Listing

## Submission checklist

- [ ] Microsoft Partner Center account created (partner.microsoft.com)
- [ ] Privacy policy hosted (enable GitHub Pages on the repo, URL below)
- [ ] Extension ZIP built (`extension/` folder contents, no parent folder)
- [ ] At least one screenshot (1280×800 or 640×400 PNG/JPG)
- [ ] Small promo tile (440×280 PNG/JPG) — optional but recommended

---

## Extension package

ZIP the **contents** of `extension/` (not the folder itself):

```
app.js
background.js
manifest.json
newtab.html
storage.js
style.css
fonts/
icons/
```

Command:
```bash
cd extension && zip -r ../swoosh-1.3.0.zip . && cd ..
```

---

## Store listing copy

### Name
```
Swoosh
```

### Short description (max 250 characters)
```
Keep tabs on your tabs. Replaces your new tab page with a clean dashboard that groups all open tabs by domain — universal search, duplicate cleanup, and save links for later.
```
Character count: 173 ✓

### Detailed description
```
Swoosh replaces your new tab page with a dashboard that actually helps you manage your tabs.

SEE EVERYTHING AT ONCE
All your open tabs are grouped by domain on a clean grid. No more squinting at 30 tiny tab titles — you can see what you have open at a glance.

UNIVERSAL SEARCH
Press / or Cmd+K to search your tabs and Google simultaneously. Arrow keys to navigate, Enter to switch or search.

LANDING PAGES GROUP
Gmail, YouTube, LinkedIn, X, GitHub pulled into their own card — close them all with one click.

DUPLICATE CLEANUP
Flags duplicate tabs with one-click cleanup.

STALE TAB DETECTION
Tabs idle for 4+ hours surfaced. Save & close bookmarks them before removing.

SAVE FOR LATER
Bookmark tabs to a checklist before closing. Come back any time.

LIGHT + DARK MODE
Toggle between cool (blue) and warm (amber) palettes.

PRIVACY-FIRST
Your tabs stay on your device. External requests limited to favicons and search suggestions only.
```

### Category
```
Productivity
```

### Privacy policy URL
```
https://akshatagrawal22.github.io/Swoosh/privacy-policy.html
```

---

## Permissions justification

When prompted to justify permissions during submission, use these:

| Permission | Justification |
|------------|--------------|
| `tabs` | Required to read tab URLs and titles to display them grouped by domain on the dashboard. |
| `activeTab` | Required to detect which tab has focus so session timing per domain works correctly. |
| `storage` | Required to persist "Saved for later" tabs and daily usage stats locally on the user's device. |
| `topSites` | Required to display your most visited sites for quick access. |
| `bookmarks` | Required to save stale tabs to a bookmark folder before closing them. |

Host permissions for `suggestqueries.google.com` and `www.google.com` are used to power the universal search dropdown with Google suggestions.

---

## GitHub Pages setup (for privacy policy hosting)

1. Go to github.com/akshatagrawal22/Swoosh → Settings → Pages
2. Source: Deploy from a branch → branch: `main` → folder: `/docs`
3. Save — URL will be: `https://akshatagrawal22.github.io/Swoosh/privacy-policy.html`

Wait ~5 minutes for GitHub Pages to publish before submitting.

---

## Submission steps (Partner Center)

1. Go to partner.microsoft.com/en-us/dashboard → register with a Microsoft account (free)
2. Dashboard → Add-ons → New extension
3. Upload `swoosh-1.3.0.zip`
4. Fill in listing: name, descriptions, category (Productivity)
5. Paste privacy policy URL
6. Upload screenshot(s)
7. Submit — review takes ~7 business days

---

## Version notes (for "What's new" on future updates)

**1.3.0** — Universal search, palette toggle, session persistence
- Universal search: `/` or `Cmd+K` opens dropdown with tabs + Google suggestions
- Palette toggle: switch between cool (blue) and warm (amber) palettes
- Session timestamps persist across service worker restarts
- Stale tab threshold raised to 4 hours
- Save & close for stale tabs: bookmarks to folder before closing

**1.1.0** — Initial release
- Groups open tabs by domain on a clean new tab dashboard
- Landing pages group (Gmail, YouTube, LinkedIn, etc.)
- Duplicate and stale tab detection
- Save for later checklist
- Swoosh + confetti when closing a group
- 100% local, no server required
