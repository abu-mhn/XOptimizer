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
function weightStr(w, hasZero) { return hasZero ? "TBA" : w.toFixed(2) + "g"; }

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
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".calc-form").forEach(f => f.classList.add("hidden"));
    document.getElementById("form-" + tab.dataset.mode).classList.remove("hidden");
    document.getElementById("result").classList.add("hidden");
  });
});

// --- Rendering ---
function renderStatTable(label, stats) {
  let rows = "";
  for (const [k, v] of Object.entries(stats)) {
    rows += `<tr><th>${k}</th><td>${v}</td></tr>`;
  }
  return `<div class="section-title">${label}</div><table>${rows}</table>`;
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

  let html = `<h2 class="status-success">${res.message}</h2>`;
  if (res.comboName) {
    html += `<div class="combo-name">${res.comboName} <span class="type-badge">${res.type}</span></div>`;
  }

  html += renderStatBars(res.grandTotal);
  html += renderStatTable("Grand Total", res.grandTotal);

  el.innerHTML = html;
}

// --- Standard calculation ---
function calcStandard(form) {
  const bladeIdx = form.querySelector('[name="blade"]').value;
  const ratchetIdx = form.querySelector('[name="ratchet"]').value;
  const bitIdx = form.querySelector('[name="bit"]').value;
  const rbIdx = form.querySelector('[name="ratchetBit"]').value;

  if (bladeIdx === "") return renderResult({ status: "Failure", message: "Please select a blade." });

  const blade = DATA.blades[bladeIdx];
  const ratchet = ratchetIdx !== "" ? DATA.ratchets[ratchetIdx] : null;
  const bit = bitIdx !== "" ? DATA.bits[bitIdx] : null;
  const rb = rbIdx !== "" ? DATA.ratchetBits[rbIdx] : null;

  const isBulletGriffon = blade.codename === "BULLETGRIFFON";
  const isClockMirage = blade.codename === "CLOCKMIRAGE";

  const hasValidBottom = (ratchet && bit) || rb || (isBulletGriffon && bit);

  const clockMirageMismatch = isClockMirage && (!ratchet || !ratchet.name.endsWith("5")) && !rb;
  const clockMirageInvalidBit = isClockMirage && rb;
  const bulletGriffonInvalid = isBulletGriffon && (ratchet || rb);

  if (!hasValidBottom || clockMirageMismatch || clockMirageInvalidBit || bulletGriffonInvalid) {
    return renderResult({ status: "Failure", message: "Combo failed to create" });
  }

  // Top stats
  const topAtkZ = blade.atk === 0, topDefZ = blade.def === 0, topStaZ = blade.sta === 0;
  const topWeightZ = blade.weight === 0;
  const topStats = {
    Blade: blade.name,
    ATK: tbaOrVal(blade.atk, topAtkZ),
    DEF: tbaOrVal(blade.def, topDefZ),
    STA: tbaOrVal(blade.sta, topStaZ),
    Weight: weightStr(blade.weight, topWeightZ),
    "Spin Direction": blade.spindirection,
  };

  // Bottom stats
  let bottomStats = {};
  let bAtk, bDef, bSta, bWeight;
  let bAtkZ, bDefZ, bStaZ, bWeightZ;

  if (rb && !isClockMirage) {
    bAtkZ = rb.atk === 0; bDefZ = rb.def === 0; bStaZ = rb.sta === 0; bWeightZ = rb.weight === 0;
    bAtk = rb.atk; bDef = rb.def; bSta = rb.sta; bWeight = rb.weight;
    bottomStats = {
      "Ratchet-Bit": rb.name,
      ATK: tbaOrVal(bAtk, bAtkZ), DEF: tbaOrVal(bDef, bDefZ), STA: tbaOrVal(bSta, bStaZ),
      Height: rb.height, Dash: rb.dash, "Burst Res": rb.burstRes,
      Weight: weightStr(bWeight, bWeightZ),
    };
  } else {
    const rAtk = ratchet ? ratchet.atk : 0, rDef = ratchet ? ratchet.def : 0, rSta = ratchet ? ratchet.sta : 0;
    const rW = ratchet ? ratchet.weight : 0;
    bAtk = isBulletGriffon ? bit.atk : rAtk + bit.atk;
    bDef = isBulletGriffon ? bit.def : rDef + bit.def;
    bSta = isBulletGriffon ? bit.sta : rSta + bit.sta;
    bAtkZ = isBulletGriffon ? bit.atk === 0 : rAtk === 0 || bit.atk === 0;
    bDefZ = isBulletGriffon ? bit.def === 0 : rDef === 0 || bit.def === 0;
    bStaZ = isBulletGriffon ? bit.sta === 0 : rSta === 0 || bit.sta === 0;
    bWeight = isBulletGriffon ? bit.weight : rW + bit.weight;
    bWeightZ = isBulletGriffon ? bit.weight === 0 : rW === 0 || bit.weight === 0;
    bottomStats = {};
    if (ratchet) bottomStats["Ratchet"] = ratchet.name;
    bottomStats["Bit"] = bit.name;
    bottomStats["ATK"] = tbaOrVal(bAtk, bAtkZ);
    bottomStats["DEF"] = tbaOrVal(bDef, bDefZ);
    bottomStats["STA"] = tbaOrVal(bSta, bStaZ);
    if (ratchet) bottomStats["Height"] = ratchet.height;
    bottomStats["Dash"] = bit.dash;
    bottomStats["Burst Res"] = bit.burstRes;
    bottomStats["Weight"] = weightStr(bWeight, bWeightZ);
  }

  // Grand total
  const gAtkZ = topAtkZ || bAtkZ, gDefZ = topDefZ || bDefZ, gStaZ = topStaZ || bStaZ;
  const gWeightZ = topWeightZ || bWeightZ;
  const gAtk = blade.atk + (bAtkZ ? 0 : bAtk);
  const gDef = blade.def + (bDefZ ? 0 : bDef);
  const gSta = blade.sta + (bStaZ ? 0 : bSta);
  const isRB = !!rb && !isClockMirage;

  // Combo name
  let comboName = blade.codename;
  if (rb && !isClockMirage) {
    comboName += rb.codename;
  } else {
    if (ratchet) comboName += ratchet.name;
    comboName += bit.codename;
  }

  const bDash = rb && !isClockMirage ? rb.dash : bit.dash;
  const bBurstRes = rb && !isClockMirage ? rb.burstRes : bit.burstRes;
  const bHeight = rb && !isClockMirage ? rb.height : (ratchet ? ratchet.height : null);

  renderResult({
    status: "Success", message: "Combo created successfully", comboName,
    type: getType(gAtk, gDef, gSta, isRB),
    grandTotal: {
      ATK: tbaOrVal(gAtk, gAtkZ), DEF: tbaOrVal(gDef, gDefZ), STA: tbaOrVal(gSta, gStaZ),
      ...(bHeight != null ? { Height: bHeight } : {}),
      Dash: bDash, "Burst Res": bBurstRes,
      Weight: weightStr(blade.weight + bWeight, gWeightZ),
      Type: getType(gAtk, gDef, gSta, isRB),
      "Spin Direction": blade.spindirection,
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
    return renderResult({ status: "Failure", message: "Please select all top components." });
  }

  const lc = DATA.lockChips[lcIdx];
  const mb = DATA.mainBlades[mbIdx];
  const ab = DATA.assistBlades[abIdx];
  const ratchet = rIdx !== "" ? DATA.ratchets[rIdx] : null;
  const bit = bIdx !== "" ? DATA.bits[bIdx] : null;
  const rb = rbIdx !== "" ? DATA.ratchetBits[rbIdx] : null;

  const hasValidBottom = (ratchet && bit) || rb;
  if (!hasValidBottom) return renderResult({ status: "Failure", message: "One or more components not found" });

  const topAtk = mb.atk + ab.atk, topDef = mb.def + ab.def, topSta = mb.sta + ab.sta;
  const topAtkZ = mb.atk === 0 || ab.atk === 0;
  const topDefZ = mb.def === 0 || ab.def === 0;
  const topStaZ = mb.sta === 0 || ab.sta === 0;
  const topWeight = lc.weight + mb.weight + ab.weight;
  const topWeightZ = lc.weight === 0 || mb.weight === 0 || ab.weight === 0;

  const topStats = {
    "Lock Chip": lc.name, "Main Blade": mb.name, "Assist Blade": ab.name,
    ATK: tbaOrVal(topAtk, topAtkZ), DEF: tbaOrVal(topDef, topDefZ), STA: tbaOrVal(topSta, topStaZ),
    Weight: weightStr(topWeight, topWeightZ), "Spin Direction": mb.spindirection,
  };

  let bottomStats = {}, bAtk, bDef, bSta, bWeight, bAtkZ, bDefZ, bStaZ, bWeightZ;
  if (rb) {
    bAtk = rb.atk; bDef = rb.def; bSta = rb.sta; bWeight = rb.weight;
    bAtkZ = rb.atk === 0; bDefZ = rb.def === 0; bStaZ = rb.sta === 0; bWeightZ = rb.weight === 0;
    bottomStats = { "Ratchet-Bit": rb.name, ATK: tbaOrVal(bAtk, bAtkZ), DEF: tbaOrVal(bDef, bDefZ), STA: tbaOrVal(bSta, bStaZ), Height: rb.height, Dash: rb.dash, "Burst Res": rb.burstRes, Weight: weightStr(bWeight, bWeightZ) };
  } else {
    bAtk = ratchet.atk + bit.atk; bDef = ratchet.def + bit.def; bSta = ratchet.sta + bit.sta;
    bAtkZ = ratchet.atk === 0 || bit.atk === 0; bDefZ = ratchet.def === 0 || bit.def === 0; bStaZ = ratchet.sta === 0 || bit.sta === 0;
    bWeight = ratchet.weight + bit.weight;
    bWeightZ = ratchet.weight === 0 || bit.weight === 0;
    bottomStats = { Ratchet: ratchet.name, Bit: bit.name, ATK: tbaOrVal(bAtk, bAtkZ), DEF: tbaOrVal(bDef, bDefZ), STA: tbaOrVal(bSta, bStaZ), Height: ratchet.height, Dash: bit.dash, "Burst Res": bit.burstRes, Weight: weightStr(bWeight, bWeightZ) };
  }

  const gAtkZ = topAtkZ || bAtkZ, gDefZ = topDefZ || bDefZ, gStaZ = topStaZ || bStaZ, gWeightZ = topWeightZ || bWeightZ;
  const gAtk = topAtk + (bAtkZ ? 0 : bAtk), gDef = topDef + (bDefZ ? 0 : bDef), gSta = topSta + (bStaZ ? 0 : bSta);
  const isRB = !!rb;

  let comboName = lc.codename + mb.codename + ab.codename;
  comboName += rb ? rb.codename : ratchet.name + bit.codename;

  const bDash = rb ? rb.dash : bit.dash;
  const bBurstRes = rb ? rb.burstRes : bit.burstRes;
  const bHeight = rb ? rb.height : ratchet.height;

  renderResult({
    status: "Success", message: "Combo created successfully", comboName, type: getType(gAtk, gDef, gSta, isRB),
    grandTotal: { ATK: tbaOrVal(gAtk, gAtkZ), DEF: tbaOrVal(gDef, gDefZ), STA: tbaOrVal(gSta, gStaZ), Height: bHeight, Dash: bDash, "Burst Res": bBurstRes, Weight: weightStr(topWeight + bWeight, gWeightZ), Type: getType(gAtk, gDef, gSta, isRB), "Spin Direction": mb.spindirection },
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
    return renderResult({ status: "Failure", message: "Please select all required top components." });
  }

  const lc = DATA.lockChips[lcIdx];
  const metalBlade = DATA.metalBlades[mbIdx];
  const overBlade = obIdx !== "" ? DATA.overBlades[obIdx] : null;
  const ab = DATA.assistBlades[abIdx];
  const ratchet = rIdx !== "" ? DATA.ratchets[rIdx] : null;
  const bit = bIdx !== "" ? DATA.bits[bIdx] : null;
  const rb = rbIdx !== "" ? DATA.ratchetBits[rbIdx] : null;

  const hasValidBottom = (ratchet && bit) || rb;
  if (!hasValidBottom) return renderResult({ status: "Failure", message: "One or more components not found" });

  let topAtk = metalBlade.atk + ab.atk, topDef = metalBlade.def + ab.def, topSta = metalBlade.sta + ab.sta;
  let topAtkZ = metalBlade.atk === 0 || ab.atk === 0;
  let topDefZ = metalBlade.def === 0 || ab.def === 0;
  let topStaZ = metalBlade.sta === 0 || ab.sta === 0;
  let topWeight = lc.weight + metalBlade.weight + ab.weight;
  let topWeightZ = lc.weight === 0 || metalBlade.weight === 0 || ab.weight === 0;

  if (overBlade) {
    topAtk += overBlade.atk; topDef += overBlade.def; topSta += overBlade.sta;
    topAtkZ = topAtkZ || overBlade.atk === 0;
    topDefZ = topDefZ || overBlade.def === 0;
    topStaZ = topStaZ || overBlade.sta === 0;
    topWeight += overBlade.weight;
    topWeightZ = topWeightZ || overBlade.weight === 0;
  }

  const topStats = {
    "Lock Chip": lc.name, "Metal Blade": metalBlade.name,
    ...(overBlade ? { "Over Blade": overBlade.name } : {}),
    "Assist Blade": ab.name,
    ATK: tbaOrVal(topAtk, topAtkZ), DEF: tbaOrVal(topDef, topDefZ), STA: tbaOrVal(topSta, topStaZ),
    Weight: weightStr(topWeight, topWeightZ), "Spin Direction": metalBlade.spindirection,
  };

  let bottomStats = {}, bAtk, bDef, bSta, bWeight, bAtkZ, bDefZ, bStaZ, bWeightZ;
  if (rb) {
    bAtk = rb.atk; bDef = rb.def; bSta = rb.sta; bWeight = rb.weight;
    bAtkZ = rb.atk === 0; bDefZ = rb.def === 0; bStaZ = rb.sta === 0; bWeightZ = rb.weight === 0;
    bottomStats = { "Ratchet-Bit": rb.name, ATK: tbaOrVal(bAtk, bAtkZ), DEF: tbaOrVal(bDef, bDefZ), STA: tbaOrVal(bSta, bStaZ), Height: rb.height, Dash: rb.dash, "Burst Res": rb.burstRes, Weight: weightStr(bWeight, bWeightZ) };
  } else {
    bAtk = ratchet.atk + bit.atk; bDef = ratchet.def + bit.def; bSta = ratchet.sta + bit.sta;
    bAtkZ = ratchet.atk === 0 || bit.atk === 0; bDefZ = ratchet.def === 0 || bit.def === 0; bStaZ = ratchet.sta === 0 || bit.sta === 0;
    bWeight = ratchet.weight + bit.weight;
    bWeightZ = ratchet.weight === 0 || bit.weight === 0;
    bottomStats = { Ratchet: ratchet.name, Bit: bit.name, ATK: tbaOrVal(bAtk, bAtkZ), DEF: tbaOrVal(bDef, bDefZ), STA: tbaOrVal(bSta, bStaZ), Height: ratchet.height, Dash: bit.dash, "Burst Res": bit.burstRes, Weight: weightStr(bWeight, bWeightZ) };
  }

  const gAtkZ = topAtkZ || bAtkZ, gDefZ = topDefZ || bDefZ, gStaZ = topStaZ || bStaZ, gWeightZ = topWeightZ || bWeightZ;
  const gAtk = topAtk + (bAtkZ ? 0 : bAtk), gDef = topDef + (bDefZ ? 0 : bDef), gSta = topSta + (bStaZ ? 0 : bSta);
  const isRB = !!rb;

  let comboName = lc.codename + metalBlade.codename;
  if (overBlade) comboName += overBlade.codename;
  comboName += ab.codename;
  comboName += rb ? rb.codename : ratchet.name + bit.codename;

  const bDash = rb ? rb.dash : bit.dash;
  const bBurstRes = rb ? rb.burstRes : bit.burstRes;
  const bHeight = rb ? rb.height : ratchet.height;

  renderResult({
    status: "Success", message: "Combo expanded successfully", comboName, type: getType(gAtk, gDef, gSta, isRB),
    grandTotal: { ATK: tbaOrVal(gAtk, gAtkZ), DEF: tbaOrVal(gDef, gDefZ), STA: tbaOrVal(gSta, gStaZ), Height: bHeight, Dash: bDash, "Burst Res": bBurstRes, Weight: weightStr(topWeight + bWeight, gWeightZ), Type: getType(gAtk, gDef, gSta, isRB), "Spin Direction": metalBlade.spindirection },
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
(function() {
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
        if (Math.random() < 0.5 && DATA.ratchetBits.length > 0) {
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
      if (Math.random() < 0.5 && DATA.ratchetBits.length > 0) {
        getWrapper(form, "ratchetBit")._select(randIdx(DATA.ratchetBits));
      } else {
        getWrapper(form, "ratchet")._select(randIdx(DATA.ratchets));
        getWrapper(form, "bit")._select(randIdx(DATA.bits));
      }
    } else if (mode === "cxExpand") {
      getWrapper(form, "lockChip")._select(randIdx(DATA.lockChips));
      getWrapper(form, "metalBlade")._select(randIdx(DATA.metalBlades));
      if (DATA.overBlades.length > 0 && Math.random() < 0.5) {
        getWrapper(form, "overBlade")._select(randIdx(DATA.overBlades));
      }
      getWrapper(form, "assistBlade")._select(randIdx(DATA.assistBlades));
      if (Math.random() < 0.5 && DATA.ratchetBits.length > 0) {
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
