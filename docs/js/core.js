// docs/js/core.js - gesture blockers, utilities, dropdowns, tab handlers, shared helpers
// --- Block pinch/gesture zoom (iOS Safari ignores user-scalable=no) ---
document.addEventListener("gesturestart", e => e.preventDefault());
document.addEventListener("gesturechange", e => e.preventDefault());
document.addEventListener("gestureend", e => e.preventDefault());
document.addEventListener("touchmove", e => {
  if (e.touches.length > 1) e.preventDefault();
}, { passive: false });
let _lastTouchEnd = 0;
document.addEventListener("touchend", e => {
  const now = Date.now();
  if (now - _lastTouchEnd <= 300) e.preventDefault();
  _lastTouchEnd = now;
}, { passive: false });

// --- Part image path helper ---
function partImgNormalize(str) {
  return (str || "").trim().replace(/\s+/g, "").replace(/-/g, "");
}

function partImgPath(folder, name, modeIndex) {
  const base = partImgNormalize(name);
  const suffix = modeIndex != null ? `${base}${modeIndex}.webp` : `${base}.webp`;
  return `assets/${folder}/${suffix}`;
}

// --- Utility ---
function getType(totalAtk, totalDef, totalSta, isRatchetBit) {
  if (isRatchetBit) {
    if (totalAtk >= 100 && totalDef >= 100 && totalSta >= 100) return "Ultimate Balance";
    if ((totalAtk >= 100 && totalDef >= 100) || (totalAtk >= 100 && totalSta >= 100) || (totalDef >= 100 && totalSta >= 100)) return "Perfect Balance";
    if (totalAtk >= 100) return "Attack";
    if (totalDef >= 100) return "Defense";
    if (totalSta >= 100) return "Stamina";
    return "Balance";
  }
  if (totalAtk >= 100 && totalDef >= 100 && totalSta >= 100) return "Balance III";
  if ((totalAtk >= 100 && totalDef >= 100) || (totalAtk >= 100 && totalSta >= 100) || (totalDef >= 100 && totalSta >= 100)) return "Balance II";
  if (totalAtk >= 100) return "Attack";
  if (totalDef >= 100) return "Defense";
  if (totalSta >= 100) return "Stamina";
  return "Balance";
}

function tbaOrVal(val, hasZero) { return hasZero ? "TBA" : val; }
function weightStr(w, hasZero) { return hasZero ? "TBA" : w.toFixed(2) + " g"; }

function typeLogo(type) {
  if (!type || type === "TBA") return "";

  let file;

  if (type === "Attack") file = "Attack_logo_Beyblade_X.webp";
  else if (type === "Defense") file = "Defense_logo_Beyblade_X.webp";
  else if (type === "Stamina") file = "Stamina_logo_Beyblade_X.webp";
  else file = "Balance_logo_Beyblade_X.webp";

  return `<img src="assets/type/${file}" alt="${type}" title="${type}" class="type-logo">`;
}

function spinLogo(dir) {
  const isLeft = dir === "L" || dir === "Left";
  const file = isLeft ? "Left-Spin_logo_Beyblade_X.webp" : "Right-Spin_logo_Beyblade_X.webp";
  const label = isLeft ? "Left Spin" : "Right Spin";
  return `<img src="assets/spin/${file}" alt="${label}" title="${label}" class="spin-logo">`;
}

// Sentinel selected in the Ratchet dropdown to signal "use a ratchet-bit bit".
const NO_RATCHET = "__NO_RATCHET__";

function applyBitFilter(form) {
  const ratchetSel = form.querySelector('[name="ratchet"]');
  const bitWrapper = form.querySelector('[name="bit"]')?.nextElementSibling;
  if (!ratchetSel || !bitWrapper) return;
  if (ratchetSel.value === NO_RATCHET) {
    bitWrapper._setFilter(b => !!b.isRatchetBit);
  } else {
    bitWrapper._setFilter(b => !b.isRatchetBit);
  }
}

// --- Merge ratchetBits into a combined bit pool ---
// allBits exposes a unified dropdown list; isRatchetBit items already include
// ratchet-portion stats and their own height, so they skip the ratchet slot.
function mergeBits() {
  if (DATA._bitsMerged) return;
  const rbTagged = (DATA.ratchetBits || []).map(rb => ({
    ...rb,
    isRatchetBit: true,
    _folder: "ratchetBits"
  }));
  (DATA.bits || []).forEach(b => { b._folder = "bits"; });
  DATA.bits = [...(DATA.bits || []), ...rbTagged];
  DATA._bitsMerged = true;
}
mergeBits();

