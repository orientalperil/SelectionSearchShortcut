# Plan: Selection Search Shortcut (cross-browser clone with adjacent-tab insertion)

Status: draft plan, no code written yet.
Target repo: `/home/admin/repos/SelectionSearchShortcut`
License: MIT

---

## 1. What we are cloning, and how we differ

Reference extension: **"Shortcut keys for selection search"** by *nex*
(`chromewebstore.google.com/detail/shortcut-keys-for-selecti/emceciddhgnjkmjmpjoahmdhibmifohp`).

Observed behavior of the reference (from its store listing):

| Aspect | Reference behavior |
| --- | --- |
| Trigger | Keyboard shortcut only (no toolbar UI, no context menu) |
| Default shortcuts | `Alt+1` = search in a **foreground** new tab; `Alt+Shift+1` = **background** new tab |
| Query source | The text currently selected in the active tab (also PDFs in Chrome's built-in viewer) |
| Search engine | The **browser's default** search engine, not hard-coded Google |
| Placement | New tab opens at the **far right end of the tab strip** |
| Config | Shortcuts remapped through `chrome://extensions/shortcuts` |
| Manifest | MV3, tiny (~9 KiB) |

**Our one functional difference:** the new tab must open **immediately to the right of the
current tab**, not at the end of the strip. Everything else (two commands, foreground /
background, remappable shortcuts, default search engine) is kept.

Additional requirement: ship for **both Chrome and Firefox**, MIT licensed.

### Non-goals (explicitly out of scope for v1)

- Toolbar popup, context-menu item, or omnibox keyword.
- Multiple/selectable search engines, or per-engine shortcuts.
- Search history, analytics, telemetry, or any network calls of our own.
- Any use of the clipboard.
- Safari / Edge-specific packaging (Edge will work as-is from the Chrome build).

### Naming

Do not reuse the reference extension's name or icon. Chosen name: **"Search Selection
Shortcut"** (used as the manifest `name`/`short_name` and throughout the repo).

---

## 2. Architecture at a glance

Three moving pieces, no persistent state:

1. **Command registration** (manifest `commands`) — two commands, both remappable by the user
   through the browser's own shortcut UI.
2. **Background event handler** (`commands.onCommand`) — the entire brain of the extension.
   Non-persistent: a service worker in Chrome, an event page in Firefox.
3. **Selection reader** — an ephemeral function injected into the active tab via
   `scripting.executeScript` at command time, returning `window.getSelection().toString()`.
   No statically declared content script, so nothing runs on pages until the user presses the key.

Flow for a single command press:

1. `tabs.query({active: true, currentWindow: true})` → the source tab (need `id`, `index`,
   `windowId`, `groupId`, `pinned`).
2. Inject the selection reader into that tab (`allFrames: true`); pick the best non-empty result.
3. If the selection is empty after normalization → do nothing, return.
4. `tabs.create({windowId, index: source.index + 1, active: <foreground?>, openerTabId: source.id})`
   → a blank tab already sitting in the right slot.
5. `search.query({text: selection, tabId: newTab.id})` → the browser's **default** search engine
   loads its results page into that specific tab.
6. Chrome only: if the source tab was in a tab group, `tabs.group({groupId, tabIds:[newTab.id]})`
   so the new tab joins the same group instead of visually splitting it.

The reason for the create-then-query split is important: `search.query` with a `disposition` of
`NEW_TAB` gives no control over tab index (that is exactly why the reference extension lands at
the end of the strip). Passing an explicit `tabId` instead lets us own tab creation — and
therefore the index and the foreground/background choice — while still deferring the actual
search URL to the browser's default engine. `tabId` and `disposition` are mutually exclusive in
both browsers, which is fine; we only ever pass `tabId`.

---

## 3. Manifest design

Single `manifest.json` shared by both browsers where possible.

Fields:

- `manifest_version`: 3.
- `name`, `description`, `version`, `icons` (16/32/48/128 PNG).
- `background`: declare **both** `service_worker` (Chrome uses it) and `scripts` (Firefox uses it),
  pointing at the same file. This is the documented cross-browser MV3 fallback; each browser
  ignores the key it does not support. Firefox only honors this reliably from **Firefox 121**, so
  set `browser_specific_settings.gecko.strict_min_version` accordingly (use `"128.0"` to sit on
  the current ESR).
  - Consequence for the source file: it must be written so it works both as a service worker
    (no DOM, no `window`) and as an event page script. Sticking to `chrome.*`/`browser.*` API
    calls only, with no top-level async work, satisfies both.
- `browser_specific_settings.gecko`: `id` (e.g. `selection-search-shortcut@<domain-or-github-user>`)
  and `strict_min_version`. Chrome ignores this key.
- `permissions`: `activeTab`, `scripting`, `search`.
  - **No host permissions**, and no `tabs` permission. `activeTab` is granted transiently when the
    user invokes one of our registered keyboard commands, which is exactly the moment we inject.
    `tabs.query`/`tabs.create` need no permission for the fields we use (`id`, `index`, `windowId`,
    `active`); we never read tab `url`/`title`.
  - Verify during implementation that Firefox also grants `activeTab` on command invocation (it
    should) — if it does not, fall back to `<all_urls>` **optional** host permissions for Firefox
    only, requested from the options page, rather than a required permission.
- `commands`: two entries.

| Command id | Description shown in the browser's shortcut UI | Suggested default |
| --- | --- | --- |
| `1-search-selection-foreground` | "Search selected text in a new tab to the right (switch to it)" | `Alt+1` |
| `2-search-selection-background` | "Search selected text in a new tab to the right (stay here)" | `Alt+Shift+1` |

Note on the `1-`/`2-` prefixes: Chrome's `chrome://extensions/shortcuts` page lists commands in
alphabetical order by command id, not manifest declaration order. Without a prefix,
`search-selection-background` sorts before `search-selection-foreground` ("b" < "f"), so
foreground would always appear second no matter how the manifest orders them. The numeric
prefix forces the intended reading order.

Notes on defaults:

- Keep the reference's `Alt+1` / `Alt+Shift+1` bindings — familiar and unlikely to clash with
  page shortcuts, though `Alt+1..9` is tab-switching (or virtual-desktop-switching, on many
  Linux window managers) on some platforms. Document that in the README and store listing, as
  the reference does for ChromeOS/macOS. In practice this means `Alt+1` may arrive with no
  default binding at all if the OS/WM grabs it first — Chrome silently leaves the command
  unbound rather than erroring, so this needs to be called out as a "bind it yourself" step,
  not just a "might conflict" note.
- Chrome allows at most 4 suggested keys; we use 2.
- Provide `default` plus `mac` overrides if `Alt` proves awkward on macOS (`Alt` maps to Option
  and can produce dead keys) — evaluate during testing (§9).
- Firefox parses the same `suggested_key` syntax; confirm both combos are accepted by
  `web-ext lint`.

If Chrome ever warns on the extra `background.scripts` key, or the two stores need diverging
metadata, split into `manifest.chrome.json` / `manifest.firefox.json` and have the build step
(§8) copy the right one — but start with one file.

---

## 4. Tab placement rules (the core differentiator)

Base rule: `newIndex = sourceTab.index + 1`.

Edge cases to handle explicitly:

- **Pinned source tab.** An unpinned tab cannot live inside the pinned region; browsers clamp the
  index. Behavior: let the browser clamp (the tab appears just after the last pinned tab), which
  is the sensible result. Just don't assume the created tab's index equals what we requested.
- **Tab groups (Chrome/Edge).** A tab inserted next to a grouped tab does **not** join the group
  automatically, which visually breaks the group. After creation, read `sourceTab.groupId` and,
  if it is a real group, call `tabs.group({groupId, tabIds})`. Guard the call behind a feature
  check so the same code is a no-op on Firefox.
- **Repeated presses.** Pressing the shortcut twice from the same source tab inserts the second
  result *between* the source tab and the first result, i.e. newest-adjacent. The alternative is
  "chain after the most recently opened sibling" (Firefox's `insertRelatedAfterCurrent` feel).
  **Decision: v1 uses the simple rule** (always `source.index + 1`) — stateless, predictable, and
  correct after the user moves tabs around. Revisit only if it feels wrong in daily use; if so,
  implement chaining as bounded per-source-tab state in the background script (`Map<sourceTabId,
  {lastIndex, timestamp}>`, invalidated on tab move/close and after a timeout).
- **Foreground vs background.** `active: true` / `active: false` at `tabs.create` time.
  `search.query` targeting an explicit `tabId` must not steal focus — verify in both browsers,
  especially Firefox, and if it does, re-assert the source tab as active afterwards.
- **`openerTabId`.** Set it to the source tab. It gives correct "back to opener" behavior on
  close, and marks the tab as related. Confirm it does not itself override our index in Chrome
  (it shouldn't when `index` is explicit); if it does, drop it.
- **Windows.** Always create in `sourceTab.windowId`. Never open a new window.

---

## 5. Reading the selection

Injected function body (conceptually): return `document.getSelection()?.toString() ?? ""`
along with `document.hasFocus()` so the caller can rank frames.

Rules and edge cases:

- **Frames.** Inject with `allFrames: true`. `executeScript` returns one result per frame.
  Choose the first result that is non-empty *and* whose frame reports focus; otherwise the first
  non-empty result. This makes selections inside iframes work.
- **Normalization.** Trim, collapse internal whitespace/newlines to single spaces, and cap length
  (~1,000–2,000 chars) before querying — long selections otherwise produce unusable URLs.
- **Empty selection.** Do nothing. No tab, no error dialog. (Optional nicety: nothing at all is
  the reference's behavior and the least annoying; skip notifications.)
- **Restricted pages.** Injection throws on `chrome://`, `about:`, `moz-extension:`, the Chrome
  Web Store, and AMO. Wrap in try/catch and silently return.
- **PDFs — the one genuinely uncertain area.** The reference advertises PDF support in Chrome's
  built-in viewer. Chrome's viewer is an embedded extension page, and injection there behaves
  differently across versions; Firefox's pdf.js viewer is an ordinary web page in a
  `resource://`-backed document and generally *is* reachable. Plan:
  1. Spike this first (§9), before building anything else, on both browsers.
  2. If `allFrames` injection returns the PDF selection, nothing more is needed.
  3. If Chrome's PDF viewer is unreachable, ship PDF support as Firefox-only and document the
     gap, or add an **optional** context-menu item (`contextMenus` with `contexts: ["selection"]`,
     whose `selectionText` does work in the PDF viewer) as a non-shortcut fallback. Do not add
     the clipboard permission for this.

---

## 6. Search engine handling

Primary path: `search.query({text, tabId})` — resolves to the user's **default** engine in both
Chrome (87+) and Firefox, requires only the `search` permission, and keeps us out of the business
of building search URLs.

Fallbacks and checks:

- Confirm Firefox's `search.query` accepts `tabId` on the minimum version we target; if it only
  supports `disposition` there, use Firefox's `search.search({query, tabId})` instead (Firefox-only
  API, also takes a tab id) and branch on feature detection.
- If `search.query` rejects (no default engine, permission missing), fall back to
  `tabs.update(newTabId, {url: "https://www.google.com/search?q=" + encodeURIComponent(text)})`
  so the press is never a no-op with a blank tab left behind. Alternatively close the blank tab.
- **Stretch (post-v1):** an options page storing a custom search URL template containing `%s`,
  used in preference to the default engine when set. Keep out of v1 to preserve the "tiny, no
  storage, no options" character of the original.

---

## 7. Shortcut configuration UX

Both browsers own the remapping UI; we do not build our own key capture in v1.

- Chrome/Edge: `chrome://extensions/shortcuts`. Users can also set scope ("In Chrome" vs "Global").
- Firefox: `about:addons` → gear → *Manage Extension Shortcuts*.
- Ship a minimal **options page** whose only job is to explain this and deep-link where possible:
  Chrome cannot be navigated to `chrome://extensions/shortcuts` from a link (it can from
  `tabs.create` in the extension's own page — verify), Firefox likewise restricts `about:addons`.
  Worst case the page shows copy-pasteable URLs plus screenshots. Also state the known conflicts
  (`Alt+1` = switch to tab 1 in some environments; macOS Option-key dead keys).
- **Firefox-only bonus (optional):** Firefox supports `commands.update()` at runtime, so the
  options page *could* offer real in-page rebinding there. Chrome has no equivalent. Only worth
  doing if the browser UIs prove too hard to find for users; keep it out of v1.

---

## 8. Repo layout, build, and packaging

```
SelectionSearchShortcut/
  LICENSE                 MIT, current year, your name
  README.md               what it does, install, shortcuts, differences from the original
  PLAN.md                 this file
  CHANGELOG.md
  src/
    manifest.json
    background.js         commands.onCommand handler (the whole brain)
    selection.js          the injected selection-reader (or inline in background.js)
    options.html/.js/.css shortcut instructions
    icons/                16/32/48/128 PNG (+ SVG source)
  scripts/build.sh        zips src/ into dist/*.zip per target
  dist/                   gitignored build output
```

Build/tooling decisions:

- **No bundler, no framework, no dependencies.** Plain ES modules or a single script. Part of the
  appeal of the original is being ~9 KiB; match that.
- `scripts/build.sh` produces `dist/selection-search-shortcut-chrome-<version>.zip` and
  `...-firefox-<version>.zip` (identical contents while the manifest stays shared, but keep two
  outputs so per-store divergence is cheap later).
- Lint Firefox package with `npx web-ext lint`; run it in CI. `web-ext run` for a scratch Firefox
  profile during development.
- Optional GitHub Actions workflow: lint + build + attach zips to a tag release.
- Version scheme: semver-ish `0.1.0` for first submission; both stores accept it.

---

## 9. Testing checklist

Do the **PDF spike (§5) and the `search.query({tabId})` spike (§6) first** — they are the only two
places where the plan could need rework.

Manual matrix, run in Chrome (stable) and Firefox (release + ESR if convenient), on Linux at
minimum, macOS/Windows if available:

- Selection on a plain page → foreground command → new tab is at `source.index + 1`, is focused,
  shows default-engine results for the exact selection.
- Same with the background command → new tab in the same slot, source tab **stays** focused and
  keeps its selection.
- Press background twice → both results sit to the right of the source tab, newest first.
- Selection inside an iframe (e.g. an embedded CodePen/YouTube description) → works.
- Selection in a `<textarea>`/`<input>` → works (getSelection may be empty here; if so, also read
  `activeElement.selectionStart/End` in the injected function — add if testing shows a gap).
- Multi-line selection → collapsed to one line, sane query.
- Very long selection (>5,000 chars) → truncated, no error.
- No selection → nothing happens, no stray blank tab.
- Source tab is pinned → new tab lands just after the pinned region, unpinned.
- Source tab is in a tab group (Chrome) → new tab joins the group.
- Source tab is the last tab → new tab is last (identical to reference behavior in that case).
- Restricted page (`chrome://extensions`, `about:config`, the Web Store) → silent no-op.
- PDF in the built-in viewer → per §5 outcome.
- Non-default search engine set (DuckDuckGo/Kagi) → that engine is used.
- Rebind both shortcuts in the browser UI → new bindings work, old ones do not.
- Two windows open → tab is created in the window the command came from.
- Private/incognito window → decide and document: extensions are off in incognito by default in
  Chrome; Firefox needs "Run in Private Windows" allowed. Just document it.

No automated test harness for v1 — the surface is one event handler, and browser-driving tests
would cost more than they return here. Revisit if the extension grows options.

---

## 10. Privacy & permissions story (needed for both stores)

- The extension makes **no network requests of its own**; it hands the query to the browser's
  default search engine, exactly as typing in the address bar would.
- No storage, no analytics, no remote code, no external libraries.
- `activeTab` + `scripting` are used only in direct response to a user-pressed shortcut, only to
  read `getSelection()`, and the text is used only to build the search.
- Write this verbatim into the README, the Chrome Web Store privacy tab (declare *no* data
  collection), and the AMO listing. Chrome requires a justification string for each permission —
  draft them alongside the store listing.

---

## 11. Publishing

- **Chrome Web Store:** $5 one-time developer fee, upload zip, fill privacy practices, screenshots
  (1280×800), 128px icon, short + long description. Expect a few days of review; MV3 with no host
  permissions reviews quickly.
- **Firefox AMO:** free, upload zip; AMO requires that submitted sources build reproducibly — with
  no bundler, the source *is* the package, which keeps this trivial. Provide the extension `id`
  from `browser_specific_settings`.
- Distinct name/icon from the reference extension (§1). Credit the original as inspiration in the
  README, note that this is an independent MIT-licensed implementation, and do not copy its
  listing text or assets.

---

## 12. Open decisions

1. **Final extension name** and icon direction. (Blocking store submission only.)
2. **Repeated-press behavior** — simple `index + 1` (planned default) vs. chaining. Revisit after
   dogfooding.
3. **PDF support scope** — decided by the §5 spike; may end up Chrome-limited or Firefox-limited.
4. **Options page in v1?** Recommended yes, but only as static instructions; no settings.
5. Whether to also expose a **context-menu item** — falls out for free if the PDF fallback is
   needed, otherwise skip to stay minimal.

---

## 13. Suggested implementation order

1. `git init`, `LICENSE` (MIT), `README.md` skeleton, `.gitignore`.
2. Spike: selection retrieval (normal page, iframe, PDF) in both browsers.
3. Spike: `tabs.create` at index + `search.query({tabId})` in both browsers.
4. Manifest + background handler implementing §2–§4 for the happy path.
5. Edge cases: frames ranking, normalization, pinned/grouped tabs, restricted pages, fallbacks.
6. Icons + options page.
7. `scripts/build.sh`, `web-ext lint`, README with the shortcut/conflict documentation.
8. Full manual test pass (§9), fix, tag `v0.1.0`.
9. Store listings + submission.
