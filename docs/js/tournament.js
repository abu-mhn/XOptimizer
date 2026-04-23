// docs/js/tournament.js - Swiss/single-elim tournament logic + live sync (Firebase)
// ================= SWISS LIVE SYNC (Firebase Realtime DB) =================
// When a host generates groups, TWO room codes are created:
//   - co-host code: view + edit (mirrors state at `swissRooms/{coHostCode}`)
//   - participant code: view only (mapped via `swissViewCodes/{viewCode}` -> coHostCode)
// The room state lives at `swissRooms/{coHostCode}` with `viewCode` as metadata.
// Anyone who enters the co-host code can score; anyone who enters the
// participant code can only watch. The host (device that created the room)
// additionally has authority to reset (wipes remote).
const SWISS_ROOM_STORAGE = "beyblade_swiss_room";       // current joined room info (JSON)
const SWISS_HOST_STORAGE = "beyblade_swiss_host_rooms"; // edit codes this device hosts

let swissDb = null;
let swissEditCode = null;    // co-host code (primary room key)
let swissViewCode = null;    // participant code
let swissIsHost = false;     // created this room (has reset authority)
let swissCanEdit = false;    // joined via co-host code (or is host) — can score
let swissRoomRef = null;
let swissApplyingRemote = false;
let swissLiveMatchId = null; // which match (if any) this device is currently live on
let swissScrollPositions = []; // horizontal scrollLeft of each rounds-scroll strip (groups then bracket)

function initFirebase() {
  if (swissDb) return swissDb;
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || !cfg.databaseURL) return null;
  if (typeof firebase === "undefined") return null;
  try {
    if (!firebase.apps.length) firebase.initializeApp(cfg);
    swissDb = firebase.database();
    return swissDb;
  } catch (e) {
    console.warn("Firebase init failed:", e);
    return null;
  }
}

function firebaseReady() {
  return !!initFirebase();
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/1/O/I/L
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function loadHostedRooms() {
  try { return JSON.parse(localStorage.getItem(SWISS_HOST_STORAGE)) || []; } catch (e) { return []; }
}
function markRoomHosted(code) {
  const rooms = loadHostedRooms();
  if (!rooms.includes(code)) {
    rooms.push(code);
    localStorage.setItem(SWISS_HOST_STORAGE, JSON.stringify(rooms));
  }
}
function isRoomHosted(code) {
  return loadHostedRooms().includes(code);
}

function saveJoinedRoom(info) {
  if (info) localStorage.setItem(SWISS_ROOM_STORAGE, JSON.stringify(info));
  else localStorage.removeItem(SWISS_ROOM_STORAGE);
}
function loadJoinedRoom() {
  try {
    const raw = localStorage.getItem(SWISS_ROOM_STORAGE);
    if (!raw) return null;
    // Back-compat: earlier versions stored just the string code.
    if (raw[0] !== "{") return { editCode: raw, viewCode: null, role: "edit" };
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function disconnectSwissRoom() {
  if (swissRoomRef) {
    try { swissRoomRef.off(); } catch (e) {}
  }
  swissRoomRef = null;
  swissEditCode = null;
  swissViewCode = null;
  swissIsHost = false;
  swissCanEdit = false;
  swissLiveMatchId = null;
  saveJoinedRoom(null);
  // Drop any match-linked state on the scoreboard so leaving a room doesn't
  // leave stale match names / score / save callback on the overlay.
  if (typeof window.resetScoreboardToDefault === "function") {
    window.resetScoreboardToDefault();
  }
}

// Strip metadata fields (viewCode) before persisting remote state locally —
// they aren't part of the tournament model and shouldn't land in loadSwiss.
function stripRoomMetadata(remote) {
  if (!remote) return remote;
  const { viewCode, ...state } = remote;
  return state;
}

function resolveRoomCode(code, cb) {
  const db = initFirebase();
  if (!db) { cb({ ok: false, reason: "Live sync isn't configured on this build." }); return; }
  db.ref("swissRooms/" + code).once("value").then(editSnap => {
    const remote = editSnap.val();
    const populated = !!(remote && (remote.groups || (remote.matches && Object.keys(remote.matches).length > 0)));
    if (populated) {
      cb({ ok: true, editCode: code, viewCode: remote.viewCode || null, role: "edit" });
      return null;
    }
    return db.ref("swissViewCodes/" + code).once("value").then(viewSnap => {
      const mappedEdit = viewSnap.val();
      if (typeof mappedEdit === "string" && mappedEdit) {
        cb({ ok: true, editCode: mappedEdit, viewCode: code, role: "view" });
      } else {
        cb({ ok: false, reason: "Room not found. Double-check the code." });
      }
    });
  }).catch(err => {
    console.warn("Room lookup failed:", err);
    cb({ ok: false, reason: "Couldn't look up room. Check your connection." });
  });
}

function connectSwissRoom(editCode, viewCode, asHost, canEdit) {
  const db = initFirebase();
  if (!db) return { ok: false, reason: "Firebase not configured" };
  if (swissRoomRef) {
    try { swissRoomRef.off(); } catch (e) {}
  }
  swissEditCode = editCode;
  swissViewCode = viewCode || null;
  swissIsHost = !!asHost;
  swissCanEdit = !!canEdit;
  swissRoomRef = db.ref("swissRooms/" + editCode);
  const isPopulatedRemote = (r) => !!(r && (r.groups || (r.matches && Object.keys(r.matches).length > 0)));
  const isPopulatedLocal = (s) => !!(s && (s.groups || (s.matches && Object.keys(s.matches).length > 0)));

  const role = asHost ? "host" : (canEdit ? "co-host" : "view");
  const isViewer = role === "view";
  const localNow = loadSwiss();
  saveTournamentHistoryEntry({
    editCode: isViewer ? null : editCode,
    viewCode: swissViewCode || null,
    name: localNow?.tournamentName || "",
    mode: localNow?.mode || null,
    role,
    createdAt: new Date().toISOString()
  });

  swissRoomRef.on("value", snap => {
    const remote = snap.val();
    if (isPopulatedRemote(remote)) {
      if (remote.viewCode && !swissViewCode) swissViewCode = remote.viewCode;
      saveTournamentHistoryEntry({
        editCode: isViewer ? null : editCode,
        viewCode: swissViewCode || null,
        name: remote.tournamentName || "",
        mode: remote.mode || null,
        role
      });
      swissApplyingRemote = true;
      localStorage.setItem(SWISS_KEY, JSON.stringify(stripRoomMetadata(remote)));
      swissApplyingRemote = false;
      renderSwiss();
    } else if (!remote && swissIsHost) {
      // Room was wiped remotely (or first-time creation). Push our local state
      // together with the viewCode metadata and publish the viewer mapping.
      const local = loadSwiss();
      if (isPopulatedLocal(local) && swissViewCode) {
        swissApplyingRemote = true;
        const payload = { ...local, viewCode: swissViewCode };
        swissRoomRef.set(payload)
          .then(() => db.ref("swissViewCodes/" + swissViewCode).set(editCode))
          .catch(e => console.warn("Initial room push failed:", e))
          .finally(() => { swissApplyingRemote = false; });
      }
    } else if (!remote && !swissIsHost) {
      // Non-host: room was wiped (or doesn't exist yet). Clear local view so
      // we don't keep showing stale groups after a host reset.
      swissApplyingRemote = true;
      localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
      swissApplyingRemote = false;
      renderSwiss();
    }
  }, err => {
    console.warn("Swiss room listen error:", err);
  });
  saveJoinedRoom({ editCode, viewCode: swissViewCode, role: canEdit ? "edit" : "view" });
  return { ok: true };
}

// Targeted update for a single score save (optionally with new matches +
// updated round counter if completing the round generated the next one).
// Using .update() with leaf paths lets two refs score different matches
// concurrently without overwriting each other's work.
function pushSwissMatchUpdate(matchId, match, state, newMatchIds, extraUpdates) {
  if (swissApplyingRemote) return;
  if (!swissRoomRef || !swissCanEdit) return;
  const updates = {
    [`matches/${matchId}/scoreA`]: match.scoreA,
    [`matches/${matchId}/scoreB`]: match.scoreB,
    [`matches/${matchId}/startedAt`]: null
  };
  if (newMatchIds && newMatchIds.length) {
    newMatchIds.forEach(id => {
      updates[`matches/${id}`] = state.matches[id];
    });
    // Only group matches track round progression via groupRounds.
    if (typeof match.groupIndex === "number") {
      updates[`groupRounds/${match.groupIndex}`] = state.groupRounds[match.groupIndex];
    }
  }
  if (extraUpdates) Object.assign(updates, extraUpdates);
  swissRoomRef.update(updates).catch(e => console.warn("Swiss match push failed:", e));
}

// Small push for just the "match is being scored" flag so other refs see
// the in-progress state the moment someone opens the scoreboard.
function pushSwissMatchStart(matchId, startedAt) {
  if (swissApplyingRemote) return;
  if (!swissRoomRef || !swissCanEdit) return;
  swissRoomRef.child(`matches/${matchId}/startedAt`).set(startedAt)
    .catch(e => console.warn("Swiss start push failed:", e));
}

function initSwissRoomOnLoad() {
  const info = loadJoinedRoom();
  if (!info || !info.editCode) return;
  if (!firebaseReady()) return;
  const asHost = isRoomHosted(info.editCode);
  const canEdit = asHost || info.role === "edit";
  connectSwissRoom(info.editCode, info.viewCode || null, asHost, canEdit);
}

// ================= SWISS TOURNAMENT =================
// 4 groups, 4 rounds per group. Each round pairs group members using Swiss rules
// (by current wins, avoiding rematches). Odd-count groups push one BYE per round
// (counts as a win) and rotate which member receives it.
const SWISS_KEY = "beyblade_swiss";
const SWISS_GROUP_COUNT = 4;
const SWISS_ROUND_COUNT = 4;
const SWISS_MIN_PER_GROUP = 2; // minimum so every group can run at least one match per round
const SWISS_BRACKET_TOP_N = 2; // top N per group advance to the knockout bracket

function loadSwiss() {
  try {
    const raw = JSON.parse(localStorage.getItem(SWISS_KEY) || "null");
    const hasGroups = raw && Array.isArray(raw.groups);
    const hasMatches = raw && raw.matches && Object.keys(raw.matches).length > 0;
    if (raw && (hasGroups || hasMatches || raw.mode === "single-elim")) {
      if (!raw.matches) raw.matches = {};
      // Migrate legacy global `roundsGenerated` into the per-group array.
      if (!Array.isArray(raw.groupRounds)) {
        const fill = typeof raw.roundsGenerated === "number" ? raw.roundsGenerated : 0;
        raw.groupRounds = hasGroups ? raw.groups.map(() => fill) : [];
      }
      return raw;
    }
  } catch (e) {}
  return { groups: null, matches: {}, groupRounds: [] };
}

function persistSwiss(state) {
  localStorage.setItem(SWISS_KEY, JSON.stringify(state));
  // Remote sync is handled by explicit callers (pushSwissMatchUpdate /
  // full-state .set for initial room creation and reset) so concurrent
  // writes from multiple refs don't clobber each other.
}

function shuffleArray(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function pairKey(a, b) {
  return [a, b].sort().join("|");
}

function playedPairs(matches, groupIndex) {
  const set = new Set();
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (!m.b) return;
    set.add(pairKey(m.a, m.b));
  });
  return set;
}

function previousByeReceivers(matches, groupIndex) {
  const set = new Set();
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (m.bye && m.a) set.add(m.a);
  });
  return set;
}

