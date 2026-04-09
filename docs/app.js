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

// --- Populate dropdowns ---
function populateSelect(sel, items, labelFn) {
  sel.innerHTML = '<option value="">-- Select --</option>';
  items.forEach((item, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = labelFn(item);
    sel.appendChild(opt);
  });
}

function initDropdowns() {
  // Standard
  const stdForm = document.getElementById("form-standard");
  populateSelect(stdForm.querySelector('[name="blade"]'), DATA.blades, b => b.name);
  populateSelect(stdForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name);
  populateSelect(stdForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  populateSelect(stdForm.querySelector('[name="ratchetBit"]'), DATA.ratchetBits, rb => rb.name);

  // CX
  const cxForm = document.getElementById("form-cx");
  populateSelect(cxForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
  populateSelect(cxForm.querySelector('[name="mainBlade"]'), DATA.mainBlades, mb => mb.name);
  populateSelect(cxForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
  populateSelect(cxForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name);
  populateSelect(cxForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  populateSelect(cxForm.querySelector('[name="ratchetBit"]'), DATA.ratchetBits, rb => rb.name);

  // CX Expand
  const cxeForm = document.getElementById("form-cxExpand");
  populateSelect(cxeForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
  populateSelect(cxeForm.querySelector('[name="metalBlade"]'), DATA.metalBlades, mb => mb.name);
  populateSelect(cxeForm.querySelector('[name="overBlade"]'), DATA.overBlades, ob => ob.name);
  populateSelect(cxeForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
  populateSelect(cxeForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name);
  populateSelect(cxeForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  populateSelect(cxeForm.querySelector('[name="ratchetBit"]'), DATA.ratchetBits, rb => rb.name);
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

  // Top
  html += renderStatTable("Top", res.top);
  // Bottom
  html += renderStatTable("Bottom", res.bottom);
  // Grand Total
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

  if (!hasValidBottom || clockMirageMismatch || clockMirageInvalidBit) {
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

  renderResult({
    status: "Success", message: "Combo created successfully", comboName,
    type: getType(gAtk, gDef, gSta, isRB),
    top: topStats, bottom: bottomStats,
    grandTotal: {
      ATK: tbaOrVal(gAtk, gAtkZ), DEF: tbaOrVal(gDef, gDefZ), STA: tbaOrVal(gSta, gStaZ),
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

  renderResult({
    status: "Success", message: "Combo created successfully", comboName, type: getType(gAtk, gDef, gSta, isRB),
    top: topStats, bottom: bottomStats,
    grandTotal: { ATK: tbaOrVal(gAtk, gAtkZ), DEF: tbaOrVal(gDef, gDefZ), STA: tbaOrVal(gSta, gStaZ), Weight: weightStr(topWeight + bWeight, gWeightZ), Type: getType(gAtk, gDef, gSta, isRB), "Spin Direction": mb.spindirection },
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

  renderResult({
    status: "Success", message: "Combo expanded successfully", comboName, type: getType(gAtk, gDef, gSta, isRB),
    top: topStats, bottom: bottomStats,
    grandTotal: { ATK: tbaOrVal(gAtk, gAtkZ), DEF: tbaOrVal(gDef, gDefZ), STA: tbaOrVal(gSta, gStaZ), Weight: weightStr(topWeight + bWeight, gWeightZ), Type: getType(gAtk, gDef, gSta, isRB), "Spin Direction": metalBlade.spindirection },
  });
}

// --- Form handlers ---
document.getElementById("form-standard").addEventListener("submit", e => { e.preventDefault(); calcStandard(e.target); });
document.getElementById("form-cx").addEventListener("submit", e => { e.preventDefault(); calcCX(e.target); });
document.getElementById("form-cxExpand").addEventListener("submit", e => { e.preventDefault(); calcCXExpand(e.target); });

// --- Init ---
initDropdowns();
