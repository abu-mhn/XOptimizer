// docs/app.js — entry point. Shows the What's New popup the first time a
// user lands on the app for a given update version, and arms the tilt-
// activated scoreboard on every page load. The scoreboard is armed
// unconditionally (independent of the popup) so returning users — who
// won't see the popup again — still get a working scoreboard.
//
// "First time entered" is keyed by the popup's data-version: bumping that
// attribute in any tab's HTML causes the popup to surface once more for
// every user, regardless of whether they dismissed an earlier version.
(function () {
  if (typeof scoreboardEnabled !== "undefined") scoreboardEnabled = true;

  const popup = document.getElementById("update-popup");
  if (!popup) return;
  const SEEN_KEY = "beyblade_update_seen_version";
  const currentVersion = popup.dataset.version || "";
  let lastSeen = "";
  try { lastSeen = localStorage.getItem(SEEN_KEY) || ""; } catch (e) {}
  if (currentVersion && lastSeen === currentVersion) return;

  popup.classList.remove("hidden");
  const dismiss = () => {
    popup.classList.add("hidden");
    try { localStorage.setItem(SEEN_KEY, currentVersion); } catch (e) {}
  };
  popup.querySelector(".popup-ok")?.addEventListener("click", dismiss);
})();