function pairSwissRound(members, matches, groupIndex, round) {
  // members: ordered (round 1 = shuffled; round 2+ = standings-sorted)
  const played = playedPairs(matches, groupIndex);
  const queue = members.slice();
  const pairs = [];

  if (queue.length % 2 === 1) {
    // Give the BYE to the lowest-ranked member who hasn't had one yet.
    const prevByes = previousByeReceivers(matches, groupIndex);
    let byeIdx = -1;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (!prevByes.has(queue[i])) { byeIdx = i; break; }
    }
    if (byeIdx === -1) byeIdx = queue.length - 1;
    const byeMember = queue.splice(byeIdx, 1)[0];
    pairs.push({ a: byeMember, b: null, bye: true });
  }

  while (queue.length >= 2) {
    const a = queue.shift();
    let partnerIdx = -1;
    for (let i = 0; i < queue.length; i++) {
      if (!played.has(pairKey(a, queue[i]))) { partnerIdx = i; break; }
    }
    if (partnerIdx === -1) partnerIdx = 0; // fallback: rematch rather than strand
    const b = queue.splice(partnerIdx, 1)[0];
    pairs.push({ a, b, bye: false });
  }

  return pairs.map((p, i) => ({
    id: `g${groupIndex}-r${round}-m${i}`,
    groupIndex,
    round,
    a: p.a,
    b: p.b,
    scoreA: null,
    scoreB: null,
    bye: p.bye
  }));
}

function appendGroupRound(state, groupIndex) {
  const members = state.groups[groupIndex];
  const roundIndex = state.groupRounds[groupIndex] || 0;
  if (roundIndex >= SWISS_ROUND_COUNT) return false;
  const ordered = roundIndex === 0
    ? shuffleArray(members)
    : computeStandings(members, state.matches, groupIndex).map(r => r.name);
  const matchObjs = pairSwissRound(ordered, state.matches, groupIndex, roundIndex);
  matchObjs.forEach(m => { state.matches[m.id] = m; });
  state.groupRounds[groupIndex] = roundIndex + 1;
  return true;
}

function generateSwissFromText(text, tournamentName) {
  const names = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  names.forEach(n => { if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); unique.push(n); } });

  const minTotal = SWISS_GROUP_COUNT * SWISS_MIN_PER_GROUP;
  if (unique.length < minTotal) {
    alert(`Need at least ${minTotal} participants (${SWISS_MIN_PER_GROUP} per group × ${SWISS_GROUP_COUNT} groups).`);
    return null;
  }

  const shuffled = shuffleArray(unique);
  const groups = Array.from({ length: SWISS_GROUP_COUNT }, () => []);
  shuffled.forEach((name, i) => { groups[i % SWISS_GROUP_COUNT].push(name); });

  const state = {
    groups,
    matches: {},
    groupRounds: groups.map(() => 0),
    mode: "swiss",
    participants: unique,
    tournamentName: (tournamentName || "").trim() || null
  };
  groups.forEach((_, gi) => appendGroupRound(state, gi));
  return state;
}

// Back-compat: derive the participant list from any state shape. New
// generated states carry `participants` explicitly; older localStorage
// or remote snapshots may not, so fall back to groups / matches names.
function getParticipants(state) {
  if (state && Array.isArray(state.participants) && state.participants.length) {
    return state.participants.slice();
  }
  if (state && Array.isArray(state.groups)) {
    return state.groups.flat();
  }
  const seen = new Set();
  const out = [];
  Object.values((state && state.matches) || {}).forEach(m => {
    if (!m || m.bracket) { /* bracket may contain winners-only names; still include */ }
    if (m && m.a && !seen.has(m.a.toLowerCase())) { seen.add(m.a.toLowerCase()); out.push(m.a); }
    if (m && m.b && !seen.has(m.b.toLowerCase())) { seen.add(m.b.toLowerCase()); out.push(m.b); }
  });
  return out;
}

// Variable-size single-elimination bracket (any number of participants ≥ 2).
// Pads the bracket up to the next power of 2 with BYEs which auto-advance
// their sole player to the next round. Uses round-indexed match IDs
// (bracket-r0-*, bracket-r1-*, ...) for pre-final rounds and bracket-f-0
// for the final. 3rd place match is included when at least 4 participants
// are present (otherwise there's nothing meaningful to play for 3rd).
function generateSingleElimFromText(text, tournamentName) {
  const names = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  names.forEach(n => { if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); unique.push(n); } });

  if (unique.length < 2) {
    alert(`Single elimination needs at least 2 participants (${unique.length} provided).`);
    return null;
  }

  let bracketSize = 2;
  while (bracketSize < unique.length) bracketSize *= 2;
  const preFinalRounds = Math.round(Math.log2(bracketSize)) - 1; // rounds before the final

  const shuffled = shuffleArray(unique);
  // Pad with null for BYE slots. Simple tail-padding — the tail positions
  // get the byes.
  while (shuffled.length < bracketSize) shuffled.push(null);

  const state = {
    groups: null,
    matches: {},
    groupRounds: [],
    mode: "single-elim",
    bracketSize,
    preFinalRounds,
    participants: unique,
    tournamentName: (tournamentName || "").trim() || null
  };

  const emptyBracketMatch = (round, idx) => ({
    bracket: true, round, bracketIndex: idx,
    groupIndex: null, a: null, b: null,
    scoreA: null, scoreB: null, startedAt: null, bye: false
  });

  if (preFinalRounds === 0) {
    // 2-player bracket — just the final.
    state.matches["bracket-f-0"] = {
      ...emptyBracketMatch("f", 0),
      a: shuffled[0], b: shuffled[1]
    };
  } else {
    // Round 0: fill with the actual seeded pairs (plus any BYEs from padding).
    for (let j = 0; j < bracketSize / 2; j++) {
      state.matches[`bracket-r0-${j}`] = {
        ...emptyBracketMatch(0, j),
        a: shuffled[j * 2],
        b: shuffled[j * 2 + 1]
      };
    }
    // Intermediate rounds — empty slots, filled later via propagation.
    for (let r = 1; r < preFinalRounds; r++) {
      const matchesInRound = bracketSize / Math.pow(2, r + 1);
      for (let j = 0; j < matchesInRound; j++) {
        state.matches[`bracket-r${r}-${j}`] = emptyBracketMatch(r, j);
      }
    }
    state.matches["bracket-f-0"] = emptyBracketMatch("f", 0);
    if (unique.length >= 4) {
      state.matches["bracket-3rd-0"] = emptyBracketMatch("3rd", 0);
    }
  }

  autoAdvanceByes(state);
  return state;
}