// --- Sort all DATA arrays alphabetically by name ---
function sortData() {
  Object.keys(DATA).forEach(key => {
    if (key === "_bitsMerged") return;
    DATA[key].sort((a, b) => a.name.localeCompare(b.name));
  });
}

// --- Auto-advance flow: map which dropdown to focus after the current one ---
// "__BOTTOM__" = scroll to Bottom fieldset and focus the first enabled field.
const NEXT_DROPDOWN = {
  "form-standard": {
    blade: "__BOTTOM__",
    ratchet: "bit",
    bit: null
  },
  "form-cx": {
    lockChip: "mainBlade",
    mainBlade: "assistBlade",
    assistBlade: "__BOTTOM__",
    ratchet: "bit",
    bit: null
  },
  "form-cxExpand": {
    lockChip: "metalBlade",
    metalBlade: "overBlade",
    overBlade: "assistBlade",
    assistBlade: "__BOTTOM__",
    ratchet: "bit",
    bit: null
  }
};

function advanceToNext(sel) {
  const form = sel.closest("form");
  if (!form) return;

  // Skip auto-advance / popup once a result is displayed (i.e. after calculate or random).
  // User is tweaking existing selections, not walking the initial flow.
  const result = document.getElementById("result");
  if (result && !result.classList.contains("hidden")) return;

  const map = NEXT_DROPDOWN[form.id];
  if (!map) return;
  const next = map[sel.getAttribute("name")];
  if (next == null) return;

  if (next === "__BOTTOM__") {
    // Auto-focus the first enabled bottom field: ratchet, then bit, then ratchet-bit.
    requestAnimationFrame(() => {
      const candidates = ["ratchet", "bit"];
      for (const name of candidates) {
        const wrapper = form.querySelector(`[name="${name}"]`)?.nextElementSibling;
        const input = wrapper?.querySelector("input");
        if (input && !input.disabled) {
          wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
          input.focus();
          return;
        }
      }
    });
    return;
  }

  const nextSel = form.querySelector(`[name="${next}"]`);
  const wrapper = nextSel?.nextElementSibling;
  const nextInput = wrapper?.querySelector("input");
  if (!nextInput || nextInput.disabled) return;

  requestAnimationFrame(() => {
    wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
    nextInput.focus();
  });
}

