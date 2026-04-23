// docs/js/calculator.js - calculator forms, renderers, lucky-button, settings, mode buttons
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
      // Bullet Griffon: force "No Ratchet"; bit list restricted to normal bits
      ratchetWrapper._filterFn = null;
      ratchetWrapper._select(NO_RATCHET);
      ratchetInput.disabled = true;
      bitWrapper._setFilter(b => !b.isRatchetBit);
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
