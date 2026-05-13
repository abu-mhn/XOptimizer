// docs/dashboard/dashboard.js — heaviest combo, lightest combo, top-stat
// combos (ATK / DEF / STA), and a deterministic "Combo of the Day" picked
// from a date seed so every visitor sees the same combo until local midnight.

const DASHBOARD_PART_FOLDER = {
  blade: "blades",
  lockChip: "lockChips",
  mainBlade: "mainBlades",
  assistBlade: "assistBlades",
  metalBlade: "metalBlades",
  overBlade: "overBlades",
  ratchet: "ratchets",
  bit: "bits",
  ratchetBit: "ratchetBits"
};

const DASHBOARD_PART_LABEL = {
  blade: "Blade",
  lockChip: "Lock Chip",
  mainBlade: "Main Blade",
  assistBlade: "Assist Blade",
  metalBlade: "Metal Blade",
  overBlade: "Over Blade",
  ratchet: "Ratchet",
  bit: "Bit"
};

const DASHBOARD_MODE_LABEL = {
  standard: "Standard",
  cx: "CX",
  cxExpand: "CX Expand"
};

const DASHBOARD_FIELD_LABEL = {
  weight: "Total Weight",
  atk: "Total ATK",
  def: "Total DEF",
  sta: "Total STA"
};

function dashboardPartList(folder) {
  if (folder === "bits") return (DATA.bits || []).filter(b => !b.isRatchetBit);
  if (folder === "ratchetBits") return (DATA.bits || []).filter(b => b.isRatchetBit);
  return DATA[folder] || [];
}

// dir: 1 picks the largest part by `field`, -1 the smallest.
function dashboardBestPart(list, field, dir) {
  if (!list.length) return null;
  let best = list[0];
  for (let i = 1; i < list.length; i++) {
    const cur = list[i];
    const curV = cur[field] || 0;
    const bestV = best[field] || 0;
    if (dir === 1 && curV > bestV) best = cur;
    if (dir === -1 && curV < bestV) best = cur;
  }
  return best;
}

// Standard-mode blade-specific bottom restrictions, mirroring the
// calculator (calculator.js, see CLOCKMIRAGE / BULLETGRIFFON branches).
// Returns null for blades with no special rules.
function dashboardBladeConfig(blade) {
  if (!blade) return null;
  if (blade.codename === "BULLETGRIFFON") {
    return { noRatchet: true, allowRatchetBit: false, ratchetFilter: null };
  }
  if (blade.codename === "CLOCKMIRAGE") {
    return { noRatchet: false, allowRatchetBit: false, ratchetFilter: r => r.name.endsWith("5") };
  }
  return null;
}

// Returns { parts, value } describing the best bottom assembly for the
// chosen field/direction under optional constraints. Tries regular
// ratchet+bit vs a single ratchet-bit and keeps whichever wins.
function dashboardBuildBottom(field, dir, config) {
  const cfg = config || { noRatchet: false, allowRatchetBit: true, ratchetFilter: null };
  const bits = dashboardPartList("bits");
  const bit = dashboardBestPart(bits, field, dir);

  if (cfg.noRatchet) {
    return {
      parts: { ratchet: null, bit: bit?.name || null },
      value: bit?.[field] || 0
    };
  }

  const ratchetsAll = dashboardPartList("ratchets");
  const ratchets = cfg.ratchetFilter ? ratchetsAll.filter(cfg.ratchetFilter) : ratchetsAll;
  const ratchet = dashboardBestPart(ratchets, field, dir);

  const splitValue = (ratchet?.[field] || 0) + (bit?.[field] || 0);
  const split = {
    parts: { ratchet: ratchet?.name || null, bit: bit?.name || null },
    value: splitValue
  };

  if (!cfg.allowRatchetBit) return split;
  const rb = dashboardBestPart(dashboardPartList("ratchetBits"), field, dir);
  if (!rb) return split;

  const rbValue = rb[field] || 0;
  const rbWins = dir === 1 ? rbValue > splitValue : rbValue < splitValue;
  if (!rbWins) return split;
  return {
    parts: { ratchet: null, bit: rb.name },
    value: rbValue
  };
}

