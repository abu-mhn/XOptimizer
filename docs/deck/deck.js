// docs/js/deck.js - deck storage, rendering, add/remove/shuffle/reset/download (multi-deck)
const DECKS_KEY = "beyblade_decks";
const LEGACY_DECK_KEY = "beyblade_deck";
const LEGACY_DECK_NAME_KEY = "beyblade_deck_name";
const DECK_SIZE = 3;

function makeDeckId() {
  return "d-" + Math.random().toString(36).slice(2, 8) + "-" + Date.now().toString(36);
}

function blankDeck(name) {
  return {
    id: makeDeckId(),
    name: name || "",
    slots: [null, null, null],
    createdAt: new Date().toISOString()
  };
}

function loadDecksState() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem(DECKS_KEY) || "null"); } catch (e) {}
  if (state && Array.isArray(state.decks) && state.decks.length) {
    state.decks.forEach(d => {
      if (!Array.isArray(d.slots)) d.slots = [null, null, null];
      while (d.slots.length < DECK_SIZE) d.slots.push(null);
      d.slots = d.slots.slice(0, DECK_SIZE);
      if (!d.id) d.id = makeDeckId();
      if (d.name == null) d.name = "";
    });
    if (!state.decks.some(d => d.id === state.activeId)) {
      state.activeId = state.decks[0].id;
    }
    return state;
  }
  // Migrate legacy single-deck storage.
  let legacySlots = null;
  try { legacySlots = JSON.parse(localStorage.getItem(LEGACY_DECK_KEY) || "null"); } catch (e) {}
  const legacyName = localStorage.getItem(LEGACY_DECK_NAME_KEY) || "";
  const first = blankDeck(legacyName || "Deck 1");
  if (Array.isArray(legacySlots)) {
    first.slots = legacySlots.slice(0, DECK_SIZE);
    while (first.slots.length < DECK_SIZE) first.slots.push(null);
  }
  const migrated = { decks: [first], activeId: first.id };
  saveDecksState(migrated);
  return migrated;
}

function saveDecksState(state) {
  localStorage.setItem(DECKS_KEY, JSON.stringify(state));
  pushDecksToCloudIfSignedIn(state);
}

// ===== Cross-device deck sync =====
// When a user is signed in (Firebase Auth), decks live at
// `userDecks/{uid}` in the Realtime Database. Every local save also
// pushes to that path; a value listener pulls remote changes back into
// localStorage so the other device's edits show up. Signed-out users
// keep their decks purely in localStorage like before.
let deckCloudRef = null;
let deckApplyingRemote = false;

function deckStateIsMeaningful(state) {
  if (!state || !Array.isArray(state.decks) || !state.decks.length) return false;
  return state.decks.some(d =>
    (d.name && d.name.trim()) ||
    (Array.isArray(d.slots) && d.slots.some(s => s != null))
  );
}

function pushDecksToCloudIfSignedIn(state) {
  if (deckApplyingRemote) return;
  if (!deckCloudRef) return;
  // Sanitize for Firebase (no undefined values, slots as plain objects).
  // JSON round-trip is the simplest way to drop undefined / functions.
  let payload;
  try { payload = JSON.parse(JSON.stringify(state || {})); }
  catch (e) { return; }
  deckCloudRef.set(payload).catch(e => console.warn("Deck cloud push failed:", e));
}

function attachDeckCloudSync(uid) {
  detachDeckCloudSync();
  if (!uid) return;
  if (typeof firebase === "undefined" || !firebase.database) return;
  try {
    deckCloudRef = firebase.database().ref("userDecks/" + uid);
  } catch (e) { return; }
  deckCloudRef.on("value", snap => {
    const remote = snap.val();
    if (remote && Array.isArray(remote.decks) && remote.decks.length) {
      // Cloud has data — adopt it as the source of truth. Skips a
      // re-push by setting the applying-remote flag during writes.
      deckApplyingRemote = true;
      localStorage.setItem(DECKS_KEY, JSON.stringify(remote));
      deckApplyingRemote = false;
      if (typeof renderDeck === "function") renderDeck();
    } else {
      // First-time sign-in on any device — seed the cloud from whatever
      // decks the user has locally (if there's anything meaningful).
      let local = null;
      try { local = JSON.parse(localStorage.getItem(DECKS_KEY) || "null"); } catch (e) {}
      if (deckStateIsMeaningful(local)) {
        pushDecksToCloudIfSignedIn(local);
      }
    }
  }, err => console.warn("Deck cloud listen error:", err));
}

function detachDeckCloudSync() {
  if (deckCloudRef) {
    try { deckCloudRef.off(); } catch (e) {}
  }
  deckCloudRef = null;
}

// Wire the auth state. window.onAuthChange is exposed by js/auth.js.
if (typeof window !== "undefined") {
  const wireSync = () => {
    if (typeof window.onAuthChange !== "function") return;
    window.onAuthChange(user => {
      if (user && user.uid) attachDeckCloudSync(user.uid);
      else detachDeckCloudSync();
    });
  };
  // auth.js loads after deck.js — defer until the helper exists.
  if (typeof window.onAuthChange === "function") wireSync();
  else document.addEventListener("DOMContentLoaded", wireSync);
}

function getActiveDeck() {
  const state = loadDecksState();
  return state.decks.find(d => d.id === state.activeId) || state.decks[0];
}

function setActiveDeck(id) {
  const state = loadDecksState();
  if (!state.decks.some(d => d.id === id)) return;
  state.activeId = id;
  saveDecksState(state);
  renderDeck();
}

function createNewDeck() {
  const state = loadDecksState();
  const defaultName = `Deck ${state.decks.length + 1}`;
  const deck = blankDeck(defaultName);
  state.decks.push(deck);
  state.activeId = deck.id;
  saveDecksState(state);
  renderDeck();
  const input = document.getElementById("deck-name");
  if (input) {
    input.value = deck.name;
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
}

function deleteActiveDeck() {
  const state = loadDecksState();
  if (state.decks.length <= 1) {
    // Last deck: just clear its contents and name.
    if (!confirm("Clear this deck's slots and name?")) return;
    state.decks[0].slots = [null, null, null];
    state.decks[0].name = "";
    saveDecksState(state);
    const input = document.getElementById("deck-name");
    if (input) input.value = "";
    renderDeck();
    return;
  }
  const active = getActiveDeck();
  const label = active.name ? `"${active.name}"` : "this deck";
  if (!confirm(`Delete ${label}? This can't be undone.`)) return;
  state.decks = state.decks.filter(d => d.id !== active.id);
  state.activeId = state.decks[0].id;
  saveDecksState(state);
  renderDeck();
}

// --- Back-compat shims: all existing call sites operate on the active deck ---
function loadDeckName() {
  return getActiveDeck().name || "";
}

function saveDeckName(name) {
  const state = loadDecksState();
  const active = state.decks.find(d => d.id === state.activeId);
  if (!active) return;
  active.name = name || "";
  saveDecksState(state);
  renderDeckSelector();
}

function loadDeck() {
  const deck = getActiveDeck();
  const slots = Array.isArray(deck.slots) ? deck.slots.slice() : [null, null, null];
  while (slots.length < DECK_SIZE) slots.push(null);
  return slots.slice(0, DECK_SIZE);
}

function persistDeck(slots) {
  const state = loadDecksState();
  const active = state.decks.find(d => d.id === state.activeId);
  if (!active) return;
  active.slots = slots;
  saveDecksState(state);
}

const LOCK_CHIP_EXCLUSIVE = new Set(["Emperor", "Valkyrie"]);

function isCountedPart(key, name) {
  if (!name) return false;
  if (key === "lockChip") return LOCK_CHIP_EXCLUSIVE.has(name);
  return true;
}

function collectDeckPartNames(deck) {
  const used = new Set();
  deck.forEach(slot => {
    if (!slot || !slot.data || !slot.data.parts) return;
    Object.entries(slot.data.parts).forEach(([key, name]) => {
      if (isCountedPart(key, name)) used.add(name);
    });
  });
  return used;
}

function addCurrentToDeck() {
  const history = JSON.parse(localStorage.getItem("beyblade_history") || "[]");
  const current = history[0];
  if (!current) {
    alert("No combo to add — calculate one first.");
    return;
  }
  const deck = loadDeck();
  const slot = deck.findIndex(s => s == null);
  if (slot === -1) {
    alert("Deck is full. Remove a slot first.");
    return;
  }

  const used = collectDeckPartNames(deck);
  const currentPartEntries = (current.data && current.data.parts) ? Object.entries(current.data.parts) : [];
  const clash = currentPartEntries.find(([key, name]) => isCountedPart(key, name) && used.has(name));
  if (clash) {
    alert(`Can't add — "${clash[1]}" is already used in the deck.`);
    return;
  }

  deck[slot] = {
    mode: current.mode,
    time: new Date().toISOString(),
    data: current.data
  };
  persistDeck(deck);
  const btn = document.querySelector(".btn-add-deck");
  if (btn) {
    const origHtml = btn.innerHTML;
    btn.innerHTML = `<img src="assets/icons/thumbs-up.png" alt="Added"
      onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','Added');">`;
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = false; }, 1200);
  }
}

