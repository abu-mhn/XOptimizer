// docs/settings/settings.js — Settings tab extras.
//
// "Show Features" button: opens a popup with a copy-pasteable plaintext
// list of every user-visible feature in X Optimizer. Update FEATURES_TEXT
// whenever a meaningful new capability ships so the dump stays accurate.
(function initFeaturesPopup() {
  const FEATURES_TEXT = `X Optimizer — Features

Calculator
- Three combo modes: Standard, CX (Custom), CX Expand
- Searchable part dropdowns
- Reset, "I'm Feeling Lucky" random pick
- Additional button modes: Random, 1D1C, Max Weight, Min Weight, Meta, Max ATK, Max DEF, Max STA

Library
- Search Beyblade X parts by name
- Filter by part type: Blades, Bits, Ratchets, Assist Blades, Main Blades, Metal Blades, Over Blades, Lock Chips
- Sort by Name, ATK, DEF, STA, Weight, Height
- Tap any part image for a larger preview

Deck (3 Slots)
- Multiple named decks with an active selector
- Shuffle slot order
- Reset / clear the deck
- Download the deck as a PNG (background follows your theme)
- Copy a deck to paste into a tournament registration

Tournament
- Three formats: Swiss + Top 8, Swiss only, Single Elimination
- Configurable Swiss groups: 2 or 4
- Configurable rounds per group: 3, 4, 5
- Every tournament is ranked automatically — no host password
- Self-registration via the Open Tournaments lobby (no manual name list)
- Three-way join from the lobby: Co-host (with host code), Participant (register name + deck), Viewer (watch only)
- Hosts AND co-hosts can play (+ Register myself), start the tournament, edit participants, and remove registrants
- Edit a registrant in place — tap their name to change the name or rebuild their deck
- Registered decks pre-fill every match; judges can override per match
- Swiss + Top 8 auto-generates the knockout bracket from group standings
- Scoreboard round counter above VS, advancing every 3 score taps
- Tilt-activated scoreboard on mobile (rotate to landscape)
- Share button opens a popup for date, time, stadium (Xtreme / Infinity / Double Xtreme), rule (Official / Unofficial), and remark — then composes a message with a registration link
- Past tournaments stay viewable in history after reset (cached snapshot)
- Parts-usage pie charts at tournament end (theme-aware palette)

Battle Pass
- Bluetooth connection to BEYBLADE_TOOL01 launcher (Chrome / Edge on desktop or Android, Bluefy browser on iOS)

Buzz Bey
- Local, International, and Japan video embeds

History
- Last 3 calculated combos
- Tournament history with role badges: Host, Co-host, Participant, Viewer
- Clickable entries open final placements (cached when the live room is gone)

Settings
- Themes: Dark, Light, Space, Tropical, Stormy, Monochrome, Love, Forest
- Stat display: Bar or Radar
- Additional button mode picker
- Show Features (this list)

Other
- Per-tab URLs: /calculator/, /library/, /deck/, /tournament/, /battlepass/, /reel/, /history/, /settings/
- "What's New" landing page at the site root
- Revox member ranking
- Live Firebase sync across host / co-host / participant / viewer devices
- Themed across the whole UI (forms, buttons, popups, scoreboard, charts, Battle Pass widgets)
`;

  const btn = document.getElementById("settings-show-features");
  const popup = document.getElementById("features-popup");
  if (!btn || !popup) return;

  const listEl = popup.querySelector("#features-list");
  const copyBtn = popup.querySelector("#features-copy");
  const closeBtn = popup.querySelector("#features-close");
  const statusEl = popup.querySelector("#features-status");

  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) statusEl.classList.add(`is-${kind}`);
  };

  const open = () => {
    if (listEl) listEl.textContent = FEATURES_TEXT;
    setStatus("");
    popup.classList.remove("hidden");
  };
  const close = () => popup.classList.add("hidden");

  btn.addEventListener("click", open);
  closeBtn?.addEventListener("click", close);
  popup.addEventListener("click", (e) => { if (e.target === popup) close(); });

  copyBtn?.addEventListener("click", () => {
    const text = listEl ? listEl.textContent : FEATURES_TEXT;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => {
          setStatus("Copied to clipboard.", "ok");
          setTimeout(() => setStatus(""), 1500);
        })
        .catch(() => setStatus("Couldn't copy. Select the text and copy manually.", "err"));
      return;
    }
    // Fallback for older browsers / non-HTTPS contexts.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      setStatus(ok ? "Copied to clipboard." : "Couldn't copy.", ok ? "ok" : "err");
      if (ok) setTimeout(() => setStatus(""), 1500);
    } catch (e) {
      setStatus("Couldn't copy. Select the text and copy manually.", "err");
    }
  });
})();
