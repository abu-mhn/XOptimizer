// docs/battleroyale/battleroyale.js — Battle Royale.
//
// Registered users challenge another player who has the SAME points, staking
// an equal wager. The challenger picks a Judge (a user with the "Judge" tag).
// Flow: challenge → opponent accepts → the Judge is notified, oversees the
// real battle and declares the winner → the wager moves loser → winner.
//
// Data model (Firebase):
//   battleRoyale/players/{uid}:    { username, points, isJudge, updatedAt }
//   battleRoyale/challenges/{cid}: { challengerUid, challengerName,
//        opponentUid, opponentName, judgeUid, judgeName, wager, status,
//        winnerUid?, createdAt, resolvedAt? }
//   status: pending → accepted | declined → resolved (+ cancelled)
//
// Points are a SEPARATE balance (everyone starts at BR_DEFAULT_POINTS) — the
// tournament ranking is untouched. The Judge's device performs the transfer;
// the DB rules let a Judge-tagged account write any player's points.
(function () {
  "use strict";

  const BR_DEFAULT_POINTS = 0; // everyone starts at 0 — points are credited at the monthly ranking rollover
  const PLAYERS_REF = "battleRoyale/players";
  const CHALLENGES_REF = "battleRoyale/challenges";

  let dbHandle = null;
  let playersCache = {};     // uid -> { username, points, isJudge }
  let challengesCache = {};  // cid -> challenge
  let listenersBound = false;
  let selfRegistered = false;
  let notifSeen = null;      // cid -> status snapshot for notification diffing

  // ---- helpers ----
  function db() {
    if (dbHandle) return dbHandle;
    try { if (typeof firebase !== "undefined" && firebase.database) dbHandle = firebase.database(); }
    catch (e) { dbHandle = null; }
    return dbHandle;
  }
  function myUid() { const u = window.getCurrentUser && window.getCurrentUser(); return u ? u.uid : null; }
  function myName() { return (window.getCurrentUsername && window.getCurrentUsername()) || ""; }
  function amJudge() { return !!(window.isJudge && window.isJudge()); }
  function brTabVisible() {
    const f = document.getElementById("form-battleroyale");
    return !!(f && !f.classList.contains("hidden"));
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // Active challenges this player can't be double-booked into.
  function isActive(c) { return c && (c.status === "pending" || c.status === "accepted"); }

  // ---- self registration (gives the user a points balance + listing) ----
  function registerSelf() {
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const ref = database.ref(PLAYERS_REF + "/" + uid);
    ref.once("value").then(snap => {
      const cur = snap.val();
      if (!cur) {
        ref.set({ username: myName(), points: BR_DEFAULT_POINTS, isJudge: amJudge(), updatedAt: new Date().toISOString() })
          .catch(e => console.warn("BR register failed:", e));
      } else {
        // Keep username / judge status fresh; never self-edit points.
        ref.update({ username: myName(), isJudge: amJudge(), updatedAt: new Date().toISOString() })
          .catch(() => {});
      }
    }).catch(() => {});
    selfRegistered = true;
  }

  // ---- live data ----
  function bindListeners() {
    const database = db();
    if (!database || listenersBound) return;
    listenersBound = true;
    database.ref(PLAYERS_REF).on("value", snap => {
      playersCache = snap.val() || {};
      if (brTabVisible()) render();
    });
    database.ref(CHALLENGES_REF).on("value", snap => {
      challengesCache = snap.val() || {};
      runNotifications();
      if (brTabVisible()) render();
    });
  }

  // ---- challenge actions ----
  function createChallenge(opponentUid, judgeUid, wager) {
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const me = playersCache[uid], opp = playersCache[opponentUid], judge = playersCache[judgeUid];
    if (!me || !opp) { alert("That player is no longer available."); return; }
    if (!judge || !judge.isJudge) { alert("Pick a Judge to oversee the battle."); return; }
    if (num(opp.points) > num(me.points)) { alert("You can only challenge a player with the same points or fewer."); return; }
    // Both stake an equal wager, so it can't exceed the lower (opponent's) balance.
    const w = Math.floor(num(wager));
    if (!(w >= 1 && w <= num(opp.points))) { alert("Wager must be between 1 and the opponent's points."); return; }
    // Don't double-book either player.
    const busy = Object.values(challengesCache).some(c => isActive(c) &&
      [c.challengerUid, c.opponentUid].some(x => x === uid || x === opponentUid));
    if (busy) { alert("You or that player already have an active challenge."); return; }
    const ref = database.ref(CHALLENGES_REF).push();
    ref.set({
      challengerUid: uid, challengerName: myName(),
      opponentUid, opponentName: opp.username || "",
      judgeUid, judgeName: judge.username || "",
      wager: w, status: "pending",
      createdAt: new Date().toISOString()
    }).catch(e => alert("Couldn't send the challenge: " + ((e && e.message) || e)));
  }

  function setChallengeStatus(cid, status) {
    const database = db();
    if (!database || !cid) return;
    database.ref(CHALLENGES_REF + "/" + cid).update({ status }).catch(() => {});
  }
  function acceptChallenge(cid) { setChallengeStatus(cid, "accepted"); }
  function declineChallenge(cid) { setChallengeStatus(cid, "declined"); }
  function cancelChallenge(cid) {
    const database = db();
    if (database && cid) database.ref(CHALLENGES_REF + "/" + cid).remove().catch(() => {});
  }

  // Judge declares the winner → move the wager loser → winner, mark resolved.
  function resolveChallenge(cid, winnerUid) {
    const c = challengesCache[cid];
    const database = db();
    if (!c || !database) return;
    if (c.status !== "accepted") return;
    if (myUid() !== c.judgeUid) { alert("Only the assigned Judge can declare the winner."); return; }
    if (winnerUid !== c.challengerUid && winnerUid !== c.opponentUid) return;
    const loserUid = winnerUid === c.challengerUid ? c.opponentUid : c.challengerUid;
    const wager = num(c.wager);
    database.ref(PLAYERS_REF + "/" + winnerUid + "/points").transaction(p => num(p) + wager).catch(() => {});
    database.ref(PLAYERS_REF + "/" + loserUid + "/points").transaction(p => Math.max(0, num(p) - wager)).catch(() => {});
    database.ref(CHALLENGES_REF + "/" + cid).update({
      status: "resolved", winnerUid, resolvedAt: new Date().toISOString()
    }).catch(e => alert("Couldn't record the result: " + ((e && e.message) || e)));
  }

  // ---- notifications (run on every page, for any signed-in user) ----
  function runNotifications() {
    const uid = myUid();
    const prev = notifSeen;
    const cur = {};
    Object.keys(challengesCache).forEach(cid => { cur[cid] = challengesCache[cid].status; });
    if (prev && uid) {
      Object.keys(challengesCache).forEach(cid => {
        const c = challengesCache[cid];
        const before = prev[cid];
        const now = c.status;
        if (before === now) return;
        if (!before && now === "pending" && c.opponentUid === uid) {
          brNotify("Battle Royale challenge", `${c.challengerName || "Someone"} challenged you for ${c.wager} pts.`);
        } else if (now === "accepted" && c.judgeUid === uid) {
          brNotify("You're judging a battle", `${c.challengerName} vs ${c.opponentName} — ${c.wager} pts.`);
        } else if (now === "declined" && c.challengerUid === uid) {
          brNotify("Challenge declined", `${c.opponentName || "Your opponent"} declined.`);
        } else if (now === "resolved" && (c.challengerUid === uid || c.opponentUid === uid)) {
          const won = c.winnerUid === uid;
          brNotify("Battle result", won ? `You won ${c.wager} pts!` : `You lost ${c.wager} pts.`);
        }
      });
    }
    notifSeen = cur;
  }

  function brNotify(title, body) {
    showBrToast(title, body);
    if (typeof maybeFireSystemNotification === "function") {
      try { maybeFireSystemNotification(title, body); } catch (e) {}
    }
  }

  function showBrToast(title, body) {
    let host = null;
    if (typeof ensureToastContainer === "function") { try { host = ensureToastContainer(); } catch (e) {} }
    if (!host) {
      host = document.getElementById("match-toasts");
      if (!host) { host = document.createElement("div"); host.id = "match-toasts"; host.className = "match-toasts"; document.body.appendChild(host); }
    }
    const card = document.createElement("div");
    card.className = "match-toast match-toast-mine";
    card.innerHTML = `<div class="match-toast-head"><span class="match-toast-tag">${esc(title)}</span>` +
      `<button type="button" class="match-toast-close" aria-label="Dismiss">&times;</button></div>` +
      `<div class="match-toast-where">${esc(body)}</div>`;
    const dismiss = () => { card.classList.add("match-toast-leaving"); setTimeout(() => card.remove(), 300); };
    card.addEventListener("click", dismiss);
    host.appendChild(card);
    setTimeout(dismiss, 8000);
  }

  // ---- rendering ----
  function render() {
    const root = document.getElementById("br-content");
    if (!root) return;
    const uid = myUid();
    if (!uid) {
      root.innerHTML = `<p class="br-empty">Sign in (Settings → Account) to join Battle Royale.</p>`;
      return;
    }
    const me = playersCache[uid] || { points: BR_DEFAULT_POINTS, username: myName() };
    const myPoints = num(me.points);
    const all = Object.keys(challengesCache).map(cid => Object.assign({ cid }, challengesCache[cid]));

    // Incoming (someone challenged ME, awaiting my accept).
    const incoming = all.filter(c => c.opponentUid === uid && c.status === "pending");
    // Outgoing (I challenged someone).
    const outgoing = all.filter(c => c.challengerUid === uid && isActive(c));
    // Judge queue (I'm the Judge, accepted and awaiting my verdict).
    const judging = all.filter(c => c.judgeUid === uid && c.status === "accepted");
    // Players I can challenge: equal OR fewer points, with at least 1 point to
    // stake, not me, not already in an active challenge.
    const busyUids = new Set();
    all.filter(isActive).forEach(c => { busyUids.add(c.challengerUid); busyUids.add(c.opponentUid); });
    const targets = Object.keys(playersCache)
      .filter(pid => pid !== uid && !busyUids.has(pid) &&
        num(playersCache[pid].points) >= 1 && num(playersCache[pid].points) <= myPoints)
      .map(pid => Object.assign({ uid: pid }, playersCache[pid]))
      .sort((a, b) => num(b.points) - num(a.points) || (a.username || "").localeCompare(b.username || ""));

    let html = `<div class="br-points">Your points: <strong>${myPoints}</strong>${amJudge() ? ` <span class="br-judge-tag">Judge</span>` : ""}</div>`;
    html += `<p class="br-hint">Points come from your tournament ranking: at the end of each month your ranking total is converted into Battle Royale points and the ranking resets. Challenge a player with the same points or fewer — both stake an equal wager and the Judge declares the winner.</p>`;

    if (judging.length) {
      html += `<div class="br-section"><h3 class="br-h">To judge (${judging.length})</h3>` +
        judging.map(c => `
          <div class="br-card">
            <div class="br-card-main"><strong>${esc(c.challengerName)}</strong> vs <strong>${esc(c.opponentName)}</strong> · ${c.wager} pts</div>
            <div class="br-card-actions">
              <span class="br-card-label">Winner:</span>
              <button type="button" class="br-btn br-btn-win" data-resolve="${c.cid}" data-winner="${esc(c.challengerUid)}">${esc(c.challengerName)}</button>
              <button type="button" class="br-btn br-btn-win" data-resolve="${c.cid}" data-winner="${esc(c.opponentUid)}">${esc(c.opponentName)}</button>
            </div>
          </div>`).join("") + `</div>`;
    }

    if (incoming.length) {
      html += `<div class="br-section"><h3 class="br-h">Challenges to you (${incoming.length})</h3>` +
        incoming.map(c => `
          <div class="br-card">
            <div class="br-card-main"><strong>${esc(c.challengerName)}</strong> challenged you · ${c.wager} pts · Judge: ${esc(c.judgeName)}</div>
            <div class="br-card-actions">
              <button type="button" class="br-btn br-btn-accept" data-accept="${c.cid}">Accept</button>
              <button type="button" class="br-btn br-btn-decline" data-decline="${c.cid}">Decline</button>
            </div>
          </div>`).join("") + `</div>`;
    }

    if (outgoing.length) {
      html += `<div class="br-section"><h3 class="br-h">Your challenges</h3>` +
        outgoing.map(c => `
          <div class="br-card">
            <div class="br-card-main">vs <strong>${esc(c.opponentName)}</strong> · ${c.wager} pts · ${c.status === "accepted" ? "accepted — awaiting Judge" : "waiting for opponent"}</div>
            <div class="br-card-actions">
              ${c.status === "pending" ? `<button type="button" class="br-btn br-btn-decline" data-cancel="${c.cid}">Cancel</button>` : `<span class="br-card-label">Judge: ${esc(c.judgeName)}</span>`}
            </div>
          </div>`).join("") + `</div>`;
    }

    html += `<div class="br-section"><h3 class="br-h">Challenge a player <span class="br-sub">(your points or fewer)</span></h3>`;
    if (myPoints < 1) {
      html += `<p class="br-empty">You have no points yet. Battle Royale points are awarded at the end of each month from your tournament ranking total — place in tournaments this month, then you can challenge other players.</p>`;
    } else if (!targets.length) {
      html += `<p class="br-empty">No one to challenge right now — you can challenge players with ${myPoints} points or fewer (and at least 1). Check back as others play.</p>`;
    } else {
      html += `<ul class="br-players">` + targets.map(p => `
        <li class="br-player">
          <span class="br-player-name">${esc(p.username || "(unnamed)")}${p.isJudge ? ` <span class="br-judge-tag">Judge</span>` : ""}</span>
          <span class="br-player-points">${num(p.points)} pts</span>
          <button type="button" class="br-btn br-btn-challenge" data-challenge="${esc(p.uid)}">Challenge</button>
        </li>`).join("") + `</ul>`;
    }
    html += `</div>`;

    root.innerHTML = html;

    root.querySelectorAll("[data-challenge]").forEach(b => b.addEventListener("click", () => showChallengePopup(b.dataset.challenge)));
    root.querySelectorAll("[data-accept]").forEach(b => b.addEventListener("click", () => acceptChallenge(b.dataset.accept)));
    root.querySelectorAll("[data-decline]").forEach(b => b.addEventListener("click", () => declineChallenge(b.dataset.decline)));
    root.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => { if (confirm("Cancel this challenge?")) cancelChallenge(b.dataset.cancel); }));
    root.querySelectorAll("[data-resolve]").forEach(b => b.addEventListener("click", () => {
      const name = b.textContent.trim();
      if (confirm(`Declare ${name} the winner? Points will transfer immediately.`)) resolveChallenge(b.dataset.resolve, b.dataset.winner);
    }));
  }

  // ---- challenge popup (pick wager + judge) ----
  function showChallengePopup(opponentUid) {
    const uid = myUid();
    const me = playersCache[uid], opp = playersCache[opponentUid];
    if (!me || !opp) return;
    document.getElementById("br-challenge-popup")?.remove();
    // Equal wager → bounded by the lower (opponent's) balance.
    const maxW = Math.min(num(me.points), num(opp.points));
    const judges = Object.keys(playersCache)
      .filter(pid => pid !== uid && pid !== opponentUid && playersCache[pid].isJudge)
      .map(pid => Object.assign({ uid: pid }, playersCache[pid]))
      .sort((a, b) => (a.username || "").localeCompare(b.username || ""));
    const overlay = document.createElement("div");
    overlay.id = "br-challenge-popup";
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-card">
        <h2 class="popup-title">Challenge ${esc(opp.username || "player")}</h2>
        <p class="popup-subtitle">Both stake the same wager. The Judge declares the winner, who takes the pot.</p>
        <label class="tournament-name-label" for="br-wager">Wager (1–${maxW})</label>
        <input type="number" id="br-wager" class="tournament-name-input" min="1" max="${maxW}" step="1" value="${Math.min(10, maxW)}">
        <label class="tournament-name-label" for="br-judge">Judge</label>
        ${judges.length
          ? `<select id="br-judge" class="tournament-name-input">${judges.map(j => `<option value="${esc(j.uid)}">${esc(j.username || "(unnamed)")}</option>`).join("")}</select>`
          : `<p class="br-empty">No Judges are available yet. A user with the "Judge" tag must open Battle Royale at least once to be selectable.</p>`}
        <div id="br-challenge-status" class="swiss-join-status"></div>
        <div class="popup-actions">
          <button type="button" id="br-challenge-send" class="btn"${judges.length ? "" : " disabled"}>Send challenge</button>
          <button type="button" id="br-challenge-cancel" class="btn popup-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("#br-challenge-cancel").onclick = close;
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
    overlay.querySelector("#br-challenge-send").onclick = () => {
      const w = parseInt(overlay.querySelector("#br-wager").value, 10);
      const judgeUid = overlay.querySelector("#br-judge")?.value;
      if (!judgeUid) return;
      createChallenge(opponentUid, judgeUid, w);
      close();
    };
  }

  // ---- entry point (called by core.js when the tab is active) ----
  window.renderBattleRoyale = function renderBattleRoyale() {
    if (!selfRegistered) registerSelf();
    bindListeners();
    render();
  };

  // ---- Battle / Shop sub-tabs ----
  // Clicking a sub-tab activates it and shows the matching panel; the other
  // panels get hidden. Mirrors the reel / history sub-tab pattern.
  function setupBrSubTabs() {
    const tabs = document.querySelectorAll(".br-sub-tab");
    if (!tabs.length) return;
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        const view = tab.dataset.brView;
        tabs.forEach(t => t.classList.toggle("active", t === tab));
        document.querySelectorAll(".br-panel").forEach(panel => {
          panel.classList.toggle("hidden", panel.id !== "br-panel-" + view);
        });
      });
    });
  }

  // Bind notification listeners on every page once signed in (so a Judge /
  // opponent is alerted even while on another tab).
  function boot() { if (myUid()) bindListeners(); }
  window.addEventListener("userprofilechange", () => {
    selfRegistered = false;
    boot();
    if (brTabVisible()) window.renderBattleRoyale();
  });
  window.addEventListener("load", () => { boot(); setupBrSubTabs(); });
})();
