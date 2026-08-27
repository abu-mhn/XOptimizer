// docs/js/library.js - library search, sort, filter, image popup
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
    const EXCLUDE_KEYS = ["name", "meta", "exclusive", "expandcx"];

    Object.entries(obj).forEach(([k, v]) => {
      if (k.startsWith("_")) return;
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
  let currentSort = "name";
  let currentDir = "asc";

  function getStatValue(item, key) {
    const mode = hasModes(item) ? item.modes[item.currentMode ?? 0] : item;
    const val = mode[key];
    if (val === undefined || val === null || val === "TBA") return -1;
    return Number(val) || 0;
  }

  function sortItems(items) {
    return [...items].sort((a, b) => {
      if (currentSort === "name") {
        const cmp = (a?.name || "").localeCompare(b?.name || "");
        return currentDir === "asc" ? cmp : -cmp;
      }
      const cmp = getStatValue(b, currentSort) - getStatValue(a, currentSort);
      return currentDir === "desc" ? -cmp : cmp;
    });
  }

  function updateSortButtons() {
    sortBar.querySelectorAll(".sort-btn").forEach(btn => {
      const key = btn.dataset.sort;
      if (key === currentSort) {
        btn.classList.add("active");
        const arrow = currentDir === "asc" ? " \u25B2" : " \u25BC";
        const label = (key === "atk" || key === "def" || key === "sta")
          ? key.toUpperCase()
          : key.charAt(0).toUpperCase() + key.slice(1);
        btn.textContent = label + arrow;
      } else {
        btn.classList.remove("active");
        const label = (key === "atk" || key === "def" || key === "sta")
          ? key.toUpperCase()
          : key.charAt(0).toUpperCase() + key.slice(1);
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
      currentDir = "asc";
    }

    updateSortButtons();
    runSearch();
  });

  // =========================
  // GETALL FILTER BUTTONS
  // =========================
  const GETALL_MAP = {
    blades: () => DATA.blades || [],
    bits: () => DATA.bits || [],
    ratchets: () => DATA.ratchets || [],
    assistBlades: () => DATA.assistBlades || [],
    mainBlades: () => DATA.mainBlades || [],
    metalBlades: () => DATA.metalBlades || [],
    overBlades: () => DATA.overBlades || [],
    lockChips: () => DATA.lockChips || []
  };

  const filterBar = document.getElementById("library-filter");
  let currentGetAll = null;

  function updateFilterButtons() {
    filterBar?.querySelectorAll(".filter-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.getall === currentGetAll);
    });
  }

  filterBar?.addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    const key = btn.dataset.getall;
    if (currentGetAll === key) {
      currentGetAll = null;
    } else {
      currentGetAll = key;
      input.value = "";
    }
    updateFilterButtons();
    runSearch();
  });

  // =========================
  // SEARCH
  // =========================
  function runSearch() {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = "";

    let filtered = [];
    let isGetAll = false;

    if (currentGetAll && GETALL_MAP[currentGetAll]) {
      filtered = GETALL_MAP[currentGetAll]();
      isGetAll = true;
    } else if (q) {
      filtered = ALL_PARTS.filter(p =>
        p?.name?.toLowerCase().includes(q)
      );
    } else {
      sortBar.classList.add("hidden");
      return;
    }

    if (isGetAll && filtered.length > 0) {
      sortBar.classList.remove("hidden");

      const hasStat = (p, key) => {
        if (!p) return false;
        const check = v => v != null && v !== 0 && v !== "TBA";
        if (check(p[key])) return true;
        if (Array.isArray(p.modes)) return p.modes.some(m => m && check(m[key]));
        return false;
      };

      ["atk", "def", "sta", "height"].forEach(key => {
        const has = filtered.some(p => hasStat(p, key));
        const btn = sortBar.querySelector(`[data-sort="${key}"]`);
        if (!btn) return;
        btn.style.display = has ? "" : "none";
        if (!has && currentSort === key) {
          currentSort = "name";
          currentDir = "asc";
          updateSortButtons();
        }
      });
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

  // --- Combined-part carousel state ---
  let combinedSlideEls = [];
  let combinedDotEls = [];
  let combinedIndex = 0;
  let combinedAutoTimer = null;

  function getCombinedGrid() {
    const content = imagePopup.querySelector(".image-popup-content");
    let grid = content.querySelector(".image-popup-combined");
    if (!grid) {
      grid = document.createElement("div");
      grid.className = "image-popup-combined";
      content.appendChild(grid);

      // Swipe / drag to change slide; any interaction restarts the 3s
      // idle countdown.
      let dragStartX = null;
      const resetIdle = () => {
        if (combinedAutoTimer !== null) scheduleCombinedAuto();
      };
      grid.addEventListener("pointerdown", (e) => {
        dragStartX = e.clientX;
        try { grid.setPointerCapture(e.pointerId); } catch (err) {}
        resetIdle();
      });
      grid.addEventListener("pointerup", (e) => {
        if (dragStartX !== null) {
          const dx = e.clientX - dragStartX;
          dragStartX = null;
          if (Math.abs(dx) > 35) showCombinedSlide(combinedIndex + (dx < 0 ? 1 : -1));
        }
        resetIdle();
      });
      grid.addEventListener("pointercancel", () => { dragStartX = null; });
      grid.addEventListener("mousemove", resetIdle);
    }
    return grid;
  }

  function showCombinedSlide(i) {
    if (!combinedSlideEls.length) return;
    combinedIndex = (i + combinedSlideEls.length) % combinedSlideEls.length;
    combinedSlideEls.forEach((el, n) => el.classList.toggle("active", n === combinedIndex));
    combinedDotEls.forEach((el, n) => el.classList.toggle("active", n === combinedIndex));
  }

  function stopCombinedAuto() {
    if (combinedAutoTimer !== null) {
      clearInterval(combinedAutoTimer);
      combinedAutoTimer = null;
    }
  }

  // Auto-advance the carousel once it has been idle for 3 seconds, then keep
  // sliding every 3 seconds. Any interaction calls this again to restart it.
  function scheduleCombinedAuto() {
    if (combinedAutoTimer !== null) clearInterval(combinedAutoTimer);
    combinedAutoTimer = setInterval(() => showCombinedSlide(combinedIndex + 1), 3000);
  }

  function openImagePopup(src, name) {
    stopCombinedAuto();
    imagePopupImg.src = src;
    imagePopupImg.style.display = "";
    imagePopupName.style.display = "";
    imagePopupName.textContent = name || "";
    const grid = imagePopup.querySelector(".image-popup-combined");
    if (grid) grid.style.display = "none";
    imagePopup.classList.remove("hidden");
  }

  // Show several parts in the popup as an auto-sliding carousel
  // (e.g. a combined CX blade: lock chip + main blade + assist blade).
  function openCombinedImagePopup(parts) {
    imagePopupImg.style.display = "none";
    imagePopupName.style.display = "none";
    const grid = getCombinedGrid();
    grid.innerHTML = `
      <div class="image-popup-carousel">
        ${parts.map((p, i) => `
          <figure class="image-popup-slide${i === 0 ? " active" : ""}">
            <img src="${p.src}" alt="${p.name}">
            <figcaption>${p.name}</figcaption>
          </figure>
        `).join("")}
      </div>
      <div class="image-popup-dots">
        ${parts.map((_, i) =>
          `<button type="button" class="image-popup-dot${i === 0 ? " active" : ""}" data-slide="${i}" aria-label="Part ${i + 1}"></button>`
        ).join("")}
      </div>
    `;
    grid.style.display = "";
    combinedSlideEls = [...grid.querySelectorAll(".image-popup-slide")];
    combinedDotEls = [...grid.querySelectorAll(".image-popup-dot")];
    combinedIndex = 0;
    showCombinedSlide(0);

    combinedDotEls.forEach(dot => {
      dot.addEventListener("click", () => {
        showCombinedSlide(Number(dot.dataset.slide));
        scheduleCombinedAuto(); // interaction restarts the idle countdown
      });
    });

    imagePopup.classList.remove("hidden");
    scheduleCombinedAuto();
  }

  function closeImagePopup() {
    stopCombinedAuto();
    imagePopup.classList.add("hidden");
    imagePopupImg.src = "";
    imagePopupImg.style.display = "";
    imagePopupName.style.display = "";
    const grid = imagePopup.querySelector(".image-popup-combined");
    if (grid) grid.style.display = "none";
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

  // Clicking a part thumbnail opens the image popup. A combined tile
  // (e.g. a CX lock chip + main blade + assist blade) opens the carousel
  // popup showing all of its parts together.
  function handlePartImgClick(e) {
    const img = e.target.closest(".result-part-img");
    if (!img) return;

    e.stopPropagation();

    const combinedBox = img.closest(".result-part-img-box-combined");
    if (combinedBox) {
      const layers = [...combinedBox.querySelectorAll(".result-part-layer")]
        .reverse() // DOM order is back-to-front; show front-to-back
        .map(l => ({ src: l.src, name: l.dataset.partName || l.alt || "" }));
      openCombinedImagePopup(layers);
      return;
    }

    const part = img.closest(".result-part");
    const name = part ? part.querySelector(".result-part-name")?.textContent || "" : "";
    openImagePopup(img.src, name);
  }

  ["result", "history-list", "deck-list"].forEach(id =>
    document.getElementById(id)?.addEventListener("click", handlePartImgClick)
  );

  // Expose the carousel popup so other pages (e.g. the dashboard) can reuse it.
  window.openCombinedImagePopup = openCombinedImagePopup;
  // The Tier sub-tab lives outside this closure but shares the same popup,
  // including its close / backdrop / Escape handlers wired above.
  window.openLibraryImagePopup = openImagePopup;

  // =========================
  // EVENTS
  // =========================
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runSearch();
    }
  });

  input.addEventListener("input", () => {
    if (input.value && currentGetAll) {
      currentGetAll = null;
      updateFilterButtons();
    }
    runSearch();
  });
}

