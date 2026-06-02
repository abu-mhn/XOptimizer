// docs/achievement/achievement.js — renders the Achievement tab.
//
// Reads the signed-in user's counters from /achievements/{usernameKey} and
// paints a progress card per achievement. Achievements + their definitions
// live in docs/js/achievements.js (shared with tournament.js, which writes
// the counters during match scoring).
//
// Signed-out users see a "Sign in to start tracking achievements." hint and
// no progress (matches the gating on the Achievement tab itself — only
// signed-in accounts get the tab visible in the nav).
(function () {
  const listEl = document.getElementById("achievement-list");
  const hintEl = document.getElementById("achievement-signin-hint");
  if (!listEl) return;

  // Achievement icons — dragon-themed entries use the fantasy mascot, the
  // wolf-themed entry uses the dog asset. Rendered as CSS-masked spans so
  // the icon silhouette adopts the current theme's text color (no fixed
  // black / white that disappears on a matching background).
  const ICONS = {
    dragonTamer: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/fantasy.png\')"></span>',
    dragonSlayer: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/knight.png\')"></span>',
    lonewolf: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/dog.png\')"></span>',
    rushHour: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/fast-time.png\')"></span>',
    kingOfJungle: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/animal.png\')"></span>',
    sharknado: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/shark.png\')"></span>',
    sorcererSupreme: '<span class="achievement-icon-mask" style="--ach-icon: url(\'assets/icons/wizard.png\')"></span>'
  };

  const defs = (window.ACHIEVEMENTS || []);

  function clampPct(n) {
    if (!isFinite(n) || n < 0) return 0;
    if (n > 100) return 100;
    return n;
  }

  // Render a single achievement card — icon, title, description, progress
  // bar with count, and an "Unlocked" badge naming the theme once the
  // counter reaches its target.
  function renderCard(def, snap) {
    const data = (snap && typeof snap === "object" && snap[def.id]) || {};
    const count = Math.max(0, Number(data.count) || 0);
    const target = def.target;
    const pct = clampPct(Math.round((count / target) * 100));
    const unlocked = !!data.awarded || count >= target;
    const icon = ICONS[def.id] || "";
    const unlockedHtml = unlocked
      ? `<span class="achievement-unlocked-badge" title="Theme: ${def.themeLabel}">Unlocked &middot; ${def.themeLabel} theme</span>`
      : "";
    return `
      <div class="achievement-card${unlocked ? " is-unlocked" : ""}">
        <div class="achievement-card-icon" aria-hidden="true">${icon}</div>
        <div class="achievement-card-body">
          <div class="achievement-card-head">
            <h3 class="achievement-card-title">${def.title}</h3>
            ${unlockedHtml}
          </div>
          <p class="achievement-card-desc">${def.shortDescription}</p>
          <div class="achievement-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${Math.min(count, target)}">
            <div class="achievement-progress-bar" style="width: ${pct}%"></div>
          </div>
          <div class="achievement-progress-count">${Math.min(count, target)} / ${target}</div>
        </div>
      </div>
    `;
  }

  function renderAll(snap) {
    listEl.innerHTML = defs.map(d => renderCard(d, snap)).join("");
  }

  // Empty render — used while signed out OR while waiting for the read.
  // The hint paragraph swaps in / out alongside.
  function showSignedOut() {
    listEl.innerHTML = "";
    if (hintEl) hintEl.classList.remove("hidden");
  }
  function showLoading() {
    if (hintEl) hintEl.classList.add("hidden");
    renderAll(null);
  }

  // Re-read the signed-in user's achievements node from Firebase and
  // re-paint. /achievements is keyed by Firebase Auth UID (see
  // js/achievements.js). Falls back to "signed out" view when the user
  // isn't signed in yet.
  // Active Firebase listener (ref + callback) so we can detach when the
  // signed-in user changes — otherwise a sign-out + sign-in-as-someone-else
  // would leave the previous account's listener firing into stale UI.
  let achListenerRef = null;
  let achListenerCb = null;
  function detachAchListener() {
    if (achListenerRef && achListenerCb) {
      try { achListenerRef.off("value", achListenerCb); } catch (e) {}
    }
    achListenerRef = null;
    achListenerCb = null;
  }

  function refresh() {
    const user = (window.getCurrentUser && window.getCurrentUser()) || null;
    const profile = (window.getUserProfile && window.getUserProfile()) || null;
    if (!user) {
      console.info("[achievement-page] no firebase user — auth unresolved or signed out");
      detachAchListener();
      showSignedOut();
      return;
    }
    if (!profile || !profile.username) {
      console.info("[achievement-page] user signed in but profile not loaded yet — staying in loading state", user.uid);
      showLoading();
      return;
    }
    // Use firebase.database() directly — initFirebase() is defined in
    // tournament.js, which isn't loaded on the Achievement page. Without
    // this, the read previously bailed silently (no log) because db was
    // null. Fall back to that path only if the global function does
    // happen to exist (e.g. on a page that loads tournament.js).
    let db = null;
    try {
      if (typeof initFirebase === "function") db = initFirebase();
      if (!db && typeof firebase !== "undefined" && firebase.database) db = firebase.database();
    } catch (e) { db = null; }
    if (!db) {
      console.warn("[achievement-page] no firebase.database() available — bailing");
      return;
    }
    // Replace any prior listener (sign-out + sign-in as a different user)
    // so updates only flow into the active account's cards.
    detachAchListener();
    const ref = db.ref("achievements/" + user.uid);
    console.info("[achievement-page] subscribing to /achievements/" + user.uid + " (username: " + profile.username + ")");
    achListenerRef = ref;
    achListenerCb = ref.on("value", snap => {
      const v = snap.val();
      console.info("[achievement-page] update for " + user.uid, v);
      renderAll(v || {});
    }, err => {
      console.warn("[achievement-page] subscription failed for " + user.uid, err && err.message);
      renderAll({});
    });
  }

  // Profile changes (sign-in, sign-out, tag changes) trigger a re-read so
  // the counters reflect the right account on every load.
  window.addEventListener("userprofilechange", refresh);
  if (window.onAuthChange) window.onAuthChange(refresh);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refresh);
  } else {
    refresh();
  }
})();