// Walk the bracket and auto-score any match where one slot is a BYE (null).
// Propagates the non-null player up the bracket. Runs to a fixed point so
// cascading byes (BYE → BYE → real match) are all handled in one pass.
function autoAdvanceByes(state) {
  let changed = true;
  let iter = 0;
  while (changed && iter < 100) {
    changed = false;
    Object.entries(state.matches).forEach(([id, m]) => {
      if (!m.bracket) return;
      if (m.scoreA != null || m.scoreB != null) return;
      const hasA = m.a != null && m.a !== "";
      const hasB = m.b != null && m.b !== "";
      if (hasA === hasB) return; // both filled or both empty — skip
      m.bye = true;
      if (hasA) { m.scoreA = 1; m.scoreB = 0; }
      else       { m.scoreA = 0; m.scoreB = 1; }
      const prop = getBracketPropagation(m.round, m.bracketIndex, state);
      if (prop && prop.winner) {
        const winner = hasA ? m.a : m.b;
        const target = state.matches[prop.winner.toId];
        if (target) target[prop.winner.slot] = winner;
      }
      changed = true;
    });
    iter++;
  }
}

function isGroupRoundComplete(matches, groupIndex, roundIndex) {
  const roundMatches = Object.values(matches).filter(m => m.groupIndex === groupIndex && m.round === roundIndex);
  if (roundMatches.length === 0) return false;
  return roundMatches.every(m => m.bye || (m.scoreA != null && m.scoreB != null));
}

function resetSwiss() {
  const state = loadSwiss();
  const hasAny = state.groups || Object.keys(state.matches || {}).length > 0;
  const inRoom = !!swissEditCode;
  const promptMsg = inRoom && !swissIsHost
    ? "Leave this live room?"
    : "Clear participants, groups, and all match scores?";
  if ((hasAny || inRoom) && !confirm(promptMsg)) return;
  // Host wipes the remote room (including the viewer-code mapping) so every
  // joined device clears too. Non-hosts just disconnect locally.
  if (inRoom && swissIsHost && swissRoomRef) {
    try {
      swissRoomRef.set(null);
      if (swissViewCode && swissDb) swissDb.ref("swissViewCodes/" + swissViewCode).set(null);
    } catch (e) {}
  }
  disconnectSwissRoom();
  // Bypass push-on-persist by writing directly.
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
  const textarea = document.getElementById("swiss-names");
  if (textarea) textarea.value = "";
  const joinInput = document.getElementById("swiss-join-code");
  if (joinInput) joinInput.value = "";
  const joinStatus = document.getElementById("swiss-join-status");
  if (joinStatus) joinStatus.textContent = "";
  renderSwiss();
}

function startSwissMatch(matchId) {
  // Participants (joined via view-only code) can't score — never open the
  // match scoreboard for them, even if something bypasses the UI gating.
  if (swissEditCode && !swissCanEdit) return;
  const state = loadSwiss();
  const match = state.matches[matchId];
  if (!match) return;
  if (match.bye) {
    alert(`${match.a} has a BYE this round.`);
    return;
  }

  // One live match per device. If we're already live on a different match,
  // block and tell the user to switch that one off first.
  if (swissLiveMatchId && swissLiveMatchId !== matchId) {
    alert("You're already live on another match. Tap that card to switch it off first.");
    return;
  }

  const isEdit = match.scoreA != null && match.scoreB != null;

  // Tapping the same unscored match we went live on toggles live OFF:
  // clears the in-progress flag, resets the scoreboard to default. Any
  // scores entered but not saved are discarded.
  if (!isEdit && swissLiveMatchId === matchId) {
    swissLiveMatchId = null;
    const s = loadSwiss();
    if (s.matches[matchId]) {
      s.matches[matchId].startedAt = null;
      persistSwiss(s);
      pushSwissMatchStart(matchId, null);
    }
    if (typeof window.resetScoreboardToDefault === "function") {
      window.resetScoreboardToDefault();
    }
    renderSwiss();
    return;
  }

  // Going live ON an unscored match — mark startedAt and claim the device
  // slot. Edits don't flip live (the card shows the score, not a badge).
  if (!isEdit) {
    swissLiveMatchId = matchId;
    const now = Date.now();
    const s = loadSwiss();
    if (s.matches[matchId]) {
      s.matches[matchId].startedAt = now;
      persistSwiss(s);
      pushSwissMatchStart(matchId, now);
      renderSwiss();
    }
  }

  window.openScoreboard(match.a, match.b, ({ scoreA, scoreB }) => {
    swissLiveMatchId = null;
    const s = loadSwiss();
    const stored = s.matches[matchId];
    if (!stored) return;
    stored.scoreA = scoreA;
    stored.scoreB = scoreB;
    stored.startedAt = null;

    // Group match: on a fresh completion of the latest generated round,
    // auto-generate the next round. Skip on edits and on bracket matches.
    let newMatchIds = null;
    if (!isEdit && !stored.bracket) {
      const gi = stored.groupIndex;
      const latestRoundIdx = (s.groupRounds[gi] || 0) - 1;
      if (stored.round === latestRoundIdx && isGroupRoundComplete(s.matches, gi, latestRoundIdx)) {
        if ((s.groupRounds[gi] || 0) < SWISS_ROUND_COUNT) {
          const before = new Set(Object.keys(s.matches));
          appendGroupRound(s, gi);
          newMatchIds = Object.keys(s.matches).filter(k => !before.has(k));
        }
      }
    }

    // Auto-generate the top-8 knockout bracket the moment every group's
    // final round completes, so no one has to hunt for a "Start" button.
    // Only fires once — the hasSwissBracket guard makes this idempotent for
    // late edits that don't change group completion.
    if (!stored.bracket && isGroupStageComplete(s) && !hasSwissBracket(s)) {
      const bracketMatches = buildBracketMatches(s);
      Object.assign(s.matches, bracketMatches);
      newMatchIds = (newMatchIds || []).concat(Object.keys(bracketMatches));
    }

    // Bracket match: propagate both winner and loser into their respective
    // downstream slots. Winners go up the main bracket (SF → F) or the
    // consolation bracket (CQF → 5th); losers drop into placement matches
    // (SF → 3rd, QF → CQF, CQF → 7th). Ties leave both downstream slots
    // blank so the UI flags them for re-scoring.
    let extraUpdates = null;
    if (stored.bracket) {
      const prop = getBracketPropagation(stored.round, stored.bracketIndex, s);
      if (prop) {
        let winner = null, loser = null;
        if (scoreA > scoreB) { winner = stored.a; loser = stored.b; }
        else if (scoreB > scoreA) { winner = stored.b; loser = stored.a; }
        extraUpdates = {};
        if (prop.winner && s.matches[prop.winner.toId]) {
          s.matches[prop.winner.toId][prop.winner.slot] = winner;
          extraUpdates[`matches/${prop.winner.toId}/${prop.winner.slot}`] = winner;
        }
        if (prop.loser && s.matches[prop.loser.toId]) {
          s.matches[prop.loser.toId][prop.loser.slot] = loser;
          extraUpdates[`matches/${prop.loser.toId}/${prop.loser.slot}`] = loser;
        }
      }
    }

    persistSwiss(s);
    pushSwissMatchUpdate(matchId, stored, s, newMatchIds, extraUpdates);
    renderSwiss();
  }, isEdit ? match.scoreA : 0, isEdit ? match.scoreB : 0);
}

let swissGroupViews = {}; // gi -> "matches" | "standings"

function renderSwissMatchCard(matchNum, id, m, seedA, seedB) {
  const done = m.scoreA != null && m.scoreB != null;
  const live = !done && m.startedAt != null;
  const aWin = done && m.scoreA > m.scoreB;
  const bWin = done && m.scoreB > m.scoreA;
  const aScore = done ? m.scoreA : (live ? "…" : "");
  const bScore = done ? m.scoreB : (live ? "…" : "");

  if (m.bye) {
    return `<div class="swiss-match-wrap">
      <div class="swiss-match-num">${matchNum}</div>
      <div class="swiss-match-card swiss-match-bye">
        <div class="swiss-match-row swiss-match-row-win swiss-match-row-bye">
          <span class="swiss-seed">${seedA}</span>
          <span class="swiss-name-cell">${escapeHtml(m.a)} <span class="swiss-bye-tag">BYE</span></span>
          <span class="swiss-score-cell swiss-score-win">W</span>
        </div>
      </div>
    </div>`;
  }

  const isMine = live && swissLiveMatchId === id;
  const hint = done
    ? "Tap to fix score"
    : isMine
      ? "Tap to switch LIVE off"
      : live
        ? "Match in progress on another device"
        : "Tap to go LIVE on this match";
  const clickable = ` data-match="${id}" role="button" tabindex="0" title="${hint}" aria-label="${hint}"`;
  const liveClass = live
    ? (isMine ? " swiss-match-card-live swiss-match-card-live-mine" : " swiss-match-card-live")
    : "";
  const cardClass = "swiss-match-card swiss-match-card-play" + liveClass;
  const liveBadge = live
    ? `<span class="swiss-live-badge${isMine ? " swiss-live-badge-mine" : ""}" aria-label="Match in progress">LIVE</span>`
    : "";
  return `<div class="swiss-match-wrap">
    <div class="swiss-match-num">${matchNum}${liveBadge}</div>
    <div class="${cardClass}"${clickable}>
      <div class="swiss-match-row ${aWin ? "swiss-match-row-win" : done ? "swiss-match-row-lose" : ""}">
        <span class="swiss-seed">${seedA}</span>
        <span class="swiss-name-cell">${escapeHtml(m.a)}</span>
        <span class="swiss-score-cell ${aWin ? "swiss-score-win" : ""}">${aScore}</span>
      </div>
      <div class="swiss-match-row ${bWin ? "swiss-match-row-win" : done ? "swiss-match-row-lose" : ""}">
        <span class="swiss-seed">${seedB}</span>
        <span class="swiss-name-cell">${escapeHtml(m.b)}</span>
        <span class="swiss-score-cell ${bWin ? "swiss-score-win" : ""}">${bScore}</span>
      </div>
    </div>
  </div>`;
}

