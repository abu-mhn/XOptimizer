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

  // ---- Ability cards ----
  // Shop cards are bought with Battle Royale points (BP). Starter cards are
  // granted free to every player (see STARTER_DECK / registerSelf) and shown in
  // the Deck tab. The Judge applies a card's effect when it's played in a battle.
  const BR_CARDS = {
    attackRulez: {
      id: "attackRulez",
      name: "Attack Rulez",
      price: 50,
      desc: "Your Attack-type combo auto-wins 1 point against a Stamina-type opponent. Can only be used once per battle.",
    },
    jankenpon:   { id: "jankenpon",   name: "Jankenpon",    starter: true, type: "ability", desc: "Settle a tied battle with rock-paper-scissors (Jankenpon)." },
    attackRule:  { id: "attackRule",  name: "Attack Rule",  starter: true, type: "ability", desc: "Play before a battle — favours Attack-type combos this match." },
    staminaRule: { id: "staminaRule", name: "Stamina Rule", starter: true, type: "ability", desc: "Play before a battle — favours Stamina-type combos this match." },
    defenseRule: { id: "defenseRule", name: "Defense Rule", starter: true, type: "ability", desc: "Play before a battle — favours Defense-type combos this match." },
    balanceRule: { id: "balanceRule", name: "Balance Rule", starter: true, type: "ability", desc: "Play before a battle — favours Balance-type combos this match." },
    negate:      { id: "negate",      name: "Negate",       starter: true, type: "ability", desc: "Cancel the opponent's played card." },
    exchange:    { id: "exchange",    name: "Exchange",     starter: true, type: "ability", desc: "Swap one of your cards with the opponent's." },
    revival:     { id: "revival",     name: "Revival",      starter: true, type: "ability", desc: "Return a used card to your deck." },
    stage:       { id: "stage",       name: "Stage",        starter: true, type: "stadium", desc: "Set the stage for this battle." },
    colosseum:   { id: "colosseum",   name: "Colosseum",    starter: true, type: "stadium", desc: "Set the colosseum for this battle." },
  };

  // Every player starts with one of each of these (in listed order).
  const STARTER_DECK = ["jankenpon", "attackRule", "staminaRule", "defenseRule", "balanceRule", "negate", "exchange", "revival", "stage", "colosseum"];
  // A deck holds at most this many cards in total (across all card types).
  const DECK_MAX = 10;
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
        const val = played[cardId], card = BR_CARDS[cardId];
        if (!val || !card) return;
        // Ability cards store the combo index (1..3); a stadium stores `true`.
        const where = card.type === "stadium" ? " (Stadium)" : (typeof val === "number" && val >= 1 ? ` (Combo ${val})` : "");
        parts.push(`${esc(c[nameKey] || "Player")}: ${esc(card.name)}${where}`);
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
    // Starter deck: one of each starter card.
    const starterCards = STARTER_DECK.reduce((o, id) => { o[id] = 1; return o; }, {});
    ref.once("value").then(snap => {
      const cur = snap.val();
      if (!cur) {
        ref.set({ username: myName(), points: BR_DEFAULT_POINTS, isJudge: amJudge(), cards: starterCards, updatedAt: new Date().toISOString() })
          .catch(e => console.warn("BR register failed:", e));
      } else {
        // Keep username / judge status fresh; never self-edit points.
        ref.update({ username: myName(), isJudge: amJudge(), updatedAt: new Date().toISOString() })
          .catch(() => {});
        // Grant the starter deck once to existing players who don't have it yet
        // (detected by none of the starter cards being present on the record).
        const hasStarter = cur.cards && STARTER_DECK.some(id => cur.cards[id] != null);
        if (!hasStarter) {
          const updates = {};
          STARTER_DECK.forEach(id => { updates["cards/" + id] = 1; });
          ref.update(updates).catch(() => {});
        }
      }
    }).catch(() => {});
    selfRegistered = true;
  }

  // Keep the player record's Judge flag in sync with the live tag. The first
  // registration can run before the profile (and its Judge tag) has loaded, so
  // the flag lands as false; this corrects it once — without it, OTHER players
  // couldn't pick this user as a Judge. Writes only on a real mismatch.
  function syncJudgeFlag() {
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const rec = playersCache[uid];
    if (!rec || !!rec.isJudge === amJudge()) return;
    database.ref(PLAYERS_REF + "/" + uid + "/isJudge").set(amJudge()).catch(() => {});
  }

  // ---- live data ----
  function bindListeners() {
    const database = db();
    if (!database || listenersBound) return;
    listenersBound = true;
    bindBrOrientation();
    database.ref(PLAYERS_REF).on("value", snap => {
      playersCache = snap.val() || {};
      if (brTabVisible()) { render(); renderShop(); renderBrDeck(); }
    });
    database.ref(CHALLENGES_REF).on("value", snap => {
      challengesCache = snap.val() || {};
      runNotifications();
      // Players prep their loadout by tilting; the Judge scores an accepted
      // battle by tilting. Refresh both on any page so a rotate does the right
      // thing (and the prep overlay closes once you've equipped). Tilt auto-open
      // is mobile-only — desktop uses the on-screen "Draw cards" button.
      if (brIsMobile) handleBrPrepOrientation();
      armJudgeScoreboard();
      if (brTabVisible()) { render(); renderShop(); renderBrDeck(); }
    });
    // Win rates (tournament W/L/T) drive each player's tier.
    database.ref(WINRATES_REF).on("value", snap => {
      winRatesCache = snap.val() || {};
      if (brTabVisible()) { render(); renderShop(); renderBrDeck(); }
    });
  }

  // ---- challenge actions ----
  function createChallenge(opponentUid, judgeUid, wager, judgeName) {
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const me = playersCache[uid], opp = playersCache[opponentUid], judge = playersCache[judgeUid];
    if (!me || !opp) { alert("That player is no longer available."); return; }
    // The judge came from the verified picker (a BR record's Judge flag, the
    // live self tag, or the public judges index confirmed by the profile tag) —
    // and may not have opened Battle Royale, so they needn't be in playersCache.
    // The DB rules still gate the actual point transfer on the real Judge tag.
    if (!judgeUid) { alert("Pick a Judge to oversee the battle."); return; }
    const resolvedJudgeName = (judge && judge.username) || judgeName || "";
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
      judgeUid, judgeName: resolvedJudgeName,
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

  // The battle whose scoreboard is currently armed for this Judge (so we don't
  // re-arm — and reset scores — on every data change while they're scoring).
  let brArmedCid = null;

  // Auto-arm the shared tilt scoreboard for the Judge's first accepted battle,
  // so they just rotate to landscape to score it (names + profile pics, exactly
  // like tournament). Higher score wins; a tie is rejected (the pot needs a
  // winner). Side A = challenger, Side B = opponent.
  function armJudgeScoreboard() {
    // If I still owe a loadout on a battle I'm playing in (e.g. a self-judge),
    // let me equip via the prep overlay first — don't arm the scoreboard yet.
    if (brPrepPending()) {
      if (brArmedCid) { brArmedCid = null; if (typeof window.resetScoreboardToDefault === "function") window.resetScoreboardToDefault(); }
      return;
    }
    const uid = myUid();
    const target = uid
      ? Object.keys(challengesCache)
          .map(cid => Object.assign({ cid }, challengesCache[cid]))
          .find(c => c.status === "accepted" && c.judgeUid === uid)
      : null;
    if (!target) {
      if (brArmedCid) {
        brArmedCid = null;
        if (typeof window.resetScoreboardToDefault === "function") window.resetScoreboardToDefault();
      }
      return;
    }
    if (brArmedCid === target.cid) return;          // already armed — leave scores alone
    if (typeof window.armScoreboard !== "function") return;
    brArmedCid = target.cid;
    window.armScoreboard(
      target.challengerName || "Challenger",
      target.opponentName || "Opponent",
      ({ scoreA, scoreB }) => {
        brArmedCid = null;
        if (scoreA === scoreB) {
          alert("It's a tie — the wager needs a winner. Tilt back and score again.");
          armJudgeScoreboard(); // re-arm the same battle for another go
          return;
        }
        resolveChallenge(target.cid, scoreA > scoreB ? target.challengerUid : target.opponentUid);
      },
      0, 0
    );
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
    syncJudgeFlag(); // heal a stale Judge flag so others can pick this user as Judge
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
            <div class="br-card-hint">📱 Rotate your phone to landscape to open the scoreboard and score this battle. The winner takes the pot.</div>
          </div>`).join("") + `</div>`;
    }

    if (myActive.length) {
      html += `<div class="br-section"><h3 class="br-h">Your active battles (${myActive.length})</h3>` +
        myActive.map(c => {
          const oppName = c.challengerUid === uid ? c.opponentName : c.challengerName;
          const unequipped = iAmUnequipped(c);
          return `
          <div class="br-card">
            <div class="br-card-main">vs <strong>${esc(oppName)}</strong> · ${c.wager} pts · awaiting Judge ${esc(c.judgeName)}</div>
            ${cardsInPlayLine(c)}
            ${unequipped ? `<div class="br-card-hint">📱 Rotate your phone to landscape (or tap Draw cards) to draw your hand and equip cards for this battle.</div>` : ""}
            <div class="br-card-actions">
              ${unequipped ? `<button type="button" class="br-btn br-btn-score" data-prep="${c.cid}">Draw cards</button>` : ""}
              <button type="button" class="br-btn br-btn-decline" data-cancel="${c.cid}">Cancel</button>
            </div>
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
        outgoing.map(c => {
          const unequipped = iAmUnequipped(c);
          return `
          <div class="br-card">
            <div class="br-card-main">vs <strong>${esc(c.opponentName)}</strong> · ${c.wager} pts · ${c.status === "accepted" ? "accepted — awaiting Judge" : "waiting for opponent"}</div>
            ${cardsInPlayLine(c)}
            ${unequipped ? `<div class="br-card-hint">📱 Rotate to landscape (or tap Draw cards) to set your loadout.</div>` : ""}
            <div class="br-card-actions">
              ${unequipped ? `<button type="button" class="br-btn br-btn-score" data-prep="${c.cid}">Draw cards</button>` : ""}
              ${c.status === "pending" ? `<button type="button" class="br-btn br-btn-decline" data-cancel="${c.cid}">Cancel</button>` : `<span class="br-card-label">Judge: ${esc(c.judgeName)}</span>`}
            </div>
          </div>`;
        }).join("") + `</div>`;
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
    root.querySelectorAll("[data-prep]").forEach(b => b.addEventListener("click", () => openBattlePrep(b.dataset.prep)));
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
      if (card.starter || card.price == null) return; // starter cards live in the Deck tab
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

  // Total cards currently in the player's deck (sum across the card types).
  function deckTotal(cards) {
    return STARTER_DECK.reduce((s, id) => s + num(cards && cards[id]), 0);
  }

  // Add / remove one copy of a card, keeping the deck total within DECK_MAX.
  function adjustDeckCard(cardId, delta) {
    const uid = myUid();
    const database = db();
    if (!uid || !database || !BR_CARDS[cardId]) return;
    const cards = (playersCache[uid] || {}).cards || {};
    const cur = num(cards[cardId]);
    if (delta > 0 && deckTotal(cards) >= DECK_MAX) return; // deck full
    const next = Math.max(0, cur + delta);
    if (next === cur) return;
    database.ref(PLAYERS_REF + "/" + uid + "/cards/" + cardId).set(next).catch(() => {});
  }

  // ---- Deck tab: build your deck of ability cards (max DECK_MAX) ----
  function renderBrDeck() {
    const panel = document.getElementById("br-panel-deck");
    if (!panel) return;
    const uid = myUid();
    if (!uid) { panel.innerHTML = `<p class="br-empty">Sign in (Settings → Account) to build your deck.</p>`; return; }
    const cards = (playersCache[uid] || {}).cards || {};
    const total = deckTotal(cards);
    const full = total >= DECK_MAX;
    // One card row: name + a type chip (Ability / Stadium), a stepper, and desc.
    const cardRow = (id) => {
      const card = BR_CARDS[id];
      if (!card) return "";
      const n = num(cards[id]);
      const type = card.type === "stadium" ? "stadium" : "ability";
      const typeLabel = type === "stadium" ? "Stadium" : "Ability";
      return `
        <div class="br-deck-card">
          <div class="br-deck-card-head">
            <span class="br-deck-card-name">${esc(card.name)} <span class="br-type-chip br-type-${type}">${typeLabel}</span></span>
            <span class="br-deck-stepper">
              <button type="button" class="br-deck-step" data-deck-dec="${esc(id)}" aria-label="Remove one ${esc(card.name)}"${n ? "" : " disabled"}>&minus;</button>
              <span class="br-deck-card-count">${n}</span>
              <button type="button" class="br-deck-step" data-deck-inc="${esc(id)}" aria-label="Add one ${esc(card.name)}"${full ? " disabled" : ""}>+</button>
            </span>
          </div>
          ${card.desc ? `<p class="br-deck-card-desc">${esc(card.desc)}</p>` : ""}
        </div>`;
    };
    let html = `<div class="br-points">Your deck: <strong>${total} / ${DECK_MAX}</strong> cards${full ? ` <span class="br-deck-full">Full</span>` : ""}</div>`;
    html += `<p class="br-hint">Adjust how many of each card you bring (up to ${DECK_MAX} total). Play a card during one of your active battles — the Judge applies its effect.</p>`;
    html += `<div class="br-deck-list">${STARTER_DECK.map(cardRow).join("")}</div>`;
    panel.innerHTML = html;
    panel.querySelectorAll("[data-deck-inc]").forEach(b => b.addEventListener("click", () => adjustDeckCard(b.dataset.deckInc, 1)));
    panel.querySelectorAll("[data-deck-dec]").forEach(b => b.addEventListener("click", () => adjustDeckCard(b.dataset.deckDec, -1)));
  }

  // Every account with the "Judge" tag, resolved to { uid, username } — not just
  // those who've opened Battle Royale. Starts from the BR players cache (reliable
  // uid + tag), then adds anyone in the public `judges` index (keyed by username)
  // whose profile actually carries the Judge tag (the index also holds Guest
  // Judge / Keeper, so we verify). The opponent is always excluded.
  function fetchAllJudges(opponentUid) {
    const database = db();
    const meUid = myUid();
    const out = {};
    Object.keys(playersCache).forEach(pid => {
      const p = playersCache[pid];
      if (p && pid !== opponentUid && (p.isJudge || (pid === meUid && amJudge()))) {
        out[pid] = { uid: pid, username: p.username || "" };
      }
    });
    if (!database) return Promise.resolve(Object.values(out));
    return database.ref("judges").once("value").then(snap => {
      const idx = snap.val() || {};
      return Promise.all(Object.keys(idx).map(key => Promise.all([
        database.ref("usernames/" + key + "/uid").once("value").then(s => s.val()).catch(() => null),
        database.ref("profiles/" + key + "/tags/Judge").once("value").then(s => s.val()).catch(() => null)
      ]).then(([juid, hasJudge]) => {
        if (juid && hasJudge === true && juid !== opponentUid && !out[juid]) {
          out[juid] = { uid: juid, username: idx[key] || "" };
        }
      })));
    }).then(() => Object.values(out)).catch(() => Object.values(out));
  }

  // ---- challenge popup (pick wager + judge) ----
  function showChallengePopup(opponentUid) {
    const uid = myUid();
    const me = playersCache[uid], opp = playersCache[opponentUid];
    if (!me || !opp) return;
    document.getElementById("br-challenge-popup")?.remove();
    // Equal wager → bounded by the lower (opponent's) balance.
    const maxW = Math.min(num(me.points), num(opp.points));
    const overlay = document.createElement("div");
    overlay.id = "br-challenge-popup";
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-card">
        <h2 class="popup-title">Challenge ${esc(opp.username || "player")}</h2>
        <p class="popup-subtitle">Both stake the same wager. The Judge declares the winner, who takes the pot.</p>
        <label class="tournament-name-label" for="br-wager">Wager (1–${maxW})</label>
        <input type="number" id="br-wager" class="tournament-name-input" min="1" max="${maxW}" step="1" value="${Math.min(10, maxW)}">
        <label class="tournament-name-label">Judge</label>
        <div id="br-judge-section"></div>
        <div id="br-challenge-status" class="swiss-join-status"></div>
        <div class="popup-actions">
          <button type="button" id="br-challenge-send" class="btn">Send challenge</button>
          <button type="button" id="br-challenge-cancel" class="btn popup-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("#br-challenge-cancel").onclick = close;
    overlay.addEventListener("click", e => { if (e.target === overlay) close(); });

    // Selected judge persists across repaints (the list fills in async).
    let selectedJudge = null; // { uid, username }
    const sendBtn = overlay.querySelector("#br-challenge-send");
    function paintJudges(list) {
      const section = overlay.querySelector("#br-judge-section");
      if (!section) return;
      list = list.slice().sort((a, b) => (a.username || "").localeCompare(b.username || ""));
      if (!list.length) {
        section.innerHTML = `<p class="br-empty">No Judges are available yet. Ask a user with the "Judge" tag to sign in.</p>`;
        selectedJudge = null;
        if (sendBtn) sendBtn.disabled = true;
        return;
      }
      if (!selectedJudge || !list.some(j => j.uid === selectedJudge.uid)) selectedJudge = list[0];
      section.innerHTML = `<div class="br-judge-picker" role="listbox" aria-label="Judge">${list.map(j => {
        const on = j.uid === selectedJudge.uid;
        return `<button type="button" class="br-judge-option${on ? " selected" : ""}" data-judge="${esc(j.uid)}" data-name="${esc(j.username || "")}" role="option" aria-selected="${on ? "true" : "false"}">${esc(j.username || "(unnamed)")}${j.uid === uid ? " (you)" : ""}</button>`;
      }).join("")}</div>`;
      if (sendBtn) sendBtn.disabled = false;
      section.querySelectorAll(".br-judge-option").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedJudge = { uid: btn.dataset.judge, username: btn.dataset.name || "" };
          section.querySelectorAll(".br-judge-option").forEach(b => {
            const sel = b === btn;
            b.classList.toggle("selected", sel);
            b.setAttribute("aria-selected", sel ? "true" : "false");
          });
        });
      });
    }

    // Show the judges we already know instantly, then fill in the rest.
    const known = Object.keys(playersCache)
      .filter(pid => { const p = playersCache[pid]; return p && pid !== opponentUid && (p.isJudge || (pid === uid && amJudge())); })
      .map(pid => ({ uid: pid, username: (playersCache[pid] || {}).username || "" }));
    paintJudges(known);
    fetchAllJudges(opponentUid).then(paintJudges);

    sendBtn.onclick = () => {
      const w = parseInt(overlay.querySelector("#br-wager").value, 10);
      if (!selectedJudge) { alert("Pick a Judge to oversee the battle."); return; }
      createChallenge(opponentUid, selectedJudge.uid, w, selectedJudge.username);
      close();
    };
  }

  // ========================= Battle prep (tilt to draw + equip) =========================
  // When you're in an active battle (as challenger once created, or opponent
  // once you've accepted) and haven't set your loadout, tilt to landscape: draw
  // 5 cards from your deck, then equip 3–4 ability cards (a shared pool) plus up
  // to one Stadium card (which applies to both sides). Your starred Beyblade
  // combo deck auto-fills for reference. Equipped cards are saved on the
  // challenge so the opponent and the Judge can see them.
  const BR_HAND_SIZE = 5;
  const BR_EQUIP_MIN_ABILITY = 3, BR_EQUIP_MAX_ABILITY = 4, BR_EQUIP_MAX_STADIUM = 1;

  // Mobile / landscape detection (mirrors scoreboard.js, incl. the iPadOS case).
  const brIsIPadOS = navigator.maxTouchPoints > 1 && (navigator.platform === "MacIntel" || /Macintosh/.test(navigator.userAgent));
  const brIsMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || brIsIPadOS;
  function brIsLandscape() {
    return (screen.orientation && screen.orientation.type) ? screen.orientation.type.indexOf("landscape") === 0 : window.innerWidth > window.innerHeight;
  }

  // Weighted random draw of `size` cards from a deck (cards map).
  function drawHand(cardsMap, size) {
    const pool = [];
    STARTER_DECK.forEach(id => { const n = num(cardsMap && cardsMap[id]); for (let i = 0; i < n; i++) pool.push(id); });
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    return pool.slice(0, size || BR_HAND_SIZE);
  }

  // My battle that still needs my equipped cards: I'm the challenger of a
  // pending/accepted battle, or the opponent of one I've already accepted.
  function myBattleNeedingEquip() {
    const uid = myUid();
    if (!uid) return null;
    return Object.keys(challengesCache)
      .map(cid => Object.assign({ cid }, challengesCache[cid]))
      .find(c => (
        (c.challengerUid === uid && (c.status === "pending" || c.status === "accepted")) ||
        (c.opponentUid === uid && c.status === "accepted")
      ) && !(c.cards && c.cards[uid] && Object.keys(c.cards[uid]).some(k => c.cards[uid][k])));
  }
  function brPrepPending() { return !!myBattleNeedingEquip(); }

  let brPrepCid = null, brPrepHand = [];
  let brPrepEquip = {};      // cardId -> combo index (1..3) for equipped ability cards
  let brPrepStadium = null;  // chosen stadium cardId (applies to both sides)
  let brPrepRedrawn = false; // Redraw is allowed once, and only before any card is selected

  function ensureBattleOverlay() {
    let overlay = document.getElementById("br-battle-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "br-battle-overlay";
    overlay.className = "br-battle-overlay hidden";
    document.body.appendChild(overlay);
    return overlay;
  }
  function abilityCount() { return Object.keys(brPrepEquip).length; }
  // Combo numbers (1-based) that hold a Beyblade in the starred deck.
  function brFilledCombos() {
    const beyDeck = (window.getDefaultRegistrationDeck && window.getDefaultRegistrationDeck()) || null;
    const out = [];
    if (beyDeck) beyDeck.forEach((slot, i) => { if (slot && slot.parts && Object.values(slot.parts).some(Boolean)) out.push(i + 1); });
    return out;
  }

  // Assign / unassign an ability card onto a Beyblade combo (1..3). One ability
  // per combo — assigning to an occupied combo replaces whatever was there.
  function assignCombo(cardId, combo) {
    if ((BR_CARDS[cardId] || {}).type === "stadium") return;
    if (brPrepEquip[cardId] === combo) { delete brPrepEquip[cardId]; renderBattlePrep(); return; }
    Object.keys(brPrepEquip).forEach(id => { if (brPrepEquip[id] === combo) delete brPrepEquip[id]; });
    brPrepEquip[cardId] = combo;
    renderBattlePrep();
  }
  // The shared Stadium (one at most; applies to both sides).
  function toggleStadium(cardId) {
    brPrepStadium = (brPrepStadium === cardId) ? null : cardId;
    renderBattlePrep();
  }

  function equipBattleCards() {
    const uid = myUid();
    const database = db();
    if (!uid || !database || !brPrepCid) return;
    const filled = brFilledCombos();
    if (!filled.length) { alert("Star a deck with Beyblade combos first (Deck tab)."); return; }
    if (abilityCount() < 1) { alert("Equip at least one ability card on a combo."); return; }
    const updates = {};
    Object.keys(brPrepEquip).forEach(id => { updates[id] = brPrepEquip[id]; }); // ability -> combo index (1..3)
    if (brPrepStadium) updates[brPrepStadium] = true;                            // stadium -> true
    database.ref(`${CHALLENGES_REF}/${brPrepCid}/cards/${uid}`).update(updates)
      .then(() => { document.getElementById("br-battle-overlay")?.classList.add("hidden"); })
      .catch(e => alert("Couldn't equip cards: " + ((e && e.message) || e)));
  }

  function renderBattlePrep() {
    const overlay = ensureBattleOverlay();
    const uid = myUid();
    const c = challengesCache[brPrepCid];
    if (!uid || !c) { overlay.classList.add("hidden"); return; }
    const oppName = c.challengerUid === uid ? (c.opponentName || "Opponent") : (c.challengerName || "Challenger");
    const beyDeck = (window.getDefaultRegistrationDeck && window.getDefaultRegistrationDeck()) || null;
    const comboParts = (i) => {
      const slot = beyDeck && beyDeck[i];
      return (slot && slot.parts) ? Object.values(slot.parts).filter(Boolean) : [];
    };
    const comboCount = beyDeck ? beyDeck.length : 0;
    // Beyblade deck — each combo lists the ability cards equipped on it.
    const combosHtml = beyDeck
      ? `<div class="brp-combos">` + beyDeck.map((slot, i) => {
          const parts = comboParts(i);
          const equipped = Object.keys(brPrepEquip).filter(id => brPrepEquip[id] === i + 1).map(id => esc(BR_CARDS[id].name));
          return `<div class="brp-combo">
            <span class="brp-combo-n">${i + 1}</span>
            <span class="brp-combo-parts">${parts.length ? esc(parts.join(" · ")) : "—"}${equipped.length ? `<span class="brp-combo-cards">🃏 ${equipped.join(", ")}</span>` : ""}</span>
          </div>`;
        }).join("") + `</div>`
      : `<p class="brp-note">Star a deck in the Deck tab first — ability cards equip onto your Beyblade combos.</p>`;
    // Hand: ability cards get combo buttons (1..N); stadium cards get a toggle.
    const handHtml = brPrepHand.map(id => {
      const card = BR_CARDS[id]; if (!card) return "";
      if (card.type === "stadium") {
        const on = brPrepStadium === id;
        return `<div class="brp-card brp-card-stadium${on ? " brp-card-on" : ""}">
          <div class="brp-card-top"><span class="brp-card-name">${esc(card.name)}</span><span class="br-type-chip br-type-stadium">Stadium</span></div>
          <button type="button" class="brp-equip-toggle" data-stadium="${esc(id)}">${on ? "Equipped ✓" : "Set stadium"}</button>
        </div>`;
      }
      const assigned = brPrepEquip[id];
      const comboBtns = Array.from({ length: comboCount }, (_, k) => {
        const combo = k + 1;
        const filled = comboParts(k).length > 0;
        return `<button type="button" class="brp-combo-btn${assigned === combo ? " on" : ""}" data-assign="${esc(id)}" data-combo="${combo}"${filled ? "" : " disabled"}>${combo}</button>`;
      }).join("");
      return `<div class="brp-card brp-card-ability${assigned ? " brp-card-on" : ""}">
        <div class="brp-card-top"><span class="brp-card-name">${esc(card.name)}</span><span class="br-type-chip br-type-ability">Ability</span></div>
        <div class="brp-card-equip"><span class="brp-equip-label">Equip on combo:</span>${comboBtns || `<span class="brp-note">star a deck</span>`}</div>
      </div>`;
    }).join("");
    const filled = brFilledCombos();
    const ab = abilityCount(), st = brPrepStadium ? 1 : 0;
    // Combos may be left empty — just require at least one ability equipped.
    const canEquip = ab >= 1;
    // Redraw: allowed once, and only before you've selected any card.
    const hasSelection = ab > 0 || !!brPrepStadium;
    const canRedraw = !brPrepRedrawn && !hasSelection;
    overlay.innerHTML = `
      <div class="brp-card-wrap">
        <div class="brp-head">
          <div>
            <div class="brp-title">Battle prep — vs ${esc(oppName)}</div>
            <div class="brp-sub">${c.wager} pts · Judge ${esc(c.judgeName || "")}</div>
          </div>
          <button type="button" id="brp-close" class="brp-close" aria-label="Close">&times;</button>
        </div>
        <div class="brp-section"><div class="brp-label">Your Beyblade deck — one ability card per combo</div>${combosHtml}</div>
        <div class="brp-section">
          <div class="brp-label">Your hand (${ab}/${filled.length || comboCount} ability · ${st}/${BR_EQUIP_MAX_STADIUM} stadium)</div>
          <div class="brp-hand">${handHtml || `<p class="brp-note">Your deck is empty — add cards in the Deck tab.</p>`}</div>
        </div>
        <div class="brp-actions">
          <button type="button" id="brp-redraw" class="btn br-btn-decline"${canRedraw ? "" : " disabled"} title="${canRedraw ? "Redraw once — you'll get one fewer card" : (brPrepRedrawn ? "You've already redrawn" : "Can't redraw after selecting a card")}">Redraw</button>
          <button type="button" id="brp-equip" class="btn"${canEquip ? "" : " disabled"}>Equip &amp; Ready</button>
        </div>
      </div>`;
    overlay.querySelectorAll("[data-assign]").forEach(b => b.addEventListener("click", () => assignCombo(b.dataset.assign, Number(b.dataset.combo))));
    overlay.querySelectorAll("[data-stadium]").forEach(b => b.addEventListener("click", () => toggleStadium(b.dataset.stadium)));
    overlay.querySelector("#brp-equip")?.addEventListener("click", equipBattleCards);
    overlay.querySelector("#brp-close")?.addEventListener("click", () => overlay.classList.add("hidden"));
    overlay.querySelector("#brp-redraw")?.addEventListener("click", () => {
      if (brPrepRedrawn) return;
      if (hasSelection) { alert("You can't redraw after selecting a card."); return; }
      // Redraw is a one-time reroll for one fewer card.
      brPrepHand = drawHand((playersCache[uid] || {}).cards || {}, BR_HAND_SIZE - 1);
      brPrepRedrawn = true;
      renderBattlePrep();
    });
  }

  // Open the prep overlay for a specific battle (used by the on-screen button;
  // on mobile the tilt handler does the same). Draws a fresh hand only when
  // switching to a different battle.
  function openBattlePrep(cid) {
    const c = challengesCache[cid];
    if (!c) return;
    if (brPrepCid !== cid) {
      brPrepCid = cid;
      brPrepHand = drawHand((playersCache[myUid()] || {}).cards || {});
      brPrepEquip = {}; brPrepStadium = null; brPrepRedrawn = false;
    }
    renderBattlePrep();
    ensureBattleOverlay().classList.remove("hidden");
  }

  // True when I'm a player in this battle and haven't set my loadout yet.
  function iAmUnequipped(c) {
    const uid = myUid();
    return !!(uid && (c.challengerUid === uid || c.opponentUid === uid)
      && !(c.cards && c.cards[uid] && Object.keys(c.cards[uid]).some(k => c.cards[uid][k])));
  }

  // Show the prep overlay when a battle needs a loadout and the phone is tilted
  // to landscape; hide it otherwise. Draws a fresh hand only on a new battle.
  function handleBrPrepOrientation() {
    const overlay = document.getElementById("br-battle-overlay");
    const target = myBattleNeedingEquip();
    if (brIsLandscape() && target) {
      if (brPrepCid !== target.cid) {
        brPrepCid = target.cid;
        brPrepHand = drawHand((playersCache[myUid()] || {}).cards || {});
        brPrepEquip = {}; brPrepStadium = null; brPrepRedrawn = false;
      }
      renderBattlePrep();
      ensureBattleOverlay().classList.remove("hidden");
    } else if (overlay) {
      overlay.classList.add("hidden");
    }
  }

  let brOrientationBound = false;
  function bindBrOrientation() {
    if (brOrientationBound || !brIsMobile) return;
    brOrientationBound = true;
    if (screen.orientation && screen.orientation.addEventListener) screen.orientation.addEventListener("change", handleBrPrepOrientation);
    else window.addEventListener("orientationchange", handleBrPrepOrientation);
  }

  // ---- entry point (called by core.js when the tab is active) ----
  window.renderBattleRoyale = function renderBattleRoyale() {
    if (!selfRegistered) registerSelf();
    bindListeners();
    render();
    renderShop();
    renderBrDeck();
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
