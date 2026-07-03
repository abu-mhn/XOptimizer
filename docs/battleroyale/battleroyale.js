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

  const WINRATES_REF = "winRates";

  let dbHandle = null;
  let playersCache = {};     // uid -> { username, points, isJudge }
  let challengesCache = {};  // cid -> challenge
  let winRatesCache = {};    // usernameKey -> { wins, losses, ties }
  let listenersBound = false;
  let selfRegistered = false;
  let notifSeen = null;      // cid -> status snapshot for notification diffing

  // Win-rate tiers (a pyramid: higher tiers need BOTH a strong win rate AND
  // enough battles, so e.g. a 1–0 record can't reach the top). Win rate is the
  // player's tournament record (wins / total games). Ordered highest first.
  const BR_TIERS = [
    { key: "S", short: "S-Tier", name: "Grand Sovereign Tier", minGames: 30, minWinRate: 70 },
    { key: "A", short: "A-Tier", name: "Vanguard Tier",        minGames: 15, minWinRate: 60 },
    { key: "B", short: "B-Tier", name: "Circuit Tier",         minGames: 5,  minWinRate: 50 },
    { key: "C", short: "C-Tier", name: "Challenger Tier",      minGames: 0,  minWinRate: 0 },
  ];
  function brTierForRecord(rec) {
    const wins = num(rec && rec.wins), losses = num(rec && rec.losses), ties = num(rec && rec.ties);
    const games = wins + losses + ties;
    const wr = games ? (wins / games) * 100 : 0;
    for (const t of BR_TIERS) {
      if (games >= t.minGames && wr >= t.minWinRate) return t;
    }
    return BR_TIERS[BR_TIERS.length - 1]; // C-Tier — the default floor
  }
  function winKeyFor(username) {
    if (!username) return null;
    if (window.usernameKey) return window.usernameKey(username);
    return String(username).trim().toLowerCase().replace(/[.#$/\[\]]/g, "_");
  }
  // Win-rate record for a BR player (keyed by uid, carries a username).
  function recordForPlayer(p) {
    const key = winKeyFor(p && p.username);
    return key ? (winRatesCache[key] || null) : null;
  }
  function tierForPlayer(p) { return brTierForRecord(recordForPlayer(p)); }
  function winRatePctForPlayer(p) {
    const rec = recordForPlayer(p);
    const games = num(rec && rec.wins) + num(rec && rec.losses) + num(rec && rec.ties);
    return games ? Math.round((num(rec && rec.wins) / games) * 100) : 0;
  }
  function gamesForPlayer(p) {
    const rec = recordForPlayer(p);
    return num(rec && rec.wins) + num(rec && rec.losses) + num(rec && rec.ties);
  }

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
  // Developer-tagged accounts can challenge anyone, regardless of tier.
  function amDeveloper() { return !!(window.isDeveloper && window.isDeveloper()); }
  function brTabVisible() {
    const f = document.getElementById("form-battleroyale");
    return !!(f && !f.classList.contains("hidden"));
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  // ---- profile pictures / banners (shared with the Friends tab look) ----
  const BR_AVATAR_PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
  const brProfileCache = {}; // profileKey -> {photo, banner, smallBanner, ...} | null
  function fetchBrProfile(key) {
    if (key in brProfileCache) return Promise.resolve(brProfileCache[key]);
    const database = db();
    if (!database || !key) return Promise.resolve(null);
    return database.ref("profiles/" + key).once("value")
      .then(s => (brProfileCache[key] = s.val() || null))
      .catch(() => (brProfileCache[key] = null));
  }
  // Avatar + banner + name that open the profile card on hover/click.
  function brAvatarHtml(username) {
    return `<span class="fr-row-banner" data-banner></span><img class="fr-avatar fr-profile-trigger" data-avatar data-profile-username="${esc(username || "")}" title="View profile" alt="" src="${BR_AVATAR_PH}">`;
  }
  function hydrateBrAvatars(root) {
    root.querySelectorAll("[data-pkey]").forEach(rowEl => {
      const key = rowEl.dataset.pkey;
      if (!key) return;
      fetchBrProfile(key).then(p => {
        if (!p) return;
        const img = rowEl.querySelector("[data-avatar]");
        if (img && p.photo) { img.src = p.photo; if (p.photoPos) img.style.objectPosition = p.photoPos; }
        const banner = rowEl.querySelector("[data-banner]");
        const bsrc = p.smallBanner || p.banner;
        if (banner && bsrc) {
          banner.style.backgroundImage = `url("${bsrc}")`;
          if (p.bannerPos) banner.style.backgroundPosition = p.bannerPos;
          rowEl.classList.add("has-banner");
        }
      });
    });
  }

  // Active challenges this player can't be double-booked into.
  function isActive(c) { return c && (c.status === "pending" || c.status === "accepted"); }

  // ---- Shop: ability cards bought with Battle Royale points (BP) ----
  const BR_CARDS = {
    attackRulez: {
      id: "attackRulez",
      name: "Attack Rulez",
      price: 50,
      desc: "Your Attack-type combo auto-wins 1 point against a Stamina-type opponent. Can only be used once per battle.",
    },
  };
  function ownedCount(uid, cardId) {
    const p = playersCache[uid];
    return num(p && p.cards && p.cards[cardId]);
  }
  // "🃏 Challenger: Attack Rulez · Opponent: …" — cards played in a challenge.
  function cardsInPlayLine(c) {
    const cardsObj = (c && c.cards) || {};
    const parts = [];
    [["challengerUid", "challengerName"], ["opponentUid", "opponentName"]].forEach(([uidKey, nameKey]) => {
      const puid = c[uidKey];
      const played = (puid && cardsObj[puid]) || {};
      Object.keys(played).forEach(cardId => {
        if (played[cardId] && BR_CARDS[cardId]) parts.push(`${esc(c[nameKey] || "Player")}: ${esc(BR_CARDS[cardId].name)}`);
      });
    });
    return parts.length ? `<div class="br-card-cards">🃏 ${parts.join(" · ")}</div>` : "";
  }

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
      if (brTabVisible()) { render(); renderShop(); }
    });
    database.ref(CHALLENGES_REF).on("value", snap => {
      challengesCache = snap.val() || {};
      runNotifications();
      if (brTabVisible()) { render(); renderShop(); }
    });
    // Win rates (tournament W/L/T) drive each player's tier.
    database.ref(WINRATES_REF).on("value", snap => {
      winRatesCache = snap.val() || {};
      if (brTabVisible()) { render(); renderShop(); }
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
    // Developers can challenge anyone; everyone else is confined to their tier.
    if (!amDeveloper() && tierForPlayer(me).key !== tierForPlayer(opp).key) {
      alert(`You can only challenge a player in your own tier (${tierForPlayer(me).short}).`);
      return;
    }
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

  // Buy an ability card: deduct its price, grant one copy. The points
  // transaction aborts if the balance can't cover it (no overspend).
  function buyCard(cardId) {
    const uid = myUid();
    const database = db();
    const card = BR_CARDS[cardId];
    if (!uid || !database || !card) return;
    if (num((playersCache[uid] || {}).points) < card.price) {
      alert(`You need ${card.price} BP for ${card.name}.`);
      return;
    }
    const playerRef = database.ref(PLAYERS_REF + "/" + uid);
    playerRef.child("points").transaction(
      p => { const cur = num(p); return cur < card.price ? undefined : cur - card.price; },
      (err, committed) => {
        if (err || !committed) { if (!err) alert("Not enough BP."); return; }
        playerRef.child("cards/" + cardId).transaction(c => num(c) + 1).catch(() => {});
      }
    );
  }

  // Play an owned card in an accepted battle — flags it on the challenge so the
  // Judge applies its effect, and consumes one copy. Once per battle per card.
  function playCard(cid, cardId) {
    const uid = myUid();
    const database = db();
    const c = challengesCache[cid];
    const card = BR_CARDS[cardId];
    if (!uid || !database || !c || !card) return;
    if (c.status !== "accepted") return;
    if (uid !== c.challengerUid && uid !== c.opponentUid) return;
    if (c.cards && c.cards[uid] && c.cards[uid][cardId]) { alert(`${card.name} is already in play this battle.`); return; }
    if (ownedCount(uid, cardId) < 1) { alert(`You don't own ${card.name}.`); return; }
    database.ref(`${CHALLENGES_REF}/${cid}/cards/${uid}/${cardId}`).set(true)
      .then(() => database.ref(`${PLAYERS_REF}/${uid}/cards/${cardId}`).transaction(n => Math.max(0, num(n) - 1)))
      .catch(e => alert("Couldn't play the card: " + ((e && e.message) || e)));
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
    Object.keys(challengesCache).forEach(cid => {
      const c = challengesCache[cid];
      cur[cid] = { status: c.status, cards: c.cards || {} };
    });
    if (prev && uid) {
      Object.keys(challengesCache).forEach(cid => {
        const c = challengesCache[cid];
        const before = prev[cid];
        const beforeStatus = before && before.status;
        const now = c.status;
        // Status transitions.
        if (beforeStatus !== now) {
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
        }
        // Ability card just played by the OTHER side — tell the opponent + Judge.
        if (before && (uid === c.challengerUid || uid === c.opponentUid || uid === c.judgeUid)) {
          const beforeCards = (before && before.cards) || {};
          const nowCards = c.cards || {};
          Object.keys(nowCards).forEach(puid => {
            if (puid === uid) return; // I played it — don't notify myself
            Object.keys(nowCards[puid] || {}).forEach(cardId => {
              const wasPlayed = beforeCards[puid] && beforeCards[puid][cardId];
              if (!wasPlayed && nowCards[puid][cardId] && BR_CARDS[cardId]) {
                const who = puid === c.challengerUid ? c.challengerName : c.opponentName;
                brNotify("Ability card played", `${who || "A player"} played ${BR_CARDS[cardId].name}.`);
              }
            });
          });
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
    const myTier = tierForPlayer(me);
    const all = Object.keys(challengesCache).map(cid => Object.assign({ cid }, challengesCache[cid]));

    // Incoming (someone challenged ME, awaiting my accept).
    const incoming = all.filter(c => c.opponentUid === uid && c.status === "pending");
    // Outgoing (I challenged someone, still waiting for them to accept).
    const outgoing = all.filter(c => c.challengerUid === uid && c.status === "pending");
    // My active battles (accepted, I'm a player) — where ability cards are played.
    const myActive = all.filter(c => c.status === "accepted" && (c.challengerUid === uid || c.opponentUid === uid));
    // Judge queue (I'm the Judge, accepted and awaiting my verdict).
    const judging = all.filter(c => c.judgeUid === uid && c.status === "accepted");
    // Players I can challenge: SAME tier as me, with at least 1 point to stake,
    // not me, not already in an active challenge.
    const busyUids = new Set();
    all.filter(isActive).forEach(c => { busyUids.add(c.challengerUid); busyUids.add(c.opponentUid); });
    // Developers can challenge across every tier; everyone else sees only theirs.
    const anyTier = amDeveloper();
    const targets = Object.keys(playersCache)
      .filter(pid => pid !== uid && !busyUids.has(pid) &&
        num(playersCache[pid].points) >= 1 &&
        (anyTier || tierForPlayer(playersCache[pid]).key === myTier.key))
      .map(pid => Object.assign({ uid: pid }, playersCache[pid]))
      .sort((a, b) => num(b.points) - num(a.points) || (a.username || "").localeCompare(b.username || ""));

    const myGames = gamesForPlayer(me);
    const myWr = winRatePctForPlayer(me);
    let html = `<div class="br-points">Your tier: <strong class="br-tier br-tier-${myTier.key}">${myTier.short}</strong> <span class="br-tier-name">${myTier.name}</span>${amJudge() ? ` <span class="br-judge-tag">Judge</span>` : ""}</div>`;
    html += `<div class="br-points br-points-sub">Win rate: <strong>${myWr}%</strong> over ${myGames} battle${myGames === 1 ? "" : "s"} · Points: <strong>${myPoints}</strong></div>`;
    html += `<p class="br-hint">Your tier comes from your tournament win rate <em>and</em> how many battles you've played (a small record can't reach the top). You can only challenge players in your own tier — both stake an equal points wager and the Judge declares the winner, who takes the pot.</p>`;

    if (judging.length) {
      html += `<div class="br-section"><h3 class="br-h">To judge (${judging.length})</h3>` +
        judging.map(c => `
          <div class="br-card">
            <div class="br-card-main"><strong>${esc(c.challengerName)}</strong> vs <strong>${esc(c.opponentName)}</strong> · ${c.wager} pts</div>
            ${cardsInPlayLine(c)}
            <div class="br-card-actions">
              <span class="br-card-label">Winner:</span>
              <button type="button" class="br-btn br-btn-win" data-resolve="${c.cid}" data-winner="${esc(c.challengerUid)}">${esc(c.challengerName)}</button>
              <button type="button" class="br-btn br-btn-win" data-resolve="${c.cid}" data-winner="${esc(c.opponentUid)}">${esc(c.opponentName)}</button>
            </div>
          </div>`).join("") + `</div>`;
    }

    if (myActive.length) {
      html += `<div class="br-section"><h3 class="br-h">Your active battles (${myActive.length})</h3>` +
        myActive.map(c => {
          const oppName = c.challengerUid === uid ? c.opponentName : c.challengerName;
          const myPlayed = (c.cards && c.cards[uid]) || {};
          const playBtns = Object.values(BR_CARDS)
            .filter(card => ownedCount(uid, card.id) > 0 && !myPlayed[card.id])
            .map(card => `<button type="button" class="br-btn br-btn-play" data-play-cid="${c.cid}" data-play-card="${esc(card.id)}">Play ${esc(card.name)}</button>`)
            .join("");
          return `
          <div class="br-card">
            <div class="br-card-main">vs <strong>${esc(oppName)}</strong> · ${c.wager} pts · awaiting Judge ${esc(c.judgeName)}</div>
            ${cardsInPlayLine(c)}
            ${playBtns ? `<div class="br-card-actions">${playBtns}</div>` : ""}
          </div>`;
        }).join("") + `</div>`;
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

    const anyTierScope = amDeveloper();
    html += `<div class="br-section"><h3 class="br-h">Challenge a player <span class="br-sub">(${anyTierScope ? "any tier" : myTier.short + " only"})</span></h3>`;
    if (myPoints < 1) {
      html += `<p class="br-empty">You have no points to wager yet. Battle Royale points are awarded at the end of each month from your tournament ranking total — place in tournaments this month, then you can challenge ${anyTierScope ? "any player" : `players in your tier (${myTier.short})`}.</p>`;
    } else if (!targets.length) {
      html += `<p class="br-empty">No one to challenge right now — ${anyTierScope ? "no players" : `you can only challenge players in your tier (${myTier.short})`} who have at least 1 point to stake. Check back as others play.</p>`;
    } else {
      html += `<ul class="br-players">` + targets.map(p => {
        const t = tierForPlayer(p);
        return `
        <li class="br-player" data-pkey="${esc(winKeyFor(p.username) || "")}">
          ${brAvatarHtml(p.username)}
          <span class="br-player-name fr-profile-trigger" data-profile-username="${esc(p.username || "")}" title="View profile">${esc(p.username || "(unnamed)")} <span class="br-tier br-tier-${t.key}">${t.short}</span>${p.isJudge ? ` <span class="br-judge-tag">Judge</span>` : ""}</span>
          <span class="br-player-points">${winRatePctForPlayer(p)}% WR · ${num(p.points)} pts</span>
          <button type="button" class="br-btn br-btn-challenge" data-challenge="${esc(p.uid)}">Challenge</button>
        </li>`;
      }).join("") + `</ul>`;
    }
    html += `</div>`;

    root.innerHTML = html;
    hydrateBrAvatars(root);
    if (typeof window.bindTournamentProfileNames === "function") window.bindTournamentProfileNames(root);

    root.querySelectorAll("[data-challenge]").forEach(b => b.addEventListener("click", () => showChallengePopup(b.dataset.challenge)));
    root.querySelectorAll("[data-accept]").forEach(b => b.addEventListener("click", () => acceptChallenge(b.dataset.accept)));
    root.querySelectorAll("[data-decline]").forEach(b => b.addEventListener("click", () => declineChallenge(b.dataset.decline)));
    root.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => { if (confirm("Cancel this challenge?")) cancelChallenge(b.dataset.cancel); }));
    root.querySelectorAll("[data-resolve]").forEach(b => b.addEventListener("click", () => {
      const name = b.textContent.trim();
      if (confirm(`Declare ${name} the winner? Points will transfer immediately.`)) resolveChallenge(b.dataset.resolve, b.dataset.winner);
    }));
    root.querySelectorAll("[data-play-card]").forEach(b => b.addEventListener("click", () => {
      const card = BR_CARDS[b.dataset.playCard];
      if (card && confirm(`Play ${card.name} in this battle? It will be used up.`)) playCard(b.dataset.playCid, b.dataset.playCard);
    }));
  }

  // ---- Shop tab ----
  function renderShop() {
    const panel = document.getElementById("br-panel-shop");
    if (!panel) return;
    const uid = myUid();
    if (!uid) { panel.innerHTML = `<p class="br-empty">Sign in (Settings → Account) to use the Shop.</p>`; return; }
    const me = playersCache[uid] || {};
    const myPoints = num(me.points);
    let html = `<div class="br-points">Your points: <strong>${myPoints} BP</strong></div>`;
    html += `<p class="br-hint">Spend Battle Royale points (BP) on ability cards. Play a card during one of your active battles — the Judge applies its effect.</p>`;
    html += `<div class="br-shop-list">`;
    Object.values(BR_CARDS).forEach(card => {
      const owned = ownedCount(uid, card.id);
      const afford = myPoints >= card.price;
      html += `
        <div class="br-shop-card">
          <div class="br-shop-card-head">
            <span class="br-shop-card-name">${esc(card.name)}</span>
            <span class="br-shop-card-price">${card.price} BP</span>
          </div>
          <p class="br-shop-card-desc">${esc(card.desc)}</p>
          <div class="br-shop-card-foot">
            <span class="br-shop-card-owned">${owned ? `Owned: ${owned}` : "Not owned"}</span>
            <button type="button" class="br-btn br-btn-buy" data-buy="${esc(card.id)}"${afford ? "" : " disabled"}>${afford ? "Buy" : "Not enough BP"}</button>
          </div>
        </div>`;
    });
    html += `</div>`;
    panel.innerHTML = html;
    panel.querySelectorAll("[data-buy]").forEach(b => b.addEventListener("click", () => {
      const card = BR_CARDS[b.dataset.buy];
      if (card && confirm(`Buy ${card.name} for ${card.price} BP?`)) buyCard(b.dataset.buy);
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
    renderShop();
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