function removeDeckSlot(idx) {
  const deck = loadDeck();
  deck[idx] = null;
  persistDeck(deck);
  renderDeck();
}

function renderDeckSelector() {
  const container = document.getElementById("deck-selector");
  if (!container) return;
  const state = loadDecksState();
  const pills = state.decks.map(d => {
    const label = (d.name && d.name.trim()) || "(unnamed)";
    const isActive = d.id === state.activeId;
    return `<button type="button" class="deck-pill ${isActive ? "active" : ""}" data-deck-id="${escapeHtml(d.id)}" title="Switch to this deck">
      <span class="deck-pill-label">${escapeHtml(label)}</span>
    </button>`;
  }).join("");
  container.innerHTML = pills +
    `<button type="button" class="deck-pill deck-pill-new" id="deck-new" title="Create a new deck">
      <span class="deck-pill-plus">+</span>
      <span class="deck-pill-label">New</span>
    </button>`;
  container.querySelectorAll(".deck-pill[data-deck-id]").forEach(btn => {
    btn.addEventListener("click", () => setActiveDeck(btn.dataset.deckId));
  });
  container.querySelector("#deck-new")?.addEventListener("click", createNewDeck);
}

const PART_FOLDER = {
  blade: "blades", lockChip: "lockChips",
  mainBlade: "mainBlades", assistBlade: "assistBlades",
  metalBlade: "metalBlades", overBlade: "overBlades",
  ratchet: "ratchets", bit: "bits", ratchetBit: "ratchetBits"
};
// A ratchet-bit (e.g. "Operate") is saved under the `bit` key, but its images
// live in assets/ratchetBits — not assets/bits. mergeBits() tags each merged
// ratchet-bit with `_folder`, so resolve the bit folder from there (same as
// the History view). Without this the image 404s and the onerror handler
// hides the whole part (blank thumbnail).
function partFolderFor(key, name) {
  if (key !== "bit") return PART_FOLDER[key];
  const found = DATA.bits?.find(b => b.name === name);
  return found?._folder || "bits";
}
// Fixed top -> bottom display order, regardless of how `parts` was keyed.
const PART_ORDER = [
  "blade", "lockChip", "mainBlade", "metalBlade", "overBlade",
  "assistBlade", "ratchet", "ratchetBit", "bit"
];

// The selectable modes for a slot part (e.g. Operate: Defense / Attack), or
// null when the part has 0/1 modes. Looks in the image folder, which for a
// ratchet-bit is the modes-bearing record.
function deckPartModeList(key, name) {
  const rec = (DATA[partFolderFor(key, name)] || []).find(p => p.name === name);
  return (rec && Array.isArray(rec.modes) && rec.modes.length > 1) ? rec.modes : null;
}

// Re-run the calculator for a slot with one part's mode overridden, then save
// the recomputed combo. Mirrors saveDeckEdit's recalc, but sources the parts
// from the stored slot instead of the edit popup — used by the inline mode
// toggle on each slot so changing a part's mode updates its image + stats.
function runDeckSlotModeChange(slotIdx, field, newModeIdx) {
  const deck = loadDeck();
  const slot = deck[slotIdx];
  if (!slot || !slot.data) return;
  const lineMode = DECK_EDIT_FIELDS[slot.mode] ? slot.mode : "BX";
  const formId = lineMode === "CX" ? "form-cx" : lineMode === "CX_EXPAND" ? "form-cxExpand" : "form-standard";
  const form = document.getElementById(formId);
  const calcFn = lineMode === "CX" ? (typeof calcCX === "function" && calcCX)
    : lineMode === "CX_EXPAND" ? (typeof calcCXExpand === "function" && calcCXExpand)
    : (typeof calcStandard === "function" && calcStandard);
  if (!form || !calcFn) { alert("Calculator isn't available on this page."); return; }

  const parts = slot.data.parts || {};
  const savedModes = slot.data.partModes || {};

  // Replay every field of the combo into the hidden calculator form, applying
  // the requested mode override (and keeping each other part's saved mode).
  (DECK_EDIT_FIELDS[lineMode] || DECK_EDIT_FIELDS.BX).forEach(([f]) => {
    const arrKey = DECK_EDIT_FIELD_ARR[f];
    const target = form.querySelector(`[name="${f}"]`);
    const name = parts[f];
    if (f === "ratchet" && !name) { if (target) target.value = NO_RATCHET; return; }
    if (!name) { if (target) target.value = ""; return; }
    const list = DATA[arrKey] || [];
    const i = list.findIndex(p => p.name === name);
    if (i < 0) { if (target) target.value = ""; return; }
    if (target) target.value = String(i);
    const part = list[i];
    if (part && Array.isArray(part.modes) && part.modes.length) {
      const ov = (f === field) ? newModeIdx : savedModes[f];
      const m = (typeof ov === "number" && ov >= 0) ? Math.min(ov, part.modes.length - 1) : 0;
      part._modeIndex = m;
    }
  });

  // Snapshot history + result so the silent recalc doesn't leak into either.
  const HKEY = "beyblade_history";
  const histBefore = localStorage.getItem(HKEY);
  const resultEl = document.getElementById("result");
  const resultWasHidden = resultEl ? resultEl.classList.contains("hidden") : true;
  let fresh = null;
  try {
    calcFn(form);
    fresh = (JSON.parse(localStorage.getItem(HKEY) || "[]"))[0] || null;
  } catch (e) {
    fresh = null;
  }
  localStorage.setItem(HKEY, histBefore || "[]");
  if (resultEl && resultWasHidden) resultEl.classList.add("hidden");
  if (!fresh || !fresh.data) { alert("Couldn't recalculate this combo."); return; }

  deck[slotIdx] = { mode: fresh.mode, time: new Date().toISOString(), data: fresh.data };
  persistDeck(deck);
  renderDeck();
}

