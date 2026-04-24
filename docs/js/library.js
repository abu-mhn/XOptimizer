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
    const EXCLUDE_KEYS = ["name", "meta", "exclusive"];

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
      currentDir = key === "name" ? "asc" : "desc";
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

  input.addEventListener("input", () => {
    if (input.value && currentGetAll) {
      currentGetAll = null;
      updateFilterButtons();
    }
    runSearch();
  });
}

document.addEventListener("DOMContentLoaded", initLibrarySearch);