document.addEventListener("DOMContentLoaded", initLibrarySearch);

// =============================================================================
// Library → Tier sub-tab
//
// Ranks every part of one type against the others of that type and drops them
// into S / A / B / C / D / F rows. The ranking is PURELY the part's own stats —
// nothing here is a vote or a usage count (the dashboard's Best Parts card is
// the usage figure), so any tier can be explained by the numbers printed on
// the part.
//
// Parts the data flags as `meta` are marked with a star rather than being
// pushed up a tier: that flag is a curated competitive opinion, and folding it
// into a stat-derived score would make the tiers unexplainable.
//
// Lock chips carry no ATK / DEF / STA at all, so they are not offered as a
// tier type. The ratchet-bits (Turbo, Operate) have no type of their own —
// core.js merges them into the bit pool, and they are ranked there.
// =============================================================================

const LIBRARY_TIER_TYPES = [
  { key: "blade",       folder: "blades",       label: "Blade" },
  { key: "ratchet",     folder: "ratchets",     label: "Ratchet" },
  { key: "bit",         folder: "bits",         label: "Bit" },
  { key: "mainBlade",   folder: "mainBlades",   label: "Main Blade" },
  { key: "metalBlade",  folder: "metalBlades",  label: "Metal Blade" },
  { key: "overBlade",   folder: "overBlades",   label: "Over Blade" },
  { key: "assistBlade", folder: "assistBlades", label: "Assist Blade" }
];

