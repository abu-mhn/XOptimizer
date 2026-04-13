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

function formatWeight(value) {
  const num = Number(value);
  return isNaN(num) ? "0.00" : num.toFixed(2);
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

  const list = document.createElement("div");
  list.className = "dd-list";

  wrapper.appendChild(input);
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
    close();
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

  // Allow clearing
  wrapper._clear = () => { sel.value = ""; input.value = ""; wrapper._filterFn = null; };

  // Allow programmatic selection
  wrapper._select = (idx) => { sel.value = idx; input.value = labelFn(items[idx]); sel.dispatchEvent(new Event("change")); };

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

      // ================= RESET FORM (ONLY ACTIVE FORM) =================
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

    // ================= HISTORY =================
    if (mode === "history") {
      renderHistory();
    }

    // ================= HIDE RESULT =================
    document.getElementById("result")?.classList.add("hidden");

    // ================= 🔥 FIX CALCULATE BUTTON (IMPORTANT) =================
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

function renderStatBars(grandTotal) {
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

  html += renderStatTable("", grandTotalRest);

  el.innerHTML = html;
}

// --- Standard calculation ---
function calcStandard(form) {
  const bladeIdx = form.querySelector('[name="blade"]').value;
  const ratchetIdx = form.querySelector('[name="ratchet"]').value;
  const bitIdx = form.querySelector('[name="bit"]').value;
  const rbIdx = form.querySelector('[name="ratchetBit"]').value;

  if (bladeIdx === "") {
    return renderResult({
      status: "Failure",
      message: "Please select a blade."
    });
  }

  const blade = DATA.blades[bladeIdx];
  const ratchet = ratchetIdx !== "" ? DATA.ratchets[ratchetIdx] : null;
  const bit = bitIdx !== "" ? DATA.bits[bitIdx] : null;
  const rb = rbIdx !== "" ? DATA.ratchetBits[rbIdx] : null;

  const isBulletGriffon = blade.codename === "BULLETGRIFFON";
  const isClockMirage = blade.codename === "CLOCKMIRAGE";

  const hasValidBottom = (ratchet && bit) || rb || (isBulletGriffon && bit);

  const clockMirageMismatch =
    isClockMirage && (!ratchet || !ratchet.name.endsWith("5")) && !rb;

  const clockMirageInvalidBit = isClockMirage && rb;
  const bulletGriffonInvalid = isBulletGriffon && (ratchet || rb);

  if (!hasValidBottom || clockMirageMismatch || clockMirageInvalidBit || bulletGriffonInvalid) {
    return renderResult({
      status: "Failure",
      message: "Combo failed to create"
    });
  }

  // ================= HEIGHT FORMAT =================
  function formatHeight(val) {
    if (val === undefined || val === null || val === "TBA") return "TBA";
    return `${(Number(val) / 10).toFixed(1)} mm`;
  }

  // ================= TOP =================
  const topAtkZ = blade.atk === 0;
  const topDefZ = blade.def === 0;
  const topStaZ = blade.sta === 0;

  const topStats = {
    Blade: blade.name,
    ATK: tbaOrVal(blade.atk, topAtkZ),
    DEF: tbaOrVal(blade.def, topDefZ),
    STA: tbaOrVal(blade.sta, topStaZ),
    Weight: weightStr(blade.weight),
    "Spin Direction": blade.spindirection,
  };

  // ================= BOTTOM =================
  let bottomStats = {};
  let bAtk, bDef, bSta, bWeight, bHeight;
  let bAtkZ, bDefZ, bStaZ, bWeightZ;

  const isRB = !!rb && !isClockMirage;

  if (isRB) {
    bAtk = rb.atk;
    bDef = rb.def;
    bSta = rb.sta;
    bWeight = rb.weight;
    bHeight = rb.height;

    bAtkZ = rb.atk === 0;
    bDefZ = rb.def === 0;
    bStaZ = rb.sta === 0;
    bWeightZ = rb.weight === 0;

    bottomStats = {
      "Ratchet-Bit": rb.name,
      ATK: tbaOrVal(bAtk, bAtkZ),
      DEF: tbaOrVal(bDef, bDefZ),
      STA: tbaOrVal(bSta, bStaZ),
      Height: formatHeight(bHeight),
      Dash: rb.dash,
      "Burst Res": rb.burstRes,
      Weight: weightStr(bWeight),
    };

  } else {
    const rAtk = ratchet ? ratchet.atk : 0;
    const rDef = ratchet ? ratchet.def : 0;
    const rSta = ratchet ? ratchet.sta : 0;
    const rW = ratchet ? ratchet.weight : 0;

    bAtk = isBulletGriffon ? bit.atk : rAtk + bit.atk;
    bDef = isBulletGriffon ? bit.def : rDef + bit.def;
    bSta = isBulletGriffon ? bit.sta : rSta + bit.sta;
    bWeight = isBulletGriffon ? bit.weight : rW + bit.weight;

    bAtkZ = isBulletGriffon ? bit.atk === 0 : rAtk === 0 || bit.atk === 0;
    bDefZ = isBulletGriffon ? bit.def === 0 : rDef === 0 || bit.def === 0;
    bStaZ = isBulletGriffon ? bit.sta === 0 : rSta === 0 || bit.sta === 0;
    bWeightZ = isBulletGriffon ? bit.weight === 0 : rW === 0 || bit.weight === 0;

    bHeight = ratchet ? ratchet.height : null;

    bottomStats = {
      Ratchet: ratchet ? ratchet.name : undefined,
      Bit: bit.name,
      ATK: tbaOrVal(bAtk, bAtkZ),
      DEF: tbaOrVal(bDef, bDefZ),
      STA: tbaOrVal(bSta, bStaZ),
      Height: formatHeight(bHeight),
      Dash: bit.dash,
      "Burst Res": bit.burstRes,
      Weight: weightStr(bWeight),
    };
  }

  // ================= GRAND =================
  const gAtk = blade.atk + (bAtkZ ? 0 : bAtk);
  const gDef = blade.def + (bDefZ ? 0 : bDef);
  const gSta = blade.sta + (bStaZ ? 0 : bSta);

  const anyZeroStat = topAtkZ || topDefZ || topStaZ || bAtkZ || bDefZ || bStaZ;

  const type = anyZeroStat
    ? "TBA"
    : getType(gAtk, gDef, gSta, isRB);

  // ================= NAME =================
  let comboName = blade.codename;
  if (isRB) comboName += rb.codename;
  else comboName += (ratchet ? ratchet.name : "") + bit.codename;

  const bDash = isRB ? rb.dash : bit.dash;
  const bBurstRes = isRB ? rb.burstRes : bit.burstRes;

  const bHeightFinal = isRB ? rb.height : (ratchet ? ratchet.height : null);

  // ================= SAVE HISTORY =================
  saveHistory("BX", {
    comboName,
    parts: {
      blade: blade.name,
      ratchet: ratchet ? ratchet.name : null,
      bit: bit ? bit.name : null,
      ratchetBit: rb ? rb.name : null
    },

    top: topStats,
    bottom: bottomStats,

    grandTotal: {
      ATK: anyZeroStat ? "TBA" : gAtk,
      DEF: anyZeroStat ? "TBA" : gDef,
      STA: anyZeroStat ? "TBA" : gSta,

      Weight: formatWeight(blade.weight + (bWeight || 0)) + " g",
      Dash: bDash,
      BurstRes: bBurstRes,
      Height: formatHeight(bHeightFinal)
    }
  });

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    comboName,

    type: typeLogo(type),

    grandTotal: {
      ATK: anyZeroStat ? "TBA" : tbaOrVal(gAtk, bAtkZ),
      DEF: anyZeroStat ? "TBA" : tbaOrVal(gDef, bDefZ),
      STA: anyZeroStat ? "TBA" : tbaOrVal(gSta, bStaZ),

      Height: formatHeight(bHeightFinal),
      Dash: bDash,
      "Burst Res": bBurstRes,

      Weight: weightStr(blade.weight + (bWeight || 0), anyZeroStat),

      "Spin Direction": spinLogo(blade.spindirection),

      ...(blade.modes
        ? { "Blade Mode": blade.modes[blade.currentMode].modeName }
        : {}),

      ...(isRB && rb.modes
        ? { "Ratchet-Bit Mode": rb.modes[rb.currentMode].modeName }
        : {})
    },
  });
}