function dashboardBuildBest(field, dir) {
  const builds = [];

  // Standard: enumerate every blade so we honour per-blade constraints
  // (Bullet Griffon = no ratchet + regular bit; Clock Mirage = ratchet
  // must end in "5" + regular bit). The greedy bottom is correct because
  // bits/ratchets stats are independent of the blade choice itself.
  let bestStandard = null;
  for (const blade of dashboardPartList("blades")) {
    const bottom = dashboardBuildBottom(field, dir, dashboardBladeConfig(blade));
    const value = (blade[field] || 0) + bottom.value;
    const wins = !bestStandard
      || (dir === 1 ? value > bestStandard.value : value < bestStandard.value);
    if (wins) {
      bestStandard = {
        mode: "standard",
        parts: { blade: blade.name, ...bottom.parts },
        value
      };
    }
  }
  if (bestStandard) builds.push(bestStandard);

  const bottom = dashboardBuildBottom(field, dir);

  const lc = dashboardBestPart(dashboardPartList("lockChips"), field, dir);
  const mainBlade = dashboardBestPart(dashboardPartList("mainBlades"), field, dir);
  const assistBlade = dashboardBestPart(dashboardPartList("assistBlades"), field, dir);
  if (lc && mainBlade && assistBlade) {
    builds.push({
      mode: "cx",
      parts: {
        lockChip: lc.name,
        mainBlade: mainBlade.name,
        assistBlade: assistBlade.name,
        ...bottom.parts
      },
      value: (lc[field] || 0) + (mainBlade[field] || 0) + (assistBlade[field] || 0) + bottom.value
    });
  }

  const metalBlade = dashboardBestPart(dashboardPartList("metalBlades"), field, dir);
  const overBlade = dashboardBestPart(dashboardPartList("overBlades"), field, dir);
  if (lc && metalBlade && overBlade && assistBlade) {
    builds.push({
      mode: "cxExpand",
      parts: {
        lockChip: lc.name,
        metalBlade: metalBlade.name,
        overBlade: overBlade.name,
        assistBlade: assistBlade.name,
        ...bottom.parts
      },
      value: (lc[field] || 0) + (metalBlade[field] || 0) + (overBlade[field] || 0)
        + (assistBlade[field] || 0) + bottom.value
    });
  }

  return builds.reduce((winner, cur) => {
    if (!winner) return cur;
    if (dir === 1) return cur.value > winner.value ? cur : winner;
    return cur.value < winner.value ? cur : winner;
  }, null);
}

// Deterministic daily seed: YYYYMMDD in local time. The hashing below is
// FNV-1a-style so neighbouring dates land on noticeably different combos.
function dashboardDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function dashboardHash(seed, salt) {
  let h = (seed ^ 0x811c9dc5) >>> 0;
  h = Math.imul(h ^ salt, 16777619) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 16777619) >>> 0;
  h ^= h >>> 17;
  return h >>> 0;
}

function dashboardDailyPick(list, seed, salt) {
  if (!list.length) return null;
  return list[dashboardHash(seed, salt) % list.length];
}

// Best parts by type from the current tournament's registered decks.
// Reuses aggregatePartUsage from tournament.js which counts each registrant's
// latest saved deck. Returns one group per part type (in tournament field
// order) with the top-N parts inside each. Returns null if no data.
const DASHBOARD_TOP_FIELD_ORDER = [
  "blade", "lockChip", "mainBlade", "metalBlade",
  "overBlade", "assistBlade", "ratchet", "bit"
];
const DASHBOARD_PART_TYPE_LABEL = {
  blade: "Blade",
  lockChip: "Lock Chip",
  mainBlade: "Main Blade",
  metalBlade: "Metal Blade",
  overBlade: "Over Blade",
  assistBlade: "Assist Blade",
  ratchet: "Ratchet",
  bit: "Bit"
};

// Snapshot the last non-empty Best Parts result so resetting / finishing a
// tournament doesn't wipe what's shown on the dashboard.
const DASHBOARD_BEST_PARTS_KEY = "dashboard_best_parts_snapshot";

function dashboardSaveBestPartsSnapshot(groups) {
  try { localStorage.setItem(DASHBOARD_BEST_PARTS_KEY, JSON.stringify(groups)); } catch (e) {}
}