function renderDeck() {
  renderDeckSelector();
  const container = document.getElementById("deck-list");
  if (!container) return;
  const nameInput = document.getElementById("deck-name");
  if (nameInput && nameInput.value !== loadDeckName()) nameInput.value = loadDeckName();
  const deck = loadDeck();
  container.innerHTML = "";

  deck.forEach((item, idx) => {
    const div = document.createElement("div");
    div.className = "deck-slot";
    if (!item) {
      div.classList.add("deck-slot-empty");
      div.innerHTML = `<div class="deck-slot-label">Slot ${idx + 1}</div><div class="deck-slot-empty-text">Empty</div>`;
      container.appendChild(div);
      return;
    }
    const data = item.data || {};
    const total = data.grandTotal || {};
    const spinDir = resolveSpinDirection(data);
    const atk = total.ATK, def = total.DEF, sta = total.STA;
    const isFullTBA = atk === "TBA" && def === "TBA" && sta === "TBA";
    const type = isFullTBA ? "TBA" : getType(Number(atk), Number(def), Number(sta), false);

    const parts = data.parts || {};
    const partModes = data.partModes || {};
    const resolvePart = (key, name) => {
      const modeIdx = partModes[key] != null ? partModes[key] : null;
      const folder = partFolderFor(key, name);
      return { src: partImgPath(folder, name, modeIdx), codename: partRecordCodename(folder, name, modeIdx) };
    };
    let partsHtml = "";
    // CX / CX Expand combos show the lock chip + blade(s) + assist blade
    // stacked into one combined thumbnail.
    const combined = combinedBladeTileHTML(parts, resolvePart);
    if (combined) partsHtml += combined.html;
    for (const key of PART_ORDER) {
      const name = parts[key];
      if (!name || !PART_FOLDER[key]) continue;
      if (combined && combined.usedKeys.has(key)) continue;
      const modeIdx = partModes[key] != null ? partModes[key] : null;
      const src = partImgPath(partFolderFor(key, name), name, modeIdx);
      // Multi-mode parts (e.g. Operate: Defense / Attack) get an inline mode
      // toggle right under the thumbnail — tap to switch and recompute.
      const modeList = deckPartModeList(key, name);
      let modeBadge = "";
      if (modeList) {
        const mi = (modeIdx != null && modeIdx >= 0 && modeIdx < modeList.length) ? modeIdx : 0;
        const modeName = modeList[mi].modeName || `Mode ${mi + 1}`;
        modeBadge = `<button type="button" class="result-part-mode" data-slot="${idx}" data-field="${key}" title="Switch mode">
          <span class="result-part-mode-name">${modeName}</span>
          <span class="result-part-mode-arrow" aria-hidden="true">&#8635;</span>
        </button>`;
      }
      partsHtml += `<div class="result-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${name}" class="result-part-img"
               onerror="this.closest('.result-part').style.display='none'">
        </div>
        <span class="result-part-name">${name}</span>
        ${modeBadge}
      </div>`;
    }

    // Stat graph (bar or radar, following the user's Stat-display setting).
    // renderStatBars lives in calculator.js, which loads before this file.
    const graphHtml = (typeof renderStatBars === "function") ? renderStatBars(total) : "";
    div.innerHTML = `
      <div class="deck-slot-header">
        <strong class="deck-slot-label">Slot ${idx + 1}</strong>
        <div class="deck-slot-actions">
          <button type="button" class="btn-deck-edit" data-slot="${idx}" aria-label="Edit slot ${idx + 1}" title="Edit combo">
            <img src="assets/icons/pencil.png" alt="Edit"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x270E;');">
          </button>
          <button type="button" class="btn-deck-remove" data-slot="${idx}" aria-label="Remove slot ${idx + 1}" title="Remove">&times;</button>
        </div>
      </div>
      <div class="history-header">
        <strong class="history-name">${data.comboName || "Unknown Combo"}</strong>
        <span class="history-icons">${typeLogo(type)}${spinLogo(spinDir)}</span>
      </div>
      ${partsHtml ? `<div class="result-parts">${partsHtml}</div>` : ""}
      <div class="deck-slot-stats">
        <span><b>ATK:</b> ${atk ?? "-"}</span>
        <span><b>DEF:</b> ${def ?? "-"}</span>
        <span><b>STA:</b> ${sta ?? "-"}</span>
        <span><b>Weight:</b> ${total.Weight ?? "-"}</span>
      </div>
      ${graphHtml ? `
      <button type="button" class="deck-slot-graph-toggle" aria-expanded="false">
        <span class="deck-slot-graph-toggle-label">Stat Graph</span>
        <span class="deck-slot-graph-caret" aria-hidden="true">+</span>
      </button>
      <div class="deck-slot-graph hidden">${graphHtml}</div>` : ""}
      <hr/>
    `;
    container.appendChild(div);
  });

  container.querySelectorAll(".btn-deck-remove").forEach(btn => {
    btn.addEventListener("click", () => removeDeckSlot(Number(btn.dataset.slot)));
  });
  container.querySelectorAll(".btn-deck-edit").forEach(btn => {
    btn.addEventListener("click", () => openDeckEdit(Number(btn.dataset.slot)));
  });
  // Inline part mode toggle — cycle a multi-mode part (e.g. Operate) to its
  // next mode and recompute the slot.
  container.querySelectorAll(".result-part-mode").forEach(btn => {
    btn.addEventListener("click", () => {
      const slotIdx = Number(btn.dataset.slot);
      const field = btn.dataset.field;
      const item = loadDeck()[slotIdx];
      const name = item && item.data && item.data.parts ? item.data.parts[field] : null;
      const modeList = name ? deckPartModeList(field, name) : null;
      if (!modeList) return;
      const cur = (item.data.partModes && typeof item.data.partModes[field] === "number")
        ? item.data.partModes[field] : 0;
      runDeckSlotModeChange(slotIdx, field, (cur + 1) % modeList.length);
    });
  });
  // Collapsible stat-graph dropdown per slot.
  container.querySelectorAll(".deck-slot-graph-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const graph = btn.nextElementSibling;
      if (!graph) return;
      const isOpen = graph.classList.toggle("hidden") === false;
      btn.setAttribute("aria-expanded", String(isOpen));
      btn.classList.toggle("open", isOpen);
      const caret = btn.querySelector(".deck-slot-graph-caret");
      if (caret) caret.textContent = isOpen ? "−" : "+"; // − / +
    });
  });
  // Part rows scroll sideways via swipe on touch; on desktop translate a
  // vertical mouse wheel into horizontal scroll so longer combos (CX) reach
  // every part. No-op on touch (no wheel events) and when nothing overflows.
  if (typeof enableHorizontalWheelScroll === "function") {
    container.querySelectorAll(".result-parts").forEach(enableHorizontalWheelScroll);
  }
}

