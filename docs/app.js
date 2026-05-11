// docs/app.js — entry point loaded on every tab page. Arms the tilt-
// activated scoreboard unconditionally so it works on every navigation.
//
// The What's New popup is no longer handled here — it lives in the root
// `index.html` splash page, which shows it once per version on first
// entry and then redirects to /calculator/. Subfolder pages don't carry
// the popup, so there's nothing for app.js to do with it.
(function () {
  if (typeof scoreboardEnabled !== "undefined") scoreboardEnabled = true;
})();
