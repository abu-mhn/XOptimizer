// docs/js/achievements.js — shared constants + deck inspection helpers for
// the three Achievement-tab milestones. Loaded on every page that either
// renders the Achievement page (achievement/index.html) or tracks progress
// during match scoring (tournament/tournament.js).
//
// Achievements are forward-only: counters start at 0 for everyone and only
// matches scored from now on contribute. Past tournament history isn't
// backfilled. Counters live at /achievements/{uid}/{achievementId} in the
// Realtime Database — keyed by Firebase Auth UID (not username key) so
// the security rules can verify a player's claim to an achievement tag
// with a direct `root.child('achievements').child($uid)` lookup, without
// needing to compute the username-key transformation inside rules.
//
// When a counter hits its target the scoring device sets `awarded: true`
// on that node; the player's own client picks the flag up on next sign-in
// and writes the matching tag onto their profile (see auth.js). The tag
// unlocks the matching theme in Settings via the standard tag-gate.
(function () {
  const ACHIEVEMENTS = [
    {
      id: "dragonTamer",
      title: "Dragon Tamer",
      tag: "Dragon Tamer",
      theme: "dragontamer",
      themeLabel: "Dragon Tamer",
      target: 100,
      shortDescription: "Win 100 matches using parts with Dran, Drake or Dragoon in the name.",
      // Per-match credit: did the WINNER use one of these parts in this match?
      creditOnWin: (winnerDeck /*, loserDeck */) => deckHasAnyPartName(winnerDeck, DRAGON_NAMES)
    },
    {
      id: "dragonSlayer",
      title: "Dragon Slayer",
      tag: "Dragon Slayer",
      theme: "dragonslayer",
      themeLabel: "Dragon Slayer",
      target: 100,
      shortDescription: "Defeat 100 opponents using Dran, Drake or Dragoon while your own deck includes any Knight part.",
      // Per-match credit: did the LOSER use a Dragon-named part AND did
      // the WINNER bring a Knight-named part to slay them with?
      creditOnWin: (winnerDeck, loserDeck) =>
        deckHasAnyPartName(loserDeck, DRAGON_NAMES)
        && deckHasAnyPartName(winnerDeck, KNIGHT_NAMES)
    },
    {
      id: "lonewolf",
      title: "Lonewolf",
      tag: "Lonewolf",
      theme: "lonewolf",
      themeLabel: "Lonewolf",
      target: 100,
      shortDescription: "Win 100 matches where your deck has exactly one Wolf part.",
      // Per-match credit: did the WINNER's deck contain EXACTLY ONE Wolf-named part?
      creditOnWin: (winnerDeck /*, loserDeck */) => countDeckPartsByName(winnerDeck, WOLF_NAMES) === 1
    },
    {
      id: "rushHour",
      title: "Rush Hour",
      tag: "Rush Hour",
      theme: "rushhour",
      themeLabel: "Rush Hour",
      target: 100,
      shortDescription: "Win 100 matches with Clock Mirage AND any Rush-named part in your deck.",
      // Per-match credit: did the WINNER's deck include BOTH a Clock Mirage
      // (exact blade name) AND a Rush-named part somewhere in the deck?
      creditOnWin: (winnerDeck /*, loserDeck */) =>
        deckHasAnyPartName(winnerDeck, CLOCK_MIRAGE_NAMES)
        && deckHasAnyPartName(winnerDeck, RUSH_NAMES)
    }
  ];

  // Substring matches — case-insensitive. Part names in DATA include both the
  // codename ("BULLETGRIFFON") and the display name ("Bullet Griffon"); the
  // deck stores display names, so we case-fold and look for the substring.
  const DRAGON_NAMES = ["dran", "drake", "dragoon"];
  const WOLF_NAMES = ["wolf"];
  // Knight match — any part with "knight" in its name qualifies the
  // winner for Dragon Slayer credit (any blade / ratchet / bit / etc.).
  const KNIGHT_NAMES = ["knight"];
  // Clock Mirage check uses the full display name (no other blade contains
  // "clock mirage" as a substring, so the substring approach is safe).
  const CLOCK_MIRAGE_NAMES = ["clock mirage"];
  // Rush match against any part containing "rush" in its name (Rush Bit,
  // any Rush-prefixed ratchet or assist blade, etc.).
  const RUSH_NAMES = ["rush"];

  // Walk every named part across all 3 slots in a bey-check deck. Each slot
  // can be in standard / cx / cxExpand mode with different fields; we just
  // collect every non-empty string value from slot.parts.
  function eachDeckPartName(deck, visit) {
    if (!Array.isArray(deck)) return;
    for (const slot of deck) {
      if (!slot || !slot.parts) continue;
      for (const key of Object.keys(slot.parts)) {
        const v = slot.parts[key];
        if (typeof v !== "string" || !v) continue;
        visit(v);
      }
    }
  }

  function deckHasAnyPartName(deck, needles) {
    let hit = false;
    eachDeckPartName(deck, (name) => {
      if (hit) return;
      const low = name.toLowerCase();
      for (const needle of needles) {
        if (low.indexOf(needle) !== -1) { hit = true; return; }
      }
    });
    return hit;
  }

  function countDeckPartsByName(deck, needles) {
    let n = 0;
    eachDeckPartName(deck, (name) => {
      const low = name.toLowerCase();
      for (const needle of needles) {
        if (low.indexOf(needle) !== -1) { n++; return; }
      }
    });
    return n;
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
  window.deckHasAnyPartName = deckHasAnyPartName;
  window.countDeckPartsByName = countDeckPartsByName;
})();