// One axis at a time, deliberately — there is no combined "overall" score.
// Beyblade X hands every part in a class the same stat budget: 63 of the 78
// blades total exactly 100, and 35 of the 37 ratchets total 30. Ranking on
// ATK + DEF + STA therefore puts nearly every part on the same number, which
// collapses the whole list into one tier and says nothing. Each basis here is
// a single figure printed on the part, so every placement is checkable.
const LIBRARY_TIER_STATS = [
  { key: "atk",    label: "ATK",    note: "attack" },
  { key: "def",    label: "DEF",    note: "defense" },
  { key: "sta",    label: "STA",    note: "stamina" },
  { key: "weight", label: "Weight", note: "weight" }
];

const LIBRARY_TIER_STORE_KEY = "libraryTier";

let libraryTierType = "blade";
let libraryTierStat = "atk";
(function restoreLibraryTierChoice() {
  try {
    const saved = JSON.parse(localStorage.getItem(LIBRARY_TIER_STORE_KEY) || "null");
    if (!saved) return;
    if (LIBRARY_TIER_TYPES.some(t => t.key === saved.type)) libraryTierType = saved.type;
    if (LIBRARY_TIER_STATS.some(s => s.key === saved.stat)) libraryTierStat = saved.stat;
  } catch (e) { /* unreadable / disabled store — the defaults stand */ }
})();

function saveLibraryTierChoice() {
  try {
    localStorage.setItem(LIBRARY_TIER_STORE_KEY,
      JSON.stringify({ type: libraryTierType, stat: libraryTierStat }));
  } catch (e) { /* private mode — the choice just won't outlive the page */ }
}

// A part's score for the chosen basis, or null when it can't be scored at all,
// so an unscoreable part is left out rather than sinking to F on a missing stat.
function libraryTierScore(part, stat) {
  if (!part) return null;
  const v = Number(part[stat]);
  return isFinite(v) ? v : null;
}

// Weights carry a decimal and a unit; the stats are plain integers.
function libraryTierScoreLabel(score, stat) {
  if (score == null) return "";
  return stat === "weight" ? `${score.toFixed(1)}g` : `${score}`;
}