// Render the current deck to a square PNG canvas off-screen and hand it to
// `onReady(canvas, deckName)`. Shared by Download (saves the PNG) and Share
// (hands the PNG to the Web Share API).
function renderDeckCanvas(onReady) {
  const deckList = document.getElementById("deck-list");
  if (!deckList) return;
  const deck = loadDeck();
  if (deck.every(s => s == null)) {
    alert("Deck is empty.");
    return;
  }

  const cls = document.body.classList;
  const isLove = cls.contains("love-mode");
  const isForest = cls.contains("forest-mode");
  const isLightLike = cls.contains("light-mode") || cls.contains("tropical-mode") || isLove || isForest;
  const isTropical = cls.contains("tropical-mode");
  const footerColor = isForest ? "#5a6a4b" : isLove ? "#9c4a5e" : isTropical ? "#8a6d3b" : isLightLike ? "#656d76" : "#8b949e";
  const footerBorder = isForest ? "#b5c89a" : isLove ? "#ffc1d2" : isTropical ? "#ffd8a8" : isLightLike ? "#d1d9e0" : "#21262d";
  const strongColor = isForest ? "#2d3e1f" : isLove ? "#4a1d2a" : isTropical ? "#2d3a3a" : isLightLike ? "#1f2328" : "#c9d1d9";
  const pageBg = isForest ? "#f0f4e8" : isLove ? "#fff0f5" : isTropical ? "#fff6e6" : cls.contains("light-mode") ? "#f6f8fa" : cls.contains("space-mode") ? "#0b0d1a" : cls.contains("stormy-mode") ? "#1e2330" : cls.contains("mono-mode") ? "#000000" : "#0d1117";
  const logoSrc = isLightLike ? "assets/icons/revoxNameLight.webp" : "assets/icons/revoxName.webp";

  const wrap = document.createElement("div");
  wrap.style.cssText = `position:fixed;left:-9999px;top:0;width:800px;background:${pageBg};padding:24px;color:${strongColor};font-family:inherit;`;
  const title = document.createElement("div");
  title.style.cssText = `font-size:20px;font-weight:700;text-align:center;margin-bottom:16px;color:${strongColor};`;
  const deckName = (loadDeckName() || "").trim();
  title.textContent = deckName ? `Deck — ${deckName}` : "Deck";
  wrap.appendChild(title);

  const clone = deckList.cloneNode(true);
  // Drop the per-slot action buttons (edit pencil + remove ×) — they're
  // interactive controls, not deck content, so they shouldn't appear in
  // the exported image. Removing the whole .deck-slot-actions wrapper
  // also takes the edit button's blue focus border with it.
  clone.querySelectorAll(".deck-slot-actions").forEach(el => el.remove());
  clone.querySelectorAll(".btn-deck-remove, .btn-deck-edit").forEach(b => b.remove());
  // The stat-graph dropdown and inline part mode toggles are interactive
  // controls — drop them so the exported image stays clean.
  clone.querySelectorAll(".deck-slot-graph-toggle, .deck-slot-graph, .result-part-mode").forEach(el => el.remove());
  wrap.appendChild(clone);

  const footer = document.createElement("div");
  footer.style.cssText = `text-align:center;padding:12px 0 8px;font-size:12px;color:${footerColor};border-top:1px solid ${footerBorder};margin-top:12px;`;
  footer.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;width:100%;text-align:center;">
      <span style="display:flex;align-items:center;gap:4px;">X Optimizer</span>
      <span style="opacity:0.5;">&bull;</span>
      <span style="display:flex;align-items:center;gap:4px;">Created by <strong style="color:${strongColor};">RvX Ashwolf</strong></span>
      <span style="display:flex;align-items:center;gap:4px;width:100%;justify-content:center;margin-top:6px;">Powered by <img src="${logoSrc}" alt="Revox" style="height:40px;width:auto;transform:translateY(-5px);"></span>
    </div>`;
  wrap.appendChild(footer);

  document.body.appendChild(wrap);

  awaitImagesReady(wrap)
    .then(() => inlineImagesAsDataUrls(wrap))
    .then(() => html2canvas(wrap, { backgroundColor: pageBg, scale: 2, useCORS: true, width: 800 }))
    .then(canvas => {
      document.body.removeChild(wrap);

      const side = Math.max(canvas.width, canvas.height);
      const square = document.createElement("canvas");
      square.width = side;
      square.height = side;
      const ctx = square.getContext("2d");
      ctx.fillStyle = pageBg;
      ctx.fillRect(0, 0, side, side);
      ctx.drawImage(canvas, Math.floor((side - canvas.width) / 2), Math.floor((side - canvas.height) / 2));

      onReady(square, deckName);
    })
    .catch(() => {
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      alert("Failed to generate deck image.");
    });
}

// Turn the deck name into a filesystem-safe PNG filename.
function deckPngFileName(deckName) {
  const safeName = (deckName || "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  return (safeName || "deck") + ".png";
}

function downloadDeckPNG() {
  renderDeckCanvas((square, deckName) => {
    const link = document.createElement("a");
    link.download = deckPngFileName(deckName);
    link.href = square.toDataURL("image/png");
    link.click();
  });
}

// Share the deck image via the Web Share API. Falls back to a plain download
// when the browser can't share files (e.g. most desktop browsers).
function shareDeck() {
  renderDeckCanvas((square, deckName) => {
    const fileName = deckPngFileName(deckName);
    const title = deckName ? `Deck — ${deckName}` : "Deck";

    const downloadFallback = () => {
      const link = document.createElement("a");
      link.download = fileName;
      link.href = square.toDataURL("image/png");
      link.click();
    };

    if (!square.toBlob || !navigator.share) {
      downloadFallback();
      return;
    }

    square.toBlob(blob => {
      if (!blob) { downloadFallback(); return; }
      const file = new File([blob], fileName, { type: "image/png" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        downloadFallback();
        return;
      }
      navigator.share({ files: [file], title }).catch(err => {
        // AbortError = user dismissed the share sheet; not a failure.
        if (err && err.name === "AbortError") return;
        downloadFallback();
      });
    }, "image/png");
  });
}

function resetDeck() {
  deleteActiveDeck();
}

function shuffleDeck() {
  const deck = loadDeck();
  if (deck.filter(s => s != null).length < 2) return;
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  persistDeck(deck);
  renderDeck();
}

document.getElementById("deck-download")?.addEventListener("click", downloadDeckPNG);
document.getElementById("deck-share")?.addEventListener("click", shareDeck);
document.getElementById("deck-reset")?.addEventListener("click", resetDeck);
document.getElementById("deck-shuffle")?.addEventListener("click", shuffleDeck);
document.getElementById("deck-copy")?.addEventListener("click", copyDeckForTournamentRegistration);

// The toolbar + deck-name pill rows scroll sideways when their buttons
// overflow (icon + label can't fit on narrow viewports). On touch a swipe
// scrolls them; on desktop translate a vertical mouse wheel into horizontal
// scroll. These containers are static (only their innerHTML changes on
// re-render), so bind once here to avoid stacking duplicate wheel listeners.
if (typeof enableHorizontalWheelScroll === "function") {
  enableHorizontalWheelScroll(document.querySelector(".deck-toolbar"));
  enableHorizontalWheelScroll(document.getElementById("deck-selector"));
}

// Serialize the active deck into the same shape the Bey Check / tournament
// registration popup uses (each slot: { mode, parts }) and write it to the
// clipboard with a small wrapper so the paste side can recognise our payload
// vs. random clipboard text.
const TOURNAMENT_DECK_CLIPBOARD_TYPE = "x-optimizer-deck";
const TOURNAMENT_DECK_CLIPBOARD_VERSION = 1;

const CALC_MODE_TO_BEY_CHECK = { BX: "standard", CX: "cx", CX_EXPAND: "cxExpand" };

function deckSlotToBeyCheckShape(slot) {
  if (!slot || !slot.data || !slot.data.parts) {
    return { mode: "standard", parts: {} };
  }
  const mapped = CALC_MODE_TO_BEY_CHECK[slot.mode] || "standard";
  return {
    mode: mapped,
    parts: { ...slot.data.parts }
  };
}

function copyDeckForTournamentRegistration() {
  const slots = loadDeck();
  const deck = slots.map(deckSlotToBeyCheckShape);
  const payload = JSON.stringify({
    type: TOURNAMENT_DECK_CLIPBOARD_TYPE,
    v: TOURNAMENT_DECK_CLIPBOARD_VERSION,
    name: (loadDeckName() || "").trim() || null,
    deck,
    // Full slot objects so Paste can restore the deck (stats included).
    slots
  });
  const btn = document.getElementById("deck-copy");
  const flash = (ok) => {
    if (!btn) return;
    const origHtml = btn.innerHTML;
    btn.innerHTML = ok
      ? `<img src="assets/icons/thumbs-up.png" alt="Copied"
           onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2713;');">`
      : `&#x2715;`; // ✕
    btn.disabled = true;
    btn.classList.toggle("btn-reset", !ok);
    setTimeout(() => {
      btn.innerHTML = origHtml;
      btn.disabled = false;
      btn.classList.remove("btn-reset");
    }, 1200);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(payload)
      .then(() => flash(true))
      .catch(() => flash(false));
    return;
  }
  // Fallback: temp textarea + execCommand for older browsers / non-HTTPS.
  try {
    const ta = document.createElement("textarea");
    ta.value = payload;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    flash(ok);
  } catch (e) {
    flash(false);
  }
}

const BEY_CHECK_TO_CALC_MODE = { standard: "BX", cx: "CX", cxExpand: "CX_EXPAND" };

// Inverse of deckSlotToBeyCheckShape: rebuild a deck slot from a bey-check
// shape ({ mode, parts }). That shape carries no stats, so a slot built this
// way shows no totals (used only when a payload has no full `slots`).
function beyCheckShapeToDeckSlot(shape) {
  if (!shape || !shape.parts || Object.keys(shape.parts).length === 0) return null;
  return {
    mode: BEY_CHECK_TO_CALC_MODE[shape.mode] || "BX",
    time: new Date().toISOString(),
    data: { parts: { ...shape.parts }, partModes: {}, grandTotal: {} }
  };
}

// Read a copied deck from the clipboard and load it into the active deck.
function pasteDeckFromClipboard() {
  const btn = document.getElementById("deck-paste");
  const flash = (ok) => {
    if (!btn) return;
    const origHtml = btn.innerHTML;
    btn.innerHTML = ok
      ? `<img src="assets/icons/thumbs-up.png" alt="Pasted"
           onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2713;');">`
      : `<img src="assets/icons/delete.png" alt="Failed"
           onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2715;');">`;
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = origHtml; btn.disabled = false; }, 1200);
  };

  const apply = (text) => {
    let payload = null;
    try { payload = JSON.parse(text); } catch (e) {}
    if (!payload || payload.type !== TOURNAMENT_DECK_CLIPBOARD_TYPE) {
      alert("Clipboard doesn't contain a copied deck. Use Copy on a deck first.");
      flash(false);
      return;
    }
    let slots = Array.isArray(payload.slots) ? payload.slots.slice() : null;
    if (!slots && Array.isArray(payload.deck)) {
      slots = payload.deck.map(beyCheckShapeToDeckSlot);
    }
    if (!slots) {
      alert("Couldn't read the copied deck.");
      flash(false);
      return;
    }
    slots = slots.slice(0, DECK_SIZE);
    while (slots.length < DECK_SIZE) slots.push(null);

    const current = loadDeck();
    if (current.some(s => s != null) &&
        !confirm("Replace the current deck with the pasted one?")) return;

    persistDeck(slots);
    if (payload.name) saveDeckName(payload.name);
    const input = document.getElementById("deck-name");
    if (input) input.value = loadDeckName();
    renderDeck();
    flash(true);
  };

  if (navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText()
      .then(apply)
      .catch(() => {
        const text = prompt("Paste the copied deck here:");
        if (text != null) apply(text);
      });
  } else {
    const text = prompt("Paste the copied deck here:");
    if (text != null) apply(text);
  }
}