function renderSwissGroupMatches(state, gi) {
  const members = state.groups[gi];
  const seedOf = (name) => members.indexOf(name) + 1;

  // Assign stable sequential match numbers within the group (round asc, match index asc).
  const groupMatchEntries = Object.entries(state.matches)
    .filter(([, m]) => m.groupIndex === gi)
    .sort(([a], [b]) => a.localeCompare(b));
  const numberFor = {};
  groupMatchEntries.forEach(([id], i) => { numberFor[id] = i + 1; });

  const roundsGen = state.groupRounds[gi] || 0;
  const rounds = [];
  for (let ri = 0; ri < roundsGen; ri++) {
    const roundMatches = groupMatchEntries.filter(([, m]) => m.round === ri);
    const cards = roundMatches.map(([id, m]) =>
      renderSwissMatchCard(numberFor[id], id, m, seedOf(m.a), m.b ? seedOf(m.b) : "")
    ).join("");
    rounds.push(`<div class="swiss-round-col">
      <div class="swiss-round-title">Round ${ri + 1}</div>
      <div class="swiss-match-list">${cards}</div>
    </div>`);
  }

  if (rounds.length === 0) {
    return `<div class="swiss-empty">No rounds yet.</div>`;
  }

  return `<div class="swiss-rounds-scroll">${rounds.join("")}</div>`;
}

function renderSwissGroupStandings(state, gi) {
  const members = state.groups[gi];
  const standings = computeStandings(members, state.matches, gi);
  const rows = standings.map((row, idx) => {
    const pd = row.pointsDiff > 0 ? `+${row.pointsDiff}` : `${row.pointsDiff}`;
    return `
    <li>
      <span class="swiss-rank">${idx + 1}</span>
      <span class="swiss-name-cell">${escapeHtml(row.name)}</span>
      <span class="swiss-record">${row.wins}W-${row.losses}L-${row.draws}D</span>
      <span class="swiss-tiebreak" title="Points Scored · Points Difference · Median-Buchholz">PS ${row.pointsScored} · PD ${pd} · MB ${row.medianBuchholz}</span>
    </li>
  `;
  }).join("");
  return `<ol class="swiss-members">${rows}</ol>`;
}

// Picks the scrollLeft target for a .swiss-rounds-scroll strip. Group strips
// always snap rightmost (show the newest round). The Swiss top-8 bracket
// advances column-by-column as each round finishes.
function computeSwissRoundsScrollTarget(scrollEl, state) {
  const isBracketStrip = !!scrollEl.closest(".swiss-bracket");
  if (!isBracketStrip || !state || state.mode !== "swiss") {
    return scrollEl.scrollWidth;
  }
  const cols = scrollEl.querySelectorAll(".swiss-round-col");
  if (cols.length < 3) return scrollEl.scrollWidth;

  const bracketMatches = Object.values(state.matches || {}).filter(m => m && m.bracket);
  const roundDone = (round) => {
    const ms = bracketMatches.filter(m => m.round === round);
    return ms.length > 0 && ms.every(m => m.bye || (m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB));
  };

  const qfDone = roundDone("qf");
  const sfDone = roundDone("sf");
  const cqfDone = roundDone("cqf");

  if (!qfDone) return 0;
  if (!(sfDone && cqfDone)) {
    const scrollRect = scrollEl.getBoundingClientRect();
    const colRect = cols[1].getBoundingClientRect();
    return Math.max(0, scrollEl.scrollLeft + (colRect.left - scrollRect.left));
  }
  return scrollEl.scrollWidth;
}

function renderSwissBracketCard(label, id, m) {
  // Bracket BYE — one slot empty, auto-scored. Renders as a single-row card.
  if (m.bye) {
    const player = m.a || m.b || "";
    return `<div class="swiss-match-wrap">
      <div class="swiss-match-num">${label}</div>
      <div class="swiss-match-card swiss-match-card-bracket swiss-match-bye">
        <div class="swiss-match-row swiss-match-row-win swiss-match-row-bye">
          <span class="swiss-name-cell">${escapeHtml(player)} <span class="swiss-bye-tag">BYE</span></span>
          <span class="swiss-score-cell swiss-score-win">W</span>
        </div>
      </div>
    </div>`;
  }

  const done = m.scoreA != null && m.scoreB != null;
  const isTie = done && m.scoreA === m.scoreB;
  const pending = !m.a || !m.b;
  const live = !done && m.startedAt != null;
  const isMine = live && swissLiveMatchId === id;
  const aWin = done && !isTie && m.scoreA > m.scoreB;
  const bWin = done && !isTie && m.scoreB > m.scoreA;
  const aScore = done ? m.scoreA : (live ? "…" : "");
  const bScore = done ? m.scoreB : (live ? "…" : "");

  const hint = pending
    ? "Waiting for earlier round"
    : isTie
      ? "Tied — tap to re-score (ties can't advance)"
      : done
        ? "Tap to fix score"
        : isMine
          ? "Tap to switch LIVE off"
          : live
            ? "Match in progress on another device"
            : "Tap to go LIVE on this match";

  const clickable = pending ? "" : ` data-match="${id}" role="button" tabindex="0" title="${hint}" aria-label="${hint}"`;
  const liveClass = live ? (isMine ? " swiss-match-card-live swiss-match-card-live-mine" : " swiss-match-card-live") : "";
  const cardClass = "swiss-match-card swiss-match-card-bracket" + (pending ? " swiss-match-card-pending" : " swiss-match-card-play") + liveClass + (isTie ? " swiss-match-card-tie" : "");
  const liveBadge = live ? `<span class="swiss-live-badge${isMine ? " swiss-live-badge-mine" : ""}">LIVE</span>` : "";
  const tieBadge = isTie ? `<span class="swiss-tie-badge">TIE</span>` : "";

  return `<div class="swiss-match-wrap">
    <div class="swiss-match-num">${label}${liveBadge}${tieBadge}</div>
    <div class="${cardClass}"${clickable}>
      <div class="swiss-match-row ${aWin ? "swiss-match-row-win" : (done && !isTie) ? "swiss-match-row-lose" : ""}">
        <span class="swiss-name-cell">${escapeHtml(m.a || "TBD")}</span>
        <span class="swiss-score-cell ${aWin ? "swiss-score-win" : ""}">${aScore}</span>
      </div>
      <div class="swiss-match-row ${bWin ? "swiss-match-row-win" : (done && !isTie) ? "swiss-match-row-lose" : ""}">
        <span class="swiss-name-cell">${escapeHtml(m.b || "TBD")}</span>
        <span class="swiss-score-cell ${bWin ? "swiss-score-win" : ""}">${bScore}</span>
      </div>
    </div>
  </div>`;
}

function renderSwissTop8({ final, third, fifth, seventh }) {
  const isDecided = (m) => m && m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB;
  const winnerLoser = (m) => {
    const aWin = m.scoreA > m.scoreB;
    return { winner: aWin ? m.a : m.b, loser: aWin ? m.b : m.a };
  };

  const rows = [];
  if (final && isDecided(final.m)) {
    const { winner, loser } = winnerLoser(final.m);
    rows.push({ rank: 1, name: winner });
    rows.push({ rank: 2, name: loser });
  }
  if (third && isDecided(third.m)) {
    const { winner, loser } = winnerLoser(third.m);
    rows.push({ rank: 3, name: winner });
    rows.push({ rank: 4, name: loser });
  }
  if (fifth && isDecided(fifth.m)) {
    const { winner, loser } = winnerLoser(fifth.m);
    rows.push({ rank: 5, name: winner });
    rows.push({ rank: 6, name: loser });
  }
  if (seventh && isDecided(seventh.m)) {
    const { winner, loser } = winnerLoser(seventh.m);
    rows.push({ rank: 7, name: winner });
    rows.push({ rank: 8, name: loser });
  }

  if (!rows.length) return "";

  const ordinal = (n) => ({ 1: "1st", 2: "2nd", 3: "3rd" })[n] || (n + "th");
  const medal = (n) => ({ 1: "🥇", 2: "🥈", 3: "🥉" })[n] || "";

  const items = rows.map(r => {
    const rankClass = r.rank <= 3 ? ` swiss-top-rank-${r.rank}` : "";
    return `
      <li class="swiss-top-rank${rankClass}">
        <span class="swiss-top-rank-num">${ordinal(r.rank)}</span>
        <span class="swiss-top-rank-medal">${medal(r.rank)}</span>
        <span class="swiss-top-rank-name">${escapeHtml(r.name || "")}</span>
      </li>
    `;
  }).join("");

  return `<ol class="swiss-top-8">${items}</ol>`;
}

