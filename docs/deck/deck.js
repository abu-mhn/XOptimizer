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

function renderDeck() {
  renderDeckSelector();
  const container = document.getElementById("deck-list");
  if (!container) return;
  const nameInput = document.getElementById("deck-name");
  if (nameInput && nameInput.value !== loadDeckName()) nameInput.value = loadDeckName();
  const deck = loadDeck();
  container.innerHTML = "";

  const PART_FOLDER = {
    blade: "blades", lockChip: "lockChips",
    mainBlade: "mainBlades", assistBlade: "assistBlades",
    metalBlade: "metalBlades", overBlade: "overBlades",
    ratchet: "ratchets", bit: "bits", ratchetBit: "ratchetBits"
  };
  // Fixed top -> bottom display order, regardless of how `parts` was keyed.
  const PART_ORDER = [
    "blade", "lockChip", "mainBlade", "metalBlade", "overBlade",
    "assistBlade", "ratchet", "ratchetBit", "bit"
  ];

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
      const folder = PART_FOLDER[key];
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
      const src = partImgPath(PART_FOLDER[key], name, modeIdx);
      partsHtml += `<div class="result-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${name}" class="result-part-img"
               onerror="this.closest('.result-part').style.display='none'">
        </div>
        <span class="result-part-name">${name}</span>
      </div>`;
    }

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
  clone.querySelectorAll(".btn-deck-remove").forEach(b => b.remove());
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

  awaitImagesReady(wrap).then(() => html2canvas(wrap, { backgroundColor: pageBg, scale: 2, useCORS: true, width: 800 })).then(canvas => {
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
  }).catch(() => {
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
        <button type="button" class="btn popup-ok" id="deck-edit-save" aria-label="Save" title="Save">&#x2713;</button>
        <button type="button" class="btn popup-cancel" id="deck-edit-cancel" aria-label="Cancel" title="Cancel">&#x2715;</button>
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
    `<label class="deck-edit-field">
      <span class="deck-edit-field-label">${label}</span>
      <select data-field="${key}"></select>
    </label>`
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
    sel.addEventListener("change", () => { deckEditValues[key] = sel.value; });
  });
}

function openDeckEdit(slotIdx) {
  const deck = loadDeck();
  const slot = deck[slotIdx];
  if (!slot) return;

  buildDeckEditPopup();
  deckEditSlotIdx = slotIdx;
  deckEditMode = DECK_EDIT_FIELDS[slot.mode] ? slot.mode : "BX";

  // Start with every dropdown empty — the combo is rebuilt from scratch.
  deckEditValues = {};

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

  const slotPartModes = (slot.data && slot.data.partModes) || {};
  const selects = [...document.querySelectorAll("#deck-edit-fields select[data-field]")];

  // Every part except the ratchet must be chosen.
  if (selects.some(s => s.dataset.field !== "ratchet" && (s.value === "" || s.value == null))) {
    alert("Please choose every part.");
    return;
  }

  // Push the chosen parts into the hidden calculator form, and set the mode
  // index for any multi-mode part (kept from the slot, clamped to range).
  selects.forEach(sel => {
    const field = sel.dataset.field;
    const target = form.querySelector(`[name="${field}"]`);
    if (target) target.value = sel.value;
    const arrKey = DECK_EDIT_FIELD_ARR[field];
    const part = (sel.value !== NO_RATCHET && sel.value !== "" && DATA[arrKey]) ? DATA[arrKey][sel.value] : null;
    if (part && Array.isArray(part.modes) && part.modes.length) {
      const m = slotPartModes[field];
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