// --- CX calculation ---
function calcCX(form) {
  const lcIdx = form.querySelector('[name="lockChip"]').value;
  const mbIdx = form.querySelector('[name="mainBlade"]').value;
  const abIdx = form.querySelector('[name="assistBlade"]').value;
  const rIdx = form.querySelector('[name="ratchet"]').value;
  const bIdx = form.querySelector('[name="bit"]').value;
  const rbIdx = form.querySelector('[name="ratchetBit"]').value;

  if (lcIdx === "" || mbIdx === "" || abIdx === "") {
    return renderResult({
      status: "Failure",
      message: "Please select all top components."
    });
  }

  const lc = DATA.lockChips[lcIdx];
  const mb = DATA.mainBlades[mbIdx];
  const ab = DATA.assistBlades[abIdx];
  const ratchet = rIdx !== "" ? DATA.ratchets[rIdx] : null;
  const bit = bIdx !== "" ? DATA.bits[bIdx] : null;
  const rb = rbIdx !== "" ? DATA.ratchetBits[rbIdx] : null;

  const hasValidBottom = (ratchet && bit) || rb;

  if (!hasValidBottom) {
    return renderResult({
      status: "Failure",
      message: "One or more components not found"
    });
  }

  // ================= TOP =================
  const topAtk = mb.atk + ab.atk;
  const topDef = mb.def + ab.def;
  const topSta = mb.sta + ab.sta;

  const topAtkZ = mb.atk === 0 || ab.atk === 0;
  const topDefZ = mb.def === 0 || ab.def === 0;
  const topStaZ = mb.sta === 0 || ab.sta === 0;

  const topWeight = lc.weight + mb.weight + ab.weight;

  // ================= BOTTOM =================
  let bAtk, bDef, bSta, bWeight, bHeight;
  let bAtkZ, bDefZ, bStaZ, bWeightZ;

  if (rb) {
    bAtk = rb.atk;
    bDef = rb.def;
    bSta = rb.sta;
    bWeight = rb.weight;
    bHeight = rb.height;

    bAtkZ = rb.atk === 0;
    bDefZ = rb.def === 0;
    bStaZ = rb.sta === 0;
    bWeightZ = rb.weight === 0;

  } else {
    bAtk = ratchet.atk + bit.atk;
    bDef = ratchet.def + bit.def;
    bSta = ratchet.sta + bit.sta;
    bWeight = ratchet.weight + bit.weight;
    bHeight = ratchet.height;

    bAtkZ = ratchet.atk === 0 || bit.atk === 0;
    bDefZ = ratchet.def === 0 || bit.def === 0;
    bStaZ = ratchet.sta === 0 || bit.sta === 0;
    bWeightZ = ratchet.weight === 0 || bit.weight === 0;
  }

  // ================= GRAND TOTAL =================
  const gAtk = topAtk + (bAtkZ ? 0 : bAtk);
  const gDef = topDef + (bDefZ ? 0 : bDef);
  const gSta = topSta + (bStaZ ? 0 : bSta);

  const anyZeroStat =
    topAtkZ || topDefZ || topStaZ ||
    bAtkZ || bDefZ || bStaZ;

  const isRB = !!rb;

  // ================= HEIGHT (FIXED) =================
  const totalHeight =
    (bHeight == null || ab.height == null || bHeight === 0 || ab.height === 0)
      ? "TBA"
      : `${((Number(bHeight) + Number(ab.height)) / 10).toFixed(1)} mm`;

  // ================= NAME =================
  let comboName = lc.codename + mb.codename + ab.codename;
  comboName += rb ? rb.codename : ratchet.name + bit.codename;

  const bDash = rb ? rb.dash : bit.dash;
  const bBurstRes = rb ? rb.burstRes : bit.burstRes;

  // ================= TYPE =================
  const type = anyZeroStat
    ? "TBA"
    : getType(gAtk, gDef, gSta, isRB);

  // ================= SAVE HISTORY =================
  saveHistory("CX", {
    comboName,

    parts: {
      lockChip: lc.name,
      mainBlade: mb.name,
      assistBlade: ab.name,
      ratchet: ratchet ? ratchet.name : null,
      bit: bit ? bit.name : null,
      ratchetBit: rb ? rb.name : null
    },

    top: {
      ATK: topAtk,
      DEF: topDef,
      STA: topSta,
      Weight: topWeight
    },

    bottom: rb
      ? { type: "ratchetBit", ATK: bAtk, DEF: bDef, STA: bSta, Weight: bWeight }
      : { type: "ratchet+bit", ATK: bAtk, DEF: bDef, STA: bSta, Weight: bWeight },

    grandTotal: {
      ATK: anyZeroStat ? "TBA" : gAtk,
      DEF: anyZeroStat ? "TBA" : gDef,
      STA: anyZeroStat ? "TBA" : gSta,

      Weight: formatWeight(topWeight + bWeight) + " g",
      Dash: bDash,
      BurstRes: bBurstRes,

      Height: totalHeight
    }
  });

  // ================= RESULT =================
  renderResult({
    status: "Success",
    message: "",
    comboName,

    type: typeLogo(type),

    grandTotal: {
      ATK: anyZeroStat ? "TBA" : tbaOrVal(gAtk, topAtkZ || bAtkZ),
      DEF: anyZeroStat ? "TBA" : tbaOrVal(gDef, topDefZ || bDefZ),
      STA: anyZeroStat ? "TBA" : tbaOrVal(gSta, topStaZ || bStaZ),

      Height: totalHeight,
      Dash: bDash,
      "Burst Res": bBurstRes,

      Weight: weightStr(topWeight + bWeight, false),

      "Spin Direction": spinLogo(mb.spindirection),
    },
  });
}

