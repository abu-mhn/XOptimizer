// docs/settings/settings.js — Settings tab extras.
//
// "Show Features" button: opens a popup with a copy-pasteable plaintext
// list of every user-visible feature in X Optimizer. Update FEATURES_TEXT
// whenever a meaningful new capability ships so the dump stays accurate.
(function initFeaturesPopup() {
  const FEATURES_TEXT = `X Optimizer — Features

Dashboard
- Auto-sliding carousel: Combo of the Day, Heaviest Bey, Max ATK / DEF / STA
- Combo names computed exactly like the calculator (e.g. BULLETGRIFFONY) — codename + ratchet name + bit codename
- Tap any part image for a larger preview
- Best Parts carousel: top 3 most-used parts per type (Blade, Lock Chip, Ratchet, Bit, etc.) in the current tournament, ranked 1st (gold) / 2nd (silver) / 3rd (bronze)
- Best Parts persist across tournament resets via a saved snapshot
- Respects calculator constraints: Bullet Griffon's built-in ratchet (no ratchet slot), Clock Mirage's -5 ratchet requirement
- Combo of the Day is seeded by today's date — every visitor sees the same combo until local midnight

Calculator
- Three combo modes: Standard, CX (Custom), CX Expand
- Searchable part dropdowns
- Reset, "I'm Feeling Lucky" random pick
- Additional button modes: Random, Meta

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
- Cross-device sync when signed in — decks follow your account everywhere

Tournament
- Two formats: Swiss, Single Elimination
- Pick Swiss, then choose whether to add a Top 8 knockout (Swiss + Top 8) or finish on group records (Swiss only)
- Configurable Swiss groups: 2, 3, or 4
- Configurable rounds per group: 3, 4, 5
- Hosting requires a free email account (Settings → Account, or prompted on Create Tournament)
- Every tournament is ranked automatically — no host password
- Self-registration via the Open Tournaments lobby (no manual name list)
- Three-way join from the lobby: Co-host (with host code), Participant (register name + deck), Viewer (watch only)
- Hosts AND co-hosts can play (+ Register myself), start the tournament, edit participants, and remove registrants
- Edit the format while waiting for players — tap the Top 8 / groups / rounds chips during registration to change them, no reset needed
- Test button (host / co-host): bulk-adds synthetic participants (default 10) with meta-random decks, one batched Firebase write
- Test decks obey "one of each part per deck" across all 3 slots (only light lock chips can repeat; Emperor / Valkyrie cannot)
- Test deck mode mix is weighted realistic: ~75% Standard, ~13% CX, ~12% CX Expand
- Edit a registrant in place — tap their name to change the name or rebuild their deck
- Registered decks pre-fill every match; judges can override per match
- CX / CX Expand decks paste from the Deck tab without losing parts (lock chip / main blade / assist blade preserved)
- Bey Check slots show just "Slot 1 / 2 / 3" with an invisible-scrollbar part row (swipe still works)
- Swiss + Top 8 auto-generates the knockout bracket from group standings — 2 groups (top 4), 3 groups (top 2 + 2 best 3rd-place wildcards), 4 groups (top 2)
- Scoreboard round counter above VS, advancing every 3 score taps
- Tilt-activated scoreboard on mobile (rotate to landscape)
- Share button opens a popup for date, time, stadium (Xtreme / Infinity / Double Xtreme), rule (Official / Unofficial), and remark — date renders as "14 May 2026 (Thursday)", and the message points participants at the Deck tab's Copy → Paste flow
- Past tournaments stay viewable in history after reset (cached snapshot)
- Parts-usage pie charts at tournament end as an auto-sliding carousel (theme-aware palette)

Revox
- Dedicated top-level tab with its own icon
- Admin login to add, edit, and remove members
- Member ranking by points

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
- Additional button mode picker (Random / Meta)
- Account: sign up / sign in with email + password, forgot-password reset, sign out
- Show Features (this list)

Other
- Per-tab URLs: /dashboard/, /calculator/, /library/, /deck/, /tournament/, /revox/, /battlepass/, /reel/, /history/, /settings/
- "What's New" landing page at the site root
- Single-line horizontal tab bar (invisible scrollbar) — scroll position preserved across navigation, centered on desktop
- Live Firebase sync across host / co-host / participant / viewer devices
- Multi-mode part images (Eclipse, Dual, Turbo, Operate, Scorpio Spear, Lightning L-Drago) display correctly everywhere — defaults to mode 0 when no mode is recorded
- Broken-image fallback hides only the image (rank chip + name stay), so Best Parts 1st / 2nd / 3rd rows never shift out of alignment
- Themed end-to-end: dashboard, scoreboard (sb-btn / round / hint / close / divider), tournament registering view (heading / format pills / + Register myself / row names), group + match cards (sub-tabs / round titles / match rows / seed pills / score cells), Bey Check popup (player tabs / slot cards / labels), Rounds + Groups picker popups, Open Tournaments list, Revox input, What's New page, charts, Battle Pass widgets
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

  // ===== Account row (sign-in / sign-out) =====
  (function initAccountRow() {
    const row = document.getElementById("settings-account-row");
    if (!row) return;
    const emailEl = row.querySelector("#settings-account-email");
    const signInBtn = row.querySelector("#settings-signin-btn");
    const signOutBtn = row.querySelector("#settings-signout-btn");
    const render = (user) => {
      if (user) {
        if (emailEl) emailEl.textContent = user.email || "Signed in";
        signInBtn?.classList.add("hidden");
        signOutBtn?.classList.remove("hidden");
      } else {
        if (emailEl) emailEl.textContent = "Not signed in";
        signInBtn?.classList.remove("hidden");
        signOutBtn?.classList.add("hidden");
      }
    };
    if (typeof window.onAuthChange === "function") {
      window.onAuthChange(render);
    } else {
      render(null);
    }
    signInBtn?.addEventListener("click", () => {
      if (typeof window.showSignInPopup !== "function") return;
      window.showSignInPopup({}).catch(() => {});
    });
    signOutBtn?.addEventListener("click", () => {
      if (typeof window.signOutCurrentUser !== "function") return;
      if (!confirm("Sign out of this account?")) return;
      window.signOutCurrentUser().catch(e => alert("Sign out failed: " + (e?.message || e)));
    });
  })();

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
