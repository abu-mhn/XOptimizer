// docs/battleroyale/battleroyale.js — Battle Royale.
//
// Every week the round assigns each player an opponent within reach of
// their tier. Both of them tap Ready, play it, and score it between
// them — there is no Judge, and nothing to accept or arrange.
// Flow: the week draws a pairing → both tap Ready → either opens the
// scoreboard → the wager moves loser → winner. A round nobody plays is
// a draw that costs both of them a point.
//
// Data model (Firebase):
//   battleRoyale/players/{uid}:    { username, points, stake, isJudge, updatedAt }
//   battleRoyale/challenges/{cid}: { challengerUid, challengerName,
//        opponentUid, opponentName, judgeUid, judgeName, wager, status,
//        ready: { uid: bool }, forfeitUid?, winnerUid?, createdAt, resolvedAt? }
//   status: pending → accepted | declined → resolved (+ cancelled)
//   A round record's cid is "r_<weekKey>_<pairId>", which is how the
//   derived pairing and the written one find each other.
//
// Points are a SEPARATE balance (everyone starts at BR_DEFAULT_POINTS) — the
// tournament ranking is untouched.
//
// The judge machinery below (the picker, the queue, isJudge) belongs to
// the hand-made challenge that used to exist. Nothing creates one any
// more: showChallengePopup has no caller. It is still here because the
// DB rules gate a points TRANSFER on the Judge tag, so a round battle
// between two untagged players cannot pay out until those are changed.
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
  // The tier table now lives in core.js, which every page loads before this
  // file, because the Profile tab and the sidebar card show a tier too. One
  // table, one set of thresholds — a second copy here could drift from it, and
  // this one decides who may challenge whom.
  const BR_TIERS = window.BR_TIERS;
  const brTierForRecord = window.brTierForRecord;
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

  // BR_TIERS is ordered best-first, so the INDEX is the rank: 0 = S, 3 = C.
  // A bigger index means a lower tier.
  function tierRank(t) {
    const i = BR_TIERS.findIndex(x => x.key === (t && t.key));
    return i === -1 ? BR_TIERS.length - 1 : i;
  }
  function rankForPlayer(p) { return tierRank(tierForPlayer(p)); }

  // "A-Tier, B-Tier and C-Tier" — the tiers within reach of this one.
  function tierReachLabel(t) {
    const i = tierRank(t);
    const names = BR_TIERS
      .filter((_, j) => Math.abs(j - i) <= 1)
      .map(x => x.short);
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }

  // You may challenge your own tier and the one either side of it — S plays A,
  // A plays S and B, and so on. Two steps apart (S vs B) is out of range.
  const BR_TIER_REACH = 1;
  function tiersCanMeet(a, b) {
    return Math.abs(rankForPlayer(a) - rankForPlayer(b)) <= BR_TIER_REACH;
  }

  // What the winner is paid, as a multiple of the wager. Beating someone from a
  // HIGHER tier doubles it; every other result pays the wager straight.
  const BR_UPSET_MULTIPLIER = 2;
  function payoutMultiplier(winner, loser) {
    return rankForPlayer(winner) > rankForPlayer(loser) ? BR_UPSET_MULTIPLIER : 1;
  }

  // The most that can be staked between two players.
  //
  // Both must be able to pay what losing would cost them, and those costs are
  // no longer equal: the higher-tier player pays DOUBLE if they lose, because
  // that loss is the upset. Capping on the plain balance would let a battle be
  // agreed that the favourite cannot actually settle — the transfer would then
  // clamp at their balance and the underdog would quietly be short-changed.
  function maxWagerBetween(a, b) {
    const aPts = num(a && a.points), bPts = num(b && b.points);
    if (rankForPlayer(a) === rankForPlayer(b)) return Math.min(aPts, bPts);
    const hiIsA = rankForPlayer(a) < rankForPlayer(b);   // smaller rank = higher tier
    const hiPts = hiIsA ? aPts : bPts;
    const loPts = hiIsA ? bPts : aPts;
    return Math.min(loPts, Math.floor(hiPts / BR_UPSET_MULTIPLIER));
  }
  // ===== Weekly rounds =====
  //
  // A round runs Monday 00:00 to Sunday 24:00, Malaysian time — the same
  // clock the tournament lobby closes on, so "midnight Sunday" means one
  // moment for everybody rather than whatever each phone thinks.
  const BR_MYT_OFFSET_MS = 8 * 60 * 60 * 1000;
  const BR_DAY_MS = 24 * 60 * 60 * 1000;
  const BR_WEEK_MS = 7 * BR_DAY_MS;

  // Milliseconds since the Monday that starts the round containing `nowMs`.
  function brRoundStart(nowMs) {
    const shifted = (typeof nowMs === "number" ? nowMs : Date.now()) + BR_MYT_OFFSET_MS;
    const dayIndex = Math.floor(shifted / BR_DAY_MS);
    // 1970-01-01 was a Thursday, so +3 lands Monday on 0.
    const sinceMonday = ((dayIndex + 3) % 7 + 7) % 7;
    return (dayIndex - sinceMonday) * BR_DAY_MS - BR_MYT_OFFSET_MS;
  }
  function brRoundEnd(nowMs) { return brRoundStart(nowMs) + BR_WEEK_MS; }

  // The round's name, and the seed every device shuffles with. Derived from
  // the start instant, so it cannot drift between devices in different
  // timezones the way a formatted local date would.
  function brRoundKey(nowMs) {
    return "w" + Math.floor(brRoundStart(nowMs) / BR_DAY_MS);
  }

  // FNV-1a over the key, the same shape the dashboard's daily pick uses.
  function brHash(str) {
    let h = 0x811c9dc5 >>> 0;
    const t = String(str);
    for (let i = 0; i < t.length; i++) {
      h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    }
    h ^= h >>> 13;
    h = Math.imul(h, 16777619) >>> 0;
    h ^= h >>> 17;
    return h >>> 0;
  }

  // Deterministic shuffle. Fisher-Yates driven by a counter off the seed,
  // so the same list and key always come out in the same order.
  function brShuffle(list, key) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = brHash(key + ":" + i) % (i + 1);
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  // This round's pairings.
  //
  // Sorted by uid BEFORE the shuffle: the cache arrives in whatever order
  // Firebase hands it over, and an unsorted input would shuffle differently
  // on two devices holding the same players.
  //
  // Greedy, because the tiers restrict who can meet: walk the shuffled list
  // and give each unpaired player the first later one within reach. Anyone
  // left over sits the round out — an odd pool, or a tier with nobody
  // adjacent, is not their doing and must not cost them a point.
  // `canMeet` is the policy, handed in rather than reached for: who may
  // face whom is a tier rule, and pairing is the arithmetic around it.
  // Defaults to the tier rule, which is what the app always wants.
  function brPairingsFor(key, players, canMeet) {
    const reach = typeof canMeet === "function" ? canMeet : tiersCanMeet;
    const ids = Object.keys(players || {}).filter(uid => players[uid]).sort();
    const order = brShuffle(ids, key);
    const taken = Object.create(null);
    const pairs = [];
    const byes = [];
    for (let i = 0; i < order.length; i++) {
      const a = order[i];
      if (taken[a]) continue;
      let partner = "";
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (taken[b]) continue;
        if (!reach(players[a], players[b])) continue;
        partner = b;
        break;
      }
      taken[a] = true;
      if (!partner) { byes.push(a); continue; }
      taken[partner] = true;
      // Ordered by uid so the pair's id is the same whichever side builds it.
      const lo = a < partner ? a : partner;
      const hi = a < partner ? partner : a;
      pairs.push({ id: lo + "_" + hi, a: lo, b: hi });
    }
    return { pairs, byes };
  }

  function brPairingFor(key, players, uid, canMeet) {
    if (!uid) return null;
    const round = brPairingsFor(key, players, canMeet);
    return round.pairs.find(x => x.a === uid || x.b === uid) || null;
  }

  // What this week's match is worth.
  //
  // Each player sets a standing stake — the most they are willing to play
  // for — and the pairing uses the SMALLER of the two, so being assigned
  // an opponent can never drag someone into a bigger bet than they chose.
  // Still capped by what both can actually settle, since an upset pays
  // double and the favourite has to be able to cover it.
  const BR_DEFAULT_STAKE = 5;
  function brStakeOf(p) {
    const v = num(p && p.stake);
    return v > 0 ? Math.floor(v) : BR_DEFAULT_STAKE;
  }
  function brWagerBetween(a, b) {
    return Math.max(0, Math.min(brStakeOf(a), brStakeOf(b), maxWagerBetween(a, b)));
  }

  // A round nobody played. Both lose a point and it counts as a draw — the
  // penalty is for not turning up, so it falls on both sides equally and
  // does not depend on who was at fault.
  const BR_NO_SHOW_PENALTY = 1;

  // "2 days 4 hours left" — coarse on purpose. A ticking clock invites
  // people to cut it fine; what matters is roughly how much weekend is
  // left to arrange a battle.
  // "3d 08h 14m 52s". Fixed-width fields so the line does not jiggle as
  // the numbers tick, and the day dropped once there is none left rather
  // than showing a permanent "0d".
  function brTimeLeftLabel(ms) {
    if (!(ms > 0)) return "Round over";
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const sec = total % 60;
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return (d > 0 ? d + "d " : "") + pad(h) + "h " + pad(m) + "m " + pad(sec) + "s left";
  }

  // One interval for the page, not one per render: render() runs on every
  // players/challenges/winRates change, and a fresh timer each time would
  // stack up and tick the same element several times a second.
  let brClockTimer = null;
  function startRoundClock() {
    if (brClockTimer) return;
    brClockTimer = setInterval(() => {
      const el = document.getElementById("br-round-clock");
      if (!el) return;                      // not on screen; nothing to do
      const left = brRoundEnd() - Date.now();
      el.textContent = brTimeLeftLabel(left);
      // The round just rolled over: redraw for the new pairing rather
      // than leave yesterday's opponent on screen counting down from zero.
      if (left <= 0 && el.dataset.key !== brRoundKey()) render();
    }, 1000);
  }

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
  // Pure round logic, exported so it can be tested without a DOM or a
  // database. Nothing in the app reads these off the window.
  window.__brRoundInternals = {
    brRoundStart, brRoundEnd, brRoundKey, brHash, brShuffle,
    brPairingsFor, brPairingFor, brStakeOf, brWagerBetween, tiersCanMeet,
    BR_DEFAULT_STAKE, BR_NO_SHOW_PENALTY, BR_WEEK_MS,
  };

  // The pairing is derived, but the Judge's verdict has to live
  // somewhere, so each pairing gets a challenge record — the same shape
  // the rest of this module already resolves, scores and pays out.
  //
  // The id is the round plus the pair, so whichever of the two opens the
  // app first writes it and the second writes the identical thing over
  // the top. No race, no duplicates, and nothing to clean up.
  function brRoundCid(key, pair) { return "r_" + key + "_" + pair.id; }

  // A name for a uid, for a record written before that player had one.
  function playerName(uid) {
    const p = uid && playersCache[uid];
    return (p && p.username) || "";
  }

  // Who has said they are at the table. A map under the record rather
  // than two fields, so the rules can tie each key to the uid writing it.
  function brIsReady(c, uid) { return !!(c && c.ready && uid && c.ready[uid]); }
  function brBothReady(c) {
    return !!c && brIsReady(c, c.challengerUid) && brIsReady(c, c.opponentUid);
  }

  // The two names on the board. They were falling back to "Challenger"
  // and "Opponent" — the A and B that showed up — because nothing
  // armed a round battle at all.
  function brSideName(c, side) {
    const uid = side === "a" ? c.challengerUid : c.opponentUid;
    const named = side === "a" ? c.challengerName : c.opponentName;
    return named || playerName(uid) || (side === "a" ? "Player 1" : "Player 2");
  }

  // What happens when a score is saved. Shared by the rotation and the
  // button, so the pot cannot be paid out two different ways.
  function brVerdict(target) {
    return ({ scoreA, scoreB }) => {
      brArmedCid = null;
      if (scoreA === scoreB) {
        alert("It's a tie — the wager needs a winner. Score it again.");
        armJudgeScoreboard();   // put the same battle back up
        return;
      }
      resolveChallenge(target.cid, scoreA > scoreB ? target.challengerUid : target.opponentUid);
    };
  }

  // Open the board now, rather than waiting to be turned sideways. A
  // rotation-locked phone never fires that event and a desktop has no
  // rotation at all, so without this those players had no way in.
  function openBrScoreboard(cid) {
    const c = cid && challengesCache[cid];
    if (!c || c.status === "resolved") return;
    // Checked here as well as on the button: the button is drawn from a
    // snapshot, and the opponent can un-ready nothing but the record can
    // arrive stale after a reconnect.
    if (isRoundCid(cid) && !brBothReady(c)) return;
    if (typeof window.openScoreboard !== "function") return;
    const target = Object.assign({ cid }, c);
    brArmedCid = cid;
    window.openScoreboard(
      brSideName(target, "a"), brSideName(target, "b"),
      brVerdict(target),
      0, 0, null, () => { brArmedCid = null; }
    );
  }

  // The record for a pairing, if one has been written yet.
  function roundChallengeFor(key, pair) {
    return pair ? (challengesCache[brRoundCid(key, pair)] || null) : null;
  }

  function isRoundCid(cid) { return String(cid || "").indexOf("r_") === 0; }
  function roundKeyOfCid(cid) { return String(cid || "").slice(2).split("_")[0]; }

  // Every round record for this player this round, oldest first.
  //
  // There should be one. There can be more, because the draw is computed
  // from a pool that moves during the week — someone registers, or a
  // tournament result shifts a tier — and a later recomputation pairs
  // them differently while the earlier record is still sitting there.
  function roundRecordsFor(key, uid) {
    return Object.keys(challengesCache)
      .filter(cid => isRoundCid(cid) && roundKeyOfCid(cid) === key)
      .map(cid => Object.assign({ cid }, challengesCache[cid]))
      .filter(c => c.challengerUid === uid || c.opponentUid === uid)
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
        || a.cid.localeCompare(b.cid));
  }

  // Which pairings count, resolved once for the whole round.
  //
  // Records are taken in the order they were written and kept only if
  // neither player is already spoken for. Every device walks the same
  // list in the same order, so they all reach the same set — which is
  // what makes the pairing MUTUAL: if my phone says I face you, yours
  // says you face me, because both phones accepted the same record.
  //
  // Asking "the earliest record naming me" per player is not enough.
  // Two devices can write at nearly the same moment, and then A's
  // earliest could be A-B while B's earliest is an older B-C — each
  // correct on its own and disagreeing with the other.
  function resolvedRound(key) {
    const taken = Object.create(null);
    const out = [];
    Object.keys(challengesCache)
      .filter(cid => isRoundCid(cid) && roundKeyOfCid(cid) === key)
      .map(cid => Object.assign({ cid }, challengesCache[cid]))
      .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
        || a.cid.localeCompare(b.cid))
      .forEach(c => {
        if (taken[c.challengerUid] || taken[c.opponentUid]) return;
        taken[c.challengerUid] = true;
        taken[c.opponentUid] = true;
        out.push(c);
      });
    return out;
  }

  // The pairing that counts for this player.
  function authoritativeRound(key, uid) {
    return resolvedRound(key).find(c => c.challengerUid === uid || c.opponentUid === uid) || null;
  }

  // A leftover: a second pairing naming someone already spoken for.
  function isLiveRoundRecord(c) {
    if (!c || !isRoundCid(c.cid)) return true;      // not a round record
    return resolvedRound(roundKeyOfCid(c.cid)).some(x => x.cid === c.cid);
  }

  // Clear the leftovers this bug already created.
  //
  // Only ever my own, only ever unresolved, and never the one that
  // counts — a scored battle has moved points and must not be touched.
  function pruneDuplicateRounds(key) {
    const d = db(), uid = myUid();
    if (!d || !uid) return;
    const mine = roundRecordsFor(key, uid);
    if (mine.length < 2) return;
    mine.slice(1).forEach(c => {
      if (c.status === "resolved") return;
      d.ref(CHALLENGES_REF + "/" + c.cid).set(null)
        .catch(e => console.warn("Couldn't clear duplicate pairing " + c.cid + ":", e));
    });
  }

  // Your standing stake. Yours alone to set — the rules allow a player to
  // write their own, and nothing else reads it but the pairing maths.
  function saveStandingStake(value) {
    const d = db(), uid = myUid();
    if (!d || !uid) return;
    const v = Math.max(0, Math.floor(Number(value) || 0));
    d.ref(PLAYERS_REF + "/" + uid + "/stake").set(v)
      .then(() => { if (playersCache[uid]) playersCache[uid].stake = v; render(); })
      .catch(e => {
        // Until the database rules are deployed, `stake` is an unknown
        // field on the player record and is refused. That is a deploy,
        // not something the player can fix, so say so.
        const msg = String((e && e.message) || e);
        alert(/permission|denied/i.test(msg)
          ? "Couldn't save your stake — the database rules for it haven't been deployed yet. Ask the organiser to deploy, then try again."
          : "Couldn't save your stake: " + msg);
      });
  }

  // "I can't play this week."
  //
  // Written onto the pairing, not applied to anyone's balance: moving
  // points is a Judge's job, and the end-of-round settlement already
  // runs. Recording it early is what lets the opponent stop chasing a
  // battle that is not going to happen.
  function forfeitRound(cid) {
    const d = db(), uid = myUid();
    if (!d || !uid || !cid) return;
    const c = challengesCache[cid];
    if (!c || c.status === "resolved" || c.forfeitUid) return;
    if (c.challengerUid !== uid && c.opponentUid !== uid) return;
    d.ref(CHALLENGES_REF + "/" + cid + "/forfeitUid").set(uid)
      .then(() => { if (challengesCache[cid]) challengesCache[cid].forfeitUid = uid; render(); })
      .catch(e => {
        const msg = String((e && e.message) || e);
        alert(/permission|denied/i.test(msg)
          ? "Couldn't record that — the database rules for it haven't been deployed yet."
          : "Couldn't record that: " + msg);
      });
  }

  // "I'm at the table" — and, tapped again, "actually I'm not".
  //
  // Under my own uid, which is the whole point: the rules reject a write
  // to the other player's key, so one person cannot mark both ready and
  // then score the battle alone.
  //
  // Set to false rather than removed. A delete skips .validate, so the
  // rule tying a key to its own uid would not run on the way back out.
  function toggleRoundReady(cid) {
    const d = db(), uid = myUid();
    if (!d || !uid || !cid) return;
    const c = challengesCache[cid];
    if (!c || c.status === "resolved" || c.forfeitUid) return;
    if (c.challengerUid !== uid && c.opponentUid !== uid) return;
    const want = !brIsReady(c, uid);
    d.ref(CHALLENGES_REF + "/" + cid + "/ready/" + uid).set(want)
      .then(() => {
        const cur = challengesCache[cid];
        if (cur) cur.ready = Object.assign({}, cur.ready, { [uid]: want });
        render();
      })
      .catch(e => {
        const msg = String((e && e.message) || e);
        alert(/permission|denied/i.test(msg)
          ? "Couldn't change that — the database rules for it haven't been deployed yet."
          : "Couldn't change that: " + msg);
      });
  }

  // Rounds that ended with nobody playing.
  //
  // Both sides lose a point and it goes down as a draw: the penalty is
  // for not turning up, which is a thing both of them did, and deciding
  // whose fault it was is not something an app can do.
  //
  // Applied by either player's device, over their own rounds only. It
  // used to be a Judge's job, which with no Judge meant nobody's.
  //
  // Both of them running it is the point: a player who never opens the
  // app cannot dodge the penalty, because the other one applies it.
  // Idempotent, and safe to race — the charge is an absolute value
  // computed from the same record, not a decrement, so two devices
  // landing it together write the same number rather than charging
  // twice, and the record is marked resolved in the same update.
  function settleFinishedRounds() {
    const d = db();
    const meUid = myUid();
    if (!d || !meUid) return;
    const nowKey = brRoundKey();
    Object.keys(challengesCache).forEach(cid => {
      if (cid.indexOf("r_") !== 0) return;              // not a round record
      const c = challengesCache[cid];
      if (!c || c.status === "resolved") return;
      if (c.challengerUid !== meUid && c.opponentUid !== meUid) return;
      // "r_<key>_<a>_<b>" — anything from an earlier round is over.
      const key = cid.slice(2).split("_")[0];
      if (key === nowKey) return;                        // still running
      const a = playersCache[c.challengerUid], b = playersCache[c.opponentUid];
      const updates = {};
      updates[CHALLENGES_REF + "/" + cid + "/status"] = "resolved";
      updates[CHALLENGES_REF + "/" + cid + "/winnerUid"] = "";
      updates[CHALLENGES_REF + "/" + cid + "/resolvedAt"] = new Date().toISOString();
      // Somebody said up front they could not make it. The point is
      // theirs alone — the other player did nothing wrong, and with an
      // assigned opponent they had no say in who they were waiting on.
      const gaveUp = c.forfeitUid || "";
      const charge = (uid, p) => (p && (!gaveUp || gaveUp === uid))
        // Never below zero: a point you do not have cannot be taken.
        ? Math.max(0, num(p.points) - BR_NO_SHOW_PENALTY)
        : null;
      const aPts = charge(c.challengerUid, a);
      const bPts = charge(c.opponentUid, b);
      if (aPts !== null) updates[PLAYERS_REF + "/" + c.challengerUid + "/points"] = aPts;
      if (bPts !== null) updates[PLAYERS_REF + "/" + c.opponentUid + "/points"] = bPts;
      d.ref().update(updates)
        .catch(e => console.warn("No-show settlement failed for " + cid + ":", e));
    });
  }

  function ensureRoundChallenge(key, pair) {
    const d = db();
    if (!d || !pair) return;
    const cid = brRoundCid(key, pair);
    if (challengesCache[cid]) return;          // already there
    // Already paired this round — by an earlier draw, before the pool
    // moved. That record stands; writing another is what produced two.
    const uidNow = myUid();
    if (authoritativeRound(key, uidNow)) return;
    const a = playersCache[pair.a], b = playersCache[pair.b];
    if (!a || !b) return;
    const uid = myUid();
    if (uid !== pair.a && uid !== pair.b) return;   // only the two of them
    d.ref(CHALLENGES_REF + "/" + cid).set({
      challengerUid: pair.a, challengerName: a.username || "",
      opponentUid: pair.b, opponentName: b.username || "",
      judgeUid: "", judgeName: "",
      wager: brWagerBetween(a, b),
      status: "accepted",          // assigned, so there is nothing to accept
      createdAt: new Date().toISOString(),
    }).catch(e => console.warn("Round pairing not recorded:", e));
  }

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
  // Shared ProfileCache first — it serves the small `thumb` / `smallBanner`
  // from localStorage instead of pulling each player's full-size photo and
  // banner out of the database on every visit. See js/profile-cache.js.
  function fetchBrProfile(key) {
    if (!key) return Promise.resolve(null);
    if (window.ProfileCache) return window.ProfileCache.row(key);
    if (key in brProfileCache) return Promise.resolve(brProfileCache[key]);
    const database = db();
    if (!database) return Promise.resolve(null);
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

  // ===== Cards, Deck and Shop: OFF =====
  //
  // Battle Royale is running as a plain challenge ladder for now: challenge a
  // player, both stake points, the Judge declares the winner. The ability-card
  // layer (draw a hand, equip one card per combo, buy more in the Shop) is
  // switched off rather than deleted — every bit of it below still works, and
  // the whole feature comes back by flipping this to true.
  //
  // What the flag gates, all in one place so nothing is left half-on:
  //   - the Deck and Shop sub-tabs (and the sub-tab row itself, since only
  //     Battle would be left)
  //   - the "Draw cards" buttons and the rotate-to-draw hints on challenges
  //   - the battle-prep overlay, including its tilt-to-open on mobile
  //   - the "cards in play" line on a battle card
  //
  // Not gated, on purpose: cards already OWNED stay in the database untouched,
  // and a battle that already has cards attached keeps them. Turning this back
  // on should restore what players had, not hand them a fresh start.
  const BR_CARDS_ENABLED = false;

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
    if (!BR_CARDS_ENABLED) return "";
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
  // ===== Who actually holds the Judge tag =====
  //
  // There were two answers to this and they disagreed. The challenge list drew
  // its JUDGE badge from `isJudge` on battleRoyale/players/{uid} — a MIRROR of
  // the tag, written only when that person opens Battle Royale (registerSelf)
  // or by syncJudgeFlag, which heals the signed-in user's own flag and nobody
  // else's. So a judge tagged after their last visit had no badge, and no one
  // could fix it for them. Meanwhile the judge PICKER read the public `judges`
  // index and verified the tag itself, so the same person was pickable as a
  // judge while showing no badge in the list above.
  //
  // Both now read this. The index is the authoritative source; the mirror is
  // kept only as an instant answer before the read lands.
  //
  // Cached for the life of the page: resolving it costs two reads per judge
  // (uid + tag), and render() runs on every players/challenges/winRates
  // update, so re-reading per render would be a lot of traffic for a list
  // that changes when a Developer edits a tag.
  let judgeUidCache = null;        // uid -> username, once resolved
  let judgeIndexPromise = null;    // in flight, so concurrent callers share one

  function loadJudgeIndex() {
    if (judgeIndexPromise) return judgeIndexPromise;
    const database = db();
    if (!database) return Promise.resolve({});
    judgeIndexPromise = database.ref("judges").once("value").then(snap => {
      const idx = snap.val() || {};
      const out = {};
      return Promise.all(Object.keys(idx).map(key => Promise.all([
        database.ref("usernames/" + key + "/uid").once("value").then(s => s.val()).catch(() => null),
        // The whole tags map rather than the single Judge leaf — same one read,
        // and two rungs of the ladder now qualify.
        database.ref("profiles/" + key + "/tags").once("value").then(s => s.val() || {}).catch(() => ({}))
      ]).then(([juid, tags]) => {
        // The tag is re-checked rather than trusted from the index, so an
        // entry left behind by a removed tag doesn't make someone a judge.
        //
        // A Head Judge counts. The roles are a ladder — Guest Judge < Judge <
        // Head Judge — and the rung above carries the one below, so a Head
        // Judge is pickable to oversee a battle exactly like a Judge. They are
        // also the one role granted by hand rather than by exam, so they carry
        // tags/Head Judge and no tags/Judge at all; checking only the latter
        // listed them in the index and then threw them out again here.
        const judges = tags.Judge === true || tags["Head Judge"] === true;
        if (juid && judges) out[juid] = idx[key] || "";
      }))).then(() => {
        judgeUidCache = out;
        return out;
      });
    }).catch(() => {
      // A failed read must not cache an empty answer as though it were true —
      // that would strip every badge until the page reloads.
      judgeIndexPromise = null;
      return {};
    });
    return judgeIndexPromise;
  }

  // True when this uid holds the Judge tag. Falls back to the mirrored flag
  // while the index is still loading, so a badge that IS correct shows at once
  // rather than flickering in a moment later.
  function uidIsJudge(pid) {
    if (judgeUidCache) return !!judgeUidCache[pid] || !!(playersCache[pid] || {}).isJudge;
    return !!(playersCache[pid] || {}).isJudge;
  }

  // Once per page. This runs from render(), and a write here fires the
  // players listener, which renders again — so a write that does not
  // stick (a tag the rules spell differently, say) span the panel
  // forever and no field in it could be typed into.
  let judgeFlagSynced = false;
  function syncJudgeFlag() {
    if (judgeFlagSynced) return;
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const rec = playersCache[uid];
    if (!rec) return;                       // roster not in yet; try next render
    judgeFlagSynced = true;                 // set before the write, not after
    if (!!rec.isJudge === amJudge()) return;
    database.ref(PLAYERS_REF + "/" + uid + "/isJudge").set(amJudge())
      .catch(e => console.warn("BR judge flag not synced:", e));
  }

  // ---- live data ----
  function bindListeners() {
    const database = db();
    if (!database || listenersBound) return;
    listenersBound = true;
    bindBrOrientation();
    database.ref(PLAYERS_REF).on("value", snap => {
      playersCache = snap.val() || {};
      if (brTabVisible()) { render(); renderShop(); renderBrDeck(); renderBrRanking(); }
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
      if (brTabVisible()) { render(); renderShop(); renderBrDeck(); renderBrRanking(); }
    });
    // Win rates (tournament W/L/T) drive each player's tier.
    database.ref(WINRATES_REF).on("value", snap => {
      winRatesCache = snap.val() || {};
      if (brTabVisible()) { render(); renderShop(); renderBrDeck(); renderBrRanking(); }
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
    // A round battle has no judge and never had one: the record is
    // written with judgeUid "", so this test refused both players and
    // the scoreboard quietly did nothing. The two of them settle it.
    const meUid = myUid();
    const mayDeclare = isRoundCid(cid)
      ? (meUid === c.challengerUid || meUid === c.opponentUid)
      : (meUid === c.judgeUid);
    if (!mayDeclare) {
      alert(isRoundCid(cid)
        ? "Only the two players in this battle can score it."
        : "Only the assigned Judge can declare the winner.");
      return;
    }
    if (winnerUid !== c.challengerUid && winnerUid !== c.opponentUid) return;
    const loserUid = winnerUid === c.challengerUid ? c.opponentUid : c.challengerUid;
    const wager = num(c.wager);
    // An upset — a lower tier beating a higher one — pays double.
    //
    // Tiers are read now rather than snapshotted on the challenge, because the
    // rules reject unknown children on a challenge node, so storing them would
    // need a rules deploy to go with this. Tiers move only when a tournament is
    // scored, so the two differ only if that happens mid-battle.
    const want = wager * payoutMultiplier(playersCache[winnerUid], playersCache[loserUid]);

    // Debit FIRST and credit exactly what came out. Running both sides
    // independently let the loser's side clamp at zero while the winner was
    // credited in full, minting points out of nothing — and doubling the
    // payout would have doubled that leak too. Points only ever move here.
    let moved = 0;
    database.ref(PLAYERS_REF + "/" + loserUid + "/points").transaction(pts => {
      const cur = num(pts);
      moved = Math.min(want, cur);
      return cur - moved;
    }).then(() => {
      if (moved <= 0) return null;
      return database.ref(PLAYERS_REF + "/" + winnerUid + "/points").transaction(pts => num(pts) + moved);
    }).catch(() => {});

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
    // A hand-made challenge waits for the judge it named. A round
    // battle has no judge — either player rotates their phone and
    // scores it between them, which is how it works at the table
    // anyway, and waiting on a third person was stopping these being
    // played at all.
    const mine = uid ? authoritativeRound(brRoundKey(), uid) : null;
    const target = uid
      ? (Object.keys(challengesCache)
          .map(cid => Object.assign({ cid }, challengesCache[cid]))
          .find(c => c.status === "accepted" && c.judgeUid === uid)
         || (mine && mine.status === "accepted" && !mine.forfeitUid && brBothReady(mine) ? mine : null))
      : null;
    if (!target) {
      if (brArmedCid) {
        brArmedCid = null;
        if (typeof window.resetScoreboardToDefault === "function") window.resetScoreboardToDefault();
      }
      return;
    }
    if (brArmedCid === target.cid) {
      // Already armed, so don't re-arm — that would wipe a score in progress.
      // But if the Judge has only just arrived on this tab, they have never
      // been told to rotate, and on a rotation-locked iPhone the board will
      // never appear on its own.
      if (brTabVisible() && typeof window.promptScoreboardRotate === "function") {
        window.promptScoreboardRotate();
      }
      return;
    }
    if (typeof window.armScoreboard !== "function") return;
    brArmedCid = target.cid;
    // Both names come off the record. They were falling back to
    // "Challenger" / "Opponent" — the A and B on the board — because
    // nothing armed a round battle at all.
    window.armScoreboard(
      brSideName(target, "a"), brSideName(target, "b"),
      brVerdict(target),
      0, 0,
      null,
      // Prompt to rotate only while the Judge is actually on Battle Royale.
      // This runs off a challenges update on every page, so prompting
      // unconditionally would throw a full-screen overlay over whatever they
      // were doing elsewhere in the app.
      { promptRotate: brTabVisible() }
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
    // A round battle is shown by "This week", which is also the only
    // place it belongs: it was assigned rather than agreed, so there is
    // no Cancel, and listing it twice made one pairing look like two.
    const isRoundRecord = (c) => String(c.cid || "").indexOf("r_") === 0;
    const myActive = all.filter(c => c.status === "accepted" && !isRoundRecord(c) &&
      (c.challengerUid === uid || c.opponentUid === uid));
    // Judge queue (I'm the Judge, accepted and awaiting my verdict).
    // Battles waiting on a verdict. A hand-made challenge names its
    // judge; an assigned round battle has none, so any Judge can pick it
    // up — otherwise it sat in a queue belonging to nobody and could
    // never be scored at all.
    // Only hand-made challenges, which named a judge. A round battle is
    // scored by the two players between them, so putting it in somebody
    // else's queue only made them wait on a third person.
    const judging = all.filter(c => c.status === "accepted" && !isRoundRecord(c) &&
      c.judgeUid === uid);
    // Players I can challenge: SAME tier as me, with at least 1 point to stake,
    // not me, not already in an active challenge.
    const busyUids = new Set();
    all.filter(isActive).forEach(c => { busyUids.add(c.challengerUid); busyUids.add(c.opponentUid); });
    // Developers can challenge across every tier; everyone else sees only theirs.
    const anyTier = amDeveloper();
    const targets = Object.keys(playersCache)
      .filter(pid => pid !== uid && !busyUids.has(pid) &&
        num(playersCache[pid].points) >= 1 &&
        // Adjacent tiers, not just your own. Also drop anyone the wager cap
        // leaves nothing to play for — a cross-tier battle needs the favourite
        // to cover double, so a 1-point favourite has no legal stake.
        maxWagerBetween(me, playersCache[pid]) >= 1 &&
        (anyTier || tiersCanMeet(me, playersCache[pid])))
      .map(pid => Object.assign({ uid: pid }, playersCache[pid]))
      .sort((a, b) => num(b.points) - num(a.points) || (a.username || "").localeCompare(b.username || ""));

    const myGames = gamesForPlayer(me);
    const myWr = winRatePctForPlayer(me);
    let html = `<div class="br-points">Your tier: <strong class="br-tier br-tier-${myTier.key}">${myTier.short}</strong> <span class="br-tier-name">${myTier.name}</span></div>`;
    html += `<div class="br-points br-points-sub">Win rate: <strong>${myWr}%</strong> over ${myGames} battle${myGames === 1 ? "" : "s"} · Points: <strong>${myPoints}</strong></div>`;
    html += `<p class="br-hint">Your tier comes from your tournament win rate <em>and</em> how many battles you've played (a small record can't reach the top). Each week you're matched with someone from your own tier or the one either side of it — ${esc(myTier.short)} can meet ${esc(tierReachLabel(myTier))}. You both stake points and score the battle between you; the winner takes the pot. Beat someone from a higher tier and you take <strong>double</strong>.</p>`;

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
            <div class="br-card-main">vs <strong>${esc(c.opponentName)}</strong> · ${c.wager} pts · ${c.status === "accepted" ? "accepted — awaiting the result" : "waiting for opponent"}</div>
            ${cardsInPlayLine(c)}
            ${unequipped ? `<div class="br-card-hint">📱 Rotate to landscape (or tap Draw cards) to set your loadout.</div>` : ""}
            <div class="br-card-actions">
              ${unequipped ? `<button type="button" class="br-btn br-btn-score" data-prep="${c.cid}">Draw cards</button>` : ""}
              ${c.status === "pending" ? `<button type="button" class="br-btn br-btn-decline" data-cancel="${c.cid}">Cancel</button>` : `<span class="br-card-label">Judge: ${esc(c.judgeName)}</span>`}
            </div>
          </div>`;
        }).join("") + `</div>`;
    }

    // ---- this week ----
    //
    // No picker any more: the round assigns an opponent, so the only
    // thing left to choose is how much you are willing to play for.
    const roundKey = brRoundKey();
    const left = brRoundEnd() - Date.now();
    pruneDuplicateRounds(roundKey);
    // What was WRITTEN beats what the draw now computes: the pool moves
    // during the week, and the opponent you were already shown — and who
    // was shown you — is the one that counts.
    const booked = authoritativeRound(roundKey, uid);
    const pair = booked
      ? { id: booked.cid.slice(("r_" + roundKey + "_").length),
          a: booked.challengerUid, b: booked.opponentUid }
      : brPairingFor(roundKey, playersCache, uid);
    const settled = booked || (pair && roundChallengeFor(roundKey, pair));

    html += `<div class="br-section br-round"><h3 class="br-h">This week <span class="br-sub br-clock" id="br-round-clock" data-key="${esc(roundKey)}">${esc(brTimeLeftLabel(left))}</span></h3>`;
    if (!pair) {
      html += `<p class="br-empty">No opponent this week — there was nobody in ${esc(tierReachLabel(myTier))} left to pair you with. You sit this round out, and sitting out costs you nothing.</p>`;
    } else {
      const oppUid = pair.a === uid ? pair.b : pair.a;
      const opp = playersCache[oppUid] || {};
      const t = tierForPlayer(opp);
      const wager = booked ? num(booked.wager) : brWagerBetween(me, opp);
      const done = settled && settled.status === "resolved";
      const gaveUp = (settled && settled.forfeitUid) || "";
      // The scoreboard stays locked until both of them have said they
      // are there to play it.
      const iAmReady = brIsReady(settled, uid);
      const oppReady = brIsReady(settled, oppUid);
      const bothReady = brBothReady(settled);
      html += `
        <div class="br-round-card" data-pkey="${esc(winKeyFor(opp.username) || "")}">
          ${brAvatarHtml(opp.username)}
          <div class="br-round-main">
            <span class="br-player-name fr-profile-trigger" data-profile-username="${esc(opp.username || "")}" title="View profile"><span class="br-player-nametext">${esc(opp.username || "(unnamed)")}</span><span class="br-tier br-tier-${t.key}">${t.short}</span></span>
            <span class="br-player-points">${winRatePctForPlayer(opp)}% WR · ${num(opp.points)} pts</span>
            <span class="br-round-wager">Playing for <strong>${wager}</strong> pt${wager === 1 ? "" : "s"}${
              payoutMultiplier(me, opp) > 1 ? ` · <strong>double</strong> if you win` : ""}</span>
          </div>
          <span class="br-round-state">${done
            ? (settled.winnerUid === uid ? "You won" : settled.winnerUid ? "You lost" : "Drawn")
            : gaveUp ? (gaveUp === uid ? "You forfeited" : "Opponent forfeited")
            : bothReady ? "Both ready \u2713"
            : iAmReady ? "You're ready \u2713"
            : oppReady ? "They're ready"
            : "Not played yet"}</span>
        </div>`;
      if (!done && gaveUp) {
        html += `<p class="br-hint br-round-hint">${gaveUp === uid
          ? `You've said you can't play this week. It goes down as a draw and costs you ${BR_NO_SHOW_PENALTY} point when the round ends — your opponent keeps theirs.`
          : `${esc(opp.username || "Your opponent")} can't play this week, so there's nothing to arrange. It's a draw and it costs you nothing.`}</p>`;
      } else if (!done) {
        const lock = bothReady ? "" : ` disabled title="You both tap I'm ready first"`;
        html += `<div class="br-round-actions">
          ${settled ? `<button type="button" class="br-btn ${
            iAmReady ? "br-btn-unready" : "br-btn-accept"}" data-ready="${esc(settled.cid)}">${
            iAmReady ? "Cancel ready" : "I'm ready"}</button>` : ""}
          ${settled ? `<button type="button" class="br-btn br-btn-score" data-score="${esc(settled.cid)}"${lock}>Score this battle</button>` : ""}
          <button type="button" class="br-btn br-btn-decline" data-forfeit="${esc(settled ? settled.cid : "")}">Can't play this week</button>
        </div>`;
        // Why it is locked matters more than that it is: a player who
        // cannot see the reason reads it as broken.
        const readyLine = bothReady
          ? `You're both ready. Play it, then either of you taps Score this battle — or just turn your phone sideways. Not playing after all? Either of you can cancel ready.`
          : iAmReady
            ? `You're ready. The scoreboard unlocks once ${esc(opp.username || "your opponent")} taps it too, so a battle can't be scored by one of you alone. Tapped it by mistake? Cancel ready — it costs you nothing.`
            : oppReady
              ? `${esc(opp.username || "Your opponent")} is ready and waiting on you. Tap I'm ready when you're both at the stadium.`
              : `Find each other and play it before the round ends. You both tap I'm ready — that's what unlocks the scoreboard, so nobody can score a battle on their own.`;
        html += `<p class="br-hint br-round-hint">${readyLine} If the round ends unplayed it is a draw and <strong>both</strong> of you lose ${BR_NO_SHOW_PENALTY} point.</p>`;
      }
    }
    // The standing stake. Set once; every round uses the smaller of the
    // two, so being assigned an opponent can never cost more than this.
    html += `
      <div class="br-stake">
        <label class="br-stake-label" for="br-stake-input">Your standing stake</label>
        <div class="br-stake-row">
          <input id="br-stake-input" class="br-stake-input" type="number" min="0" step="1" value="${brStakeOf(me)}">
          <button type="button" class="br-btn br-btn-accept" id="br-stake-save">Save</button>
        </div>
        <span class="br-stake-note">The most you'll play for. Each match uses the smaller of the two stakes.</span>
      </div>`;
    html += `</div>`;

    // Anything on the roster changing re-renders this whole panel, and
    // on a busy ladder that is often. Carry the field you are typing in
    // across the swap — value, focus and caret — or it reverts to the
    // saved stake under your fingers.
    const live = document.activeElement;
    const keep = live && live.id === "br-stake-input" && root.contains(live)
      ? { value: live.value, start: live.selectionStart, end: live.selectionEnd }
      : null;

    root.innerHTML = html;
    hydrateBrAvatars(root);
    if (typeof window.bindTournamentProfileNames === "function") window.bindTournamentProfileNames(root);

    if (keep) {
      const again = root.querySelector("#br-stake-input");
      if (again) {
        again.value = keep.value;
        again.focus();
        // A number input only has a selection while it parses as one;
        // setSelectionRange throws on it otherwise.
        try { again.setSelectionRange(keep.start, keep.end); } catch (e) {}
      }
    }

    // The pairing's record is created on first sight, by whichever of the
    // two players looks first.
    if (pair) ensureRoundChallenge(roundKey, pair);
    settleFinishedRounds();
    startRoundClock();

    root.querySelectorAll("[data-ready]").forEach(b =>
      b.addEventListener("click", () => toggleRoundReady(b.dataset.ready)));

    root.querySelectorAll("[data-score]").forEach(b =>
      b.addEventListener("click", () => openBrScoreboard(b.dataset.score)));

    root.querySelectorAll("[data-forfeit]").forEach(b => b.addEventListener("click", () => {
      if (!b.dataset.forfeit) return;
      if (!confirm("Tell your opponent you can't play this week?\n\nIt goes down as a draw. You lose " +
        BR_NO_SHOW_PENALTY + " point when the round ends; they keep theirs.")) return;
      forfeitRound(b.dataset.forfeit);
    }));

    const stakeSave = root.querySelector("#br-stake-save");
    if (stakeSave) {
      stakeSave.addEventListener("click", () => {
        const input = root.querySelector("#br-stake-input");
        const v = Math.max(0, Math.floor(Number(input && input.value) || 0));
        saveStandingStake(v);
      });
    }
    root.querySelectorAll("[data-accept]").forEach(b => b.addEventListener("click", () => acceptChallenge(b.dataset.accept)));
    root.querySelectorAll("[data-decline]").forEach(b => b.addEventListener("click", () => declineChallenge(b.dataset.decline)));
    root.querySelectorAll("[data-cancel]").forEach(b => b.addEventListener("click", () => { if (confirm("Cancel this challenge?")) cancelChallenge(b.dataset.cancel); }));
    root.querySelectorAll("[data-prep]").forEach(b => b.addEventListener("click", () => openBattlePrep(b.dataset.prep)));
  }

  // ---- Shop tab ----
  function renderShop() {
    if (!BR_CARDS_ENABLED) return;
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
    if (!BR_CARDS_ENABLED) return;
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
    // Same index the badges use, so the picker and the list can never disagree
    // — and opening the dialog re-uses the read instead of repeating it.
    return loadJudgeIndex().then(idx => {
      Object.keys(idx).forEach(juid => {
        if (juid !== opponentUid && !out[juid]) {
          out[juid] = { uid: juid, username: idx[juid] || "" };
        }
      });
      return Object.values(out);
    }).catch(() => Object.values(out));
  }

  // ---- challenge popup (pick wager + judge) ----
  function showChallengePopup(opponentUid) {
    const uid = myUid();
    const me = playersCache[uid], opp = playersCache[opponentUid];
    if (!me || !opp) return;
    document.getElementById("br-challenge-popup")?.remove();
    // Equal wager, but NOT an equal risk once the tiers differ: the favourite
    // owes double if they lose, so the cap has to leave them able to pay it.
    const maxW = maxWagerBetween(me, opp);
    const myRank = rankForPlayer(me), oppRank = rankForPlayer(opp);
    const upsetNote = myRank === oppRank
      ? ""
      : (myRank > oppRank
          ? `<p class="popup-subtitle br-upset-note">${esc(opp.username || "They")} is a tier above you — win and you take <strong>double</strong> your wager.</p>`
          : `<p class="popup-subtitle br-upset-note">${esc(opp.username || "They")} is a tier below you — if they win, they take <strong>double</strong>.</p>`);
    const overlay = document.createElement("div");
    overlay.id = "br-challenge-popup";
    overlay.className = "popup-overlay";
    overlay.innerHTML = `
      <div class="popup-card">
        <h2 class="popup-title">Challenge ${esc(opp.username || "player")}</h2>
        <p class="popup-subtitle">Both stake the same wager. The Judge declares the winner, who takes the pot.</p>
        ${upsetNote}
        <label class="tournament-name-label" for="br-wager">Wager (1–${maxW})</label>
        <input type="number" id="br-wager" class="tournament-name-input" min="1" max="${maxW}" step="1" value="${Math.min(10, maxW)}">
        <label class="tournament-name-label" for="br-judge-search">Judge</label>
        <input type="text" id="br-judge-search" class="tournament-name-input hidden"
               placeholder="Search judges" autocomplete="off" spellcheck="false">
        <div id="br-judge-section"></div>
        <div id="br-challenge-status" class="swiss-join-status"></div>
        <div class="popup-actions">
          <button type="button" id="br-challenge-send" class="btn" disabled>Send challenge</button>
          <button type="button" id="br-challenge-cancel" class="btn popup-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector("#br-challenge-cancel").onclick = close;
    closeOnBackdrop(overlay, close);

    // Nothing is pre-selected. This used to default to `list[0]`, which meant a
    // judge you never chose was already highlighted when the dialog opened —
    // and WHICH one was effectively arbitrary, because the list paints twice
    // (cached judges first, then everyone) and the pick was made from whichever
    // partial list arrived first. On a points wager, sending to the wrong judge
    // because you didn't notice one was chosen for you is a real cost, so the
    // choice is now deliberate and Send stays disabled until it is made.
    let selectedJudge = null; // { uid, username }
    // The full list, kept separately from what the search box is showing: a
    // judge filtered out of view is still a valid selection, and must not be
    // cleared just because you typed something that hides them.
    let allJudges = [];
    let judgeFilter = "";
    const sendBtn = overlay.querySelector("#br-challenge-send");
    const searchInput = overlay.querySelector("#br-judge-search");

    function matchesFilter(j) {
      if (!judgeFilter) return true;
      return (j.username || "").toLowerCase().indexOf(judgeFilter) !== -1;
    }

    function renderJudgeList() {
      const section = overlay.querySelector("#br-judge-section");
      if (!section) return;
      if (!allJudges.length) {
        section.innerHTML = `<p class="br-empty">No Judges are available yet. Ask a user with the "Judge" tag to sign in.</p>`;
        searchInput?.classList.add("hidden");
        if (sendBtn) sendBtn.disabled = true;
        return;
      }
      searchInput?.classList.remove("hidden");
      const shown = allJudges.filter(matchesFilter);
      if (!shown.length) {
        section.innerHTML = `<p class="br-empty">No judge matches “${esc(judgeFilter)}”.</p>`;
      } else {
        section.innerHTML = `<div class="br-judge-picker" role="listbox" aria-label="Judge">${shown.map(j => {
          const on = !!selectedJudge && j.uid === selectedJudge.uid;
          return `<button type="button" class="br-judge-option${on ? " selected" : ""}" data-judge="${esc(j.uid)}" data-name="${esc(j.username || "")}" role="option" aria-selected="${on ? "true" : "false"}">${esc(j.username || "(unnamed)")}${j.uid === uid ? " (you)" : ""}</button>`;
        }).join("")}</div>`;
      }
      // Say who is picked when the search has scrolled them out of sight —
      // otherwise an enabled Send button with nothing highlighted looks broken.
      if (selectedJudge && !shown.some(j => j.uid === selectedJudge.uid)) {
        section.innerHTML += `<p class="br-judge-chosen">Judge: <strong>${esc(selectedJudge.username || "(unnamed)")}</strong></p>`;
      }
      if (sendBtn) sendBtn.disabled = !selectedJudge;
      section.querySelectorAll(".br-judge-option").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedJudge = { uid: btn.dataset.judge, username: btn.dataset.name || "" };
          section.querySelectorAll(".br-judge-option").forEach(b => {
            const sel = b === btn;
            b.classList.toggle("selected", sel);
            b.setAttribute("aria-selected", sel ? "true" : "false");
          });
          if (sendBtn) sendBtn.disabled = false;
        });
      });
    }

    // Called on each data arrival: the cached judges first, then the full set.
    function paintJudges(list) {
      allJudges = list.slice().sort((a, b) => (a.username || "").localeCompare(b.username || ""));
      // Only drop the selection if that judge is genuinely gone from the data,
      // never because the search box is hiding them.
      if (selectedJudge && !allJudges.some(j => j.uid === selectedJudge.uid)) selectedJudge = null;
      renderJudgeList();
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        judgeFilter = searchInput.value.trim().toLowerCase();
        renderJudgeList();
      });
      // Enter would otherwise do nothing visible; treat it as "done typing".
      searchInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") e.preventDefault();
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
    // Must follow the flag as well. armJudgeScoreboard() refuses to arm the
    // board while a loadout is owed, and with cards off every battle looks
    // unequipped forever — so a Judge who is also a player in the battle
    // (self-judge) could never score it at all.
    if (!BR_CARDS_ENABLED) return null;
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
        <div class="brp-card-equip"><span class="brp-equip-label">Equip on combo:</span>${comboBtns ? `<span class="brp-combo-btns">${comboBtns}</span>` : `<span class="brp-note">star a deck</span>`}</div>
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
    if (!BR_CARDS_ENABLED) return;
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
    if (!BR_CARDS_ENABLED) return false;
    const uid = myUid();
    return !!(uid && (c.challengerUid === uid || c.opponentUid === uid)
      && !(c.cards && c.cards[uid] && Object.keys(c.cards[uid]).some(k => c.cards[uid][k])));
  }

  // Show the prep overlay when a battle needs a loadout and the phone is tilted
  // to landscape; hide it otherwise. Draws a fresh hand only on a new battle.
  function handleBrPrepOrientation() {
    const overlay = document.getElementById("br-battle-overlay");
    // With cards off there is no loadout to set, so a tilt must not put an
    // overlay over the board the Judge is about to score on.
    if (!BR_CARDS_ENABLED) { if (overlay) overlay.classList.add("hidden"); return; }
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
    // Arriving on the tab is the moment to surface a battle waiting to be
    // scored — including the rotate prompt, if the phone is still upright.
    armJudgeScoreboard();
    render();
    renderShop();
    renderBrDeck();
  };

  // ---- the standings ----
  //
  // Sorted on points, because points are what the game is played for.
  // Win rate breaks a tie, since two players level on points are not
  // level if one of them got there over twice as many battles.
  function brRankedPlayers() {
    return Object.keys(playersCache)
      .map(pid => Object.assign({ uid: pid }, playersCache[pid]))
      .filter(p => p.username)
      .sort((a, b) => num(b.points) - num(a.points)
        || winRatePctForPlayer(b) - winRatePctForPlayer(a)
        || gamesForPlayer(b) - gamesForPlayer(a)
        || String(a.username).localeCompare(String(b.username)));
  }

  // Level on points is level. Numbering them 6th and 7th would say one
  // is ahead of the other, and nothing in the game says that.
  function brPlaces(rows) {
    let place = 0, prev = null;
    return rows.map((p, i) => {
      const pts = num(p.points);
      if (prev === null || pts !== prev) { place = i + 1; prev = pts; }
      return Object.assign({ place }, p);
    });
  }

  function renderBrRanking() {
    const root = document.getElementById("br-ranking");
    if (!root) return;
    const uid = myUid();
    const rows = brPlaces(brRankedPlayers());
    if (!rows.length) {
      root.innerHTML = `<p class="br-empty">Nobody has joined Battle Royale yet. Open the Battle tab and you're in.</p>`;
      return;
    }
    const mine = rows.find(p => p.uid === uid);
    let html = "";
    if (mine) {
      // Your own line first: on a long list your row can be well off
      // screen, and where you stand is the thing you came to find out.
      html += `<p class="br-rank-you">You're <strong>#${mine.place}</strong> of ${rows.length} on <strong>${num(mine.points)}</strong> pt${
        num(mine.points) === 1 ? "" : "s"}.</p>`;
    }
    html += `<div class="br-rank-list">`;
    rows.forEach(p => {
      const t = tierForPlayer(p);
      const games = gamesForPlayer(p);
      html += `
        <div class="br-rank-row${p.uid === uid ? " br-rank-me" : ""}" data-pkey="${esc(winKeyFor(p.username) || "")}">
          <span class="br-rank-place br-rank-place-${p.place <= 3 ? p.place : "n"}">${p.place}</span>
          ${brAvatarHtml(p.username)}
          <div class="br-rank-main">
            <span class="br-player-name fr-profile-trigger" data-profile-username="${esc(p.username)}" title="View profile"><span class="br-player-nametext">${esc(p.username)}</span><span class="br-tier br-tier-${t.key}">${t.short}</span></span>
            <span class="br-player-points">${winRatePctForPlayer(p)}% WR${
              games ? ` over ${games} battle${games === 1 ? "" : "s"}` : ` \u00b7 no battles yet`}</span>
          </div>
          <span class="br-rank-points"><strong>${num(p.points)}</strong> pts</span>
        </div>`;
    });
    html += `</div>`;
    root.innerHTML = html;
    hydrateBrAvatars(root);
    if (typeof window.bindTournamentProfileNames === "function") window.bindTournamentProfileNames(root);
  }

  // ---- Battle / Shop sub-tabs ----
  // Clicking a sub-tab activates it and shows the matching panel; the other
  // panels get hidden. Mirrors the reel / history sub-tab pattern.
  const BR_CARD_VIEWS = ["deck", "shop"];
  function setupBrSubTabs() {
    const tabs = Array.prototype.slice.call(document.querySelectorAll(".br-sub-tab"));
    if (!tabs.length) return;
    const row = document.getElementById("br-sub-tabs");
    // Deck and Shop belong to the card game, which is off. Ranking does
    // not, so the row itself stays — it used to be hidden wholesale, and
    // the standings went with it.
    const live = tabs.filter(t => BR_CARDS_ENABLED || BR_CARD_VIEWS.indexOf(t.dataset.brView) < 0);
    tabs.forEach(t => t.classList.toggle("hidden", live.indexOf(t) < 0));
    if (row) row.classList.toggle("hidden", live.length < 2);

    const show = (view) => {
      tabs.forEach(t => t.classList.toggle("active", t.dataset.brView === view));
      document.querySelectorAll(".br-panel").forEach(panel => {
        panel.classList.toggle("hidden", panel.id !== "br-panel-" + view);
      });
      if (view === "ranking") renderBrRanking();
    };
    // A card panel left showing by an earlier session would have no tab
    // left to leave it by.
    const active = tabs.find(t => t.classList.contains("active"));
    show(active && live.indexOf(active) >= 0 ? active.dataset.brView : "battle");
    live.forEach(tab => tab.addEventListener("click", () => show(tab.dataset.brView)));
  }

  // Bind notification listeners on every page once signed in (so a Judge /
  // opponent is alerted even while on another tab).
  function boot() { if (myUid()) bindListeners(); }
  window.addEventListener("userprofilechange", () => {
    selfRegistered = false;
    boot();
    if (brTabVisible()) window.renderBattleRoyale();
  });
  // "load" waits for every image and font on the page; the sub-tabs only need
  // the DOM. Running at DOMContentLoaded settles them before first paint has
  // anything to flash, and the "load" call stays as a backstop for a script
  // that somehow arrives after the document is already parsed.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupBrSubTabs);
  } else {
    setupBrSubTabs();
  }
  window.addEventListener("load", () => { boot(); setupBrSubTabs(); });
})();