function renderSwissBracket(state) {
  if (state.mode === "single-elim") {
    return renderSingleElimBracket(state);
  }
  return renderSwissTop8Bracket(state);
}

function getBracketRoundName(matchesInRound) {
  if (matchesInRound === 1) return "Final";
  if (matchesInRound === 2) return "Semifinals";
  if (matchesInRound === 4) return "Quarterfinals";
  return `Round of ${matchesInRound * 2}`;
}

function getBracketShortLabel(matchesInRound, index) {
  if (matchesInRound === 1) return "F";
  if (matchesInRound === 2) return `SF${index + 1}`;
  if (matchesInRound === 4) return `QF${index + 1}`;
  return `R${index + 1}`;
}

function renderSingleElimBracket(state) {
  const bracketSize = state.bracketSize || 2;
  const preFinalRounds = typeof state.preFinalRounds === "number" ? state.preFinalRounds : 0;
  const finalMatch = state.matches["bracket-f-0"];
  const thirdMatch = state.matches["bracket-3rd-0"];

  // Pre-final round columns
  const columnHtml = [];
  for (let r = 0; r < preFinalRounds; r++) {
    const matchesInRound = bracketSize / Math.pow(2, r + 1);
    const roundName = getBracketRoundName(matchesInRound);
    const cards = [];
    for (let j = 0; j < matchesInRound; j++) {
      const id = `bracket-r${r}-${j}`;
      const m = state.matches[id];
      if (m) cards.push(renderSwissBracketCard(getBracketShortLabel(matchesInRound, j), id, m));
    }
    columnHtml.push(`
      <div class="swiss-round-col">
        <div class="swiss-round-title">${roundName}</div>
        <div class="swiss-match-list">${cards.join("")}</div>
      </div>
    `);
  }

  // Final column — the Final plus (optionally) the 3rd place match.
  const finalColParts = [];
  finalColParts.push(`<div class="swiss-round-title">Final</div>`);
  finalColParts.push(`<div class="swiss-match-list">${finalMatch ? renderSwissBracketCard("F", "bracket-f-0", finalMatch) : ""}</div>`);
  if (thirdMatch) {
    finalColParts.push(`<div class="swiss-round-subtitle">3rd Place</div>`);
    finalColParts.push(`<div class="swiss-match-list">${renderSwissBracketCard("3rd", "bracket-3rd-0", thirdMatch)}</div>`);
  }
  columnHtml.push(`<div class="swiss-round-col">${finalColParts.join("")}</div>`);

  const topRankings = renderSwissTop8({
    final: finalMatch ? { id: "bracket-f-0", m: finalMatch } : null,
    third: thirdMatch ? { id: "bracket-3rd-0", m: thirdMatch } : null,
    fifth: null,
    seventh: null
  });

  return `
    <section class="swiss-bracket">
      <header class="swiss-bracket-header">
        <span class="swiss-bracket-title">Single Elimination — ${bracketSize}-slot bracket</span>
      </header>
      ${topRankings}
      <div class="swiss-rounds-scroll">
        ${columnHtml.join("")}
      </div>
    </section>
  `;
}

function renderSwissTop8Bracket(state) {
  const qf = [];
  const sf = [];
  const cqf = [];
  let final = null, third = null, fifth = null, seventh = null;

  Object.entries(state.matches || {}).forEach(([id, m]) => {
    if (!id.startsWith("bracket-")) return;
    if (m.round === "qf") qf[m.bracketIndex] = { id, m };
    else if (m.round === "sf") sf[m.bracketIndex] = { id, m };
    else if (m.round === "cqf") cqf[m.bracketIndex] = { id, m };
    else if (m.round === "f") final = { id, m };
    else if (m.round === "3rd") third = { id, m };
    else if (m.round === "5th") fifth = { id, m };
    else if (m.round === "7th") seventh = { id, m };
  });

  const qfHtml = qf.map((e, i) => e ? renderSwissBracketCard(`QF${i + 1}`, e.id, e.m) : "").join("");
  const sfHtml = sf.map((e, i) => e ? renderSwissBracketCard(`SF${i + 1}`, e.id, e.m) : "").join("");
  const cqfHtml = cqf.map((e, i) => e ? renderSwissBracketCard(`C${i + 1}`, e.id, e.m) : "").join("");
  const cardOrBlank = (entry, label) => entry ? renderSwissBracketCard(label, entry.id, entry.m) : "";

  const top8 = renderSwissTop8({ final, third, fifth, seventh });

  return `
    <section class="swiss-bracket">
      <header class="swiss-bracket-header">
        <span class="swiss-bracket-title">Knockout — Top 8</span>
      </header>
      ${top8}
      <div class="swiss-rounds-scroll">
        <div class="swiss-round-col">
          <div class="swiss-round-title">Quarterfinals</div>
          <div class="swiss-match-list">${qfHtml}</div>
        </div>
        <div class="swiss-round-col">
          <div class="swiss-round-title">Semifinals</div>
          <div class="swiss-match-list">${sfHtml}</div>
          <div class="swiss-round-subtitle">Consolation (QF losers)</div>
          <div class="swiss-match-list">${cqfHtml}</div>
        </div>
        <div class="swiss-round-col">
          <div class="swiss-round-title">Final</div>
          <div class="swiss-match-list">${cardOrBlank(final, "F")}</div>
          <div class="swiss-round-subtitle">3rd Place</div>
          <div class="swiss-match-list">${cardOrBlank(third, "3rd")}</div>
          <div class="swiss-round-subtitle">5th Place</div>
          <div class="swiss-match-list">${cardOrBlank(fifth, "5th")}</div>
          <div class="swiss-round-subtitle">7th Place</div>
          <div class="swiss-match-list">${cardOrBlank(seventh, "7th")}</div>
        </div>
      </div>
    </section>
  `;
}

function renderSwissRoomBadge() {
  if (!swissEditCode) return "";
  const pills = [];
  // Users who can edit see the Co-host code so they can invite other refs.
  if (swissCanEdit) {
    const label = swissIsHost ? "Host" : "Co-host";
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-edit" title="${label} — tap to copy">
        <span class="swiss-room-role">${label}</span>
        <button type="button" class="swiss-room-code" data-room="${swissEditCode}">${swissEditCode}</button>
      </span>
    `);
  }
  // Everyone sees the participant code so they can invite spectators.
  if (swissViewCode) {
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-view" title="Participant (view only) — tap to copy">
        <span class="swiss-room-role">View</span>
        <button type="button" class="swiss-room-code" data-room="${swissViewCode}">${swissViewCode}</button>
      </span>
    `);
  }
  if (!pills.length) return "";
  return `<div class="swiss-room-badges">${pills.join("")}</div>`;
}

function bindSwissRoomBadge(view) {
  view.querySelectorAll(".swiss-room-code").forEach(btn => {
    btn.addEventListener("click", () => {
      const code = btn.dataset.room || "";
      if (!code) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(() => {
          const prev = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = prev; }, 1200);
        }).catch(() => {});
      }
    });
  });
}

