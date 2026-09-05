/**
 * Selection Search Shortcut - background script.
 *
 * Runs as a Chrome service worker and as a Firefox background script (see
 * manifest.json's "background" key, which declares both). No persistent
 * state is kept between command presses.
 *
 * Flow for each keyboard command:
 *   1. Find the active tab in the current window (the "source" tab).
 *   2. Read whatever text is selected in that tab (any frame).
 *   3. If there's a selection, open a new tab immediately to the right of
 *      the source tab - foreground or background depending on the command.
 *   4. Ask the browser's default search engine to render results into that
 *      specific new tab (via the "search" API's tabId option), rather than
 *      building a search URL ourselves.
 *   5. If the source tab belonged to a Chrome tab group, pull the new tab
 *      into that same group so it doesn't visually split the group.
 */

const api = typeof browser !== "undefined" ? browser : chrome;

const MAX_QUERY_LENGTH = 2000;

api.commands.onCommand.addListener((command) => {
  // The "1-"/"2-" prefixes exist only so Chrome's alphabetically-sorted
  // chrome://extensions/shortcuts page lists foreground before background.
  if (command === "1-search-selection-foreground") {
    handleCommand({ foreground: true }).catch(logError);
  } else if (command === "2-search-selection-background") {
    handleCommand({ foreground: false }).catch(logError);
  }
});

async function handleCommand({ foreground }) {
  const sourceTab = await getActiveTab();
  if (!sourceTab || sourceTab.id === undefined) {
    return;
  }

  const selection = await readSelection(sourceTab.id);
  if (!selection) {
    return;
  }

  const newTab = await createAdjacentTab(sourceTab, foreground);
  await runSearch(selection, newTab.id);
  await joinSourceTabGroup(sourceTab, newTab);
}

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Reads the current selection out of every frame of a tab and returns the
 * best candidate: preferring a non-empty selection from a focused frame,
 * falling back to any non-empty selection.
 */
async function readSelection(tabId) {
  let results;
  try {
    results = await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: getSelectionFromFrame,
    });
  } catch (err) {
    // Injection fails on restricted pages (chrome://, about:, the Web
    // Store/AMO, PDF viewer internals in some versions, etc). Nothing we
    // can do there - treat it like an empty selection.
    return "";
  }

  if (!results || results.length === 0) {
    return "";
  }

  let best = "";
  let bestIsFocused = false;
  for (const frameResult of results) {
    const value = frameResult && frameResult.result;
    if (!value || !value.text) {
      continue;
    }
    if (value.focused && !bestIsFocused) {
      best = value.text;
      bestIsFocused = true;
    } else if (!best) {
      best = value.text;
    }
  }

  return normalize(best);
}

/**
 * Executed inside the page via scripting.executeScript. Must be a plain,
 * self-contained function - it runs in the page's context, not here.
 */
function getSelectionFromFrame() {
  let text = "";

  const active = document.activeElement;
  const isTextInput =
    active &&
    (active.tagName === "TEXTAREA" ||
      (active.tagName === "INPUT" && typeof active.selectionStart === "number"));
  if (isTextInput && typeof active.selectionStart === "number" && typeof active.selectionEnd === "number") {
    text = active.value.slice(active.selectionStart, active.selectionEnd);
  }

  if (!text) {
    const selection = window.getSelection ? window.getSelection() : null;
    text = selection ? selection.toString() : "";
  }

  return { text, focused: document.hasFocus() };
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * Creates a new tab in the same window as sourceTab, placed directly to its
 * right (index + 1), instead of at the end of the tab strip.
 */
async function createAdjacentTab(sourceTab, active) {
  return api.tabs.create({
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1,
    active,
    openerTabId: sourceTab.id,
  });
}

/**
 * Hands the query to the browser's default search engine, targeting the
 * specific tab we just created. Falls back to a Google search URL if the
 * search API is unavailable or rejects (e.g. no default engine configured).
 */
async function runSearch(text, tabId) {
  try {
    await api.search.query({ text, tabId });
  } catch (err) {
    const url = "https://www.google.com/search?q=" + encodeURIComponent(text);
    await api.tabs.update(tabId, { url });
  }
}

/**
 * Chrome/Edge tab groups: if the source tab was in a group, pull the new
 * tab into the same group so it doesn't appear to split the group visually.
 * No-op on browsers without a tabs.group API (e.g. Firefox).
 */
async function joinSourceTabGroup(sourceTab, newTab) {
  if (!api.tabs.group) {
    return;
  }
  const groupId = sourceTab.groupId;
  if (groupId === undefined || groupId === -1) {
    return;
  }
  try {
    await api.tabs.group({ groupId, tabIds: [newTab.id] });
  } catch (err) {
    // Non-fatal: leave the new tab ungrouped.
  }
}

function logError(err) {
  console.error("Selection Search Shortcut:", err);
}
