# Using the Release Management Intelligence Tool

The tool is fully self-contained in a single HTML file. Browsers apply security restrictions when opening HTML files directly from disk (`file://` protocol), which can prevent localStorage, service worker and download features from working correctly.

**There are three ways to use it — choose the one that suits you.**

---

## Option 1 — Use it online (recommended for most people)

Visit the tool directly. No installation. Your data never leaves your machine.

**[https://Zeus-17.github.io/release-management-intelligence/](https://Zeus-17.github.io/release-management-intelligence/)**

Works in Chrome, Edge, Firefox and Safari. The tool is always current — the service worker ensures every visit loads the latest version automatically.

---

## Option 2 — Install it as a desktop app (recommended for offline use)

The tool is a Progressive Web App (PWA). After visiting the URL above once, you can install it as a standalone desktop application that works fully offline.

**In Chrome or Edge:**
1. Visit the URL above
2. Look for the install icon (⊞) in the address bar — right side
3. Click it and select **Install**
4. Opens as a standalone app — find it in Start Menu as **Release Management Intelligence**

**On mobile (iOS/Android):**
1. Visit the URL in Safari (iOS) or Chrome (Android)
2. Tap Share → **Add to Home Screen**
3. Installs as an app icon on your home screen

Once installed, the tool works completely offline. Your data is stored in the app and persists across sessions.

---

## Option 3 — Download and run locally

If you prefer to keep a local copy:

**Step 1** — Download the main file:  
[`rm-tool-v1.html`](rm-tool-v1.html) — right-click → Save As

You also need these two files in the same folder for PWA and auto-update features:  
[`rm-manifest.json`](rm-manifest.json) · [`rm-sw.js`](rm-sw.js) · [`rm-content-v1.json`](rm-content-v1.json)

**Step 2** — Run a local server (required — opening the file directly has browser restrictions):

**Python** (available on most systems):
```bash
# Navigate to your download folder
cd "C:\Users\YourName\Downloads\rm-tool"

# Start server
python -m http.server 3031
```
Then open: `http://localhost:3031/rm-tool-v1.html`

**Node.js** (if installed):
```bash
cd "C:\Users\YourName\Downloads\rm-tool"
npx serve .
```
Open the URL shown in the terminal.

Stop the server when done: `Ctrl+C`

---

## Auto-updates

When using Option 1 or 2 (online / PWA), the tool updates automatically every time you open it — no action needed. The service worker clears stale caches and loads the latest version from GitHub. Framework guidance (ITIL 4, DORA, FCA) updates separately via the content layer and is checked on every load.

For Option 3 (local copy), re-download the files periodically to get the latest version.

---

## Your data

Everything you enter stays in **your browser's localStorage only**. Nothing is sent to any server. Use Settings → Export JSON to back up your releases, and Import JSON to restore — useful when switching devices or browsers.

---

## Files in this repository

| File | Purpose |
|---|---|
| `rm-tool-v1.html` | Main application — the complete tool |
| `rm-content-v1.json` | Framework and regulatory content layer — auto-fetched on load |
| `rm-manifest.json` | PWA configuration — enables Install button |
| `rm-sw.js` | Service worker — enables offline use and auto-updates |
| `rm-showcase.html` | Product showcase / landing page |
| `index.html` | Redirect — makes the GitHub Pages root URL work |
| `HOW-TO-RUN-LOCALLY.md` | This file |
| `README.md` | Full feature documentation |
| `LICENSE` | Permitted use, regulatory notice, no-liability clause |