// Resolved here rather than borrowing the dashboard's copy, and honouring two
// things a bare partImgPath() call doesn't:
//   1. `_folder` (set by mergeBits in core.js) wins over the pool's own folder.
//      A part merged in from elsewhere keeps its real asset directory, so it
//      can't end up pointing at a file that was never in that folder.
//   2. Parts with a `modes` array (Lightning L-Drago, Scorpio Spear, Eclipse,
//      Dual) ship one image per mode and have no plain "{Name}.webp", so they
//      need mode 0.
function libraryTierPartImg(folder, name, modeIdx) {
  if (!folder || !name) return "";
  const part = ((typeof DATA !== "undefined" && DATA[folder]) || []).find(p => p.name === name);
  const realFolder = (part && part._folder) || folder;
  let idx = modeIdx;
  if (idx == null) {
    idx = (part && Array.isArray(part.modes) && part.modes.length > 0) ? 0 : null;
  }
  return partImgPath(realFolder, name, idx);
}

function libraryBuildTierList(typeKey, stat) {
  if (typeof DATA === "undefined") return null;
  const type = LIBRARY_TIER_TYPES.find(t => t.key === typeKey) || LIBRARY_TIER_TYPES[0];
  // mergeBits() in core.js folds the ratchet-bits (Turbo, Operate) into
  // DATA.bits, and they're ranked here alongside the plain bits — they're a
  // real choice in that slot. Worth knowing when reading the Weight tier:
  // they include the ratchet, so they weigh 12.7g / 14.1g against 2-4g for a
  // plain bit and will always head that row. The footer says so.
  //
  // A part that switches mode (Scorpio Spear, Hells Nether, Turbo, Dual …)
  // is a different part in each mode — Hells Nether is 50 ATK in Normal and
  // 70 in Low — so each mode is ranked on its own rather than the part being
  // represented by whichever mode happens to be listed first.
  const pool = [];
  (DATA[type.folder] || []).forEach(p => {
    if (!p || !p.name) return;
    const modes = Array.isArray(p.modes) && p.modes.length ? p.modes : null;
    const variants = modes
      ? modes.map((m, i) => ({ stats: m, modeName: m.modeName || `Mode ${i + 1}`, modeIdx: i }))
      : [{ stats: p, modeName: "", modeIdx: null }];
    variants.forEach(v => {
      // A mode entry that omits the stat falls back to the parent's value,
      // so a sparse mode record can't drop the part out of the list.
      let score = libraryTierScore(v.stats, stat);
      if (score == null && v.modeIdx != null) score = libraryTierScore(p, stat);
      if (score == null) return;
      pool.push({
        name: p.name,
        modeName: v.modeName,
        modeIdx: v.modeIdx,
        meta: !!p.meta,               // `meta` is on the part, so it covers every mode
        ratchetBit: !!p.isRatchetBit,
        score
      });
    });
  });
  pool.sort((a, b) =>
    b.score - a.score ||
    a.name.localeCompare(b.name) ||
    (a.modeIdx || 0) - (b.modeIdx || 0));
  if (!pool.length) return null;
  // Bucketing lives in core.js so this and the Dashboard's usage tier list
  // can't drift into ranking things differently.
  return { type, stat, rows: buildTierRows(pool), total: pool.length };
}

