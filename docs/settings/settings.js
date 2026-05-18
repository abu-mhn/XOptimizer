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
- Three formats: Swiss, Round Robin, Single Elimination
- Round Robin: everyone in a group plays everyone else exactly once; rounds are fixed by group size (N players = N-1 rounds, or N with a bye each round when odd)
- Round Robin reuses the Swiss group stage, standings and Top 8 — only the per-round pairing differs (fixed everyone-vs-everyone schedule vs. Swiss standings-based pairing)
- Pick Swiss or Round Robin, then choose whether to add a Top 8 knockout (+ Top 8) or finish on group records (group records only)
- Configurable groups: 2, 3, or 4 (Swiss and Round Robin)
- Configurable rounds per group for Swiss: 3, 4, 5 (Round Robin derives rounds from group size)
- Hosting requires a free email account (Settings → Account, or prompted on Create Tournament)
- Every tournament is ranked automatically — no host password
- Self-registration via the Open Tournaments lobby (no manual name list)
- Tournaments you host show a "Hosting" badge in the Open Tournaments lobby when you're signed in
- Running tournaments stay listed in the Open Tournaments lobby with an "In progress" badge — registration is closed, but co-hosts and viewers can still join
- My Tournaments: a signed-in host is dropped straight back into the tournament they host on any device — the room index follows your account, not the device (a pick list appears only if you host more than one)
- Three-way join from the lobby: Co-host (with host code), Participant (register name + deck), Viewer (watch only)
- Hosts AND co-hosts can play (+ Register myself), start the tournament, add participants, and remove registrants
- Edit the format while waiting for players — tap the Top 8 / groups / rounds chips during registration to change them, no reset needed
- Test button (host / co-host): bulk-adds synthetic participants (default 10) with meta-random decks, one batched Firebase write
- Test decks obey "one of each part per deck" across all 3 slots (only light lock chips can repeat; Emperor / Valkyrie cannot)
- Test deck mode mix is weighted realistic: ~75% Standard, ~13% CX, ~12% CX Expand
- Test registrants never earn global ranking points or appear on the leaderboard
- Edit a registrant in place — tap their name to change the name or rebuild their deck
- Add a participant after the tournament starts — name + 3-combo deck; in Swiss they slot into the next round with no reset
- Rename any participant after the tournament starts — tap their name in a group's Standings
- Adjust the total round count mid-tournament — tap "Round X / Y" in a group header; already-played rounds are kept
- Registered decks pre-fill every match; judges can override per match
- CX / CX Expand decks paste from the Deck tab without losing parts (lock chip / main blade / assist blade preserved)
- Bey Check slots show just "Slot 1 / 2 / 3" with an invisible-scrollbar part row (swipe still works)
- Swiss + Top 8 auto-generates the knockout bracket from group standings — 2 groups (top 4), 3 groups (top 2 + 2 best 3rd-place wildcards), 4 groups (top 2)
- Scoreboard round counter above VS, advancing every 3 score taps
- Tilt-activated scoreboard on mobile (rotate to landscape)
- Share button opens a popup for date, time, stadium (Xtreme / Infinity / Double Xtreme), rule (Official / Unofficial), and remark — date renders as "14 May 2026 (Thursday)", and the message points participants at the Deck tab's Copy → Paste flow
- Share message lists the registered participants (numbered) when anyone has signed up
- Past tournaments stay viewable in history after reset (cached snapshot)
- Parts-usage pie charts at tournament end as an auto-sliding carousel (theme-aware palette)

Revox
- Dedicated tab and theme, shown only to accounts tagged "Revox Admin"
- The Revox theme turns on automatically when a Revox Admin signs in
- Revox Admins add, edit, and remove members directly — no password, the account tag is the key
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
- Themes: Dark, Light, Space, Tropical, Stormy, Monochrome, Love, Forest (plus Revox, for Revox Admins)
- Stat display: Bar or Radar
- Additional button mode picker (Random / Meta)
- Account: sign up / sign in with username or email + password, forgot-password reset, sign out
- Show Features (this list)

Profile
- Your own profile tab — the profile photo doubles as the tab icon
- Upload a photo and a banner (tap the image to change it), set a username and a short bio
- Discord-style profile card; admin-assigned tags show as badges
- Profile syncs to your account — same photo, name and bio on every device

Developer
- Extra tab shown only to accounts tagged "Developer"
- Lists every registered user with a total count, searchable by username or email
- Developers can add tags to any user (multiple tags per user)