function renderSwiss() {
  const view = document.getElementById("swiss-view");
  const setup = document.getElementById("swiss-setup");
  if (!view || !setup) return;

  // Capture current horizontal scroll of each rounds strip so re-rendering
  // doesn't snap back to round 1. Groups are in stable A/B/C/D order, bracket
  // always follows — index-based mapping works. We merge with stored state so
  // a user-scrolled value from before the render is preserved even if the
  // element was temporarily detached.
  Array.from(view.querySelectorAll(".swiss-rounds-scroll")).forEach((el, i) => {
    swissScrollPositions[i] = el.scrollLeft;
  });

  const state = loadSwiss();
  const hasGroups = !!state.groups;
  const bracketActive = hasSwissBracket(state);
  const hasTournament = hasGroups || bracketActive;
  const inRoom = !!swissEditCode;
  const inRoomNonHost = inRoom && !swissIsHost;

  // Hide the setup form once we have a live tournament OR when the user is
  // connected to someone else's room (they shouldn't generate their own).
  setup.classList.toggle("hidden", hasTournament || inRoomNonHost);

  if (!hasTournament) {
    if (inRoomNonHost) {
      view.innerHTML = `
        <div class="swiss-toolbar">
          ${renderSwissRoomBadge()}
          <button type="button" id="swiss-clear" class="btn btn-reset" title="Leave Room">
            <img src="assets/icons/exit-button.png" alt="Leave"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
          </button>
        </div>
        <div class="swiss-empty">Waiting for host to start the tournament…</div>
      `;
      view.querySelector("#swiss-clear")?.addEventListener("click", resetSwiss);
      bindSwissRoomBadge(view);
    } else {
      view.innerHTML = "";
    }
    return;
  }

  const groupStageDone = isGroupStageComplete(state);
  const isMatchDecided = (m) => m && m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB;
  // Swiss + top-8 mode needs every placement decided. Single-elim needs the
  // Final and (if present) the 3rd place match.
  const isSingleElim = state.mode === "single-elim";
  const placementIds = isSingleElim
    ? ["bracket-f-0"].concat(state.matches["bracket-3rd-0"] ? ["bracket-3rd-0"] : [])
    : ["bracket-f-0", "bracket-3rd-0", "bracket-5th-0", "bracket-7th-0"];
  const allPlacementsDone = bracketActive && placementIds.every(id => isMatchDecided(state.matches[id]));
  const tournamentComplete = bracketActive && allPlacementsDone;
  const canEdit = !inRoom || swissCanEdit;

  const groupsHtml = hasGroups ? state.groups.map((members, gi) => {
    const mode = swissGroupViews[gi] || "matches";
    const body = mode === "standings"
      ? renderSwissGroupStandings(state, gi)
      : renderSwissGroupMatches(state, gi);
    const roundsGen = state.groupRounds[gi] || 0;

    return `<section class="swiss-group">
      <header class="swiss-group-header">
        <span class="swiss-group-title">Group ${String.fromCharCode(65 + gi)}</span>
        <span class="swiss-group-progress">Round ${roundsGen} / ${SWISS_ROUND_COUNT}</span>
        <div class="swiss-group-tabs">
          <button type="button" class="swiss-group-tab ${mode === "standings" ? "active" : ""}" data-group="${gi}" data-view="standings">Standings</button>
          <button type="button" class="swiss-group-tab ${mode === "matches" ? "active" : ""}" data-group="${gi}" data-view="matches">Matches</button>
        </div>
      </header>
      <div class="swiss-group-body">${body}</div>
    </section>`;
  }).join("") : "";

  const bracketHtml = bracketActive ? renderSwissBracket(state) : "";
  const showStartKnockoutBtn = groupStageDone && !bracketActive && canEdit;
  const resetTitle = inRoomNonHost ? "Leave Room" : "Reset Tournament";

  const tournamentNameHtml = state.tournamentName
    ? `<span class="swiss-tournament-name" title="${escapeHtml(state.tournamentName)}">${escapeHtml(state.tournamentName)}</span>`
    : "";

  const nameRowHtml = (tournamentNameHtml || tournamentComplete)
    ? `<div class="swiss-toolbar-row swiss-toolbar-name-row">
        ${tournamentNameHtml}
        ${tournamentComplete ? `<span class="swiss-complete">Tournament Complete</span>` : ""}
      </div>`
    : "";

  view.innerHTML = `
    <div class="swiss-toolbar">
      ${nameRowHtml}
      <div class="swiss-toolbar-row swiss-toolbar-info-row">
        ${renderSwissRoomBadge()}
        ${showStartKnockoutBtn ? `<button type="button" id="swiss-start-bracket" class="btn">Start Knockout</button>` : ""}
        <div class="swiss-toolbar-actions">
          ${canEdit ? `<button type="button" id="swiss-edit-participants" class="btn btn-icon-sm" aria-label="Edit participants" title="Edit participants">
            <img src="assets/icons/pencil.png" alt="Edit"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#9998;');">
          </button>` : ""}
          <button type="button" id="swiss-clear" class="btn btn-reset btn-icon-sm" title="${resetTitle}">
            <img src="assets/icons/exit-button.png" alt="${resetTitle}"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
          </button>
        </div>
      </div>
    </div>
    ${groupsHtml}
    ${bracketHtml}
  `;

  // Auto-scroll each rounds strip after render. Group strips snap to the
  // rightmost (latest round). The Swiss top-8 bracket strip advances column
  // by column as rounds complete: QF (left) → SF/consolation (middle) → Final
  // + placements (right). Retry at several delays because exiting the
  // scoreboard's landscape/fullscreen mode triggers a layout reflow (up to
  // ~800ms on mobile) that can reset scrollLeft after the initial snap.
  view.querySelectorAll(".swiss-rounds-scroll").forEach((el, i) => {
    const snap = () => {
      el.scrollLeft = computeSwissRoundsScrollTarget(el, state);
    };
    requestAnimationFrame(snap);
    [100, 400, 800, 1200].forEach(delay => setTimeout(snap, delay));
    swissScrollPositions[i] = computeSwissRoundsScrollTarget(el, state);
    el.addEventListener("scroll", () => {
      swissScrollPositions[i] = el.scrollLeft;
    }, { passive: true });
  });

  bindSwissRoomBadge(view);
  view.querySelector("#swiss-start-bracket")?.addEventListener("click", startSwissBracket);
  view.querySelector("#swiss-edit-participants")?.addEventListener("click", showEditParticipantsPopup);

  // Match cards are interactive only for users who can edit (host + co-host).
  // Participants joined via the view-only code see cards but can't open them.
  if (canEdit) {
    view.querySelectorAll(".swiss-match-card-play").forEach(el => {
      const id = el.dataset.match;
      if (!id) return;
      el.addEventListener("click", () => startSwissMatch(id));
      el.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); startSwissMatch(id); }
      });
    });
  } else {
    view.querySelectorAll(".swiss-match-card-play").forEach(el => {
      el.classList.remove("swiss-match-card-play");
      el.removeAttribute("role");
      el.removeAttribute("tabindex");
      el.removeAttribute("title");
      el.removeAttribute("aria-label");
    });
  }
  view.querySelectorAll(".swiss-group-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const gi = Number(btn.dataset.group);
      swissGroupViews[gi] = btn.dataset.view;
      renderSwiss();
    });
  });
  view.querySelector("#swiss-clear")?.addEventListener("click", resetSwiss);
}

function computeStandings(members, matches, groupIndex) {
  const stats = {};
  members.forEach(n => {
    stats[n] = { name: n, wins: 0, losses: 0, draws: 0, pointsScored: 0, pointsAgainst: 0, opponents: [] };
  });
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (m.bye && m.a && stats[m.a]) { stats[m.a].wins++; return; }
    if (m.scoreA == null || m.scoreB == null) return;
    if (!stats[m.a] || !stats[m.b]) return;
    stats[m.a].pointsScored += m.scoreA;
    stats[m.a].pointsAgainst += m.scoreB;
    stats[m.b].pointsScored += m.scoreB;
    stats[m.b].pointsAgainst += m.scoreA;
    stats[m.a].opponents.push(m.b);
    stats[m.b].opponents.push(m.a);
    if (m.scoreA > m.scoreB) { stats[m.a].wins++; stats[m.b].losses++; }
    else if (m.scoreB > m.scoreA) { stats[m.b].wins++; stats[m.a].losses++; }
    else { stats[m.a].draws++; stats[m.b].draws++; }
  });

  // Tie-breakers: Points Scored, Points Difference, Median-Buchholz
  // (sum of opponents' wins, dropping highest and lowest when >= 3 opponents).
  members.forEach(n => {
    const s = stats[n];
    s.pointsDiff = s.pointsScored - s.pointsAgainst;
    const oppWins = s.opponents.map(o => (stats[o] ? stats[o].wins : 0));
    if (oppWins.length >= 3) {
      oppWins.sort((a, b) => a - b);
      oppWins.shift();
      oppWins.pop();
    }
    s.medianBuchholz = oppWins.reduce((sum, w) => sum + w, 0);
  });

  return members
    .map(n => stats[n])
    .sort((a, b) =>
      (b.wins - a.wins) ||
      (b.pointsScored - a.pointsScored) ||
      (b.pointsDiff - a.pointsDiff) ||
      (b.medianBuchholz - a.medianBuchholz) ||
      a.name.localeCompare(b.name)
    );
}

// ---------------- Knockout bracket -----------------
// Top 2 per group (A1, A2, B1, B2, C1, C2, D1, D2) → 8-player single
// elimination with full placement matches (1st, 3rd, 5th, 7th).
//
// Main bracket:
//   QF0: A1 vs B2   QF1: C1 vs D2   QF2: B1 vs A2   QF3: D1 vs C2
//   SF0: QF0w vs QF1w              SF1: QF2w vs QF3w
//   F0:  SF0w vs SF1w              3rd: SF0l vs SF1l
//
// Consolation (QF losers) for 5th/7th:
//   CQF0: QF0l vs QF1l             CQF1: QF2l vs QF3l
//   5th:  CQF0w vs CQF1w           7th:  CQF0l vs CQF1l

function hasSwissBracket(state) {
  return Object.keys(state.matches || {}).some(k => k.startsWith("bracket-"));
}

function isGroupStageComplete(state) {
  if (!state.groups || state.groups.length !== SWISS_GROUP_COUNT) return false;
  return state.groups.every((_, gi) =>
    (state.groupRounds[gi] || 0) >= SWISS_ROUND_COUNT &&
    isGroupRoundComplete(state.matches, gi, SWISS_ROUND_COUNT - 1)
  );
}