function dashboardLoadBestPartsSnapshot() {
  try {
    const raw = localStorage.getItem(DASHBOARD_BEST_PARTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch (e) { return null; }
}

function dashboardBuildTopParts(limit) {
  if (typeof loadSwiss !== "function" || typeof aggregatePartUsage !== "function") {
    return dashboardLoadBestPartsSnapshot();
  }
  let state;
  try { state = loadSwiss(); } catch (e) { return dashboardLoadBestPartsSnapshot(); }
  if (!state) return dashboardLoadBestPartsSnapshot();

  const usage = aggregatePartUsage(state);
  const fieldOrder = typeof BEY_CHECK_FIELD_ORDER !== "undefined"
    ? BEY_CHECK_FIELD_ORDER
    : DASHBOARD_TOP_FIELD_ORDER;
  const max = limit || 3;

  const groups = [];
  for (const field of fieldOrder) {
    const counts = usage[field];
    if (!counts) continue;
    const parts = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, max);
    if (parts.length) groups.push({ field, parts });
  }
  if (groups.length) {
    dashboardSaveBestPartsSnapshot(groups);
    return groups;
  }
  return dashboardLoadBestPartsSnapshot();
}

const DASHBOARD_RANK_TEXT = ["1st", "2nd", "3rd"];
const DASHBOARD_RANK_CLASS = ["gold", "silver", "bronze"];

function dashboardRenderTopPartsCarousel(groups) {
  if (!groups || !groups.length) {
    return `<div class="dashboard-card">
      <div class="dashboard-card-header"><h3>Best Parts</h3></div>
      <div class="dashboard-card-empty">No tournament data yet.</div>
    </div>`;
  }
  const cards = groups.map(({ field, parts }) => {
    const folder = DASHBOARD_PART_FOLDER[field];
    const title = `Best Parts (${DASHBOARD_PART_TYPE_LABEL[field] || field})`;
    const partsHtml = parts.map(({ name }, i) => {
      if (!folder) return "";
      const isRatchetBit = field === "bit"
        && (DATA.bits || []).some(b => b.isRatchetBit && b.name === name);
      const src = partImgPath(isRatchetBit ? "ratchetBits" : folder, name, null);
      const rankClass = DASHBOARD_RANK_CLASS[i];
      const rankText = DASHBOARD_RANK_TEXT[i];
      const rankHtml = rankClass
        ? `<span class="dashboard-rank dashboard-rank-${rankClass}">${rankText}</span> `
        : "";
      return `<div class="result-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${escapeHtml(name)}" class="result-part-img dashboard-part-img"
               data-part-name="${escapeHtml(name)}"
               onerror="this.closest('.result-part').style.display='none'">
        </div>
        <span class="result-part-name">${rankHtml}${escapeHtml(name)}</span>
      </div>`;
    }).join("");
    return `<div class="dashboard-card">
      <div class="dashboard-card-header"><h3>${escapeHtml(title)}</h3></div>
      <div class="result-parts dashboard-card-parts">${partsHtml}</div>
    </div>`;
  }).join("");
  return `<div class="dashboard-carousel">
    <div class="dashboard-carousel-track">${cards}</div>
    <div class="dashboard-carousel-dots"></div>
  </div>`;
}

function dashboardBuildComboOfTheDay() {
  const seed = dashboardDailySeed();
  const blade = dashboardDailyPick(dashboardPartList("blades"), seed, 1);
  const cfg = dashboardBladeConfig(blade);
  let ratchet = null;
  if (!cfg?.noRatchet) {
    const ratchetPool = cfg?.ratchetFilter
      ? dashboardPartList("ratchets").filter(cfg.ratchetFilter)
      : dashboardPartList("ratchets");
    ratchet = dashboardDailyPick(ratchetPool, seed, 2);
  }
  const bit = dashboardDailyPick(dashboardPartList("bits"), seed, 3);
  const weight = (blade?.weight || 0) + (ratchet?.weight || 0) + (bit?.weight || 0);
  return {
    mode: "standard",
    parts: {
      blade: blade?.name || null,
      ratchet: ratchet?.name || null,
      bit: bit?.name || null
    },
    field: "weight",
    value: weight
  };
}

// Mirrors the comboName concatenation the calculator builds in
// calculator.js (BX / CX / CX Expand): codenames for top parts, ratchet
// uses its name (e.g. "1-50"), bit uses its codename. A ratchet-bit replaces
// the (ratchet + bit) segment with its own codename.
function dashboardPartByName(folder, name) {
  if (!name) return null;
  return (DATA[folder] || []).find(p => p.name === name) || null;
}

function dashboardComboName(combo) {
  if (!combo || !combo.parts) return "";
  const p = combo.parts;

  const ratchetName = p.ratchet || "";
  const bitObj = p.bit
    ? (DATA.bits || []).find(b => b.name === p.bit) || null
    : null;
  const isRB = !!(bitObj && bitObj.isRatchetBit);
  const bottom = isRB
    ? (bitObj.codename || "")
    : ratchetName + (bitObj?.codename || "");

  if (combo.mode === "cx") {
    const lc = dashboardPartByName("lockChips", p.lockChip);
    const mb = dashboardPartByName("mainBlades", p.mainBlade);
    const ab = dashboardPartByName("assistBlades", p.assistBlade);
    return (lc?.codename || "") + (mb?.codename || "") + (ab?.codename || "") + bottom;
  }
  if (combo.mode === "cxExpand") {
    const lc = dashboardPartByName("lockChips", p.lockChip);
    const metal = dashboardPartByName("metalBlades", p.metalBlade);
    const over = dashboardPartByName("overBlades", p.overBlade);
    const ab = dashboardPartByName("assistBlades", p.assistBlade);
    return (lc?.codename || "") + (metal?.codename || "")
      + (over?.codename || "") + (ab?.codename || "") + bottom;
  }
  const blade = dashboardPartByName("blades", p.blade);
  return (blade?.codename || blade?.name || "") + bottom;
}

function dashboardPartImgHtml(key, name) {
  const folder = DASHBOARD_PART_FOLDER[key];
  if (!folder || !name) return "";
  const isRatchetBit = key === "bit"
    && (DATA.bits || []).some(b => b.isRatchetBit && b.name === name);
  const src = partImgPath(isRatchetBit ? "ratchetBits" : folder, name, null);
  return `<div class="result-part">
    <div class="result-part-img-box">
      <img src="${src}" alt="${escapeHtml(name)}" class="result-part-img dashboard-part-img"
           data-part-name="${escapeHtml(name)}"
           onerror="this.closest('.result-part').style.display='none'">
    </div>
    <span class="result-part-name">${escapeHtml(name)}</span>
  </div>`;
}

function dashboardOpenImagePopup(src, name) {
  const popup = document.getElementById("image-popup");
  const img = document.getElementById("image-popup-img");
  const nameEl = document.getElementById("image-popup-name");
  if (!popup || !img) return;
  img.src = src;
  if (nameEl) nameEl.textContent = name || "";
  popup.classList.remove("hidden");
}

function dashboardCloseImagePopup() {
  const popup = document.getElementById("image-popup");
  const img = document.getElementById("image-popup-img");
  if (!popup) return;
  popup.classList.add("hidden");
  if (img) img.src = "";
}

let dashboardPopupBound = false;
function bindDashboardImagePopup(root) {
  root.addEventListener("click", (e) => {
    const img = e.target.closest(".dashboard-part-img");
    if (!img) return;
    e.stopPropagation();
    dashboardOpenImagePopup(img.src, img.dataset.partName || img.alt || "");
  });

  if (dashboardPopupBound) return;
  dashboardPopupBound = true;
  const popup = document.getElementById("image-popup");
  if (!popup) return;
  popup.querySelector(".image-popup-backdrop")?.addEventListener("click", dashboardCloseImagePopup);
  popup.querySelector(".image-popup-close")?.addEventListener("click", dashboardCloseImagePopup);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popup.classList.contains("hidden")) dashboardCloseImagePopup();
  });
}