document.getElementById("deck-paste")?.addEventListener("click", pasteDeckFromClipboard);

// =========================
// EDIT A DECK SLOT'S COMBO
// =========================
const DECK_EDIT_FIELD_ARR = {
  blade: "blades", ratchet: "ratchets", bit: "bits",
  lockChip: "lockChips", mainBlade: "mainBlades", assistBlade: "assistBlades",
  metalBlade: "metalBlades", overBlade: "overBlades"
};

const DECK_EDIT_FIELDS = {
  BX: [["blade", "Blade"], ["ratchet", "Ratchet"], ["bit", "Bit"]],
  CX: [["lockChip", "Lock Chip"], ["mainBlade", "Main Blade"], ["assistBlade", "Assist Blade"],
       ["ratchet", "Ratchet"], ["bit", "Bit"]],
  CX_EXPAND: [["lockChip", "Lock Chip"], ["metalBlade", "Metal Blade"], ["overBlade", "Over Blade"],
              ["assistBlade", "Assist Blade"], ["ratchet", "Ratchet"], ["bit", "Bit"]]
};

let deckEditSlotIdx = -1;
let deckEditMode = "BX";
// Current chosen value per field key (index string, or NO_RATCHET). Survives
// mode switches so shared fields (ratchet/bit/lock chip/assist blade) keep
// their selection.
let deckEditValues = {};
// Chosen mode index per field for multi-mode parts (a blade/bit/etc. with a
// `.modes` array). Seeded from the slot's saved partModes, reset to 0 when the
// part itself changes, and applied at save time.
let deckEditPartModes = {};

// The DATA part currently selected for a field (null for empty / No-Ratchet).
function deckEditPartFor(field) {
  const arrKey = DECK_EDIT_FIELD_ARR[field];
  const v = deckEditValues[field];
  if (!arrKey || v == null || v === "" || v === NO_RATCHET) return null;
  return (DATA[arrKey] || [])[Number(v)] || null;
}

// The selectable modes for a field, or null when the part has 0/1 modes
// (nothing to switch).
function deckEditModesFor(field) {
  const part = deckEditPartFor(field);
  return (part && Array.isArray(part.modes) && part.modes.length > 1) ? part.modes : null;
}

// Render (or hide) the mode switch for one field, reflecting the current
// selection and chosen mode index.
function updateDeckEditModeRow(field) {
  const row = document.querySelector(`#deck-edit-fields .deck-edit-mode-row[data-mode-field="${field}"]`);
  if (!row) return;
  const modes = deckEditModesFor(field);
  if (!modes) {
    row.hidden = true;
    row.innerHTML = "";
    return;
  }
  let idx = deckEditPartModes[field];
  if (typeof idx !== "number" || idx < 0 || idx >= modes.length) { idx = 0; }
  deckEditPartModes[field] = idx;
  const name = modes[idx].modeName || `Mode ${idx + 1}`;
  row.hidden = false;
  row.innerHTML = `<span class="deck-edit-mode-key">Mode</span>
    <button type="button" class="deck-edit-mode-btn" data-mode-field="${field}" title="Switch mode">
      <span class="deck-edit-mode-name">${name}</span>
      <span class="deck-edit-mode-arrow" aria-hidden="true">&#8635;</span>
    </button>`;
}

function buildDeckEditPopup() {
  if (document.getElementById("deck-edit-popup")) return;
  const overlay = document.createElement("div");
  overlay.id = "deck-edit-popup";
  overlay.className = "popup-overlay hidden";
  overlay.innerHTML = `
    <div class="popup-card deck-edit-card">
      <h2 class="popup-title">Edit Combo</h2>
      <p class="popup-text" id="deck-edit-subtitle"></p>
      <div class="deck-edit-modes" id="deck-edit-modes">
        <button type="button" class="sub-tab deck-edit-mode-tab" data-mode="BX" aria-label="Basic / Unique Line" title="Basic / Unique Line">
          <img src="assets/line/Basic_Line_Logo.webp" alt="Basic Line"> /
          <img src="assets/line/Unique_Line_Logo.webp" alt="Unique Line">
        </button>
        <button type="button" class="sub-tab deck-edit-mode-tab" data-mode="CX" aria-label="Custom Line" title="Custom Line">
          <img src="assets/line/Custom_Line_Logo.webp" alt="Custom Line">
        </button>
        <button type="button" class="sub-tab deck-edit-mode-tab" data-mode="CX_EXPAND" aria-label="Custom Line Expand" title="Custom Line Expand">
          <img src="assets/line/Custom_Line_Logo.webp" alt="Custom Line">
          <img src="assets/line/Expand_Blade_Logo.webp" alt="Expand Blade">
        </button>
      </div>
      <div id="deck-edit-fields" class="deck-edit-fields"></div>
      <div class="popup-actions">
        <button type="button" class="btn popup-ok" id="deck-edit-save" aria-label="Save" title="Save">
          <img src="assets/icons/diskette.png" alt="Save"
               onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2713;');">
          <span class="btn-label">Save</span>
        </button>
        <button type="button" class="btn popup-cancel" id="deck-edit-cancel" aria-label="Cancel" title="Cancel">
          <img src="assets/icons/exit-button.png" alt="Cancel"
               onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2715;');">
          <span class="btn-label">Cancel</span>
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeDeckEdit(); });
  document.getElementById("deck-edit-cancel").addEventListener("click", closeDeckEdit);
  document.getElementById("deck-edit-save").addEventListener("click", saveDeckEdit);
  document.querySelectorAll("#deck-edit-modes .deck-edit-mode-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      if (tab.dataset.mode === deckEditMode) return;
      captureDeckEditValues();
      deckEditMode = tab.dataset.mode;
      setDeckEditModeTab();
      renderDeckEditFields();
    });
  });
  // Cycle a multi-mode part's mode. Delegated on the fields host (bound once)
  // so it survives every renderDeckEditFields rebuild.
  document.getElementById("deck-edit-fields").addEventListener("click", (e) => {
    const btn = e.target.closest(".deck-edit-mode-btn");
    if (!btn) return;
    const field = btn.dataset.modeField;
    const modes = deckEditModesFor(field);
    if (!modes) return;
    const cur = (typeof deckEditPartModes[field] === "number") ? deckEditPartModes[field] : 0;
    deckEditPartModes[field] = (cur + 1) % modes.length;
    updateDeckEditModeRow(field);
  });
}

function setDeckEditModeTab() {
  document.querySelectorAll("#deck-edit-modes .deck-edit-mode-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.mode === deckEditMode);
  });
}

function closeDeckEdit() {
  deckEditSlotIdx = -1;
  document.getElementById("deck-edit-popup")?.classList.add("hidden");
}

// Read the current dropdown selections back into deckEditValues.
function captureDeckEditValues() {
  document.querySelectorAll("#deck-edit-fields select[data-field]").forEach(sel => {
    deckEditValues[sel.dataset.field] = sel.value;
  });
}

// Render the part dropdowns for the currently chosen mode, using the same
// searchable dropdowns as the calculator. Pre-selects from deckEditValues so
// a mode switch keeps whatever still applies.
function renderDeckEditFields() {
  const fields = DECK_EDIT_FIELDS[deckEditMode] || DECK_EDIT_FIELDS.BX;
  const host = document.getElementById("deck-edit-fields");
  host.innerHTML = fields.map(([key, label]) =>
    `<div class="deck-edit-field-group">
      <label class="deck-edit-field">
        <span class="deck-edit-field-label">${label}</span>
        <select data-field="${key}"></select>
      </label>
      <div class="deck-edit-mode-row" data-mode-field="${key}" hidden></div>
    </div>`
  ).join("");

  fields.forEach(([key]) => {
    const sel = host.querySelector(`select[data-field="${key}"]`);
    if (!sel) return;
    const list = DATA[DECK_EDIT_FIELD_ARR[key]] || [];
    const prepend = key === "ratchet" ? [{ value: NO_RATCHET, label: "No Ratchet" }] : [];
    if (typeof makeSearchable === "function") makeSearchable(sel, list, p => p.name, prepend);
    const wrapper = sel.nextElementSibling;
    const cur = deckEditValues[key];
    if (wrapper && wrapper._select) {
      if (cur === NO_RATCHET) wrapper._select(NO_RATCHET);
      else if (cur != null && cur !== "" && list[Number(cur)]) wrapper._select(Number(cur));
    }
    // Listener attaches AFTER the preselect above, so seeding a value never
    // counts as a user change — that keeps the slot's saved mode intact.
    sel.addEventListener("change", () => {
      deckEditValues[key] = sel.value;
      // A different part was chosen — its old mode index no longer applies.
      delete deckEditPartModes[key];
      updateDeckEditModeRow(key);
    });
    updateDeckEditModeRow(key);
  });
}

function openDeckEdit(slotIdx) {
  const deck = loadDeck();
  const slot = deck[slotIdx];
  if (!slot) return;

  buildDeckEditPopup();
  deckEditSlotIdx = slotIdx;
  deckEditMode = DECK_EDIT_FIELDS[slot.mode] ? slot.mode : "BX";
  const parts = (slot.data && slot.data.parts) || {};

  // Pre-fill every dropdown from the slot's current combo (name -> index).
  deckEditValues = {};
  Object.keys(DECK_EDIT_FIELD_ARR).forEach(key => {
    const name = parts[key];
    if (!name) return;
    const list = DATA[DECK_EDIT_FIELD_ARR[key]] || [];
    const i = list.findIndex(p => p.name === name);
    if (i >= 0) deckEditValues[key] = String(i);
  });
  if (!parts.ratchet) deckEditValues.ratchet = NO_RATCHET;

  // Seed each multi-mode part's chosen mode from the slot's saved partModes.
  deckEditPartModes = {};
  const savedModes = (slot.data && slot.data.partModes) || {};
  Object.keys(savedModes).forEach(k => {
    if (typeof savedModes[k] === "number" && savedModes[k] >= 0) deckEditPartModes[k] = savedModes[k];
  });

  document.getElementById("deck-edit-subtitle").textContent = `Slot ${slotIdx + 1}`;
  setDeckEditModeTab();
  renderDeckEditFields();
  document.getElementById("deck-edit-popup").classList.remove("hidden");
}

function saveDeckEdit() {
  if (deckEditSlotIdx < 0) return;
  const deck = loadDeck();
  const slot = deck[deckEditSlotIdx];
  if (!slot) { closeDeckEdit(); return; }
  const mode = deckEditMode;
  const formId = mode === "CX" ? "form-cx" : mode === "CX_EXPAND" ? "form-cxExpand" : "form-standard";
  const form = document.getElementById(formId);
  const calcFn = mode === "CX" ? (typeof calcCX === "function" && calcCX)
    : mode === "CX_EXPAND" ? (typeof calcCXExpand === "function" && calcCXExpand)
    : (typeof calcStandard === "function" && calcStandard);
  if (!form || !calcFn) { alert("Calculator isn't available on this page."); return; }

  const selects = [...document.querySelectorAll("#deck-edit-fields select[data-field]")];

  // Every part except the ratchet must be chosen.
  if (selects.some(s => s.dataset.field !== "ratchet" && (s.value === "" || s.value == null))) {
    alert("Please choose every part.");
    return;
  }

  // Push the chosen parts into the hidden calculator form, and set the mode
  // index for any multi-mode part from the editor's chosen mode (clamped).
  selects.forEach(sel => {
    const field = sel.dataset.field;
    const target = form.querySelector(`[name="${field}"]`);
    if (target) target.value = sel.value;
    const arrKey = DECK_EDIT_FIELD_ARR[field];
    const part = (sel.value !== NO_RATCHET && sel.value !== "" && DATA[arrKey]) ? DATA[arrKey][sel.value] : null;
    if (part && Array.isArray(part.modes) && part.modes.length) {
      const m = deckEditPartModes[field];
      part._modeIndex = (typeof m === "number" && m >= 0) ? Math.min(m, part.modes.length - 1) : 0;
    }
  });

  // Recalculate through the calculator, snapshotting history + result so the
  // edit doesn't leak into either.
  const HKEY = "beyblade_history";
  const histBefore = localStorage.getItem(HKEY);
  const resultEl = document.getElementById("result");
  const resultWasHidden = resultEl ? resultEl.classList.contains("hidden") : true;

  let fresh = null;
  try {
    calcFn(form);
    fresh = (JSON.parse(localStorage.getItem(HKEY) || "[]"))[0] || null;
  } catch (e) {
    fresh = null;
  }

  localStorage.setItem(HKEY, histBefore || "[]");
  if (resultEl && resultWasHidden) resultEl.classList.add("hidden");

  if (!fresh || !fresh.data) {
    alert("Couldn't recalculate this combo.");
    return;
  }

  // Honour the deck's no-duplicate-parts rule against the other slots.
  const usedOther = new Set();
  deck.forEach((s, i) => {
    if (i === deckEditSlotIdx || !s || !s.data || !s.data.parts) return;
    Object.entries(s.data.parts).forEach(([k, n]) => {
      if (isCountedPart(k, n)) usedOther.add(n);
    });
  });
  const freshParts = fresh.data.parts || {};
  const clash = Object.entries(freshParts).find(([k, n]) => isCountedPart(k, n) && usedOther.has(n));
  if (clash) {
    alert(`Can't save — "${clash[1]}" is already used in another slot.`);
    return;
  }

  deck[deckEditSlotIdx] = {
    mode: fresh.mode,
    time: new Date().toISOString(),
    data: fresh.data
  };
  persistDeck(deck);
  renderDeck();
  closeDeckEdit();
}

