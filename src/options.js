const api = typeof browser !== "undefined" ? browser : chrome;

// Feature-detect rather than sniff the browser: commands.openShortcutSettings()
// is a Firefox-only API (MDN confirms Chrome doesn't implement it), and it's
// exactly the capability that decides which block/button to show - so it
// doubles as the right signal for both. (Note: as of Chrome 148, Chrome also
// defines a global "browser" object aliasing "chrome", so a plain
// `typeof browser !== "undefined"` check can no longer tell the two apart.)
const isFirefox = typeof api.commands.openShortcutSettings === "function";

document.getElementById(isFirefox ? "chrome-block" : "firefox-block").style.display = "none";

const openChromeShortcuts = document.getElementById("open-chrome-shortcuts");
if (openChromeShortcuts) {
  openChromeShortcuts.addEventListener("click", () => {
    api.tabs.create({ url: "chrome://extensions/shortcuts" }).catch(() => {
      // Some builds/policies block extensions from opening browser-internal
      // pages. The instructions above already spell out the URL to visit
      // manually, so there's nothing more to do here.
    });
  });
}

const openFirefoxShortcuts = document.getElementById("open-firefox-shortcuts");
if (openFirefoxShortcuts) {
  openFirefoxShortcuts.addEventListener("click", () => {
    // Deliberately not tabs.create({url: "about:addons"}): Firefox treats
    // about:addons as a privileged page and always refuses extensions
    // navigating to it directly. commands.openShortcutSettings() is the
    // real, supported way to get there.
    api.commands.openShortcutSettings().catch(() => {
      // Fall through to the manual instructions already on the page.
    });
  });
}