Other
- Per-tab URLs: /dashboard/, /calculator/, /library/, /deck/, /tournament/, /revox/, /battlepass/, /reel/, /history/, /settings/, /account/, /developer/
- "What's New" landing page at the site root
- Single-line horizontal tab bar (invisible scrollbar) — each tab shows its icon with a name label below; scroll position preserved across navigation, centered on desktop
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

  // ===== Account page (sign in/out + profile: username & photo) =====
  // The Account tab is its own page (/account/); this wires it. settings.js
  // loads on every page, so on non-account pages the elements are absent and
  // this whole block no-ops.
  (function initAccountPage() {
    const signedOut = document.getElementById("account-signedout");
    const signedIn = document.getElementById("account-signedin");
    if (!signedOut && !signedIn) return;
    const signInBtn = document.getElementById("account-signin-btn");
    const signOutBtn = document.getElementById("account-signout-btn");
    const avatar = document.getElementById("account-profile-avatar");
    const nameInput = document.getElementById("account-profile-username");
    const bioInput = document.getElementById("account-bio");
    const emailEl = document.getElementById("account-email");
    const tagsEl = document.getElementById("account-tags");
    const saveBtn = document.getElementById("account-save-btn");
    const fileInput = document.getElementById("account-profile-file");
    const banner = document.getElementById("account-banner");
    const bannerFile = document.getElementById("account-banner-file");
    const statusEl = document.getElementById("account-status");

    // Neutral person-silhouette placeholder shown until a photo is set,
    // and a plain dark strip shown until a banner is set.
    const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%2321262d'/%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
    const BANNER_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 110'%3E%3Crect width='400' height='110' fill='%2321262d'/%3E%3C/svg%3E";

    let pendingPhoto = "";
    let pendingBanner = "";

    const setStatus = (msg, kind) => {
      if (!statusEl) return;
      statusEl.textContent = msg || "";
      statusEl.classList.remove("is-ok", "is-err", "is-pending");
      if (kind) statusEl.classList.add(`is-${kind}`);
    };

    const fill = (profile) => {
      pendingPhoto = (profile && profile.photo) || "";
      pendingBanner = (profile && profile.banner) || "";
      if (nameInput) nameInput.value = (profile && profile.username) || "";
      if (bioInput) bioInput.value = (profile && profile.bio) || "";
      if (tagsEl) {
        const tags = (profile && profile.tags) || [];
        tagsEl.textContent = "";
        tags.forEach(t => {
          const s = document.createElement("span");
          s.className = "account-tag";
          s.textContent = t;
          tagsEl.appendChild(s);
        });
        tagsEl.classList.toggle("hidden", !tags.length);
      }
      if (avatar) avatar.src = pendingPhoto || PLACEHOLDER;
      if (banner) banner.src = pendingBanner || BANNER_PLACEHOLDER;
    };

    // Toggle the signed-in / signed-out panes and load the profile.
    const render = (user) => {
      if (user) {
        signedOut?.classList.add("hidden");
        signedIn?.classList.remove("hidden");
        if (emailEl) emailEl.textContent = user.email || "";
        setStatus("");
        if (typeof window.loadUserProfile === "function") {
          window.loadUserProfile().then(p => fill(p || {}));
        } else {
          fill({});
        }
      } else {
        signedIn?.classList.add("hidden");
        signedOut?.classList.remove("hidden");
      }
    };

    if (typeof window.onAuthChange === "function") window.onAuthChange(render);
    else render(null);

    signInBtn?.addEventListener("click", () => {
      if (typeof window.showSignInPopup === "function") window.showSignInPopup({}).catch(() => {});
    });
    signOutBtn?.addEventListener("click", () => {
      if (typeof window.signOutCurrentUser !== "function") return;
      if (!confirm("Sign out of this account?")) return;
      window.signOutCurrentUser().catch(e => alert("Sign out failed: " + (e?.message || e)));
    });

    // Downscale a picked image to a small JPEG data-URL so the profile
    // record stays tiny enough to live in the Realtime Database.
    const downscale = (file, maxSize) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that file."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That file isn't a readable image."));
        img.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/jpeg", 0.82));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

    // Tap the avatar / banner image itself to change it.
    avatar?.addEventListener("click", () => fileInput?.click());

    fileInput?.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = ""; // let the same file be re-picked later
      if (!file) return;
      setStatus("Processing photo…", "pending");
      downscale(file, 128)
        .then(dataUrl => {
          pendingPhoto = dataUrl;
          if (avatar) avatar.src = dataUrl;
          setStatus("Photo ready — tap Save profile to keep it.", "ok");
        })
        .catch(e => setStatus(e.message || "Couldn't process that image.", "err"));
    });

    banner?.addEventListener("click", () => bannerFile?.click());

    bannerFile?.addEventListener("change", () => {
      const file = bannerFile.files && bannerFile.files[0];
      bannerFile.value = "";
      if (!file) return;
      setStatus("Processing banner…", "pending");
      downscale(file, 640)
        .then(dataUrl => {
          pendingBanner = dataUrl;
          if (banner) banner.src = dataUrl;
          setStatus("Banner ready — tap Save profile to keep it.", "ok");
        })
        .catch(e => setStatus(e.message || "Couldn't process that image.", "err"));
    });

    saveBtn?.addEventListener("click", () => {
      if (typeof window.saveUserProfile !== "function") return;
      const username = (nameInput?.value || "").trim();
      if (!username) { setStatus("Enter a username.", "err"); nameInput?.focus(); return; }
      setStatus("Saving…", "pending");
      saveBtn.disabled = true;
      window.saveUserProfile({ username, photo: pendingPhoto, banner: pendingBanner, bio: (bioInput?.value || "").trim() })
        .then(() => setStatus("Profile saved ✓", "ok"))
        .catch(e => setStatus(e.message || "Couldn't save your profile.", "err"))
        .finally(() => { saveBtn.disabled = false; });
    });
  })();