function getBracketPropagation(round, bracketIndex, state) {
  // Return both winner and loser destinations. Placement-final rounds
  // (f, 3rd, 5th, 7th) are terminal and return null.
  if (round === "qf") {
    const sfIdx = Math.floor(bracketIndex / 2);
    const slot = bracketIndex % 2 === 0 ? "a" : "b";
    return {
      winner: { toId: `bracket-sf-${sfIdx}`, slot },
      loser:  { toId: `bracket-cqf-${sfIdx}`, slot }
    };
  }
  if (round === "sf") {
    const slot = bracketIndex === 0 ? "a" : "b";
    return {
      winner: { toId: "bracket-f-0", slot },
      loser:  { toId: "bracket-3rd-0", slot }
    };
  }
  if (round === "cqf") {
    const slot = bracketIndex === 0 ? "a" : "b";
    return {
      winner: { toId: "bracket-5th-0", slot },
      loser:  { toId: "bracket-7th-0", slot }
    };
  }
  // Single-elimination (variable size) — numeric round index.
  if (typeof round === "number") {
    const preFinal = state && typeof state.preFinalRounds === "number" ? state.preFinalRounds : 0;
    const isSemi = round === preFinal - 1;
    const slot = bracketIndex % 2 === 0 ? "a" : "b";
    if (isSemi) {
      const has3rd = !!(state && state.matches && state.matches["bracket-3rd-0"]);
      return {
        winner: { toId: "bracket-f-0", slot },
        loser:  has3rd ? { toId: "bracket-3rd-0", slot } : null
      };
    }
    return {
      winner: { toId: `bracket-r${round + 1}-${Math.floor(bracketIndex / 2)}`, slot },
      loser:  null
    };
  }
  return null;
}

function bracketSeedingFromStandings(state) {
  const top = state.groups.map((members, gi) => {
    const st = computeStandings(members, state.matches, gi);
    return { first: (st[0] && st[0].name) || null, second: (st[1] && st[1].name) || null };
  });
  const [A, B, C, D] = top;
  return [
    [A.first, B.second],
    [C.first, D.second],
    [B.first, A.second],
    [D.first, C.second]
  ];
}

function buildBracketMatches(state) {
  const qfPairs = bracketSeedingFromStandings(state);
  const newMatches = {};
  const emptyBracketMatch = (round, idx) => ({
    bracket: true, round, bracketIndex: idx,
    groupIndex: null, a: null, b: null,
    scoreA: null, scoreB: null, startedAt: null, bye: false
  });

  // QFs — the only round that has names up front.
  qfPairs.forEach((pair, i) => {
    newMatches[`bracket-qf-${i}`] = {
      ...emptyBracketMatch("qf", i),
      a: pair[0], b: pair[1]
    };
  });
  // Semifinals + consolation QFs (QF losers cross).
  for (let i = 0; i < 2; i++) {
    newMatches[`bracket-sf-${i}`] = emptyBracketMatch("sf", i);
    newMatches[`bracket-cqf-${i}`] = emptyBracketMatch("cqf", i);
  }
  // Placement finals.
  newMatches["bracket-f-0"] = emptyBracketMatch("f", 0);
  newMatches["bracket-3rd-0"] = emptyBracketMatch("3rd", 0);
  newMatches["bracket-5th-0"] = emptyBracketMatch("5th", 0);
  newMatches["bracket-7th-0"] = emptyBracketMatch("7th", 0);
  return newMatches;
}

function startSwissBracket() {
  const s = loadSwiss();
  if (!isGroupStageComplete(s)) {
    alert("Finish every group match first.");
    return;
  }
  if (hasSwissBracket(s)) {
    if (!confirm("Bracket already started. Regenerate from current standings?")) return;
    Object.keys(s.matches).forEach(k => { if (k.startsWith("bracket-")) delete s.matches[k]; });
  }
  const newMatches = buildBracketMatches(s);
  Object.assign(s.matches, newMatches);
  persistSwiss(s);

  // Push all new bracket matches at once.
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    const updates = {};
    Object.entries(newMatches).forEach(([id, m]) => { updates[`matches/${id}`] = m; });
    swissRoomRef.update(updates).catch(e => console.warn("Bracket push failed:", e));
  }
  renderSwiss();
}

// Apply a pure rename mapping (old names → new names at the same positions)
// across groups, matches and the participants list. Returns true if any
// actual change was applied.
function applyParticipantRenames(state, oldNames, newNames) {
  const renames = Object.create(null);
  let any = false;
  for (let i = 0; i < oldNames.length; i++) {
    if (oldNames[i] !== newNames[i]) {
      renames[oldNames[i]] = newNames[i];
      any = true;
    }
  }
  if (!any) return false;
  state.participants = newNames.slice();
  if (Array.isArray(state.groups)) {
    state.groups = state.groups.map(grp => grp.map(name => (name in renames) ? renames[name] : name));
  }
  Object.values(state.matches || {}).forEach(m => {
    if (m && m.a && (m.a in renames)) m.a = renames[m.a];
    if (m && m.b && (m.b in renames)) m.b = renames[m.b];
  });
  return true;
}

function showEditParticipantsPopup() {
  const popup = document.getElementById("edit-participants-popup");
  if (!popup) return;
  const textarea = popup.querySelector("#edit-participants-names");
  const status = popup.querySelector("#edit-participants-status");
  const saveBtn = popup.querySelector("#edit-participants-save");
  const cancelBtn = popup.querySelector("#edit-participants-cancel");
  const state = loadSwiss();
  const current = getParticipants(state);
  textarea.value = current.join("\n");
  if (status) status.textContent = "";
  popup.classList.remove("hidden");

  const close = () => {
    popup.classList.add("hidden");
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  cancelBtn.onclick = close;
  saveBtn.onclick = () => {
    const lines = textarea.value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const seen = new Set();
    const unique = [];
    for (const n of lines) {
      const k = n.toLowerCase();
      if (!seen.has(k)) { seen.add(k); unique.push(n); }
    }
    if (unique.length === 0) {
      if (status) status.textContent = "Need at least one participant.";
      return;
    }
    const sameCount = unique.length === current.length;
    if (sameCount) {
      // Pure rename path — preserves scores, pairings and standings.
      const s = loadSwiss();
      const changed = applyParticipantRenames(s, current, unique);
      if (!changed) { close(); return; }
      persistSwiss(s);
      if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
        const payload = { ...s };
        if (swissViewCode) payload.viewCode = swissViewCode;
        swissRoomRef.set(payload).catch(e => console.warn("Rename push failed:", e));
      }
      renderSwiss();
      close();
      return;
    }
    // Count changed — regenerate the tournament.
    const msg = `Participant count changes from ${current.length} to ${unique.length}. ` +
                `This will regenerate the tournament — all current matches and scores will be lost. Continue?`;
    if (!confirm(msg)) return;
    const mode = state.mode === "single-elim" ? "single-elim" : "swiss";
    const next = mode === "single-elim"
      ? generateSingleElimFromText(unique.join("\n"), state.tournamentName)
      : generateSwissFromText(unique.join("\n"), state.tournamentName);
    if (!next) return; // generator already alerted (e.g. Swiss min participants)
    persistSwiss(next);
    if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
      const payload = { ...next };
      if (swissViewCode) payload.viewCode = swissViewCode;
      swissRoomRef.set(payload).catch(e => console.warn("Regenerate push failed:", e));
    }
    renderSwiss();
    close();
  };
}

function showTournamentModePopup(onPick) {
  const popup = document.getElementById("tournament-mode-popup");
  if (!popup) { onPick("swiss", ""); return; } // popup missing, fall back to swiss
  const swissBtn = popup.querySelector("#tournament-mode-swiss");
  const singleBtn = popup.querySelector("#tournament-mode-single");
  const cancelBtn = popup.querySelector("#tournament-mode-cancel");
  const nameInput = popup.querySelector("#tournament-name-input");
  if (nameInput) nameInput.value = "";
  const close = (choice) => {
    popup.classList.add("hidden");
    swissBtn.onclick = null;
    singleBtn.onclick = null;
    cancelBtn.onclick = null;
    if (choice) {
      const name = nameInput ? nameInput.value.trim() : "";
      onPick(choice, name);
    }
  };
  swissBtn.onclick = () => close("swiss");
  singleBtn.onclick = () => close("single-elim");
  cancelBtn.onclick = () => close(null);
  popup.classList.remove("hidden");
  if (nameInput) setTimeout(() => nameInput.focus(), 0);
}

function startTournamentFromState(next) {
  disconnectSwissRoom();
  localStorage.setItem(SWISS_KEY, JSON.stringify(next));
  if (firebaseReady()) {
    // Two codes: edit (co-host) + view (participant). Ensure they differ.
    const editCode = generateRoomCode();
    let viewCode = generateRoomCode();
    while (viewCode === editCode) viewCode = generateRoomCode();
    markRoomHosted(editCode);
    connectSwissRoom(editCode, viewCode, true, true);
    // connectSwissRoom saves a tournament history entry and its listener will
    // push the local state (with viewCode metadata) and publish the
    // swissViewCodes mapping because remote is empty.
  }
  renderSwiss();
}