// --- Searchable dropdown ---
// `prependChoices`: optional [{ value: string, label: string }] rendered before
// the real items (e.g. a "No Ratchet" synthetic choice with a sentinel value).
function makeSearchable(sel, items, labelFn, prependChoices = []) {
  sel.innerHTML = '<option value="">-- Select --</option>';
  prependChoices.forEach(ch => {
    const opt = document.createElement("option");
    opt.value = ch.value;
    opt.textContent = ch.label;
    sel.appendChild(opt);
  });
  items.forEach((item, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = labelFn(item);
    sel.appendChild(opt);
  });

  const wrapper = document.createElement("div");
  wrapper.className = "search-dropdown";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "-- Select --";
  input.autocomplete = "off";

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "dd-clear hidden";
  clearBtn.textContent = "\u00d7";
  clearBtn.setAttribute("aria-label", "Clear selection");

  const list = document.createElement("div");
  list.className = "dd-list";

  wrapper.appendChild(input);
  wrapper.appendChild(clearBtn);
  wrapper.appendChild(list);
  sel.parentNode.insertBefore(wrapper, sel.nextSibling);

  let activeIdx = -1;

  function buildList(filter) {
    list.innerHTML = "";
    activeIdx = -1;
    const query = filter.toLowerCase();
    let count = 0;
    prependChoices.forEach(ch => {
      if (query && !ch.label.toLowerCase().includes(query)) return;
      const div = document.createElement("div");
      div.className = "dd-item dd-item-synthetic";
      div.textContent = ch.label;
      div.addEventListener("mousedown", e => {
        e.preventDefault();
        select(ch.value, ch.label);
      });
      list.appendChild(div);
      count++;
    });
    items.forEach((item, i) => {
      const label = labelFn(item);
      if (wrapper._filterFn && !wrapper._filterFn(item)) return;
      if (query && !label.toLowerCase().includes(query)) return;
      const div = document.createElement("div");
      div.className = "dd-item";
      div.textContent = label;
      div.addEventListener("mousedown", e => {
        e.preventDefault();
        select(i, label);
      });
      list.appendChild(div);
      count++;
    });
    if (count === 0) {
      list.innerHTML = '<div class="dd-empty">No results</div>';
    }
  }

  function select(idx, label) {
    sel.value = idx;
    sel.dispatchEvent(new Event("change"));
    input.value = label;
    clearBtn.classList.remove("hidden");
    close();
    advanceToNext(sel);
  }

  function open() {
    buildList(input.value);
    wrapper.classList.add("open");
  }

  function close() {
    wrapper.classList.remove("open");
    activeIdx = -1;
  }

  input.addEventListener("focus", open);
  input.addEventListener("input", () => {
    buildList(input.value);
    wrapper.classList.add("open");
  });
  input.addEventListener("blur", () => {
    close();
    if (sel.value === "") input.value = "";
  });
  input.addEventListener("keydown", e => {
    const items = list.querySelectorAll(".dd-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
      items[activeIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
      items[activeIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && items[activeIdx]) items[activeIdx].dispatchEvent(new MouseEvent("mousedown"));
    } else if (e.key === "Escape") {
      close();
      input.blur();
    }
  });

  // Clear button click
  clearBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    sel.value = "";
    input.value = "";
    clearBtn.classList.add("hidden");
    sel.dispatchEvent(new Event("change"));
  });

  // Allow clearing
  wrapper._clear = () => { sel.value = ""; input.value = ""; clearBtn.classList.add("hidden"); wrapper._filterFn = null; };

  // Allow programmatic selection (numeric idx into items, or a prepend-choice value string)
  wrapper._select = (idx) => {
    sel.value = idx;
    if (typeof idx === "number") {
      input.value = labelFn(items[idx]);
    } else {
      const ch = prependChoices.find(c => c.value === idx);
      input.value = ch ? ch.label : "";
    }
    clearBtn.classList.remove("hidden");
    sel.dispatchEvent(new Event("change"));
  };

  // Allow external filtering
  wrapper._filterFn = null;
  wrapper._setFilter = (fn) => {
    wrapper._filterFn = fn;
    const curIdx = sel.value;
    const numIdx = Number(curIdx);
    const curItem = (curIdx !== "" && Number.isInteger(numIdx)) ? items[numIdx] : null;
    const keep = !!curItem && (!fn || fn(curItem));
    if (!keep) {
      sel.value = "";
      input.value = "";
      clearBtn.classList.add("hidden");
      sel.dispatchEvent(new Event("change"));
    }
  };
}

