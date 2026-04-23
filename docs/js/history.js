// docs/js/history.js - combo history save/render, tournament history render, clear handlers
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

function renderTournamentHistory() {
  const container = document.getElementById("tournament-history-list");
  if (!container) return;
  const list = loadTournamentHistory();
  if (!list.length) {
    container.innerHTML = `<p class="tournament-history-empty">No tournaments yet. Tournaments you host, co-host, or watch will appear here with their Host and View codes.</p>`;
    return;
  }
  const modeLabel = m => {
    if (m === "single-elim") return "Single Elimination";
    if (m === "swiss") return "Swiss + Top 8";
    return "";
  };
  const roleLabel = r => {
    if (r === "host") return "Host";
    if (r === "co-host") return "Co-host";
    if (r === "view") return "Viewer";
    return "";
  };
  container.innerHTML = list.map(e => {
    const hasName = !!(e.name && e.name.trim());
    const displayName = hasName ? escapeHtml(e.name) : "(unnamed tournament)";
    const nameCls = hasName ? "tournament-history-name" : "tournament-history-name is-unnamed";
    const when = e.createdAt ? new Date(e.createdAt).toLocaleString() : "";
    const mLabel = modeLabel(e.mode);
    const rLabel = roleLabel(e.role);
    const codes = [];
    if (e.editCode) codes.push(`
      <span class="swiss-room-badge swiss-room-badge-edit" title="Host code — tap to copy">
        <span class="swiss-room-role">Host</span>
        <button type="button" class="swiss-room-code" data-room="${escapeHtml(e.editCode)}">${escapeHtml(e.editCode)}</button>
      </span>`);
    if (e.viewCode) codes.push(`
      <span class="swiss-room-badge swiss-room-badge-view" title="View code — tap to copy">
        <span class="swiss-room-role">View</span>
        <button type="button" class="swiss-room-code" data-room="${escapeHtml(e.viewCode)}">${escapeHtml(e.viewCode)}</button>
      </span>`);
    const metaBits = [];
    if (rLabel) metaBits.push(`<span class="tournament-history-role tournament-history-role-${e.role}">${rLabel}</span>`);
    if (mLabel) metaBits.push(`<span class="tournament-history-mode">${mLabel}</span>`);
    const joinKey = e.editCode || e.viewCode || "";
    return `
      <article class="tournament-history-item" data-join-code="${escapeHtml(joinKey)}" role="button" tabindex="0" title="Show final placements">
        <header class="tournament-history-header">
          <span class="${nameCls}" title="${escapeHtml(hasName ? e.name : '')}">${displayName}</span>
          <span class="tournament-history-tags">${metaBits.join("")}</span>
        </header>
        <div class="tournament-history-meta">
          ${when ? `<span class="tournament-history-time">${escapeHtml(when)}</span>` : "<span></span>"}
          <div class="swiss-room-badges">${codes.join("")}</div>
        </div>
      </article>`;
  }).join("");
  bindSwissRoomBadge(container);
  container.querySelectorAll(".tournament-history-item").forEach(el => {
    const openIt = () => {
      const code = el.dataset.joinCode;
      if (code) showTournamentResultsFromHistory(code);
    };
    el.addEventListener("click", e => {
      // Don't hijack copy-code button clicks.
      if (e.target.closest(".swiss-room-code")) return;
      openIt();
    });
    el.addEventListener("keydown", e => {
      if ((e.key === "Enter" || e.key === " ") && !e.target.closest(".swiss-room-code")) {
        e.preventDefault();
        openIt();
      }
    });
  });
  appendHistoryClearButton(container, "tournaments");
}

document.querySelectorAll(".history-sub-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".history-sub-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.historyView;
    const combos = document.getElementById("history-panel-combos");
    const tournaments = document.getElementById("history-panel-tournaments");
    if (combos) combos.classList.toggle("hidden", view !== "combos");
    if (tournaments) tournaments.classList.toggle("hidden", view !== "tournaments");
    if (view === "tournaments") renderTournamentHistory();
    else renderHistory();
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
});

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

  appendHistoryClearButton(container, "combos");
}

function clearCombosHistory() {
  if (!confirm("Clear your combo history? This can't be undone.")) return;
  localStorage.removeItem("beyblade_history");
  renderHistory();
}

function clearTournamentHistory() {
  if (!confirm("Clear tournament history? This will remove all saved tournament codes on this device.")) return;
  localStorage.removeItem(TOURNAMENT_HISTORY_KEY);
  renderTournamentHistory();
}

function appendHistoryClearButton(container, kind) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-reset btn-clear-history";
  const label = kind === "tournaments" ? "Clear Tournament History" : "Clear Combo History";
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.innerHTML = `<img src="assets/icons/delete.png" alt="Delete" onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x1F5D1;');">`;
  btn.addEventListener("click", kind === "tournaments" ? clearTournamentHistory : clearCombosHistory);
  container.appendChild(btn);
}