function libraryRenderTierInner() {
  const built = libraryBuildTierList(libraryTierType, libraryTierStat);
  const chip = (attr, key, label, active) =>
    `<button type="button" class="tier-chip${active ? " is-active" : ""}" ${attr}="${key}">${escapeHtml(label)}</button>`;
  const controls = `<div class="tier-controls">
      <div class="tier-chips">${LIBRARY_TIER_TYPES
        .map(t => chip("data-tier-type", t.key, t.label, t.key === libraryTierType)).join("")}</div>
      <div class="tier-chips">${LIBRARY_TIER_STATS
        .map(s => chip("data-tier-stat", s.key, s.label, s.key === libraryTierStat)).join("")}</div>
    </div>`;

  if (!built) return `${controls}<div class="tier-msg">No parts to rank.</div>`;

  const rowsHtml = built.rows.map(row => {
    const items = row.parts.map(p => {
      const src = libraryTierPartImg(built.type.folder, p.name, p.modeIdx);
      const star = p.meta ? `<span class="tier-meta" title="Meta pick">&#9733;</span>` : "";
      // Each mode gets its own tile, so the popup title has to name the mode
      // too — otherwise two tiles for the same part open identically.
      const full = p.modeName ? `${p.name} (${p.modeName})` : p.name;
      const mode = p.modeName
        ? `<span class="tier-mode">${escapeHtml(p.modeName)}</span>`
        : "";
      return `<div class="result-part tier-part">
        <div class="result-part-img-box">
          <img src="${src}" alt="${escapeHtml(full)}" title="${escapeHtml(full)}"
               class="result-part-img tier-img"
               data-part-name="${escapeHtml(full)}"
               onerror="this.style.display='none'">
        </div>
        <span class="result-part-name">${escapeHtml(p.name)}${star}${mode}</span>
        <span class="tier-score">${escapeHtml(libraryTierScoreLabel(p.score, built.stat))}</span>
      </div>`;
    }).join("");
    return `<div class="tier-row">
      <div class="tier-label tier-${row.tier}">${row.tier}</div>
      <div class="tier-items">${items || `<span class="tier-none">&mdash;</span>`}</div>
    </div>`;
  }).join("");

  const statNote = (LIBRARY_TIER_STATS.find(s => s.key === built.stat) || {}).note || built.stat;
  // Ratchet-bits are ranked with the plain bits but include the ratchet, so
  // say so rather than letting them look like freakishly heavy bits.
  const rbNames = built.rows.flatMap(r => r.parts).filter(p => p.ratchetBit).map(p => p.name);
  const rbNote = rbNames.length
    ? ` ${escapeHtml([...new Set(rbNames)].join(" and "))} ${new Set(rbNames).size > 1 ? "are ratchet-bits" : "is a ratchet-bit"} — the ratchet is built in, so ${new Set(rbNames).size > 1 ? "they weigh" : "it weighs"} more than a plain bit.`
    : "";
  // `total` counts entries, and a mode-switching part contributes one per
  // mode, so say how many distinct parts that actually is.
  const partCount = new Set(built.rows.flatMap(r => r.parts).map(p => p.name)).size;
  const modeNote = built.total > partCount
    ? ` A part with a mode switch is listed once per mode.`
    : "";
  const countLabel = built.total > partCount
    ? `${built.total} entries from ${partCount} ${escapeHtml(built.type.label.toLowerCase())}s`
    : `${built.total} ${escapeHtml(built.type.label.toLowerCase())}s`;
  return `${controls}
    <div class="tier-rows">${rowsHtml}</div>
    <div class="tier-foot">${countLabel} ranked by ${escapeHtml(statNote)}. &#9733; marks a meta pick.${modeNote}${rbNote}</div>`;
}

function renderLibraryTier() {
  const host = document.getElementById("library-tier");
  if (!host) return;
  host.innerHTML = libraryRenderTierInner();
  // The tier rows and chip rails hide their scrollbars (six stacked rows meant
  // six tracks), which leaves a mouse with nothing to grab. Same treatment the
  // rest of the app's horizontal rails get: vertical wheel scrolls sideways,
  // and click-drag pans. Touch already swipes natively.
  host.querySelectorAll(".tier-items, .tier-chips").forEach(rail => {
    if (typeof enableHorizontalWheelScroll === "function") enableHorizontalWheelScroll(rail);
    if (typeof enableHorizontalDragScroll === "function") enableHorizontalDragScroll(rail);
  });
}

function initLibraryTier() {
  const host = document.getElementById("library-tier");
  if (!host) return;   // page without the Library tab
  renderLibraryTier();

  // Chip clicks repaint only the rows, so switching type / stat never disturbs
  // the rest of the tab.
  host.addEventListener("click", (e) => {
    const img = e.target.closest(".tier-img");
    if (img) {
      if (typeof window.openLibraryImagePopup === "function") {
        window.openLibraryImagePopup(img.src, img.dataset.partName || img.alt || "");
      }
      return;
    }
    const btn = e.target.closest("[data-tier-type], [data-tier-stat]");
    if (!btn) return;
    if (btn.dataset.tierType) libraryTierType = btn.dataset.tierType;
    if (btn.dataset.tierStat) libraryTierStat = btn.dataset.tierStat;
    saveLibraryTierChoice();
    renderLibraryTier();
  });

  document.querySelectorAll(".library-sub-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".library-sub-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const view = btn.dataset.libraryView;
      const search = document.getElementById("library-panel-search");
      const tier = document.getElementById("library-panel-tier");
      if (search) search.classList.toggle("hidden", view !== "search");
      if (tier) tier.classList.toggle("hidden", view !== "tier");
      if (view === "tier") renderLibraryTier();
      requestAnimationFrame(() => {
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  });
}

document.addEventListener("DOMContentLoaded", initLibraryTier);