function initDropdowns() {
  const noRatchetChoice = [{ value: NO_RATCHET, label: "No Ratchet" }];

  // Standard
  const stdForm = document.getElementById("form-standard");
  makeSearchable(stdForm.querySelector('[name="blade"]'), DATA.blades, b => b.name);
  makeSearchable(stdForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name, noRatchetChoice);
  makeSearchable(stdForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);

  // CX
  const cxForm = document.getElementById("form-cx");
  makeSearchable(cxForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
  makeSearchable(cxForm.querySelector('[name="mainBlade"]'), DATA.mainBlades, mb => mb.name);
  makeSearchable(cxForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
  makeSearchable(cxForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name, noRatchetChoice);
  makeSearchable(cxForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);

  // CX Expand
  const cxeForm = document.getElementById("form-cxExpand");
  makeSearchable(cxeForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
  makeSearchable(cxeForm.querySelector('[name="metalBlade"]'), DATA.metalBlades, mb => mb.name);
  makeSearchable(cxeForm.querySelector('[name="overBlade"]'), DATA.overBlades, ob => ob.name);
  makeSearchable(cxeForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
  makeSearchable(cxeForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name, noRatchetChoice);
  makeSearchable(cxeForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
}

// --- Helper: switch to a calculator sub-mode ---
const subTabs = document.getElementById("sub-tabs");
const calcModes = ["standard", "cx", "cxExpand"];

function switchToCalcMode(mode) {
  // ================= SWITCH FORM =================
  document.querySelectorAll(".calc-form").forEach(f => f.classList.add("hidden"));

  const form = document.getElementById("form-" + mode);

  if (form) {
    form.classList.remove("hidden");

    // ================= RESET FORM =================
    form.querySelectorAll("select, input").forEach(el => {
      if (el.tagName === "SELECT") {
        el.selectedIndex = 0;
      } else {
        el.value = "";
      }
    });

    // ================= dropdown clear =================
    form.querySelectorAll(".search-dropdown").forEach(w => {
      if (w._clear) w._clear();
    });

    // ================= re-enable inputs =================
    const rInput = form.querySelector('[name="ratchet"]')?.nextElementSibling?.querySelector("input");
    if (rInput) {
      rInput.disabled = false;
      rInput.placeholder = "-- Select --";
    }

    const bInput = form.querySelector('[name="bit"]')?.nextElementSibling?.querySelector("input");
    if (bInput) {
      bInput.disabled = false;
      bInput.placeholder = "-- Select --";
    }

    // Restore the default "regular bits only" filter on the bit dropdown.
    applyBitFilter(form);

    // ================= hide mode buttons =================
    form.querySelectorAll(".btn-mode").forEach(b => {
      b.classList.add("hidden");
    });
  }

  // ================= HIDE RESULT =================
  document.getElementById("result")?.classList.add("hidden");

  // ================= FIX CALCULATE BUTTON =================
  document.querySelectorAll(".calc-btn").forEach(btn => {
    btn.classList.add("hidden");
    btn.style.display = "none";
  });

  const activeBtn = document.querySelector(`.calc-btn[data-mode="${mode}"]`);
  if (activeBtn) {
    activeBtn.classList.remove("hidden");
    activeBtn.style.display = "inline-block";
  }

  // Re-check calc button state for the active form
  const activeForm = document.querySelector(`#form-${mode}`);
  if (activeForm && window._updateCalcBtn) window._updateCalcBtn(activeForm);
}

// --- Sub-tabs (standard / cx / cxExpand) ---
document.querySelectorAll(".sub-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".sub-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    switchToCalcMode(tab.dataset.mode);
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
});

// --- Mode tabs ---
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {

    // ================= ACTIVE TAB =================
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");

    const mode = tab.dataset.mode;

    if (mode === "calculator") {
      // Show sub-tabs and activate the current sub-tab's form
      subTabs.classList.remove("hidden");
      const activeSubTab = subTabs.querySelector(".sub-tab.active");
      const subMode = activeSubTab ? activeSubTab.dataset.mode : "standard";
      switchToCalcMode(subMode);
    } else {
      // Hide sub-tabs for non-calculator tabs
      subTabs.classList.add("hidden");

      // ================= SWITCH FORM =================
      document.querySelectorAll(".calc-form").forEach(f => f.classList.add("hidden"));

      const form = document.getElementById("form-" + mode);

      if (form) {
        form.classList.remove("hidden");

        // ================= RESET FORM =================
        form.querySelectorAll("select, input").forEach(el => {
          if (el.tagName === "SELECT") {
            el.selectedIndex = 0;
          } else {
            el.value = "";
          }
        });

        // ================= dropdown clear =================
        form.querySelectorAll(".search-dropdown").forEach(w => {
          if (w._clear) w._clear();
        });
      }

      // ================= RESET SEARCH =================
      const searchInput = document.getElementById("library-search");
      const searchResults = document.getElementById("library-results");

      if (searchInput) searchInput.value = "";
      if (searchResults) searchResults.innerHTML = "";

      const sortBar = document.getElementById("library-sort");
      if (sortBar) sortBar.classList.add("hidden");

      // ================= HISTORY =================
      if (mode === "history") {
        const activeSub = document.querySelector(".history-sub-tab.active");
        const view = activeSub ? activeSub.dataset.historyView : "combos";
        if (view === "tournaments") renderTournamentHistory();
        else renderHistory();
      }

      // ================= DECK =================
      if (mode === "deck") {
        renderDeck();
      }

      // ================= SWISS =================
      if (mode === "swiss") {
        renderSwiss();
        const activeTournamentSub = document.querySelector(".tournament-sub-tab.active");
        if (activeTournamentSub?.dataset.tournamentView === "ranking") {
          renderTournamentRanking();
        }
      }

      // ================= HIDE RESULT =================
      document.getElementById("result")?.classList.add("hidden");
    }

    // 🔽 AUTO SCROLL TO TOP ON TAB SWITCH
    requestAnimationFrame(() => {
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  });
});

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function resolveSpinDirection(data) {
  const top = data?.top || {};
  const direct = top.spinDirection || top["Spin Direction"];
  if (direct) return direct;
  const parts = data?.parts || {};
  const findIn = (arr, name) => arr?.find(p => p.name === name);
  const src =
    findIn(DATA.blades, parts.blade) ||
    findIn(DATA.mainBlades, parts.mainBlade) ||
    findIn(DATA.metalBlades, parts.metalBlade);
  return src?.spindirection || "R";
}
