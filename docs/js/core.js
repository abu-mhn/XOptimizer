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

// Wait for every <img> inside `el` to be loaded AND fully decoded. iOS Safari
// is much stricter than other browsers — it considers an image "loaded"
// before it has decoded the bitmap into canvas-readable memory, so html2canvas
// captures it as blank. Call this before any html2canvas() to avoid that.
function awaitImagesReady(el) {
  const imgs = [...el.querySelectorAll("img")];
  return Promise.all(imgs.map(img => {
    const decode = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve());
    if (img.complete && img.naturalWidth > 0) return decode();
    return new Promise(resolve => {
      const done = () => decode().then(resolve);
      img.addEventListener("load", done, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  }));
}

// iOS Safari + html2canvas often draws WebP-source <img> elements as blanks
// (especially when they're positioned off-screen), even after decode(). The
// reliable workaround: re-encode every image as a same-origin PNG data URL
// before the capture, then restore the originals afterwards. Returns the
// originals so the caller can call restoreImageSources() when done.
function inlineImagesAsDataUrls(el) {
  const imgs = [...el.querySelectorAll("img")];
  const originals = imgs.map(img => img.src);
  return Promise.all(imgs.map(img => convertOneImageToPngDataUrl(img))).then(() => originals);
}

function convertOneImageToPngDataUrl(img) {
  const src = img.src;
  if (!src || src.startsWith("data:")) return Promise.resolve();
  return fetch(src, { credentials: "omit" })
    .then(r => r.ok ? r.blob() : null)
    .then(blob => {
      if (!blob) return;
      const objUrl = URL.createObjectURL(blob);
      const tmp = new Image();
      return new Promise(resolve => {
        tmp.onerror = () => { URL.revokeObjectURL(objUrl); resolve(); };
        tmp.onload = () => {
          const finish = () => {
            try {
              const c = document.createElement("canvas");
              c.width = tmp.naturalWidth || tmp.width;
              c.height = tmp.naturalHeight || tmp.height;
              c.getContext("2d").drawImage(tmp, 0, 0);
              img.src = c.toDataURL("image/png");
              const after = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
              after.then(() => { URL.revokeObjectURL(objUrl); resolve(); });
            } catch (e) {
              URL.revokeObjectURL(objUrl);
              resolve();
            }
          };
          if (tmp.decode) tmp.decode().then(finish, finish);
          else finish();
        };
        tmp.src = objUrl;
      });
    })
    .catch(() => {});
}

function restoreImageSources(el, originals) {
  if (!originals) return;
  const imgs = [...el.querySelectorAll("img")];
  imgs.forEach((img, i) => { if (originals[i] != null) img.src = originals[i]; });
}

// --- Title case ("HELLS" -> "Hells", "GEAR BALL" -> "Gear Ball") ---
function titleCaseName(str) {
  return (str || "").toLowerCase().replace(/(^|\s)\w/g, c => c.toUpperCase());
}

// Resolve a part's (mode-aware) codename from DATA.
function partRecordCodename(folder, name, modeIndex) {
  const rec = (typeof DATA !== "undefined" && DATA[folder] || []).find(p => p.name === name) || null;
  if (!rec) return name || "";
  if (modeIndex != null && Array.isArray(rec.modes) && rec.modes[modeIndex]) {
    return rec.modes[modeIndex].codename || rec.codename || name;
  }
  return rec.codename || name;
}

// --- Combined CX / CX Expand blade tile -------------------------------
// CX and CX Expand combos assemble several parts into one blade, so the
// lock chip + blade(s) + assist blade are shown as a single stacked
// thumbnail. Shared by the calculator, history, deck and dashboard.
// `parts` is a { key: name } map; `resolvePart(key, name)` must return
// { src, codename }. Returns null when `parts` isn't a CX/CX Expand combo,
// otherwise { html, usedKeys } — usedKeys are the part keys it consumed.
function combinedBladeTileHTML(parts, resolvePart, extraImgClass) {
  if (!parts) return null;
  const lc = parts.lockChip;
  const ab = parts.assistBlade;
  const hasMain = !!parts.mainBlade;
  const hasMetal = !!parts.metalBlade;
  if (!lc || !ab || (!hasMain && !hasMetal)) return null;

  const extra = extraImgClass ? " " + extraImgClass : "";
  const lcP = resolvePart("lockChip", lc);
  const abP = resolvePart("assistBlade", ab);
  const usedKeys = new Set(["lockChip", "assistBlade"]);

  let layers, label;
  if (hasMetal && parts.overBlade) {
    // CX Expand: lock chip + over blade + metal blade + assist blade.
    usedKeys.add("metalBlade");
    usedKeys.add("overBlade");
    const mbP = resolvePart("metalBlade", parts.metalBlade);
    const obP = resolvePart("overBlade", parts.overBlade);
    layers = [
      { src: abP.src, cls: "result-layer-x4-assist", name: ab },
      { src: mbP.src, cls: "result-layer-x4-metal", name: parts.metalBlade },
      { src: obP.src, cls: "result-layer-x4-over", name: parts.overBlade },
      { src: lcP.src, cls: "result-layer-x4-lock", name: lc },
    ];
    label = `${titleCaseName(lcP.codename)} ${titleCaseName(mbP.codename)} ${obP.codename}${abP.codename}`;
  } else {
    // CX (or CX Expand with no over blade): lock chip + blade + assist blade.
    const bladeKey = hasMetal ? "metalBlade" : "mainBlade";
    usedKeys.add(bladeKey);
    const mbP = resolvePart(bladeKey, parts[bladeKey]);
    layers = [
      { src: abP.src, cls: "result-layer-assist", name: ab },
      { src: mbP.src, cls: "result-layer-main", name: parts[bladeKey] },
      { src: lcP.src, cls: "result-layer-lock", name: lc },
    ];
    label = `${titleCaseName(lcP.codename)} ${titleCaseName(mbP.codename)} ${abP.codename}`;
  }

  const wideCls = layers.length >= 4 ? " result-part-img-box-x4" : "";
  const layersHtml = layers.map(L =>
    `<img src="${L.src}" alt="${L.name}" data-part-name="${L.name}"`
    + ` class="result-part-img result-part-layer ${L.cls}${extra}"`
    + ` onerror="this.style.display='none'">`
  ).join("");

  return {
    usedKeys,
    html: `<div class="result-part result-part-combined">`
      + `<div class="result-part-img-box result-part-img-box-combined${wideCls}">${layersHtml}</div>`
      + `<span class="result-part-name">${label}</span>`
      + `</div>`
  };
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

// --- Per-page tab init (multi-page mode) ---
// Tabs are now anchor links — clicking them does a real page navigation, so
// the in-page show/hide router is gone. Instead we read which tab the
// current page hosts (from `.tab.active` set in the HTML) and fire that
// tab's render. Wait for DOMContentLoaded because the per-tab render
// functions (renderDeck, renderSwiss, renderHistory, renderTournamentRanking,
// etc.) live in scripts that load *after* core.js — they don't exist yet
// when this file finishes parsing.
// Preserve the .mode-tabs horizontal scroll position across page navigations.
// Runs synchronously when core.js executes — since the script tag sits at the
// end of <body>, the .mode-tabs element is already parsed and we can set
// scrollLeft before the first paint, so there's no visible "reset then snap"
// jump on each tab click.
// Lets a vertical mouse wheel scroll a horizontal-only row sideways. A
// horizontal wheel / trackpad swipe already scrolls it natively, so that's
// left alone, and the page wheel is only hijacked when the row can scroll.
function enableHorizontalWheelScroll(el) {
  if (!el) return;
  el.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;     // horizontal input
    if (el.scrollWidth <= el.clientWidth) return;             // nothing to scroll
    el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; // line vs pixel
    e.preventDefault();
  }, { passive: false });
}

(function restoreModeTabsScrollSync() {
  const tabs = document.querySelector(".mode-tabs");
  if (!tabs) return;
  const stored = sessionStorage.getItem("modeTabsScrollLeft");
  if (stored !== null) tabs.scrollLeft = parseInt(stored, 10) || 0;
  // Reveal once we've positioned it (CSS hides .mode-tabs by default to
  // guarantee no scrollLeft=0 frame ever paints).
  tabs.classList.add("mode-tabs-ready");

  let scrollSaveTimer = null;
  tabs.addEventListener("scroll", () => {
    if (scrollSaveTimer) clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(() => {
      sessionStorage.setItem("modeTabsScrollLeft", String(tabs.scrollLeft));
    }, 80);
  }, { passive: true });

  // Vertical mouse wheel scrolls the tab row horizontally.
  enableHorizontalWheelScroll(tabs);

  // Final snapshot at the moment of click, in case the user clicked
  // immediately after scrolling and the debounced save hasn't fired yet.
  tabs.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      sessionStorage.setItem("modeTabsScrollLeft", String(tabs.scrollLeft));
    });
  });
})();

