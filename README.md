# Selection Search Shortcut

A tiny browser extension (Chrome, Edge, and Firefox) with two keyboard
shortcuts that search whatever text you've selected using your browser's
**default search engine**.

It's a clone of
["Shortcut keys for selection search"](https://chromewebstore.google.com/detail/shortcut-keys-for-selecti/emceciddhgnjkmjmpjoahmdhibmifohp)
by nex, with one deliberate difference:

> The new results tab opens **directly to the right of the tab you're on**,
> instead of at the far end of the tab strip.

No popup, no context menu, no options beyond shortcut remapping, no network
requests of its own, no data collection.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Alt</kbd>+<kbd>1</kbd> | Search the selection in a new tab next to this one, and switch to it (foreground) |
| <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>1</kbd> | Same, but stay on the current tab (background) |

Both shortcuts are remappable through the browser's own shortcut settings:

- **Chrome / Edge:** `chrome://extensions/shortcuts`
- **Firefox:** `about:addons` → gear icon → *Manage Extension Shortcuts*

The extension's options page (right-click the extension → *Options*) links
to these directly.

### Known shortcut conflicts

- Some Linux window managers and ChromeOS use `Alt+1` to switch to the first
  pinned tab. Rebind if that happens.
- On macOS, `Alt` is the Option key and can type accented characters in some
  keyboard layouts. Rebind if it interferes with typing.

## Installing from source

1. Clone this repo.
2. **Chrome/Edge:** open `chrome://extensions`, enable *Developer mode*, click
   *Load unpacked*, select the `src/` directory.
3. **Firefox:** open `about:debugging#/runtime/this-firefox`, click
   *Load Temporary Add-on*, select `src/manifest.json`. (Or use
   `npx web-ext run` from the repo root for a persistent dev profile.)

## Building release zips

```bash
./scripts/build.sh
```

Produces `dist/selection-search-shortcut-chrome-<version>.zip` and
`dist/selection-search-shortcut-firefox-<version>.zip`.

## How it works

1. On a keyboard command, find the active tab and the tab's index.
2. Inject a small function into every frame of that tab to read
   `window.getSelection()` (falling back to the focused `<input>`/`<textarea>`
   selection range).
3. Create a new tab just to the right of the source tab instead of at the end
   of the strip, with `active` set according to which shortcut was pressed.
   Firing the command repeatedly from the same tab chains each result to the
   right of the previous one (by walking past tabs already opened from the
   source tab), the same way the browser's built-in "Search for …" menu item
   behaves.
4. Call `search.query({ text, tabId })`, which asks the browser to run the
   query through the user's **default search engine** directly into that new
   tab, rather than hard-coding a search-engine URL.
5. If the source tab was in a Chrome tab group, pull the new tab into that
   group so it doesn't visually split the group.

See [PLAN.md](PLAN.md) for the full design rationale, edge cases considered,
and open follow-ups.

## Permissions

- `activeTab` — granted only when a shortcut is pressed; used to read the
  selection in the current tab.
- `scripting` — to inject the (very small) selection-reading function.
- `search` — to hand the query to the browser's default search engine.

No host permissions, no `tabs` permission, no storage, no analytics.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with, and does not reuse any
code or assets from, the original "Shortcut keys for selection search"
extension — this is an independent reimplementation with different tab
placement behavior.