function dashboardFormatValue(field, value) {
  if (value == null) return "—";
  if (field === "weight") return `${value.toFixed(2)} g`;
  return `${value}`;
}

function dashboardRenderCard(title, combo, field) {
  if (!combo) {
    return `<div class="dashboard-card">
      <div class="dashboard-card-header"><h3>${escapeHtml(title)}</h3></div>
      <div class="dashboard-card-empty">No combo available.</div>
    </div>`;
  }
  const partsHtml = Object.entries(combo.parts)
    .filter(([, v]) => !!v)
    .map(([k, v]) => dashboardPartImgHtml(k, v))
    .join("");
  const showValue = field !== null;
  const resolvedField = field || combo.field || "weight";
  const valueLabel = DASHBOARD_FIELD_LABEL[resolvedField] || resolvedField;
  const valueText = dashboardFormatValue(resolvedField, combo.value);
  const comboName = dashboardComboName(combo);
  return `<div class="dashboard-card">
    <div class="dashboard-card-header">
      <h3>${escapeHtml(title)}</h3>
    </div>
    ${comboName ? `<div class="dashboard-combo-name">${escapeHtml(comboName)}</div>` : ""}
    <div class="result-parts dashboard-card-parts">${partsHtml}</div>
    ${showValue ? `<div class="dashboard-card-footer"><b>${escapeHtml(valueLabel)}:</b> ${escapeHtml(valueText)}</div>` : ""}
  </div>`;
}

