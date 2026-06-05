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
      shortDescription: "Win 100 matches using parts named Dran, Drake, Dragoon, Wyvern, Bahamut or Ragna.",
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
      shortDescription: "Defeat 100 opponents using Dran / Drake / Dragoon / Wyvern / Bahamut / Ragna while your own deck includes any Knight part.",
      // Per-match credit: did the LOSER use a Dragon-named part AND did
      // the WINNER bring a Knight-named part to slay them with?
      creditOnWin: (winnerDeck, loserDeck) =>
        deckHasAnyPartName(loserDeck, DRAGON_NAMES)
        && deckHasAnyPartName(winnerDeck, KNIGHT_NAMES)
    },
    {
      id: "lonewolf",
      title: "Lone Wolf",
      tag: "Lone Wolf",
      theme: "lonewolf",
      themeLabel: "Lone Wolf",
      target: 100,
      shortDescription: "Win 100 matches where your deck has exactly one Wolf part — and that slot's combo type is unique across the deck (the other two slots must be a different type).",
      // Per-match credit:
      //   1. Exactly one Wolf-named part appears anywhere in the winner's
      //      3-combo deck (the original Lonewolf rule).
      //   2. The slot CONTAINING that Wolf part has a combo type (Attack /
      //      Defense / Stamina / Balance via the shared getType heuristic)
      //      that NEITHER of the other two slots matches. The wolf walks
      //      its own type — if it's a Stamina build, the rest of the deck
      //      can't also be Stamina.
      creditOnWin: (winnerDeck /*, loserDeck */) => {
        if (!Array.isArray(winnerDeck) || winnerDeck.length < 3) return false;
        if (countDeckPartsByName(winnerDeck, WOLF_NAMES) !== 1) return false;
        let wolfSlot = null;
        const otherSlots = [];
        for (const slot of winnerDeck) {
          if (!slot || !slot.parts) return false;
          if (slotHasAnyPartName(slot.parts, WOLF_NAMES)) wolfSlot = slot;
          else otherSlots.push(slot);
        }
        if (!wolfSlot || otherSlots.length !== 2) return false;
        const wolfType = slotBaseType(wolfSlot.parts);
        if (!wolfType) return false;
        return otherSlots.every(s => slotBaseType(s.parts) !== wolfType);
      }
    },
    {
      id: "rushHour",
      title: "Rush Hour",
      tag: "Rush Hour",
      theme: "rushhour",
      themeLabel: "Rush Hour",
      target: 100,
      shortDescription: "Win 100 matches with a Clock Mirage + Rush-named bit combo in your deck.",
      // Per-match credit: does at least ONE slot in the winner's deck pair
      // Clock Mirage (blade) with a Rush-named bit? That's the meta combo
      // — Clock Mirage is built around a Rush bit — so the achievement
      // requires the parts in the SAME slot, not just both somewhere in
      // the 3-combo deck.
      creditOnWin: (winnerDeck /*, loserDeck */) => deckHasSlotWhere(
        winnerDeck,
        parts => partNameMatches(parts.blade, CLOCK_MIRAGE_NAMES)
              && partNameMatches(parts.bit, RUSH_NAMES)
      )
    },
    {
      id: "kingOfJungle",
      title: "King of The Jungle",
      tag: "King of The Jungle",
      theme: "kingofjungle",
      themeLabel: "King of The Jungle",
      target: 100,
      shortDescription: "Win 100 matches with a Leon slot flanked by two slots that each carry Rhino / Fox / Wolf / Viper / Tiger / Bear / Goat parts.",
      // Per-match credit: exactly ONE slot has a Leon-named part (the lion
      // king) and the OTHER TWO slots each carry at least one part named
      // for another jungle/wild animal — the pride flanking the king.
      creditOnWin: (winnerDeck /*, loserDeck */) =>
        deckSplitMatches(winnerDeck, slot => slotHasAnyPartName(slot.parts, LEON_NAMES), {
          markedCount: 1,
          otherPredicate: slot => slotHasAnyPartName(slot.parts, JUNGLE_ANIMAL_NAMES)
        })
    },
    {
      id: "sharknado",
      title: "Sharknado",
      tag: "Sharknado",
      theme: "sharknado",
      themeLabel: "Sharknado",
      target: 100,
      shortDescription: "Win 100 matches with a Shark-named part on a Balance-type slot.",
      // Per-match credit: any slot in the winner's deck that BOTH contains a
      // Shark-named part AND classifies as a Balance-type combo via the
      // shared getType() heuristic (no single stat hitting 100). The
      // achievement is about pairing a Shark blade/ratchet/bit with the
      // OTHER parts so the slot ends up balanced rather than glass-cannon.
      creditOnWin: (winnerDeck /*, loserDeck */) => deckHasSlotWhere(
        winnerDeck,
        parts => slotHasAnyPartName(parts, SHARK_NAMES) && slotTypeIsBalance(parts)
      )
    },
    {
      id: "sorcererSupreme",
      title: "Sorcerer Supreme",
      tag: "Sorcerer Supreme",
      theme: "sorcerersupreme",
      themeLabel: "Sorcerer Supreme",
      target: 100,
      shortDescription: "Win 100 matches with a Wizard-named part in every slot of your deck.",
      // Per-match credit: every one of the deck's 3 slots contains at
      // least one Wizard-named part. Pure wizard council, no exceptions.
      creditOnWin: (winnerDeck /*, loserDeck */) => {
        if (!Array.isArray(winnerDeck) || winnerDeck.length < 3) return false;
        let validSlots = 0;
        for (const slot of winnerDeck) {
          if (!slot || !slot.parts) return false;
          validSlots++;
          if (!slotHasAnyPartName(slot.parts, WIZARD_NAMES)) return false;
        }
        return validSlots >= 3;
      }
    },
    {
      id: "paleonerd",
      title: "Paleonerd",
      tag: "Paleonerd",
      theme: "paleonerd",
      themeLabel: "Paleonerd",
      target: 100,
      shortDescription: "Win 100 matches with every slot carrying a Tyranno / Tricera / Ptera / Mammoth or Brachio part.",
      // Per-match credit: every one of the deck's 3 slots contains at
      // least one prehistoric-creature-named part. Full Jurassic deck.
      creditOnWin: (winnerDeck /*, loserDeck */) => {
        if (!Array.isArray(winnerDeck) || winnerDeck.length < 3) return false;
        let validSlots = 0;
        for (const slot of winnerDeck) {
          if (!slot || !slot.parts) return false;
          validSlots++;
          if (!slotHasAnyPartName(slot.parts, DINOSAUR_NAMES)) return false;
        }
        return validSlots >= 3;
      }
    }
  ];

  // Substring matches — case-insensitive. Part names in DATA include both the
  // codename ("BULLETGRIFFON") and the display name ("Bullet Griffon"); the
  // deck stores display names, so we case-fold and look for the substring.
  const DRAGON_NAMES = ["dran", "drake", "dragoon", "wyvern", "bahamut", "ragna"];
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
  // Leon match — any part with "leon" in its name (Leon Crest / Leon
  // Claw / any Leon-prefixed blade or ratchet, etc.).
  const LEON_NAMES = ["leon"];
  // Other jungle / wild animals used to flank the Leon slot in the King
  // of Jungle achievement (the king with his pride). Substring match —
  // catches Rhino Horn, Fox Bit, Silver Wolf, Viper Tail, Weiss Tiger,
  // Bear Scratch, Goat Tackle, etc.
  const JUNGLE_ANIMAL_NAMES = ["rhino", "fox", "wolf", "viper", "tiger", "bear", "goat"];
  // Shark match — any part with "shark" in its name (Shark Edge, Shark
  // Scale, etc.). Used by the Sharknado achievement combined with a
  // per-slot Balance-type check.
  const SHARK_NAMES = ["shark"];
  // Wizard match — any part with "wizard" in its name (Wizard Arrow,
  // Wizard Rod, etc.). Used by the Sorcerer Supreme achievement.
  const WIZARD_NAMES = ["wizard"];
  // Prehistoric / dinosaur match — any part name containing one of
  // these substrings (Tyranno Beat, Tyranno Roar, Tricera Press,
  // Ptera Swing, Mammoth Tusk, Brachio lockChip). Used by Paleonerd.
  const DINOSAUR_NAMES = ["tyranno", "tricera", "ptera", "mammoth", "brachio"];

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

  // True if any single slot's `parts` object satisfies `predicate`. Used
  // by Rush Hour to require the Clock Mirage + Rush-bit combo within the
  // SAME slot, not just both somewhere across the 3-combo deck.
  function deckHasSlotWhere(deck, predicate) {
    if (!Array.isArray(deck)) return false;
    for (const slot of deck) {
      if (slot && slot.parts && predicate(slot.parts)) return true;
    }
    return false;
  }

  // Case-insensitive substring test against a list of needles.
  function partNameMatches(name, needles) {
    if (typeof name !== "string" || !name) return false;
    const low = name.toLowerCase();
    for (const needle of needles) {
      if (low.indexOf(needle) !== -1) return true;
    }
    return false;
  }

  // True if any field in a single slot's `parts` map matches one of the
  // substring needles. Per-slot variant of `deckHasAnyPartName` — used
  // when a creditOnWin callback needs to test a SLOT (not the whole
  // deck) for a named part.
  function slotHasAnyPartName(parts, needles) {
    if (!parts) return false;
    for (const key of Object.keys(parts)) {
      if (partNameMatches(parts[key], needles)) return true;
    }
    return false;
  }

  // Classify a single slot via the same heuristic the Calculator uses
  // (getType() in js/core.js) — sum ATK/DEF/STA across every named part
  // in the slot, look the part up in DATA for its stats, and pass to
  // getType. Returns the type label (e.g. "Balance", "Balance II",
  // "Perfect Balance", "Attack", "Defense", "Stamina") or "" if the
  // shared globals aren't loaded yet.
  //
  // Field → DATA collection mapping mirrors the Bey Check form. Bits
  // include both normal bits and ratchet-bits after mergeBits() runs in
  // core.js, so the isRatchetBit flag on the matched bit drives the
  // ratchet-bit branch of getType (which uses different thresholds).
  const FIELD_TO_DATA = {
    blade: "blades",
    lockChip: "lockChips",
    mainBlade: "mainBlades",
    metalBlade: "metalBlades",
    overBlade: "overBlades",
    assistBlade: "assistBlades",
    ratchet: "ratchets",
    bit: "bits"
  };
  function slotTypeLabel(parts) {
    if (!parts) return "";
    // `DATA` and `getType` are declared with `const` / `function` at the
    // top level of data.js / core.js. `const` doesn't attach to `window`
    // in classic scripts, so `window.DATA` is undefined — read the names
    // directly off the global scope instead. Wrap in try/catch so a page
    // that didn't load data.js doesn't throw ReferenceError.
    let dataRef = null;
    let getTypeFn = null;
    try { dataRef = (typeof DATA !== "undefined") ? DATA : null; } catch (e) { dataRef = null; }
    try { getTypeFn = (typeof getType === "function") ? getType : (window && typeof window.getType === "function" ? window.getType : null); } catch (e) { getTypeFn = null; }
    if (!dataRef) return "";
    let atk = 0, def = 0, sta = 0;
    let isRatchetBit = false;
    for (const field of Object.keys(FIELD_TO_DATA)) {
      const name = parts[field];
      if (typeof name !== "string" || !name) continue;
      // The "__NO_RATCHET__" sentinel and any other non-data name will
      // simply not match below — no need to special-case it.
      const collection = dataRef[FIELD_TO_DATA[field]];
      if (!Array.isArray(collection)) continue;
      const part = collection.find(p => p && p.name === name);
      if (!part) continue;
      atk += (part.atk || 0);
      def += (part.def || 0);
      sta += (part.sta || 0);
      if (field === "bit" && part.isRatchetBit) isRatchetBit = true;
    }
    if (!getTypeFn) return "";
    return getTypeFn(atk, def, sta, isRatchetBit);
  }

  // Convenience predicate — true when slotTypeLabel returns any Balance
  // variant ("Balance", "Balance II", "Balance III", "Perfect Balance",
  // "Ultimate Balance"). Used by Sharknado.
  function slotTypeIsBalance(parts) {
    const t = slotTypeLabel(parts);
    return typeof t === "string" && t.indexOf("Balance") !== -1;
  }

  // Coarse type bucket — collapses every Balance variant down to a single
  // "Balance" label so achievements can compare a slot's type identity
  // without caring about Balance / Balance II / Perfect Balance grades.
  // Returns "Attack" / "Defense" / "Stamina" / "Balance" / "".
  function slotBaseType(parts) {
    const label = slotTypeLabel(parts);
    if (typeof label !== "string" || !label) return "";
    if (label.indexOf("Balance") !== -1) return "Balance";
    return label;
  }

  // Generic deck split — partitions every slot into "marked" (passes
  // `markedPredicate`) vs "other", then enforces:
  //   1. Exactly `opts.markedCount` slots are marked.
  //   2. Every non-marked slot satisfies `opts.otherPredicate`.
  // Used by Sorcerer Supreme (markedCount: 1 Wizard slot + the OTHER 2
  // slots must be Attack-type). Falls back to false if the deck shape
  // isn't an array of 3 valid slots — partial decks shouldn't credit.
  function deckSplitMatches(deck, markedPredicate, opts) {
    if (!Array.isArray(deck) || deck.length < 3) return false;
    opts = opts || {};
    const otherPred = typeof opts.otherPredicate === "function" ? opts.otherPredicate : null;
    let markedSeen = 0;
    let othersOk = true;
    let validSlots = 0;
    for (const slot of deck) {
      if (!slot || !slot.parts) continue;
      validSlots++;
      if (markedPredicate(slot)) {
        markedSeen++;
      } else if (otherPred && !otherPred(slot)) {
        othersOk = false;
      }
    }
    if (validSlots < 3) return false;
    if (typeof opts.markedCount === "number" && markedSeen !== opts.markedCount) return false;
    return othersOk;
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
