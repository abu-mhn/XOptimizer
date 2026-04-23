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
    let partsHtml = "";
    for (const [key, name] of Object.entries(parts)) {
      if (!name || !PART_FOLDER[key]) continue;
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
        <button type="button" class="btn-deck-remove" data-slot="${idx}" aria-label="Remove slot ${idx + 1}" title="Remove">&times;</button>
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
}

function downloadDeckPNG() {
  const deckList = document.getElementById("deck-list");
  if (!deckList) return;
  const deck = loadDeck();
  if (deck.every(s => s == null)) {
    alert("Deck is empty.");
    return;
  }

  const cls = document.body.classList;
  const isLightLike = cls.contains("light-mode") || cls.contains("tropical-mode");
  const isTropical = cls.contains("tropical-mode");
  const footerColor = isTropical ? "#8a6d3b" : isLightLike ? "#656d76" : "#8b949e";
  const footerBorder = isTropical ? "#ffd8a8" : isLightLike ? "#d1d9e0" : "#21262d";
  const strongColor = isTropical ? "#2d3a3a" : isLightLike ? "#1f2328" : "#c9d1d9";
  const pageBg = isTropical ? "#fff6e6" : cls.contains("light-mode") ? "#f6f8fa" : cls.contains("space-mode") ? "#0b0d1a" : cls.contains("stormy-mode") ? "#1e2330" : cls.contains("mono-mode") ? "#000000" : "#0d1117";
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

  html2canvas(wrap, { backgroundColor: pageBg, scale: 2, useCORS: true, width: 800 }).then(canvas => {
    document.body.removeChild(wrap);

    const side = Math.max(canvas.width, canvas.height);
    const square = document.createElement("canvas");
    square.width = side;
    square.height = side;
    const ctx = square.getContext("2d");
    ctx.fillStyle = pageBg;
    ctx.fillRect(0, 0, side, side);
    ctx.drawImage(canvas, Math.floor((side - canvas.width) / 2), Math.floor((side - canvas.height) / 2));

    const link = document.createElement("a");
    const safeName = deckName.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    link.download = (safeName || "deck") + ".png";
    link.href = square.toDataURL("image/png");
    link.click();
  }).catch(() => {
    if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
    alert("Failed to generate deck image.");
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
document.getElementById("deck-reset")?.addEventListener("click", resetDeck);
document.getElementById("deck-shuffle")?.addEventListener("click", shuffleDeck);

(function initDeckName() {
  const input = document.getElementById("deck-name");
  if (!input) return;
  input.value = loadDeckName();
  input.addEventListener("input", () => saveDeckName(input.value));
})();