let dashboardCarouselTimers = [];

function clearDashboardCarouselTimers() {
  dashboardCarouselTimers.forEach(t => clearInterval(t));
  dashboardCarouselTimers = [];
}

function centerDashboardCardScrollers(root) {
  root.querySelectorAll(".dashboard-card-parts").forEach(el => {
    const overflow = el.scrollWidth - el.clientWidth;
    if (overflow > 0) el.scrollLeft = overflow / 2;
  });
}

function setupDashboardCarousel(carouselEl) {
  const track = carouselEl.querySelector(".dashboard-carousel-track");
  const dotsContainer = carouselEl.querySelector(".dashboard-carousel-dots");
  if (!track || !dotsContainer) return;
  // Treat every direct child as a slide so this works for both the dashboard
  // cards and the tournament's part-usage pies (or anything else slotted in).
  const cards = Array.from(track.children);
  if (cards.length < 2) return;

  centerDashboardCardScrollers(carouselEl);

  dotsContainer.innerHTML = cards.map((_, i) =>
    `<button type="button" class="dashboard-carousel-dot${i === 0 ? " active" : ""}" data-idx="${i}" aria-label="Slide ${i + 1}"></button>`
  ).join("");
  const dots = Array.from(dotsContainer.querySelectorAll(".dashboard-carousel-dot"));

  let idx = 0;
  let paused = false;

  const goTo = (i) => {
    idx = ((i % cards.length) + cards.length) % cards.length;
    track.scrollTo({ left: cards[idx].offsetLeft, behavior: "smooth" });
    dots.forEach((d, j) => d.classList.toggle("active", j === idx));
  };

  dots.forEach(d => {
    d.addEventListener("click", () => goTo(Number(d.dataset.idx)));
  });

  track.addEventListener("mouseenter", () => { paused = true; });
  track.addEventListener("mouseleave", () => { paused = false; });
  track.addEventListener("touchstart", () => { paused = true; }, { passive: true });
  track.addEventListener("touchend", () => { paused = false; }, { passive: true });

  let scrollIdleTimer = null;
  track.addEventListener("scroll", () => {
    if (scrollIdleTimer) clearTimeout(scrollIdleTimer);
    scrollIdleTimer = setTimeout(() => {
      const closest = cards.reduce((best, c, i) => {
        const dist = Math.abs(c.offsetLeft - track.scrollLeft);
        return dist < best.dist ? { dist, i } : best;
      }, { dist: Infinity, i: 0 });
      idx = closest.i;
      dots.forEach((d, j) => d.classList.toggle("active", j === idx));
    }, 80);
  });

  dashboardCarouselTimers.push(setInterval(() => {
    if (paused) return;
    goTo(idx + 1);
  }, 4000));
}

function renderDashboard() {
  const root = document.getElementById("dashboard-content");
  if (!root) return;
  if (typeof DATA === "undefined" || !DATA.blades) {
    root.innerHTML = `<p class="dashboard-empty">Data isn't loaded yet.</p>`;
    return;
  }
  const heaviest = dashboardBuildBest("weight", 1);
  const maxAtk = dashboardBuildBest("atk", 1);
  const maxDef = dashboardBuildBest("def", 1);
  const maxSta = dashboardBuildBest("sta", 1);
  const cotd = dashboardBuildComboOfTheDay();
  const topParts = dashboardBuildTopParts();
  const today = new Date();
  const dateLabel = today.toLocaleDateString(undefined, {
    weekday: "long", year: "numeric", month: "long", day: "numeric"
  });
  root.innerHTML = `
    <p class="dashboard-date">${escapeHtml(dateLabel)}</p>
    <div class="dashboard-carousel">
      <div class="dashboard-carousel-track">
        ${dashboardRenderCard("Combo of the Day", cotd, null)}
        ${dashboardRenderCard("Heaviest Bey", heaviest, "weight")}
        ${dashboardRenderCard("Max ATK", maxAtk, "atk")}
        ${dashboardRenderCard("Max DEF", maxDef, "def")}
        ${dashboardRenderCard("Max STA", maxSta, "sta")}
      </div>
      <div class="dashboard-carousel-dots"></div>
    </div>
    ${dashboardRenderTopPartsCarousel(topParts)}
  `;
  clearDashboardCarouselTimers();
  root.querySelectorAll(".dashboard-carousel").forEach(setupDashboardCarousel);
  bindDashboardImagePopup(root);
}
