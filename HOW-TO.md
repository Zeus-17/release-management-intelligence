# HOW-TO — Maintainer Guide

This guide is for James. Everything needed to run, update, version and publish the Release Management Intelligence Tool.

---

## Running locally

**Option 1 — Direct file open (simplest)**
Double-click `rm-tool-v1.html` in Windows Explorer. Opens in your default browser. All features work including localStorage persistence.

**Option 2 — Local server (for content update testing)**
```powershell
# In the tool directory
python -m http.server 3031
# Then open: http://localhost:3031
```

**Option 3 — Claude Code preview server**
If working in Claude Code, `preview_start('rm-tool')` starts the server automatically using the `.claude/launch.json` config.

---

## Updating the content layer (no app change needed)

The content layer (`rm-content-v1.json`) holds all framework guidance, glossary additions, AI rule overrides and regulatory notices. Update this file when ITIL, DORA, FCA or SAFe publish material changes — the app fetches it automatically.

**Steps:**
1. Edit `rm-content-v1.json`
2. Increment `meta.content_version` to today's date (format: `YYYY-MM-DD`)
3. Update `meta.next_review` to the next quarterly review date
4. Add a note to `meta.changelog`
5. Commit and push to GitHub main branch
6. All users will see "Framework guidance updated to [date]" toast within 24 hours (or immediately on manual check)

**To add a new glossary term without an app update:**
```json
"glossary_additions": [
  {
    "term": "Your New Term",
    "def": "Definition here.",
    "source": "ITIL 4 (current edition)"
  }
]
```

**To override an AI rule hint (e.g. if DORA thresholds change):**
```json
"ai_rule_overrides": {
  "payment": {
    "hint": "Updated regulatory hint text...",
    "level": "danger"
  }
}
```

---

## Incrementing the version (when adding features)

Every time you add a meaningful feature or fix:

1. Open `rm-tool-v1.html`
2. Find `const TOOL_VERSION = '1.6';` (search for `TOOL_VERSION`)
3. Increment: `'1.6'` → `'1.7'` (or `'2.0'` for a major new feature set)
4. Find the changelog modal HTML (search for `changelog-version-block`)
5. Add a new version block at the **top** (before v1.6):

```html
<!-- v1.7 -->
<div class="changelog-version-block">
  <div class="changelog-version-tag">
    <span class="changelog-ver-num">v1.7</span>
    <span class="changelog-ver-date">Month Year</span>
    <span class="changelog-ver-current">Current</span>
  </div>
  <div class="changelog-section-title">Feature category</div>
  <div class="changelog-item">Description of what was added</div>
</div>
```

6. Remove the `<span class="changelog-ver-current">Current</span>` from the previous version block (v1.6)
7. Update the header version badge: search for `v1.6` in the header HTML and change it
8. Update the four items that should always be updated when features change:
   - **Tour steps** — if you added a new tab or major feature
   - **Practice scenarios** — if new data fields exist that scenarios should pre-populate
   - **Welcome overlay** — if the description of what the tool does has changed
   - **Version + changelog** — (done above)

---

## The four items to update with every significant change

This is the rule established during development. Always update before publishing:

| Item | Where to find it | Why |
|---|---|---|
| Tour steps | Search `const obSteps` | Returning users will take the tour; stale descriptions mislead |
| Practice scenarios | Search `const SCENARIOS` | Scenarios pre-populate fields; missing v1.x data fields are obvious |
| Welcome overlay | Search `welcome-choice-sub` | First impression; descriptions must match current reality |
| Version + changelog | Search `TOOL_VERSION` | Auto-show mechanic depends on version string being updated |

---

## Pushing to GitHub

**First-time setup:**
```powershell
cd "C:\Users\James Holford\Desktop\Learning stuff\My Release Management tool"
git init
git remote add origin https://github.com/zeus-17/release-management-intelligence.git
```

**Regular push:**
```powershell
git add .
git commit -m "v1.6 — [brief description of what changed]"
git push origin main
```

**GitHub Pages setup (one-time):**
1. Go to the repo on GitHub
2. Settings → Pages
3. Source: Deploy from a branch → main → / (root)
4. Save — site will be live at `https://zeus-17.github.io/release-management-intelligence/`

**After GitHub Pages is live:**
The content JSON URL in the tool (`GITHUB_CONTENT_URL`) is already pointing to the right place:
```
https://raw.githubusercontent.com/zeus-17/release-management-intelligence/main/rm-content-v1.json
```
This means updating `rm-content-v1.json` on GitHub automatically delivers updated guidance to all users within 24 hours.

---

## Files to include in GitHub (and why)

| File | Include | Reason |
|---|---|---|
| `rm-tool-v1.html` | ✅ | Main application |
| `rm-content-v1.json` | ✅ | Content layer — fetched by all users |
| `rm-manifest.json` | ✅ | PWA — makes it installable |
| `rm-sw.js` | ✅ | Service worker — cache management |
| `rm-showcase.html` | ✅ | Landing page / demo |
| `index.html` | ✅ | Redirect — makes GitHub Pages URL work cleanly |
| `LICENSE` | ✅ | Required for any public repo |
| `README.md` | ✅ | GitHub displays this automatically |
| `HOW-TO.md` | ✅ | This file |
| `.claude/` | ❌ | Local Claude Code config — don't publish |
| `files_latest/` | ❌ | That's the ITSM tool, not this one |

---

## Adding a new tool in future

If you build a third tool (e.g. a Service Management tool):

1. Create its directory: `My New Tool\`
2. Create `index.html` redirect in that directory
3. Add its server to **both** `.claude/launch.json` files (ITSM tool and RM tool) with a unique port (start from 3032 upwards)
4. Create a new GitHub repo for it
5. Follow the same single-HTML architecture

---

## Key architectural decisions (for reference)

| Decision | Reason |
|---|---|
| Single HTML file | No build process; anyone can open it; portable |
| `rm-tool-v1.html` filename never changes | Git history stays clean; no broken links; "v1" = Generation 1 |
| Content in JSON, not HTML | Framework guidance can update without app changes |
| localStorage, not a database | No server, no accounts, no GDPR complexity |
| Deterministic AI rules, not generative | Consistent, auditable, no API dependency, works offline |
| ITIL 4 explicitly stated | Credibility, discoverability, honesty about what's implemented |

---

## Contact / LinkedIn

For commercial licensing or enquiries: [linkedin.com/in/james-holford-z17](https://www.linkedin.com/in/james-holford-z17/)