// --- CX Expand calculation ---
function calcCXExpand(form) {
  const lcIdx = form.querySelector('[name="lockChip"]').value;
  const mbIdx = form.querySelector('[name="metalBlade"]').value;
  const obIdx = form.querySelector('[name="overBlade"]').value;
  const abIdx = form.querySelector('[name="assistBlade"]').value;
  const rIdx = form.querySelector('[name="ratchet"]').value;
  const bIdx = form.querySelector('[name="bit"]').value;
  const rbIdx = form.querySelector('[name="ratchetBit"]').value;

  if (lcIdx === "" || mbIdx === "" || abIdx === "") {
    return renderResult({
      status: "Failure",
      message: "Please select all required top components."
    });
  }

  const lc = DATA.lockChips[lcIdx];
  const metalBlade = DATA.metalBlades[mbIdx];
  const overBlade = obIdx !== "" ? DATA.overBlades[obIdx] : null;
  const ab = DATA.assistBlades[abIdx];

  const ratchet = rIdx !== "" ? DATA.ratchets[rIdx] : null;
  const bit = bIdx !== "" ? DATA.bits[bIdx] : null;
  const rb = rbIdx !== "" ? DATA.ratchetBits[rbIdx] : null;

  const hasValidBottom = (ratchet && bit) || rb;

  if (!hasValidBottom) {
    return renderResult({
      status: "Failure",
      message: "One or more components not found"
    });
  }

  // ================= TOP =================
  let topAtk = metalBlade.atk + ab.atk;
  let topDef = metalBlade.def + ab.def;
  let topSta = metalBlade.sta + ab.sta;

  let topAtkZ = metalBlade.atk === 0 || ab.atk === 0;
  let topDefZ = metalBlade.def === 0 || ab.def === 0;
  let topStaZ = metalBlade.sta === 0 || ab.sta === 0;

  let topWeight = lc.weight + metalBlade.weight + ab.weight;

  if (overBlade) {
    topAtk += overBlade.atk;
    topDef += overBlade.def;
    topSta += overBlade.sta;

    topAtkZ = topAtkZ || overBlade.atk === 0;
    topDefZ = topDefZ || overBlade.def === 0;
    topStaZ = topStaZ || overBlade.sta === 0;

    topWeight += overBlade.weight;
  }

  // ================= BOTTOM =================
  let bAtk, bDef, bSta, bWeight, bHeight;
  let bAtkZ, bDefZ, bStaZ;

  if (rb) {
    bAtk = rb.atk;
    bDef = rb.def;
    bSta = rb.sta;
    bWeight = rb.weight;
    bHeight = rb.height;

    bAtkZ = rb.atk === 0;
    bDefZ = rb.def === 0;
    bStaZ = rb.sta === 0;
  } else {
    bAtk = ratchet.atk + bit.atk;
    bDef = ratchet.def + bit.def;
    bSta = ratchet.sta + bit.sta;
    bWeight = ratchet.weight + bit.weight;
    bHeight = ratchet.height;

    bAtkZ = ratchet.atk === 0 || bit.atk === 0;
    bDefZ = ratchet.def === 0 || bit.def === 0;
    bStaZ = ratchet.sta === 0 || bit.sta === 0;
  }

  // ================= GRAND TOTAL =================
  const gAtk = topAtk + bAtk;
  const gDef = topDef + bDef;
  const gSta = topSta + bSta;
  const gWeight = topWeight + bWeight;

  const gAtkTBA = topAtkZ || bAtkZ;
  const gDefTBA = topDefZ || bDefZ;
  const gStaTBA = topStaZ || bStaZ;

  const isAnyStatTBA = gAtkTBA || gDefTBA || gStaTBA;

  // ================= HEIGHT FIXED (NEW) =================
  const totalHeight =
    (bHeight == null || ab.height == null || bHeight === 0 || ab.height === 0)
      ? "TBA"
      : `${((Number(bHeight) + Number(ab.height)) / 10).toFixed(1)} mm`;

  const comboName =
    lc.codename +
    metalBlade.codename +
    (overBlade ? overBlade.codename : "") +
    ab.codename +
    (rb ? rb.codename : ratchet.name + bit.codename);

  const bDash = rb ? rb.dash : bit.dash;
  const bBurstRes = rb ? rb.burstRes : bit.burstRes;

  saveHistory("CX_EXPAND", {
    comboName,
    mode: "CX_EXPAND",

    type: isAnyStatTBA
      ? "TBA"
      : getType(gAtk, gDef, gSta, !!rb),

    parts: {
      lockChip: lc.name,
      metalBlade: metalBlade.name,
      overBlade: overBlade ? overBlade.name : null,
      assistBlade: ab.name,
      ratchet: ratchet ? ratchet.name : null,
      bit: bit ? bit.name : null,
      ratchetBit: rb ? rb.name : null,
    },

    top: {
      ATK: topAtk,
      DEF: topDef,
      STA: topSta,
      Weight: topWeight
    },

    bottom: rb
      ? { type: "ratchetBit", ATK: bAtk, DEF: bDef, STA: bSta, Weight: bWeight }
      : { type: "ratchet+bit", ATK: bAtk, DEF: bDef, STA: bSta, Weight: bWeight },

    grandTotal: {
      ATK: gAtkTBA ? "TBA" : gAtk,
      DEF: gDefTBA ? "TBA" : gDef,
      STA: gStaTBA ? "TBA" : gSta,

      Weight: formatWeight(gWeight) + " g",
      Dash: bDash,
      BurstRes: bBurstRes,
      Height: totalHeight
    }
  });

  renderResult({
    status: "Success",
    message: "",
    comboName,

    type: isAnyStatTBA
      ? typeLogo("TBA")
      : typeLogo(getType(gAtk, gDef, gSta, !!rb)),

    grandTotal: {
      ATK: gAtkTBA ? "TBA" : gAtk,
      DEF: gDefTBA ? "TBA" : gDef,
      STA: gStaTBA ? "TBA" : gSta,

      // ✅ ORDER FIXED HERE
      Height: totalHeight,
      Dash: bDash,
      "Burst Res": bBurstRes,
      Weight: formatWeight(gWeight) + " g",

      "Spin Direction": spinLogo(metalBlade.spindirection)
    }
  });
}

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
      // Default: enable everything, clear filters
      ratchetWrapper._setFilter(null);
      ratchetWrapper._filterFn = null;
      ratchetInput.disabled = false;
      ratchetInput.placeholder = "-- Select --";
      rbInput.disabled = false;
      rbInput.placeholder = "-- Select --";
    }
  });
})();