(function initDeckName() {
  const input = document.getElementById("deck-name");
  if (!input) return;
  input.value = loadDeckName();
  input.addEventListener("input", () => saveDeckName(input.value));
})();

// =========================
// AUTO-BUILD DECK FROM ACHIEVEMENT
// =========================
// The "Auto" button opens a popup listing every Achievement; picking one
// fills the active deck with a 3-slot combo that satisfies that achievement's
// `creditOnWin` check (see js/achievements.js). Generators build slot data
// directly (no form round-trip) so the same parts the user copies into a
// tournament also pass the achievement predicate after deckSlotToBeyCheckShape.

const AUTOBUILD_NEEDLES = {
  dragon: ["dran", "drake", "dragoon", "wyvern", "bahamut", "ragna"],
  knight: ["knight"],
  wolf: ["wolf"],
  leon: ["leon"],
  jungle: ["rhino", "fox", "wolf", "viper", "tiger", "bear", "goat"],
  shark: ["shark"],
  wizard: ["wizard"],
  dinosaur: ["tyranno", "tricera", "ptera", "mammoth", "brachio"],
  clockMirage: ["clock mirage"],
  rush: ["rush"],
  bulletGriffon: ["bullet griffon"]
};

function autobuildNameMatches(name, needles) {
  if (typeof name !== "string" || !name) return false;
  const low = name.toLowerCase();
  return needles.some(n => {
    if (low.indexOf(n) === -1) return false;
    // "Dranzer" shares the "dran" prefix but isn't part of the Dragon family
    // for the achievement matchers — must stay out of the dragon pool.
    if (n === "dran" && low.indexOf("dranzer") !== -1) return false;
    return true;
  });
}

function autobuildFilterByName(arr, needles) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => autobuildNameMatches(p.name, needles));
}

