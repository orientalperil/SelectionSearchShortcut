/**
 * Selection Search Shortcut - background script.
 *
 * Runs as a Chrome service worker and as a Firefox background script (see
 * manifest.json's "background" key, which declares both). No persistent
 * state is kept between command presses.
 *
 * The foreground and background commands use different strategies:
 *
 * - Foreground: uses search.query({disposition: "NEW_TAB"}). The browser
 *   creates the tab and navigates it to the results in one step, so there's
 *   no separate "new blank tab" moment where the omnibox can get stuck
 *   focused/selected, and no perceptible delay. The one thing this call
 *   doesn't give us is placement: disposition: "NEW_TAB" always appends the
 *   tab at the end of the tab strip (confirmed by testing - this is likely
 *   exactly why the extension this project clones has that same behavior).
 *   tabs.move() afterwards recovers the intended position; it only changes
 *   tab-strip index, not navigation or focus, so it doesn't reintroduce the
 *   delay or the omnibox artifact - it does cause a brief visible flash at
 *   the end of the strip before the tab jumps over, which was judged an
 *   acceptable trade for feeling instant like the browser's own search
 *   feature (see PLAN.md for the alternatives that were tried and rejected,
 *   and for what is/isn't actually verified about how Chrome implements its
 *   own version of this).
 * - Background: creates an inactive tab ourselves at the target index, then
 *   calls search.query({tabId}) to load results into it. Because the tab
 *   is never shown to the user while it's blank/loading, there's no
 *   omnibox-artifact risk to begin with, and disposition has no
 *   background/inactive option to borrow from regardless.
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

  if (foreground) {
    await searchForeground(sourceTab, selection);
  } else {
    await searchBackground(sourceTab, selection);
  }
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
 * Foreground command: let the browser create-and-navigate the tab in one
 * step via search.query({disposition: "NEW_TAB"}), then move it next to the
 * source tab and into its tab group if any.
 */
async function searchForeground(sourceTab, text) {
  const newTabPromise = waitForNewTabIn(sourceTab.windowId);

  try {
    await api.search.query({ text, disposition: "NEW_TAB" });
  } catch (err) {
    // search.query() itself failed - most likely there's no default search
    // engine configured at all. We have no engine to fall back to (the
    // search API never exposes one), so tell the user rather than guessing.
    const alertTab = await api.tabs.create({
      url: "about:blank",
      windowId: sourceTab.windowId,
      index: sourceTab.index + 1,
      active: true,
      openerTabId: sourceTab.id,
    });
    await joinSourceTabGroup(sourceTab, alertTab);
    await showNoSearchEngineAlert(alertTab.id, text);
    return;
  }

  const newTab = await newTabPromise;
  if (!newTab) {
    // Couldn't identify which tab the browser just created - leave it
    // wherever the browser put it rather than risk moving the wrong tab.
    return;
  }
  await moveTab(newTab.id, sourceTab.index + 1);
  await joinSourceTabGroup(sourceTab, newTab);
}

/**
 * Background command: create the tab ourselves (inactive, so there's
 * nothing visible while it loads) at the target index, then load results
 * into it via search.query({tabId}).
 */
async function searchBackground(sourceTab, text) {
  const newTab = await api.tabs.create({
    url: "about:blank",
    windowId: sourceTab.windowId,
    index: sourceTab.index + 1,
    active: false,
    openerTabId: sourceTab.id,
  });
  await runSearch(text, newTab.id);
  await joinSourceTabGroup(sourceTab, newTab);
}

/**
 * Resolves with the first tab created in the given window after this is
 * called, or null after timeoutMs with nothing matching. Used to identify
 * the tab search.query({disposition: "NEW_TAB"}) creates internally, since
 * that call doesn't return the new tab's id itself.
 */
function waitForNewTabIn(windowId, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let settled = false;

    function finish(tab) {
      if (settled) return;
      settled = true;
      api.tabs.onCreated.removeListener(onCreated);
      clearTimeout(timer);
      resolve(tab || null);
    }

    function onCreated(tab) {
      if (tab.windowId === windowId) {
        finish(tab);
      }
    }

    api.tabs.onCreated.addListener(onCreated);
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function moveTab(tabId, index) {
  try {
    await api.tabs.move(tabId, { index });
  } catch (err) {
    // Non-fatal: leave the tab wherever the browser placed it.
  }
}

/**
 * Hands the query to the browser's default search engine, targeting the
 * specific tab we just created. If the search API rejects (most likely: no
 * default search engine configured), tells the user instead of guessing
 * one - see showNoSearchEngineAlert().
 */
async function runSearch(text, tabId) {
  try {
    await api.search.query({ text, tabId });
  } catch (err) {
    await showNoSearchEngineAlert(tabId, text);
  }
}

/**
 * Injects a plain alert() into the (blank) tab we created, telling the user
 * their search couldn't run. Deliberately doesn't guess a search engine -
 * the search API never exposes one, so there's nothing reliable to fall
 * back to. Needs no extra permission: it's a tab we created ourselves, so
 * it's never a restricted page the "scripting" permission can't reach.
 */
async function showNoSearchEngineAlert(tabId, text) {
  try {
    await api.scripting.executeScript({
      target: { tabId },
      func: (query) => {
        alert(
          "Selection Search Shortcut couldn't run this search: no default " +
            'search engine is configured in this browser.\n\nQuery: "' +
            query +
            '"'
        );
      },
      args: [text],
    });
  } catch (err) {
    // If even this fails, there's nothing more we can do.
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