// Library filter chips + sort row: vertical wheel scrolls them horizontally.
enableHorizontalWheelScroll(document.querySelector(".library-filter"));
enableHorizontalWheelScroll(document.querySelector(".library-sort"));

document.addEventListener("DOMContentLoaded", function initActiveTabRender() {
  const activeTab = document.querySelector(".tab.active");
  if (!activeTab) return;
  const mode = activeTab.dataset.mode;

  if (mode === "calculator") {
    const activeSubTab = subTabs?.querySelector(".sub-tab.active");
    const subMode = activeSubTab ? activeSubTab.dataset.mode : "standard";
    switchToCalcMode(subMode);
    return;
  }

  if (mode === "history") {
    const activeSub = document.querySelector(".history-sub-tab.active");
    const view = activeSub ? activeSub.dataset.historyView : "combos";
    if (view === "tournaments") {
      if (typeof renderTournamentHistory === "function") renderTournamentHistory();
    } else if (typeof renderHistory === "function") {
      renderHistory();
    }
  }

  if (mode === "deck") {
    if (typeof renderDeck === "function") renderDeck();
  }

  if (mode === "dashboard") {
    if (typeof renderDashboard === "function") renderDashboard();
  }

  if (mode === "swiss") {
    if (typeof renderSwiss === "function") renderSwiss();
    const activeTournamentSub = document.querySelector(".tournament-sub-tab.active");
    const view = activeTournamentSub?.dataset.tournamentView;
    if (view === "ranking" && typeof renderTournamentRanking === "function") renderTournamentRanking();
  }

  if (mode === "revox") {
    if (typeof renderRevoxRanking === "function") renderRevoxRanking();
  }
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