function autobuildShuffled(arr) {
  const out = (arr || []).slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function autobuildAvailable(arr, used) {
  return (arr || []).filter(p => !used.has(p.name));
}

function autobuildMarkUsed(slot, used) {
  const parts = slot && slot.data && slot.data.parts;
  if (!parts) return;
  for (const [k, n] of Object.entries(parts)) {
    if (isCountedPart(k, n)) used.add(n);
  }
}

// Build a BX-mode slot data object from blade/ratchet/bit. `ratchet` may be
// null — the no-ratchet path used for Bullet Griffon.
function autobuildMakeBXSlot(blade, ratchet, bit) {
  const r = ratchet || { atk: 0, def: 0, sta: 0, weight: 0 };
  const totalAtk = (blade.atk || 0) + r.atk + (bit?.atk || 0);
  const totalDef = (blade.def || 0) + r.def + (bit?.def || 0);
  const totalSta = (blade.sta || 0) + r.sta + (bit?.sta || 0);
  const totalWeight = (blade.weight || 0) + r.weight + (bit?.weight || 0);
  const isBG = isExpandCxBlade(blade);
  const bHeight = ratchet ? ratchet.height : null;
  const comboName = (blade.codename || blade.name)
    + (ratchet ? ratchet.name : "")
    + (bit ? (bit.codename || bit.name) : "");
  return {
    mode: "BX",
    time: new Date().toISOString(),
    data: {
      comboName,
      top: { spinDirection: blade.spindirection || "R" },
      parts: {
        blade: blade.name,
        ratchet: ratchet ? ratchet.name : null,
        bit: bit ? bit.name : null
      },
      partModes: {},
      grandTotal: {
        ATK: totalAtk,
        DEF: totalDef,
        STA: totalSta,
        Weight: `${totalWeight.toFixed(1)} g`,
        ...(isBG ? {} : {
          Height: bHeight == null ? "TBA" : `${(Number(bHeight) / 10).toFixed(1)} mm`
        }),
        Dash: bit ? bit.dash : undefined,
        "Burst Res": bit ? bit.burstRes : undefined
      }
    }
  };
}

// Build a CX-mode slot data object.
function autobuildMakeCXSlot(lc, mb, ab, ratchet, bit) {
  const r = ratchet || { atk: 0, def: 0, sta: 0, weight: 0, height: 0 };
  const totalAtk = (mb.atk || 0) + (ab.atk || 0) + r.atk + (bit?.atk || 0);
  const totalDef = (mb.def || 0) + (ab.def || 0) + r.def + (bit?.def || 0);
  const totalSta = (mb.sta || 0) + (ab.sta || 0) + r.sta + (bit?.sta || 0);
  const totalWeight = (lc.weight || 0) + (mb.weight || 0) + (ab.weight || 0)
    + r.weight + (bit?.weight || 0);
  const totalHeight = (ab?.height || 0) + (r.height || 0);
  const comboName = (lc.codename || lc.name)
    + (mb.codename || mb.name)
    + (ab.codename || ab.name)
    + (ratchet ? ratchet.name : "")
    + (bit ? (bit.codename || bit.name) : "");
  return {
    mode: "CX",
    time: new Date().toISOString(),
    data: {
      comboName,
      top: { spinDirection: mb.spindirection || "R" },
      parts: {
        lockChip: lc.name,
        mainBlade: mb.name,
        assistBlade: ab.name,
        ratchet: ratchet ? ratchet.name : null,
        bit: bit ? bit.name : null
      },
      partModes: {},
      grandTotal: {
        ATK: totalAtk,
        DEF: totalDef,
        STA: totalSta,
        Weight: `${totalWeight.toFixed(1)} g`,
        Height: `${(totalHeight / 10).toFixed(1)} mm`,
        Dash: bit ? bit.dash : undefined,
        "Burst Res": bit ? bit.burstRes : undefined
      }
    }
  };
}

// Coarse type bucket (Attack / Defense / Stamina / Balance) for a BX combo.
function autobuildBaseTypeForBX(blade, ratchet, bit) {
  const atk = (blade.atk || 0) + (ratchet?.atk || 0) + (bit?.atk || 0);
  const def = (blade.def || 0) + (ratchet?.def || 0) + (bit?.def || 0);
  const sta = (blade.sta || 0) + (ratchet?.sta || 0) + (bit?.sta || 0);
  const t = getType(atk, def, sta, false);
  if (typeof t !== "string") return "";
  if (t.indexOf("Balance") !== -1) return "Balance";
  return t;
}

// Brute-force search for a (ratchet, bit) pair that gives `blade` the
// requested base type (Attack / Defense / Stamina / Balance), avoiding any
// part name in `used`. Pass `opts.noRatchet: true` for the Bullet Griffon
// path (no ratchet, normal bit — see the tool_bullet_griffon memory).
function autobuildPickRatchetBitForType(blade, targetType, used, opts) {
  opts = opts || {};
  const ratchetPool = opts.noRatchet
    ? [null]
    : autobuildShuffled(autobuildAvailable(DATA.ratchets, used));
  const bitPool = autobuildShuffled(
    autobuildAvailable(DATA.bits, used).filter(b => !b.isRatchetBit)
  );
  for (const r of ratchetPool) {
    for (const b of bitPool) {
      const t = autobuildBaseTypeForBX(blade, r, b);
      if (!targetType || t === targetType) return { ratchet: r, bit: b };
    }
  }
  return null;
}

// Build a BX slot for `blade`, recording used parts. Returns null when no
// ratchet/bit combination meets `targetType` against the remaining pool.
function autobuildBuildBXSlotFor(blade, used, targetType, opts) {
  const pick = autobuildPickRatchetBitForType(blade, targetType, used, opts);
  if (!pick) return null;
  const slot = autobuildMakeBXSlot(blade, pick.ratchet, pick.bit);
  autobuildMarkUsed(slot, used);
  return slot;
}

// Fill remaining slots with random non-conflicting BX combos. `excludeNames`
// is a list of substring needles to skip (e.g. ["bullet griffon"] so fillers
// don't grab the achievement's themed blade by accident).
function autobuildFillRemaining(slots, used, excludeNeedles) {
  const blades = autobuildShuffled(
    DATA.blades.filter(b =>
      !used.has(b.name)
      && !(excludeNeedles && autobuildNameMatches(b.name, excludeNeedles))
    )
  );
  for (const blade of blades) {
    if (slots.length === 3) return true;
    const s = autobuildBuildBXSlotFor(blade, used, null);
    if (s) slots.push(s);
  }
  return slots.length === 3;
}

// ----- Per-achievement generators (return { ok, slots } | { ok: false, reason }) -----

function autobuildDragonTamerDeck() {
  const used = new Set();
  const slots = [];
  for (const blade of autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.dragon))) {
    if (slots.length === 3) break;
    if (used.has(blade.name)) continue;
    const s = autobuildBuildBXSlotFor(blade, used, null);
    if (s) slots.push(s);
  }
  if (slots.length < 3) return { ok: false, reason: "Not enough dragon blades available." };
  return { ok: true, slots };
}

function autobuildDragonSlayerDeck() {
  const used = new Set();
  const slots = [];
  for (const blade of autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.knight))) {
    if (slots.length === 3) break;
    if (used.has(blade.name)) continue;
    const s = autobuildBuildBXSlotFor(blade, used, null);
    if (s) slots.push(s);
  }
  if (slots.length < 3) return { ok: false, reason: "Not enough Knight blades available." };
  return { ok: true, slots };
}

function autobuildLoneWolfDeck() {
  const used = new Set();
  const wolfBlades = autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.wolf));
  if (!wolfBlades.length) return { ok: false, reason: "No Wolf blade available." };
  // Aim for a Stamina wolf slot (Silver Wolf is sta-heavy); fall back to any.
  let wolfSlot = null, wolfType = null;
  for (const blade of wolfBlades) {
    for (const tType of ["Stamina", "Defense", "Attack", "Balance"]) {
      const s = autobuildBuildBXSlotFor(blade, used, tType);
      if (s) { wolfSlot = s; wolfType = tType; break; }
    }
    if (wolfSlot) break;
  }
  if (!wolfSlot) return { ok: false, reason: "Couldn't tune the Wolf slot." };
  // The other two slots must have a coarse type different from the wolf's.
  const otherTargets = autobuildShuffled(
    ["Attack", "Defense", "Stamina", "Balance"].filter(t => t !== wolfType)
  );
  const slots = [wolfSlot];
  const otherBladePool = autobuildShuffled(
    DATA.blades.filter(b => !autobuildNameMatches(b.name, AUTOBUILD_NEEDLES.wolf))
  );
  for (const blade of otherBladePool) {
    if (slots.length === 3) break;
    if (used.has(blade.name)) continue;
    let placed = null;
    for (const t of otherTargets) {
      placed = autobuildBuildBXSlotFor(blade, used, t);
      if (placed) break;
    }
    if (placed) slots.push(placed);
  }
  if (slots.length < 3) return { ok: false, reason: "Couldn't fill remaining slots." };
  return { ok: true, slots };
}

function autobuildRushHourDeck() {
  const used = new Set();
  const clockMirage = (DATA.blades || []).find(b => autobuildNameMatches(b.name, AUTOBUILD_NEEDLES.clockMirage));
  if (!clockMirage) return { ok: false, reason: "Clock Mirage blade not in data." };
  const rushBits = autobuildShuffled(
    DATA.bits.filter(b => !b.isRatchetBit && autobuildNameMatches(b.name, AUTOBUILD_NEEDLES.rush))
  );
  if (!rushBits.length) return { ok: false, reason: "No Rush bit in data." };
  const bit = rushBits[0];
  used.add(bit.name);
  // Clock Mirage convention: only pair with ratchets whose name ends in "5"
  // (e.g. 4-55, 3-85, M-85, 9-65, 7-55).
  const ratchet = autobuildShuffled(
    autobuildAvailable(DATA.ratchets, used).filter(r => /5$/.test(r.name))
  )[0];
  if (!ratchet) return { ok: false, reason: "No Clock Mirage-compatible ratchet available." };
  const rushSlot = autobuildMakeBXSlot(clockMirage, ratchet, bit);
  autobuildMarkUsed(rushSlot, used);
  const slots = [rushSlot];
  if (!autobuildFillRemaining(slots, used, AUTOBUILD_NEEDLES.clockMirage)) {
    return { ok: false, reason: "Couldn't fill remaining slots." };
  }
  return { ok: true, slots };
}

