// docs/js/achievements.js — the Achievement-tab milestone and the deck check
// behind it. Loaded on every page that either renders the Achievement page
// (achievement/index.html) or tracks progress during match scoring
// (tournament/tournament.js).
//
// Achievements are forward-only: counters start at 0 for everyone and only
// matches scored from now on contribute. Counters live at
// /achievements/{uid}/{achievementId} in the Realtime Database — keyed by
// Firebase Auth UID (not username key) so the security rules can verify a
// player's claim to an achievement tag with a direct
// `root.child('achievements').child($uid)` lookup.
//
// When a counter hits its target the scoring device sets `awarded: true`
// on that node; the player's own client picks the flag up on next sign-in
// and writes the matching tag onto their profile (see auth.js). The tag
// unlocks the matching theme in Settings via the standard tag-gate.
(function () {
  const ACHIEVEMENTS = [
    {
      id: "sorcererSupreme",
      title: "Sorcerer Supreme",
      tag: "Sorcerer Supreme",
      theme: "sorcerersupreme",
      themeLabel: "Sorcerer Supreme",
      target: 100,
      shortDescription: "Win 100 tournament matches with Wizard Rod in your deck.",
      // Per-match credit: the winner's deck carries a Wizard Rod in any slot.
      creditOnWin: (winnerDeck /*, loserDeck */) => deckHasPartNamed(winnerDeck, "Wizard Rod")
    }
  ];

  // Calls `visit` with every part name in a deck. Slots can be standard /
  // cx / cxExpand with different fields, so every non-empty string value
  // in slot.parts counts.
  function eachDeckPartName(deck, visit) {
    if (!Array.isArray(deck)) return;
    for (const slot of deck) {
      if (!slot || !slot.parts) continue;
      for (const key of Object.keys(slot.parts)) {
        const v = slot.parts[key];
        if (typeof v === "string" && v) visit(v);
      }
    }
  }

  // Whole-name match, case-insensitive — "Wizard Rod" must not be satisfied
  // by Wizard Arrow or the Wizard lock chip.
  function deckHasPartNamed(deck, name) {
    const want = String(name).trim().toLowerCase();
    let hit = false;
    eachDeckPartName(deck, (n) => { if (n.trim().toLowerCase() === want) hit = true; });
    return hit;
  }

  // Firebase key for the username -> uid lookup. Same encoding as winRates
  // (uses '_' for chars Firebase rejects in keys). Used by the scoring
  // device to resolve a winner's UID before bumping their achievements.
  function usernameKeyFor(name) {
    return String(name || "")
      .trim()
      .toLowerCase()
      .replace(/[.#$/\[\]]/g, "_");
  }

  window.ACHIEVEMENTS = ACHIEVEMENTS;
  window.achievementUsernameKeyFor = usernameKeyFor;
})();