// --- Generic multi-mode item button ---
function setupModeButton(form, selectName, dataArray) {
  const sel = form.querySelector(`[name="${selectName}"]`);
  if (!sel) return;
  const label = sel.closest("label");
  if (!label) return;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-mode hidden";
  btn.dataset.modeFor = selectName;
  label.parentNode.insertBefore(btn, label.nextSibling);

  function applyMode(item) {
    const m = item.modes[item.currentMode];
    for (const k in m) {
      if (k !== "modeName") item[k] = m[k];
    }
  }

  function refreshBtn() {
    const idx = sel.value;
    if (idx === "") { btn.classList.add("hidden"); return; }
    const item = dataArray[idx];
    if (!item || !item.modes) { btn.classList.add("hidden"); return; }
    btn.classList.remove("hidden");
    btn.textContent = `Mode: ${item.modes[item.currentMode].modeName} (click to switch)`;
  }

  sel.addEventListener("change", () => {
    const idx = sel.value;
    if (idx !== "") {
      const item = dataArray[idx];
      if (item && item.modes) {
        item.currentMode = 0;
        applyMode(item);
      }
    }
    refreshBtn();
  });

  btn.addEventListener("click", () => {
    const idx = sel.value;
    if (idx === "") return;
    const item = dataArray[idx];
    if (!item || !item.modes) return;
    item.currentMode = (item.currentMode + 1) % item.modes.length;
    applyMode(item);
    refreshBtn();
    if (!document.getElementById("result").classList.contains("hidden")) {
      form.requestSubmit();
    }
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

  ratchetSel.addEventListener("change", () => {
    // Skip if already disabled by blade logic (Clock Mirage / Bullet Griffon)
    const bladeSel = form.querySelector('[name="blade"]');
    if (bladeSel) {
      const idx = bladeSel.value;
      if (idx !== "" && (DATA.blades[idx].codename === "CLOCKMIRAGE" || DATA.blades[idx].codename === "BULLETGRIFFON")) return;
    }

    if (ratchetSel.value !== "") {
      rbWrapper._clear();
      rbInput.disabled = true;
      rbInput.placeholder = "Not available";
    } else {
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
    // Re-enable dropdowns that may have been disabled
    const rInput = form.querySelector('[name="ratchet"]')?.nextElementSibling?.querySelector("input");
    if (rInput) { rInput.disabled = false; rInput.placeholder = "-- Select --"; }
    const bInput = form.querySelector('[name="bit"]')?.nextElementSibling?.querySelector("input");
    if (bInput) { bInput.disabled = false; bInput.placeholder = "-- Select --"; }
    const rbInput = form.querySelector('[name="ratchetBit"]')?.nextElementSibling?.querySelector("input");
    if (rbInput) { rbInput.disabled = false; rbInput.placeholder = "-- Select --"; }
    form.querySelectorAll(".btn-mode").forEach(b => b.classList.add("hidden"));
    document.getElementById("result").classList.add("hidden");
  });
});

// --- I'm Feeling Lucky ---
function randIdx(arr) { return Math.floor(Math.random() * arr.length); }

function getWrapper(form, name) { return form.querySelector(`[name="${name}"]`).nextElementSibling; }

document.querySelectorAll(".btn-lucky").forEach(btn => {
  btn.addEventListener("click", () => {
    const form = btn.closest("form");
    // Reset first
    form.querySelector(".btn-reset").click();

    const mode = form.id.replace("form-", "");

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

    // Auto-calculate
    form.requestSubmit();
  });
});

// --- Update popup ---
(function () {
  const popup = document.getElementById("update-popup");
  if (!popup) return;

  popup.classList.remove("hidden");
  const dismiss = () => { popup.classList.add("hidden"); };
  popup.querySelector(".popup-close").addEventListener("click", dismiss);
  popup.querySelector(".popup-ok").addEventListener("click", dismiss);
  popup.addEventListener("click", e => { if (e.target === popup) dismiss(); });
  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") { dismiss(); document.removeEventListener("keydown", onEsc); }
  });
})();

