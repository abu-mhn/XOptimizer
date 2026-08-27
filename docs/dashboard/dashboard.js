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
  if (isExpandCxBlade(blade)) {
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

// Best Parts has no local cache. It reads the shared monthly tally in the
// database and nothing else — see dashboardLoadMonthlyBestParts below. The
// previous localStorage snapshot (and the "most recent finished tournament on
// this device" computation behind it) is gone: both were per-device answers to
// a community-wide question, and both would have outlived the monthly reset.


// ===== Shared monthly Best Parts =====
// Best Parts reads a community-wide tally at bestParts/{YYYY-MM} that every
// host contributes to as their tournament finishes, rather than whatever the
// last tournament on THIS device happened to use. The month is the node key,
// so each new month starts empty — that's the reset, with no scheduled job.
//
// The read is async and the dashboard renders synchronously, so the first
// paint falls back to the local snapshot and repaints once the tally arrives.
let dashboardMonthlyParts = null;      // top-3 groups for the current month (null = none recorded)
let dashboardMonthlyAll = null;        // the same tally, untrimmed, for the usage tier list
let dashboardMonthlyPartsTried = false; // a read has been started
let dashboardMonthlyLoaded = false;     // a read came back — the DB is now authoritative

function dashboardMonthKey() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function dashboardLoadMonthlyBestParts() {
  if (dashboardMonthlyPartsTried) return;   // one read per page load
  dashboardMonthlyPartsTried = true;
  let db;
  try { db = firebase.database(); } catch (e) { return; }
  if (!db) return;
  db.ref("bestParts/" + dashboardMonthKey()).once("value").then(snap => {
    // The read answered, so the shared tally is now the source of truth even
    // when it's EMPTY. A fresh month has nothing in it, and falling back to
    // this device's last tournament there would quietly undo the monthly
    // reset — showing last month's parts under a new month's heading.
    dashboardMonthlyLoaded = true;
    const val = snap.val();
    if (!val) {
      // Repaint so the card drops last month's data rather than leaving the
      // pre-read fallback on screen.
      if (typeof renderDashboard === "function") renderDashboard();
      if (typeof renderSideDashboard === "function") renderSideDashboard();
      return;
    }
    const fieldOrder = typeof BEY_CHECK_FIELD_ORDER !== "undefined"
      ? BEY_CHECK_FIELD_ORDER
      : DASHBOARD_TOP_FIELD_ORDER;
    const groups = [];
    const full = [];
    for (const field of fieldOrder) {
      const bucket = val[field];
      if (!bucket) continue;
      const ranked = Object.keys(bucket)
        .map(k => bucket[k])
        .filter(r => r && r.name)
        .map(r => ({ name: r.name, count: Number(r.count) || 0 }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      if (!ranked.length) continue;
      // The carousel shows a podium; the usage tier list below ranks the whole
      // field, so keep both rather than throwing the tail away here.
      groups.push({ field, parts: ranked.slice(0, 3) });
      full.push({ field, parts: ranked });
    }
    if (!groups.length) return;
    dashboardMonthlyParts = groups;
    dashboardMonthlyAll = full;
    // Repaint whichever surface is on screen. Safe from looping: the cache is
    // set, so the rebuild below returns it without starting another read.
    if (typeof renderDashboard === "function") renderDashboard();
    if (typeof renderSideDashboard === "function") renderSideDashboard();
  }).catch(() => { /* offline / rules not deployed — local snapshot stands */ });
}

function dashboardBuildTopParts(limit) {
  // The shared monthly tally in the database is the ONLY source: no localStorage
  // snapshot, and no fall-back to this device's last tournament. Best Parts is a
  // community figure, so a per-device cache would show a different answer on
  // every phone in the room, and a local fallback would survive the monthly
  // reset — showing last month's parts under a new month's heading.
  //
  // Returns null until the read lands, and whenever the month is empty — the
  // card renders "No tournament data yet" for both, which is honest.
  dashboardLoadMonthlyBestParts();
  return dashboardMonthlyParts;
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
      const src = dashboardResolvePartImg(field, name);
      const rankClass = DASHBOARD_RANK_CLASS[i];
      const rankText = DASHBOARD_RANK_TEXT[i];
      const rankHtml = rankClass
        ? `<span class="dashboard-rank dashboard-rank-${rankClass}">${rankText}</span> `
        : "";
      return `<div class="result-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${escapeHtml(name)}" class="result-part-img dashboard-part-img"
               data-part-name="${escapeHtml(name)}"
               onerror="this.style.display='none'">
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

// ===== Usage tier list =====
// Ranks parts by how often the community actually brought them this month,
// straight off the same bestParts/{YYYY-MM} tally the Best Parts carousel
// reads. This is the counterpart to the Library's tier list, which ranks on
// the numbers printed on the part — here S means "most played", not "best on
// paper", and the two will disagree. That's the point of having both.
//
// Only parts that were played appear at all: a part nobody brought has no
// entry in the tally, so it's absent rather than sitting in F. F is the least
// played of what WAS played.
const DASHBOARD_USAGE_STORE_KEY = "dashboardUsageField";

let dashboardUsageField = null;   // null = follow the first field with data
(function restoreDashboardUsageField() {
  try {
    const saved = localStorage.getItem(DASHBOARD_USAGE_STORE_KEY);
    if (saved && DASHBOARD_TOP_FIELD_ORDER.indexOf(saved) >= 0) dashboardUsageField = saved;
  } catch (e) { /* unreadable / disabled store — fall back to the first field */ }
})();

function saveDashboardUsageField() {
  try {
    localStorage.setItem(DASHBOARD_USAGE_STORE_KEY, dashboardUsageField || "");
  } catch (e) { /* private mode — the choice just won't outlive the page */ }
}

// Returns { field, rows, total, plays } for the chosen part type, or null when
// the month's tally has nothing in it yet.
function dashboardBuildUsageTier(fieldKey) {
  dashboardLoadMonthlyBestParts();
  const all = dashboardMonthlyAll;
  if (!all || !all.length) return null;
  // A remembered field with no data this month (nobody played a Metal Blade)
  // falls back to the first field that has some, rather than showing an empty
  // card for a type the user picked weeks ago.
  const group = all.find(g => g.field === fieldKey) || all[0];
  const entries = group.parts.map(p => ({ name: p.name, score: p.count }));
  if (!entries.length) return null;
  return {
    field: group.field,
    rows: buildTierRows(entries),
    total: entries.length,
    plays: entries.reduce((n, e) => n + e.score, 0)
  };
}

function dashboardRenderUsageTierInner() {
  const built = dashboardBuildUsageTier(dashboardUsageField);
  if (!built) {
    // Same wording as the Best Parts card: before the read lands, and for a
    // month nobody has finished a tournament in yet.
    return `<div class="dashboard-card-empty">No tournament data yet.</div>`;
  }
  const chips = (dashboardMonthlyAll || []).map(g => {
    const label = DASHBOARD_PART_TYPE_LABEL[g.field] || g.field;
    const active = g.field === built.field ? " is-active" : "";
    return `<button type="button" class="tier-chip${active}" data-usage-field="${escapeHtml(g.field)}">${escapeHtml(label)}</button>`;
  }).join("");

  const rowsHtml = built.rows.map(row => {
    const items = row.parts.map(p => {
      const src = dashboardResolvePartImg(built.field, p.name);
      // The count is a SIBLING of the name, not nested inside it, so the
      // desktop rail's mini variant can hide the name and keep the count.
      // `title` is what names the part there, since the label is gone.
      return `<div class="result-part tier-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}"
               class="result-part-img dashboard-part-img"
               data-part-name="${escapeHtml(p.name)}"
               onerror="this.style.display='none'">
        </div>
        <span class="result-part-name">${escapeHtml(p.name)}</span>
        <span class="tier-score">${p.score}&times;</span>
      </div>`;
    }).join("");
    return `<div class="tier-row">
      <div class="tier-label tier-${row.tier}">${row.tier}</div>
      <div class="tier-items">${items || `<span class="tier-none">&mdash;</span>`}</div>
    </div>`;
  }).join("");

  const label = (DASHBOARD_PART_TYPE_LABEL[built.field] || built.field).toLowerCase();
  return `<div class="tier-controls"><div class="tier-chips">${chips}</div></div>
    <div class="tier-rows">${rowsHtml}</div>
    <div class="tier-foot">${built.total} ${escapeHtml(label)}s played ${built.plays} time${built.plays === 1 ? "" : "s"} this month. Ranked by how often each was brought, so S is the most played &mdash; not the strongest on paper.</div>`;
}

function dashboardRenderUsageTier() {
  return `<div class="dashboard-card dashboard-usage-tier" data-usage-tier>
    <div class="dashboard-card-header"><h3>Tier List (Most Played)</h3></div>
    ${dashboardRenderUsageTierInner()}
  </div>`;
}

// Chip clicks repaint only this card — a full renderDashboard would restart
// the carousels above it and snap them back to their first slide.
function bindDashboardUsageTier(root) {
  if (!root) return;
  root.querySelectorAll("[data-usage-tier] .tier-items, [data-usage-tier] .tier-chips")
    .forEach(rail => {
      if (typeof enableHorizontalWheelScroll === "function") enableHorizontalWheelScroll(rail);
      if (typeof enableHorizontalDragScroll === "function") enableHorizontalDragScroll(rail);
    });
  if (root.dataset.usageTierBound === "1") return;
  root.dataset.usageTierBound = "1";
  root.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-usage-field]");
    if (!btn) return;
    e.stopPropagation();
    dashboardUsageField = btn.dataset.usageField;
    saveDashboardUsageField();
    const card = root.querySelector("[data-usage-tier]");
    if (!card) return;
    const header = card.querySelector(".dashboard-card-header");
    card.innerHTML = (header ? header.outerHTML : "") + dashboardRenderUsageTierInner();
    bindDashboardUsageTier(root);
  });
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

// Resolves the asset path for a named part, honouring two things the bare
// partImgPath() doesn't:
//   1. A "bit" field that turns out to be a ratchet-bit (Turbo / Operate)
//      lives in the "ratchetBits" asset folder, not "bits".
//   2. Parts with a `modes` array (Eclipse, Dual, Lightning L-Drago, Turbo,
//      Operate, Scorpio Spear) store one image per mode and have no plain
//      "{Name}.webp" — default to mode index 0 when we don't know which.
function dashboardResolvePartImg(key, name) {
  const baseFolder = DASHBOARD_PART_FOLDER[key];
  if (!baseFolder || !name) return "";
  let folder = baseFolder;
  let part = null;
  if (key === "bit") {
    const allBits = DATA.bits || [];
    part = allBits.find(b => b.name === name) || null;
    if (part && part.isRatchetBit) folder = "ratchetBits";
  } else {
    part = (DATA[baseFolder] || []).find(p => p.name === name) || null;
  }
  const modeIdx = (part && Array.isArray(part.modes) && part.modes.length > 0) ? 0 : null;
  return partImgPath(folder, name, modeIdx);
}

function dashboardPartImgHtml(key, name) {
  const folder = DASHBOARD_PART_FOLDER[key];
  if (!folder || !name) return "";
  const src = dashboardResolvePartImg(key, name);
  return `<div class="result-part">
    <div class="result-part-img-box">
      <img src="${src}" alt="${escapeHtml(name)}" class="result-part-img dashboard-part-img"
           data-part-name="${escapeHtml(name)}"
           onerror="this.style.display='none'">
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
    // A combined CX / CX Expand tile opens the carousel popup (shared from
    // library.js) showing all of its parts.
    const combinedBox = img.closest(".result-part-img-box-combined");
    if (combinedBox && typeof window.openCombinedImagePopup === "function") {
      const layers = [...combinedBox.querySelectorAll(".result-part-layer")]
        .reverse()
        .map(l => ({ src: l.src, name: l.dataset.partName || l.alt || "" }));
      window.openCombinedImagePopup(layers);
      return;
    }
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
  // CX / CX Expand combos show the lock chip + blade(s) + assist blade
  // stacked into one combined thumbnail.
  const resolvePart = (key, name) => {
    const folder = DASHBOARD_PART_FOLDER[key];
    const rec = (DATA[folder] || []).find(p => p.name === name) || null;
    const modeIdx = (rec && Array.isArray(rec.modes) && rec.modes.length > 0) ? 0 : null;
    return { src: dashboardResolvePartImg(key, name), codename: partRecordCodename(folder, name, modeIdx) };
  };
  const combined = combinedBladeTileHTML(combo.parts, resolvePart, "dashboard-part-img");
  let partsHtml = combined ? combined.html : "";
  partsHtml += Object.entries(combo.parts)
    .filter(([k, v]) => !!v && !(combined && combined.usedKeys.has(k)))
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
  let resumeTimer = null;

  // Any user interaction halts the auto-advance. We then schedule a resume
  // for a short idle window — every fresh interaction pushes that resume
  // back so a user who's actively scrolling is never interrupted.
  const RESUME_AFTER_MS = 3 * 1000;
  const pauseAndScheduleResume = () => {
    paused = true;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, RESUME_AFTER_MS);
  };

  const goTo = (i) => {
    idx = ((i % cards.length) + cards.length) % cards.length;
    track.scrollTo({ left: cards[idx].offsetLeft, behavior: "smooth" });
    dots.forEach((d, j) => d.classList.toggle("active", j === idx));
  };

  dots.forEach(d => {
    d.addEventListener("click", () => {
      pauseAndScheduleResume();
      goTo(Number(d.dataset.idx));
    });
  });

  track.addEventListener("touchstart", pauseAndScheduleResume, { passive: true });
  track.addEventListener("wheel", pauseAndScheduleResume, { passive: true });

  // Click-and-drag the carousel horizontally with a mouse. Touch swipes are
  // already handled natively by the browser's horizontal-scroll.
  let drag = null;
  track.addEventListener("mousedown", (e) => {
    pauseAndScheduleResume();
    // Don't hijack drags on interactive elements inside a card.
    if (e.target.closest("button, a, input, select, textarea")) return;
    drag = { x: e.clientX, scroll: track.scrollLeft, moved: false };
    track.classList.add("is-dragging");
    e.preventDefault();
  });
  const onDragMove = (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 3) drag.moved = true;
    track.scrollLeft = drag.scroll - dx;
  };
  const onDragEnd = () => {
    if (!drag) return;
    drag = null;
    track.classList.remove("is-dragging");
  };
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);

  let scrollIdleTimer = null;
  track.addEventListener("scroll", () => {
    pauseAndScheduleResume();
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

// ===== Side panel mode (Settings → Side panel) =====
// Governs the DESKTOP RAIL only. The Dashboard page itself always shows
// everything — it's the dashboard, and the setting is about the strip of
// screen the other tabs lend it.
//
//   normal → the combo / stat carousel and Best Parts (the original rail)
//   tier   → the usage tier list on its own
//
// Read straight from localStorage rather than waiting on the dropdown: the
// rail is built on DOMContentLoaded and the dropdown is wired at the same
// time, so relying on initSettingDropdown's callback would paint the wrong
// panel first and correct it a tick later.
const DASHBOARD_SIDE_PANEL_KEY = "sidePanelMode";
let dashboardSidePanelMode = "normal";
(function restoreDashboardSidePanelMode() {
  try {
    const saved = localStorage.getItem(DASHBOARD_SIDE_PANEL_KEY);
    if (saved === "tier" || saved === "normal") dashboardSidePanelMode = saved;
  } catch (e) { /* unreadable / disabled store — Normal stands */ }
})();

// `rootEl` lets the same dashboard render into the desktop side rail as well as
// the Dashboard page itself — see renderSideDashboard below.
function renderDashboard(rootEl) {
  const root = rootEl || document.getElementById("dashboard-content");
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
  // In the rail the Settings choice picks ONE of the two; on the Dashboard
  // page both are always shown.
  const isRail = root.id === "side-dashboard-content";
  const tierOnly = isRail && dashboardSidePanelMode === "tier";
  const carousels = tierOnly ? "" : `
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
    ${dashboardRenderTopPartsCarousel(topParts)}`;
  const tier = (isRail && !tierOnly) ? "" : dashboardRenderUsageTier();
  root.innerHTML = `${carousels}
    ${tier}
  `;
  clearDashboardCarouselTimers();
  root.querySelectorAll(".dashboard-carousel").forEach(setupDashboardCarousel);
  bindDashboardImagePopup(root);
  bindDashboardUsageTier(root);
}

// ===== Desktop side rail =====
// Every page but the Dashboard leaves a wide empty gutter to the RIGHT of the
// 640px column — the left gutter already holds the sticky profile card. Mirror
// it with the same dashboard so that space earns its keep.
//
// The rail is injected rather than added to all 16 page templates: one place to
// change, and no risk of the copies drifting apart.
function ensureSideDashboardHost() {
  // On the Dashboard page the real thing is already on screen, so no rail.
  //
  // Test the SECTION's visibility, not the presence of #dashboard-content:
  // every page ships the whole shell, so that element exists everywhere and
  // only the active page's section has `hidden` removed. Checking for the
  // element instead short-circuited on every page and built no rail at all.
  const section = document.getElementById("form-dashboard");
  if (section && !section.classList.contains("hidden")) return null;
  const container = document.querySelector(".container");
  if (!container) return null;
  let aside = document.getElementById("side-dashboard");
  if (!aside) {
    aside = document.createElement("aside");
    aside.id = "side-dashboard";
    aside.className = "side-dashboard";
    aside.setAttribute("aria-label", "Dashboard summary");
    aside.innerHTML =
      '<div class="side-dashboard-inner"><div id="side-dashboard-content" class="dashboard-content"></div></div>';
    // Sticky only tracks from where the element sits in flow, so it goes at the
    // TOP of the column (right after the profile rail) rather than appended at
    // the end, where it would stick only once you'd scrolled past everything.
    const profileRail = document.getElementById("side-profile");
    if (profileRail && profileRail.parentNode === container) {
      container.insertBefore(aside, profileRail.nextSibling);
    } else {
      container.insertBefore(aside, container.firstChild);
    }
  }
  return document.getElementById("side-dashboard-content");
}

function renderSideDashboard() {
  // Data lives in data.js and every page loads it, but a slow/failed load would
  // otherwise paint "Data isn't loaded yet" into the rail on every page.
  if (typeof DATA === "undefined" || !DATA.blades) return;
  const host = ensureSideDashboardHost();
  if (host) renderDashboard(host);
}

// Wire Settings → Side panel. Guarded because initSettingDropdown assumes the
// element exists and would throw on a page that ever ships without it.
function initDashboardSidePanelSetting() {
  if (typeof initSettingDropdown !== "function") return;
  if (!document.getElementById("setting-side-panel")) return;
  initSettingDropdown("setting-side-panel", DASHBOARD_SIDE_PANEL_KEY, "normal", (val) => {
    dashboardSidePanelMode = val;
    // Repaint the rail in place so the choice takes effect without a reload.
    // renderDashboard clears the carousel timers itself; clearing them here
    // would kill the Dashboard page's own carousels on the one path where
    // renderSideDashboard early-returns and rebuilds nothing.
    renderSideDashboard();
  });
}

// The rail is a desktop-only affordance (CSS hides it below 1200px, same
// breakpoint as the profile card), but it's cheap to build once on load. The
// Dashboard page short-circuits inside ensureSideDashboardHost.
document.addEventListener("DOMContentLoaded", () => {
  renderSideDashboard();
  initDashboardSidePanelSetting();
});
if (document.readyState !== "loading") {
  renderSideDashboard();
  initDashboardSidePanelSetting();
}
