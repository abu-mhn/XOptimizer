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

// --- Sort all DATA arrays alphabetically by name ---
function sortData() {
  Object.keys(DATA).forEach(key => {
    DATA[key].sort((a, b) => a.name.localeCompare(b.name));
  });
}

// --- Auto-advance flow: map which dropdown to focus after the current one ---
// "__BOTTOM__" = scroll to Bottom fieldset but let the user choose Ratchet or Ratchet-Bit
const NEXT_DROPDOWN = {
  "form-standard": {
    blade: "__BOTTOM__",
    ratchet: "bit",
    bit: null,
    ratchetBit: null
  },
  "form-cx": {
    lockChip: "mainBlade",
    mainBlade: "assistBlade",
    assistBlade: "__BOTTOM__",
    ratchet: "bit",
    bit: null,
    ratchetBit: null
  },
  "form-cxExpand": {
    lockChip: "metalBlade",
    metalBlade: "overBlade",
    overBlade: "assistBlade",
    assistBlade: "__BOTTOM__",
    ratchet: "bit",
    bit: null,
    ratchetBit: null
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
    requestAnimationFrame(() => {
      showBottomChoicePopup(form);
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

function showBottomChoicePopup(form) {
  const popup = document.getElementById("bottom-choice-popup");
  if (!popup) return;

  const ratchetInput = form.querySelector('[name="ratchet"]')?.nextElementSibling?.querySelector("input");
  const rbInput = form.querySelector('[name="ratchetBit"]')?.nextElementSibling?.querySelector("input");

  const ratchetBtn = popup.querySelector('[data-choice="ratchet"]');
  const rbBtn = popup.querySelector('[data-choice="ratchetBit"]');

  // Only disable ratchet button if both ratchet AND bit are disabled
  const bitInput = form.querySelector('[name="bit"]')?.nextElementSibling?.querySelector("input");
  if (ratchetBtn) ratchetBtn.disabled = !!ratchetInput?.disabled && !!bitInput?.disabled;
  if (rbBtn) rbBtn.disabled = !!rbInput?.disabled;

  // Hide the X close button so the only way out is choosing
  const closeBtn = popup.querySelector(".popup-close");
  if (closeBtn) closeBtn.style.display = "none";

  popup.classList.remove("hidden");

  const close = () => {
    popup.classList.add("hidden");
    if (closeBtn) closeBtn.style.display = "";
  };

  const onClick = (e) => {
    const btn = e.target.closest(".popup-choice");
    if (!btn || btn.disabled) return;
    const choice = btn.dataset.choice;
    close();
    popup.removeEventListener("click", onClick);

    let targetName = choice === "ratchet" ? "ratchet" : "ratchetBit";
    let wrapper = form.querySelector(`[name="${targetName}"]`)?.nextElementSibling;
    let input = wrapper?.querySelector("input");

    // If ratchet is disabled (e.g. Bullet Griffon), skip to bit
    if (choice === "ratchet" && input?.disabled) {
      targetName = "bit";
      wrapper = form.querySelector(`[name="${targetName}"]`)?.nextElementSibling;
      input = wrapper?.querySelector("input");
    }

    if (!input || input.disabled) return;

    requestAnimationFrame(() => {
      wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus();
    });
  };

  popup.addEventListener("click", onClick);
}

// --- Searchable dropdown ---
function makeSearchable(sel, items, labelFn) {
  sel.innerHTML = '<option value="">-- Select --</option>';
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

  // Allow programmatic selection
  wrapper._select = (idx) => { sel.value = idx; input.value = labelFn(items[idx]); clearBtn.classList.remove("hidden"); sel.dispatchEvent(new Event("change")); };

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
  // Standard
  const stdForm = document.getElementById("form-standard");
  makeSearchable(stdForm.querySelector('[name="blade"]'), DATA.blades, b => b.name);
  makeSearchable(stdForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name);
  makeSearchable(stdForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  makeSearchable(stdForm.querySelector('[name="ratchetBit"]'), DATA.ratchetBits, rb => rb.name);

  // CX
  const cxForm = document.getElementById("form-cx");
  makeSearchable(cxForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
  makeSearchable(cxForm.querySelector('[name="mainBlade"]'), DATA.mainBlades, mb => mb.name);
  makeSearchable(cxForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
  makeSearchable(cxForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name);
  makeSearchable(cxForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  makeSearchable(cxForm.querySelector('[name="ratchetBit"]'), DATA.ratchetBits, rb => rb.name);

  // CX Expand
  const cxeForm = document.getElementById("form-cxExpand");
  makeSearchable(cxeForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
  makeSearchable(cxeForm.querySelector('[name="metalBlade"]'), DATA.metalBlades, mb => mb.name);
  makeSearchable(cxeForm.querySelector('[name="overBlade"]'), DATA.overBlades, ob => ob.name);
  makeSearchable(cxeForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
  makeSearchable(cxeForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name);
  makeSearchable(cxeForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  makeSearchable(cxeForm.querySelector('[name="ratchetBit"]'), DATA.ratchetBits, rb => rb.name);
}

// --- Mode tabs ---
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {

    // ================= ACTIVE TAB =================
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");

    const mode = tab.dataset.mode;

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

      const rbInput = form.querySelector('[name="ratchetBit"]')?.nextElementSibling?.querySelector("input");
      if (rbInput) {
        rbInput.disabled = false;
        rbInput.placeholder = "-- Select --";
      }

      // ================= hide mode buttons =================
      form.querySelectorAll(".btn-mode").forEach(b => {
        b.classList.add("hidden");
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

    // 🔽 AUTO SCROLL TO TOP ON TAB SWITCH
    requestAnimationFrame(() => {
      window.scrollTo({
        top: 0,
        behavior: "smooth"
      });
    });

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
  if (val >= 100) return "#3fb950";
  if (val >= 50) return "#d29922";
  return "#f85149";
}

let statDisplayMode = "bar";

function renderStatBars(grandTotal) {
  if (statDisplayMode === "radar") return renderRadarChart(grandTotal);

  const stats = [
    { label: "ATK", value: grandTotal.ATK },
    { label: "DEF", value: grandTotal.DEF },
    { label: "STA", value: grandTotal.STA },
  ];
  let html = '<div class="stat-bars">';
  for (const s of stats) {
    const isTBA = s.value === "TBA";
    const val = isTBA ? 0 : Number(s.value);
    const color = isTBA ? "#484f58" : getBarColor(val);
    const pct = isTBA ? 0 : Math.min(val / 150 * 100, 100);
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
  if (label === "Dash") {
    if (val >= 35) return "#3fb950";
    if (val >= 20) return "#d29922";
    return "#f85149";
  }
  if (label === "B.Res") {
    if (val >= 80) return "#3fb950";
    if (val >= 50) return "#d29922";
    return "#f85149";
  }
  return getBarColor(val);
}

function renderRadarChart(grandTotal) {
  const stats = [
    { label: "ATK", value: grandTotal.ATK },
    { label: "DEF", value: grandTotal.DEF },
    { label: "STA", value: grandTotal.STA },
    { label: "Dash", value: grandTotal.Dash },
    { label: "B.Res", value: grandTotal["Burst Res"] },
  ];

  const count = stats.length;
  const cx = 160, cy = 150, r = 90;
  const maxVal = 150;
  const isLight = document.body.classList.contains("light-mode");
  const gridColor = isLight ? "#c0c5cc" : "#30363d";
  const textColor = isLight ? "#1f2328" : "#e6edf3";

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
  const fillColor = allTBA ? "rgba(72,79,88,0.3)" : "rgba(56,139,253,0.25)";
  const strokeColor = allTBA ? "#484f58" : "#388bfd";

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

  html += renderStatBars(res.grandTotal);

  const { ATK, DEF, STA, Type, "Spin Direction": _spin, ...grandTotalRest } =
    res.grandTotal;

  if (statDisplayMode === "radar") {
    const { Dash: _d, "Burst Res": _b, ...radarRest } = grandTotalRest;
    html += renderStatTable("", radarRest);
  } else {
    html += renderStatTable("", grandTotalRest);
  }

  html += `<div class="download-row">
    <button type="button" class="btn btn-download" aria-label="Download as PNG">
      <img src="assets/icons/download.png" alt="Download"
           onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2B07;');">
      Download PNG
    </button>
  </div>`;

  el.innerHTML = html;

  // Wire up download button
  el.querySelector(".btn-download")?.addEventListener("click", () => downloadResultPNG(el));
}

function downloadResultPNG(el) {
  // Temporarily hide the download button during capture
  const dlBtn = el.querySelector(".download-row");
  if (dlBtn) dlBtn.style.display = "none";

  // Temporarily add footer for the screenshot (hidden from user view)
  const footer = document.createElement("div");
  footer.className = "png-footer";
  footer.style.cssText = "text-align:center;padding:12px 0 8px;font-size:12px;color:#8b949e;border-top:1px solid #21262d;margin-top:12px;";
  footer.innerHTML = `
    <div style="display:flex;justify-content:center;align-items:center;gap:6px;flex-wrap:wrap;width:100%;text-align:center;">
      <span style="display:flex;align-items:center;gap:4px;">Beyblade X Stat Calculator</span>
      <span style="opacity:0.5;">•</span>
      <span style="display:flex;align-items:center;gap:4px;">Created by <strong style="color:#c9d1d9;">RvX Ashwolf</strong></span>
      <span style="display:flex;align-items:center;gap:4px;width:100%;justify-content:center;margin-top:6px;">Powered by <img src="${document.body.classList.contains('light-mode') ? 'assets/icons/revoxNameLight.webp' : 'assets/icons/revoxName.webp'}" alt="Revox" style="height:40px;width:auto;transform:translateY(-5px);"></span>
    </div>`;
  el.appendChild(footer);

  // Move element off-screen so the user doesn't see the footer flash
  const origPos = el.style.position;
  const origLeft = el.style.left;
  el.style.position = "fixed";
  el.style.left = "-9999px";

  html2canvas(el, {
    backgroundColor: "#0d1117",
    scale: 2,
    useCORS: true
  }).then(canvas => {
    el.style.position = origPos;
    el.style.left = origLeft;
    if (dlBtn) dlBtn.style.display = "";
    footer.remove();
    const link = document.createElement("a");
    // Use combo name for filename if available
    const comboEl = el.querySelector(".combo-name, .combo-header");
    const name = comboEl ? comboEl.textContent.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_") : "result";
    link.download = `${name}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  }).catch(() => {
    el.style.position = origPos;
    el.style.left = origLeft;
    if (dlBtn) dlBtn.style.display = "";
    footer.remove();
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
  const rbIdx = form.querySelector('[name="ratchetBit"]')?.value;

  if (!bladeIdx) {
    return renderResult({
      status: "Failure",
      message: "Please select a blade."
    });
  }

  const blade = DATA?.blades?.[bladeIdx];
  const ratchet = ratchetIdx ? DATA?.ratchets?.[ratchetIdx] : null;
  const bit = bitIdx ? DATA?.bits?.[bitIdx] : null;
  const rb = rbIdx ? DATA?.ratchetBits?.[rbIdx] : null;

  if (!blade) {
    return renderResult({
      status: "Failure",
      message: "Blade not found."
    });
  }

  const isRB = !!rb;

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

    parts: {
      blade: blade.name,
      ratchet: ratchet?.name || null,
      bit: bit?.name || null,
      ratchetBit: rb?.name || null
    },

    grandTotal: {
      ATK: finalAtk,
      DEF: finalDef,
      STA: finalSta,

      Weight: finalWeight,

      Height: bHeight == null
        ? "TBA"
        : `${(Number(bHeight) / 10).toFixed(1)} mm`,

      Dash: isRB ? rbA?.dash : bit?.dash,
      "Burst Res": isRB ? rbA?.burstRes : bit?.burstRes
    }
  });

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    barState,

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

      Height: bHeight == null
        ? "TBA"
        : `${(Number(bHeight) / 10).toFixed(1)} mm`,

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
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth"
    });
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
  const rbIdx = form.querySelector('[name="ratchetBit"]')?.value;

  if (!lcIdx || !mbIdx || !abIdx) {
    return renderResult({
      status: "Failure",
      message: "Please select all top components."
    });
  }

  const lc = DATA.lockChips[lcIdx];
  const mb = DATA.mainBlades[mbIdx];
  const ab = DATA.assistBlades[abIdx];
  const ratchet = rIdx ? DATA.ratchets[rIdx] : null;
  const bit = bIdx ? DATA.bits[bIdx] : null;
  const rb = rbIdx ? DATA.ratchetBits[rbIdx] : null;

  if (!lc || !mb || !ab) {
    return renderResult({
      status: "Failure",
      message: "One or more parts not found."
    });
  }

  const isRB = !!rb;

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

    parts: {
      lockChip: lc.name,
      mainBlade: mbA.name,
      assistBlade: abA.name,
      ratchet: ratchet?.name || null,
      bit: bit?.name || null,
      ratchetBit: rb?.name || null
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

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    barState: isStatTBA ? "grey" : "normal",

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
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth"
    });
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
  const rbIdx = form.querySelector('[name="ratchetBit"]')?.value;

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

  const ratchet = rIdx ? DATA.ratchets[rIdx] : null;
  const bit = bIdx ? DATA.bits[bIdx] : null;
  const rb = rbIdx ? DATA.ratchetBits[rbIdx] : null;

  const isRB = !!rb;

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
      bit: bit?.name || null,
      ratchetBit: rb?.name || null
    },

    top: {
      ATK: topAtk,
      DEF: topDef,
      STA: topSta,
      Weight: topWeight
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

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",

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
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth"
    });
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
    const rb = DATA.ratchetBits?.[form.querySelector('[name="ratchetBit"]')?.value];

    if (mode === "blade") cycle(blade);
    if (mode === "rb") cycle(rb);

    calcStandard(form);
  } else if (calc === "cx") {
    const mb = DATA.mainBlades?.[form.querySelector('[name="mainBlade"]')?.value];
    const ab = DATA.assistBlades?.[form.querySelector('[name="assistBlade"]')?.value];
    const rb = DATA.ratchetBits?.[form.querySelector('[name="ratchetBit"]')?.value];

    if (mode === "mb") cycle(mb);
    if (mode === "ab") cycle(ab);
    if (mode === "rb") cycle(rb);

    calcCX(form);
  } else if (calc === "cxExpand") {
    const mb = DATA.metalBlades?.[form.querySelector('[name="metalBlade"]')?.value];
    const ob = DATA.overBlades?.[form.querySelector('[name="overBlade"]')?.value];
    const ab = DATA.assistBlades?.[form.querySelector('[name="assistBlade"]')?.value];
    const rb = DATA.ratchetBits?.[form.querySelector('[name="ratchetBit"]')?.value];

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
  const rbWrapper = stdForm.querySelector('[name="ratchetBit"]').nextElementSibling;
  const rbInput = rbWrapper.querySelector("input");

  bladeSel.addEventListener("change", () => {
    const idx = bladeSel.value;
    const codename = idx !== "" ? DATA.blades[idx].codename : "";

    if (codename === "CLOCKMIRAGE") {
      // Clock Mirage: filter ratchet to *5, disable ratchet-bit
      ratchetWrapper._setFilter(r => r.name.endsWith("5"));
      ratchetInput.disabled = false;
      ratchetInput.placeholder = "-- Select --";
      rbWrapper._clear();
      rbInput.disabled = true;
      rbInput.placeholder = "Not available";
    } else if (codename === "BULLETGRIFFON") {
      // Bullet Griffon: disable ratchet and ratchet-bit
      ratchetWrapper._clear();
      ratchetWrapper._filterFn = null;
      ratchetInput.disabled = true;
      ratchetInput.placeholder = "Not available";
      rbWrapper._clear();
      rbInput.disabled = true;
      rbInput.placeholder = "Not available";
    } else {
      // Default: clear filters, re-enable based on current selections
      ratchetWrapper._filterFn = null;

      const ratchetSel = stdForm.querySelector('[name="ratchet"]');
      const bitSel = stdForm.querySelector('[name="bit"]');
      const rbSel = stdForm.querySelector('[name="ratchetBit"]');

      // Only re-enable ratchet if ratchet-bit is not chosen
      if (!rbSel.value) {
        ratchetInput.disabled = false;
        ratchetInput.placeholder = "-- Select --";
      }

      // Only re-enable ratchet-bit if both ratchet and bit are empty
      if (!ratchetSel.value && !bitSel.value) {
        rbInput.disabled = false;
        rbInput.placeholder = "-- Select --";
      }
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
  setupModeButton(stdForm, "ratchetBit", DATA.ratchetBits);

  setupModeButton(cxForm, "mainBlade", DATA.mainBlades);
  setupModeButton(cxForm, "assistBlade", DATA.assistBlades);
  setupModeButton(cxForm, "ratchetBit", DATA.ratchetBits);

  setupModeButton(cxeForm, "assistBlade", DATA.assistBlades);
  setupModeButton(cxeForm, "ratchetBit", DATA.ratchetBits);
})();

// --- Ratchet <-> Ratchet-Bit mutual disable ---
document.querySelectorAll(".calc-form").forEach(form => {
  const ratchetSel = form.querySelector('[name="ratchet"]');
  const bitSel = form.querySelector('[name="bit"]');
  const rbSel = form.querySelector('[name="ratchetBit"]');
  if (!ratchetSel || !rbSel || !bitSel) return;

  const ratchetWrapper = ratchetSel.nextElementSibling;
  const ratchetInput = ratchetWrapper.querySelector("input");
  const bitWrapper = bitSel.nextElementSibling;
  const bitInput = bitWrapper.querySelector("input");
  const rbWrapper = rbSel.nextElementSibling;
  const rbInput = rbWrapper.querySelector("input");

  function isBladeRestricted() {
    const bladeSel = form.querySelector('[name="blade"]');
    if (!bladeSel) return false;
    const idx = bladeSel.value;
    if (idx === "") return false;
    const cn = DATA.blades[idx].codename;
    return cn === "CLOCKMIRAGE" || cn === "BULLETGRIFFON";
  }

  ratchetSel.addEventListener("change", () => {
    if (isBladeRestricted()) return;

    if (ratchetSel.value !== "") {
      rbWrapper._clear();
      rbInput.disabled = true;
      rbInput.placeholder = "Not available";
    } else if (bitSel.value === "") {
      rbInput.disabled = false;
      rbInput.placeholder = "-- Select --";
    }
  });

  bitSel.addEventListener("change", () => {
    if (isBladeRestricted()) return;

    if (bitSel.value !== "") {
      rbWrapper._clear();
      rbInput.disabled = true;
      rbInput.placeholder = "Not available";
    } else if (ratchetSel.value === "") {
      rbInput.disabled = false;
      rbInput.placeholder = "-- Select --";
    }
  });

  rbSel.addEventListener("change", () => {
    if (rbSel.value !== "") {
      ratchetWrapper._clear();
      ratchetInput.disabled = true;
      ratchetInput.placeholder = "Not available";
      bitWrapper._clear();
      bitInput.disabled = true;
      bitInput.placeholder = "Not available";
    } else {
      ratchetInput.disabled = false;
      ratchetInput.placeholder = "-- Select --";
      bitInput.disabled = false;
      bitInput.placeholder = "-- Select --";
    }
  });
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

    const rbInput = form.querySelector('[name="ratchetBit"]')?.nextElementSibling?.querySelector("input");
    if (rbInput) {
      rbInput.disabled = false;
      rbInput.placeholder = "-- Select --";
    }

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

// --- I'm Feeling Lucky ---
function randIdx(arr) { return Math.floor(Math.random() * arr.length); }

function heaviestIdx(arr) {
  let max = -1, idx = 0;
  arr.forEach((item, i) => {
    const w = item.weight || 0;
    if (w > max) { max = w; idx = i; }
  });
  return idx;
}

function lightestIdx(arr) {
  let min = Infinity, idx = 0;
  arr.forEach((item, i) => {
    const w = item.weight || Infinity;
    if (w < min) { min = w; idx = i; }
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

  btn.addEventListener("click", () => menu.classList.toggle("hidden"));

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
  document.body.classList.toggle("light-mode", val === "light");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = val === "light" ? "#f6f8fa" : "#0a4797";
  document.querySelectorAll('img.footer-logo').forEach(img => {
    img.src = val === "light" ? "assets/icons/revoxNameLight.webp" : "assets/icons/revoxName.webp";
  });
});

// Stat display setting
initSettingDropdown("setting-stat-display", "statDisplay", "bar", (val) => {
  statDisplayMode = val;
});

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
    } else if (randomModeValue === "minweight") {
      btn.innerHTML = '<img src="assets/icons/lightweight.png" alt="Min Weight">';
      btn.setAttribute("aria-label", "Min Weight");
    } else {
      btn.innerHTML = '<img src="assets/icons/dice.png" alt="Random">';
      btn.setAttribute("aria-label", "I'm Feeling Lucky");
    }
  });
}

function selectMaxWeight(form, mode) {
  if (mode === "standard") {
    getWrapper(form, "blade")._select(heaviestIdx(DATA.blades));

    const maxRatchetW = Math.max(...DATA.ratchets.map(r => r.weight || 0));
    const maxBitW = Math.max(...DATA.bits.map(b => b.weight || 0));
    const maxRBW = DATA.ratchetBits.length > 0
      ? Math.max(...DATA.ratchetBits.map(rb => rb.weight || 0))
      : 0;

    if (maxRBW > maxRatchetW + maxBitW) {
      getWrapper(form, "ratchetBit")._select(heaviestIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(heaviestIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(heaviestIdx(DATA.bits));
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(heaviestIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(heaviestIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(heaviestIdx(DATA.assistBlades));

    const maxRatchetW = Math.max(...DATA.ratchets.map(r => r.weight || 0));
    const maxBitW = Math.max(...DATA.bits.map(b => b.weight || 0));
    const maxRBW = DATA.ratchetBits.length > 0
      ? Math.max(...DATA.ratchetBits.map(rb => rb.weight || 0))
      : 0;

    if (maxRBW > maxRatchetW + maxBitW) {
      getWrapper(form, "ratchetBit")._select(heaviestIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(heaviestIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(heaviestIdx(DATA.bits));
    }
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(heaviestIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(heaviestIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(heaviestIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(heaviestIdx(DATA.assistBlades));

    const maxRatchetW = Math.max(...DATA.ratchets.map(r => r.weight || 0));
    const maxBitW = Math.max(...DATA.bits.map(b => b.weight || 0));
    const maxRBW = DATA.ratchetBits.length > 0
      ? Math.max(...DATA.ratchetBits.map(rb => rb.weight || 0))
      : 0;

    if (maxRBW > maxRatchetW + maxBitW) {
      getWrapper(form, "ratchetBit")._select(heaviestIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(heaviestIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(heaviestIdx(DATA.bits));
    }
  }
}

function selectMinWeight(form, mode) {
  if (mode === "standard") {
    getWrapper(form, "blade")._select(lightestIdx(DATA.blades));

    const minRatchetW = Math.min(...DATA.ratchets.map(r => r.weight || Infinity));
    const minBitW = Math.min(...DATA.bits.map(b => b.weight || Infinity));
    const minRBW = DATA.ratchetBits.length > 0
      ? Math.min(...DATA.ratchetBits.map(rb => rb.weight || Infinity))
      : Infinity;

    if (minRBW < minRatchetW + minBitW) {
      getWrapper(form, "ratchetBit")._select(lightestIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(lightestIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(lightestIdx(DATA.bits));
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(lightestIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(lightestIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(lightestIdx(DATA.assistBlades));

    const minRatchetW = Math.min(...DATA.ratchets.map(r => r.weight || Infinity));
    const minBitW = Math.min(...DATA.bits.map(b => b.weight || Infinity));
    const minRBW = DATA.ratchetBits.length > 0
      ? Math.min(...DATA.ratchetBits.map(rb => rb.weight || Infinity))
      : Infinity;

    if (minRBW < minRatchetW + minBitW) {
      getWrapper(form, "ratchetBit")._select(lightestIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(lightestIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(lightestIdx(DATA.bits));
    }
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(lightestIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(lightestIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(lightestIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(lightestIdx(DATA.assistBlades));

    const minRatchetW = Math.min(...DATA.ratchets.map(r => r.weight || Infinity));
    const minBitW = Math.min(...DATA.bits.map(b => b.weight || Infinity));
    const minRBW = DATA.ratchetBits.length > 0
      ? Math.min(...DATA.ratchetBits.map(rb => rb.weight || Infinity))
      : Infinity;

    if (minRBW < minRatchetW + minBitW) {
      getWrapper(form, "ratchetBit")._select(lightestIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(lightestIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(lightestIdx(DATA.bits));
    }
  }
}

function selectRandom(form, mode) {
  if (mode === "standard") {
    const bladeIdx = randIdx(DATA.blades);
    getWrapper(form, "blade")._select(bladeIdx);
    const codename = DATA.blades[bladeIdx].codename;

    if (codename === "BULLETGRIFFON") {
      getWrapper(form, "bit")._select(randIdx(DATA.bits));
    } else if (codename === "CLOCKMIRAGE") {
      const valid = DATA.ratchets.map((r, i) => ({ r, i })).filter(x => x.r.name.endsWith("5"));
      getWrapper(form, "ratchet")._select(valid[Math.floor(Math.random() * valid.length)].i);
      getWrapper(form, "bit")._select(randIdx(DATA.bits));
    } else {
      if (Math.random() < 0.05 && DATA.ratchetBits.length > 0) {
        getWrapper(form, "ratchetBit")._select(randIdx(DATA.ratchetBits));
      } else {
        getWrapper(form, "ratchet")._select(randIdx(DATA.ratchets));
        getWrapper(form, "bit")._select(randIdx(DATA.bits));
      }
    }
  } else if (mode === "cx") {
    getWrapper(form, "lockChip")._select(randIdx(DATA.lockChips));
    getWrapper(form, "mainBlade")._select(randIdx(DATA.mainBlades));
    getWrapper(form, "assistBlade")._select(randIdx(DATA.assistBlades));
    if (Math.random() < 0.05 && DATA.ratchetBits.length > 0) {
      getWrapper(form, "ratchetBit")._select(randIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(randIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(randIdx(DATA.bits));
    }
  } else if (mode === "cxExpand") {
    getWrapper(form, "lockChip")._select(randIdx(DATA.lockChips));
    getWrapper(form, "metalBlade")._select(randIdx(DATA.metalBlades));
    getWrapper(form, "overBlade")._select(randIdx(DATA.overBlades));
    getWrapper(form, "assistBlade")._select(randIdx(DATA.assistBlades));
    if (Math.random() < 0.05 && DATA.ratchetBits.length > 0) {
      getWrapper(form, "ratchetBit")._select(randIdx(DATA.ratchetBits));
    } else {
      getWrapper(form, "ratchet")._select(randIdx(DATA.ratchets));
      getWrapper(form, "bit")._select(randIdx(DATA.bits));
    }
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
    ...(DATA.lockChips || []),
    ...(DATA.ratchetBits || [])
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

    if (DATA.blades?.some(i => i.name === name)) return "blades";
    if (DATA.lockChips?.some(i => i.name === name)) return "lockChips";
    if (DATA.ratchetBits?.some(i => i.name === name)) return "ratchetBits";
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
    const EXCLUDE_KEYS = ["name"];

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
    if (num >= 50) return "#f1c40f";
    return "#e74c3c";
  }

  function createBar(label, value, isTBA) {
    const color = isTBA ? "#95a5a6" : getColor(value);
    const width = isTBA ? 100 : Math.min(Number(value), 120);

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
    const top = data.top || {};

    const atk = total.ATK;
    const def = total.DEF;
    const sta = total.STA;

    const isAtkTBA = atk === "TBA";
    const isDefTBA = def === "TBA";
    const isStaTBA = sta === "TBA";

    const isFullTBA = isAtkTBA && isDefTBA && isStaTBA;

    const spinDir = top.spinDirection || top["Spin Direction"] || "R";

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

      <div class="history-section">
        <b>Grand Total</b>

        ${statDisplayMode === "radar"
          ? renderRadarChart({ ATK: atk, DEF: def, STA: sta, Dash: total.Dash, "Burst Res": total["Burst Res"] })
          : createBar("ATK", atk, isAtkTBA) + createBar("DEF", def, isDefTBA) + createBar("STA", sta, isStaTBA)
        }

        ${statDisplayMode === "radar" ? renderObject((() => { const { Dash: _d, "Burst Res": _b, ...rest } = total; return rest; })()) : renderObject(total)}

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

// ================= SCOREBOARD ON ROTATE (MOBILE) =================
(function () {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  if (!isMobile) return;

  let scoreA = 0;
  let scoreB = 0;

  const overlay = document.getElementById("scoreboard-overlay");
  const scoreAEl = document.getElementById("score-a");
  const scoreBEl = document.getElementById("score-b");
  const resetBtn = document.getElementById("scoreboard-reset");
  const leftSide = document.getElementById("scoreboard-left");
  const rightSide = document.getElementById("scoreboard-right");

  if (!overlay) return;

  function updateDisplay() {
    scoreAEl.textContent = scoreA;
    scoreBEl.textContent = scoreB;
  }

  function addSwipe(el, onChange) {
    let startY = 0;
    let swiping = false;

    el.addEventListener("touchstart", e => {
      startY = e.touches[0].clientY;
      swiping = true;
    }, { passive: true });

    el.addEventListener("touchend", e => {
      if (!swiping) return;
      swiping = false;
      const dy = startY - e.changedTouches[0].clientY;
      if (Math.abs(dy) < 30) return;
      onChange(dy > 0 ? 1 : -1);
    });
  }

  addSwipe(leftSide, d => { scoreA = Math.max(0, scoreA + d); updateDisplay(); });
  addSwipe(rightSide, d => { scoreB = Math.max(0, scoreB + d); updateDisplay(); });

  resetBtn.addEventListener("click", () => {
    scoreA = 0;
    scoreB = 0;
    updateDisplay();
  });

  function isLandscape() {
    if (screen.orientation) return screen.orientation.type.startsWith("landscape");
    return window.innerWidth > window.innerHeight;
  }

  function enterFullscreen() {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el).catch(() => {});
  }

  function exitFullscreen() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn && (document.fullscreenElement || document.webkitFullscreenElement)) {
      fn.call(document).catch(() => {});
    }
  }

  function handleOrientation() {
    if (isLandscape()) {
      overlay.classList.remove("hidden");
      enterFullscreen();
    } else {
      overlay.classList.add("hidden");
      exitFullscreen();
    }
  }

  // Fallback: if auto-fullscreen was blocked, enter on first tap
  overlay.addEventListener("touchstart", () => {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      enterFullscreen();
    }
  }, { once: false, passive: true });

  if (screen.orientation) {
    screen.orientation.addEventListener("change", handleOrientation);
  } else {
    window.addEventListener("orientationchange", handleOrientation);
  }
})();