function initLibrarySearch() {
  const input = document.getElementById("library-search");
  const btn = document.getElementById("library-search-btn");
  const results = document.getElementById("library-results");

  if (!input || !btn || !results) {
    console.error("Library elements missing");
    return;
  }

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
  ].filter(item => item && item.name);

  // =========================
  // 🧠 CORE HELPERS
  // =========================

  function getFolder(item) {
    if (DATA.blades?.includes(item)) return "blades";
    if (DATA.lockChips?.includes(item)) return "lockChips";
    if (DATA.ratchetBits?.includes(item)) return "ratchetBits";
    if (DATA.bits?.includes(item)) return "bits";
    if (DATA.ratchets?.includes(item)) return "ratchets";
    if (DATA.mainBlades?.includes(item)) return "mainBlades";
    if (DATA.assistBlades?.includes(item)) return "assistBlades";
    if (DATA.metalBlades?.includes(item)) return "metalBlades";
    if (DATA.overBlades?.includes(item)) return "overBlades";
    return "misc";
  }

  function getBaseName(item) {
    return (item.name || "")
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/-/g, "");
  }

  function hasModes(item) {
    return Array.isArray(item.modes) && item.modes.length > 0;
  }

  function getImage(item, index = 0) {
    const base = getBaseName(item);
    const folder = getFolder(item);

    if (hasModes(item)) {
      return `assets/${folder}/${base}${index}.webp`;
    }

    return `assets/${folder}/${base}.webp`;
  }

  // =========================
  // 📊 STATS RENDER (HEIGHT FIXED)
  // =========================

  function renderStats(obj) {
    return Object.entries(obj)
      .filter(([k, v]) =>
        v !== undefined &&
        v !== null &&
        typeof v !== "object" &&
        k.toLowerCase() !== "name"   // ✅ REMOVE NAME FROM DATA
      )
      .map(([k, v]) => {

        // HEIGHT FIX (÷10 + mm)
        if (k.toLowerCase() === "height") {
          const num = Number(v);
          if (!isNaN(num)) {
            v = `${(num / 10).toFixed(1)} mm`;
          }
        }

        // weight formatting
        if (k.toLowerCase() === "weight") {
          v = `${v} g`;
        }

        return `<div class="stat-line"><b>${k.toUpperCase()}:</b> ${v}</div>`;
      })
      .join("");
  }

  // =========================
  // 🎮 FORMAT ITEM
  // =========================

  function formatItem(item) {
    const hasM = hasModes(item);

    const index = item.currentMode ?? 0;
    const safeIndex = Math.min(index, hasM ? item.modes.length - 1 : 0);

    const mode = hasM ? item.modes[safeIndex] : item;

    return `
      <div class="stat-card drag-card"
        data-name="${item.name}"
        data-mode-index="${safeIndex}"
      >

        <img 
          src="${getImage(item, safeIndex)}"
          alt="${item.name}"
          class="part-img"
          onerror="this.style.display='none'"
        />

        <div class="stat-info">
          <strong>${item.name}</strong><br>

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
  // 🔍 SEARCH ENGINE
  // =========================

  function runSearch() {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = "";

    if (!q) {
      results.style.maxHeight = "0px";
      return;
    }

    let filtered = [];

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
          results.innerHTML = `<div class="search-item">Unknown command</div>`;
          results.style.maxHeight = "200px";
          return;
      }
    } else {
      filtered = ALL_PARTS.filter(p =>
        p.name.toLowerCase().includes(q)
      );
    }

    if (filtered.length === 0) {
      results.innerHTML = `<div class="search-item">No results found</div>`;
      results.style.maxHeight = "200px";
      return;
    }

    results.style.maxHeight = "400px";

    filtered.slice(0, 100).forEach(item => {
      const div = document.createElement("div");
      div.className = "search-item";
      div.innerHTML = formatItem(item);
      results.appendChild(div);
    });
  }

  // =========================
  // MODE + EVENTS (UNCHANGED)
  // =========================

  function updateMode(card, item, index) {
    const mode = item.modes[index];

    card.dataset.modeIndex = index;

    card.querySelector(".full-data").innerHTML =
      renderStats(mode);

    const counter = card.querySelector(".mode-counter");
    if (counter) {
      counter.textContent = `${index + 1} / ${item.modes.length}`;
    }

    const img = card.querySelector("img");
    if (img) {
      img.src = getImage(item, index);
    }
  }

  let dragState = {
    active: false,
    startX: 0,
    card: null
  };

  results.addEventListener("mousedown", (e) => {
    const card = e.target.closest(".drag-card");
    if (!card) return;

    const item = ALL_PARTS.find(p => p.name === card.dataset.name);
    if (!item || !item.modes) return;

    dragState.active = true;
    dragState.startX = e.clientX;
    dragState.card = card;
  });

  document.addEventListener("mouseup", () => {
    dragState.active = false;
    dragState.card = null;
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragState.active || !dragState.card) return;

    const item = ALL_PARTS.find(p => p.name === dragState.card.dataset.name);
    if (!item || !item.modes) return;

    const diff = e.clientX - dragState.startX;
    if (Math.abs(diff) < 60) return;

    let index = parseInt(dragState.card.dataset.modeIndex || "0");

    if (diff < 0) index = (index + 1) % item.modes.length;
    else index = (index - 1 + item.modes.length) % item.modes.length;

    updateMode(dragState.card, item, index);
    dragState.active = false;
  });

  results.addEventListener("touchstart", (e) => {
    const card = e.target.closest(".drag-card");
    if (!card) return;

    const item = ALL_PARTS.find(p => p.name === card.dataset.name);
    if (!item || !item.modes) return;

    dragState.active = true;
    dragState.startX = e.touches[0].clientX;
    dragState.card = card;
  });

  results.addEventListener("touchend", (e) => {
    if (!dragState.active || !dragState.card) return;

    const item = ALL_PARTS.find(p => p.name === dragState.card.dataset.name);
    if (!item || !item.modes) return;

    const diff = e.changedTouches[0].clientX - dragState.startX;
    if (Math.abs(diff) < 60) return;

    let index = parseInt(dragState.card.dataset.modeIndex || "0");

    if (diff < 0) index = (index + 1) % item.modes.length;
    else index = (index - 1 + item.modes.length) % item.modes.length;

    updateMode(dragState.card, item, index);
  });

  results.addEventListener("wheel", (e) => {
    const card = e.target.closest(".drag-card");
    if (!card) return;

    const item = ALL_PARTS.find(p => p.name === card.dataset.name);
    if (!item || !item.modes) return;

    e.preventDefault();

    let index = parseInt(card.dataset.modeIndex || "0");

    if (e.deltaY < 0) index = (index - 1 + item.modes.length) % item.modes.length;
    else index = (index + 1) % item.modes.length;

    updateMode(card, item, index);
  }, { passive: false });

  btn.addEventListener("click", runSearch);

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  });
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
    if (value > 100) return "#2ecc71";
    if (value >= 50) return "#f1c40f";
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

  // =========================
  // 🧠 ONLY NON-STAT DATA
  // =========================
  function renderObject(obj) {
    if (!obj) return "";

    // ❌ REMOVE ATK/DEF/STA COMPLETELY
    const EXCLUDE_KEYS = ["ATK", "DEF", "STA"];

    const order = ["Height", "Dash", "BurstRes", "Burst Res", "Weight"];

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

    const max = Math.max(a, d, s);

    if (a < 100 && d < 100 && s < 100) return "Balance";
    if (max === a && a > d && a > s) return "Attack";
    if (max === d && d > a && d > s) return "Defense";
    if (max === s && s > a && s > d) return "Stamina";

    return "Balance";
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

        ${createBar("ATK", atk, isAtkTBA)}
        ${createBar("DEF", def, isDefTBA)}
        ${createBar("STA", sta, isStaTBA)}

        ${renderObject(total)}
      </div>

      <small>${new Date(item.time).toLocaleString()}</small>
      <hr/>
    `;

    container.appendChild(div);
  });
}
