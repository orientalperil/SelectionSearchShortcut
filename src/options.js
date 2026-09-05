const api = typeof browser !== "undefined" ? browser : chrome;

const isFirefox = typeof browser !== "undefined";

// Only show the block relevant to the browser we're actually running in.
document.getElementById(isFirefox ? "chrome-block" : "firefox-block").style.display = "none";

const openChromeShortcuts = document.getElementById("open-chrome-shortcuts");
if (openChromeShortcuts) {
  openChromeShortcuts.addEventListener("click", () => {
    openUrl("chrome://extensions/shortcuts");
  });
}

const openFirefoxAddons = document.getElementById("open-firefox-addons");
if (openFirefoxAddons) {
  openFirefoxAddons.addEventListener("click", () => {
    openUrl("about:addons");
  });
}

function openUrl(url) {
  api.tabs.create({ url }).catch(() => {
    // Some builds/policies block extensions from opening browser-internal
    // pages. The instructions above already spell out the URL to visit
    // manually, so there's nothing more to do here.
  });
}
