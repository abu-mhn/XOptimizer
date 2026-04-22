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
    sel.value = "";
    input.value = "";
    sel.dispatchEvent(new Event("change"));
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
        renderHistory();
      }

      // ================= DECK =================
      if (mode === "deck") {
        renderDeck();
      }

      // ================= SWISS =================
      if (mode === "swiss") {
        renderSwiss();
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

// --- Rendering ---
function renderStatTable(label, stats) {
  let rows = "";
  for (const [k, v] of Object.entries(stats)) {
    rows += `<tr><th>${k}</th><td>${v}</td></tr>`;
  }
  const title = label ? `<div class="section-title">${label}</div>` : "";
  return `${title}<table>${rows}</table>`;
}

function getBarColor(val) {
  const cls = document.body.classList;
  const yellow = (cls.contains("light-mode") || cls.contains("tropical-mode")) ? "#ffbd59" : "#d29922";
  if (val >= 100) return "#3fb950";
  if (val >= 50) return yellow;
  return "#f85149";
}

let statDisplayMode = "bar";

function renderStatBars(grandTotal) {
  if (statDisplayMode === "radar") return renderRadarChart(grandTotal);

  const stats = [
    { label: "ATK", value: grandTotal.ATK, max: 150 },
    { label: "DEF", value: grandTotal.DEF, max: 150 },
    { label: "STA", value: grandTotal.STA, max: 150 },
    { label: "DAS", value: grandTotal.Dash, max: 50 },
    { label: "BUR", value: grandTotal["Burst Res"], max: 100 },
  ];
  let html = '<div class="stat-bars">';
  for (const s of stats) {
    const isTBA = s.value === "TBA" || s.value == null;
    const val = isTBA ? 0 : Number(s.value);
    const color = isTBA ? "#484f58" : (s.label === "DAS" || s.label === "BUR") ? getRadarColor(s.label, val) : getBarColor(val);
    const pct = isTBA ? 0 : Math.min(val / s.max * 100, 100);
    html += `<div class="stat-bar-row">
      <span class="stat-bar-label">${s.label}</span>
      <div class="stat-bar-track">
        <div class="stat-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="stat-bar-value" style="color:${color}">${isTBA ? "TBA" : val}</span>
    </div>`;
  }
  html += '</div>';
  return html;
}

function getRadarColor(label, val) {
  const cls = document.body.classList;
  const yellow = (cls.contains("light-mode") || cls.contains("tropical-mode")) ? "#ffbd59" : "#d29922";
  if (label === "DAS") {
    if (val >= 35) return "#3fb950";
    if (val >= 20) return yellow;
    return "#f85149";
  }
  if (label === "BUR") {
    if (val >= 80) return "#3fb950";
    if (val >= 50) return yellow;
    return "#f85149";
  }
  return getBarColor(val);
}

function renderRadarChart(grandTotal) {
  const stats = [
    { label: "ATK", value: grandTotal.ATK },
    { label: "DEF", value: grandTotal.DEF },
    { label: "STA", value: grandTotal.STA },
    { label: "DAS", value: grandTotal.Dash },
    { label: "BUR", value: grandTotal["Burst Res"] },
  ];

  const count = stats.length;
  const cx = 160, cy = 150, r = 90;
  const maxVal = 150;
  const cls = document.body.classList;
  const isLight = cls.contains("light-mode");
  const isTropical = cls.contains("tropical-mode");
  const gridColor = isTropical ? "#ffd8a8" : isLight ? "#c0c5cc" : "#30363d";
  const textColor = isTropical ? "#8a6d3b" : isLight ? "#1f2328" : "#e6edf3";

  // Evenly space angles starting from top
  const angles = stats.map((_, i) => -90 + (360 / count) * i);

  function polar(angle, radius) {
    const rad = angle * Math.PI / 180;
    return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
  }

  // Grid lines (3 levels)
  let grid = "";
  for (const level of [0.33, 0.66, 1]) {
    const pts = angles.map(a => polar(a, r * level).join(",")).join(" ");
    grid += `<polygon points="${pts}" fill="none" stroke="${gridColor}" stroke-width="1"/>`;
  }

  // Axis lines
  let axes = "";
  for (const a of angles) {
    const [x, y] = polar(a, r);
    axes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${gridColor}" stroke-width="1"/>`;
  }

  // Data polygon
  const dataPoints = stats.map((s, i) => {
    const val = (s.value === "TBA" || s.value == null) ? 0 : Number(s.value);
    const ratio = Math.min(val / maxVal, 1);
    return polar(angles[i], r * Math.max(ratio, 0.02));
  });
  const dataPts = dataPoints.map(p => p.join(",")).join(" ");

  const allTBA = stats.every(s => s.value === "TBA" || s.value == null);
  const fillColor = allTBA ? "rgba(72,79,88,0.3)" : isTropical ? "rgba(0,184,169,0.25)" : "rgba(56,139,253,0.25)";
  const strokeColor = allTBA ? "#484f58" : isTropical ? "#00b8a9" : "#388bfd";

  // Data points (dots)
  let dots = "";
  dataPoints.forEach(([x, y]) => {
    dots += `<circle cx="${x}" cy="${y}" r="3" fill="${strokeColor}"/>`;
  });

  // Labels
  let labels = "";
  stats.forEach((s, i) => {
    const angle = angles[i];
    const [x, y] = polar(angle, r + 30);
    const isTBA = s.value === "TBA" || s.value == null;
    const val = isTBA ? 0 : Number(s.value);
    const color = isTBA ? "#484f58" : getRadarColor(s.label, val);

    // Adjust vertical offset based on position
    let yOff = 0;
    if (angle === -90) yOff = -8;
    else if (angle > 90 && angle < 270) yOff = 8;

    labels += `<text x="${x}" y="${y + yOff}"
      text-anchor="middle" dominant-baseline="middle"
      fill="${textColor}" font-size="12" font-weight="600">${s.label}</text>`;
    labels += `<text x="${x}" y="${y + yOff + 14}"
      text-anchor="middle" dominant-baseline="middle"
      fill="${color}" font-size="11" font-weight="700">${isTBA ? "TBA" : val}</text>`;
  });

  return `<div class="stat-radar">
    <svg viewBox="0 0 320 300">
      ${grid}
      ${axes}
      <polygon points="${dataPts}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="2"/>
      ${dots}
      ${labels}
    </svg>
  </div>`;
}

function renderResult(res) {
  const el = document.getElementById("result");
  el.classList.remove("hidden");

  if (res.status === "Failure") {
    el.innerHTML = `<h2 class="status-failure">${res.message}</h2>`;
    return;
  }

  // ❌ DON'T re-run typeLogo
  const typeHtml = res.type || "";

  let html = `<h2 class="status-success">${res.message}</h2>`;

  if (res.comboName) {
    const spin = res.grandTotal?.["Spin Direction"]
      ? ` ${res.grandTotal["Spin Direction"]}`
      : "";

    html += `
      <div class="combo-name">
        ${res.comboName}
        ${typeHtml}
        ${spin}
      </div>
    `;
  }

  if (res.partImages && res.partImages.length > 0) {
    html += `<div class="result-parts">`;
    for (const p of res.partImages) {
      html += `<div class="result-part">
        <div class="result-part-img-box">
          <img src="${p.src}" alt="${p.name}" class="result-part-img"
               onerror="this.closest('.result-part').style.display='none'">
        </div>
        <span class="result-part-name">${p.name}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += renderStatBars(res.grandTotal);

  const { ATK, DEF, STA, Type, "Spin Direction": _spin, ...grandTotalRest } =
    res.grandTotal;

  const { Dash: _d, "Burst Res": _b, ...filteredRest } = grandTotalRest;
  html += renderStatTable("", filteredRest);

  html += `<div class="download-row">
    <button type="button" class="btn btn-download" aria-label="Download as PNG" title="Download as PNG">
      <img src="assets/icons/download.png" alt="Download"
           onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2B07;');">
    </button>
    <button type="button" class="btn btn-add-deck" aria-label="Add to Deck" title="Add to Deck">
      <span class="btn-add-deck-plus">+</span>
      <img src="assets/icons/cards.png" alt="Deck"
           onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','Deck');">
    </button>
  </div>`;

  el.innerHTML = html;

  // Wire up download button
  el.querySelector(".btn-download")?.addEventListener("click", () => downloadResultPNG(el));
  el.querySelector(".btn-add-deck")?.addEventListener("click", () => addCurrentToDeck());
}

function downloadResultPNG(el) {
  // Temporarily hide the download button during capture
  const dlBtn = el.querySelector(".download-row");
  if (dlBtn) dlBtn.style.display = "none";

  // Temporarily allow part images to wrap onto multiple rows for the capture
  const partsEl = el.querySelector(".result-parts");
  const origFlexWrap = partsEl?.style.flexWrap;
  const origOverflowX = partsEl?.style.overflowX;
  const origJustify = partsEl?.style.justifyContent;
  if (partsEl) {
    partsEl.style.flexWrap = "wrap";
    partsEl.style.overflowX = "visible";
    partsEl.style.justifyContent = "center";
  }
  const restoreParts = () => {
    if (!partsEl) return;
    partsEl.style.flexWrap = origFlexWrap;
    partsEl.style.overflowX = origOverflowX;
    partsEl.style.justifyContent = origJustify;
  };

  // Temporarily add footer for the screenshot (hidden from user view)
  const cls = document.body.classList;
  const isLightLike = cls.contains("light-mode") || cls.contains("tropical-mode");
  const isTropical = cls.contains("tropical-mode");
  const footerColor = isTropical ? "#8a6d3b" : isLightLike ? "#656d76" : "#8b949e";
  const footerBorder = isTropical ? "#ffd8a8" : isLightLike ? "#d1d9e0" : "#21262d";
  const strongColor = isTropical ? "#2d3a3a" : isLightLike ? "#1f2328" : "#c9d1d9";
  const pageBg = isTropical ? "#fff6e6" : cls.contains("light-mode") ? "#f6f8fa" : cls.contains("space-mode") ? "#0b0d1a" : cls.contains("stormy-mode") ? "#1e2330" : cls.contains("mono-mode") ? "#000000" : "#0d1117";
  const logoSrc = isLightLike ? "assets/icons/revoxNameLight.webp" : "assets/icons/revoxName.webp";

  const footer = document.createElement("div");
  footer.className = "png-footer";
  footer.style.cssText = `text-align:center;padding:12px 0 8px;font-size:12px;color:${footerColor};border-top:1px solid ${footerBorder};margin-top:12px;`;
  footer.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;width:100%;text-align:center;">
      <span style="display:flex;align-items:center;gap:4px;">X Optimizer</span>
      <span style="opacity:0.5;">•</span>
      <span style="display:flex;align-items:center;gap:4px;">Created by <strong style="color:${strongColor};">RvX Ashwolf</strong></span>
      <span style="display:flex;align-items:center;gap:4px;width:100%;justify-content:center;margin-top:6px;">Powered by <img src="${logoSrc}" alt="Revox" style="height:40px;width:auto;transform:translateY(-5px);"></span>
    </div>`;
  el.appendChild(footer);

  // Move element off-screen so the user doesn't see the footer flash
  const origPos = el.style.position;
  const origLeft = el.style.left;
  const origWidth = el.style.width;
  const captureWidth = el.offsetWidth;
  el.style.width = captureWidth + "px";
  el.style.position = "fixed";
  el.style.left = "-9999px";

  html2canvas(el, {
    backgroundColor: pageBg,
    scale: 2,
    useCORS: true,
    width: captureWidth
  }).then(canvas => {
    el.style.position = origPos;
    el.style.left = origLeft;
    el.style.width = origWidth;
    if (dlBtn) dlBtn.style.display = "";
    footer.remove();
    restoreParts();
    const side = Math.max(canvas.width, canvas.height);
    const square = document.createElement("canvas");
    square.width = side;
    square.height = side;
    const ctx = square.getContext("2d");
    ctx.fillStyle = pageBg;
    ctx.fillRect(0, 0, side, side);
    ctx.drawImage(canvas, Math.floor((side - canvas.width) / 2), Math.floor((side - canvas.height) / 2));

    const link = document.createElement("a");
    // Use combo name for filename if available
    const comboEl = el.querySelector(".combo-name, .combo-header");
    const name = comboEl ? comboEl.textContent.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_") : "result";
    link.download = `${name}.png`;
    link.href = square.toDataURL("image/png");
    link.click();
  }).catch(() => {
    el.style.position = origPos;
    el.style.left = origLeft;
    el.style.width = origWidth;
    if (dlBtn) dlBtn.style.display = "";
    footer.remove();
    restoreParts();
    alert("Failed to generate image.");
  });
}

function formatWeight(val) {
  if (val === null || val === undefined || val === "TBA") return "TBA";
  return `${Number(val).toFixed(1)} g`;
}

function formatStat(val) {
  if (val === null || val === undefined || val === "TBA") return "TBA";
  return Number(val);
}

function formatHeight(val) {
  if (val === null || val === undefined || val === "TBA") return "TBA";
  return `${(Number(val) / 10).toFixed(1)} mm`;
}

// --- Standard calculation ---
function calcStandard(form) {
  console.log("calcStandard triggered");

  window.__activeForm = form;
  window.__activeCalc = "standard";

  const bladeIdx = form.querySelector('[name="blade"]')?.value;
  const ratchetIdx = form.querySelector('[name="ratchet"]')?.value;
  const bitIdx = form.querySelector('[name="bit"]')?.value;

  if (!bladeIdx) {
    return renderResult({
      status: "Failure",
      message: "Please select a blade."
    });
  }

  const blade = DATA?.blades?.[bladeIdx];
  const bitRaw = bitIdx !== "" && bitIdx != null ? DATA?.bits?.[bitIdx] : null;
  const isRB = !!(bitRaw && bitRaw.isRatchetBit);
  const isNoRatchet = ratchetIdx === NO_RATCHET;
  const ratchet = isRB || isNoRatchet ? null : (ratchetIdx ? DATA?.ratchets?.[ratchetIdx] : null);
  const bit = isRB ? null : bitRaw;
  const rb = isRB ? bitRaw : null;

  if (!blade) {
    return renderResult({
      status: "Failure",
      message: "Blade not found."
    });
  }

  // ================= STAT CHECK =================
  function hasZeroStat(...parts) {
    return parts.some(p =>
      p && (p.atk === 0 || p.def === 0 || p.sta === 0)
    );
  }

  // ================= MODE =================
  const bladeModes = blade?.modes?.length ? blade.modes : null;
  const rbModes = rb?.modes?.length ? rb.modes : null;

  if (bladeModes && blade._modeIndex == null) blade._modeIndex = 0;
  if (rbModes && rb._modeIndex == null) rb._modeIndex = 0;

  const applyMode = (base, mode) => {
    if (!base || !mode) return base;
    return { ...base, ...mode };
  };

  const bladeA = applyMode(
    blade,
    bladeModes ? bladeModes[blade._modeIndex] : null
  );

  const rbA = applyMode(
    rb,
    rbModes ? rbModes[rb._modeIndex] : null
  );

  // ================= BOTTOM =================
  let bAtk = 0, bDef = 0, bSta = 0, bWeight = 0, bHeight = null;

  if (isRB && rbA) {
    bAtk = rbA.atk || 0;
    bDef = rbA.def || 0;
    bSta = rbA.sta || 0;
    bWeight = rbA.weight || 0;
    bHeight = rbA.height || null;
  } else if (bit) {
    const r = ratchet || { atk: 0, def: 0, sta: 0, weight: 0 };

    bAtk = r.atk + (bit.atk || 0);
    bDef = r.def + (bit.def || 0);
    bSta = r.sta + (bit.sta || 0);
    bWeight = r.weight + (bit.weight || 0);
    bHeight = ratchet?.height || null;
  }

  // ================= GRAND TOTAL =================
  const gAtk = (bladeA.atk || 0) + bAtk;
  const gDef = (bladeA.def || 0) + bDef;
  const gSta = (bladeA.sta || 0) + bSta;

  // ================= STAT TBA =================
  const isStatTBA = hasZeroStat(bladeA, ratchet, bit, rbA);
  const barState = isStatTBA ? "grey" : "normal";

  const finalAtk = isStatTBA ? "TBA" : gAtk;
  const finalDef = isStatTBA ? "TBA" : gDef;
  const finalSta = isStatTBA ? "TBA" : gSta;

  // ================= WEIGHT TBA (FIXED) =================
  const selectedParts = [bladeA, ratchet, bit, rbA];

  const isWeightTBA = selectedParts.some(p => p?.weight === 0);

  const totalWeightRaw = (bladeA.weight || 0) + bWeight;

  const finalWeight = isWeightTBA
    ? "TBA"
    : `${totalWeightRaw.toFixed(1)} g`;

  // ================= TYPE =================
  const type = getType(gAtk, gDef, gSta, isRB);

  const comboName =
    (bladeA.codename || bladeA.name) +
    (isRB
      ? (rbA?.codename || "")
      : ((ratchet?.name || "") + (bit?.codename || "")));

  const headerId = "comboHeader";

  // ================= SAVE HISTORY =================
  saveHistory("BX", {
    comboName,
    modeData: {
      bladeMode: bladeModes
        ? bladeModes[blade._modeIndex]?.modeName
        : null,
      ratchetBitMode: rbModes
        ? rbModes[rb._modeIndex]?.modeName
        : null
    },

    top: {
      spinDirection: bladeA?.spindirection || "R"
    },

    parts: {
      blade: blade.name,
      ratchet: ratchet?.name || null,
      bit: (bit?.name) || (rb?.name) || null
    },
    partModes: {
      blade: bladeModes ? blade?._modeIndex ?? null : null,
      bit: isRB && rbModes ? rb?._modeIndex ?? null : null
    },

    grandTotal: {
      ATK: finalAtk,
      DEF: finalDef,
      STA: finalSta,

      Weight: finalWeight,

      ...(bladeA.codename === "BULLETGRIFFON" ? {} : {
        Height: bHeight == null
          ? "TBA"
          : `${(Number(bHeight) / 10).toFixed(1)} mm`
      }),

      Dash: isRB ? rbA?.dash : bit?.dash,
      "Burst Res": isRB ? rbA?.burstRes : bit?.burstRes
    }
  });

  // ================= PART IMAGES =================
  const partImages = [
    { name: blade.name, src: partImgPath("blades", blade.name, bladeModes ? blade._modeIndex : null) },
  ];
  if (isRB && rb) {
    partImages.push({ name: rb.name, src: partImgPath(rb._folder || "ratchetBits", rb.name, rbModes ? rb._modeIndex : null) });
  } else {
    if (ratchet) partImages.push({ name: ratchet.name, src: partImgPath("ratchets", ratchet.name) });
    if (bit) partImages.push({ name: bit.name, src: partImgPath(bit._folder || "bits", bit.name) });
  }

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    barState,
    partImages,

    comboName: `
      <div id="${headerId}" class="combo-header">
        <div class="combo-inner">
          <span class="combo-name">${comboName}</span>
          ${typeLogo(type)}
          ${spinLogo(bladeA?.spindirection)}
        </div>
      </div>
    `,

    grandTotal: {
      ATK: finalAtk,
      DEF: finalDef,
      STA: finalSta,

      Weight: finalWeight,

      ...(bladeA.codename === "BULLETGRIFFON" ? {} : {
        Height: bHeight == null
          ? "TBA"
          : `${(Number(bHeight) / 10).toFixed(1)} mm`
      }),

      Dash: isRB ? rbA?.dash : bit?.dash,
      "Burst Res": isRB ? rbA?.burstRes : bit?.burstRes,

      ...(bladeModes
        ? {
          "Blade Mode": `
              <span class="clickable-mode" data-mode="blade">
                ${bladeModes[blade._modeIndex].modeName}
              </span>`
        }
        : {}),

      ...(rbModes
        ? {
          "Ratchet-Bit Mode": `
              <span class="clickable-mode" data-mode="rb">
                ${rbModes[rb._modeIndex].modeName}
              </span>`
        }
        : {})
    }
  });

  // ================= AUTO SCROLL =================
  requestAnimationFrame(() => {
    document.getElementById("result")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// --- CX calculation ---
function calcCX(form) {
  console.log("calcCX triggered");

  window.__activeForm = form;
  window.__activeCalc = "cx";

  const lcIdx = form.querySelector('[name="lockChip"]')?.value;
  const mbIdx = form.querySelector('[name="mainBlade"]')?.value;
  const abIdx = form.querySelector('[name="assistBlade"]')?.value;
  const rIdx = form.querySelector('[name="ratchet"]')?.value;
  const bIdx = form.querySelector('[name="bit"]')?.value;

  if (!lcIdx || !mbIdx || !abIdx) {
    return renderResult({
      status: "Failure",
      message: "Please select all top components."
    });
  }

  const lc = DATA.lockChips[lcIdx];
  const mb = DATA.mainBlades[mbIdx];
  const ab = DATA.assistBlades[abIdx];
  const bitRaw = bIdx !== "" && bIdx != null ? DATA.bits[bIdx] : null;
  const isRB = !!(bitRaw && bitRaw.isRatchetBit);
  const isNoRatchet = rIdx === NO_RATCHET;
  const ratchet = isRB || isNoRatchet ? null : (rIdx ? DATA.ratchets[rIdx] : null);
  const bit = isRB ? null : bitRaw;
  const rb = isRB ? bitRaw : null;

  if (!lc || !mb || !ab) {
    return renderResult({
      status: "Failure",
      message: "One or more parts not found."
    });
  }

  // ================= MODE =================
  const mbModes = mb?.modes || null;
  const abModes = ab?.modes || null;
  const rbModes = rb?.modes || null;

  if (mbModes && mb._modeIndex == null) mb._modeIndex = 0;
  if (abModes && ab._modeIndex == null) ab._modeIndex = 0;
  if (rbModes && rb._modeIndex == null) rb._modeIndex = 0;

  const applyMode = (base, mode) =>
    !base || !mode ? base : { ...base, ...mode };

  const mbA = applyMode(mb, mbModes?.[mb._modeIndex]);
  const abA = applyMode(ab, abModes?.[ab._modeIndex]);
  const rbA = applyMode(rb, rbModes?.[rb?._modeIndex]);

  // ================= ZERO CHECK =================
  function hasZeroStat(...parts) {
    return parts.some(p => p && (p.atk === 0 || p.def === 0 || p.sta === 0));
  }

  function hasZeroWeight(...parts) {
    return parts.some(p => p && p.weight === 0);
  }

  const isStatTBA = hasZeroStat(mbA, abA, lc, ratchet, bit, rbA);
  const isWeightTBA = hasZeroWeight(mbA, abA, lc, ratchet, bit, rbA);

  const formatWeight = (v) =>
    v === null || v === undefined || v === "TBA"
      ? "TBA"
      : `${Number(v).toFixed(1)} g`;

  const formatHeight = (v) =>
    v === null || v === undefined || v === "TBA"
      ? "TBA"
      : `${(Number(v) / 10).toFixed(1)} mm`;

  // ================= TOP =================
  const topAtk = (mbA.atk || 0) + (abA.atk || 0);
  const topDef = (mbA.def || 0) + (abA.def || 0);
  const topSta = (mbA.sta || 0) + (abA.sta || 0);

  const topWeight =
    (lc.weight || 0) + (mbA.weight || 0) + (abA.weight || 0);

  const abHeight = abA?.height || 0;

  // ================= BOTTOM =================
  let bAtk = 0, bDef = 0, bSta = 0, bWeight = 0, bHeight = 0;

  if (isRB && rbA) {
    bAtk = rbA.atk || 0;
    bDef = rbA.def || 0;
    bSta = rbA.sta || 0;
    bWeight = rbA.weight || 0;
    bHeight = abHeight + (rbA.height || 0);
  } else if (bit) {
    const r = ratchet || { atk: 0, def: 0, sta: 0, weight: 0, height: 0 };

    bAtk = r.atk + (bit.atk || 0);
    bDef = r.def + (bit.def || 0);
    bSta = r.sta + (bit.sta || 0);
    bWeight = r.weight + (bit.weight || 0);
    bHeight = abHeight + (r.height || 0);
  }

  // ================= GRAND =================
  const gAtk = isStatTBA ? "TBA" : topAtk + bAtk;
  const gDef = isStatTBA ? "TBA" : topDef + bDef;
  const gSta = isStatTBA ? "TBA" : topSta + bSta;

  const gWeight = isWeightTBA ? "TBA" : topWeight + bWeight;
  const gHeight = bHeight;

  const type = isStatTBA ? null : getType(gAtk, gDef, gSta, isRB);

  const comboName =
    lc.codename +
    mbA.codename +
    abA.codename +
    (isRB
      ? rbA.codename
      : (ratchet?.name || "") + (bit?.codename || ""));

  // ================= HISTORY (FIXED + COMPLETE) =================
  saveHistory("CX", {
    comboName,

    modeData: {
      mainBladeMode: mbModes?.[mb._modeIndex]?.modeName || null,
      assistBladeMode: abModes?.[ab._modeIndex]?.modeName || null,
      ratchetBitMode: rbModes?.[rb?._modeIndex]?.modeName || null
    },

    top: {
      spinDirection: mbA?.spindirection || "R"
    },

    parts: {
      lockChip: lc.name,
      mainBlade: mbA.name,
      assistBlade: abA.name,
      ratchet: ratchet?.name || null,
      bit: (bit?.name) || (rb?.name) || null
    },
    partModes: {
      mainBlade: mbModes ? mb?._modeIndex ?? null : null,
      assistBlade: abModes ? ab?._modeIndex ?? null : null,
      bit: isRB && rbModes ? rb?._modeIndex ?? null : null
    },

    grandTotal: {
      ATK: gAtk,
      DEF: gDef,
      STA: gSta,
      Weight: formatWeight(gWeight),
      Height: formatHeight(gHeight),
      Dash: isRB ? rbA?.dash : bit?.dash,
      "Burst Res": isRB ? rbA?.burstRes : bit?.burstRes
    }
  });

  // ================= PART IMAGES =================
  const partImages = [
    { name: lc.name, src: partImgPath("lockChips", lc.name) },
    { name: mb.name, src: partImgPath("mainBlades", mb.name, mbModes ? mb._modeIndex : null) },
    { name: ab.name, src: partImgPath("assistBlades", ab.name, abModes ? ab._modeIndex : null) },
  ];
  if (isRB && rb) {
    partImages.push({ name: rb.name, src: partImgPath(rb._folder || "ratchetBits", rb.name, rbModes ? rb._modeIndex : null) });
  } else {
    if (ratchet) partImages.push({ name: ratchet.name, src: partImgPath("ratchets", ratchet.name) });
    if (bit) partImages.push({ name: bit.name, src: partImgPath(bit._folder || "bits", bit.name) });
  }

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    barState: isStatTBA ? "grey" : "normal",
    partImages,

    comboName: `
      <div class="combo-header">
        <span>${comboName}</span>
        ${typeLogo(type)}
        ${spinLogo(mbA?.spindirection)}
      </div>
    `,

    grandTotal: {
      ATK: gAtk,
      DEF: gDef,
      STA: gSta,
      Weight: formatWeight(gWeight),
      Height: formatHeight(gHeight),

      Dash: isRB ? rbA?.dash : bit?.dash,
      "Burst Res": isRB ? rbA?.burstRes : bit?.burstRes,

      ...(mbModes ? {
        "Main Blade Mode": `<span class="clickable-mode" data-mode="mb">${mbModes[mb._modeIndex].modeName}</span>`
      } : {}),

      ...(abModes ? {
        "Assist Blade Mode": `<span class="clickable-mode" data-mode="ab">${abModes[ab._modeIndex].modeName}</span>`
      } : {}),

      ...(rbModes ? {
        "Ratchet-Bit Mode": `<span class="clickable-mode" data-mode="rb">${rbModes[rb._modeIndex].modeName}</span>`
      } : {})
    }
  });

  // ================= AUTO SCROLL =================
  requestAnimationFrame(() => {
    document.getElementById("result")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

// --- CX Expand calculation ---
function calcCXExpand(form) {
  console.log("calcCXExpand triggered");

  // ================= STORE ACTIVE FORM (IMPORTANT FOR MODE CLICK) =================
  window.__activeForm = form;
  window.__activeCalc = "cxExpand";

  const lcIdx = form.querySelector('[name="lockChip"]')?.value;
  const mbIdx = form.querySelector('[name="metalBlade"]')?.value;
  const obIdx = form.querySelector('[name="overBlade"]')?.value;
  const abIdx = form.querySelector('[name="assistBlade"]')?.value;
  const rIdx = form.querySelector('[name="ratchet"]')?.value;
  const bIdx = form.querySelector('[name="bit"]')?.value;

  if (!lcIdx || !mbIdx || !abIdx) {
    return renderResult({
      status: "Failure",
      message: "Please select all required top components."
    });
  }

  const lc = DATA.lockChips[lcIdx];
  const mb = DATA.metalBlades[mbIdx];
  const ob = obIdx ? DATA.overBlades[obIdx] : null;
  const ab = DATA.assistBlades[abIdx];

  const bitRaw = bIdx !== "" && bIdx != null ? DATA.bits[bIdx] : null;
  const isRB = !!(bitRaw && bitRaw.isRatchetBit);
  const isNoRatchet = rIdx === NO_RATCHET;
  const ratchet = isRB || isNoRatchet ? null : (rIdx ? DATA.ratchets[rIdx] : null);
  const bit = isRB ? null : bitRaw;
  const rb = isRB ? bitRaw : null;

  if (!lc || !mb || !ab) {
    return renderResult({
      status: "Failure",
      message: "One or more components not found"
    });
  }

  // ================= ACTIVE MODE =================
  const getActive = (item) => {
    if (!item?.modes?.length) return item;
    if (item._modeIndex == null) item._modeIndex = 0;
    return { ...item, ...item.modes[item._modeIndex] };
  };

  const mbA = getActive(mb);
  const obA = getActive(ob);
  const abA = getActive(ab);
  const rbA = getActive(rb);

  const mbModes = mb?.modes || null;
  const obModes = ob?.modes || null;
  const abModes = ab?.modes || null;
  const rbModes = rb?.modes || null;

  // ================= TBA CHECK =================
  function hasZeroStat(...parts) {
    return parts.some(p =>
      p && (p.atk === 0 || p.def === 0 || p.sta === 0)
    );
  }

  function hasZeroWeight(...parts) {
    return parts.some(p => p && p.weight === 0);
  }

  function hasZeroHeight(...parts) {
    return parts.some(p => p && p.height === 0);
  }

  const isStatTBA = hasZeroStat(mbA, obA, abA, lc, ratchet, bit, rbA);
  const isWeightTBA = hasZeroWeight(mbA, obA, abA, lc, ratchet, bit, rbA);
  const isHeightTBA = hasZeroHeight(mbA, obA, abA, lc, ratchet, bit, rbA);

  // ================= TOP =================
  let topAtk = (mbA.atk || 0) + (abA.atk || 0) + (obA?.atk || 0);
  let topDef = (mbA.def || 0) + (abA.def || 0) + (obA?.def || 0);
  let topSta = (mbA.sta || 0) + (abA.sta || 0) + (obA?.sta || 0);

  let topWeight =
    (lc.weight || 0) +
    (mbA.weight || 0) +
    (abA.weight || 0) +
    (obA?.weight || 0);

  const abHeight = abA?.height || 0;
  const obHeight = obA?.height || 0;
  const topHeight = abHeight + obHeight;

  // ================= BOTTOM =================
  let bAtk = 0, bDef = 0, bSta = 0, bWeight = 0, bHeight = 0;

  if (isRB && rbA) {
    bAtk = rbA.atk || 0;
    bDef = rbA.def || 0;
    bSta = rbA.sta || 0;
    bWeight = rbA.weight || 0;
    bHeight = topHeight + (rbA.height || 0);
  } else if (bit) {
    const r = ratchet || { atk: 0, def: 0, sta: 0, weight: 0, height: 0 };

    bAtk = r.atk + (bit.atk || 0);
    bDef = r.def + (bit.def || 0);
    bSta = r.sta + (bit.sta || 0);
    bWeight = r.weight + (bit.weight || 0);
    bHeight = topHeight + (r.height || 0);
  }

  const bDash = isRB ? rbA?.dash : bit?.dash;
  const bBurstRes = isRB ? rbA?.burstRes : bit?.burstRes;

  // ================= GRAND =================
  const gAtk = isStatTBA ? "TBA" : (topAtk + bAtk);
  const gDef = isStatTBA ? "TBA" : (topDef + bDef);
  const gSta = isStatTBA ? "TBA" : (topSta + bSta);

  const gWeightRaw = topWeight + bWeight;

  const gWeight = isWeightTBA ? "TBA" : gWeightRaw;

  const gHeight = isHeightTBA
    ? "TBA"
    : (bHeight / 10).toFixed(1);

  const type = isStatTBA ? null : getType(gAtk, gDef, gSta, isRB);

  const comboName =
    lc.codename +
    mbA.codename +
    (obA?.codename || "") +
    abA.codename +
    (isRB
      ? rbA.codename
      : (ratchet?.name || "") + (bit?.codename || ""));

  const headerId = "comboHeader";

  // ================= MODE CLICK SYSTEM (FIXED - NO REBIND ISSUES) =================
  // (handled globally below)

  // ================= SAVE HISTORY =================
  saveHistory("CX_EXPAND", {
    comboName,
    modeData: {
      assistBlade: abModes?.[ab._modeIndex]?.modeName || null,
      ratchetBit: rbModes?.[rb?._modeIndex]?.modeName || null
    },

    parts: {
      lockChip: lc.name,
      metalBlade: mbA.name,
      overBlade: obA?.name || null,
      assistBlade: abA.name,
      ratchet: ratchet?.name || null,
      bit: (bit?.name) || (rb?.name) || null
    },
    partModes: {
      assistBlade: abModes ? ab?._modeIndex ?? null : null,
      bit: isRB && rbModes ? rb?._modeIndex ?? null : null
    },

    top: {
      ATK: topAtk,
      DEF: topDef,
      STA: topSta,
      Weight: topWeight,
      spinDirection: mbA?.spindirection || "R"
    },

    bottom: {
      ATK: bAtk,
      DEF: bDef,
      STA: bSta,
      Weight: bWeight,
      Height: isHeightTBA ? "TBA" : `${gHeight} mm`
    },

    grandTotal: {
      ATK: gAtk,
      DEF: gDef,
      STA: gSta,
      Weight: gWeight === "TBA" ? "TBA" : formatWeight(gWeight),
      Height: isHeightTBA ? "TBA" : `${gHeight} mm`,
      Dash: bDash,
      "Burst Res": bBurstRes
    }
  });

  // ================= PART IMAGES =================
  const partImages = [
    { name: lc.name, src: partImgPath("lockChips", lc.name) },
    { name: mb.name, src: partImgPath("metalBlades", mb.name, mbModes ? (mb._modeIndex || 0) : null) },
  ];
  if (ob) partImages.push({ name: ob.name, src: partImgPath("overBlades", ob.name, obModes ? (ob._modeIndex || 0) : null) });
  partImages.push({ name: ab.name, src: partImgPath("assistBlades", ab.name, abModes ? (ab._modeIndex || 0) : null) });
  if (isRB && rb) {
    partImages.push({ name: rb.name, src: partImgPath(rb._folder || "ratchetBits", rb.name, rbModes ? (rb._modeIndex || 0) : null) });
  } else {
    if (ratchet) partImages.push({ name: ratchet.name, src: partImgPath("ratchets", ratchet.name) });
    if (bit) partImages.push({ name: bit.name, src: partImgPath(bit._folder || "bits", bit.name) });
  }

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    partImages,

    comboName: `
      <div class="combo-header">
        <span>${comboName}</span>
        ${typeLogo(type)}
        ${spinLogo(mbA.spindirection)}
      </div>
    `,

    grandTotal: {
      ATK: gAtk,
      DEF: gDef,
      STA: gSta,
      Weight: gWeight === "TBA" ? "TBA" : formatWeight(gWeight),
      Height: isHeightTBA ? "TBA" : `${gHeight} mm`,
      Dash: bDash,
      "Burst Res": bBurstRes,

      ...(mbModes ? {
        "Metal Blade Mode": `<span class="clickable-mode" data-mode="mb">${mbModes[mb._modeIndex || 0].modeName}</span>`
      } : {}),

      ...(obModes ? {
        "Over Blade Mode": `<span class="clickable-mode" data-mode="ob">${obModes[ob._modeIndex || 0].modeName}</span>`
      } : {}),

      ...(abModes ? {
        "Assist Blade Mode": `<span class="clickable-mode" data-mode="ab">${abModes[ab._modeIndex || 0].modeName}</span>`
      } : {}),

      ...(rbModes ? {
        "Ratchet-Bit Mode": `<span class="clickable-mode" data-mode="rb">${rbModes[rb._modeIndex || 0].modeName}</span>`
      } : {})
    }
  });

  // ================= AUTO SCROLL =================
  requestAnimationFrame(() => {
    document.getElementById("result")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });
}

document.addEventListener("click", (e) => {
  const el = e.target.closest(".clickable-mode");
  if (!el) return;

  const form = window.__activeForm;
  const calc = window.__activeCalc;
  if (!form || !calc) return;

  const mode = el.dataset.mode;

  const cycle = (item) => {
    if (!item?.modes?.length) return;
    item._modeIndex = ((item._modeIndex || 0) + 1) % item.modes.length;
  };

  if (calc === "standard") {
    const blade = DATA.blades?.[form.querySelector('[name="blade"]')?.value];
    const bitSelected = DATA.bits?.[form.querySelector('[name="bit"]')?.value];
    const rb = bitSelected && bitSelected.isRatchetBit ? bitSelected : null;

    if (mode === "blade") cycle(blade);
    if (mode === "rb") cycle(rb);

    calcStandard(form);
  } else if (calc === "cx") {
    const mb = DATA.mainBlades?.[form.querySelector('[name="mainBlade"]')?.value];
    const ab = DATA.assistBlades?.[form.querySelector('[name="assistBlade"]')?.value];
    const bitSelected = DATA.bits?.[form.querySelector('[name="bit"]')?.value];
    const rb = bitSelected && bitSelected.isRatchetBit ? bitSelected : null;

    if (mode === "mb") cycle(mb);
    if (mode === "ab") cycle(ab);
    if (mode === "rb") cycle(rb);

    calcCX(form);
  } else if (calc === "cxExpand") {
    const mb = DATA.metalBlades?.[form.querySelector('[name="metalBlade"]')?.value];
    const ob = DATA.overBlades?.[form.querySelector('[name="overBlade"]')?.value];
    const ab = DATA.assistBlades?.[form.querySelector('[name="assistBlade"]')?.value];
    const bitSelected = DATA.bits?.[form.querySelector('[name="bit"]')?.value];
    const rb = bitSelected && bitSelected.isRatchetBit ? bitSelected : null;

    if (mode === "mb") cycle(mb);
    if (mode === "ob") cycle(ob);
    if (mode === "ab") cycle(ab);
    if (mode === "rb") cycle(rb);

    calcCXExpand(form);
  }
});

// --- Form handlers ---
document.getElementById("form-standard").addEventListener("submit", e => { e.preventDefault(); calcStandard(e.target); });
document.getElementById("form-cx").addEventListener("submit", e => { e.preventDefault(); calcCX(e.target); });
document.getElementById("form-cxExpand").addEventListener("submit", e => { e.preventDefault(); calcCXExpand(e.target); });

// --- Init ---
sortData();
initDropdowns();

// --- Blade-specific restrictions (Standard) ---
(function () {
  const stdForm = document.getElementById("form-standard");
  const bladeSel = stdForm.querySelector('[name="blade"]');
  const ratchetWrapper = stdForm.querySelector('[name="ratchet"]').nextElementSibling;
  const ratchetInput = ratchetWrapper.querySelector("input");
  const bitWrapper = stdForm.querySelector('[name="bit"]').nextElementSibling;
  const bitInput = bitWrapper.querySelector("input");

  bladeSel.addEventListener("change", () => {
    const idx = bladeSel.value;
    const codename = idx !== "" ? DATA.blades[idx].codename : "";

    if (codename === "CLOCKMIRAGE") {
      // Clock Mirage: filter ratchet to *5; bit list restricted to regular bits
      ratchetWrapper._setFilter(r => r.name.endsWith("5"));
      ratchetInput.disabled = false;
      ratchetInput.placeholder = "-- Select --";
      bitWrapper._setFilter(b => !b.isRatchetBit);
      bitInput.disabled = false;
      bitInput.placeholder = "-- Select --";
    } else if (codename === "BULLETGRIFFON") {
      // Bullet Griffon: force "No Ratchet"; bit list restricted to ratchet-bits
      ratchetWrapper._filterFn = null;
      ratchetWrapper._select(NO_RATCHET);
      ratchetInput.disabled = true;
      bitWrapper._setFilter(b => !!b.isRatchetBit);
      bitInput.disabled = false;
      bitInput.placeholder = "-- Select --";
    } else {
      // Default: clear ratchet filter; bit filter driven by ratchet selection.
      ratchetWrapper._filterFn = null;
      ratchetInput.disabled = false;
      ratchetInput.placeholder = "-- Select --";
      bitInput.disabled = false;
      bitInput.placeholder = "-- Select --";
      applyBitFilter(stdForm);
    }
  });
})();

// --- Generic multi-mode item button ---
function setupModeButton(form, selectName, dataArray) {
  const sel = form.querySelector(`[name="${selectName}"]`);
  if (!sel) return;

  function getItem() {
    const idx = sel.value;
    if (idx === "") return null;
    return dataArray[idx] || null;
  }

  function applyMode(item) {
    if (!item?.modes || typeof item.currentMode !== "number") return item;
    const m = item.modes[item.currentMode];
    if (!m) return item;

    for (const k in m) {
      if (k !== "modeName") item[k] = m[k];
    }
  }

  function updateMode() {
    const item = getItem();
    if (!item || !item.modes) return;

    // reset mode when changed
    item.currentMode = item.currentMode ?? 0;
    applyMode(item);

    // auto re-calc if result visible
    const result = document.getElementById("result");
    if (result && !result.classList.contains("hidden")) {
      form.requestSubmit();
    }
  }

  // ================= CHANGE EVENT =================
  sel.addEventListener("change", () => {
    const item = getItem();
    if (item?.modes) {
      item.currentMode = 0;
      applyMode(item);
    }

    updateMode();
  });

  // ================= CLICK ANY ELEMENT WITH MODE =================
  sel.addEventListener("dblclick", () => {
    const item = getItem();
    if (!item?.modes) return;

    item.currentMode = (item.currentMode + 1) % item.modes.length;
    applyMode(item);

    updateMode();
  });
}

(function () {
  const stdForm = document.getElementById("form-standard");
  const cxForm = document.getElementById("form-cx");
  const cxeForm = document.getElementById("form-cxExpand");

  setupModeButton(stdForm, "blade", DATA.blades);
  setupModeButton(stdForm, "bit", DATA.bits);

  setupModeButton(cxForm, "mainBlade", DATA.mainBlades);
  setupModeButton(cxForm, "assistBlade", DATA.assistBlades);
  setupModeButton(cxForm, "bit", DATA.bits);

  setupModeButton(cxeForm, "assistBlade", DATA.assistBlades);
  setupModeButton(cxeForm, "bit", DATA.bits);
})();

// --- Ratchet -> Bit filter coupling ---
// Bit dropdown defaults to regular bits. Picking "No Ratchet" (NO_RATCHET sentinel)
// switches the bit filter to ratchet-bit-flagged items only.
document.querySelectorAll(".calc-form").forEach(form => {
  const ratchetSel = form.querySelector('[name="ratchet"]');
  const bitSel = form.querySelector('[name="bit"]');
  if (!ratchetSel || !bitSel) return;

  ratchetSel.addEventListener("change", () => {
    applyBitFilter(form);
  });

  // Initial state: enforce the default (regular bits only).
  applyBitFilter(form);
});

// --- Reset handlers ---
document.querySelectorAll(".btn-reset").forEach(btn => {
  btn.addEventListener("click", () => {
    const form = btn.closest("form");

    form.querySelectorAll(".search-dropdown").forEach(w => w._clear());

    // Re-enable dropdowns
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

    form.querySelectorAll(".btn-mode").forEach(b => b.classList.add("hidden"));

    document.getElementById("result")?.classList.add("hidden");

    // 🔽 AUTO SCROLL TO TOP (追加)
    requestAnimationFrame(() => {
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });
  });
});

// --- Calc button enable/disable ---
(function () {
  const COMBO_RULES = {
    "form-standard": {
      top: ["blade"]
    },
    "form-cx": {
      top: ["lockChip", "mainBlade", "assistBlade"]
    },
    "form-cxExpand": {
      top: ["lockChip", "metalBlade", "assistBlade"]
    }
  };

  function isComboComplete(form) {
    const rules = COMBO_RULES[form.id];
    if (!rules) return false;

    // Check all top parts are selected
    for (const name of rules.top) {
      const sel = form.querySelector(`[name="${name}"]`);
      if (!sel || sel.value === "") return false;
    }

    // Bottom: ratchet must be picked (real ratchet OR "No Ratchet" sentinel), and bit must be picked.
    const rSel = form.querySelector('[name="ratchet"]');
    const bSel = form.querySelector('[name="bit"]');
    if (!bSel || bSel.value === "") return false;
    if (!rSel || rSel.value === "") return false;
    return true;
  }

  function updateCalcBtn(form) {
    const btn = form.querySelector(".calc-btn");
    if (!btn) return;
    btn.disabled = !isComboComplete(form);
  }

  document.querySelectorAll(".calc-form").forEach(form => {
    // Disable on init
    const btn = form.querySelector(".calc-btn");
    if (btn) btn.disabled = true;

    // Listen to all selects in the form
    form.querySelectorAll("select").forEach(sel => {
      sel.addEventListener("change", () => updateCalcBtn(form));
    });
  });

  // Re-disable after reset
  document.querySelectorAll(".btn-reset").forEach(btn => {
    const form = btn.closest("form");
    if (form) {
      btn.addEventListener("click", () => {
        requestAnimationFrame(() => updateCalcBtn(form));
      });
    }
  });

  // Re-enable after lucky/random fills all fields
  window._updateCalcBtn = updateCalcBtn;
})();

// --- I'm Feeling Lucky ---
function isExclusive(item) { return !!(item && item.exclusive === true); }

function nonExclusiveIndices(arr) {
  const idxs = [];
  arr.forEach((item, i) => { if (!isExclusive(item)) idxs.push(i); });
  return idxs.length > 0 ? idxs : arr.map((_, i) => i);
}

function randIdx(arr) {
  const idxs = nonExclusiveIndices(arr);
  return idxs[Math.floor(Math.random() * idxs.length)];
}

function getModeWeight(item) {
  if (item.modes && item.modes.length > 0) {
    const mode = item.modes[item.currentMode || 0];
    if (mode && mode.weight != null) return mode.weight;
  }
  return item.weight || 0;
}

function heaviestIdx(arr) {
  let max = -1, idx = 0, found = false;
  arr.forEach((item, i) => {
    if (isExclusive(item)) return;
    const w = getModeWeight(item);
    if (!found || w > max) { max = w; idx = i; found = true; }
  });
  return idx;
}

function lightestIdx(arr) {
  let min = Infinity, idx = 0, found = false;
  arr.forEach((item, i) => {
    if (isExclusive(item)) return;
    const w = getModeWeight(item) || Infinity;
    if (!found || w < min) { min = w; idx = i; found = true; }
  });
  return idx;
}

function getModeStat(item, key) {
  if (item.modes && item.modes.length > 0) {
    const mode = item.modes[item.currentMode || 0];
    if (mode && mode[key] != null) return mode[key];
  }
  return item[key] || 0;
}

function highestStatIdx(arr, key) {
  let max = -Infinity, idx = 0, found = false;
  arr.forEach((item, i) => {
    if (isExclusive(item)) return;
    const v = getModeStat(item, key);
    if (!found || v > max) { max = v; idx = i; found = true; }
  });
  return idx;
}

function getWrapper(form, name) { return form.querySelector(`[name="${name}"]`).nextElementSibling; }

// --- Settings ---
function initSettingDropdown(id, storageKey, defaultVal, onChange) {
  const dropdown = document.getElementById(id);
  const btn = dropdown.querySelector(".setting-dropdown-btn");
  const menu = dropdown.querySelector(".setting-dropdown-menu");
  const text = dropdown.querySelector(".setting-dropdown-text");
  const options = dropdown.querySelectorAll(".setting-dropdown-option");

  let value = localStorage.getItem(storageKey) || defaultVal;

  // Init from saved value
  btn.dataset.value = value;
  const saved = dropdown.querySelector(`.setting-dropdown-option[data-value="${value}"]`);
  if (saved) {
    text.textContent = saved.textContent;
    options.forEach(o => o.classList.remove("active"));
    saved.classList.add("active");
  }

  let sized = false;
  btn.addEventListener("click", () => {
    menu.classList.toggle("hidden");
    if (!sized && !menu.classList.contains("hidden") && options.length > 4) {
      const h = options[0].getBoundingClientRect().height;
      if (h > 0) menu.style.maxHeight = (h * 4) + "px";
      sized = true;
    }
  });

  options.forEach(option => {
    option.addEventListener("click", () => {
      value = option.dataset.value;
      btn.dataset.value = value;
      text.textContent = option.textContent;
      options.forEach(o => o.classList.remove("active"));
      option.classList.add("active");
      menu.classList.add("hidden");
      localStorage.setItem(storageKey, value);
      onChange(value);
    });
  });

  document.addEventListener("click", (e) => {
    if (!dropdown.contains(e.target)) menu.classList.add("hidden");
  });

  onChange(value);
  return () => value;
}

// Theme setting
initSettingDropdown("setting-theme", "theme", "dark", (val) => {
  document.body.classList.remove("light-mode", "space-mode", "tropical-mode", "stormy-mode", "mono-mode");
  if (val === "light") document.body.classList.add("light-mode");
  if (val === "space") document.body.classList.add("space-mode");
  if (val === "tropical") document.body.classList.add("tropical-mode");
  if (val === "stormy") document.body.classList.add("stormy-mode");
  if (val === "mono") document.body.classList.add("mono-mode");
  const titleLogo = document.getElementById("app-title-logo");
  if (titleLogo) {
    const isLightLike = val === "light" || val === "tropical";
    titleLogo.src = "assets/icons/" + (isLightLike ? "XOptimizerLight.webp" : "XOptimizerDark.webp");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = val === "light" ? "#f6f8fa" : val === "space" ? "#0b0d1a" : val === "tropical" ? "#fff6e6" : val === "stormy" ? "#1e2330" : val === "mono" ? "#000000" : "#0a4797";
  document.querySelectorAll('img.footer-logo').forEach(img => {
    img.src = (val === "light" || val === "tropical") ? "assets/icons/revoxNameLight.webp" : "assets/icons/revoxName.webp";
  });
});

// Stat display setting
initSettingDropdown("setting-stat-display", "statDisplay", "bar", (val) => {
  statDisplayMode = val;
});

// Scoreboard mode — always advanced
let scoreboardMode = "advanced";

// Random button mode setting
let randomModeValue;
const getRandomMode = initSettingDropdown("setting-random-mode", "randomMode", "random", (val) => {
  randomModeValue = val;
  updateLuckyButtons();
});

function updateLuckyButtons() {
  document.querySelectorAll(".btn-lucky").forEach(btn => {
    if (randomModeValue === "maxweight") {
      btn.innerHTML = '<img src="assets/icons/heavy.png" alt="Max Weight">';
      btn.setAttribute("aria-label", "Max Weight");
      btn.title = "Max Weight";
    } else if (randomModeValue === "minweight") {
      btn.innerHTML = '<img src="assets/icons/lightweight.png" alt="Min Weight">';
      btn.setAttribute("aria-label", "Min Weight");
      btn.title = "Min Weight";
    } else if (randomModeValue === "comboday") {
      btn.innerHTML = '<img src="assets/icons/calendar.png" alt="1D1C" class="icon-1d1c">';
      btn.setAttribute("aria-label", "1D1C");
      btn.title = "1 Day, 1 Combo";
    } else if (randomModeValue === "meta") {
      btn.innerHTML = '<img src="assets/icons/confrontation.png" alt="Meta" class="icon-meta">';
      btn.setAttribute("aria-label", "Meta Combo");
      btn.title = "Meta Combo";
    } else if (randomModeValue === "maxatk") {
      btn.innerHTML = '<span class="btn-lucky-stat">ATK</span>';
      btn.setAttribute("aria-label", "Max ATK");
      btn.title = "Max ATK Build";
    } else if (randomModeValue === "maxdef") {
      btn.innerHTML = '<span class="btn-lucky-stat">DEF</span>';
      btn.setAttribute("aria-label", "Max DEF");
      btn.title = "Max DEF Build";
    } else if (randomModeValue === "maxsta") {
      btn.innerHTML = '<span class="btn-lucky-stat">STA</span>';
      btn.setAttribute("aria-label", "Max STA");
      btn.title = "Max STA Build";
    } else {
      btn.innerHTML = '<img src="assets/icons/dice.png" alt="Random">';
      btn.setAttribute("aria-label", "Random Combo");
      btn.title = "Random Combo";
    }
  });
}

// ---- Bit-pool helpers for the lucky selectors ----
function bestIdxByPredicate(arr, predicate, scoreFn, compare) {
  // compare(newScore, bestScore) should return true when newScore is preferred
  let bestI = -1, bestS = null;
  arr.forEach((item, i) => {
    if (isExclusive(item)) return;
    if (!predicate(item)) return;
    const s = scoreFn(item);
    if (bestI < 0 || compare(s, bestS)) { bestI = i; bestS = s; }
  });
  return bestI;
}

const isNormalBit = b => !b.isRatchetBit;
const isRBBit = b => !!b.isRatchetBit;

function selectBottomByWeight(form, preferMin) {
  const cmp = preferMin ? ((a, b) => a < b) : ((a, b) => a > b);
  const score = preferMin
    ? (p) => (p.weight == null ? Infinity : p.weight)
    : (p) => (p.weight || 0);

  const bestRatchet = bestIdxByPredicate(DATA.ratchets, () => true, score, cmp);
  const bestRegBit = bestIdxByPredicate(DATA.bits, isNormalBit, score, cmp);
  const bestRBBit = bestIdxByPredicate(DATA.bits, isRBBit, score, cmp);

  const regularTotal = (DATA.ratchets[bestRatchet]?.weight || 0) + (DATA.bits[bestRegBit]?.weight || 0);
  const rbTotal = DATA.bits[bestRBBit]?.weight || 0;

  const pickRB = preferMin
    ? (bestRBBit >= 0 && rbTotal < regularTotal)
    : (bestRBBit >= 0 && rbTotal > regularTotal);

  if (pickRB) {
    getWrapper(form, "ratchet")._select(NO_RATCHET);
    getWrapper(form, "bit")._select(bestRBBit);
  } else {
    if (bestRatchet >= 0) getWrapper(form, "ratchet")._select(bestRatchet);
    if (bestRegBit >= 0) getWrapper(form, "bit")._select(bestRegBit);
  }
}

function selectBottomRegularByWeight(form, preferMin, ratchetFilter) {
  // Picks ratchet + regular bit (excludes ratchet-bit-flagged bits).
  const cmp = preferMin ? ((a, b) => a < b) : ((a, b) => a > b);
  const score = preferMin
    ? (p) => (p.weight == null ? Infinity : p.weight)
    : (p) => (p.weight || 0);
  const bestRatchet = bestIdxByPredicate(DATA.ratchets, ratchetFilter || (() => true), score, cmp);
  const bestRegBit = bestIdxByPredicate(DATA.bits, isNormalBit, score, cmp);
  if (bestRatchet >= 0) getWrapper(form, "ratchet")._select(bestRatchet);
  if (bestRegBit >= 0) getWrapper(form, "bit")._select(bestRegBit);
}

function selectHeaviestRBBit(form) {
  const idx = bestIdxByPredicate(DATA.bits, isRBBit, b => b.weight || 0, (a, b) => a > b);
  if (idx >= 0) {
    getWrapper(form, "ratchet")._select(NO_RATCHET);
    getWrapper(form, "bit")._select(idx);
  }
}

function selectMaxWeight(form, mode) {
  if (mode === "standard") {
    const bladeIdx = heaviestIdx(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      selectHeaviestRBBit(form);
    } else if (codename === "CLOCKMIRAGE") {
      selectBottomRegularByWeight(form, false, r => r.name.endsWith("5"));
    } else {
      selectBottomByWeight(form, false);
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(heaviestIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(heaviestIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(heaviestIdx(DATA.assistBlades));
    selectBottomByWeight(form, false);
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(heaviestIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(heaviestIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(heaviestIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(heaviestIdx(DATA.assistBlades));
    selectBottomByWeight(form, false);
  }
}

function selectMinWeight(form, mode) {
  if (mode === "standard") {
    const bladeIdx = lightestIdx(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      const idx = bestIdxByPredicate(DATA.bits, isRBBit, b => b.weight ?? Infinity, (a, b) => a < b);
      if (idx >= 0) {
        getWrapper(form, "ratchet")._select(NO_RATCHET);
        getWrapper(form, "bit")._select(idx);
      }
    } else if (codename === "CLOCKMIRAGE") {
      selectBottomRegularByWeight(form, true, r => r.name.endsWith("5"));
    } else {
      selectBottomByWeight(form, true);
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(lightestIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(lightestIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(lightestIdx(DATA.assistBlades));
    selectBottomByWeight(form, true);
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(lightestIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(lightestIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(lightestIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(lightestIdx(DATA.assistBlades));
    selectBottomByWeight(form, true);
  }
}

function selectBottomByStat(form, key) {
  const statOf = (item) => getModeStat(item, key);
  const cmp = (a, b) => a > b;

  const bestRatchet = bestIdxByPredicate(DATA.ratchets, () => true, statOf, cmp);
  const bestRegBit = bestIdxByPredicate(DATA.bits, isNormalBit, statOf, cmp);
  const bestRBBit = bestIdxByPredicate(DATA.bits, isRBBit, statOf, cmp);

  const regularTotal = statOf(DATA.ratchets[bestRatchet] || {}) + statOf(DATA.bits[bestRegBit] || {});
  const rbTotal = statOf(DATA.bits[bestRBBit] || {});

  if (bestRBBit >= 0 && rbTotal > regularTotal) {
    getWrapper(form, "ratchet")._select(NO_RATCHET);
    getWrapper(form, "bit")._select(bestRBBit);
  } else {
    if (bestRatchet >= 0) getWrapper(form, "ratchet")._select(bestRatchet);
    if (bestRegBit >= 0) getWrapper(form, "bit")._select(bestRegBit);
  }
}

function selectMaxStat(form, mode, key) {
  const pickIdx = (arr) => highestStatIdx(arr, key);
  const statOf = (item) => getModeStat(item, key);

  if (mode === "standard") {
    const bladeIdx = pickIdx(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      const idx = bestIdxByPredicate(DATA.bits, isRBBit, statOf, (a, b) => a > b);
      if (idx >= 0) {
        getWrapper(form, "ratchet")._select(NO_RATCHET);
        getWrapper(form, "bit")._select(idx);
      }
    } else if (codename === "CLOCKMIRAGE") {
      const bestRatchet = bestIdxByPredicate(DATA.ratchets, r => r.name.endsWith("5"), statOf, (a, b) => a > b);
      const bestRegBit = bestIdxByPredicate(DATA.bits, isNormalBit, statOf, (a, b) => a > b);
      if (bestRatchet >= 0) getWrapper(form, "ratchet")._select(bestRatchet);
      if (bestRegBit >= 0) getWrapper(form, "bit")._select(bestRegBit);
    } else {
      selectBottomByStat(form, key);
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(pickIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(pickIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(pickIdx(DATA.assistBlades));
    selectBottomByStat(form, key);
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(pickIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(pickIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(pickIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(pickIdx(DATA.assistBlades));
    selectBottomByStat(form, key);
  }
}

const selectMaxAtk = (form, mode) => selectMaxStat(form, mode, "atk");
const selectMaxDef = (form, mode) => selectMaxStat(form, mode, "def");
const selectMaxSta = (form, mode) => selectMaxStat(form, mode, "sta");

function randIdxFromPredicate(arr, predicate) {
  const idxs = [];
  arr.forEach((item, i) => { if (!isExclusive(item) && predicate(item)) idxs.push(i); });
  if (idxs.length === 0) return -1;
  return idxs[Math.floor(Math.random() * idxs.length)];
}

function selectRandomBottom(form) {
  // 5% chance to pick a ratchet-bit-flagged bit; otherwise regular ratchet + bit.
  if (Math.random() < 0.05) {
    const rbIdx = randIdxFromPredicate(DATA.bits, isRBBit);
    if (rbIdx >= 0) {
      getWrapper(form, "ratchet")._select(NO_RATCHET);
      getWrapper(form, "bit")._select(rbIdx);
      return;
    }
  }
  getWrapper(form, "ratchet")._select(randIdx(DATA.ratchets));
  const regIdx = randIdxFromPredicate(DATA.bits, isNormalBit);
  if (regIdx >= 0) getWrapper(form, "bit")._select(regIdx);
}

function selectRandom(form, mode) {
  if (mode === "standard") {
    const bladeIdx = randIdx(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      const idx = randIdxFromPredicate(DATA.bits, isRBBit);
      if (idx >= 0) {
        getWrapper(form, "ratchet")._select(NO_RATCHET);
        getWrapper(form, "bit")._select(idx);
      }
    } else if (codename === "CLOCKMIRAGE") {
      const valid = DATA.ratchets.map((r, i) => ({ r, i })).filter(x => x.r.name.endsWith("5"));
      getWrapper(form, "ratchet")._select(valid[Math.floor(Math.random() * valid.length)].i);
      const regIdx = randIdxFromPredicate(DATA.bits, isNormalBit);
      if (regIdx >= 0) getWrapper(form, "bit")._select(regIdx);
    } else {
      selectRandomBottom(form);
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(randIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(randIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(randIdx(DATA.assistBlades));
    selectRandomBottom(form);
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(randIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(randIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(randIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(randIdx(DATA.assistBlades));
    selectRandomBottom(form);
  }
}

// --- Meta (random combo from parts flagged meta:true; falls back to full list) ---
function selectMeta(form, mode) {
  const pickMeta = (arr) => {
    const eligible = arr.filter(p => p && !isExclusive(p));
    const base = eligible.length > 0 ? eligible : arr;
    const metas = base.filter(p => p.meta === true);
    const pool = metas.length > 0 ? metas : base;
    const chosen = pool[Math.floor(Math.random() * pool.length)];
    return arr.indexOf(chosen);
  };

  // Meta bit = prefer meta-flagged *regular* bit (skip ratchet-bit items so ratchet slot is used).
  const pickMetaBit = () => {
    const eligible = DATA.bits.filter(b => !isExclusive(b) && isNormalBit(b));
    const metas = eligible.filter(b => b.meta === true);
    const pool = metas.length > 0 ? metas : eligible;
    if (pool.length === 0) return -1;
    return DATA.bits.indexOf(pool[Math.floor(Math.random() * pool.length)]);
  };

  if (mode === "standard") {
    const bladeIdx = pickMeta(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      const idx = randIdxFromPredicate(DATA.bits, isRBBit);
      if (idx >= 0) {
        getWrapper(form, "ratchet")._select(NO_RATCHET);
        getWrapper(form, "bit")._select(idx);
      }
    } else if (codename === "CLOCKMIRAGE") {
      const validMeta = DATA.ratchets.map((r, i) => ({ r, i })).filter(x => x.r.name.endsWith("5") && x.r.meta === true);
      const validAny = DATA.ratchets.map((r, i) => ({ r, i })).filter(x => x.r.name.endsWith("5"));
      const pool = validMeta.length > 0 ? validMeta : validAny;
      getWrapper(form, "ratchet")._select(pool[Math.floor(Math.random() * pool.length)].i);
      const bIdx = pickMetaBit();
      if (bIdx >= 0) getWrapper(form, "bit")._select(bIdx);
    } else {
      getWrapper(form, "ratchet")._select(pickMeta(DATA.ratchets));
      const bIdx = pickMetaBit();
      if (bIdx >= 0) getWrapper(form, "bit")._select(bIdx);
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(heaviestIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(pickMeta(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(heaviestIdx(DATA.assistBlades));
    getWrapper(form, "ratchet")._select(pickMeta(DATA.ratchets));
    const bIdx = pickMetaBit();
    if (bIdx >= 0) getWrapper(form, "bit")._select(bIdx);
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(heaviestIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(pickMeta(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(heaviestIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(heaviestIdx(DATA.assistBlades));
    getWrapper(form, "ratchet")._select(pickMeta(DATA.ratchets));
    const bIdx = pickMetaBit();
    if (bIdx >= 0) getWrapper(form, "bit")._select(bIdx);
  }
}

// --- Combo of the Day (date-seeded deterministic selection) ---
function dateSeededRng(seed) {
  let h = seed;
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function selectComboOfDay(form, mode) {
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${today.getMonth() + 1}-${today.getDate()}-${mode}`;
  let seed = 0;
  for (let i = 0; i < dateStr.length; i++) seed = ((seed << 5) - seed + dateStr.charCodeAt(i)) | 0;
  const rng = dateSeededRng(seed);
  const pick = (arr) => {
    const idxs = nonExclusiveIndices(arr);
    return idxs[Math.floor(rng() * idxs.length)];
  };
  const pickFromPredicate = (arr, predicate) => {
    const idxs = [];
    arr.forEach((item, i) => { if (!isExclusive(item) && predicate(item)) idxs.push(i); });
    if (idxs.length === 0) return -1;
    return idxs[Math.floor(rng() * idxs.length)];
  };
  const pickBottom = (form) => {
    // 5% chance (seeded) to pick a ratchet-bit bit
    if (rng() < 0.05) {
      const rbIdx = pickFromPredicate(DATA.bits, isRBBit);
      if (rbIdx >= 0) {
        getWrapper(form, "ratchet")._select(NO_RATCHET);
        getWrapper(form, "bit")._select(rbIdx);
        return;
      }
    }
    getWrapper(form, "ratchet")._select(pick(DATA.ratchets));
    const regIdx = pickFromPredicate(DATA.bits, isNormalBit);
    if (regIdx >= 0) getWrapper(form, "bit")._select(regIdx);
  };

  if (mode === "standard") {
    const bladeIdx = pick(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      const idx = pickFromPredicate(DATA.bits, isRBBit);
      if (idx >= 0) {
        getWrapper(form, "ratchet")._select(NO_RATCHET);
        getWrapper(form, "bit")._select(idx);
      }
    } else if (codename === "CLOCKMIRAGE") {
      const valid = DATA.ratchets.map((r, i) => ({ r, i })).filter(x => x.r.name.endsWith("5"));
      getWrapper(form, "ratchet")._select(valid[Math.floor(rng() * valid.length)].i);
      const regIdx = pickFromPredicate(DATA.bits, isNormalBit);
      if (regIdx >= 0) getWrapper(form, "bit")._select(regIdx);
    } else {
      pickBottom(form);
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(pick(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(pick(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(pick(DATA.assistBlades));
    pickBottom(form);
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(pick(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(pick(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(pick(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(pick(DATA.assistBlades));
    pickBottom(form);
  }
}

document.querySelectorAll(".btn-lucky").forEach(btn => {
  btn.addEventListener("click", () => {
    const form = btn.closest("form");
    form.querySelector(".btn-reset").click();
    const mode = form.id.replace("form-", "");

    if (randomModeValue === "maxweight") {
      selectMaxWeight(form, mode);
    } else if (randomModeValue === "minweight") {
      selectMinWeight(form, mode);
    } else if (randomModeValue === "comboday") {
      selectComboOfDay(form, mode);
    } else if (randomModeValue === "meta") {
      selectMeta(form, mode);
    } else if (randomModeValue === "maxatk") {
      selectMaxAtk(form, mode);
    } else if (randomModeValue === "maxdef") {
      selectMaxDef(form, mode);
    } else if (randomModeValue === "maxsta") {
      selectMaxSta(form, mode);
    } else {
      selectRandom(form, mode);
    }

    form.requestSubmit();
  });
});

// --- Update popup ---
(function () {
  const popup = document.getElementById("update-popup");
  if (!popup) return;

  popup.classList.remove("hidden");
  const dismiss = () => {
    popup.classList.add("hidden");
    scoreboardEnabled = true;
  };
  popup.querySelector(".popup-ok").addEventListener("click", dismiss);
})();

function initLibrarySearch() {
  const input = document.getElementById("library-search");
  const results = document.getElementById("library-results");

  if (!input || !results) {
    console.error("Library elements missing");
    return;
  }

  // =========================
  // DATA MERGE
  // =========================
  const ALL_PARTS = [
    ...(DATA.blades || []),
    ...(DATA.mainBlades || []),
    ...(DATA.metalBlades || []),
    ...(DATA.overBlades || []),
    ...(DATA.assistBlades || []),
    ...(DATA.ratchets || []),
    ...(DATA.bits || []),
    ...(DATA.lockChips || [])
  ].filter(i => i && typeof i.name === "string");

  // =========================
  // SAFE INDEX MAP
  // =========================
  function getIndex(item) {
    return ALL_PARTS.findIndex(p =>
      (p.codename || p.name) === (item.codename || item.name)
    );
  }

  // =========================
  // FOLDER DETECTION
  // =========================
  function getFolder(item) {
    const name = item.name;
    if (item._folder) return item._folder;

    if (DATA.blades?.some(i => i.name === name)) return "blades";
    if (DATA.lockChips?.some(i => i.name === name)) return "lockChips";
    if (DATA.bits?.some(i => i.name === name && i.isRatchetBit)) return "ratchetBits";
    if (DATA.bits?.some(i => i.name === name)) return "bits";
    if (DATA.ratchets?.some(i => i.name === name)) return "ratchets";
    if (DATA.mainBlades?.some(i => i.name === name)) return "mainBlades";
    if (DATA.assistBlades?.some(i => i.name === name)) return "assistBlades";
    if (DATA.metalBlades?.some(i => i.name === name)) return "metalBlades";
    if (DATA.overBlades?.some(i => i.name === name)) return "overBlades";

    return "misc";
  }

  function hasModes(item) {
    return Array.isArray(item.modes) && item.modes.length > 0;
  }

  // =========================
  // IMAGE BUILDER
  // =========================
  function normalize(str) {
    return (str || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(/-/g, "");
  }

  function getImage(item, index = 0) {
    const folder = getFolder(item);

    const base = normalize(item.name);

    const fileName = hasModes(item)
      ? `${base}${index}.webp`
      : `${base}.webp`;

    return `assets/${folder}/${fileName}`;
  }

  // =========================
  // STATS (UPDATED)
  // =========================
  function renderStats(obj) {
    if (!obj) return "";

    let html = "";
    const EXCLUDE_KEYS = ["name", "meta", "exclusive"];

    Object.entries(obj).forEach(([k, v]) => {
      if (EXCLUDE_KEYS.includes(k.toLowerCase())) return;
      if (v === undefined || v === null) return;

      const key = k.toLowerCase();

      // ================= COLOR =================
      if (key === "color") {
        const colors = Array.isArray(v) ? v : [v];

        html += `
          <div class="stat-line">
            <b>COLOR:</b>
            <span class="color-box-group">
              ${colors.map(c => {
          const fill = c?.[0] || "transparent";
          const dot = c?.[1] || "#ffffff";
          const border = c?.[2] || "transparent";

          return `
                  <span class="color-box"
                    style="background:${fill}; border:2px solid ${border}; transform: translateY(2px);">
                    <span class="color-dot" style="background:${dot};"></span>
                  </span>
                `;
        }).join("")}
            </span>
          </div>
        `;
        return;
      }

      // ================= TBA LOGIC =================
      if (["atk", "def", "sta"].includes(key)) {
        const num = Number(v);
        v = num === 0 ? "TBA" : v;
      }

      if (key === "height") {
        const num = Number(v);
        v = num === 0 ? "TBA" : `${(num / 10).toFixed(1)} mm`;
      }

      // ================= WEIGHT =================
      if (key === "weight") {
        v = v === 0 ? "TBA" : `${v} g`;
      }

      html += `
        <div class="stat-line">
          <b>${k.toUpperCase()}:</b> ${v}
        </div>
      `;
    });

    return html;
  }

  // =========================
  // FORMAT ITEM
  // =========================
  function formatItem(item) {
    const hasM = hasModes(item);

    const globalIndex = getIndex(item);
    const index = item.currentMode ?? 0;

    const safeIndex = Math.min(index, hasM ? item.modes.length - 1 : 0);
    const mode = hasM ? item.modes[safeIndex] : item;

    return `
      <div class="stat-card mode-card"
        data-index="${globalIndex}"
        data-mode-index="${safeIndex}">
        
        <img src="${getImage(item, safeIndex)}" class="part-img"/>

        <div class="stat-info">
          <strong>${item.name}</strong>

          <div class="full-data">
            ${renderStats(mode)}
          </div>

          ${hasM ? `
            <div class="mode-counter">
              ${safeIndex + 1} / ${item.modes.length}
            </div>
          ` : ""}
        </div>
      </div>
    `;
  }

  // =========================
  // SORT STATE
  // =========================
  const sortBar = document.getElementById("library-sort");
  let currentSort = "atk";
  let currentDir = "desc";

  function getStatValue(item, key) {
    const mode = hasModes(item) ? item.modes[item.currentMode ?? 0] : item;
    const val = mode[key];
    if (val === undefined || val === null || val === "TBA") return -1;
    return Number(val) || 0;
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      let cmp;
      cmp = getStatValue(b, currentSort) - getStatValue(a, currentSort);
      return currentDir === "desc" ? -cmp : cmp;
    });
  }

  function updateSortButtons() {
    sortBar.querySelectorAll(".sort-btn").forEach(btn => {
      const key = btn.dataset.sort;
      if (key === currentSort) {
        btn.classList.add("active");
        const arrow = currentDir === "asc" ? " \u25B2" : " \u25BC";
        btn.textContent = btn.dataset.sort.charAt(0).toUpperCase() + btn.dataset.sort.slice(1) + arrow;
        if (key === "atk" || key === "def" || key === "sta") btn.textContent = key.toUpperCase() + arrow;
      } else {
        btn.classList.remove("active");
        const label = key === "atk" || key === "def" || key === "sta" ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
        btn.textContent = label;
      }
    });
  }

  sortBar.addEventListener("click", (e) => {
    const btn = e.target.closest(".sort-btn");
    if (!btn) return;

    const key = btn.dataset.sort;
    if (key === currentSort) {
      currentDir = currentDir === "asc" ? "desc" : "asc";
    } else {
      currentSort = key;
      currentDir = "desc";
    }

    updateSortButtons();
    runSearch();
  });

  // =========================
  // SEARCH
  // =========================
  function runSearch() {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = "";

    if (!q) {
      sortBar.classList.add("hidden");
      return;
    }

    let filtered = [];
    let isGetAll = false;

    if (q.startsWith("@")) {
      switch (q) {
        case "@getallbits": filtered = DATA.bits || []; break;
        case "@getallratchets": filtered = DATA.ratchets || []; break;
        case "@getallblades": filtered = DATA.blades || []; break;
        case "@getallratchetbits": filtered = DATA.ratchetBits || []; break;
        case "@getallassistblades": filtered = DATA.assistBlades || []; break;
        case "@getallmainblades": filtered = DATA.mainBlades || []; break;
        case "@getallmetalblades": filtered = DATA.metalBlades || []; break;
        case "@getalloverblades": filtered = DATA.overBlades || []; break;
        case "@getalllockchips": filtered = DATA.lockChips || []; break;
        default:
          sortBar.classList.add("hidden");
          results.innerHTML = `<div class="search-item">Unknown command</div>`;
          return;
      }
      isGetAll = true;
    } else {
      filtered = ALL_PARTS.filter(p =>
        p?.name?.toLowerCase().includes(q)
      );
    }

    if (isGetAll && filtered.length > 0) {
      sortBar.classList.remove("hidden");

      const hasHeight = filtered.some(p => p && p.height != null && p.height !== 0);
      const heightBtn = sortBar.querySelector('[data-sort="height"]');
      if (heightBtn) {
        heightBtn.style.display = hasHeight ? "" : "none";
        if (!hasHeight && currentSort === "height") {
          currentSort = "atk";
          currentDir = "desc";
          updateSortButtons();
        }
      }
    } else {
      sortBar.classList.add("hidden");
    }

    sortItems(filtered).slice(0, 100).forEach(item => {
      const div = document.createElement("div");
      div.className = "search-item";
      div.innerHTML = formatItem(item);
      results.appendChild(div);
    });
  }

  // =========================
  // MODE SWITCH
  // =========================
  results.addEventListener("click", (e) => {
    if (e.target.closest(".part-img")) return;

    const card = e.target.closest(".mode-card");
    if (!card) return;

    const index = Number(card.dataset.index);
    const item = ALL_PARTS[index];

    if (!item?.modes) return;

    let modeIndex = Number(card.dataset.modeIndex || 0);
    modeIndex = (modeIndex + 1) % item.modes.length;

    card.dataset.modeIndex = modeIndex;

    card.querySelector(".full-data").innerHTML =
      renderStats(item.modes[modeIndex]);

    const counter = card.querySelector(".mode-counter");
    if (counter) counter.textContent = `${modeIndex + 1} / ${item.modes.length}`;

    const img = card.querySelector("img");
    if (img) img.src = getImage(item, modeIndex);
  });

  // =========================
  // IMAGE POPUP
  // =========================
  const imagePopup = document.getElementById("image-popup");
  const imagePopupImg = document.getElementById("image-popup-img");
  const imagePopupName = document.getElementById("image-popup-name");

  function openImagePopup(src, name) {
    imagePopupImg.src = src;
    imagePopupName.textContent = name || "";
    imagePopup.classList.remove("hidden");
  }

  function closeImagePopup() {
    imagePopup.classList.add("hidden");
    imagePopupImg.src = "";
  }

  imagePopup.querySelector(".image-popup-backdrop").addEventListener("click", closeImagePopup);
  imagePopup.querySelector(".image-popup-close").addEventListener("click", closeImagePopup);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !imagePopup.classList.contains("hidden")) closeImagePopup();
  });

  results.addEventListener("click", (e) => {
    const img = e.target.closest(".part-img");
    if (!img) return;

    e.stopPropagation();

    const card = img.closest(".mode-card");
    const name = card ? card.querySelector("strong")?.textContent || "" : "";
    openImagePopup(img.src, name);
  });

  document.getElementById("result")?.addEventListener("click", (e) => {
    const img = e.target.closest(".result-part-img");
    if (!img) return;

    e.stopPropagation();

    const part = img.closest(".result-part");
    const name = part ? part.querySelector(".result-part-name")?.textContent || "" : "";
    openImagePopup(img.src, name);
  });

  document.getElementById("history-list")?.addEventListener("click", (e) => {
    const img = e.target.closest(".result-part-img");
    if (!img) return;

    e.stopPropagation();

    const part = img.closest(".result-part");
    const name = part ? part.querySelector(".result-part-name")?.textContent || "" : "";
    openImagePopup(img.src, name);
  });

  document.getElementById("deck-list")?.addEventListener("click", (e) => {
    const img = e.target.closest(".result-part-img");
    if (!img) return;

    e.stopPropagation();

    const part = img.closest(".result-part");
    const name = part ? part.querySelector(".result-part-name")?.textContent || "" : "";
    openImagePopup(img.src, name);
  });

  // =========================
  // EVENTS
  // =========================
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  });

  input.addEventListener("input", runSearch);
}

document.addEventListener("DOMContentLoaded", initLibrarySearch);

const help = document.getElementById("library-help");

help.addEventListener("click", () => {
  alert(`Search Commands:

@getallblades
@getallbits
@getallratchets
@getallratchetbits
@getallassistblades
@getallmainblades
@getallmetalblades
@getalloverblades
@getalllockchips`);
});

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

function saveHistory(mode, comboData) {
  const key = "beyblade_history";

  let history = JSON.parse(localStorage.getItem(key)) || [];

  history.unshift({
    mode,
    time: new Date().toISOString(),
    data: comboData
  });

  // keep only last 3 total
  history = history.slice(0, 3);

  localStorage.setItem(key, JSON.stringify(history));
}

const DECK_KEY = "beyblade_deck";
const DECK_NAME_KEY = "beyblade_deck_name";
const DECK_SIZE = 3;

function loadDeckName() {
  return localStorage.getItem(DECK_NAME_KEY) || "";
}

function saveDeckName(name) {
  localStorage.setItem(DECK_NAME_KEY, name || "");
}

function loadDeck() {
  let deck = JSON.parse(localStorage.getItem(DECK_KEY) || "null");
  if (!Array.isArray(deck)) deck = [null, null, null];
  while (deck.length < DECK_SIZE) deck.push(null);
  return deck.slice(0, DECK_SIZE);
}

function persistDeck(deck) {
  localStorage.setItem(DECK_KEY, JSON.stringify(deck));
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

function renderDeck() {
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
  const deck = loadDeck();
  const hasName = (loadDeckName() || "").trim().length > 0;
  if (deck.every(s => s == null) && !hasName) return;
  if (!confirm("Clear all deck slots and deck name?")) return;
  persistDeck([null, null, null]);
  saveDeckName("");
  const nameInput = document.getElementById("deck-name");
  if (nameInput) nameInput.value = "";
  renderDeck();
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

// ================= SWISS LIVE SYNC (Firebase Realtime DB) =================
// When a host generates groups, TWO room codes are created:
//   - co-host code: view + edit (mirrors state at `swissRooms/{coHostCode}`)
//   - participant code: view only (mapped via `swissViewCodes/{viewCode}` -> coHostCode)
// The room state lives at `swissRooms/{coHostCode}` with `viewCode` as metadata.
// Anyone who enters the co-host code can score; anyone who enters the
// participant code can only watch. The host (device that created the room)
// additionally has authority to reset (wipes remote).
const SWISS_ROOM_STORAGE = "beyblade_swiss_room";       // current joined room info (JSON)
const SWISS_HOST_STORAGE = "beyblade_swiss_host_rooms"; // edit codes this device hosts

let swissDb = null;
let swissEditCode = null;    // co-host code (primary room key)
let swissViewCode = null;    // participant code
let swissIsHost = false;     // created this room (has reset authority)
let swissCanEdit = false;    // joined via co-host code (or is host) — can score
let swissRoomRef = null;
let swissApplyingRemote = false;
let swissLiveMatchId = null; // which match (if any) this device is currently live on

function initFirebase() {
  if (swissDb) return swissDb;
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || !cfg.databaseURL) return null;
  if (typeof firebase === "undefined") return null;
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    swissDb = firebase.database();
    return swissDb;
  } catch (e) {
    console.warn("Firebase init failed:", e);
    return null;
  }
}

function firebaseReady() {
  return !!initFirebase();
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/1/O/I/L
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function loadHostedRooms() {
  try { return JSON.parse(localStorage.getItem(SWISS_HOST_STORAGE)) || []; } catch (e) { return []; }
}
function markRoomHosted(code) {
  const rooms = loadHostedRooms();
  if (!rooms.includes(code)) {
    rooms.push(code);
    localStorage.setItem(SWISS_HOST_STORAGE, JSON.stringify(rooms));
  }
}
function isRoomHosted(code) {
  return loadHostedRooms().includes(code);
}

function saveJoinedRoom(info) {
  if (info) localStorage.setItem(SWISS_ROOM_STORAGE, JSON.stringify(info));
  else localStorage.removeItem(SWISS_ROOM_STORAGE);
}
function loadJoinedRoom() {
  try {
    const raw = localStorage.getItem(SWISS_ROOM_STORAGE);
    if (!raw) return null;
    // Back-compat: earlier versions stored just the string code.
    if (raw[0] !== "{") return { editCode: raw, viewCode: null, role: "edit" };
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function disconnectSwissRoom() {
  if (swissRoomRef) {
    try { swissRoomRef.off(); } catch (e) {}
  }
  swissRoomRef = null;
  swissEditCode = null;
  swissViewCode = null;
  swissIsHost = false;
  swissCanEdit = false;
  swissLiveMatchId = null;
  saveJoinedRoom(null);
  // Drop any match-linked state on the scoreboard so leaving a room doesn't
  // leave stale match names / score / save callback on the overlay.
  if (typeof window.resetScoreboardToDefault === "function") {
    window.resetScoreboardToDefault();
  }
}

// Strip metadata fields (viewCode) before persisting remote state locally —
// they aren't part of the tournament model and shouldn't land in loadSwiss.
function stripRoomMetadata(remote) {
  if (!remote) return remote;
  const { viewCode, ...state } = remote;
  return state;
}

function resolveRoomCode(code, cb) {
  const db = initFirebase();
  if (!db) { cb({ ok: false, reason: "Live sync isn't configured on this build." }); return; }
  db.ref("swissRooms/" + code).once("value").then(editSnap => {
    const remote = editSnap.val();
    if (remote && remote.groups) {
      cb({ ok: true, editCode: code, viewCode: remote.viewCode || null, role: "edit" });
      return null;
    }
    return db.ref("swissViewCodes/" + code).once("value").then(viewSnap => {
      const mappedEdit = viewSnap.val();
      if (typeof mappedEdit === "string" && mappedEdit) {
        cb({ ok: true, editCode: mappedEdit, viewCode: code, role: "view" });
      } else {
        cb({ ok: false, reason: "Room not found. Double-check the code." });
      }
    });
  }).catch(err => {
    console.warn("Room lookup failed:", err);
    cb({ ok: false, reason: "Couldn't look up room. Check your connection." });
  });
}

function connectSwissRoom(editCode, viewCode, asHost, canEdit) {
  const db = initFirebase();
  if (!db) return { ok: false, reason: "Firebase not configured" };
  if (swissRoomRef) {
    try { swissRoomRef.off(); } catch (e) {}
  }
  swissEditCode = editCode;
  swissViewCode = viewCode || null;
  swissIsHost = !!asHost;
  swissCanEdit = !!canEdit;
  swissRoomRef = db.ref("swissRooms/" + editCode);
  swissRoomRef.on("value", snap => {
    const remote = snap.val();
    if (remote && remote.groups) {
      if (remote.viewCode && !swissViewCode) swissViewCode = remote.viewCode;
      swissApplyingRemote = true;
      localStorage.setItem(SWISS_KEY, JSON.stringify(stripRoomMetadata(remote)));
      swissApplyingRemote = false;
      renderSwiss();
    } else if (!remote && swissIsHost) {
      // Room was wiped remotely (or first-time creation). Push our local state
      // together with the viewCode metadata and publish the viewer mapping.
      const local = loadSwiss();
      if (local.groups && swissViewCode) {
        swissApplyingRemote = true;
        const payload = { ...local, viewCode: swissViewCode };
        swissRoomRef.set(payload)
          .then(() => db.ref("swissViewCodes/" + swissViewCode).set(editCode))
          .catch(e => console.warn("Initial room push failed:", e))
          .finally(() => { swissApplyingRemote = false; });
      }
    } else if (!remote && !swissIsHost) {
      // Non-host: room was wiped (or doesn't exist yet). Clear local view so
      // we don't keep showing stale groups after a host reset.
      swissApplyingRemote = true;
      localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
      swissApplyingRemote = false;
      renderSwiss();
    }
  }, err => {
    console.warn("Swiss room listen error:", err);
  });
  saveJoinedRoom({ editCode, viewCode: swissViewCode, role: canEdit ? "edit" : "view" });
  return { ok: true };
}

// Targeted update for a single score save (optionally with new matches +
// updated round counter if completing the round generated the next one).
// Using .update() with leaf paths lets two refs score different matches
// concurrently without overwriting each other's work.
function pushSwissMatchUpdate(matchId, match, state, newMatchIds) {
  if (swissApplyingRemote) return;
  if (!swissRoomRef || !swissCanEdit) return;
  const updates = {
    [`matches/${matchId}/scoreA`]: match.scoreA,
    [`matches/${matchId}/scoreB`]: match.scoreB,
    [`matches/${matchId}/startedAt`]: null
  };
  if (newMatchIds && newMatchIds.length) {
    newMatchIds.forEach(id => {
      updates[`matches/${id}`] = state.matches[id];
    });
    updates[`groupRounds/${match.groupIndex}`] = state.groupRounds[match.groupIndex];
  }
  swissRoomRef.update(updates).catch(e => console.warn("Swiss match push failed:", e));
}

// Small push for just the "match is being scored" flag so other refs see
// the in-progress state the moment someone opens the scoreboard.
function pushSwissMatchStart(matchId, startedAt) {
  if (swissApplyingRemote) return;
  if (!swissRoomRef || !swissCanEdit) return;
  swissRoomRef.child(`matches/${matchId}/startedAt`).set(startedAt)
    .catch(e => console.warn("Swiss start push failed:", e));
}

function initSwissRoomOnLoad() {
  const info = loadJoinedRoom();
  if (!info || !info.editCode) return;
  if (!firebaseReady()) return;
  const asHost = isRoomHosted(info.editCode);
  const canEdit = asHost || info.role === "edit";
  connectSwissRoom(info.editCode, info.viewCode || null, asHost, canEdit);
}

// ================= SWISS TOURNAMENT =================
// 4 groups, 4 rounds per group. Each round pairs group members using Swiss rules
// (by current wins, avoiding rematches). Odd-count groups push one BYE per round
// (counts as a win) and rotate which member receives it.
const SWISS_KEY = "beyblade_swiss";
const SWISS_GROUP_COUNT = 4;
const SWISS_ROUND_COUNT = 4;
const SWISS_MIN_PER_GROUP = 2; // minimum so every group can run at least one match per round

function loadSwiss() {
  try {
    const raw = JSON.parse(localStorage.getItem(SWISS_KEY) || "null");
    if (raw && Array.isArray(raw.groups)) {
      if (!raw.matches) raw.matches = {};
      // Migrate legacy global `roundsGenerated` into the per-group array.
      if (!Array.isArray(raw.groupRounds)) {
        const fill = typeof raw.roundsGenerated === "number" ? raw.roundsGenerated : 0;
        raw.groupRounds = raw.groups.map(() => fill);
      }
      return raw;
    }
  } catch (e) {}
  return { groups: null, matches: {}, groupRounds: [] };
}

function persistSwiss(state) {
  localStorage.setItem(SWISS_KEY, JSON.stringify(state));
  // Remote sync is handled by explicit callers (pushSwissMatchUpdate /
  // full-state .set for initial room creation and reset) so concurrent
  // writes from multiple refs don't clobber each other.
}

function shuffleArray(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function playedPairs(matches, groupIndex) {
  const set = new Set();
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (!m.b) return;
    set.add(pairKey(m.a, m.b));
  });
  return set;
}

function previousByeReceivers(matches, groupIndex) {
  const set = new Set();
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (m.bye && m.a) set.add(m.a);
  });
  return set;
}

function pairSwissRound(members, matches, groupIndex, round) {
  // members: ordered (round 1 = shuffled; round 2+ = standings-sorted)
  const played = playedPairs(matches, groupIndex);
  const queue = members.slice();
  const pairs = [];

  if (queue.length % 2 === 1) {
    // Give the BYE to the lowest-ranked member who hasn't had one yet.
    const prevByes = previousByeReceivers(matches, groupIndex);
    let byeIdx = -1;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!prevByes.has(queue[i])) { byeIdx = i; break; }
    }
    if (byeIdx === -1) byeIdx = queue.length - 1;
    const byeMember = queue.splice(byeIdx, 1)[0];
    pairs.push({ a: byeMember, b: null, bye: true });
  }

  while (queue.length >= 2) {
    const a = queue.shift();
    let partnerIdx = -1;
    for (let i = 0; i < queue.length; i++) {
      if (!played.has(pairKey(a, queue[i]))) { partnerIdx = i; break; }
    }
    if (partnerIdx === -1) partnerIdx = 0; // fallback: rematch rather than strand
    const b = queue.splice(partnerIdx, 1)[0];
    pairs.push({ a, b, bye: false });
  }

  return pairs.map((p, i) => ({
    id: `g${groupIndex}-r${round}-m${i}`,
    groupIndex,
    round,
    a: p.a,
    b: p.b,
    scoreA: null,
    scoreB: null,
    bye: p.bye
  }));
}

function appendGroupRound(state, groupIndex) {
  const members = state.groups[groupIndex];
  const roundIndex = state.groupRounds[groupIndex] || 0;
  if (roundIndex >= SWISS_ROUND_COUNT) return false;
  const ordered = roundIndex === 0
    ? shuffleArray(members)
    : computeStandings(members, state.matches, groupIndex).map(r => r.name);
  const matchObjs = pairSwissRound(ordered, state.matches, groupIndex, roundIndex);
  matchObjs.forEach(m => { state.matches[m.id] = m; });
  state.groupRounds[groupIndex] = roundIndex + 1;
  return true;
}

function generateSwissFromText(text) {
  const names = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  names.forEach(n => { if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); unique.push(n); } });

  const minTotal = SWISS_GROUP_COUNT * SWISS_MIN_PER_GROUP;
  if (unique.length < minTotal) {
    alert(`Need at least ${minTotal} participants (${SWISS_MIN_PER_GROUP} per group × ${SWISS_GROUP_COUNT} groups).`);
    return null;
  }

  const shuffled = shuffleArray(unique);
  const groups = Array.from({ length: SWISS_GROUP_COUNT }, () => []);
  shuffled.forEach((name, i) => { groups[i % SWISS_GROUP_COUNT].push(name); });

  const state = { groups, matches: {}, groupRounds: groups.map(() => 0) };
  groups.forEach((_, gi) => appendGroupRound(state, gi));
  return state;
}

function isGroupRoundComplete(matches, groupIndex, roundIndex) {
  const roundMatches = Object.values(matches).filter(m => m.groupIndex === groupIndex && m.round === roundIndex);
  if (roundMatches.length === 0) return false;
  return roundMatches.every(m => m.bye || (m.scoreA != null && m.scoreB != null));
}

function resetSwiss() {
  const state = loadSwiss();
  const hasAny = state.groups || Object.keys(state.matches || {}).length > 0;
  const inRoom = !!swissEditCode;
  const promptMsg = inRoom && !swissIsHost
    ? "Leave this live room?"
    : "Clear participants, groups, and all match scores?";
  if ((hasAny || inRoom) && !confirm(promptMsg)) return;
  // Host wipes the remote room (including the viewer-code mapping) so every
  // joined device clears too. Non-hosts just disconnect locally.
  if (inRoom && swissIsHost && swissRoomRef) {
    try {
      swissRoomRef.set(null);
      if (swissViewCode && swissDb) swissDb.ref("swissViewCodes/" + swissViewCode).set(null);
    } catch (e) {}
  }
  disconnectSwissRoom();
  // Bypass push-on-persist by writing directly.
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
  const textarea = document.getElementById("swiss-names");
  if (textarea) textarea.value = "";
  const joinInput = document.getElementById("swiss-join-code");
  if (joinInput) joinInput.value = "";
  const joinStatus = document.getElementById("swiss-join-status");
  if (joinStatus) joinStatus.textContent = "";
  renderSwiss();
}

function startSwissMatch(matchId) {
  // Participants (joined via view-only code) can't score — never open the
  // match scoreboard for them, even if something bypasses the UI gating.
  if (swissEditCode && !swissCanEdit) return;
  const state = loadSwiss();
  const match = state.matches[matchId];
  if (!match) return;
  if (match.bye) {
    alert(`${match.a} has a BYE this round.`);
    return;
  }

  // One live match per device. If we're already live on a different match,
  // block and tell the user to switch that one off first.
  if (swissLiveMatchId && swissLiveMatchId !== matchId) {
    alert("You're already live on another match. Tap that card to switch it off first.");
    return;
  }

  const isEdit = match.scoreA != null && match.scoreB != null;

  // Tapping the same unscored match we went live on toggles live OFF:
  // clears the in-progress flag, resets the scoreboard to default. Any
  // scores entered but not saved are discarded.
  if (!isEdit && swissLiveMatchId === matchId) {
    swissLiveMatchId = null;
    const s = loadSwiss();
    if (s.matches[matchId]) {
      s.matches[matchId].startedAt = null;
      persistSwiss(s);
      pushSwissMatchStart(matchId, null);
    }
    if (typeof window.resetScoreboardToDefault === "function") {
      window.resetScoreboardToDefault();
    }
    renderSwiss();
    return;
  }

  // Going live ON an unscored match — mark startedAt and claim the device
  // slot. Edits don't flip live (the card shows the score, not a badge).
  if (!isEdit) {
    swissLiveMatchId = matchId;
    const now = Date.now();
    const s = loadSwiss();
    if (s.matches[matchId]) {
      s.matches[matchId].startedAt = now;
      persistSwiss(s);
      pushSwissMatchStart(matchId, now);
      renderSwiss();
    }
  }

  window.openScoreboard(match.a, match.b, ({ scoreA, scoreB }) => {
    swissLiveMatchId = null;
    const s = loadSwiss();
    const stored = s.matches[matchId];
    if (!stored) return;
    stored.scoreA = scoreA;
    stored.scoreB = scoreB;
    stored.startedAt = null;

    // On a fresh completion, if this finished the latest generated round for
    // the group, auto-generate the next round (up to SWISS_ROUND_COUNT).
    // Skip on edits — the next round already exists and must not be duplicated.
    let newMatchIds = null;
    if (!isEdit) {
      const gi = stored.groupIndex;
      const latestRoundIdx = (s.groupRounds[gi] || 0) - 1;
      if (stored.round === latestRoundIdx && isGroupRoundComplete(s.matches, gi, latestRoundIdx)) {
        if ((s.groupRounds[gi] || 0) < SWISS_ROUND_COUNT) {
          const before = new Set(Object.keys(s.matches));
          appendGroupRound(s, gi);
          newMatchIds = Object.keys(s.matches).filter(k => !before.has(k));
        }
      }
    }

    persistSwiss(s);
    pushSwissMatchUpdate(matchId, stored, s, newMatchIds);
    renderSwiss();
  }, isEdit ? match.scoreA : 0, isEdit ? match.scoreB : 0);
}

let swissGroupViews = {}; // gi -> "matches" | "standings"

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function renderSwissMatchCard(matchNum, id, m, seedA, seedB) {
  const done = m.scoreA != null && m.scoreB != null;
  const live = !done && m.startedAt != null;
  const aWin = done && m.scoreA > m.scoreB;
  const bWin = done && m.scoreB > m.scoreA;
  const aScore = done ? m.scoreA : (live ? "…" : "");
  const bScore = done ? m.scoreB : (live ? "…" : "");

  if (m.bye) {
    return `<div class="swiss-match-wrap">
      <div class="swiss-match-num">${matchNum}</div>
      <div class="swiss-match-card swiss-match-bye">
        <div class="swiss-match-row swiss-match-row-win swiss-match-row-bye">
          <span class="swiss-seed">${seedA}</span>
          <span class="swiss-name-cell">${escapeHtml(m.a)} <span class="swiss-bye-tag">BYE</span></span>
          <span class="swiss-score-cell swiss-score-win">W</span>
        </div>
      </div>
    </div>`;
  }

  const isMine = live && swissLiveMatchId === id;
  const hint = done
    ? "Tap to fix score"
    : isMine
      ? "Tap to switch LIVE off"
      : live
        ? "Match in progress on another device"
        : "Tap to go LIVE on this match";
  const clickable = ` data-match="${id}" role="button" tabindex="0" title="${hint}" aria-label="${hint}"`;
  const liveClass = live
    ? (isMine ? " swiss-match-card-live swiss-match-card-live-mine" : " swiss-match-card-live")
    : "";
  const cardClass = "swiss-match-card swiss-match-card-play" + liveClass;
  const liveBadge = live
    ? `<span class="swiss-live-badge${isMine ? " swiss-live-badge-mine" : ""}" aria-label="Match in progress">LIVE</span>`
    : "";
  return `<div class="swiss-match-wrap">
    <div class="swiss-match-num">${matchNum}${liveBadge}</div>
    <div class="${cardClass}"${clickable}>
      <div class="swiss-match-row ${aWin ? "swiss-match-row-win" : done ? "swiss-match-row-lose" : ""}">
        <span class="swiss-seed">${seedA}</span>
        <span class="swiss-name-cell">${escapeHtml(m.a)}</span>
        <span class="swiss-score-cell ${aWin ? "swiss-score-win" : ""}">${aScore}</span>
      </div>
      <div class="swiss-match-row ${bWin ? "swiss-match-row-win" : done ? "swiss-match-row-lose" : ""}">
        <span class="swiss-seed">${seedB}</span>
        <span class="swiss-name-cell">${escapeHtml(m.b)}</span>
        <span class="swiss-score-cell ${bWin ? "swiss-score-win" : ""}">${bScore}</span>
      </div>
    </div>
  </div>`;
}

function renderSwissGroupMatches(state, gi) {
  const members = state.groups[gi];
  const seedOf = (name) => members.indexOf(name) + 1;

  // Assign stable sequential match numbers within the group (round asc, match index asc).
  const groupMatchEntries = Object.entries(state.matches)
    .filter(([, m]) => m.groupIndex === gi)
    .sort(([a], [b]) => a.localeCompare(b));
  const numberFor = {};
  groupMatchEntries.forEach(([id], i) => { numberFor[id] = i + 1; });

  const roundsGen = state.groupRounds[gi] || 0;
  const rounds = [];
  for (let ri = 0; ri < roundsGen; ri++) {
    const roundMatches = groupMatchEntries.filter(([, m]) => m.round === ri);
    const cards = roundMatches.map(([id, m]) =>
      renderSwissMatchCard(numberFor[id], id, m, seedOf(m.a), m.b ? seedOf(m.b) : "")
    ).join("");
    rounds.push(`<div class="swiss-round-col">
      <div class="swiss-round-title">Round ${ri + 1}</div>
      <div class="swiss-match-list">${cards}</div>
    </div>`);
  }

  if (rounds.length === 0) {
    return `<div class="swiss-empty">No rounds yet.</div>`;
  }

  return `<div class="swiss-rounds-scroll">${rounds.join("")}</div>`;
}

function renderSwissGroupStandings(state, gi) {
  const members = state.groups[gi];
  const standings = computeStandings(members, state.matches, gi);
  const rows = standings.map((row, idx) => {
    const pd = row.pointsDiff > 0 ? `+${row.pointsDiff}` : `${row.pointsDiff}`;
    return `
    <li>
      <span class="swiss-rank">${idx + 1}</span>
      <span class="swiss-name-cell">${escapeHtml(row.name)}</span>
      <span class="swiss-record">${row.wins}W-${row.losses}L-${row.draws}D</span>
      <span class="swiss-tiebreak" title="Points Scored · Points Difference · Median-Buchholz">PS ${row.pointsScored} · PD ${pd} · MB ${row.medianBuchholz}</span>
    </li>
  `;
  }).join("");
  return `<ol class="swiss-members">${rows}</ol>`;
}

function renderSwissRoomBadge() {
  if (!swissEditCode) return "";
  const pills = [];
  // Users who can edit see the Co-host code so they can invite other refs.
  if (swissCanEdit) {
    const label = swissIsHost ? "Host" : "Co-host";
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-edit" title="${label} — tap to copy">
        <span class="swiss-room-role">${label}</span>
        <button type="button" class="swiss-room-code" data-room="${swissEditCode}">${swissEditCode}</button>
      </span>
    `);
  }
  // Everyone sees the participant code so they can invite spectators.
  if (swissViewCode) {
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-view" title="Participant (view only) — tap to copy">
        <span class="swiss-room-role">View</span>
        <button type="button" class="swiss-room-code" data-room="${swissViewCode}">${swissViewCode}</button>
      </span>
    `);
  }
  if (!pills.length) return "";
  return `<div class="swiss-room-badges">${pills.join("")}</div>`;
}

function bindSwissRoomBadge(view) {
  view.querySelectorAll(".swiss-room-code").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.room || "";
      if (!code) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          const prev = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = prev; }, 1200);
        }).catch(() => {});
      }
    });
  });
}

function renderSwiss() {
  const view = document.getElementById("swiss-view");
  const setup = document.getElementById("swiss-setup");
  if (!view || !setup) return;

  const state = loadSwiss();
  const hasGroups = !!state.groups;
  const inRoom = !!swissEditCode;
  const inRoomNonHost = inRoom && !swissIsHost;

  // Hide the setup form once we have a live tournament OR when the user is
  // connected to someone else's room (they shouldn't generate their own).
  setup.classList.toggle("hidden", hasGroups || inRoomNonHost);

  if (!hasGroups) {
    if (inRoomNonHost) {
      view.innerHTML = `
        <div class="swiss-toolbar">
          ${renderSwissRoomBadge()}
          <button type="button" id="swiss-clear" class="btn btn-reset" title="Leave Room">
            <img src="assets/icons/undo.png" alt="Leave"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
          </button>
        </div>
        <div class="swiss-empty">Waiting for host to generate groups…</div>
      `;
      view.querySelector("#swiss-clear")?.addEventListener("click", resetSwiss);
      bindSwissRoomBadge(view);
    } else {
      view.innerHTML = "";
    }
    return;
  }

  const allDone = state.groups.every((_, gi) => (state.groupRounds[gi] || 0) >= SWISS_ROUND_COUNT
    && isGroupRoundComplete(state.matches, gi, SWISS_ROUND_COUNT - 1));

  const groupsHtml = state.groups.map((members, gi) => {
    const mode = swissGroupViews[gi] || "matches";
    const body = mode === "standings"
      ? renderSwissGroupStandings(state, gi)
      : renderSwissGroupMatches(state, gi);
    const roundsGen = state.groupRounds[gi] || 0;

    return `<section class="swiss-group">
      <header class="swiss-group-header">
        <span class="swiss-group-title">Group ${String.fromCharCode(65 + gi)}</span>
        <span class="swiss-group-progress">Round ${roundsGen} / ${SWISS_ROUND_COUNT}</span>
        <div class="swiss-group-tabs">
          <button type="button" class="swiss-group-tab ${mode === "standings" ? "active" : ""}" data-group="${gi}" data-view="standings">Standings</button>
          <button type="button" class="swiss-group-tab ${mode === "matches" ? "active" : ""}" data-group="${gi}" data-view="matches">Matches</button>
        </div>
      </header>
      <div class="swiss-group-body">${body}</div>
    </section>`;
  }).join("");

  const resetTitle = inRoomNonHost ? "Leave Room" : "Reset Swiss";
  view.innerHTML = `
    <div class="swiss-toolbar">
      ${allDone ? `<span class="swiss-complete">Tournament Complete</span>` : ""}
      ${renderSwissRoomBadge()}
      <button type="button" id="swiss-clear" class="btn btn-reset" title="${resetTitle}">
        <img src="assets/icons/undo.png" alt="${resetTitle}"
             onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
      </button>
    </div>
    ${groupsHtml}
  `;

  bindSwissRoomBadge(view);

  // Match cards are interactive only for users who can edit (host + co-host).
  // Participants joined via the view-only code see cards but can't open them.
  const canEdit = !inRoom || swissCanEdit;
  if (canEdit) {
    view.querySelectorAll(".swiss-match-card-play").forEach(el => {
      const id = el.dataset.match;
      if (!id) return;
      el.addEventListener("click", () => startSwissMatch(id));
      el.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startSwissMatch(id); }
      });
    });
  } else {
    view.querySelectorAll(".swiss-match-card-play").forEach(el => {
      el.classList.remove("swiss-match-card-play");
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
      el.removeAttribute("title");
      el.removeAttribute("aria-label");
    });
  }
  view.querySelectorAll(".swiss-group-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const gi = Number(btn.dataset.group);
      swissGroupViews[gi] = btn.dataset.view;
      renderSwiss();
    });
  });
  view.querySelector("#swiss-clear")?.addEventListener("click", resetSwiss);
}

function computeStandings(members, matches, groupIndex) {
  const stats = {};
  members.forEach(n => {
    stats[n] = { name: n, wins: 0, losses: 0, draws: 0, pointsScored: 0, pointsAgainst: 0, opponents: [] };
  });
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (m.bye && m.a && stats[m.a]) { stats[m.a].wins++; return; }
    if (m.scoreA == null || m.scoreB == null) return;
    if (!stats[m.a] || !stats[m.b]) return;
    stats[m.a].pointsScored += m.scoreA;
    stats[m.a].pointsAgainst += m.scoreB;
    stats[m.b].pointsScored += m.scoreB;
    stats[m.b].pointsAgainst += m.scoreA;
    stats[m.a].opponents.push(m.b);
    stats[m.b].opponents.push(m.a);
    if (m.scoreA > m.scoreB) { stats[m.a].wins++; stats[m.b].losses++; }
    else if (m.scoreB > m.scoreA) { stats[m.b].wins++; stats[m.a].losses++; }
    else { stats[m.a].draws++; stats[m.b].draws++; }
  });

  // Tie-breakers: Points Scored, Points Difference, Median-Buchholz
  // (sum of opponents' wins, dropping highest and lowest when >= 3 opponents).
  members.forEach(n => {
    const s = stats[n];
    s.pointsDiff = s.pointsScored - s.pointsAgainst;
    const oppWins = s.opponents.map(o => (stats[o] ? stats[o].wins : 0));
    if (oppWins.length >= 3) {
      oppWins.sort((a, b) => a - b);
      oppWins.shift();
      oppWins.pop();
    }
    s.medianBuchholz = oppWins.reduce((sum, w) => sum + w, 0);
  });

  return members
    .map(n => stats[n])
    .sort((a, b) =>
      (b.wins - a.wins) ||
      (b.pointsScored - a.pointsScored) ||
      (b.pointsDiff - a.pointsDiff) ||
      (b.medianBuchholz - a.medianBuchholz) ||
      a.name.localeCompare(b.name)
    );
}

document.getElementById("swiss-generate")?.addEventListener("click", () => {
  const textarea = document.getElementById("swiss-names");
  if (!textarea) return;
  const next = generateSwissFromText(textarea.value);
  if (!next) return;
  // Write local state first (disconnected), then create a live room if Firebase is available.
  disconnectSwissRoom();
  localStorage.setItem(SWISS_KEY, JSON.stringify(next));
  if (firebaseReady()) {
    // Two codes: edit (co-host) + view (participant). Ensure they differ.
    const editCode = generateRoomCode();
    let viewCode = generateRoomCode();
    while (viewCode === editCode) viewCode = generateRoomCode();
    markRoomHosted(editCode);
    connectSwissRoom(editCode, viewCode, true, true);
    // connectSwissRoom's listener will push the local state (with viewCode
    // metadata) and publish the swissViewCodes mapping because remote is empty.
  }
  renderSwiss();
});

document.getElementById("swiss-join")?.addEventListener("click", () => {
  const input = document.getElementById("swiss-join-code");
  const status = document.getElementById("swiss-join-status");
  if (!input) return;
  const code = (input.value || "").trim().toUpperCase();
  if (!code) return;
  if (!firebaseReady()) {
    if (status) status.textContent = "Live sync isn't configured on this build.";
    return;
  }
  if (status) status.textContent = "Looking up room…";
  resolveRoomCode(code, result => {
    if (!result.ok) {
      if (status) status.textContent = result.reason || "Failed to connect.";
      return;
    }
    // Fresh join — remote owns the view, clear any stale local state.
    localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
    const asHost = isRoomHosted(result.editCode);
    const canEdit = asHost || result.role === "edit";
    const connected = connectSwissRoom(result.editCode, result.viewCode, asHost, canEdit);
    if (!connected.ok) {
      if (status) status.textContent = connected.reason || "Failed to connect.";
      return;
    }
    const label = canEdit ? "co-host" : "participant";
    if (status) status.textContent = `Joined as ${label}.`;
    renderSwiss();
  });
});

document.getElementById("swiss-reset")?.addEventListener("click", resetSwiss);

// Re-join a previously connected room on page load.
window.addEventListener("load", initSwissRoomOnLoad);

(function initDeckName() {
  const input = document.getElementById("deck-name");
  if (!input) return;
  input.value = loadDeckName();
  input.addEventListener("input", () => saveDeckName(input.value));
})();

function renderHistory() {
  const container = document.getElementById("history-list");
  const history = JSON.parse(localStorage.getItem("beyblade_history")) || [];

  container.innerHTML = "";

  if (history.length === 0) {
    container.innerHTML = "<p>No history yet.</p>";
    return;
  }

  function getColor(value) {
    if (value === "TBA") return "#95a5a6";

    const num = Number(value);
    if (isNaN(num)) return "#95a5a6";

    if (num >= 100) return "#2ecc71";
    if (num >= 50) {
      const cls = document.body.classList;
      return (cls.contains("light-mode") || cls.contains("tropical-mode")) ? "#ffbd59" : "#f1c40f";
    }
    return "#e74c3c";
  }

  function createBar(label, value, isTBA) {
    const maxMap = { "DAS": 50, "BUR": 100 };
    const max = maxMap[label] || 120;
    const color = isTBA ? "#95a5a6" : (label === "DAS" || label === "BUR") ? getRadarColor(label, Number(value)) : getColor(value);
    const width = isTBA ? 0 : Math.min(Number(value) / max * 100, 100);

    return `
      <div class="stat-row">
        <span class="stat-label">${label}</span>

        <div class="stat-bar-bg">
          <div class="stat-bar-fill"
               style="width:${width}%;
                      background:${color}"></div>
        </div>

        <span class="stat-value">
          ${isTBA ? "TBA" : value}
        </span>
      </div>
    `;
  }

  function renderObject(obj) {
    if (!obj) return "";

    const EXCLUDE_KEYS = ["ATK", "DEF", "STA"];
    const order = ["Weight", "Height", "Dash", "BurstRes", "Burst Res"];

    const entries = Object.entries(obj)
      .filter(([key]) => !EXCLUDE_KEYS.includes(key));

    const sorted = [
      ...order
        .map(k => entries.find(([key]) => key === k))
        .filter(Boolean),

      ...entries.filter(([key]) => !order.includes(key))
    ];

    return sorted
      .map(([key, val]) => {
        if (val === undefined || val === null) val = "-";
        return `<div class="stat-line"><b>${key}:</b> ${val}</div>`;
      })
      .join("");
  }

  function detectType(atk, def, sta) {
    if (atk === "TBA" || def === "TBA" || sta === "TBA") {
      return "TBA";
    }

    const a = Number(atk);
    const d = Number(def);
    const s = Number(sta);

    return getType(a, d, s, false);
  }

  history.forEach(item => {
    const data = item.data || {};
    const total = data.grandTotal || {};

    const atk = total.ATK;
    const def = total.DEF;
    const sta = total.STA;

    const isAtkTBA = atk === "TBA";
    const isDefTBA = def === "TBA";
    const isStaTBA = sta === "TBA";

    const isFullTBA = isAtkTBA && isDefTBA && isStaTBA;

    const spinDir = resolveSpinDirection(data);

    const type = isFullTBA
      ? "TBA"
      : detectType(atk, def, sta);

    // ================= MODE SUPPORT =================
    const modeData = data.modeData || {};

    const mainBladeMode =
      modeData.mainBlade ||
      modeData.bladeMode ||
      modeData.blade ||
      null;

    const assistBladeMode =
      modeData.assistBlade ||
      modeData.assistBladeMode ||
      null;

    const rbMode =
      modeData.ratchetBit ||
      modeData.ratchetBitMode ||
      null;

    const div = document.createElement("div");
    div.className = "history-item";

    // ================= PART IMAGES =================
    const parts = data.parts || {};
    const partModes = data.partModes || {};
    const PART_FOLDER = {
      blade: "blades", lockChip: "lockChips",
      mainBlade: "mainBlades", assistBlade: "assistBlades",
      metalBlade: "metalBlades", overBlade: "overBlades",
      ratchet: "ratchets", bit: "bits", ratchetBit: "ratchetBits"
    };
    const bitFolderFor = (name) => {
      const found = DATA.bits?.find(b => b.name === name);
      return found?._folder || "bits";
    };
    let partsHtml = "";
    for (const [key, name] of Object.entries(parts)) {
      if (!name || !PART_FOLDER[key]) continue;
      const modeIdx = partModes[key] != null ? partModes[key] : null;
      const folder = key === "bit" ? bitFolderFor(name) : PART_FOLDER[key];
      const src = partImgPath(folder, name, modeIdx);
      partsHtml += `<div class="result-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${name}" class="result-part-img"
               onerror="this.closest('.result-part').style.display='none'">
        </div>
        <span class="result-part-name">${name}</span>
      </div>`;
    }

    div.innerHTML = `
      <div class="history-header">
        <strong class="history-name">
          ${data.comboName || "Unknown Combo"}
        </strong>

        <span class="history-icons">
          ${typeLogo(type)}
          ${spinLogo(spinDir)}
        </span>
      </div>

      ${partsHtml ? `<div class="result-parts">${partsHtml}</div>` : ""}

      <div class="history-section">
        <b>Grand Total</b>

        ${statDisplayMode === "radar"
          ? renderRadarChart({ ATK: atk, DEF: def, STA: sta, Dash: total.Dash, "Burst Res": total["Burst Res"] })
          : createBar("ATK", atk, isAtkTBA) + createBar("DEF", def, isDefTBA) + createBar("STA", sta, isStaTBA)
            + createBar("DAS", total.Dash, total.Dash == null || total.Dash === "TBA")
            + createBar("BUR", total["Burst Res"], total["Burst Res"] == null || total["Burst Res"] === "TBA")
        }

        ${renderObject((() => { const { Dash: _d, "Burst Res": _b, ...rest } = total; return rest; })())}

        ${(mainBladeMode || assistBladeMode || rbMode) ? `
          <div class="stat-section">

            ${mainBladeMode ? `
              <div class="stat-line">
                <b>Main Blade Mode:</b> ${mainBladeMode}
              </div>
            ` : ""}

            ${assistBladeMode ? `
              <div class="stat-line">
                <b>Assist Blade Mode:</b> ${assistBladeMode}
              </div>
            ` : ""}

            ${rbMode ? `
              <div class="stat-line">
                <b>Ratchet-Bit Mode:</b> ${rbMode}
              </div>
            ` : ""}

          </div>
        ` : ""}
      </div>

      <small>${new Date(item.time).toLocaleString()}</small>
      <hr/>
    `;

    container.appendChild(div);
  });
}

// ================= SCOREBOARD =================
let scoreboardEnabled = false;
let scoreboardSaveCallback = null;

(function () {
  let scoreA = 0;
  let scoreB = 0;

  const overlay = document.getElementById("scoreboard-overlay");
  const scoreAEl = document.getElementById("score-a");
  const scoreBEl = document.getElementById("score-b");
  const labelA = overlay?.querySelector(".scoreboard-left .scoreboard-player-label");
  const labelB = overlay?.querySelector(".scoreboard-right .scoreboard-player-label");
  const resetBtn = document.getElementById("scoreboard-reset");
  const closeBtn = document.getElementById("scoreboard-close");
  const leftSide = document.getElementById("scoreboard-left");
  const rightSide = document.getElementById("scoreboard-right");

  if (!overlay) return;

  function updateDisplay() {
    scoreAEl.textContent = scoreA;
    scoreBEl.textContent = scoreB;
  }

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  if (isMobile) {
    const addSwipe = (el, onChange) => {
      let startY = 0;
      let swiping = false;
      el.addEventListener("touchstart", e => { startY = e.touches[0].clientY; swiping = true; }, { passive: true });
      el.addEventListener("touchend", e => {
        if (!swiping) return;
        swiping = false;
        const dy = startY - e.changedTouches[0].clientY;
        if (Math.abs(dy) < 30) return;
        onChange(dy > 0 ? 1 : -1);
      });
    };
    addSwipe(leftSide, d => { if (d < 0) { scoreA = Math.max(0, scoreA + d); updateDisplay(); } });
    addSwipe(rightSide, d => { if (d < 0) { scoreB = Math.max(0, scoreB + d); updateDisplay(); } });
  }

  const finishSounds = {
    Spin: new Audio("assets/voices/spinFinish.wav"),
    Over: new Audio("assets/voices/overFinish.wav"),
    Burst: new Audio("assets/voices/burstFinish.wav"),
    Extreme: new Audio("assets/voices/extremeFinish.wav")
  };

  overlay.querySelectorAll(".sb-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = btn.dataset.side;
      const delta = parseInt(btn.dataset.delta, 10);
      if (side === "a") { scoreA = Math.max(0, scoreA + delta); }
      else { scoreB = Math.max(0, scoreB + delta); }
      updateDisplay();
      const sound = finishSounds[btn.textContent.trim()];
      if (sound) {
        sound.currentTime = 0;
        sound.play().catch(() => {});
      }
    });
  });

  resetBtn.addEventListener("click", () => {
    scoreA = 0;
    scoreB = 0;
    updateDisplay();
  });

  // Set when the user taps check to save — the scoreboard keeps the just-
  // scored names/scores on screen, and only resets to the default board once
  // the user tilts back to portrait (see handleOrientation below).
  let pendingResetOnPortrait = false;

  closeBtn?.addEventListener("click", () => {
    const cb = scoreboardSaveCallback;
    scoreboardSaveCallback = null;
    closeBtn.classList.add("hidden");
    if (cb) cb({ scoreA, scoreB });
    pendingResetOnPortrait = true;
  });

  const isLandscape = () => screen.orientation ? screen.orientation.type.startsWith("landscape") : window.innerWidth > window.innerHeight;
  const enterFullscreen = () => {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el).catch(() => {});
  };
  const exitFullscreen = () => {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn && (document.fullscreenElement || document.webkitFullscreenElement)) fn.call(document).catch(() => {});
  };

  // Clear any match-linked state so the scoreboard behaves as the default
  // standalone board again (empty names, 0-0, no save target). Called when
  // the user leaves / resets a live room so they don't end up with stale
  // match context stuck on the overlay.
  window.resetScoreboardToDefault = function () {
    scoreboardSaveCallback = null;
    if (labelA) labelA.textContent = "A";
    if (labelB) labelB.textContent = "B";
    scoreA = 0;
    scoreB = 0;
    updateDisplay();
    closeBtn?.classList.add("hidden");
  };

  // Scores are entered only via the scoreboard overlay, and the overlay is
  // only revealed by tilting the phone to landscape. No alternative input.
  window.openScoreboard = function (nameA, nameB, onSave, initialA, initialB) {
    if (!isMobile) {
      alert("Scoring uses the tilt-activated scoreboard — open this page on your phone and rotate to landscape.");
      return;
    }

    // Safety net: if called for a view-only participant, drop the match
    // context and fall back to the default standalone scoreboard (no save
    // callback, no pre-filled names/scores). The tilt-to-open behavior for
    // the standalone board is unchanged.
    if (swissEditCode && !swissCanEdit) {
      nameA = "";
      nameB = "";
      onSave = null;
      initialA = 0;
      initialB = 0;
    }

    if (labelA) labelA.textContent = nameA || "A";
    if (labelB) labelB.textContent = nameB || "B";
    scoreA = typeof initialA === "number" ? initialA : 0;
    scoreB = typeof initialB === "number" ? initialB : 0;
    updateDisplay();
    scoreboardSaveCallback = typeof onSave === "function" ? onSave : null;
    closeBtn?.classList.toggle("hidden", !scoreboardSaveCallback);
    // Only reveal if already tilted; otherwise wait for the orientation handler.
    if (isLandscape()) { overlay.classList.remove("hidden"); enterFullscreen(); }
    else { overlay.classList.add("hidden"); }
  };

  if (isMobile) {
    const handleOrientation = () => {
      const armed = scoreboardEnabled || !!scoreboardSaveCallback;
      if (!armed) { overlay.classList.add("hidden"); exitFullscreen(); return; }
      if (isLandscape()) { overlay.classList.remove("hidden"); enterFullscreen(); }
      else {
        overlay.classList.add("hidden");
        exitFullscreen();
        // Now-in-portrait: if the user just saved a match, clear the match
        // context so the next tilt shows the default board.
        if (pendingResetOnPortrait) {
          pendingResetOnPortrait = false;
          if (typeof window.resetScoreboardToDefault === "function") {
            window.resetScoreboardToDefault();
          }
        }
      }
    };
    overlay.addEventListener("touchstart", () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) enterFullscreen();
    }, { once: false, passive: true });
    if (screen.orientation) screen.orientation.addEventListener("change", handleOrientation);
    else window.addEventListener("orientationchange", handleOrientation);
  }
})();