function autobuildKingOfJungleDeck() {
  const used = new Set();
  const leonBlades = autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.leon));
  if (!leonBlades.length) return { ok: false, reason: "No Leon blade available." };
  let leonSlot = null;
  for (const blade of leonBlades) {
    leonSlot = autobuildBuildBXSlotFor(blade, used, null);
    if (leonSlot) break;
  }
  if (!leonSlot) return { ok: false, reason: "Couldn't build Leon slot." };
  const slots = [leonSlot];
  // Two more slots — each carries a jungle-animal-named blade (not Leon).
  const jungleBlades = autobuildShuffled(
    DATA.blades.filter(b =>
      !autobuildNameMatches(b.name, AUTOBUILD_NEEDLES.leon)
      && autobuildNameMatches(b.name, AUTOBUILD_NEEDLES.jungle)
    )
  );
  for (const blade of jungleBlades) {
    if (slots.length === 3) break;
    if (used.has(blade.name)) continue;
    const s = autobuildBuildBXSlotFor(blade, used, null);
    if (s) slots.push(s);
  }
  if (slots.length < 3) return { ok: false, reason: "Not enough jungle animal blades." };
  return { ok: true, slots };
}

function autobuildSharknadoDeck() {
  const used = new Set();
  const sharkBlades = autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.shark));
  if (!sharkBlades.length) return { ok: false, reason: "No Shark blade available." };
  let sharkSlot = null;
  for (const blade of sharkBlades) {
    sharkSlot = autobuildBuildBXSlotFor(blade, used, "Balance");
    if (sharkSlot) break;
  }
  if (!sharkSlot) return { ok: false, reason: "Couldn't find a Balance-type Shark slot." };
  const slots = [sharkSlot];
  if (!autobuildFillRemaining(slots, used, AUTOBUILD_NEEDLES.shark)) {
    return { ok: false, reason: "Couldn't fill remaining slots." };
  }
  return { ok: true, slots };
}

function autobuildSorcererSupremeDeck() {
  const used = new Set();
  const wizardBlades = autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.wizard));
  const slots = [];
  // First two slots: BX with Wizard-named blades.
  for (const blade of wizardBlades) {
    if (slots.length === 2) break;
    if (used.has(blade.name)) continue;
    const s = autobuildBuildBXSlotFor(blade, used, null);
    if (s) slots.push(s);
  }
  if (slots.length < 2) return { ok: false, reason: "Not enough Wizard blades available." };
  // Third slot: CX combo using the Wizard lock chip so the slot still has
  // a Wizard-named part (any main blade / assist blade pair will do).
  const wizardLC = (DATA.lockChips || []).find(lc => autobuildNameMatches(lc.name, AUTOBUILD_NEEDLES.wizard));
  if (!wizardLC) return { ok: false, reason: "No Wizard lock chip available." };
  const mb = autobuildShuffled(autobuildAvailable(DATA.mainBlades, used))[0];
  const ab = autobuildShuffled(autobuildAvailable(DATA.assistBlades, used))[0];
  const r = autobuildShuffled(autobuildAvailable(DATA.ratchets, used))[0];
  const b = autobuildShuffled(
    autobuildAvailable(DATA.bits, used).filter(x => !x.isRatchetBit)
  )[0];
  if (!mb || !ab || !r || !b) return { ok: false, reason: "Couldn't build Wizard CX slot." };
  const cxSlot = autobuildMakeCXSlot(wizardLC, mb, ab, r, b);
  autobuildMarkUsed(cxSlot, used);
  slots.push(cxSlot);
  return { ok: true, slots };
}

function autobuildPaleonerdDeck() {
  const used = new Set();
  const slots = [];
  for (const blade of autobuildShuffled(autobuildFilterByName(DATA.blades, AUTOBUILD_NEEDLES.dinosaur))) {
    if (slots.length === 3) break;
    if (used.has(blade.name)) continue;
    const s = autobuildBuildBXSlotFor(blade, used, null);
    if (s) slots.push(s);
  }
  if (slots.length < 3) return { ok: false, reason: "Not enough prehistoric blades." };
  return { ok: true, slots };
}

function autobuildKingOfAllTypesDeck() {
  const used = new Set();
  const bg = (DATA.blades || []).find(b => autobuildNameMatches(b.name, AUTOBUILD_NEEDLES.bulletGriffon));
  if (!bg) return { ok: false, reason: "Bullet Griffon not in data." };
  // Bullet Griffon: no ratchet, normal bit, push into a non-Balance type.
  let bgSlot = null;
  for (const tType of autobuildShuffled(["Attack", "Defense", "Stamina"])) {
    bgSlot = autobuildBuildBXSlotFor(bg, used, tType, { noRatchet: true });
    if (bgSlot) break;
  }
  if (!bgSlot) return { ok: false, reason: "Couldn't tune Bullet Griffon away from Balance." };
  const slots = [bgSlot];
  if (!autobuildFillRemaining(slots, used, AUTOBUILD_NEEDLES.bulletGriffon)) {
    return { ok: false, reason: "Couldn't fill remaining slots." };
  }
  return { ok: true, slots };
}

const AUTOBUILD_GENERATORS = {
  dragonTamer: autobuildDragonTamerDeck,
  dragonSlayer: autobuildDragonSlayerDeck,
  lonewolf: autobuildLoneWolfDeck,
  rushHour: autobuildRushHourDeck,
  kingOfJungle: autobuildKingOfJungleDeck,
  sharknado: autobuildSharknadoDeck,
  sorcererSupreme: autobuildSorcererSupremeDeck,
  paleonerd: autobuildPaleonerdDeck,
  kingOfAllTypes: autobuildKingOfAllTypesDeck
};

function openAutobuildPopup() {
  const list = document.getElementById("deck-autobuild-list");
  const popup = document.getElementById("deck-autobuild-popup");
  if (!list || !popup) return;
  const defs = (typeof window !== "undefined" && Array.isArray(window.ACHIEVEMENTS))
    ? window.ACHIEVEMENTS : [];
  list.innerHTML = defs.map(d => `
    <button type="button" class="deck-autobuild-item" data-ach-id="${escapeHtml(d.id)}">
      <span class="deck-autobuild-item-title">${escapeHtml(d.title)}</span>
      <span class="deck-autobuild-item-desc">${escapeHtml(d.shortDescription || "")}</span>
    </button>
  `).join("");
  list.querySelectorAll(".deck-autobuild-item").forEach(btn => {
    btn.addEventListener("click", () => handleAutobuildPick(btn.dataset.achId));
  });
  popup.classList.remove("hidden");
}

function closeAutobuildPopup() {
  document.getElementById("deck-autobuild-popup")?.classList.add("hidden");
}

function handleAutobuildPick(achId) {
  const gen = AUTOBUILD_GENERATORS[achId];
  const def = (window.ACHIEVEMENTS || []).find(d => d.id === achId);
  if (!gen) {
    alert("No generator for this achievement.");
    return;
  }
  const current = loadDeck();
  if (current.some(s => s != null) &&
      !confirm("Replace the current deck with an auto-built one?")) return;
  const result = gen();
  if (!result.ok) {
    alert(result.reason || "Couldn't auto-build this deck.");
    return;
  }
  const slots = result.slots.slice(0, DECK_SIZE);
  while (slots.length < DECK_SIZE) slots.push(null);
  persistDeck(slots);
  if (def && def.title) saveDeckName(def.title);
  const nameInput = document.getElementById("deck-name");
  if (nameInput) nameInput.value = loadDeckName();
  renderDeck();
  closeAutobuildPopup();
}

document.getElementById("deck-autobuild")?.addEventListener("click", openAutobuildPopup);
document.getElementById("deck-autobuild-cancel")?.addEventListener("click", closeAutobuildPopup);
document.getElementById("deck-autobuild-popup")?.addEventListener("click", e => {
  if (e.target === e.currentTarget) closeAutobuildPopup();
});