const TOURNAMENT_HISTORY_KEY = "beyblade_tournament_history";
const TOURNAMENT_HISTORY_MAX = 20;

function loadTournamentHistory() {
  try { return JSON.parse(localStorage.getItem(TOURNAMENT_HISTORY_KEY)) || []; }
  catch { return []; }
}

function tournamentHistoryKey(entry) {
  return entry && (entry.editCode || entry.viewCode) || null;
}

function saveTournamentHistoryEntry(entry) {
  const key = tournamentHistoryKey(entry);
  if (!key) return;
  let list = loadTournamentHistory();
  const existing = list.find(e => tournamentHistoryKey(e) === key);
  const merged = {
    ...(existing || {}),
    ...entry,
    createdAt: existing?.createdAt || entry.createdAt || new Date().toISOString()
  };
  // Don't let an empty incoming name/mode overwrite a populated existing one
  // (happens when a join hits connectSwissRoom before the remote state arrives).
  if (existing?.name && !merged.name) merged.name = existing.name;
  if (existing?.mode && !merged.mode) merged.mode = existing.mode;
  // Skip no-op writes so every Firebase listener tick doesn't churn localStorage.
  if (existing
      && existing.name === merged.name
      && existing.mode === merged.mode
      && existing.editCode === merged.editCode
      && existing.viewCode === merged.viewCode
      && existing.role === merged.role) {
    return;
  }
  list = list.filter(e => tournamentHistoryKey(e) !== key);
  list.unshift(merged);
  list = list.slice(0, TOURNAMENT_HISTORY_MAX);
  localStorage.setItem(TOURNAMENT_HISTORY_KEY, JSON.stringify(list));
}

document.getElementById("swiss-generate")?.addEventListener("click", () => {
  const textarea = document.getElementById("swiss-names");
  if (!textarea) return;
  const namesText = textarea.value;
  showTournamentModePopup((mode, tournamentName) => {
    const next = mode === "single-elim"
      ? generateSingleElimFromText(namesText, tournamentName)
      : generateSwissFromText(namesText, tournamentName);
    if (!next) return;
    startTournamentFromState(next);
  });
});

function joinSwissByCode(code, { onStatus } = {}) {
  const setStatus = msg => { if (typeof onStatus === "function") onStatus(msg); };
  if (!code) return;
  if (!firebaseReady()) {
    setStatus("Live sync isn't configured on this build.");
    return;
  }
  setStatus("Looking up room…");
  resolveRoomCode(code, result => {
    if (!result.ok) {
      setStatus(result.reason || "Failed to connect.");
      return;
    }
    // Fresh join — remote owns the view, clear any stale local state.
    localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
    const asHost = isRoomHosted(result.editCode);
    const canEdit = asHost || result.role === "edit";
    const connected = connectSwissRoom(result.editCode, result.viewCode, asHost, canEdit);
    if (!connected.ok) {
      setStatus(connected.reason || "Failed to connect.");
      return;
    }
    const label = asHost ? "host" : (canEdit ? "co-host" : "participant");
    setStatus(`Joined as ${label}.`);
    renderSwiss();
  });
}

document.getElementById("swiss-join")?.addEventListener("click", () => {
  const input = document.getElementById("swiss-join-code");
  const status = document.getElementById("swiss-join-status");
  if (!input) return;
  const code = (input.value || "").trim().toUpperCase();
  joinSwissByCode(code, {
    onStatus: msg => { if (status) status.textContent = msg; }
  });
});

function fetchTournamentState(code, cb) {
  const db = initFirebase();
  if (!db) { cb(null); return; }
  const lookup = key =>
    db.ref("swissRooms/" + key).once("value").then(snap => snap.val());
  lookup(code).then(val => {
    if (val && (val.groups || (val.matches && Object.keys(val.matches).length > 0))) {
      cb(val);
      return;
    }
    // Not an edit code (or empty). Try resolving as a view code.
    db.ref("swissViewCodes/" + code).once("value").then(vSnap => {
      const editCode = vSnap.val();
      if (!editCode) { cb(null); return; }
      lookup(editCode).then(cb).catch(() => cb(null));
    }).catch(() => cb(null));
  }).catch(() => cb(null));
}

function placementLabel(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

function computeTournamentPlacements(state) {
  const matches = state?.matches || {};
  const matchResult = m => {
    if (!m || m.scoreA == null || m.scoreB == null || m.scoreA === m.scoreB) return null;
    const aWon = m.scoreA > m.scoreB;
    return { winner: aWon ? m.a : m.b, loser: aWon ? m.b : m.a };
  };
  const placements = [];
  const f = matchResult(matches["bracket-f-0"]);
  if (f) {
    placements.push({ place: 1, name: f.winner });
    placements.push({ place: 2, name: f.loser });
  }
  const third = matchResult(matches["bracket-3rd-0"]);
  if (third) {
    placements.push({ place: 3, name: third.winner });
    placements.push({ place: 4, name: third.loser });
  }
  if (state?.mode === "swiss") {
    const fifth = matchResult(matches["bracket-5th-0"]);
    if (fifth) {
      placements.push({ place: 5, name: fifth.winner });
      placements.push({ place: 6, name: fifth.loser });
    }
    const seventh = matchResult(matches["bracket-7th-0"]);
    if (seventh) {
      placements.push({ place: 7, name: seventh.winner });
      placements.push({ place: 8, name: seventh.loser });
    }
  }
  return placements;
}

function renderTournamentResultsMarkup(state) {
  const name = state.tournamentName && state.tournamentName.trim()
    ? escapeHtml(state.tournamentName)
    : "(unnamed tournament)";
  const modeLabel = state.mode === "single-elim" ? "Single Elimination" : "Swiss + Top 8";
  const header = `
    <div class="tournament-results-heading">
      <div class="tournament-results-name">${name}</div>
      <div class="tournament-results-mode">${escapeHtml(modeLabel)}</div>
    </div>
  `;
  const placements = computeTournamentPlacements(state);
  if (!placements.length) {
    return header + `<p class="tournament-results-empty">This tournament hasn't reached the knockout placements yet — come back when the bracket finishes.</p>`;
  }
  const rows = placements.map(p => `
    <div class="tournament-results-row tournament-results-place-${p.place}">
      <span class="tournament-results-place">${placementLabel(p.place)}</span>
      <span class="tournament-results-player">${escapeHtml(p.name || "—")}</span>
    </div>
  `).join("");
  return header + `<div class="tournament-results-list">${rows}</div>`;
}

function showTournamentResultsFromHistory(code) {
  const popup = document.getElementById("tournament-results-popup");
  const body = document.getElementById("tournament-results-body");
  if (!popup || !body) return;
  body.innerHTML = `<p class="tournament-results-loading">Loading results…</p>`;
  popup.classList.remove("hidden");
  if (!firebaseReady()) {
    body.innerHTML = `<p class="tournament-results-empty">Live sync isn't configured on this build, so results can't be fetched.</p>`;
    return;
  }
  fetchTournamentState(code.toUpperCase(), state => {
    if (!state) {
      body.innerHTML = `<p class="tournament-results-empty">Couldn't find this tournament. It may have been cleared.</p>`;
      return;
    }
    body.innerHTML = renderTournamentResultsMarkup(state);
  });
}

(function initTournamentResultsPopup() {
  const popup = document.getElementById("tournament-results-popup");
  if (!popup) return;
  const close = () => popup.classList.add("hidden");
  popup.querySelector("#tournament-results-close")?.addEventListener("click", close);
  popup.addEventListener("click", e => {
    if (e.target === popup) close();
  });
})();

document.getElementById("swiss-reset")?.addEventListener("click", resetSwiss);

// Re-join a previously connected room on page load.
window.addEventListener("load", initSwissRoomOnLoad);

// Rotating the device (especially through the scoreboard's fullscreen flow)
// can reset the rounds-scroll containers back to scrollLeft 0. Re-apply the
// stored scroll positions after a brief settle so the user stays on the
// round they were viewing.
function restoreSwissScrollPositions() {
  const view = document.getElementById("swiss-view");
  if (!view) return;
  // Snap every rounds strip to the target column computed from current state
  // (rightmost for group strips; the current bracket phase for Swiss top-8).
  const state = loadSwiss();
  view.querySelectorAll(".swiss-rounds-scroll").forEach((el, i) => {
    el.scrollLeft = computeSwissRoundsScrollTarget(el, state);
    swissScrollPositions[i] = el.scrollLeft;
  });
}
function scheduleSwissScrollRestore() {
  [50, 200, 500, 900].forEach(delay => setTimeout(restoreSwissScrollPositions, delay));
}
if (screen.orientation && typeof screen.orientation.addEventListener === "function") {
  screen.orientation.addEventListener("change", scheduleSwissScrollRestore);
} else {
  window.addEventListener("orientationchange", scheduleSwissScrollRestore);
}
document.addEventListener("fullscreenchange", scheduleSwissScrollRestore);
document.addEventListener("webkitfullscreenchange", scheduleSwissScrollRestore);
