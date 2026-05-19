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
let swissSetupWasVisible = false; // tracks setup-form visibility so we only re-fetch open rooms on the hidden→visible edge
let swissSubHosts = {};      // room's designated sub-host usernames { lowercaseKey: casedName }

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
  swissSubHosts = {};
  swissLiveMatchId = null;
  saveJoinedRoom(null);
  // Drop any match-linked state on the scoreboard so leaving a room doesn't
  // leave stale match names / score / save callback on the overlay.
  if (typeof window.resetScoreboardToDefault === "function") {
    window.resetScoreboardToDefault();
  }
}

// Strip metadata fields (viewCode, subHosts) before persisting remote state
// locally — they aren't part of the tournament model and shouldn't land in
// loadSwiss.
function stripRoomMetadata(remote) {
  if (!remote) return remote;
  const { viewCode, subHosts, ...state } = remote;
  return state;
}

// Normalise a username to a Firebase-safe key for the sub-host map.
function subHostKey(name) {
  return String(name || "").trim().toLowerCase().replace(/[.#$/[\]]/g, "_");
}

// True when the signed-in account's username is on this room's sub-host list.
function isCurrentUserSubHost() {
  const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  const key = subHostKey(uname);
  return !!(key && swissSubHosts && swissSubHosts[key]);
}

// Co-host (edit) access goes to the host and to any signed-in user whose
// username the host added to the room's sub-host list.
function recomputeSwissCanEdit() {
  swissCanEdit = swissIsHost || isCurrentUserSubHost();
}

// The signed-in profile can load after the room — re-evaluate sub-host
// access (a user may newly match, or stop matching, the list) and re-render.
window.addEventListener("userprofilechange", () => {
  if (!swissRoomRef) return;
  recomputeSwissCanEdit();
  if (typeof renderSwiss === "function") renderSwiss();
});

function resolveRoomCode(code, cb) {
  const db = initFirebase();
  if (!db) { cb({ ok: false, reason: "Live sync isn't configured on this build." }); return; }
  db.ref("swissRooms/" + code).once("value").then(editSnap => {
    const remote = editSnap.val();
    const populated = !!(remote && (remote.groups || (remote.matches && Object.keys(remote.matches).length > 0) || remote.phase === "registering"));
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

function connectSwissRoom(editCode, viewCode, asHost, canEdit, roleHint) {
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
  const isPopulatedRemote = (r) => !!(r && (r.groups || (r.matches && Object.keys(r.matches).length > 0) || r.phase === "registering"));
  const isPopulatedLocal = (s) => !!(s && (s.groups || (s.matches && Object.keys(s.matches).length > 0) || s.phase === "registering"));

  // Role hint lets callers (e.g. submitRegistration's lobby path) tag
  // this session as "participant" so the History tab can distinguish
  // self-registered players from plain viewers. Without a hint we
  // fall back to the canEdit/asHost flags.
  const role = roleHint || (asHost ? "host" : (canEdit ? "co-host" : "view"));
  const isViewer = role === "view" || role === "participant";
  const localNow = loadSwiss();
  saveTournamentHistoryEntry({
    editCode: isViewer ? null : editCode,
    viewCode: swissViewCode || null,
    name: localNow?.tournamentName || "",
    mode: localNow?.mode || null,
    role,
    createdAt: new Date().toISOString()
  });

  // Tracks whether this connection has ever seen the room populated. Lets the
  // listener tell "the room was just deleted" (follow it) apart from "the room
  // doesn't exist yet" (first-time creation — push it).
  let roomEverPopulated = false;
  swissRoomRef.on("value", snap => {
    const remote = snap.val();
    if (isPopulatedRemote(remote)) {
      roomEverPopulated = true;
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
      // Pick up the room's sub-host list and (re)grant co-host access to any
      // signed-in user whose username the host listed.
      swissSubHosts = remote.subHosts || {};
      recomputeSwissCanEdit();
      renderSwiss();
      syncTournamentRankingAwards(remote);
      // Keep the lobby entry alive for BOTH registering and running rooms.
      // Re-publishing on every host sync means a started tournament that
      // failed to publish on Start — or got dropped by a stale lobby
      // refresh — is restored on the next update, so it never vanishes from
      // the Open Tournaments list while the host stays connected.
      if (swissIsHost && (remote.phase === "registering" || remote.phase === "running")) {
        publishOpenRoomIndex(editCode, remote);
      }
    } else if (!remote && roomEverPopulated) {
      // The room was deleted on another device (a host reset / closed it).
      // Every other connected device — host, co-host or viewer — follows:
      // drop the dead room and fall back to the tournament landing page
      // (setup form + Open Tournaments list). Without this, a second host
      // device would hit the branch below and resurrect the room.
      swissApplyingRemote = true;
      localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
      swissApplyingRemote = false;
      disconnectSwissRoom();
      renderSwiss();
    } else if (!remote && swissIsHost) {
      // First-time creation: the room doesn't exist yet. Push our local state
      // with the viewCode metadata and publish the viewer mapping.
      const local = loadSwiss();
      if (isPopulatedLocal(local) && swissViewCode) {
        swissApplyingRemote = true;
        const payload = { ...local, viewCode: swissViewCode };
        swissRoomRef.set(payload)
          .then(() => db.ref("swissViewCodes/" + swissViewCode).set(editCode))
          .then(() => {
            if (local.phase === "registering") publishOpenRoomIndex(editCode, local);
          })
          .catch(e => console.warn("Initial room push failed:", e))
          .finally(() => { swissApplyingRemote = false; });
      }
    } else if (!remote) {
      // Non-host connected to a code with no room yet — clear any stale view.
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

// Public lobby index. Hosts publish a small summary record at
// `openTournaments/{editCode}` while a room is in the "registering" OR
// "running" phase so the Open Tournaments list can show both; a running
// tournament stays listed (viewers/co-hosts can still join) and the entry
// is removed only when the host resets / closes the room.
//
// We DON'T arm a Firebase onDisconnect().remove() handler. Mobile browsers
// suspend the WebSocket when the app is backgrounded (e.g. host opens
// YouTube), which would fire that handler and yank the room from the
// lobby — participants viewing the lobby in that window can't register.
// Instead we rely on:
//   * explicit removal on Reset, and
//   * reactive stale-pruning in refreshOpenTournamentRooms (drops entries
//     whose underlying swissRoom phase is neither registering nor running).
// Truly abandoned rooms (host force-closed without resetting) will linger
// in the lobby until the next refresh prunes them.

function publishOpenRoomIndex(editCode, state) {
  const db = initFirebase();
  if (!db || !editCode || !state) return;
  // `pairing` is deliberately NOT stored here — the lobby reads it live from
  // the room when it needs the label, so this summary stays within whatever
  // field whitelist the DB rules enforce (no rules change needed per field).
  const summary = {
    editCode,
    viewCode: swissViewCode || null,
    name: state.tournamentName || "",
    mode: state.mode || "swiss",
    roundCount: state.roundCount || null,
    groupCount: state.groupCount || null,
    registrantCount: Object.keys(state.registrants || {}).length,
    createdAt: state.createdAt || new Date().toISOString(),
    hostUid: state.hostUid || null
  };
  db.ref("openTournaments/" + editCode).set(summary)
    .catch(e => console.warn("Open room index push failed:", e));
}

function removeOpenRoomIndex(editCode) {
  const db = initFirebase();
  if (!db || !editCode) return;
  db.ref("openTournaments/" + editCode).set(null)
    .catch(e => console.warn("Open room index remove failed:", e));
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
const SWISS_GROUP_COUNT_DEFAULT = 4; // legacy fallback when state.groupCount is missing
const SWISS_GROUP_OPTIONS = [2, 3, 4];  // selectable group counts. 2 and 4 feed a clean Top-8; 3 works for Swiss-only (the Top-8 generator skips uneven group counts).
const SWISS_ROUND_COUNT = 4; // default / legacy fallback; actual count lives on state.roundCount
const SWISS_ROUND_OPTIONS = [3, 4, 5];
const SWISS_MIN_PER_GROUP = 2; // minimum so every group can run at least one match per round
const SWISS_BRACKET_SIZE = 8;  // Top-8 bracket; top-N per group derives from groupCount

function getRoundCount(state) {
  // Round robin derives its round count from group size, not a stored setting.
  if (state && state.pairing === "round-robin"
      && Array.isArray(state.groups) && state.groups.length) {
    return Math.max(1, ...state.groups.map(g => roundRobinRoundCount((g || []).length)));
  }
  const n = state && Number(state.roundCount);
  return SWISS_ROUND_OPTIONS.includes(n) ? n : SWISS_ROUND_COUNT;
}

function getGroupCount(state) {
  const n = state && Number(state.groupCount);
  if (SWISS_GROUP_OPTIONS.includes(n)) return n;
  // Old states won't carry groupCount — infer from the actual groups array,
  // and fall back to the legacy default when the tournament hasn't been
  // generated yet.
  if (state && Array.isArray(state.groups) && state.groups.length > 0) {
    return state.groups.length;
  }
  return SWISS_GROUP_COUNT_DEFAULT;
}

// Human-readable format label. Round robin reuses the swiss / swiss-only mode
// keys plus a `pairing: "round-robin"` flag, so the label keys off both.
// `shortElim` picks the compact "Single Elim" for room cards.
function tournamentFormatLabel(mode, pairing, shortElim) {
  if (mode === "single-elim") return shortElim ? "Single Elim" : "Single Elimination";
  const base = pairing === "round-robin" ? "Round Robin" : "Swiss";
  return mode === "swiss-only" ? base : base + " + Top 8";
}

// Registration-phase helpers. A tournament with `phase: "registering"` is
// open to self-signups via the Room tab; once the host clicks Start the
// phase flips to "running" and the existing generators take over.
function isRegisteringPhase(state) {
  return !!(state && state.phase === "registering");
}

function generateRegistrantId() {
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function listRegistrants(state) {
  const reg = (state && state.registrants) || {};
  return Object.entries(reg).map(([id, r]) => ({
    id,
    name: (r && r.name) || "",
    deck: normalizeBeyCheckDeck(r && r.deck)
  }));
}

function findRegistrantByName(state, name) {
  if (!state || !state.registrants || !name) return null;
  const target = String(name).trim().toLowerCase();
  if (!target) return null;
  for (const [id, r] of Object.entries(state.registrants)) {
    if (r && typeof r.name === "string" && r.name.trim().toLowerCase() === target) {
      return { id, ...r };
    }
  }
  return null;
}

// Pull a participant's authoritative deck from the registrants map. Used by
// the Bey Check popup to pre-fill matches with what the player registered
// rather than re-asking the judge each round.
function getRegisteredDeckForParticipant(state, name) {
  const r = findRegistrantByName(state, name);
  if (!r) return null;
  const deck = normalizeBeyCheckDeck(r.deck);
  return isBeyCheckDeckEmpty(deck) ? null : deck;
}

function loadSwiss() {
  try {
    const raw = JSON.parse(localStorage.getItem(SWISS_KEY) || "null");
    const hasGroups = raw && Array.isArray(raw.groups);
    const hasMatches = raw && raw.matches && Object.keys(raw.matches).length > 0;
    const isRegistering = raw && raw.phase === "registering";
    if (raw && (hasGroups || hasMatches || raw.mode === "single-elim" || isRegistering)) {
      if (!raw.matches) raw.matches = {};
      // Migrate legacy global `roundsGenerated` into the per-group array.
      if (!Array.isArray(raw.groupRounds)) {
        const fill = typeof raw.roundsGenerated === "number" ? raw.roundsGenerated : 0;
        raw.groupRounds = hasGroups ? raw.groups.map(() => fill) : [];
      }
      // Pre-registration fields. Older states default to "running" so anything
      // already in flight keeps its current behaviour without migration.
      if (!raw.phase) raw.phase = "running";
      if (!raw.registrants || typeof raw.registrants !== "object") raw.registrants = {};
      return raw;
    }
  } catch (e) {}
  return { groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} };
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

  // Pair the (now even) queue while minimizing rematches. A simple greedy
  // pass — pair the top of the queue with the first unplayed opponent —
  // can force avoidable rematches downstream (e.g. queue [A,B,C,D,E,F]
  // with A-B, C-D, E-F already played: greedy pairs A-C and B-D, then
  // strands E vs F as a rematch when A-C/B-E/D-F was achievable). The
  // search below picks the pairing with the fewest rematches; ties are
  // broken in favour of opponents earlier in the standings-sorted queue,
  // so the top of the table still meets the closest-ranked opponent it
  // hasn't faced.
  solveSwissPairing(queue, played).forEach(p => {
    pairs.push({ a: p.a, b: p.b, bye: false });
  });

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

// Backtracking search over partner choices for the front of the queue.
// Realistic Swiss group sizes here cap well below the point where the
// search explodes (T(8) = 105 leaves, T(14) ≈ 135K — both fine in JS),
// and we early-out the moment we hit a zero-rematch full pairing. For
// pathologically large groups we fall back to the original greedy.
function solveSwissPairing(queue, played) {
  if (queue.length <= 1) return [];
  if (queue.length > 14) return greedySwissPairing(queue, played);

  function search(remaining) {
    if (remaining.length === 0) return { pairs: [], rematches: 0 };
    const a = remaining[0];
    const rest = remaining.slice(1);
    let best = null;
    for (let i = 0; i < rest.length; i++) {
      const b = rest[i];
      const cost = played.has(pairKey(a, b)) ? 1 : 0;
      const nextRest = rest.slice(0, i).concat(rest.slice(i + 1));
      const sub = search(nextRest);
      const total = cost + sub.rematches;
      if (best === null || total < best.rematches) {
        best = { pairs: [{ a, b }, ...sub.pairs], rematches: total };
        if (total === 0) break;
      }
    }
    return best;
  }

  return search(queue).pairs;
}

function greedySwissPairing(queue, played) {
  const remaining = queue.slice();
  const pairs = [];
  while (remaining.length >= 2) {
    const a = remaining.shift();
    let partnerIdx = -1;
    for (let i = 0; i < remaining.length; i++) {
      if (!played.has(pairKey(a, remaining[i]))) { partnerIdx = i; break; }
    }
    if (partnerIdx === -1) partnerIdx = 0;
    const b = remaining.splice(partnerIdx, 1)[0];
    pairs.push({ a, b });
  }
  return pairs;
}

// --- Round-robin scheduling (circle method) ---
// A round robin pairs everyone in a group against everyone else exactly once:
// N players → N-1 rounds (N even) or N rounds (N odd, one bye each round).
function roundRobinRoundCount(n) {
  if (n < 2) return 0;
  return n % 2 === 0 ? n - 1 : n;
}

// Full schedule as an array of rounds; each round is an array of [a, b] pairs.
// A null in a pair marks the bye that an odd group size forces each round.
function roundRobinSchedule(members) {
  const arr = members.slice();
  if (arr.length % 2 === 1) arr.push(null); // bye marker
  const n = arr.length;
  if (n < 2) return [];
  const fixed = arr[0];
  let rest = arr.slice(1);
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const row = [fixed].concat(rest);
    const pairs = [];
    for (let i = 0; i < n / 2; i++) pairs.push([row[i], row[n - 1 - i]]);
    rounds.push(pairs);
    // Rotate everything except the fixed player one step.
    rest = [rest[rest.length - 1]].concat(rest.slice(0, rest.length - 1));
  }
  return rounds;
}

function appendGroupRound(state, groupIndex) {
  const members = state.groups[groupIndex];
  const roundIndex = state.groupRounds[groupIndex] || 0;
  // Round robin: pull this round straight from the fixed circle-method
  // schedule. Its length is the cap — appending stops when it's exhausted.
  if (state.pairing === "round-robin") {
    const schedule = roundRobinSchedule(members);
    if (roundIndex >= schedule.length) return false;
    schedule[roundIndex].forEach((pair, i) => {
      const [a, b] = pair;
      const bye = a == null || b == null;
      const id = `g${groupIndex}-r${roundIndex}-m${i}`;
      state.matches[id] = {
        id, groupIndex, round: roundIndex,
        a: bye ? (a || b) : a,
        b: bye ? null : b,
        scoreA: null, scoreB: null, bye
      };
    });
    state.groupRounds[groupIndex] = roundIndex + 1;
    return true;
  }
  if (roundIndex >= getRoundCount(state)) return false;
  const ordered = roundIndex === 0
    ? shuffleArray(members)
    : computeStandings(members, state.matches, groupIndex, state.pairing === "round-robin").map(r => r.name);
  const matchObjs = pairSwissRound(ordered, state.matches, groupIndex, roundIndex);
  matchObjs.forEach(m => { state.matches[m.id] = m; });
  state.groupRounds[groupIndex] = roundIndex + 1;
  return true;
}

// Swiss pairs best with even-sized groups (odd-sized groups force a BYE each
// round). Even totals always rebalance to all-even groups; odd totals leave
// exactly one unavoidable odd group.
function balanceSwissGroups(groups) {
  const oddIndices = [];
  groups.forEach((g, i) => { if (g.length % 2 === 1) oddIndices.push(i); });
  while (oddIndices.length >= 2) {
    const iA = oddIndices.shift();
    const iB = oddIndices.shift();
    const [fromIdx, toIdx] = groups[iA].length >= groups[iB].length ? [iA, iB] : [iB, iA];
    if (groups[fromIdx].length > 0) {
      groups[toIdx].push(groups[fromIdx].pop());
    }
  }
}

function generateSwissFromText(text, tournamentName, roundCount, groupCount, pairing) {
  const names = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const seen = new Set();
  const unique = [];
  names.forEach(n => { if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); unique.push(n); } });

  const gc = SWISS_GROUP_OPTIONS.includes(Number(groupCount))
    ? Number(groupCount)
    : SWISS_GROUP_COUNT_DEFAULT;

  const minTotal = gc * SWISS_MIN_PER_GROUP;
  if (unique.length < minTotal) {
    alert(`Need at least ${minTotal} participants (${SWISS_MIN_PER_GROUP} per group × ${gc} groups).`);
    return null;
  }
  // The Top-8 bracket needs at least one feeder per slot (top-N per group),
  // so the smaller-group config (2 groups → top 4 each) requires more
  // participants per group up front.
  const minPerGroupForBracket = Math.ceil(SWISS_BRACKET_SIZE / gc);
  if (unique.length < gc * minPerGroupForBracket) {
    alert(`Need at least ${gc * minPerGroupForBracket} participants for ${gc} groups (top ${minPerGroupForBracket} from each feed the Top-8 bracket).`);
    return null;
  }

  const shuffled = shuffleArray(unique);
  const groups = Array.from({ length: gc }, () => []);
  shuffled.forEach((name, i) => { groups[i % gc].push(name); });
  balanceSwissGroups(groups);

  const rc = SWISS_ROUND_OPTIONS.includes(Number(roundCount)) ? Number(roundCount) : SWISS_ROUND_COUNT;
  const state = {
    groups,
    matches: {},
    groupRounds: groups.map(() => 0),
    mode: "swiss",
    participants: unique,
    tournamentName: (tournamentName || "").trim() || null,
    roundCount: rc,
    groupCount: gc
  };
  // Round robin reuses the whole Swiss group/standings/bracket machinery —
  // only the per-round pairing differs (everyone-vs-everyone, see
  // appendGroupRound). `pairing` must be set before the first round appends.
  if (pairing === "round-robin") state.pairing = "round-robin";
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
    // Top-8: QF losers feed two consolation QFs which in turn feed the
    // 5th- and 7th-place matches. Mirrors Swiss + Top 8. Requires a real
    // QF round (bracketSize ≥ 8 → preFinalRounds ≥ 2).
    if (preFinalRounds >= 2) {
      state.matches["bracket-cqf-0"] = emptyBracketMatch("cqf", 0);
      state.matches["bracket-cqf-1"] = emptyBracketMatch("cqf", 1);
      state.matches["bracket-5th-0"] = emptyBracketMatch("5th", 0);
      state.matches["bracket-7th-0"] = emptyBracketMatch("7th", 0);
    }
  }

  autoAdvanceByes(state);
  return state;
}

// Returns the match id whose winner OR loser feeds the given slot, or null
// if this slot has no upstream match (R0 slots, or the final in a 2-player
// bracket). The winner-vs-loser distinction doesn't matter to the callers
// (phantom detection and the auto-advance live-upstream check) — they only
// care whether *something* live still feeds the slot.
function bracketUpstreamSource(round, bracketIndex, slot, state) {
  if (typeof round === "number") {
    if (round === 0) return null;
    const j = slot === "a" ? bracketIndex * 2 : bracketIndex * 2 + 1;
    return `bracket-r${round - 1}-${j}`;
  }
  const matches = (state && state.matches) || {};
  // Swiss top-8 bracket: QF is the leaf, SF/CQF feed off QF, F/3rd feed off
  // SF, 5th/7th feed off CQF. Slot parity inside each downstream match
  // mirrors bracketIndex parity (see getBracketPropagation).
  if (matches["bracket-qf-0"]) {
    if (round === "sf" || round === "cqf") {
      const j = bracketIndex * 2 + (slot === "a" ? 0 : 1);
      return `bracket-qf-${j}`;
    }
    if (round === "f" || round === "3rd") {
      return `bracket-sf-${slot === "a" ? 0 : 1}`;
    }
    if (round === "5th" || round === "7th") {
      return `bracket-cqf-${slot === "a" ? 0 : 1}`;
    }
    return null;
  }
  // Single-elim placement rounds — fed by the last numeric round, except
  // CQF which is fed by the QF round (preFinal-2) loser side.
  const preFinal = state && typeof state.preFinalRounds === "number" ? state.preFinalRounds : 0;
  if (round === "f" || round === "3rd") {
    if (preFinal === 0) return null;
    const j = slot === "a" ? 0 : 1;
    return `bracket-r${preFinal - 1}-${j}`;
  }
  if (round === "cqf") {
    if (preFinal < 2) return null;
    const j = bracketIndex * 2 + (slot === "a" ? 0 : 1);
    return `bracket-r${preFinal - 2}-${j}`;
  }
  if (round === "5th" || round === "7th") {
    return `bracket-cqf-${slot === "a" ? 0 : 1}`;
  }
  return null;
}

// A match is "phantom" if no upstream path can ever deliver a player to it.
// Leaves (R0, or a 2-player final) are phantom iff both slots start null;
// a non-leaf match is phantom iff both its upstream sources are phantom.
function computeBracketPhantoms(state) {
  const phantoms = new Set();
  const entries = Object.entries(state.matches || {}).filter(([, m]) => m && m.bracket);
  let changed = true;
  while (changed) {
    changed = false;
    entries.forEach(([id, m]) => {
      if (phantoms.has(id)) return;
      const aSrc = bracketUpstreamSource(m.round, m.bracketIndex, "a", state);
      const bSrc = bracketUpstreamSource(m.round, m.bracketIndex, "b", state);
      const aDead = aSrc == null
        ? !(m.a != null && m.a !== "")
        : phantoms.has(aSrc);
      const bDead = bSrc == null
        ? !(m.b != null && m.b !== "")
        : phantoms.has(bSrc);
      if (aDead && bDead) {
        phantoms.add(id);
        changed = true;
      }
    });
  }
  return phantoms;
}

// Walk the bracket and auto-score any match where one slot is a BYE (null).
// Propagates the non-null player up the bracket. Runs to a fixed point so
// cascading byes (BYE → BYE → real match) are all handled in one pass.
// A half-filled match only auto-advances when the empty side's upstream is
// *phantom* (no live match feeds it) — otherwise we wait for that upstream
// match to be scored so its winner can fill the slot properly.
//
// If `updates` is provided, each mutated leaf path is recorded there so the
// caller can sync the diff to Firebase (used by the live-scoring path).
function autoAdvanceByes(state, updates) {
  const phantoms = computeBracketPhantoms(state);
  let changed = true;
  let iter = 0;
  while (changed && iter < 100) {
    changed = false;
    Object.entries(state.matches).forEach(([id, m]) => {
      if (!m.bracket || phantoms.has(id)) return;
      if (m.scoreA != null || m.scoreB != null) return;
      const hasA = m.a != null && m.a !== "";
      const hasB = m.b != null && m.b !== "";
      if (hasA === hasB) return; // both filled or both empty — skip
      const emptySlot = hasA ? "b" : "a";
      const emptySrc = bracketUpstreamSource(m.round, m.bracketIndex, emptySlot, state);
      if (emptySrc && !phantoms.has(emptySrc)) {
        // Live upstream — but if it's already a bye AND we're its loser-feed
        // (e.g. 3rd-place fed by a bye SF), the source has no loser to deliver
        // and this slot is effectively dead. Otherwise wait for it to score.
        const upstream = state.matches[emptySrc];
        const upstreamProp = upstream && getBracketPropagation(upstream.round, upstream.bracketIndex, state);
        const isLoserFeed = !!(upstreamProp && upstreamProp.loser
          && upstreamProp.loser.toId === id
          && upstreamProp.loser.slot === emptySlot);
        if (!(upstream && upstream.bye && isLoserFeed)) return;
      }
      m.bye = true;
      if (hasA) { m.scoreA = 1; m.scoreB = 0; }
      else       { m.scoreA = 0; m.scoreB = 1; }
      if (updates) {
        updates[`matches/${id}/bye`] = true;
        updates[`matches/${id}/scoreA`] = m.scoreA;
        updates[`matches/${id}/scoreB`] = m.scoreB;
      }
      const prop = getBracketPropagation(m.round, m.bracketIndex, state);
      if (prop && prop.winner) {
        const winner = hasA ? m.a : m.b;
        const target = state.matches[prop.winner.toId];
        if (target) {
          target[prop.winner.slot] = winner;
          if (updates) updates[`matches/${prop.winner.toId}/${prop.winner.slot}`] = winner;
        }
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
  const hasAny = state.groups || Object.keys(state.matches || {}).length > 0 || isRegisteringPhase(state);
  const inRoom = !!swissEditCode;
  // The dialog only describes the live room being torn down. Past
  // tournament history entries (Tournament History tab) are stored
  // separately and never touched by reset.
  let promptMsg;
  if (inRoom && !swissIsHost) {
    promptMsg = "Leave this live room?";
  } else if (isRegisteringPhase(state)) {
    promptMsg = "Cancel this tournament and close registration? Past tournaments in your history won't be affected.";
  } else {
    promptMsg = "Reset this live tournament? The room (groups, matches, scores) will be cleared. Past tournaments in your history won't be affected.";
  }
  if ((hasAny || inRoom) && !confirm(promptMsg)) return;

  // Capture codes BEFORE disconnecting (disconnectSwissRoom clears them).
  const wasHost = swissIsHost;
  const codeForRemote = swissEditCode;
  const viewCodeForRemote = swissViewCode;
  const dbHandle = swissDb;

  // Snapshot the live state into the history entry before we wipe the
  // remote. Past tournaments in the Tournament History tab become
  // viewable offline this way — clicking the entry shows the cached
  // placements / standings even though the Firebase room is gone.
  if (wasHost && codeForRemote) {
    cacheTournamentSnapshotInHistory(codeForRemote, state);
  }

  // Detach the listener and clear local state FIRST, then wipe remote.
  // Otherwise the host's own listener would fire on the wipe, see
  // `!remote && swissIsHost && isPopulatedLocal(local)`, and re-push the
  // room (re-publishing the lobby index) before our explicit remove
  // settles — the lobby entry would resurrect.
  disconnectSwissRoom();
  // Bypass push-on-persist by writing directly.
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));

  if (wasHost && codeForRemote && dbHandle) {
    try {
      dbHandle.ref("swissRooms/" + codeForRemote).set(null);
      if (viewCodeForRemote) dbHandle.ref("swissViewCodes/" + viewCodeForRemote).set(null);
      removeOpenRoomIndex(codeForRemote);
      if (state.hostUid) removeUserTournament(state.hostUid, codeForRemote);
    } catch (e) {}
  }

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
        if ((s.groupRounds[gi] || 0) < getRoundCount(s)) {
          const before = new Set(Object.keys(s.matches));
          appendGroupRound(s, gi);
          newMatchIds = Object.keys(s.matches).filter(k => !before.has(k));
        }
      }
    }

    // Auto-generate the top-8 knockout bracket the moment every group's
    // final round completes, so no one has to hunt for a "Start" button.
    // Only fires once — the hasSwissBracket guard makes this idempotent for
    // late edits that don't change group completion. Skipped for swiss-only
    // mode, which ends after the group stage with no knockout.
    if (s.mode !== "swiss-only" && !stored.bracket && isGroupStageComplete(s) && !hasSwissBracket(s)) {
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
      extraUpdates = {};
      if (prop) {
        let winner = null, loser = null;
        if (scoreA > scoreB) { winner = stored.a; loser = stored.b; }
        else if (scoreB > scoreA) { winner = stored.b; loser = stored.a; }
        if (prop.winner && s.matches[prop.winner.toId]) {
          s.matches[prop.winner.toId][prop.winner.slot] = winner;
          extraUpdates[`matches/${prop.winner.toId}/${prop.winner.slot}`] = winner;
        }
        if (prop.loser && s.matches[prop.loser.toId]) {
          s.matches[prop.loser.toId][prop.loser.slot] = loser;
          extraUpdates[`matches/${prop.loser.toId}/${prop.loser.slot}`] = loser;
        }
      }
      // After propagation, a downstream slot whose sibling upstream is a
      // phantom (BYE-vs-BYE) may now be a half-filled bye — auto-advance
      // it so the lone real player skips ahead. Cascades up the bracket.
      autoAdvanceByes(s, extraUpdates);
      if (Object.keys(extraUpdates).length === 0) extraUpdates = null;
    }

    persistSwiss(s);
    pushSwissMatchUpdate(matchId, stored, s, newMatchIds, extraUpdates);
    renderSwiss();
  }, isEdit ? match.scoreA : 0, isEdit ? match.scoreB : 0);
}

let swissGroupViews = {}; // gi -> "matches" | "standings"

function renderSwissMatchCard(matchNum, id, m, seedA, seedB, isRoundRobin) {
  const done = m.scoreA != null && m.scoreB != null;
  const live = !done && m.startedAt != null;
  const aWin = done && m.scoreA > m.scoreB;
  const bWin = done && m.scoreB > m.scoreA;
  const aScore = done ? m.scoreA : (live ? "…" : "");
  const bScore = done ? m.scoreB : (live ? "…" : "");

  if (m.bye) {
    // A Swiss bye is a free win ("W"); a round-robin bye is just a sit-out
    // this round — no win, since everyone still faces everyone else.
    const winCls = isRoundRobin ? "" : " swiss-match-row-win";
    const scoreCell = isRoundRobin
      ? `<span class="swiss-score-cell">&mdash;</span>`
      : `<span class="swiss-score-cell swiss-score-win">W</span>`;
    return `<div class="swiss-match-wrap">
      <div class="swiss-match-num">${matchNum}</div>
      <div class="swiss-match-card swiss-match-bye">
        <div class="swiss-match-row${winCls} swiss-match-row-bye">
          <span class="swiss-seed">${seedA}</span>
          <span class="swiss-name-cell">${escapeHtml(m.a)} <span class="swiss-bye-tag">BYE</span></span>
          ${scoreCell}
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
      renderSwissMatchCard(numberFor[id], id, m, seedOf(m.a), m.b ? seedOf(m.b) : "",
        state.pairing === "round-robin")
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

function renderSwissGroupStandings(state, gi, canEdit) {
  const members = state.groups[gi];
  const standings = computeStandings(members, state.matches, gi, state.pairing === "round-robin");
  const rows = standings.map((row, idx) => {
    const pd = row.pointsDiff > 0 ? `+${row.pointsDiff}` : `${row.pointsDiff}`;
    // Host / co-host can rename a participant straight from the standings,
    // even mid-tournament — the name cell becomes a tap-to-rename button.
    const nameCell = canEdit
      ? `<button type="button" class="swiss-name-cell swiss-name-edit" data-rename="${escapeHtml(row.name)}" title="Tap to rename">${escapeHtml(row.name)}</button>`
      : `<span class="swiss-name-cell">${escapeHtml(row.name)}</span>`;
    return `
    <li>
      <span class="swiss-rank">${idx + 1}</span>
      ${nameCell}
      <span class="swiss-record">${row.wins}W-${row.losses}L-${row.draws}D</span>
      <span class="swiss-tiebreak" title="Points Scored · Points Difference · Median-Buchholz">PS ${row.pointsScored} · PD ${pd} · MB ${row.medianBuchholz}</span>
    </li>
  `;
  }).join("");
  return `<ol class="swiss-members">${rows}</ol>`;
}

// Rename a participant everywhere their name appears — groups, the
// participant list, every match (group + bracket) and the registrants map.
// Match decks are keyed by side (a/b), not name, so they need no change.
// Works at any phase; pushes a targeted update so nothing else is clobbered.
function renameSwissParticipant(oldName, newName) {
  const s = loadSwiss();
  const updates = {};
  if (Array.isArray(s.participants)) {
    let changed = false;
    s.participants = s.participants.map(n => {
      if (n === oldName) { changed = true; return newName; }
      return n;
    });
    if (changed) updates.participants = s.participants;
  }
  if (Array.isArray(s.groups)) {
    s.groups.forEach((g, gi) => {
      let changed = false;
      const ng = g.map(n => {
        if (n === oldName) { changed = true; return newName; }
        return n;
      });
      if (changed) { s.groups[gi] = ng; updates[`groups/${gi}`] = ng; }
    });
  }
  Object.entries(s.matches || {}).forEach(([id, m]) => {
    if (!m) return;
    if (m.a === oldName) { m.a = newName; updates[`matches/${id}/a`] = newName; }
    if (m.b === oldName) { m.b = newName; updates[`matches/${id}/b`] = newName; }
  });
  if (s.registrants && typeof s.registrants === "object") {
    Object.entries(s.registrants).forEach(([id, r]) => {
      if (r && r.name === oldName) {
        r.name = newName;
        updates[`registrants/${id}/name`] = newName;
      }
    });
  }
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote && Object.keys(updates).length) {
    swissRoomRef.update(updates).catch(e => console.warn("Rename push failed:", e));
  }
  renderSwiss();
}

// Standings tap-to-rename entry point: prompt for the new name, reject blanks
// and case-insensitive clashes with another participant, then apply.
function promptRenameSwissParticipant(oldName) {
  if (!oldName) return;
  const raw = prompt(`Rename "${oldName}" to:`, oldName);
  if (raw == null) return; // cancelled
  const newName = raw.trim();
  if (!newName || newName === oldName) return;
  const taken = getParticipants(loadSwiss())
    .some(n => n !== oldName && n.toLowerCase() === newName.toLowerCase());
  if (taken) {
    alert(`"${newName}" is already a participant in this tournament.`);
    return;
  }
  renameSwissParticipant(oldName, newName);
}

// Change a running tournament's total round count — no reset. Raising it lets
// more rounds pair in; lowering it ends the group stage sooner. The floor is
// the most rounds any group has already generated, so no played/generated
// round is ever orphaned.
function setSwissRoundCount(newRc) {
  const s = loadSwiss();
  if (getRoundCount(s) === newRc) return;
  s.roundCount = newRc;
  const updates = { roundCount: newRc };
  // Raising the cap can re-open a finished group stage. The per-match
  // auto-append never fires when every match is already scored, so append the
  // next round now for any group sitting complete-but-below the new cap.
  if (Array.isArray(s.groups)) {
    s.groups.forEach((_, gi) => {
      const gen = s.groupRounds[gi] || 0;
      if (gen > 0 && gen < newRc && isGroupRoundComplete(s.matches, gi, gen - 1)) {
        const before = new Set(Object.keys(s.matches));
        if (appendGroupRound(s, gi)) {
          updates[`groupRounds/${gi}`] = s.groupRounds[gi];
          Object.keys(s.matches).forEach(id => {
            if (!before.has(id)) updates[`matches/${id}`] = s.matches[id];
          });
        }
      }
    });
  }
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    swissRoomRef.update(updates).catch(e => console.warn("Round count push failed:", e));
  }
  renderSwiss();
}

// Host entry point: reuse the round-count picker, then apply with no reset.
function showEditRoundCountPopup() {
  const s = loadSwiss();
  if (!Array.isArray(s.groups) || !s.groups.length) return;
  const maxGen = s.groups.reduce((m, _, gi) => Math.max(m, s.groupRounds[gi] || 0), 0);
  showSwissRoundsPopup(rc => {
    if (rc < maxGen) {
      alert(`A group has already played ${maxGen} rounds — the total can't be lower than that. Set it to ${maxGen} to end the group stage now.`);
      return;
    }
    setSwissRoundCount(rc);
  });
}

// Picks the scrollLeft target for a .swiss-rounds-scroll strip. Group strips
// always snap rightmost (show the newest round). Bracket strips advance
// column-by-column as each round finishes — for both the Swiss top-8
// bracket and the variable-size single-elimination bracket.
function computeSwissRoundsScrollTarget(scrollEl, state) {
  const isBracketStrip = !!scrollEl.closest(".swiss-bracket");
  if (!isBracketStrip || !state) return scrollEl.scrollWidth;

  if (state.mode === "single-elim") {
    return computeSingleElimScrollTarget(scrollEl, state);
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

function computeSingleElimScrollTarget(scrollEl, state) {
  const cols = scrollEl.querySelectorAll(".swiss-round-col");
  if (cols.length < 2) return scrollEl.scrollWidth;

  const preFinalRounds = typeof state.preFinalRounds === "number" ? state.preFinalRounds : 0;
  if (preFinalRounds === 0) return scrollEl.scrollWidth; // 2-player bracket — only the final column

  const phantoms = computeBracketPhantoms(state);
  const bracketEntries = Object.entries(state.matches || {}).filter(([, m]) => m && m.bracket);
  const roundDone = (round) => {
    const ms = bracketEntries.filter(([id, m]) => m.round === round && !phantoms.has(id));
    if (ms.length === 0) return true; // round has only phantoms — nothing to play, treat as done
    return ms.every(([, m]) => m.bye || (m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB));
  };

  // Scroll to the leftmost incomplete round; once all pre-final rounds are
  // done, snap to the rightmost column (Final + 3rd place).
  for (let r = 0; r < preFinalRounds; r++) {
    if (!roundDone(r)) {
      const col = cols[r];
      if (!col) return scrollEl.scrollWidth;
      const scrollRect = scrollEl.getBoundingClientRect();
      const colRect = col.getBoundingClientRect();
      return Math.max(0, scrollEl.scrollLeft + (colRect.left - scrollRect.left));
    }
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
  const fifthMatch = state.matches["bracket-5th-0"];
  const seventhMatch = state.matches["bracket-7th-0"];
  const cqf0 = state.matches["bracket-cqf-0"];
  const cqf1 = state.matches["bracket-cqf-1"];

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

  // Consolation column — only when the bracket has a quarterfinal round.
  if (cqf0 || cqf1) {
    const cqfCards = [];
    if (cqf0) cqfCards.push(renderSwissBracketCard("C1", "bracket-cqf-0", cqf0));
    if (cqf1) cqfCards.push(renderSwissBracketCard("C2", "bracket-cqf-1", cqf1));
    columnHtml.push(`
      <div class="swiss-round-col">
        <div class="swiss-round-title">Consolation</div>
        <div class="swiss-match-list">${cqfCards.join("")}</div>
      </div>
    `);
  }

  // Final column — Final, plus 3rd / 5th / 7th place matches when present.
  const finalColParts = [];
  finalColParts.push(`<div class="swiss-round-title">Final</div>`);
  finalColParts.push(`<div class="swiss-match-list">${finalMatch ? renderSwissBracketCard("F", "bracket-f-0", finalMatch) : ""}</div>`);
  if (thirdMatch) {
    finalColParts.push(`<div class="swiss-round-subtitle">3rd Place</div>`);
    finalColParts.push(`<div class="swiss-match-list">${renderSwissBracketCard("3rd", "bracket-3rd-0", thirdMatch)}</div>`);
  }
  if (fifthMatch) {
    finalColParts.push(`<div class="swiss-round-subtitle">5th Place</div>`);
    finalColParts.push(`<div class="swiss-match-list">${renderSwissBracketCard("5th", "bracket-5th-0", fifthMatch)}</div>`);
  }
  if (seventhMatch) {
    finalColParts.push(`<div class="swiss-round-subtitle">7th Place</div>`);
    finalColParts.push(`<div class="swiss-match-list">${renderSwissBracketCard("7th", "bracket-7th-0", seventhMatch)}</div>`);
  }
  columnHtml.push(`<div class="swiss-round-col">${finalColParts.join("")}</div>`);

  const topRankings = renderSwissTop8({
    final: finalMatch ? { id: "bracket-f-0", m: finalMatch } : null,
    third: thirdMatch ? { id: "bracket-3rd-0", m: thirdMatch } : null,
    fifth: fifthMatch ? { id: "bracket-5th-0", m: fifthMatch } : null,
    seventh: seventhMatch ? { id: "bracket-7th-0", m: seventhMatch } : null
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
  // The badge just identifies the role + signed-in user — no room code is
  // shown. Viewers/participants join via the Open Tournaments lobby and
  // co-hosts are granted by username, so there's no code to type or copy.
  if (swissCanEdit) {
    const label = swissIsHost ? "Host" : "Co-host";
    const prof = (typeof getUserProfile === "function") ? getUserProfile() : null;
    const uname = (prof && prof.username) ? prof.username : "";
    const namePill = uname ? `<button type="button" class="swiss-room-name swiss-profile-link" data-username="${escapeHtml(uname)}">${escapeHtml(uname)}</button>` : "";
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-edit">
        <span class="swiss-room-role">${label}</span>
        ${namePill}
      </span>
    `);
  }
  // Show the room's designated sub-hosts so the host and co-hosts can see who
  // has been granted co-host access for this room.
  const subNames = Object.keys(swissSubHosts || {})
    .map(k => swissSubHosts[k])
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)));
  if (swissCanEdit && subNames.length) {
    const subLinks = subNames.map(n =>
      `<button type="button" class="swiss-profile-link swiss-room-subname" data-username="${escapeHtml(n)}">${escapeHtml(n)}</button>`
    ).join(", ");
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-sub" title="Sub-hosts for this room">
        <span class="swiss-room-role">Sub-host${subNames.length > 1 ? "s" : ""}</span>
        <span class="swiss-room-subnames">${subLinks}</span>
      </span>
    `);
  }
  if (!pills.length) return "";
  return `<div class="swiss-room-badges">${pills.join("")}</div>`;
}

const STADIUM_OPTIONS = ["Xtreme", "Infinity", "Double Xtreme"];
const RULE_OPTIONS = ["Official", "Unofficial"];
const SHARE_TOURNAMENT_URL = "https://abu-mhn.github.io/XOptimizer/tournament/";
const SHARE_TOURNAMENT_INVITE = "To the bladers that are planning to join this event, please click the link below for registration.";
const SHARE_TOURNAMENT_INSTRUCTIONS = [
  "How to register as a Participant:",
  "1. Open the link below on your phone.",
  "2. Under \"Open Tournaments\", tap this tournament.",
  "3. Pick \"Participant\".",
  "4. Enter your name, then build your 3-slot deck — or open the Deck tab, tap Copy on a saved deck, and tap \"Paste from Deck tab\" in the register popup.",
  "5. Tap Register."
].join("\n");

function renderSwissShareButton() {
  return `<button type="button" id="swiss-share" class="btn btn-icon-sm swiss-share-btn" aria-label="Share tournament details" title="Share tournament details">
    <img src="assets/icons/share.png" alt="Share"
         onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21AA;');">
  </button>`;
}

// --- Sub-hosts: the host designates co-hosts by username. Anyone signed in
// with a listed username gets full co-host access — no host code needed. ---
function renderCoHostsButton() {
  return `<button type="button" id="swiss-cohosts" class="btn btn-icon-sm swiss-cohosts-btn" aria-label="Manage sub-hosts" title="Manage sub-hosts">` +
    `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>` +
    `</button>`;
}

function renderCoHostList() {
  const listEl = document.getElementById("cohost-list");
  if (!listEl) return;
  const keys = Object.keys(swissSubHosts || {});
  if (!keys.length) {
    listEl.innerHTML = `<p class="swiss-rooms-empty">No sub-hosts yet — add a username above.</p>`;
    return;
  }
  listEl.innerHTML = keys
    .sort((a, b) => String(swissSubHosts[a]).localeCompare(String(swissSubHosts[b])))
    .map(k => `<div class="cohost-row">
      <span class="cohost-row-name">${escapeHtml(swissSubHosts[k] || k)}</span>
      <button type="button" class="revox-row-btn revox-row-btn-delete" data-cohost-remove="${escapeHtml(k)}" title="Remove" aria-label="Remove">${REVOX_ICON_DELETE}</button>
    </div>`).join("");
  listEl.querySelectorAll("[data-cohost-remove]").forEach(btn => {
    btn.addEventListener("click", () => removeSubHost(btn.dataset.cohostRemove));
  });
}

function addSubHost(name) {
  const cleaned = String(name || "").trim().slice(0, 30);
  const key = subHostKey(cleaned);
  if (!key) return;
  swissSubHosts = swissSubHosts || {};
  swissSubHosts[key] = cleaned;
  if (swissRoomRef) {
    swissRoomRef.child("subHosts/" + key).set(cleaned)
      .catch(e => console.warn("Sub-host add failed:", e));
  }
  recomputeSwissCanEdit();
  renderCoHostList();
}

function removeSubHost(key) {
  if (!key) return;
  if (swissSubHosts) delete swissSubHosts[key];
  if (swissRoomRef) {
    swissRoomRef.child("subHosts/" + key).set(null)
      .catch(e => console.warn("Sub-host remove failed:", e));
  }
  recomputeSwissCanEdit();
  renderCoHostList();
}

// Registered usernames for the sub-host field's type-ahead. Loaded once when
// the popup opens; the dropdown is filled only as the host types (see
// updateCoHostUsernameOptions) so the whole list never shows on focus.
let coHostUsernamePool = [];

function loadCoHostUsernameList() {
  const db = initFirebase();
  if (!db) return;
  db.ref("usernames").once("value").then(snap => {
    const val = snap.val() || {};
    coHostUsernamePool = Object.keys(val)
      .map(k => (val[k] && val[k].username) || "")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    // If the host already typed something before the list arrived, refresh.
    const input = document.getElementById("cohost-username-input");
    if (input && input.value.trim()) updateCoHostUsernameOptions(input.value);
  }).catch(() => { coHostUsernamePool = []; });
}

// Custom type-ahead — a plain suggestion box (no native datalist, so no
// permanent dropdown arrow). Shown only while the host is typing.
function updateCoHostUsernameOptions(query) {
  const box = document.getElementById("cohost-suggest");
  if (!box) return;
  const input = document.getElementById("cohost-username-input");
  const q = String(query || "").trim().toLowerCase();
  const matches = q
    ? coHostUsernamePool.filter(n => n.toLowerCase().indexOf(q) >= 0).slice(0, 12)
    : [];
  if (!matches.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.innerHTML = matches
    .map(n => `<button type="button" class="cohost-suggest-item" data-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`)
    .join("");
  box.classList.remove("hidden");
  box.querySelectorAll(".cohost-suggest-item").forEach(btn => {
    btn.addEventListener("click", () => {
      if (input) input.value = btn.dataset.name || "";
      box.innerHTML = "";
      box.classList.add("hidden");
      input?.focus();
    });
  });
}

function showCoHostsPopup() {
  const popup = document.getElementById("tournament-cohosts-popup");
  if (!popup) return;
  const input = popup.querySelector("#cohost-username-input");
  const addBtn = popup.querySelector("#cohost-username-add");
  const closeBtn = popup.querySelector("#tournament-cohosts-close");
  if (input) input.value = "";
  renderCoHostList();
  // Start with the suggestion box hidden — it shows only as the host types.
  updateCoHostUsernameOptions("");
  loadCoHostUsernameList();
  popup.classList.remove("hidden");
  setTimeout(() => input?.focus(), 0);
  const submit = () => {
    const v = (input?.value || "").trim();
    if (!v) { input?.focus(); return; }
    addSubHost(v);
    if (input) { input.value = ""; input.focus(); }
    updateCoHostUsernameOptions("");
  };
  const close = () => {
    popup.classList.add("hidden");
    if (addBtn) addBtn.onclick = null;
    if (closeBtn) closeBtn.onclick = null;
    if (input) { input.onkeydown = null; input.oninput = null; }
    popup.onclick = null;
  };
  if (addBtn) addBtn.onclick = submit;
  if (closeBtn) closeBtn.onclick = close;
  if (input) input.oninput = () => updateCoHostUsernameOptions(input.value);
  if (input) input.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  popup.onclick = (e) => { if (e.target === popup) close(); };
}

// Compose the share message in the form:
//   [name]
//   Date: [date]
//   Time: [time]
//   Stadium: [stadium]
//   Rule: [rule]
//   Remark: [remark]
//
//   To the bladers ... please click the link below for registration.
//
//   How to register as a Participant:
//   1. ...
//   ...
//
//   https://abu-mhn.github.io/XOptimizer/tournament/
// Lines whose field is empty are omitted so the message stays clean.
function formatShareDate(value) {
  if (typeof value !== "string") return value || "";
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return value;
  const y = Number(m[1]), mo = Number(m[2]) - 1, day = Number(m[3]);
  const date = new Date(y, mo, day);
  if (isNaN(date.getTime())) return value;
  const months = ["January","February","March","April","May","June",
                  "July","August","September","October","November","December"];
  const weekdays = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  return `${day} ${months[mo]} ${y} (${weekdays[date.getDay()]})`;
}

function composeTournamentShareMessage(state, details) {
  const d = details || {};
  const name = (state?.tournamentName || "").trim() || "Tournament";
  const lines = [name];
  if (d.date)    lines.push(`Date: ${formatShareDate(d.date)}`);
  if (d.time)    lines.push(`Time: ${d.time}`);
  if (d.stadium) lines.push(`Stadium: ${d.stadium}`);
  if (d.rule)    lines.push(`Rule: ${d.rule}`);
  if (d.remark)  lines.push(`Remark: ${d.remark}`);

  // List the registered participants if any have signed up — useful for
  // a host sharing the line-up before starting.
  let participantNames = listRegistrants(state)
    .map(r => (r.name || "").trim())
    .filter(Boolean);
  if (!participantNames.length && typeof getParticipants === "function") {
    participantNames = getParticipants(state).map(n => (n || "").trim()).filter(Boolean);
  }
  participantNames.sort((a, b) => a.localeCompare(b));
  if (participantNames.length) {
    lines.push("");
    lines.push(`Participants (${participantNames.length}):`);
    participantNames.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  }

  lines.push("");
  lines.push(SHARE_TOURNAMENT_INVITE);
  lines.push("");
  lines.push(SHARE_TOURNAMENT_INSTRUCTIONS);
  lines.push("");
  lines.push(SHARE_TOURNAMENT_URL);
  return lines.join("\n");
}

function flashShareButton(btn, msg) {
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.innerHTML = `<span class="swiss-share-flash">${msg}</span>`;
  setTimeout(() => { btn.innerHTML = orig; }, 1200);
}

async function dispatchShareMessage(message, btn) {
  // Mobile native share sheet first; falls back to clipboard, then to a
  // prompt() as a last resort for very old browsers without either API.
  if (navigator.share) {
    try {
      await navigator.share({ text: message });
      return;
    } catch (e) { /* user cancelled or unsupported — fall through */ }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(message);
      flashShareButton(btn, "&#x2713;"); // ✓
      return;
    } catch (e) { /* fall through */ }
  }
  prompt("Copy this and share it:", message);
}

function bindSwissShareButton(view) {
  const btn = view.querySelector("#swiss-share");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (swissCanEdit) {
      // Host / co-host: open the details popup so they can pick / edit the
      // date, time, stadium, rule, remark before sharing.
      showShareDetailsPopup(btn);
    } else {
      // Viewer / participant: share whatever details the host has saved.
      const state = loadSwiss();
      const message = composeTournamentShareMessage(state, state.eventDetails);
      dispatchShareMessage(message, btn);
    }
  });
}

// Persist the host-picked event details onto the live tournament state.
// Pushes to Firebase too so co-hosts see the same values when they tap
// share.
function saveTournamentEventDetails(details) {
  const s = loadSwiss();
  s.eventDetails = {
    date: details.date || "",
    time: details.time || "",
    stadium: details.stadium || "",
    rule: details.rule || "",
    remark: details.remark || ""
  };
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    swissRoomRef.update({ eventDetails: s.eventDetails })
      .catch(e => console.warn("Event details push failed:", e));
  }
}

// Popup that lets the host / co-host fill (or edit) the share-message
// fields. Pre-fills from state.eventDetails so re-opening shows the
// previous choices.
function showShareDetailsPopup(triggerBtn) {
  const popup = document.getElementById("tournament-share-popup");
  if (!popup) {
    // Popup missing — fall back to sharing whatever's already on state.
    const state = loadSwiss();
    dispatchShareMessage(composeTournamentShareMessage(state, state.eventDetails), triggerBtn);
    return;
  }
  const dateInput = popup.querySelector("#share-date-input");
  const timeInput = popup.querySelector("#share-time-input");
  const stadiumDd = popup.querySelector("#share-stadium-input");
  const ruleDd = popup.querySelector("#share-rule-input");
  const remarkInput = popup.querySelector("#share-remark-input");
  const submitBtn = popup.querySelector("#tournament-share-submit");
  const cancelBtn = popup.querySelector("#tournament-share-cancel");
  const nameLabel = popup.querySelector("#tournament-share-subtitle");

  const state = loadSwiss();
  const details = state.eventDetails || {};
  if (nameLabel) {
    nameLabel.textContent = (state.tournamentName || "").trim() || "(unnamed tournament)";
  }
  if (dateInput) dateInput.value = details.date || "";
  if (timeInput) timeInput.value = details.time || "";
  if (remarkInput) remarkInput.value = details.remark || "";

  const stadiumCtrl = wireShareDropdown(stadiumDd, STADIUM_OPTIONS, details.stadium);
  const ruleCtrl = wireShareDropdown(ruleDd, RULE_OPTIONS, details.rule);

  const close = () => {
    popup.classList.add("hidden");
    if (submitBtn) submitBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
  };

  if (submitBtn) {
    submitBtn.onclick = async () => {
      const picked = {
        date: dateInput?.value || "",
        time: timeInput?.value || "",
        stadium: stadiumCtrl ? stadiumCtrl.getValue() : "",
        rule: ruleCtrl ? ruleCtrl.getValue() : "",
        remark: (remarkInput?.value || "").trim()
      };
      saveTournamentEventDetails(picked);
      close();
      const message = composeTournamentShareMessage(loadSwiss(), picked);
      await dispatchShareMessage(message, triggerBtn);
    };
  }
  if (cancelBtn) cancelBtn.onclick = close;
  popup.classList.remove("hidden");
}

// Lightweight custom dropdown wiring for the share popup — mirrors the
// behaviour of initSettingDropdown from calculator.js but doesn't
// persist to localStorage (we save the picked value onto state.eventDetails
// after the user hits Share). Returns { getValue, setValue }.
function wireShareDropdown(root, options, initial) {
  if (!root) return null;
  const btn = root.querySelector(".setting-dropdown-btn");
  const text = root.querySelector(".setting-dropdown-text");
  const menu = root.querySelector(".setting-dropdown-menu");
  const opts = root.querySelectorAll(".setting-dropdown-option");
  if (!btn || !text || !menu) return null;

  const safeInitial = options.includes(initial) ? initial : options[0];
  const apply = (val) => {
    btn.dataset.value = val;
    text.textContent = val;
    opts.forEach(o => o.classList.toggle("active", o.dataset.value === val));
  };
  apply(safeInitial);

  btn.onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle("hidden");
  };
  opts.forEach(opt => {
    opt.onclick = () => {
      apply(opt.dataset.value);
      menu.classList.add("hidden");
    };
  });
  // Close when clicking outside (one-shot per popup-open is fine — the
  // listener becomes a no-op once the menu is already hidden).
  const outsideClick = (e) => { if (!root.contains(e.target)) menu.classList.add("hidden"); };
  document.addEventListener("click", outsideClick);

  return {
    getValue: () => btn.dataset.value || safeInitial,
    setValue: apply
  };
}

// Placeholders for the profile-view popup when an account has no photo/banner.
const PROFILE_VIEW_PHOTO_PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%2321262d'/%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
const PROFILE_VIEW_BANNER_PH = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

// Render a profile's tags as coloured badge spans (Revox red, Developer
// black-blue, Revox Admin gold-bordered); honours the legacy single `tag`.
function revoxTagBadges(profile) {
  const tagsMap = (profile && profile.tags) || {};
  const tags = Object.keys(tagsMap).filter(t => tagsMap[t]);
  if (profile && profile.tag && tags.indexOf(profile.tag) < 0) tags.push(profile.tag);
  return tags.map(t => {
    const lower = String(t).toLowerCase();
    let cls = "account-tag";
    if (lower.indexOf("revox") >= 0) {
      cls += " account-tag-revox";
      if (lower === "revox admin") cls += " account-tag-revox-admin";
    } else if (lower === "developer") {
      cls += " account-tag-developer";
    }
    return `<span class="${cls}">${escapeHtml(t)}</span>`;
  }).join("");
}

// The profile dropdown is dismissed by an outside click or by hovering away;
// these hold the active document listener and the hover grace-period timer.
let profileDropdownOutsideHandler = null;
let profileDropdownHideTimer = null;

function hideProfileDropdown() {
  clearTimeout(profileDropdownHideTimer);
  profileDropdownHideTimer = null;
  const panel = document.getElementById("profile-view-popup");
  if (panel) panel.classList.add("hidden");
  if (profileDropdownOutsideHandler) {
    document.removeEventListener("click", profileDropdownOutsideHandler, true);
    profileDropdownOutsideHandler = null;
  }
}

// A short grace period lets the mouse travel from the username to the
// dropdown (across the small gap) without it closing.
function scheduleProfileDropdownHide() {
  clearTimeout(profileDropdownHideTimer);
  profileDropdownHideTimer = setTimeout(hideProfileDropdown, 220);
}
function cancelProfileDropdownHide() {
  clearTimeout(profileDropdownHideTimer);
  profileDropdownHideTimer = null;
}

// Anchor the fixed-position dropdown just below the clicked username, kept
// inside the viewport (flips above when there isn't room below).
function positionProfileDropdown(panel, anchorEl) {
  if (!panel || !anchorEl) return;
  const r = anchorEl.getBoundingClientRect();
  const pw = panel.offsetWidth || 250;
  const ph = panel.offsetHeight || 220;
  let left = r.left;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - 8 - pw;
  if (left < 8) left = 8;
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8 && r.top - ph - 6 >= 8) {
    top = r.top - ph - 6;
  }
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}

// Resolve a username to its account and show that profile in a read-only
// dropdown (photo, banner, bio, tags) anchored to the clicked name. Reading
// another account's profile needs the public users read rule.
function showProfileByUsername(username, anchorEl) {
  const panel = document.getElementById("profile-view-popup");
  if (!panel || !username) return;
  const nameEl = document.getElementById("profile-view-name");
  const photoEl = document.getElementById("profile-view-photo");
  const bannerEl = document.getElementById("profile-view-banner");
  const bioEl = document.getElementById("profile-view-bio");
  const tagsEl = document.getElementById("profile-view-tags");
  const statusEl = document.getElementById("profile-view-status");
  if (nameEl) nameEl.textContent = username;
  if (bioEl) bioEl.textContent = "";
  if (tagsEl) tagsEl.innerHTML = "";
  if (photoEl) photoEl.src = PROFILE_VIEW_PHOTO_PH;
  if (bannerEl) bannerEl.src = PROFILE_VIEW_BANNER_PH;
  if (statusEl) statusEl.textContent = "Loading…";
  panel.classList.remove("hidden");
  positionProfileDropdown(panel, anchorEl);
  // Keep it open while the pointer is over the dropdown itself.
  cancelProfileDropdownHide();
  panel.onmouseenter = cancelProfileDropdownHide;
  panel.onmouseleave = scheduleProfileDropdownHide;
  // Dismiss on an outside click — deferred so the opening click doesn't count.
  if (profileDropdownOutsideHandler) {
    document.removeEventListener("click", profileDropdownOutsideHandler, true);
  }
  profileDropdownOutsideHandler = (e) => {
    if (panel.contains(e.target)) return;
    if (anchorEl && anchorEl.contains(e.target)) return;
    hideProfileDropdown();
  };
  setTimeout(() => {
    if (profileDropdownOutsideHandler) {
      document.addEventListener("click", profileDropdownOutsideHandler, true);
    }
  }, 0);

  const db = initFirebase();
  if (!db) { if (statusEl) statusEl.textContent = "Live sync isn't configured on this build."; return; }
  db.ref("usernames/" + subHostKey(username)).once("value").then(snap => {
    const v = snap.val();
    if (!v || !v.uid) {
      if (statusEl) statusEl.textContent = "No registered account uses that username.";
      return null;
    }
    return db.ref("users/" + v.uid).once("value");
  }).then(snap => {
    if (!snap) { positionProfileDropdown(panel, anchorEl); return; }
    const p = snap.val() || {};
    if (statusEl) statusEl.textContent = "";
    if (nameEl) nameEl.textContent = p.username || username;
    if (photoEl) photoEl.src = p.photo || PROFILE_VIEW_PHOTO_PH;
    if (bannerEl) bannerEl.src = p.banner || PROFILE_VIEW_BANNER_PH;
    if (bioEl) bioEl.textContent = p.bio || "";
    if (tagsEl) tagsEl.innerHTML = revoxTagBadges(p);
    // Content height changed — re-anchor to the username.
    positionProfileDropdown(panel, anchorEl);
  }).catch(() => {
    if (statusEl) statusEl.textContent = "Couldn't load that profile.";
    positionProfileDropdown(panel, anchorEl);
  });
}

function bindSwissRoomBadge(view) {
  // A username in the room badge opens that account's profile — on hover or
  // on click (click also covers touch devices, where hover doesn't exist).
  view.querySelectorAll(".swiss-profile-link").forEach(el => {
    const uname = el.dataset.username || "";
    if (!uname) return;
    el.addEventListener("click", () => showProfileByUsername(uname, el));
    el.addEventListener("mouseenter", () => showProfileByUsername(uname, el));
    el.addEventListener("mouseleave", () => scheduleProfileDropdownHide());
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
  const isRegistering = isRegisteringPhase(state);
  const hasTournament = hasGroups || bracketActive || isRegistering;
  const inRoom = !!swissEditCode;
  const inRoomNonHost = inRoom && !swissIsHost;

  // Hide the setup form once we have a live tournament OR when the user is
  // connected to someone else's room (they shouldn't generate their own).
  const setupShouldHide = hasTournament || inRoomNonHost;
  setup.classList.toggle("hidden", setupShouldHide);
  // Refresh the open-tournaments list whenever the setup transitions to
  // visible (initial page load with no active tournament, host reset,
  // viewer leaving a room). The flag handles both the first-render case
  // and avoids re-firing on every subsequent render while it stays open.
  const setupNowVisible = !setupShouldHide;
  if (setupNowVisible && !swissSetupWasVisible) {
    refreshOpenTournamentRooms();
    refreshMyTournaments();
  }
  swissSetupWasVisible = setupNowVisible;

  if (isRegistering) {
    view.innerHTML = renderSwissRegisteringMarkup(state);
    bindSwissRegisteringHandlers(view, state);
    bindSwissRoomBadge(view);
    return;
  }

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
    ? ["bracket-f-0"]
        .concat(state.matches["bracket-3rd-0"] ? ["bracket-3rd-0"] : [])
        .concat(state.matches["bracket-5th-0"] ? ["bracket-5th-0"] : [])
        .concat(state.matches["bracket-7th-0"] ? ["bracket-7th-0"] : [])
    : ["bracket-f-0", "bracket-3rd-0", "bracket-5th-0", "bracket-7th-0"];
  const allPlacementsDone = bracketActive && placementIds.every(id => isMatchDecided(state.matches[id]));
  const isSwissOnly = state.mode === "swiss-only";
  const tournamentComplete = isSwissOnly ? groupStageDone : (bracketActive && allPlacementsDone);
  const canEdit = !inRoom || swissCanEdit;

  const groupsHtml = hasGroups ? state.groups.map((members, gi) => {
    const mode = swissGroupViews[gi] || "matches";
    const body = mode === "standings"
      ? renderSwissGroupStandings(state, gi, canEdit)
      : renderSwissGroupMatches(state, gi);
    const roundsGen = state.groupRounds[gi] || 0;
    // Host can retune the total round count mid-tournament, but only while the
    // group stage is live — once the Top-8 bracket is up, rounds are moot.
    // Round robin's total is this group's own schedule length (groups can
    // differ by a player), not the tournament-wide max.
    const totalRounds = state.pairing === "round-robin"
      ? roundRobinRoundCount(members.length)
      : getRoundCount(state);
    const progressLabel = `Round ${roundsGen} / ${totalRounds}`;
    // Round robin's round count is fixed by group size — only Swiss exposes
    // the tap-to-edit round picker.
    const canEditRounds = canEdit && !bracketActive && state.pairing !== "round-robin";
    const progressHtml = canEditRounds
      ? `<button type="button" class="swiss-group-progress swiss-group-progress-edit" title="Tap to change total rounds">${progressLabel}</button>`
      : `<span class="swiss-group-progress">${progressLabel}</span>`;

    return `<section class="swiss-group">
      <header class="swiss-group-header">
        <span class="swiss-group-title">Group ${String.fromCharCode(65 + gi)}</span>
        ${progressHtml}
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

  // Hosts and co-hosts can rename via a popup; viewers see a static label.
  const nameValue = state.tournamentName || "";
  let tournamentNameHtml = "";
  if (canEdit) {
    const placeholder = "+ Add tournament name";
    const label = nameValue || placeholder;
    const cls = "swiss-tournament-name swiss-tournament-name-editable" + (nameValue ? "" : " swiss-tournament-name-empty");
    tournamentNameHtml = `<button type="button" class="${cls}" id="swiss-edit-name" title="Tap to rename">${escapeHtml(label)}</button>`;
  } else if (nameValue) {
    tournamentNameHtml = `<span class="swiss-tournament-name" title="${escapeHtml(nameValue)}">${escapeHtml(nameValue)}</span>`;
  }

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
          ${renderSwissShareButton()}
          ${swissIsHost ? renderCoHostsButton() : ""}
          ${canEdit && canAddParticipant(state) ? `<button type="button" id="swiss-edit-participants" class="btn btn-icon-sm btn-icon-plus" aria-label="Add participant" title="Add participant">+</button>` : ""}
          <button type="button" id="swiss-clear" class="btn btn-reset btn-icon-sm" title="${resetTitle}">
            <img src="assets/icons/exit-button.png" alt="${resetTitle}"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
          </button>
        </div>
      </div>
    </div>
    ${groupsHtml}
    ${bracketHtml}
    ${isSwissOnly && groupStageDone ? renderCombinedSwissStandings(state) : ""}
    ${tournamentComplete ? renderPartUsageCharts(state) : ""}
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
  view.querySelector("#swiss-edit-participants")?.addEventListener("click", showAddParticipantPopup);
  view.querySelector("#swiss-cohosts")?.addEventListener("click", showCoHostsPopup);
  view.querySelector("#swiss-edit-name")?.addEventListener("click", showEditTournamentNamePopup);
  bindSwissShareButton(view);

  // Match cards are interactive only for users who can edit (host + co-host).
  // Participants joined via the view-only code see cards but can't open them.
  if (canEdit) {
    view.querySelectorAll(".swiss-match-card-play").forEach(el => {
      const id = el.dataset.match;
      if (!id) return;
      el.addEventListener("click", () => showBeyCheckPopup(id));
      el.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showBeyCheckPopup(id); }
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
  // Tap a name in the Standings view to rename that participant (host-only;
  // the buttons are only rendered when canEdit).
  view.querySelectorAll(".swiss-name-edit").forEach(btn => {
    btn.addEventListener("click", () => promptRenameSwissParticipant(btn.dataset.rename));
  });
  // Tap the "Round X / Y" header to change the total round count (host-only,
  // group stage only).
  view.querySelectorAll(".swiss-group-progress-edit").forEach(btn => {
    btn.addEventListener("click", showEditRoundCountPopup);
  });
  view.querySelector("#swiss-clear")?.addEventListener("click", resetSwiss);

  // Wire up any part-usage carousels rendered into the view.
  if (typeof setupDashboardCarousel === "function") {
    view.querySelectorAll(".part-usage-carousel").forEach(setupDashboardCarousel);
  }
}

// Registration-phase render. Same toolbar shape as the running view (so the
// room codes / leave button stay where users expect them), but the body is
// the registrants list and a host-only Start button. Match-deck pre-fill
// later in the tournament reads from these registrants directly.
function renderSwissRegisteringMarkup(state) {
  const isHost = swissIsHost;
  // Hosts AND co-hosts can both start the tournament, remove registrants,
  // edit the name, etc. The Reset / Leave behaviour still differs by
  // role — only the original host wipes the room; co-hosts just
  // disconnect locally.
  const canEdit = !!swissCanEdit;
  const canRegisterSelf = !!swissCanEdit;
  const registrants = listRegistrants(state).sort((a, b) =>
    (a.name || "").localeCompare(b.name || "")
  );
  const minTotal = swissRegistrationMinimum(state);
  const enoughRegistrants = registrants.length >= minTotal;

  const modeLabel = tournamentFormatLabel(state.mode, state.pairing, false);
  // Hosts / co-hosts can tweak the format while still waiting for players —
  // no matches exist yet, so changing groups / rounds / Top-8 is safe.
  const isSwiss = state.mode !== "single-elim";
  // Round robin has no round count to set — its rounds are generated from the
  // group size so every participant plays every other one.
  const isRoundRobin = state.pairing === "round-robin";
  const formatBits = [];
  if (canEdit && isSwiss) {
    formatBits.push(`<button type="button" class="swiss-reg-format-mode swiss-reg-format-editable" id="swiss-edit-mode" title="Tap to change Top 8">${modeLabel}</button>`);
  } else {
    formatBits.push(`<span class="swiss-reg-format-mode">${modeLabel}</span>`);
  }
  if (isSwiss) {
    if (canEdit) {
      formatBits.push(`<button type="button" class="swiss-reg-format-bit swiss-reg-format-editable" id="swiss-edit-groups" title="Tap to change groups">${getGroupCount(state)} groups</button>`);
      if (!isRoundRobin) {
        formatBits.push(`<button type="button" class="swiss-reg-format-bit swiss-reg-format-editable" id="swiss-edit-rounds" title="Tap to change rounds">${getRoundCount(state)} rounds</button>`);
      }
    } else {
      formatBits.push(`<span class="swiss-reg-format-bit">${getGroupCount(state)} groups</span>`);
      if (!isRoundRobin) {
        formatBits.push(`<span class="swiss-reg-format-bit">${getRoundCount(state)} rounds</span>`);
      }
    }
  }

  const nameValue = state.tournamentName || "";
  let nameHtml = "";
  if (canEdit) {
    const placeholder = "+ Add tournament name";
    const label = nameValue || placeholder;
    const cls = "swiss-tournament-name swiss-tournament-name-editable" + (nameValue ? "" : " swiss-tournament-name-empty");
    nameHtml = `<button type="button" class="${cls}" id="swiss-edit-name" title="Tap to rename">${escapeHtml(label)}</button>`;
  } else if (nameValue) {
    nameHtml = `<span class="swiss-tournament-name">${escapeHtml(nameValue)}</span>`;
  }

  const registrantRows = registrants.length
    ? registrants.map((r, i) => {
        const removeBtn = canEdit
          ? `<button type="button" class="swiss-reg-remove" data-reg-id="${escapeHtml(r.id)}" title="Remove ${escapeHtml(r.name)}" aria-label="Remove ${escapeHtml(r.name)}">&times;</button>`
          : "";
        const deckHasContent = !isBeyCheckDeckEmpty(r.deck);
        const deckBadge = deckHasContent
          ? `<span class="swiss-reg-deck-badge">Deck ✓</span>`
          : `<span class="swiss-reg-deck-badge swiss-reg-deck-badge-missing">No deck</span>`;
        // Hosts and co-hosts can tap a registrant's name to edit it
        // (re-opens the registration form pre-filled with that
        // registrant's name + deck).
        const nameEl = canEdit
          ? `<button type="button" class="swiss-reg-name swiss-reg-name-edit" data-reg-id="${escapeHtml(r.id)}" title="Edit name or deck">${escapeHtml(r.name || "(unnamed)")}</button>`
          : `<span class="swiss-reg-name">${escapeHtml(r.name || "(unnamed)")}</span>`;
        return `<li class="swiss-reg-row">
          <span class="swiss-reg-num">${i + 1}</span>
          ${nameEl}
          ${deckBadge}
          ${removeBtn}
        </li>`;
      }).join("")
    : `<li class="swiss-reg-empty">No one has registered yet. Players can find this tournament under Open Tournaments and sign up there.</li>`;

  const selfRegBtnHtml = canRegisterSelf
    ? `<button type="button" id="swiss-reg-self" class="swiss-reg-self">+ Register myself</button>`
    : "";
  const testRegBtnHtml = canEdit
    ? `<button type="button" id="swiss-reg-test" class="swiss-reg-self swiss-reg-test">Test</button>`
    : "";
  const startBtnHtml = canEdit
    ? `<button type="button" id="swiss-reg-start" class="btn swiss-reg-start" ${enoughRegistrants ? "" : "disabled"}>
         ${enoughRegistrants ? "Start Tournament" : `Need ${minTotal - registrants.length} more`}
       </button>`
    : (canRegisterSelf
        ? ""
        : `<div class="swiss-reg-waiting">Waiting for the host to start the tournament…</div>`);

  return `
    <div class="swiss-toolbar">
      <div class="swiss-toolbar-row swiss-toolbar-name-row">
        ${nameHtml}
        <div class="swiss-toolbar-actions">
          ${renderSwissShareButton()}
          ${swissIsHost ? renderCoHostsButton() : ""}
          <button type="button" id="swiss-clear" class="btn btn-reset btn-icon-sm" title="${isHost ? "Reset Tournament" : "Leave Room"}">
            <img src="assets/icons/exit-button.png" alt="Leave"
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
          </button>
        </div>
      </div>
      <div class="swiss-toolbar-row swiss-toolbar-info-row">
        <div class="swiss-toolbar-idgroup">
          ${renderSwissRoomBadge()}
          <span class="swiss-reg-pill">Registration open</span>
        </div>
      </div>
    </div>
    <section class="swiss-registering">
      <div class="swiss-reg-format">${formatBits.join("")}</div>
      <div class="swiss-reg-heading-row">
        <h3 class="swiss-reg-heading">Registrants <span class="swiss-reg-count">(${registrants.length}${minTotal ? ` / ${minTotal} min` : ""})</span></h3>
      </div>
      ${(selfRegBtnHtml || testRegBtnHtml)
        ? `<div class="swiss-reg-host-actions">${selfRegBtnHtml}${testRegBtnHtml}</div>`
        : ""}
      <ul class="swiss-reg-list">${registrantRows}</ul>
      <div class="swiss-reg-actions">${startBtnHtml}</div>
    </section>
  `;
}

// Apply a settings patch to the tournament while it's still in the
// registering phase, persist locally and push to Firebase, then re-render.
function updateRegisteringSetting(patch) {
  const s = loadSwiss();
  if (!isRegisteringPhase(s)) return;
  Object.assign(s, patch);
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    swissRoomRef.update(patch).catch(e => console.warn("Tournament setting push failed:", e));
  }
  renderSwiss();
}

function bindSwissRegisteringHandlers(view, state) {
  view.querySelector("#swiss-edit-name")?.addEventListener("click", showEditTournamentNamePopup);
  view.querySelector("#swiss-cohosts")?.addEventListener("click", showCoHostsPopup);
  view.querySelector("#swiss-clear")?.addEventListener("click", resetSwiss);
  view.querySelector("#swiss-edit-mode")?.addEventListener("click", () => {
    showTopEightPopup((mode) => {
      if (mode) updateRegisteringSetting({ mode });
    }, state.pairing === "round-robin");
  });
  view.querySelector("#swiss-edit-groups")?.addEventListener("click", () => {
    showSwissGroupsPopup((gc) => updateRegisteringSetting({ groupCount: gc }));
  });
  view.querySelector("#swiss-edit-rounds")?.addEventListener("click", () => {
    showSwissRoundsPopup((rc) => updateRegisteringSetting({ roundCount: rc }));
  });
  view.querySelector("#swiss-reg-start")?.addEventListener("click", startRegisteringTournament);
  view.querySelector("#swiss-reg-self")?.addEventListener("click", showSelfRegisterPopup);
  view.querySelector("#swiss-reg-test")?.addEventListener("click", () => {
    const raw = prompt("How many test registrants?", "10");
    if (raw == null) return;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) { alert("Enter a positive number."); return; }
    if (n > 64) {
      if (!confirm(`Add ${n} test registrants? That's a lot — confirm to proceed.`)) return;
    }
    addTestRegistrants(n);
  });
  bindSwissShareButton(view);
  view.querySelectorAll(".swiss-reg-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.regId;
      if (!id) return;
      removeRegistrant(id);
    });
  });
  view.querySelectorAll(".swiss-reg-name-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.regId;
      if (id) showEditRegistrantPopup(id);
    });
  });
}

// Edit an existing registrant — re-opens the registration popup pre-filled
// with their current name and deck, and routes the submit through an
// update path (overwrites the same registrant entry, no new id).
function showEditRegistrantPopup(registrantId) {
  if (!swissCanEdit || !swissEditCode || !registrantId) return;
  const state = loadSwiss();
  if (!isRegisteringPhase(state)) return;
  const reg = state.registrants && state.registrants[registrantId];
  if (!reg) return;
  const room = {
    editCode: swissEditCode,
    viewCode: swissViewCode,
    name: state.tournamentName || "",
    mode: state.mode || "swiss",
    roundCount: state.roundCount || null,
    groupCount: state.groupCount || null
  };
  showRegistrationPopup(room, {
    editRegistrantId: registrantId,
    initialName: reg.name || "",
    initialDeck: normalizeBeyCheckDeck(reg.deck)
  });
}

// Host / co-host registers themselves as a player. Reuses the registration
// popup but routes the submit through a path that writes directly to the
// already-connected `swissRoomRef` (no disconnect/reconnect, so the user
// keeps host/co-host edit privileges).
function showSelfRegisterPopup() {
  if (!swissCanEdit || !swissEditCode) return;
  const state = loadSwiss();
  if (!isRegisteringPhase(state)) return;
  const room = {
    editCode: swissEditCode,
    viewCode: swissViewCode,
    name: state.tournamentName || "",
    mode: state.mode || "swiss",
    roundCount: state.roundCount || null,
    groupCount: state.groupCount || null
  };
  showRegistrationPopup(room, { selfRegister: true });
}

// Minimum registrants needed before Start can fire. Mirrors the same checks
// the underlying generators apply, so the host can never click Start and
// then get an alert from the generator.
function swissRegistrationMinimum(state) {
  if (!state) return 0;
  if (state.mode === "single-elim") return 2;
  // Swiss / Swiss + Top 8: need enough per group for SWISS_MIN_PER_GROUP and
  // enough total for the bracket's top-N slots.
  const gc = getGroupCount(state);
  const minPerGroupForBracket = state.mode === "swiss-only"
    ? SWISS_MIN_PER_GROUP
    : Math.ceil(SWISS_BRACKET_SIZE / gc);
  return gc * Math.max(SWISS_MIN_PER_GROUP, minPerGroupForBracket);
}

function removeRegistrant(id) {
  if (!id) return;
  const s = loadSwiss();
  if (!s.registrants || !s.registrants[id]) return;
  delete s.registrants[id];
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    const updates = { [`registrants/${id}`]: null };
    swissRoomRef.update(updates).catch(e => console.warn("Registrant remove push failed:", e));
    if (s.phase === "registering" && swissEditCode) publishOpenRoomIndex(swissEditCode, s);
  }
  renderSwiss();
}

// Host-side Start: lock the registrant list, run the existing generators
// from the registered names, copy registrants forward into the running
// state, flip phase to "running", and remove the open-tournaments index.
function startRegisteringTournament() {
  // Host and co-host can both start the tournament.
  if (!swissCanEdit) return;
  const state = loadSwiss();
  if (!isRegisteringPhase(state)) return;
  const registrants = listRegistrants(state);
  const minTotal = swissRegistrationMinimum(state);
  if (registrants.length < minTotal) {
    alert(`Need at least ${minTotal} registrants to start (${registrants.length} so far).`);
    return;
  }
  const missingDecks = registrants.filter(r => isBeyCheckDeckEmpty(r.deck)).map(r => r.name || "(unnamed)");
  if (missingDecks.length) {
    const proceed = confirm(`These registrants haven't submitted a deck yet:\n\n${missingDecks.join("\n")}\n\nStart anyway? (Their decks will be empty until the judge fills them in.)`);
    if (!proceed) return;
  }
  const names = registrants.map(r => (r.name || "").trim()).filter(Boolean);
  if (names.length < minTotal) {
    alert("Some registrants are missing a name.");
    return;
  }
  const namesText = names.join("\n");
  const generated = state.mode === "single-elim"
    ? generateSingleElimFromText(namesText, state.tournamentName)
    : generateSwissFromText(namesText, state.tournamentName, getRoundCount(state), getGroupCount(state), state.pairing);
  if (!generated) return; // generator already alerted
  // Carry forward registrants + metadata; flip phase to running. hostUid must
  // be carried too — the room push below is a full overwrite, so dropping it
  // would wipe the room's owner field.
  generated.registrants = state.registrants;
  generated.phase = "running";
  generated.ranked = state.ranked;
  generated.hostUid = state.hostUid || null;
  if (state.mode === "swiss-only") generated.mode = "swiss-only";
  if (state.createdAt) generated.createdAt = state.createdAt;
  persistSwiss(generated);

  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    const payload = { ...generated };
    if (swissViewCode) payload.viewCode = swissViewCode;
    // The Start push is a full overwrite — carry the sub-host list forward
    // so designated co-hosts aren't wiped when the tournament begins.
    if (swissSubHosts && Object.keys(swissSubHosts).length) payload.subHosts = swissSubHosts;
    swissApplyingRemote = true;
    swissRoomRef.set(payload)
      .catch(e => console.warn("Start tournament push failed:", e))
      .finally(() => { swissApplyingRemote = false; });
  }
  // Keep the room in the Open Tournaments lobby once it's running. Registration
  // is closed, but co-hosts and viewers can still find and join it — the entry
  // is only removed when the host resets/closes the room.
  if (swissEditCode) publishOpenRoomIndex(swissEditCode, generated);
  // Refresh the host's account-scoped index so the phase flips to running.
  if (swissEditCode && generated.hostUid) {
    publishUserTournament(generated.hostUid, swissEditCode, generated);
  }
  renderSwiss();
}

// Combined cross-group standings for swiss-only mode. Each group's stats
// are computed independently (so medianBuchholz uses each player's actual
// opponents), then all players are flattened and re-sorted by the same
// comparator used per-group: wins → points scored → points diff → MB → name.
function computeCombinedSwissStandings(state) {
  if (!state || !Array.isArray(state.groups)) return [];
  const all = [];
  state.groups.forEach((members, gi) => {
    const standings = computeStandings(members, state.matches, gi, state.pairing === "round-robin");
    standings.forEach(s => all.push({ ...s, groupIndex: gi }));
  });
  return all.sort((a, b) =>
    (b.wins - a.wins) ||
    (b.pointsScored - a.pointsScored) ||
    (b.pointsDiff - a.pointsDiff) ||
    (b.medianBuchholz - a.medianBuchholz) ||
    a.name.localeCompare(b.name)
  );
}

function renderCombinedSwissStandings(state) {
  const standings = computeCombinedSwissStandings(state);
  if (!standings.length) return "";
  const groupLetter = i => String.fromCharCode(65 + i); // 0 → A, 1 → B, ...
  const rows = standings.map((s, i) => {
    const place = i + 1;
    const placeMod = place <= 3 ? ` tournament-results-place-${place}` : "";
    const record = `${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""}`;
    return `
      <div class="tournament-results-row swiss-final-row${placeMod}">
        <span class="tournament-results-place">${placementLabel(place)}</span>
        <span class="tournament-results-player">${escapeHtml(s.name)}</span>
        <span class="swiss-final-group">Group ${groupLetter(s.groupIndex)}</span>
        <span class="swiss-final-record">${record}</span>
      </div>
    `;
  }).join("");
  return `
    <fieldset class="swiss-final-standings">
      <legend>Final Standings</legend>
      <div class="tournament-results-list">${rows}</div>
    </fieldset>
  `;
}

function computeStandings(members, matches, groupIndex, isRoundRobin) {
  const stats = {};
  members.forEach(n => {
    stats[n] = { name: n, wins: 0, losses: 0, draws: 0, pointsScored: 0, pointsAgainst: 0, opponents: [] };
  });
  Object.values(matches).forEach(m => {
    if (m.groupIndex !== groupIndex) return;
    if (m.bye && m.a && stats[m.a]) {
      // A Swiss bye is a free win — the player wasn't paired, so they aren't
      // penalised. A round-robin bye is just a sit-out (everyone still faces
      // everyone else over the full schedule), so it scores nothing.
      if (!isRoundRobin) stats[m.a].wins++;
      return;
    }
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
  if (!state.groups || state.groups.length === 0) return false;
  // Round robin: each group finishes on its own schedule length, which
  // depends on that group's size (groups can differ by one player).
  if (state.pairing === "round-robin") {
    return state.groups.every((g, gi) => {
      const need = roundRobinRoundCount((g || []).length);
      return (state.groupRounds[gi] || 0) >= need
        && (need === 0 || isGroupRoundComplete(state.matches, gi, need - 1));
    });
  }
  const rc = getRoundCount(state);
  return state.groups.every((_, gi) =>
    (state.groupRounds[gi] || 0) >= rc &&
    isGroupRoundComplete(state.matches, gi, rc - 1)
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
    const isQuarter = round === preFinal - 2;
    const slot = bracketIndex % 2 === 0 ? "a" : "b";
    if (isSemi) {
      const has3rd = !!(state && state.matches && state.matches["bracket-3rd-0"]);
      return {
        winner: { toId: "bracket-f-0", slot },
        loser:  has3rd ? { toId: "bracket-3rd-0", slot } : null
      };
    }
    if (isQuarter) {
      // Top-8: QF losers feed bracket-cqf-{floor(qfIdx/2)}. QFs 0,1 → CQF0;
      // QFs 2,3 → CQF1. The slot inside the CQF mirrors the QF index parity.
      const hasCqf = !!(state && state.matches && state.matches["bracket-cqf-0"]);
      return {
        winner: { toId: `bracket-r${round + 1}-${Math.floor(bracketIndex / 2)}`, slot },
        loser:  hasCqf ? { toId: `bracket-cqf-${Math.floor(bracketIndex / 2)}`, slot } : null
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
  // Top-N per group is whatever fills the 8-slot bracket: 4 groups → top 2,
  // 2 groups → top 4. The cross-seed pattern keeps each group's #1 on a
  // different half of the bracket so top seeds can only meet later.
  const groupCount = getGroupCount(state);

  if (groupCount === 3) {
    // 8 doesn't divide evenly across 3 groups, so we take top 2 from each
    // (6 players) and add the best 2 third-place finishers as wildcards.
    const standings = state.groups.map((members, gi) =>
      computeStandings(members, state.matches, gi, state.pairing === "round-robin")
    );
    const top2 = standings.map(st => [st[0]?.name || null, st[1]?.name || null]);
    // Collect 3rd-place finishers across groups, sorted by the same metrics
    // computeStandings already ranks by — wins desc, then ties broken by
    // whatever computeStandings put after (already sorted, so list order is
    // each group's 3rd seed in its own ranking). Compare across groups using
    // available numeric stats with safe fallbacks.
    const thirds = standings
      .map(st => st[2])
      .filter(Boolean);
    thirds.sort((a, b) =>
      ((b.wins || 0) - (a.wins || 0)) ||
      ((b.pointsScored || 0) - (a.pointsScored || 0)) ||
      ((b.pointsDiff || 0) - (a.pointsDiff || 0)) ||
      ((b.medianBuchholz || 0) - (a.medianBuchholz || 0)) ||
      (a.name || "").localeCompare(b.name || "")
    );
    const wild1 = thirds[0]?.name || null;
    const wild2 = thirds[1]?.name || null;
    const [A, B, C] = top2;
    return [
      [A[0], wild2],   // half 1: A1 vs weaker wildcard
      [B[1], C[1]],    // half 1: B2 vs C2
      [B[0], wild1],   // half 2: B1 vs stronger wildcard
      [C[0], A[1]]     // half 2: C1 vs A2
    ];
  }

  const topN = SWISS_BRACKET_SIZE / groupCount;
  const top = state.groups.map((members, gi) => {
    const st = computeStandings(members, state.matches, gi, state.pairing === "round-robin");
    return Array.from({ length: topN }, (_, i) => (st[i] && st[i].name) || null);
  });

  if (groupCount === 4) {
    const [A, B, C, D] = top;
    return [
      [A[0], B[1]],
      [C[0], D[1]],
      [B[0], A[1]],
      [D[0], C[1]]
    ];
  }
  if (groupCount === 2) {
    // Standard 8-team cross-seed within a 2-group split: A1/B1 sit on
    // opposite halves, the rest interleave so QFs are always cross-group.
    const [A, B] = top;
    return [
      [A[0], B[3]],
      [B[1], A[2]],
      [B[0], A[3]],
      [A[1], B[2]]
    ];
  }
  return [];
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

// Bey check popup: when host/co-host taps a match, build each participant's
// 3-slot deck and persist on the match record so every device in the room
// can review what each player brought. Each slot supports the three combo
// lines from the calculator (Standard / CX / CX Expand). The actual match
// scoring stays untouched — a "Score Match" button in the parent popup is
// what hands off to startSwissMatch.
const BEY_CHECK_DECK_SIZE = 3;
const BEY_CHECK_MODES = ["standard", "cx", "cxExpand"];
const BEY_CHECK_FIELDS = {
  standard: ["blade", "ratchet", "bit"],
  cx: ["lockChip", "mainBlade", "assistBlade", "ratchet", "bit"],
  cxExpand: ["lockChip", "metalBlade", "overBlade", "assistBlade", "ratchet", "bit"]
};
const BEY_CHECK_DATA_BY_FIELD = {
  blade: "blades",
  lockChip: "lockChips",
  mainBlade: "mainBlades",
  metalBlade: "metalBlades",
  overBlade: "overBlades",
  assistBlade: "assistBlades",
  ratchet: "ratchets",
  bit: "bits"
};

function getBeyCheckPartList(field) {
  const key = BEY_CHECK_DATA_BY_FIELD[field];
  return (key && DATA && Array.isArray(DATA[key])) ? DATA[key] : [];
}

function emptyBeyCheckSlot() {
  return { mode: "standard", parts: {} };
}

function emptyBeyCheckDeck() {
  const slots = [];
  for (let i = 0; i < BEY_CHECK_DECK_SIZE; i++) slots.push(emptyBeyCheckSlot());
  return slots;
}

function normalizeBeyCheckSlot(raw) {
  if (!raw || typeof raw !== "object") return emptyBeyCheckSlot();
  // Legacy {blade, ratchet, bit} → new shape with mode "standard".
  if (!("mode" in raw) && ("blade" in raw || "ratchet" in raw || "bit" in raw)) {
    const parts = {};
    ["blade", "ratchet", "bit"].forEach(f => {
      if (typeof raw[f] === "string" && raw[f]) parts[f] = raw[f];
    });
    return { mode: "standard", parts };
  }
  const mode = BEY_CHECK_MODES.includes(raw.mode) ? raw.mode : "standard";
  const parts = {};
  if (raw.parts && typeof raw.parts === "object") {
    BEY_CHECK_FIELDS[mode].forEach(f => {
      const v = raw.parts[f];
      if (typeof v === "string" && v) parts[f] = v;
    });
  }
  return { mode, parts };
}

function normalizeBeyCheckDeck(raw) {
  const out = emptyBeyCheckDeck();
  // Firebase may round-trip a sparse array as an object keyed by numeric
  // strings, so accept either shape.
  if (!raw || typeof raw !== "object") return out;
  for (let i = 0; i < BEY_CHECK_DECK_SIZE; i++) {
    if (raw[i]) out[i] = normalizeBeyCheckSlot(raw[i]);
  }
  return out;
}

function isBeyCheckSlotEmpty(slot) {
  if (!slot || !slot.parts) return true;
  return Object.values(slot.parts).every(v => !v);
}

function isBeyCheckDeckEmpty(deck) {
  return !Array.isArray(deck) || deck.every(isBeyCheckSlotEmpty);
}

// Aggregate part usage across the tournament. Counts each participant's
// most recent saved deck once (via findLatestDeckForParticipant) so that a
// player who plays many matches with the same deck doesn't dominate the
// chart proportionally to their match count.
const BEY_CHECK_FIELD_LABEL = {
  blade: "Blades",
  lockChip: "Lock Chips",
  mainBlade: "Main Blades",
  metalBlade: "Metal Blades",
  overBlade: "Over Blades",
  assistBlade: "Assist Blades",
  ratchet: "Ratchets",
  bit: "Bits"
};
const BEY_CHECK_FIELD_ORDER = [
  "blade", "lockChip", "mainBlade", "metalBlade",
  "overBlade", "assistBlade", "ratchet", "bit"
];

function aggregatePartUsage(state) {
  const usage = {};
  const participants = getParticipants(state);
  for (const name of participants) {
    if (!name) continue;
    const deck = findLatestDeckForParticipant(state, name, null);
    if (!deck) continue;
    deck.forEach(slot => {
      if (!slot || !slot.parts) return;
      Object.entries(slot.parts).forEach(([field, partName]) => {
        if (!partName || partName === NO_RATCHET) return;
        if (!usage[field]) usage[field] = {};
        usage[field][partName] = (usage[field][partName] || 0) + 1;
      });
    });
  }
  return usage;
}

// Theme-aware pie palette. Each theme has its own hue band + S/L preset so
// the slices feel native to the surrounding card. Mono uses a grayscale
// gradient; the rest distribute hues across a constrained band so slices
// stay distinguishable without falling back to rainbow primaries.
function getPiePaletteForTheme() {
  const cls = document.body.classList;
  if (cls.contains("love-mode"))     return { type: "hue", hueStart: 320, hueRange: 100, sat: 70, light: 60 };
  if (cls.contains("forest-mode"))   return { type: "hue", hueStart: 70,  hueRange: 80,  sat: 50, light: 45 };
  if (cls.contains("tropical-mode")) return { type: "hue", hueStart: 15,  hueRange: 60,  sat: 70, light: 55 };
  if (cls.contains("space-mode"))    return { type: "hue", hueStart: 200, hueRange: 120, sat: 65, light: 60 };
  if (cls.contains("stormy-mode"))   return { type: "hue", hueStart: 200, hueRange: 90,  sat: 55, light: 55 };
  if (cls.contains("mono-mode"))     return { type: "gray", lightStart: 30, lightEnd: 80 };
  if (cls.contains("light-mode"))    return { type: "hue", hueStart: 0,   hueRange: 360, sat: 55, light: 50 };
  return                                    { type: "hue", hueStart: 0,   hueRange: 360, sat: 65, light: 55 };
}

function getPieStrokeForTheme() {
  const cls = document.body.classList;
  if (cls.contains("love-mode"))     return "#ffd6e3";
  if (cls.contains("forest-mode"))   return "#e1e8d2";
  if (cls.contains("tropical-mode")) return "#ffe8c5";
  if (cls.contains("light-mode"))    return "#ffffff";
  if (cls.contains("space-mode"))    return "#0a0d1f";
  if (cls.contains("stormy-mode"))   return "#1a2030";
  if (cls.contains("mono-mode"))     return "#0b0b0b";
  return "#0d1117";
}

function partUsageColor(i, total, palette) {
  if (palette.type === "gray") {
    const t = total <= 1 ? 0 : i / (total - 1);
    const light = palette.lightStart + (palette.lightEnd - palette.lightStart) * t;
    return `hsl(0, 0%, ${light.toFixed(0)}%)`;
  }
  // Spread hues evenly across the band. Wrap around the colour wheel so a
  // band wider than 360 still produces distinct hues.
  const hue = (palette.hueStart + (i * palette.hueRange) / Math.max(total, 1)) % 360;
  return `hsl(${hue.toFixed(0)}, ${palette.sat}%, ${palette.light}%)`;
}

function renderPartUsagePie(label, counts) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = entries.reduce((s, [, c]) => s + c, 0);
  if (total === 0) return "";
  const palette = getPiePaletteForTheme();
  const strokeColor = getPieStrokeForTheme();
  const cx = 70, cy = 70, r = 60;
  let cumulative = 0;
  const slices = entries.map(([, count], i) => {
    const startAngle = (cumulative / total) * 2 * Math.PI;
    cumulative += count;
    const endAngle = (cumulative / total) * 2 * Math.PI;
    const x1 = cx + r * Math.sin(startAngle);
    const y1 = cy - r * Math.cos(startAngle);
    const x2 = cx + r * Math.sin(endAngle);
    const y2 = cy - r * Math.cos(endAngle);
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    const color = partUsageColor(i, entries.length, palette);
    // Single-slice pie: a full circle path (zero-length arc isn't drawn).
    const path = entries.length === 1
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} Z`
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return `<path d="${path}" fill="${color}" stroke="${strokeColor}" stroke-width="1"/>`;
  }).join("");
  const legend = entries.map(([name, count], i) => {
    const pct = ((count / total) * 100).toFixed(1);
    const color = partUsageColor(i, entries.length, palette);
    return `<li class="part-usage-legend-item">
      <span class="part-usage-swatch" style="background:${color}"></span>
      <span class="part-usage-name">${escapeHtml(name)}</span>
      <span class="part-usage-pct">${pct}% <span class="part-usage-count">(${count})</span></span>
    </li>`;
  }).join("");
  return `
    <section class="part-usage-card">
      <header class="part-usage-title">${escapeHtml(label)}</header>
      <div class="part-usage-body">
        <svg viewBox="0 0 140 140" class="part-usage-pie" aria-hidden="true">${slices}</svg>
        <ul class="part-usage-legend">${legend}</ul>
      </div>
    </section>
  `;
}

function renderPartUsageCharts(state) {
  const usage = aggregatePartUsage(state);
  const fields = BEY_CHECK_FIELD_ORDER.filter(f => usage[f] && Object.keys(usage[f]).length);
  if (!fields.length) return "";
  const charts = fields
    .map(f => renderPartUsagePie(BEY_CHECK_FIELD_LABEL[f] || f, usage[f]))
    .join("");
  return `<fieldset class="part-usage-fieldset">
    <legend>Parts Usage</legend>
    <div class="dashboard-carousel part-usage-carousel">
      <div class="dashboard-carousel-track">${charts}</div>
      <div class="dashboard-carousel-dots"></div>
    </div>
  </fieldset>`;
}

// Mirrors the deck builder's "one of each part per deck" rule (deck.js).
// Lock chips repeat freely except for the exclusive ones (Emperor, Valkyrie).
// NO_RATCHET is a sentinel, not a real part — it can repeat across slots.
function isBeyCheckCountedPart(field, name) {
  if (!name || name === NO_RATCHET) return false;
  if (field === "lockChip") {
    return typeof LOCK_CHIP_EXCLUSIVE !== "undefined" && LOCK_CHIP_EXCLUSIVE.has(name);
  }
  return true;
}

// Returns { name, slotIdx } for the first part in `newSlot` that's already
// used in another slot of `deck` (excluding `excludeIdx`), or null if clean.
function findBeyCheckPartConflict(newSlot, deck, excludeIdx) {
  if (!newSlot || !newSlot.parts || !Array.isArray(deck)) return null;
  const newEntries = Object.entries(newSlot.parts)
    .filter(([f, n]) => isBeyCheckCountedPart(f, n));
  for (let i = 0; i < deck.length; i++) {
    if (i === excludeIdx) continue;
    const other = deck[i];
    if (!other || !other.parts) continue;
    for (const [field, name] of newEntries) {
      for (const [otherField, otherName] of Object.entries(other.parts)) {
        if (!isBeyCheckCountedPart(otherField, otherName)) continue;
        if (otherName === name) return { name, slotIdx: i };
      }
    }
  }
  return null;
}

// Find the most recently saved deck for a participant across the tournament,
// excluding the current match. Used to carry decks forward to the next match
// without making the host re-enter them. "Most recent" = reverse insertion
// order in state.matches, which mirrors the round-by-round generation flow
// (R1 → R2 → … → bracket).
function findLatestDeckForParticipant(state, name, excludeMatchId) {
  if (!name || !state || !state.matches) return null;
  const entries = Object.entries(state.matches);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [matchId, match] = entries[i];
    if (matchId === excludeMatchId) continue;
    if (!match || !match.decks) continue;
    let raw = null;
    if (match.a === name) raw = match.decks.a;
    else if (match.b === name) raw = match.decks.b;
    if (!raw) continue;
    const deck = normalizeBeyCheckDeck(raw);
    if (!isBeyCheckDeckEmpty(deck)) return deck;
  }
  return null;
}

const BEY_CHECK_FIELD_FOLDER = {
  blade: "blades",
  lockChip: "lockChips",
  mainBlade: "mainBlades",
  metalBlade: "metalBlades",
  overBlade: "overBlades",
  assistBlade: "assistBlades",
  ratchet: "ratchets",
  bit: "bits"
};

// Resolve the asset folder for a part. Bits are special: after mergeBits()
// runs in core.js, DATA.bits contains both normal bits and ratchet-bits, and
// each item carries its own _folder ("bits" vs "ratchetBits") — so picking
// the right path means looking the item up rather than using the field map.
// Parts with modes (e.g. Scorpio Spear, Turbo, Operate) have mode-suffixed
// image filenames (Name0.webp, Name1.webp …); fall back to the item's
// currentMode (default 0) so the image actually loads.
function beyCheckPartImg(field, name) {
  if (!name || name === NO_RATCHET) return null;
  const arr = getBeyCheckPartList(field);
  const item = arr && arr.find(it => it.name === name);
  const folder = (item && item._folder) || BEY_CHECK_FIELD_FOLDER[field];
  if (!folder) return null;
  const hasModes = item && Array.isArray(item.modes) && item.modes.length > 0;
  const modeIdx = hasModes ? (typeof item.currentMode === "number" ? item.currentMode : 0) : null;
  return partImgPath(folder, name, modeIdx);
}

function renderBeyCheckSlotParts(slot) {
  const mode = (slot && BEY_CHECK_MODES.includes(slot.mode)) ? slot.mode : "standard";
  const parts = (slot && slot.parts) || {};
  return BEY_CHECK_FIELDS[mode]
    .filter(f => parts[f] && parts[f] !== NO_RATCHET)
    .map(f => {
      const name = parts[f];
      const src = beyCheckPartImg(f, name);
      const imgHtml = src
        ? `<img src="${src}" alt="${escapeHtml(name)}" class="bey-check-part-img" onerror="this.style.display='none'">`
        : "";
      return `
        <div class="bey-check-part">
          <div class="bey-check-part-img-box">${imgHtml}</div>
          <span class="bey-check-part-name">${escapeHtml(name)}</span>
        </div>`;
    })
    .join("");
}

function renderBeyCheckSlot(slotIdx, slot) {
  const empty = isBeyCheckSlotEmpty(slot);
  const body = empty
    ? `<div class="bey-check-slot-summary">Empty — tap to build</div>`
    : `<div class="bey-check-slot-parts">${renderBeyCheckSlotParts(slot)}</div>`;
  return `
    <button type="button" class="bey-check-slot${empty ? " bey-check-slot-empty" : ""}" data-slot="${slotIdx}">
      <div class="bey-check-slot-label">Slot ${slotIdx + 1}</div>
      ${body}
    </button>
  `;
}

// Wire the calculator-style searchable dropdowns (makeSearchable + the
// ratchet→bit filter coupling) onto the popup's three mode forms once. Run
// at module load — the popup elements live in index.html so they exist as
// soon as this script executes.
(function initBeyCheckSlotForms() {
  if (typeof makeSearchable !== "function") return;
  const noRatchetChoice = [{ value: NO_RATCHET, label: "No Ratchet" }];

  const stdForm = document.getElementById("bey-check-form-standard");
  if (stdForm) {
    makeSearchable(stdForm.querySelector('[name="blade"]'), DATA.blades, b => b.name);
    makeSearchable(stdForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name, noRatchetChoice);
    makeSearchable(stdForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  }

  const cxForm = document.getElementById("bey-check-form-cx");
  if (cxForm) {
    makeSearchable(cxForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
    makeSearchable(cxForm.querySelector('[name="mainBlade"]'), DATA.mainBlades, mb => mb.name);
    makeSearchable(cxForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
    makeSearchable(cxForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name, noRatchetChoice);
    makeSearchable(cxForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  }

  const cxeForm = document.getElementById("bey-check-form-cxExpand");
  if (cxeForm) {
    makeSearchable(cxeForm.querySelector('[name="lockChip"]'), DATA.lockChips, lc => lc.name);
    makeSearchable(cxeForm.querySelector('[name="metalBlade"]'), DATA.metalBlades, mb => mb.name);
    makeSearchable(cxeForm.querySelector('[name="overBlade"]'), DATA.overBlades, ob => ob.name);
    makeSearchable(cxeForm.querySelector('[name="assistBlade"]'), DATA.assistBlades, ab => ab.name);
    makeSearchable(cxeForm.querySelector('[name="ratchet"]'), DATA.ratchets, r => r.name, noRatchetChoice);
    makeSearchable(cxeForm.querySelector('[name="bit"]'), DATA.bits, b => b.name);
  }

  // Picking "No Ratchet" flips the bit list to ratchet-bits, mirroring the
  // calculator. Standard form additionally honors Bullet Griffon (forced no
  // ratchet, normal-bit only) so it matches the calculator's blade rules.
  ["bey-check-form-standard", "bey-check-form-cx", "bey-check-form-cxExpand"].forEach(id => {
    const form = document.getElementById(id);
    if (!form) return;
    const ratchetSel = form.querySelector('[name="ratchet"]');
    if (ratchetSel) {
      ratchetSel.addEventListener("change", () => applyBitFilter(form));
      applyBitFilter(form);
    }
    // Auto-advance to the next field after a real selection. Skipped during
    // restoreBeyCheckForm and skipped when the value clears (filter rejection
    // or user wiping a field).
    form.querySelectorAll("select").forEach(sel => {
      sel.addEventListener("change", () => {
        if (beyCheckSuppressAdvance) return;
        if (!sel.value) return;
        advanceBeyCheckField(sel);
      });
    });
  });

  if (stdForm) {
    const bladeSel = stdForm.querySelector('[name="blade"]');
    const ratchetWrapper = stdForm.querySelector('[name="ratchet"]').nextElementSibling;
    const ratchetInput = ratchetWrapper && ratchetWrapper.querySelector("input");
    const bitWrapper = stdForm.querySelector('[name="bit"]').nextElementSibling;
    const bitInput = bitWrapper && bitWrapper.querySelector("input");
    bladeSel?.addEventListener("change", () => {
      const idx = bladeSel.value;
      const codename = idx !== "" && DATA.blades[idx] ? DATA.blades[idx].codename : "";
      if (codename === "BULLETGRIFFON") {
        if (ratchetWrapper) {
          ratchetWrapper._filterFn = null;
          ratchetWrapper._select(NO_RATCHET);
          if (ratchetInput) ratchetInput.disabled = true;
        }
        if (bitWrapper) bitWrapper._setFilter(b => !b.isRatchetBit);
        if (bitInput) bitInput.disabled = false;
      } else if (codename === "CLOCKMIRAGE") {
        if (ratchetWrapper) {
          ratchetWrapper._setFilter(r => r.name.endsWith("5"));
          if (ratchetInput) { ratchetInput.disabled = false; ratchetInput.placeholder = "-- Select --"; }
        }
        if (bitWrapper) bitWrapper._setFilter(b => !b.isRatchetBit);
        if (bitInput) { bitInput.disabled = false; bitInput.placeholder = "-- Select --"; }
      } else {
        if (ratchetWrapper) {
          ratchetWrapper._filterFn = null;
          if (ratchetInput) { ratchetInput.disabled = false; ratchetInput.placeholder = "-- Select --"; }
        }
        if (bitInput) { bitInput.disabled = false; bitInput.placeholder = "-- Select --"; }
        applyBitFilter(stdForm);
      }
    });
  }
})();

// Per-form field order for auto-advance in the bey check slot popup.
// Mirrors the calculator's NEXT_DROPDOWN, but jumps directly to the next
// field (no __BOTTOM__ scrolling intermediate — the slot popup is short).
const BEY_CHECK_NEXT_FIELD = {
  "bey-check-form-standard": { blade: "ratchet", ratchet: "bit", bit: null },
  "bey-check-form-cx": {
    lockChip: "mainBlade", mainBlade: "assistBlade", assistBlade: "ratchet",
    ratchet: "bit", bit: null
  },
  "bey-check-form-cxExpand": {
    lockChip: "metalBlade", metalBlade: "overBlade", overBlade: "assistBlade",
    assistBlade: "ratchet", ratchet: "bit", bit: null
  }
};

// Suppresses auto-advance during restoreBeyCheckForm so pre-loaded values
// don't fight each other for focus. User-initiated changes still advance.
let beyCheckSuppressAdvance = false;

function advanceBeyCheckField(sel) {
  const form = sel.closest("form");
  if (!form) return;
  const map = BEY_CHECK_NEXT_FIELD[form.id];
  if (!map) return;
  const nextName = map[sel.getAttribute("name")];
  if (!nextName) return;
  const wrapper = form.querySelector(`[name="${nextName}"]`)?.nextElementSibling;
  const input = wrapper && wrapper.querySelector("input");
  if (!input || input.disabled) return;
  // rAF: let the dropdown's own close() and DOM updates settle before
  // scrolling/focusing. block: "center" works against the popup card's
  // own overflow-y: auto, so the popup scrolls — not the page.
  requestAnimationFrame(() => {
    wrapper.scrollIntoView({ behavior: "smooth", block: "center" });
    input.focus();
  });
}

function clearBeyCheckForm(form) {
  if (!form) return;
  form.querySelectorAll(".search-dropdown").forEach(w => { if (w._clear) w._clear(); });
  // Re-enable any dropdown that the BG/CM rules may have disabled.
  form.querySelectorAll(".search-dropdown input").forEach(input => {
    input.disabled = false;
    input.placeholder = "-- Select --";
  });
  applyBitFilter(form);
}

function restoreBeyCheckForm(form, slot) {
  if (!form) return;
  clearBeyCheckForm(form);
  const fields = BEY_CHECK_FIELDS[slot.mode] || [];
  // Order matters: write blade/lockChip first so any change-driven rules
  // (Bullet Griffon, ratchet→bit filter) settle before we set ratchet/bit.
  const order = ["blade", "lockChip", "mainBlade", "metalBlade", "overBlade", "assistBlade", "ratchet", "bit"]
    .filter(f => fields.includes(f));
  beyCheckSuppressAdvance = true;
  try {
    order.forEach(name => {
      const sel = form.querySelector(`[name="${name}"]`);
      if (!sel) return;
      const wrapper = sel.nextElementSibling;
      if (!wrapper || typeof wrapper._select !== "function") return;
      const value = slot.parts && slot.parts[name];
      if (!value) return;
      if (value === NO_RATCHET) { wrapper._select(NO_RATCHET); return; }
      const arr = getBeyCheckPartList(name);
      const idx = arr.findIndex(it => it.name === value);
      if (idx >= 0) wrapper._select(idx);
    });
  } finally {
    beyCheckSuppressAdvance = false;
  }
}

function readBeyCheckForm(form, mode) {
  const parts = {};
  if (!form) return { mode, parts };
  BEY_CHECK_FIELDS[mode].forEach(name => {
    const sel = form.querySelector(`[name="${name}"]`);
    if (!sel) return;
    const val = sel.value;

    // Primary path: the search dropdown set sel.value = item index when the
    // user clicked an option.
    if (val !== "" && val != null) {
      if (val === NO_RATCHET) { parts[name] = NO_RATCHET; return; }
      const arr = getBeyCheckPartList(name);
      const idx = Number(val);
      if (Number.isInteger(idx) && arr[idx]) { parts[name] = arr[idx].name; return; }
    }

    // Fallback: the user typed a name into the searchable input but the
    // option didn't latch on the underlying <select> (can happen on mobile
    // if Save is tapped before the option's mousedown registers). Match the
    // typed text against item names so the save isn't silently dropped.
    const wrapper = sel.nextElementSibling;
    const input = wrapper && wrapper.querySelector("input");
    const text = input && input.value && input.value.trim();
    if (!text) return;
    if (text.toLowerCase() === "no ratchet") { parts[name] = NO_RATCHET; return; }
    const arr = getBeyCheckPartList(name);
    const match = arr.find(it => it.name.toLowerCase() === text.toLowerCase());
    if (match) parts[name] = match.name;
  });
  return { mode, parts };
}

// Combo-builder sub-popup. Opens on top of the bey check popup; on Save it
// hands the working draft back to the caller via onSave(slot). Edits stay
// local to the draft until Save — Cancel discards. `deck` is the full 3-slot
// deck for the active side, used to detect duplicate parts at save time.
function showBeyCheckSlotPopup(slotIdx, slot, deck, onSave) {
  const popup = document.getElementById("bey-check-slot-popup");
  if (!popup) return;
  const subtitle = popup.querySelector("#bey-check-slot-subtitle");
  const tabs = popup.querySelectorAll(".bey-check-mode-tab");
  const forms = popup.querySelectorAll(".bey-check-mode-form");
  const statusEl = popup.querySelector("#bey-check-slot-status");
  const saveBtn = popup.querySelector("#bey-check-slot-save");
  const clearBtn = popup.querySelector("#bey-check-slot-clear");
  const cancelBtn = popup.querySelector("#bey-check-slot-cancel");

  if (subtitle) subtitle.textContent = `Slot ${slotIdx + 1}`;
  if (statusEl) statusEl.textContent = "";

  let activeMode = BEY_CHECK_MODES.includes(slot.mode) ? slot.mode : "standard";

  const showMode = (mode) => {
    activeMode = mode;
    tabs.forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
    forms.forEach(f => f.classList.toggle("hidden", f.dataset.mode !== mode));
  };

  // Reset every form so leftovers from a previous open don't bleed in,
  // then restore the saved slot into its matching mode form.
  forms.forEach(f => clearBeyCheckForm(f));
  const targetForm = popup.querySelector(`.bey-check-mode-form[data-mode="${activeMode}"]`);
  restoreBeyCheckForm(targetForm, slot);
  showMode(activeMode);

  tabs.forEach(t => {
    t.onclick = () => {
      // Switching modes wipes the working draft for the new mode — the user
      // is picking a different combo line, not editing the same parts.
      const next = t.dataset.mode;
      const nextForm = popup.querySelector(`.bey-check-mode-form[data-mode="${next}"]`);
      clearBeyCheckForm(nextForm);
      showMode(next);
    };
  });

  popup.classList.remove("hidden");

  const close = () => {
    popup.classList.add("hidden");
    saveBtn.onclick = null;
    clearBtn.onclick = null;
    cancelBtn.onclick = null;
    tabs.forEach(t => { t.onclick = null; });
  };

  cancelBtn.onclick = close;
  saveBtn.onclick = () => {
    const form = popup.querySelector(`.bey-check-mode-form[data-mode="${activeMode}"]`);
    const next = readBeyCheckForm(form, activeMode);
    const conflict = findBeyCheckPartConflict(next, deck, slotIdx);
    if (conflict) {
      if (statusEl) {
        statusEl.textContent = `"${conflict.name}" is already used in Slot ${conflict.slotIdx + 1}.`;
      }
      return;
    }
    onSave(next);
    close();
  };
  clearBtn.onclick = () => {
    // Clearing can never introduce a duplicate.
    if (statusEl) statusEl.textContent = "";
    onSave({ mode: activeMode, parts: {} });
    close();
  };
}

function showBeyCheckPopup(matchId) {
  const popup = document.getElementById("bey-check-popup");
  if (!popup) return;
  if (swissEditCode && !swissCanEdit) return; // viewers don't get bey check

  const state = loadSwiss();
  const match = state.matches[matchId];
  if (!match) return;
  if (match.bye) {
    alert(`${match.a} has a BYE this round.`);
    return;
  }
  if (!match.b) {
    // Bracket slot not yet filled — fall back to the original behavior so
    // the host can still go live / score whatever is there.
    startSwissMatch(matchId);
    return;
  }

  const subtitle = popup.querySelector("#bey-check-subtitle");
  const tabs = popup.querySelectorAll(".bey-check-tab");
  const slotsHost = popup.querySelector("#bey-check-slots");
  const status = popup.querySelector("#bey-check-status");
  const scoreBtn = popup.querySelector("#bey-check-score");
  const cancelBtn = popup.querySelector("#bey-check-cancel");

  if (subtitle) subtitle.textContent = `${match.a} vs ${match.b}`;
  tabs.forEach(t => {
    if (t.dataset.side === "a") t.textContent = match.a;
    else if (t.dataset.side === "b") t.textContent = match.b;
    t.classList.toggle("active", t.dataset.side === "a");
  });
  if (status) status.textContent = "";

  const decks = {
    a: normalizeBeyCheckDeck(match.decks && match.decks.a),
    b: normalizeBeyCheckDeck(match.decks && match.decks.b)
  };
  // Pre-fill priority: 1) what's already saved on this match (judge override
  // from earlier), 2) what the player registered up front, 3) carry-forward
  // from their most recent previous match. (3) is the legacy path for
  // tournaments started before self-registration existed.
  let carriedOver = false;
  let registeredFill = false;
  if (isBeyCheckDeckEmpty(decks.a) && match.a) {
    const reg = getRegisteredDeckForParticipant(state, match.a);
    if (reg) { decks.a = reg; registeredFill = true; }
    else {
      const prev = findLatestDeckForParticipant(state, match.a, matchId);
      if (prev) { decks.a = prev; carriedOver = true; }
    }
  }
  if (isBeyCheckDeckEmpty(decks.b) && match.b) {
    const reg = getRegisteredDeckForParticipant(state, match.b);
    if (reg) { decks.b = reg; registeredFill = true; }
    else {
      const prev = findLatestDeckForParticipant(state, match.b, matchId);
      if (prev) { decks.b = prev; carriedOver = true; }
    }
  }
  let activeSide = "a";

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  // Push the full decks subtree for this match. Direct user action, so we
  // don't gate on swissApplyingRemote (that flag exists to prevent echo
  // loops on listener-driven writes — bey check is user-driven). Surfaces
  // success / failure visibly so it's obvious whether Firebase received it.
  const pushDecksToFirebase = () => {
    if (!swissRoomRef) {
      setStatus("Saved locally — no live room to sync.", "ok");
      return;
    }
    if (!swissCanEdit) {
      setStatus("View-only — can't write.", "err");
      return;
    }
    setStatus("Saving…", "pending");
    swissRoomRef.update({
      [`matches/${matchId}/decks`]: { a: decks.a, b: decks.b }
    }).then(() => {
      setStatus("Saved to Firebase ✓", "ok");
      setTimeout(() => setStatus(""), 1500);
    }).catch(e => {
      console.warn("Bey check push failed:", e);
      setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
    });
  };

  const persistDecks = () => {
    const s = loadSwiss();
    if (!s.matches[matchId]) return;
    s.matches[matchId].decks = { a: decks.a, b: decks.b };
    persistSwiss(s);
    pushDecksToFirebase();
  };

  const renderSlots = () => {
    const deck = decks[activeSide];
    slotsHost.innerHTML = deck.map((s, i) => renderBeyCheckSlot(i, s)).join("");
    slotsHost.querySelectorAll(".bey-check-slot").forEach(el => {
      el.addEventListener("click", () => {
        const slotIdx = Number(el.dataset.slot);
        const sideAtOpen = activeSide;
        showBeyCheckSlotPopup(slotIdx, decks[sideAtOpen][slotIdx], decks[sideAtOpen], (next) => {
          decks[sideAtOpen][slotIdx] = next;
          if (sideAtOpen === activeSide) renderSlots();
          persistDecks();
        });
      });
    });
  };
  renderSlots();

  tabs.forEach(t => {
    t.onclick = () => {
      activeSide = t.dataset.side;
      tabs.forEach(o => o.classList.toggle("active", o === t));
      renderSlots();
    };
  });

  popup.classList.remove("hidden");

  if (carriedOver || registeredFill) {
    // Write the inherited decks to this match's record so other devices
    // see them too, then surface a brief notice in the status line. The
    // registered-deck path also shows a persistent warning that edits
    // here only affect this single match — they don't change the
    // participant's registered deck.
    const s = loadSwiss();
    if (s.matches[matchId]) {
      s.matches[matchId].decks = { a: decks.a, b: decks.b };
      persistSwiss(s);
    }
    const sourceLabel = registeredFill ? "registered deck" : "previous match";
    if (swissRoomRef && swissCanEdit) {
      setStatus(`Loading from ${sourceLabel}…`, "pending");
      swissRoomRef.update({
        [`matches/${matchId}/decks`]: { a: decks.a, b: decks.b }
      }).then(() => {
        if (registeredFill) {
          setStatus("Loaded registered deck — edits apply to this match only.", "ok");
        } else {
          setStatus("Loaded last deck ✓", "ok");
          setTimeout(() => setStatus(""), 1800);
        }
      }).catch(e => {
        console.warn("Bey check carry-over push failed:", e);
        setStatus("Save failed: " + (e && e.message ? e.message : e), "err");
      });
    } else if (registeredFill) {
      setStatus("Loaded registered deck — edits apply to this match only.", "ok");
    } else {
      setStatus("Loaded last deck (local only).", "ok");
      setTimeout(() => setStatus(""), 1800);
    }
  }

  const close = () => {
    popup.classList.add("hidden");
    scoreBtn.onclick = null;
    cancelBtn.onclick = null;
    tabs.forEach(t => { t.onclick = null; });
  };

  cancelBtn.onclick = close;
  scoreBtn.onclick = () => {
    close();
    startSwissMatch(matchId);
  };
}

function showEditTournamentNamePopup() {
  const popup = document.getElementById("edit-tournament-name-popup");
  if (!popup) return;
  const input = popup.querySelector("#edit-tournament-name-input");
  const saveBtn = popup.querySelector("#edit-tournament-name-save");
  const cancelBtn = popup.querySelector("#edit-tournament-name-cancel");
  const state = loadSwiss();
  if (input) input.value = state.tournamentName || "";
  popup.classList.remove("hidden");
  setTimeout(() => { input?.focus(); input?.select(); }, 0);

  const close = () => {
    popup.classList.add("hidden");
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    if (input) input.onkeydown = null;
  };

  const save = () => {
    const next = (input?.value || "").trim();
    const s = loadSwiss();
    const current = s.tournamentName || "";
    if (next === current) { close(); return; }
    s.tournamentName = next || null;
    persistSwiss(s);
    if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
      swissRoomRef.update({ tournamentName: next || null })
        .catch(e => console.warn("Tournament name push failed:", e));
    }
    renderSwiss();
    close();
  };

  cancelBtn.onclick = close;
  saveBtn.onclick = save;
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    };
  }
}

// Whether the "Add Participant" affordance is available. Single-elim
// regenerates, so it allows it any time. Swiss AND round robin only take new
// players during round 1 — once any group has generated round 2, it closes.
function canAddParticipant(state) {
  if (!state) return false;
  if (state.mode === "single-elim") return true;
  if (!Array.isArray(state.groups) || !state.groups.length) return true;
  const maxRound = state.groups.reduce((m, _, gi) => Math.max(m, state.groupRounds[gi] || 0), 0);
  return maxRound <= 1; // 1 = only round 1 (index 0) generated
}

// Add a participant to a Swiss or round-robin tournament still in round 1, no
// reset. The newcomer enters round 1 as a free win (a bye) — UNLESS a bye
// already exists in round 1, in which case they're paired against that bye
// player, turning the existing free win into a real match. True on success.
function addSwissParticipantRound1(name, deck) {
  const s = loadSwiss();
  if (!Array.isArray(s.groups) || !s.groups.length) return false;
  if (!canAddParticipant(s)) {
    alert("Participants can only be added during round 1 — round 2 has already started.");
    return false;
  }
  // Look for an existing round-1 bye (free win) to pair the newcomer into.
  let byeMatch = null;
  for (const m of Object.values(s.matches || {})) {
    if (m && m.round === 0 && m.bye && m.a && m.b == null) { byeMatch = m; break; }
  }
  const updates = {};
  let target;
  if (byeMatch) {
    // A free win already exists — pair the newcomer against that player. The
    // bye match becomes a real, unscored round-1 match.
    target = byeMatch.groupIndex;
    byeMatch.b = name;
    byeMatch.bye = false;
    updates[`matches/${byeMatch.id}/b`] = name;
    updates[`matches/${byeMatch.id}/bye`] = false;
  } else {
    // No free win yet — the newcomer joins the smallest group and takes a
    // round-1 bye (free win) of their own.
    target = 0;
    for (let i = 1; i < s.groups.length; i++) {
      if (s.groups[i].length < s.groups[target].length) target = i;
    }
    const idx = Object.values(s.matches || {})
      .filter(m => m && m.groupIndex === target && m.round === 0).length;
    const id = `g${target}-r0-m${idx}`;
    const byeM = { id, groupIndex: target, round: 0, a: name, b: null, scoreA: null, scoreB: null, bye: true };
    s.matches[id] = byeM;
    updates[`matches/${id}`] = byeM;
  }
  s.groups[target].push(name);
  // Keep the canonical participant list in sync (getParticipants falls back to
  // groups.flat() only when `participants` is absent).
  if (Array.isArray(s.participants)) s.participants.push(name);
  if (!s.registrants || typeof s.registrants !== "object") s.registrants = {};
  const regId = generateRegistrantId();
  s.registrants[regId] = { name, deck };
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    // Targeted update — only the touched group, match, participant list and
    // the new registrant. Nothing else in the room is rewritten.
    updates[`groups/${target}`] = s.groups[target];
    updates[`registrants/${regId}`] = { name, deck };
    if (Array.isArray(s.participants)) updates.participants = s.participants;
    swissRoomRef.update(updates).catch(e => console.warn("Add participant push failed:", e));
  }
  return true;
}

// Add a single participant — name + a 3-combo deck — to a running tournament.
// Swiss slots the player into round 1 as a free win, no reset (see
// addSwissParticipantRound1). Single-elim and round robin have no open slot,
// so they regenerate from scratch after an explicit confirm.
function showAddParticipantPopup() {
  const popup = document.getElementById("edit-participants-popup");
  if (!popup) return;
  const nameInput = popup.querySelector("#add-participant-name");
  const slotsHost = popup.querySelector("#add-participant-deck-slots");
  const status = popup.querySelector("#edit-participants-status");
  const saveBtn = popup.querySelector("#edit-participants-save");
  const cancelBtn = popup.querySelector("#edit-participants-cancel");
  const pasteBtn = popup.querySelector("#add-participant-paste");

  const state = loadSwiss();
  const current = getParticipants(state);
  let deck = emptyBeyCheckDeck();

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  if (nameInput) nameInput.value = "";
  setStatus("");

  const renderSlots = () => {
    if (!slotsHost) return;
    slotsHost.innerHTML = deck.map((s, i) => renderBeyCheckSlot(i, s)).join("");
    slotsHost.querySelectorAll(".bey-check-slot").forEach(el => {
      el.addEventListener("click", () => {
        const slotIdx = Number(el.dataset.slot);
        showBeyCheckSlotPopup(slotIdx, deck[slotIdx], deck, (next) => {
          deck[slotIdx] = next;
          renderSlots();
        });
      });
    });
  };
  renderSlots();

  popup.classList.remove("hidden");
  setTimeout(() => nameInput?.focus(), 0);

  const close = () => {
    popup.classList.add("hidden");
    saveBtn.onclick = null;
    cancelBtn.onclick = null;
    if (pasteBtn) pasteBtn.onclick = null;
    if (nameInput) nameInput.onkeydown = null;
  };
  cancelBtn.onclick = close;

  // Paste a deck copied from the Deck tab (same payload the registration
  // popup accepts) straight into the slots.
  if (pasteBtn) {
    pasteBtn.onclick = () => {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        setStatus("Clipboard read isn't available in this browser.", "err");
        return;
      }
      navigator.clipboard.readText().then(text => {
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        if (!parsed || parsed.type !== "x-optimizer-deck" || !Array.isArray(parsed.deck)) {
          setStatus("Clipboard doesn't contain a copied deck. Hit Copy in the Deck tab first.", "err");
          return;
        }
        deck = normalizeBeyCheckDeck(parsed.deck);
        renderSlots();
        const label = parsed.name ? ` "${parsed.name}"` : "";
        setStatus(`Pasted deck${label} — review before adding.`, "ok");
      }).catch(() => {
        setStatus("Couldn't read the clipboard. Did you allow the permission?", "err");
      });
    };
  }

  const submit = () => {
    const name = (nameInput?.value || "").trim();
    if (!name) {
      setStatus("Enter a name.", "err");
      nameInput?.focus();
      return;
    }
    if (current.some(n => n.toLowerCase() === name.toLowerCase())) {
      setStatus("That name is already in the tournament.", "err");
      return;
    }
    if (isBeyCheckDeckEmpty(deck)) {
      // Soft-warn but allow — the judge can still fill the deck at match time.
      if (!confirm(`"${name}" has no deck slots filled. Add anyway?`)) return;
    }

    // Swiss and round robin slot a player into round 1 as a free win (or pair
    // them against an existing round-1 bye), no reset. Single-elim has a fixed
    // bracket with no open slot, so it regenerates.
    const hasGroups = Array.isArray(state.groups) && state.groups.length;
    const canSlotIn = state.mode !== "single-elim" && hasGroups;
    if (canSlotIn) {
      if (!addSwissParticipantRound1(name, deck)) return; // helper alerted
      renderSwiss();
      close();
      return;
    }

    const names = current.concat([name]);
    const isRR = state.pairing === "round-robin";
    const reason = isRR
      ? "a round robin re-pairs everyone against everyone, so it"
      : "a single-elimination bracket can't take a new player mid-tournament, so it";
    const msg = `Adding "${name}" brings the tournament to ${names.length} participants. ` +
                `Because ${reason} will be regenerated — all current matches and scores will be lost. Continue?`;
    if (!confirm(msg)) return;
    let next;
    if (state.mode === "single-elim") {
      next = generateSingleElimFromText(names.join("\n"), state.tournamentName);
    } else {
      next = generateSwissFromText(names.join("\n"), state.tournamentName,
        getRoundCount(state), getGroupCount(state), state.pairing);
      if (next && state.mode === "swiss-only") next.mode = "swiss-only";
    }
    if (!next) return; // generator already alerted
    if (typeof state.ranked === "boolean") next.ranked = state.ranked;
    next.hostUid = state.hostUid || null;
    // Carry registrants forward so existing players keep their registered
    // decks, then add the new player's registrant entry.
    next.registrants = { ...(state.registrants || {}) };
    next.registrants[generateRegistrantId()] = { name, deck };
    persistSwiss(next);
    if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
      const payload = { ...next };
      if (swissViewCode) payload.viewCode = swissViewCode;
      swissRoomRef.set(payload).catch(e => console.warn("Add participant push failed:", e));
    }
    renderSwiss();
    close();
  };
  saveBtn.onclick = submit;
  if (nameInput) {
    nameInput.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    };
  }
}

function showSwissRoundsPopup(onPick) {
  const popup = document.getElementById("swiss-rounds-popup");
  if (!popup) { onPick(SWISS_ROUND_COUNT); return; }
  const options = popup.querySelector(".swiss-rounds-options");
  const cancelBtn = popup.querySelector("#swiss-rounds-cancel");
  const close = (rc) => {
    popup.classList.add("hidden");
    if (options) options.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (rc != null) onPick(rc);
  };
  if (options) {
    options.onclick = (e) => {
      const btn = e.target.closest(".swiss-rounds-btn");
      if (!btn) return;
      const n = Number(btn.dataset.rounds);
      close(SWISS_ROUND_OPTIONS.includes(n) ? n : SWISS_ROUND_COUNT);
    };
  }
  if (cancelBtn) cancelBtn.onclick = () => close(null);
  popup.classList.remove("hidden");
}

function showSwissGroupsPopup(onPick) {
  const popup = document.getElementById("swiss-groups-popup");
  if (!popup) { onPick(SWISS_GROUP_COUNT_DEFAULT); return; }
  const options = popup.querySelector(".swiss-groups-options");
  const cancelBtn = popup.querySelector("#swiss-groups-cancel");
  const close = (gc) => {
    popup.classList.add("hidden");
    if (options) options.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (gc != null) onPick(gc);
  };
  if (options) {
    options.onclick = (e) => {
      const btn = e.target.closest(".swiss-groups-btn");
      if (!btn) return;
      const n = Number(btn.dataset.groups);
      close(SWISS_GROUP_OPTIONS.includes(n) ? n : SWISS_GROUP_COUNT_DEFAULT);
    };
  }
  if (cancelBtn) cancelBtn.onclick = () => close(null);
  popup.classList.remove("hidden");
}

// Yes / No follow-up that asks whether the Swiss tournament should end in
// a Top 8 knockout. Resolves the callback with the corresponding mode key
// ("swiss" = with Top 8, "swiss-only" = without).
function showTopEightPopup(onPick, isRoundRobin) {
  const popup = document.getElementById("tournament-top-eight-popup");
  if (!popup) { onPick("swiss"); return; }
  const yesBtn = popup.querySelector("#tournament-top-eight-yes");
  const noBtn = popup.querySelector("#tournament-top-eight-no");
  const cancelBtn = popup.querySelector("#tournament-top-eight-cancel");
  // The "No" choice keeps just the group stage — label it for the format.
  const noName = noBtn && noBtn.querySelector(".tournament-mode-name");
  if (noName) noName.textContent = isRoundRobin ? "No — Round Robin only" : "No — Swiss only";
  const teardown = () => {
    popup.classList.add("hidden");
    if (yesBtn) yesBtn.onclick = null;
    if (noBtn) noBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
  };
  if (yesBtn) yesBtn.onclick = () => { teardown(); onPick("swiss"); };
  if (noBtn) noBtn.onclick = () => { teardown(); onPick("swiss-only"); };
  if (cancelBtn) cancelBtn.onclick = () => { teardown(); onPick(null); };
  popup.classList.remove("hidden");
}

function showTournamentModePopup(onPick) {
  const popup = document.getElementById("tournament-mode-popup");
  if (!popup) { onPick("swiss", "", SWISS_ROUND_COUNT); return; } // popup missing, fall back to swiss
  const swissBtn = popup.querySelector("#tournament-mode-swiss");
  const rrBtn = popup.querySelector("#tournament-mode-roundrobin");
  const singleBtn = popup.querySelector("#tournament-mode-single");
  const cancelBtn = popup.querySelector("#tournament-mode-cancel");
  const nameInput = popup.querySelector("#tournament-name-input");
  if (nameInput) nameInput.value = "";
  const teardown = () => {
    popup.classList.add("hidden");
    swissBtn.onclick = null;
    if (rrBtn) rrBtn.onclick = null;
    singleBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  // Every tournament is ranked now — no password gate. Pass ranked=true
  // through unchanged for compatibility with existing call sites.
  swissBtn.onclick = () => {
    const name = nameInput ? nameInput.value.trim() : "";
    teardown();
    // Ask whether to add a Top 8 bracket after the group stage.
    showTopEightPopup((mode) => {
      if (!mode) return; // user cancelled at the Top 8 step
      showSwissRoundsPopup((rc) => {
        showSwissGroupsPopup((gc) => onPick(mode, name, rc, true, gc));
      });
    });
  };
  if (rrBtn) rrBtn.onclick = () => {
    const name = nameInput ? nameInput.value.trim() : "";
    teardown();
    // Round robin asks Top 8 + group count, but skips the round picker —
    // rounds are fixed by group size (everyone plays everyone once).
    showTopEightPopup((mode) => {
      if (!mode) return;
      showSwissGroupsPopup((gc) => onPick(mode, name, undefined, true, gc, "round-robin"));
    }, true);
  };
  singleBtn.onclick = () => {
    const name = nameInput ? nameInput.value.trim() : "";
    teardown();
    onPick("single-elim", name, undefined, true, undefined);
  };
  cancelBtn.onclick = () => teardown();
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
    // Index it under the host's account so it shows in "My Tournaments" on
    // any device they sign in on.
    if (next.hostUid) publishUserTournament(next.hostUid, editCode, { ...next, viewCode });
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

// Persist a snapshot of the current live tournament state onto its history
// entry so the entry stays viewable after the Firebase room is wiped (e.g.
// host reset). The snapshot drops the `viewCode` metadata field — that's a
// room-routing detail, not part of the tournament model.
function cacheTournamentSnapshotInHistory(editCode, state) {
  if (!editCode || !state) return;
  let list = loadTournamentHistory();
  const idx = list.findIndex(e => tournamentHistoryKey(e) === editCode);
  if (idx === -1) return; // no entry to attach the cache to
  const { viewCode, ...cleanState } = state;
  list[idx] = { ...list[idx], cachedState: cleanState };
  try {
    localStorage.setItem(TOURNAMENT_HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    // localStorage quota exceeded — drop the cache silently rather than
    // breaking the reset flow.
    console.warn("Couldn't cache tournament snapshot:", e);
  }
}

function findCachedTournamentByCode(code) {
  if (!code) return null;
  const upper = String(code).toUpperCase();
  const list = loadTournamentHistory();
  const entry = list.find(e =>
    String(e.editCode || "").toUpperCase() === upper ||
    String(e.viewCode || "").toUpperCase() === upper
  );
  return (entry && entry.cachedState) || null;
}

document.getElementById("swiss-generate")?.addEventListener("click", async () => {
  // Hosting requires a signed-in account. requireSignIn returns the
  // current user (or pops the sign-in modal first). If the user cancels
  // we silently bail.
  let user = null;
  try {
    if (typeof window.requireSignIn === "function") {
      user = await window.requireSignIn({
        subtitle: "Sign in with your email to host a tournament."
      });
    }
  } catch (e) {
    return; // user cancelled the sign-in modal
  }
  showTournamentModePopup((mode, tournamentName, roundCount, ranked, groupCount, pairing) => {
    // Open Registration only — empty room in registering phase. Players
    // self-register with their decks via the Rooms tab, then the host
    // clicks Start to generate groups / bracket from the registrants.
    const next = createRegisteringTournamentState({
      mode, tournamentName, roundCount, ranked, groupCount, pairing, hostUid: user ? user.uid : null
    });
    startTournamentFromState(next);
  });
});

// Build the empty-shell tournament state for the open-registration flow.
// Stores the format choices up front so participants signing up via the
// Room tab can see exactly what they're entering. The `hostUid` is the
// Firebase Auth uid of the user creating the tournament — Reset / Start
// flows check it to ensure only the original host (signed into the same
// account on any device) can wipe or kick off the room.
function createRegisteringTournamentState({ mode, tournamentName, roundCount, ranked, groupCount, pairing, hostUid }) {
  const safeMode = mode === "single-elim" ? "single-elim"
    : mode === "swiss-only" ? "swiss-only"
    : "swiss";
  const state = {
    groups: null,
    matches: {},
    groupRounds: [],
    mode: safeMode,
    participants: [],
    tournamentName: (tournamentName || "").trim() || null,
    ranked: !!ranked,
    phase: "registering",
    registrants: {},
    createdAt: new Date().toISOString(),
    hostUid: hostUid || null
  };
  if (safeMode !== "single-elim") {
    state.groupCount = SWISS_GROUP_OPTIONS.includes(Number(groupCount))
      ? Number(groupCount) : SWISS_GROUP_COUNT_DEFAULT;
    // Round robin derives its rounds from group size, so it skips roundCount.
    if (pairing === "round-robin") {
      state.pairing = "round-robin";
    } else {
      state.roundCount = SWISS_ROUND_OPTIONS.includes(Number(roundCount))
        ? Number(roundCount) : SWISS_ROUND_COUNT;
    }
  }
  return state;
}

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
  if (state?.mode === "swiss" || state?.mode === "single-elim") {
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
  const modeLabel = tournamentFormatLabel(state.mode, state.pairing, false);
  const header = `
    <div class="tournament-results-heading">
      <div class="tournament-results-name">${name}</div>
      <div class="tournament-results-mode">${escapeHtml(modeLabel)}</div>
    </div>
  `;
  // Append the parts-usage pie charts whenever any deck data exists in this
  // tournament — useful in the history popup even before final placements.
  const partsCharts = renderPartUsageCharts(state);

  // Swiss-only mode never produces knockout placements — its result is the
  // combined cross-group standings instead.
  if (state.mode === "swiss-only") {
    const standings = computeCombinedSwissStandings(state);
    if (!standings.length) {
      return header + `<p class="tournament-results-empty">This tournament hasn't started yet — come back once group rounds are played.</p>` + partsCharts;
    }
    const groupLetter = i => String.fromCharCode(65 + i);
    const rows = standings.map((s, i) => {
      const place = i + 1;
      const placeMod = place <= 3 ? ` tournament-results-place-${place}` : "";
      const record = `${s.wins}-${s.losses}${s.draws ? `-${s.draws}` : ""}`;
      return `
        <div class="tournament-results-row swiss-final-row${placeMod}">
          <span class="tournament-results-place">${placementLabel(place)}</span>
          <span class="tournament-results-player">${escapeHtml(s.name || "—")}</span>
          <span class="swiss-final-group">Group ${groupLetter(s.groupIndex)}</span>
          <span class="swiss-final-record">${record}</span>
        </div>
      `;
    }).join("");
    return header + `<div class="tournament-results-list">${rows}</div>` + partsCharts;
  }
  const placements = computeTournamentPlacements(state);
  if (!placements.length) {
    return header + `<p class="tournament-results-empty">This tournament hasn't reached the knockout placements yet — come back when the bracket finishes.</p>` + partsCharts;
  }
  const rows = placements.map(p => `
    <div class="tournament-results-row tournament-results-place-${p.place}">
      <span class="tournament-results-place">${placementLabel(p.place)}</span>
      <span class="tournament-results-player">${escapeHtml(p.name || "—")}</span>
    </div>
  `).join("");
  return header + `<div class="tournament-results-list">${rows}</div>` + partsCharts;
}

function showTournamentResultsFromHistory(code) {
  const popup = document.getElementById("tournament-results-popup");
  const body = document.getElementById("tournament-results-body");
  if (!popup || !body) return;
  body.innerHTML = `<p class="tournament-results-loading">Loading results…</p>`;
  popup.classList.remove("hidden");
  // Cached snapshot saved on host reset — used as a fallback when Firebase
  // has no record (e.g. the room was cleared). For live-and-running rooms
  // we still prefer the Firebase fetch so the results stay current.
  const wirePartUsageCarousels = () => {
    if (typeof setupDashboardCarousel === "function") {
      body.querySelectorAll(".part-usage-carousel").forEach(setupDashboardCarousel);
    }
  };
  const cached = findCachedTournamentByCode(code);
  if (!firebaseReady()) {
    if (cached) { body.innerHTML = renderTournamentResultsMarkup(cached); wirePartUsageCarousels(); return; }
    body.innerHTML = `<p class="tournament-results-empty">Live sync isn't configured on this build, so results can't be fetched.</p>`;
    return;
  }
  fetchTournamentState(code.toUpperCase(), state => {
    if (state) {
      body.innerHTML = renderTournamentResultsMarkup(state);
      wirePartUsageCarousels();
      return;
    }
    if (cached) {
      body.innerHTML = renderTournamentResultsMarkup(cached);
      wirePartUsageCarousels();
      return;
    }
    body.innerHTML = `<p class="tournament-results-empty">Couldn't find this tournament. It may have been cleared.</p>`;
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

// Re-join a previously connected room on page load.
window.addEventListener("load", initSwissRoomOnLoad);

// The room badge shows the signed-in user's profile username — re-render it
// once the profile loads or changes.
window.addEventListener("userprofilechange", () => {
  if (document.getElementById("swiss-view")) renderSwiss();
});

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

(function initTournamentSubTabs() {
  const tabs = document.querySelectorAll(".tournament-sub-tab");
  if (!tabs.length) return;
  const panels = document.querySelectorAll(".tournament-panel");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.tournamentView;
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panels.forEach(p => p.classList.toggle("hidden", p.id !== "tournament-panel-" + view));
      if (view === "ranking") renderTournamentRanking();
      // Coming back to Hosting? Refresh the open-tournaments list so it
      // doesn't sit stale while the user is poking at other tabs. Only
      // matters when the setup form is actually visible (i.e. the user
      // isn't currently inside a tournament).
      if (view === "hosting") {
        const setup = document.getElementById("swiss-setup");
        if (setup && !setup.classList.contains("hidden")) {
          refreshOpenTournamentRooms();
          refreshMyTournaments();
        }
      }
    });
  });
  document.getElementById("swiss-rooms-refresh")?.addEventListener("click", () => {
    refreshOpenTournamentRooms();
    refreshMyTournaments();
  });
  // Re-list the host's own tournaments whenever auth resolves or changes —
  // this also fires once at boot, populating the list on first load.
  if (typeof onAuthChange === "function") {
    onAuthChange(() => refreshMyTournaments());
  }
})();

// ===== "My Tournaments": an account-scoped index so a host sees their own
// rooms on any device they sign in on. The joined-room pointer and Tournament
// History both live in localStorage (per-device), so without this a host on a
// second device has no way back into their tournament. Each hosted room
// writes a small summary at userTournaments/{uid}/{editCode}. =====

function publishUserTournament(uid, editCode, state) {
  const db = initFirebase();
  if (!db || !uid || !editCode || !state) return;
  // The DB rule only lets a signed-in user write their own userTournaments
  // subtree. Skip when this device isn't that account (e.g. a co-host starting
  // the tournament) — the host already indexed the room when they created it.
  const user = (typeof getCurrentUser === "function") ? getCurrentUser() : null;
  if (!user || user.uid !== uid) return;
  // No `pairing` field — see publishOpenRoomIndex; refreshMyTournaments reads
  // it from the live room so this stays inside the DB rules' field whitelist.
  db.ref(`userTournaments/${uid}/${editCode}`).set({
    editCode,
    viewCode: swissViewCode || state.viewCode || null,
    name: state.tournamentName || "",
    mode: state.mode || "swiss",
    phase: state.phase || "running",
    createdAt: state.createdAt || new Date().toISOString()
  }).catch(e => console.warn("My-tournament publish failed:", e));
}

function removeUserTournament(uid, editCode) {
  const db = initFirebase();
  if (!db || !uid || !editCode) return;
  const user = (typeof getCurrentUser === "function") ? getCurrentUser() : null;
  if (!user || user.uid !== uid) return;
  db.ref(`userTournaments/${uid}/${editCode}`).set(null)
    .catch(e => console.warn("My-tournament remove failed:", e));
}

function refreshMyTournaments() {
  const section = document.getElementById("my-tournaments-section");
  const list = document.getElementById("my-tournaments-list");
  if (!list) return;
  // The section only surfaces when there's a real choice to make — the host
  // has 2+ live tournaments. With 0 it's just noise (Create is right there),
  // and with 1 the host is auto-entered, so it stays hidden in both cases.
  const showSection = visible => {
    if (section) section.classList.toggle("hidden", !visible);
  };
  showSection(false);
  const user = (typeof getCurrentUser === "function") ? getCurrentUser() : null;
  if (!user || !firebaseReady()) return;
  const db = initFirebase();
  db.ref("userTournaments/" + user.uid).once("value")
    .then(snap => {
      const rooms = Object.values(snap.val() || {}).filter(r => r && r.editCode);
      if (!rooms.length) return;
      // Cross-check each entry against the live room: prune ones whose room
      // is gone, and read `pairing` live (it isn't kept in the summary).
      return Promise.all(rooms.map(r =>
        Promise.all([
          db.ref("swissRooms/" + r.editCode + "/phase").once("value").then(s => s.val()).catch(() => null),
          db.ref("swissRooms/" + r.editCode + "/pairing").once("value").then(s => s.val()).catch(() => null)
        ]).then(([phase, pairing]) => ({ room: r, phase, pairing }))
      )).then(results => {
        const live = [];
        results.forEach(({ room, phase, pairing }) => {
          if (phase === "registering" || phase === "running") {
            room.phase = phase;
            room.pairing = pairing || null;
            live.push(room);
          } else {
            removeUserTournament(user.uid, room.editCode);
          }
        });
        live.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        if (!live.length) return;
        // Auto-enter: one live tournament and not already in a room → drop
        // straight in. Section stays hidden.
        if (live.length === 1 && !swissEditCode) {
          joinMyTournament(live[0]);
          return;
        }
        // 2+ live tournaments → a genuine choice, so reveal the pick list.
        renderMyTournamentRooms(list, live);
        showSection(true);
      });
    })
    .catch(err => {
      console.warn("My-tournaments fetch failed:", err);
    });
}

function renderMyTournamentRooms(list, rooms) {
  list.innerHTML = rooms.map(r => {
    const name = (r.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(r.mode, r.pairing, true);
    const badge = r.phase === "running"
      ? `<span class="swiss-room-running-badge">In progress</span>`
      : `<span class="swiss-room-hosting-badge">Registering</span>`;
    return `
      <button type="button" class="swiss-room-card" data-edit-code="${escapeHtml(r.editCode)}">
        <div class="swiss-room-card-name">${escapeHtml(name)}${badge}</div>
        <div class="swiss-room-card-mode">${modeLabel}</div>
        <div class="swiss-room-card-meta">Host code ${escapeHtml(r.editCode)}</div>
      </button>
    `;
  }).join("");
  list.querySelectorAll(".swiss-room-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const room = rooms.find(r => r.editCode === btn.dataset.editCode);
      if (room) joinMyTournament(room);
    });
  });
}

// Re-open one of the signed-in user's own tournaments as host on this device.
// The account owns the room, so we connect with full host authority and mark
// it hosted locally so it also auto-reconnects on reload.
function joinMyTournament(room) {
  if (!room || !room.editCode) return;
  if (!firebaseReady()) { alert("Live sync isn't configured on this build."); return; }
  markRoomHosted(room.editCode);
  disconnectSwissRoom();
  // Empty placeholder — connectSwissRoom's listener fills it from the remote.
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
  connectSwissRoom(room.editCode, room.viewCode || null, true, true);
  renderSwiss();
}

// ===== Public Rooms tab: list open tournaments, click to register. =====

function refreshOpenTournamentRooms() {
  const list = document.getElementById("swiss-rooms-list");
  const status = document.getElementById("swiss-rooms-status");
  if (!list) return;
  const setStatus = msg => { if (status) status.textContent = msg || ""; };
  if (!firebaseReady()) {
    list.innerHTML = "";
    setStatus("Live sync isn't configured on this build.");
    return;
  }
  setStatus("Loading…");
  const db = initFirebase();
  db.ref("openTournaments").once("value")
    .then(snap => {
      const val = snap.val() || {};
      const rooms = Object.values(val).filter(r => r && r.editCode);
      if (!rooms.length) {
        list.innerHTML = `<p class="swiss-rooms-empty">No tournaments right now. Ask your host to create one.</p>`;
        setStatus("");
        return;
      }
      // Cross-check each lobby entry against the underlying swissRoom.
      // We re-read phase + registrant count straight from the source so
      // a stale cached `registrantCount` doesn't lie to viewers (the
      // host's listener can miss publishes when their tab is suspended).
      // Stale entries (room gone or phase no longer registering) get
      // pruned from the lobby in the same pass.
      return Promise.all(rooms.map(r => {
        const phaseP = db.ref("swissRooms/" + r.editCode + "/phase").once("value")
          .then(s => s.val())
          .catch(() => null);
        const regP = db.ref("swissRooms/" + r.editCode + "/registrants").once("value")
          .then(s => s.numChildren())
          .catch(() => null);
        // `pairing` lives on the room, not the lobby summary — read it live.
        const pairP = db.ref("swissRooms/" + r.editCode + "/pairing").once("value")
          .then(s => s.val())
          .catch(() => null);
        return Promise.all([phaseP, regP, pairP]).then(([phase, count, pairing]) => ({
          room: r, phase, count, pairing
        }));
      })).then(results => {
        const live = [];
        results.forEach(({ room, phase, count, pairing }) => {
          // Registering AND running rooms stay listed — running ones just
          // can't take new registrations. Only a vanished room (phase is
          // null because the host reset/deleted it) gets pruned.
          if (phase === "registering" || phase === "running") {
            // Refresh the cached count too so future viewers benefit.
            if (typeof count === "number" && count !== room.registrantCount) {
              db.ref("openTournaments/" + room.editCode + "/registrantCount")
                .set(count).catch(() => {});
              room.registrantCount = count;
            }
            room.phase = phase;
            room.pairing = pairing || null;
            live.push(room);
          } else {
            // Underlying room is gone — drop the stale lobby entry.
            db.ref("openTournaments/" + room.editCode).set(null)
              .catch(() => {});
          }
        });
        live.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        if (!live.length) {
          list.innerHTML = `<p class="swiss-rooms-empty">No tournaments right now. Ask your host to create one.</p>`;
          setStatus("");
          return;
        }
        renderLobbyRooms(list, live);
        setStatus("");
      });
    })
    .catch(err => {
      console.warn("Open rooms fetch failed:", err);
      setStatus("Couldn't load rooms. Check your connection.");
    });
}

function renderLobbyRooms(list, rooms) {
  // Tag rooms the signed-in account hosts so the user can spot their own
  // tournaments in the lobby.
  const myUid = (typeof getCurrentUser === "function" && getCurrentUser())
    ? getCurrentUser().uid : null;
  list.innerHTML = rooms.map(r => {
    const name = (r.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(r.mode, r.pairing, true);
    const isRunning = r.phase === "running";
    const meta = [`${r.registrantCount || 0} ${isRunning ? "players" : "registered"}`];
    if (r.mode !== "single-elim") {
      if (r.groupCount) meta.push(`${r.groupCount} groups`);
      if (r.roundCount) meta.push(`${r.roundCount} rounds`);
    }
    const hostingBadge = (myUid && r.hostUid && r.hostUid === myUid)
      ? `<span class="swiss-room-hosting-badge">Hosting</span>`
      : "";
    const runningBadge = isRunning
      ? `<span class="swiss-room-running-badge">In progress</span>`
      : "";
    return `
      <button type="button" class="swiss-room-card" data-edit-code="${escapeHtml(r.editCode)}">
        <div class="swiss-room-card-name">${escapeHtml(name)}${hostingBadge}${runningBadge}</div>
        <div class="swiss-room-card-mode">${modeLabel}</div>
        <div class="swiss-room-card-meta">${meta.map(escapeHtml).join(" · ")}</div>
      </button>
    `;
  }).join("");
  list.querySelectorAll(".swiss-room-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const editCode = btn.dataset.editCode;
      const room = rooms.find(r => r.editCode === editCode);
      if (room) showTournamentJoinChoicePopup(room);
    });
  });
}

// Three-way join picker shown when a user taps an entry in the Open
// Tournaments list. Co-host requires the host code (matched against the
// lobby summary's editCode), participant opens the registration form,
// viewer connects view-only directly via the lobby's viewCode.
function showTournamentJoinChoicePopup(room) {
  // This device hosts the room — rejoin straight as host, no role pick.
  if (isRoomHosted(room.editCode)) {
    joinTournamentAsCoHost(room);
    return;
  }
  // A signed-in user on this room's sub-host list joins straight as co-host —
  // no role pick and no host code. We read just their own subHosts entry.
  const subHostUname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  const subHostDb = subHostUname ? initFirebase() : null;
  if (subHostDb) {
    subHostDb.ref("swissRooms/" + room.editCode + "/subHosts/" + subHostKey(subHostUname))
      .once("value")
      .then(snap => { if (snap.val()) joinTournamentAsCoHost(room); else openJoinChoicePopup(room); })
      .catch(() => openJoinChoicePopup(room));
    return;
  }
  openJoinChoicePopup(room);
}

function openJoinChoicePopup(room) {
  const popup = document.getElementById("tournament-join-choice-popup");
  if (!popup) return;
  const subtitle = popup.querySelector("#tournament-join-choice-subtitle");
  const cohostBtn = popup.querySelector("#tournament-join-cohost");
  const participantBtn = popup.querySelector("#tournament-join-participant");
  const viewerBtn = popup.querySelector("#tournament-join-viewer");
  const cancelBtn = popup.querySelector("#tournament-join-choice-cancel");

  if (subtitle) {
    const name = (room.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(room.mode, room.pairing, true);
    subtitle.textContent = `${name} · ${modeLabel}`;
  }

  const close = () => {
    popup.classList.add("hidden");
    if (cohostBtn) cohostBtn.onclick = null;
    if (participantBtn) participantBtn.onclick = null;
    if (viewerBtn) viewerBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
  };

  // Co-hosts are no longer joined by host code — the host grants co-host
  // access by listing usernames in the Sub-hosts popup. Hide the option.
  if (cohostBtn) {
    cohostBtn.style.display = "none";
    cohostBtn.onclick = null;
  }
  if (participantBtn) {
    // A running tournament has closed registration — co-host and viewer
    // still work, but the participant sign-up path is disabled. The desc
    // text is restored explicitly because the popup is reused across rooms.
    const desc = participantBtn.querySelector(".tournament-mode-desc");
    if (room.phase === "running") {
      participantBtn.disabled = true;
      participantBtn.classList.add("is-disabled");
      participantBtn.onclick = null;
      if (desc) desc.textContent = "Registration is closed — this tournament has already started.";
    } else {
      participantBtn.disabled = false;
      participantBtn.classList.remove("is-disabled");
      if (desc) desc.textContent = "Sign up with your name and deck. Your deck pre-fills every match you play.";
      participantBtn.onclick = () => {
        close();
        showRegistrationPopup(room);
      };
    }
  }
  if (viewerBtn) {
    viewerBtn.onclick = () => {
      close();
      joinTournamentAsViewer(room);
    };
  }
  if (cancelBtn) cancelBtn.onclick = close;
  popup.classList.remove("hidden");
}

// Code prompt for the co-host path. Validates the entered code against
// the lobby summary's editCode rather than going through resolveRoomCode,
// so a user accidentally typing the view code gets a clear error instead
// of silently being downgraded to view-only.
function showCoHostCodePopup(room) {
  const popup = document.getElementById("tournament-cohost-code-popup");
  if (!popup) return;
  const subtitle = popup.querySelector("#tournament-cohost-code-subtitle");
  const input = popup.querySelector("#tournament-cohost-code-input");
  const statusEl = popup.querySelector("#tournament-cohost-code-status");
  const submitBtn = popup.querySelector("#tournament-cohost-code-submit");
  const cancelBtn = popup.querySelector("#tournament-cohost-code-cancel");

  if (subtitle) {
    const name = (room.name || "").trim() || "(unnamed tournament)";
    subtitle.textContent = `Enter the host code for ${name}.`;
  }
  if (input) input.value = "";
  if (statusEl) { statusEl.textContent = ""; statusEl.classList.remove("is-err", "is-ok", "is-pending"); }

  const setStatus = (msg, kind) => {
    if (!statusEl) return;
    statusEl.textContent = msg || "";
    statusEl.classList.remove("is-err", "is-ok", "is-pending");
    if (kind) statusEl.classList.add(`is-${kind}`);
  };

  const close = () => {
    popup.classList.add("hidden");
    if (submitBtn) submitBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (input) input.onkeydown = null;
  };

  const submit = () => {
    const entered = (input?.value || "").trim().toUpperCase();
    if (!entered) {
      setStatus("Enter the host code.", "err");
      input?.focus();
      return;
    }
    if (entered !== String(room.editCode || "").toUpperCase()) {
      setStatus("Wrong host code for this tournament.", "err");
      input?.select();
      return;
    }
    close();
    joinTournamentAsCoHost(room);
  };

  if (submitBtn) submitBtn.onclick = submit;
  if (cancelBtn) cancelBtn.onclick = close;
  if (input) {
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    };
  }
  popup.classList.remove("hidden");
  setTimeout(() => input?.focus(), 0);
}

function joinTournamentAsCoHost(room) {
  if (!firebaseReady()) {
    alert("Live sync isn't configured on this build.");
    return;
  }
  disconnectSwissRoom();
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
  const asHost = isRoomHosted(room.editCode);
  connectSwissRoom(room.editCode, room.viewCode || null, asHost, true);
  // Make sure the user is on the Hosting tab so they see the live tournament.
  const hostingTab = document.querySelector('.tournament-sub-tab[data-tournament-view="hosting"]');
  hostingTab?.click();
}

function joinTournamentAsViewer(room) {
  if (!firebaseReady()) {
    alert("Live sync isn't configured on this build.");
    return;
  }
  // Viewer connects via the lobby's viewCode (or falls back to the editCode
  // path with canEdit=false if the lobby summary somehow lacks viewCode).
  disconnectSwissRoom();
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
  connectSwissRoom(room.editCode, room.viewCode || null, false, false);
  const hostingTab = document.querySelector('.tournament-sub-tab[data-tournament-view="hosting"]');
  hostingTab?.click();
}

function showRegistrationPopup(room, options = {}) {
  const popup = document.getElementById("register-popup");
  if (!popup) return;
  const subtitle = popup.querySelector("#register-subtitle");
  const nameInput = popup.querySelector("#register-name-input");
  const slotsHost = popup.querySelector("#register-deck-slots");
  const status = popup.querySelector("#register-status");
  const submitBtn = popup.querySelector("#register-submit");
  const cancelBtn = popup.querySelector("#register-cancel");
  const pasteBtn = popup.querySelector("#register-paste");
  const selfRegister = !!options.selfRegister;
  const editRegistrantId = options.editRegistrantId || null;
  // Edit mode is implicitly self-managed too (writes via swissRoomRef,
  // no disconnect/reconnect).
  const isEdit = !!editRegistrantId;

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  if (subtitle) {
    const name = (room.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(room.mode, room.pairing, true);
    subtitle.textContent = `${name} · ${modeLabel}`;
  }
  if (nameInput) nameInput.value = options.initialName || "";
  if (submitBtn) submitBtn.textContent = isEdit ? "Save" : "Register";
  setStatus("");
  let deck = options.initialDeck && Array.isArray(options.initialDeck)
    ? normalizeBeyCheckDeck(options.initialDeck)
    : emptyBeyCheckDeck();

  const renderSlots = () => {
    if (!slotsHost) return;
    slotsHost.innerHTML = deck.map((s, i) => renderBeyCheckSlot(i, s)).join("");
    slotsHost.querySelectorAll(".bey-check-slot").forEach(el => {
      el.addEventListener("click", () => {
        const slotIdx = Number(el.dataset.slot);
        showBeyCheckSlotPopup(slotIdx, deck[slotIdx], deck, (next) => {
          deck[slotIdx] = next;
          renderSlots();
        });
      });
    });
  };
  renderSlots();

  popup.classList.remove("hidden");
  setTimeout(() => nameInput?.focus(), 0);

  const close = () => {
    popup.classList.add("hidden");
    submitBtn.onclick = null;
    cancelBtn.onclick = null;
    if (pasteBtn) pasteBtn.onclick = null;
    if (nameInput) nameInput.onkeydown = null;
  };
  cancelBtn.onclick = close;

  // Paste from Deck tab. Reads the JSON payload that the Deck tab's Copy
  // button writes to the clipboard, validates the wrapper, then drops the
  // 3-slot deck straight into the form (the user can still tweak slots
  // before submitting).
  if (pasteBtn) {
    pasteBtn.onclick = () => {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        setStatus("Clipboard read isn't available in this browser.", "err");
        return;
      }
      navigator.clipboard.readText().then(text => {
        let parsed;
        try { parsed = JSON.parse(text); } catch (e) { parsed = null; }
        if (!parsed || parsed.type !== "x-optimizer-deck" || !Array.isArray(parsed.deck)) {
          setStatus("Clipboard doesn't contain a copied deck. Hit Copy in the Deck tab first.", "err");
          return;
        }
        // normalizeBeyCheckDeck filters parts to the slot's mode + caps to 3
        // slots, so anything weird in the payload gets sanitised before we
        // render it.
        deck = normalizeBeyCheckDeck(parsed.deck);
        renderSlots();
        const label = parsed.name ? ` "${parsed.name}"` : "";
        setStatus(`Pasted deck${label} — review before registering.`, "ok");
      }).catch(() => {
        setStatus("Couldn't read the clipboard. Did you allow the permission?", "err");
      });
    };
  }

  const submit = () => {
    const name = (nameInput?.value || "").trim();
    if (!name) {
      setStatus("Enter a name to register.", "err");
      nameInput?.focus();
      return;
    }
    if (isBeyCheckDeckEmpty(deck)) {
      // Soft-warn but allow — host can still start with an empty deck if needed.
      const msg = isEdit
        ? "This deck has no slots filled. Save anyway?"
        : "You haven't built any deck slots yet. Register without a deck?";
      if (!confirm(msg)) return;
    }
    submitRegistration(room, name, deck, setStatus, close, { selfRegister, editRegistrantId });
  };
  submitBtn.onclick = submit;
  if (nameInput) {
    nameInput.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    };
  }
}

// Test-data generation: builds a single bey-check slot using the same
// meta-random rules the calculator's selectMeta uses, but returns the
// {mode, parts} shape the tournament's deck slots expect.
//
// Across the 3 slots of a deck, parts MUST NOT repeat, matching the deck
// builder's "one of each part per deck" rule (see deck.js). The only
// exception is lock chips — light lock chips can repeat freely; the
// heaviest ones (Emperor and Valkyrie) can't.
const META_UNIQUE_LOCK_CHIPS = new Set(["Emperor", "Valkyrie"]);

function metaIsLockChipUniqueTracked(name) {
  return META_UNIQUE_LOCK_CHIPS.has(name);
}

// Generic picker that prefers meta-flagged items and respects the `used`
// exclusion set. Falls back through wider pools so a slot can always fill
// even when the meta pool is empty after exclusions.
function pickMetaFrom(arr, used, extraFilter) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const baseFilter = p => p && !isExclusive(p) && (!extraFilter || extraFilter(p));
  const notUsed = p => baseFilter(p) && !used.has(p.name);
  const tiers = [
    arr.filter(p => notUsed(p) && p.meta === true),  // meta + unused
    arr.filter(notUsed),                              // any eligible + unused
    arr.filter(p => baseFilter(p) && p.meta === true),// meta (used pool exhausted)
    arr.filter(baseFilter)                            // anything eligible
  ];
  for (const pool of tiers) {
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  return null;
}

function pickMetaLockChip(used) {
  // Light lock chips (everything except Emperor/Valkyrie) repeat freely, so
  // they're never considered "used" for exclusion purposes.
  const arr = DATA.lockChips || [];
  const baseFilter = p => p && !isExclusive(p);
  const notBlocked = p => baseFilter(p) && !(metaIsLockChipUniqueTracked(p.name) && used.has(p.name));
  const tiers = [
    arr.filter(p => notBlocked(p) && p.meta === true),
    arr.filter(notBlocked),
    arr.filter(p => baseFilter(p) && p.meta === true),
    arr.filter(baseFilter)
  ];
  for (const pool of tiers) {
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)];
  }
  return null;
}

function buildMetaSlot(mode, used) {
  const bitObj = pickMetaFrom(DATA.bits || [], used, isNormalBit);
  const bitName = bitObj?.name || null;

  if (mode === "cx") {
    const lc = pickMetaLockChip(used);
    const mb = pickMetaFrom(DATA.mainBlades || [], used);
    const ab = pickMetaFrom(DATA.assistBlades || [], used);
    const ratchet = pickMetaFrom(DATA.ratchets || [], used);
    return {
      mode,
      parts: {
        lockChip: lc?.name || null,
        mainBlade: mb?.name || null,
        assistBlade: ab?.name || null,
        ratchet: ratchet?.name || null,
        bit: bitName
      }
    };
  }
  if (mode === "cxExpand") {
    const lc = pickMetaLockChip(used);
    const metal = pickMetaFrom(DATA.metalBlades || [], used);
    const over = pickMetaFrom(DATA.overBlades || [], used);
    const ab = pickMetaFrom(DATA.assistBlades || [], used);
    const ratchet = pickMetaFrom(DATA.ratchets || [], used);
    return {
      mode,
      parts: {
        lockChip: lc?.name || null,
        metalBlade: metal?.name || null,
        overBlade: over?.name || null,
        assistBlade: ab?.name || null,
        ratchet: ratchet?.name || null,
        bit: bitName
      }
    };
  }

  // standard — honour Bullet Griffon (no ratchet) and Clock Mirage (ratchet
  // must end in "5") the same way the calculator's selectMeta does.
  const blade = pickMetaFrom(DATA.blades || [], used);
  const codename = blade?.codename || "";
  if (codename === "BULLETGRIFFON") {
    return { mode, parts: { blade: blade.name, bit: bitName } };
  }
  if (codename === "CLOCKMIRAGE") {
    const ratchet = pickMetaFrom(DATA.ratchets || [], used, r => r.name.endsWith("5"));
    return { mode, parts: { blade: blade.name, ratchet: ratchet?.name || null, bit: bitName } };
  }
  const ratchet = pickMetaFrom(DATA.ratchets || [], used);
  return {
    mode,
    parts: {
      blade: blade?.name || null,
      ratchet: ratchet?.name || null,
      bit: bitName
    }
  };
}

// Real-world players bring Standard combos most of the time, with the odd
// CX / CX Expand thrown in. The weighted pick below biases the generator
// toward that distribution so test brackets feel realistic.
function pickWeightedMode() {
  const r = Math.random();
  if (r < 0.75) return "standard";   // 75% Standard
  if (r < 0.88) return "cx";          // 13% CX
  return "cxExpand";                  // 12% CX Expand
}

function buildMetaDeck() {
  const used = new Set();
  const out = [];
  for (let i = 0; i < BEY_CHECK_DECK_SIZE; i++) {
    const slot = buildMetaSlot(pickWeightedMode(), used);
    out.push(slot);
    // Record what's used for the next slot. Lock chips are only tracked if
    // they're a heaviest variant (Emperor / Valkyrie) — see deck.js's
    // LOCK_CHIP_EXCLUSIVE rule.
    for (const [key, name] of Object.entries(slot.parts || {})) {
      if (!name) continue;
      if (key === "lockChip" && !metaIsLockChipUniqueTracked(name)) continue;
      used.add(name);
    }
  }
  return out;
}

// Bulk-register `count` synthetic participants with meta-random decks. Used
// for stress-testing the bracket / pairing logic without manually filling
// the registration popup N times.
function addTestRegistrants(count) {
  if (!swissCanEdit || !swissEditCode) {
    alert("You need host or co-host privileges to add test registrants.");
    return;
  }
  const state = loadSwiss();
  if (!isRegisteringPhase(state)) {
    alert("The tournament isn't in the registering phase.");
    return;
  }
  const db = initFirebase();
  if (!db) { alert("Firebase not available."); return; }

  const roomRef = db.ref("swissRooms/" + swissEditCode);
  roomRef.once("value").then(snap => {
    const remote = snap.val();
    if (!remote || remote.phase !== "registering") {
      alert("This tournament is no longer accepting registrations.");
      return;
    }
    const usedNames = new Set(
      Object.values(remote.registrants || {})
        .map(r => (r && typeof r.name === "string") ? r.name.trim().toLowerCase() : "")
        .filter(Boolean)
    );

    const updates = {};
    let added = 0;
    let nextNum = 1;
    while (added < count) {
      const name = `Tester ${nextNum++}`;
      if (usedNames.has(name.toLowerCase())) continue;
      usedNames.add(name.toLowerCase());
      const id = generateRegistrantId();
      updates[`registrants/${id}`] = { name, deck: buildMetaDeck() };
      added++;
    }

    return roomRef.update(updates).then(() => {
      return roomRef.child("registrants").once("value").then(s => {
        const total = s.numChildren();
        return db.ref("openTournaments/" + swissEditCode + "/registrantCount").set(total).catch(() => {});
      });
    });
  }).catch(e => {
    alert("Couldn't add test registrants: " + (e?.message || e));
  });
}

function submitRegistration(room, name, deck, setStatus, onSuccess, options = {}) {
  const selfRegister = !!options.selfRegister;
  const editRegistrantId = options.editRegistrantId || null;
  const isEdit = !!editRegistrantId;
  const db = initFirebase();
  if (!db) { setStatus("Firebase not available.", "err"); return; }
  setStatus(isEdit ? "Saving…" : "Looking up tournament…", "pending");
  const editCode = room.editCode;
  const roomRef = db.ref("swissRooms/" + editCode);
  roomRef.once("value")
    .then(snap => {
      const remote = snap.val();
      if (!remote || remote.phase !== "registering") {
        throw new Error("This tournament is no longer accepting registrations.");
      }
      // Duplicate-name guard. Skip the registrant being edited so saving
      // an unchanged name doesn't trip the check against itself.
      const lower = name.trim().toLowerCase();
      const taken = Object.entries(remote.registrants || {}).some(([id, r]) => {
        if (!r || typeof r.name !== "string") return false;
        if (id === editRegistrantId) return false;
        return r.name.trim().toLowerCase() === lower;
      });
      if (taken) throw new Error("That name is already registered. Pick a different one.");

      const id = editRegistrantId || generateRegistrantId();
      const payload = { name: name.trim(), deck };
      if (!isEdit) setStatus("Submitting…", "pending");
      return roomRef.child("registrants/" + id).set(payload)
        .then(() => {
          // Refresh the lobby's registrantCount from the authoritative
          // source. The host's listener would normally re-publish the
          // open-tournaments summary on this same registrant write, but
          // if the host is currently backgrounded (mobile suspends the
          // WebSocket) that publish never fires and the lobby keeps
          // showing a stale count. Have the registrant device update it
          // directly so the lobby stays correct independently of the
          // host's connectivity.
          if (!isEdit) {
            return roomRef.child("registrants").once("value").then(snap => {
              const count = snap.numChildren();
              return db.ref("openTournaments/" + editCode + "/registrantCount").set(count)
                .catch(() => {}); // non-fatal — host listener will sync eventually
            }).catch(() => {});
          }
        })
        .then(() => remote);
    })
    .then(remote => {
      if (isEdit) {
        // Host / co-host edited a registrant in place — listener will
        // re-render the row with the new name + deck.
        setStatus("Saved ✓", "ok");
        onSuccess?.();
        return;
      }
      if (selfRegister) {
        // Host / co-host registering themselves: keep their existing
        // connection and edit privileges. The Firebase listener will pick
        // up the new registrant entry and re-render the registering UI on
        // its own.
        setStatus("Registered ✓", "ok");
        onSuccess?.();
        return;
      }
      // Lobby path: auto-join as a view-only participant so the registrant
      // immediately sees the registrants list updating live and the
      // tournament starting. The "participant" role hint sticks across
      // listener ticks so the Tournament History tab distinguishes
      // self-registered players from plain spectators.
      const viewCode = remote.viewCode || null;
      disconnectSwissRoom();
      localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
      connectSwissRoom(editCode, viewCode, false, false, "participant");
      setStatus("Registered ✓ — switching to tournament view…", "ok");
      onSuccess?.();
      // Switch the user's visible tab to Hosting so they see the tournament.
      const hostingTab = document.querySelector('.tournament-sub-tab[data-tournament-view="hosting"]');
      hostingTab?.click();
    })
    .catch(err => {
      console.warn("Registration failed:", err);
      setStatus(err.message || (isEdit ? "Couldn't save. Try again." : "Couldn't register. Try again."), "err");
    });
}

// Firebase keys can't contain ".", "#", "$", "/", "[", "]". Normalize so
// "Alice" and "alice" merge into a single leaderboard entry.
function rankingKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]]/g, "_");
}

// Stress-test registrants added via the "Test" button are always named
// exactly "Tester <n>". They play out the bracket like real players but must
// never earn global ranking points or appear on the leaderboard.
function isTestRegistrant(name) {
  return /^Tester \d+$/.test(String(name || "").trim());
}

// Atomically add `points` to /ranking/{key}.points. Stores the freshest cased
// version of the name so the leaderboard shows a real spelling, not the key.
function bumpGlobalRanking(name, points) {
  if (!points) return;
  const db = initFirebase();
  if (!db) return;
  const key = rankingKey(name);
  if (!key) return;
  db.ref("ranking/" + key).transaction(curr => ({
    name: (name || "").trim() || (curr && curr.name) || key,
    points: ((curr && curr.points) || 0) + points
  }));
}

// Claim the per-room per-player slot via transaction so concurrent hosts
// can't double-award and later state ticks never re-award the same player.
function awardPlayerIfNew(name, points) {
  if (!swissRoomRef || !points) return;
  const cleanName = (name || "").trim();
  if (!cleanName) return;
  if (isTestRegistrant(cleanName)) return; // test registrants aren't ranked

  const key = rankingKey(cleanName);
  if (!key) return;
  const slotRef = swissRoomRef.child("awarded/players/" + key);
  slotRef.transaction(
    prev => prev != null ? undefined : { name: cleanName, points },
    (err, committed) => {
      if (err || !committed) return;
      bumpGlobalRanking(cleanName, points);
    }
  );
}

// Tournament is "decided" once the final is played AND (if a 3rd-place
// match exists) it's also played. Triggers the single award pass.
function tournamentIsDecided(state) {
  const matches = state?.matches || {};
  const isDecided = m => m && m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB;
  if (!isDecided(matches["bracket-f-0"])) return false;
  if (matches["bracket-3rd-0"] && !isDecided(matches["bracket-3rd-0"])) return false;
  return true;
}

// Returns { name: points } for every participant, applying the points scheme:
//   1st = 5, 2nd = 4, 3rd = 3, top 8 (4th–8th) = 2, anyone else = 1.
function computeTournamentRankingAwards(state) {
  const matches = state?.matches || {};
  const matchResult = m => {
    if (!m || m.scoreA == null || m.scoreB == null || m.scoreA === m.scoreB) return null;
    const aWon = m.scoreA > m.scoreB;
    return { winner: aWon ? m.a : m.b, loser: aWon ? m.b : m.a };
  };
  const awards = {};
  const set = (name, pts) => {
    if (!name || !pts) return;
    if (awards[name] == null || pts > awards[name]) awards[name] = pts;
  };
  // Podium
  const f = matchResult(matches["bracket-f-0"]);
  if (f) { set(f.winner, 5); set(f.loser, 4); }
  const third = matchResult(matches["bracket-3rd-0"]);
  if (third) { set(third.winner, 3); set(third.loser, 2); }
  // Top 8 = anyone in the knockout bracket. For Swiss this is everyone in
  // any `bracket-*` match; for Single Elim it's the QF round and beyond
  // (or every participant if the bracket is small enough that QFs == R0).
  const topEight = new Set();
  if (state?.mode === "swiss") {
    Object.values(matches).forEach(m => {
      if (m && m.bracket) {
        if (m.a) topEight.add(m.a);
        if (m.b) topEight.add(m.b);
      }
    });
  } else if (state?.mode === "single-elim") {
    const preFinal = state.preFinalRounds || 0;
    if (preFinal <= 2) {
      // Bracket size ≤ 8 → every real participant is top 8.
      getParticipants(state).forEach(n => { if (n) topEight.add(n); });
    } else {
      const qfRound = preFinal - 2;
      Object.values(matches).forEach(m => {
        if (!m || !m.bracket) return;
        const inQfOrLater = (typeof m.round === "number" && m.round >= qfRound)
          || m.round === "f" || m.round === "3rd";
        if (inQfOrLater) {
          if (m.a) topEight.add(m.a);
          if (m.b) topEight.add(m.b);
        }
      });
    }
  }
  topEight.forEach(name => set(name, 2));
  // Everyone else who participated → +1.
  getParticipants(state).forEach(name => {
    if (name && awards[name] == null) awards[name] = 1;
  });
  return awards;
}

function syncTournamentRankingAwards(state) {
  if (!swissCanEdit || !swissRoomRef) return;
  if (state?.ranked !== true) return; // unranked tournament → skip ranking writes
  if (!tournamentIsDecided(state)) return; // wait until final + 3rd-place are settled
  const awards = computeTournamentRankingAwards(state);
  Object.entries(awards).forEach(([name, points]) => awardPlayerIfNew(name, points));
}

function renderTournamentRanking() {
  const container = document.getElementById("tournament-ranking-list");
  if (!container) return;
  if (!firebaseReady()) {
    container.innerHTML = `<p class="tournament-results-empty">Live sync isn't configured on this build, so the global ranking can't be loaded.</p>`;
    return;
  }
  container.innerHTML = `<p class="tournament-results-loading">Loading rankings…</p>`;
  const db = initFirebase();
  db.ref("ranking").once("value")
    .then(snap => {
      const data = snap.val() || {};
      const list = Object.entries(data)
        .map(([key, v]) => ({
          name: (v && v.name) || key,
          points: (v && Number(v.points)) || 0
        }))
        .filter(r => r.points > 0 && !isTestRegistrant(r.name))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
      if (!list.length) {
        container.innerHTML = `<p class="tournament-results-empty">No tournament results yet. Finish an online tournament to start earning ranking points (1st = +5, 2nd = +4, 3rd = +3, top 8 = +2, participation = +1). Same names merge across tournaments.</p>`;
        return;
      }
      const rows = list.map((r, i) => {
        const placeMod = i < 3 ? ` tournament-results-place-${i + 1}` : "";
        return `
          <div class="tournament-results-row tournament-ranking-row${placeMod}">
            <span class="tournament-results-place">#${i + 1}</span>
            <span class="tournament-results-player">${escapeHtml(r.name)}</span>
            <span class="tournament-ranking-points">${r.points} pt${r.points === 1 ? "" : "s"}</span>
          </div>
        `;
      }).join("");
      container.innerHTML = `<div class="tournament-results-list">${rows}</div>`;
    })
    .catch(err => {
      console.warn("Ranking load failed:", err);
      container.innerHTML = `<p class="tournament-results-empty">Couldn't load the ranking right now.</p>`;
    });
}

// ===================== REVOX MEMBER RANKING (admin-curated) =====================
// Manually-managed leaderboard, separate from tournament-driven /ranking.
// Anyone can read; write access (add / edit / delete) is reserved for accounts
// carrying the "Revox Admin" tag — the same tag that unlocks the Revox tab —
// so no separate password login is needed.

function isRevoxAdminUnlocked() {
  return typeof window.isRevoxAdmin === "function" && window.isRevoxAdmin();
}

// Records a tournament result for a member. If the same name (after key
// normalization) already exists, the new points are added to the running
// total and the tournament + placing are updated to this latest result.
// A transaction keeps concurrent admin writes from losing updates.
function addRevoxEntry(name, points, tournament, placing, date) {
  const db = initFirebase();
  if (!db) return Promise.reject(new Error("firebase not configured"));
  const cleanName = String(name || "").trim();
  const pts = Number(points);
  if (!cleanName || !Number.isFinite(pts)) return Promise.reject(new Error("bad input"));
  const key = rankingKey(cleanName);
  if (!key) return Promise.reject(new Error("bad name"));
  const tour = String(tournament || "").trim().slice(0, 80);
  const place = Number(placing) || 0;
  const dt = String(date || "").trim().slice(0, 10);
  // Each Add appends one result so a member keeps a full tournament history;
  // the top-level tournament/placing/date mirror this latest result.
  const entryRef = db.ref("revoxRanking/" + key);
  const resultId = entryRef.child("results").push().key;
  return entryRef.transaction(curr => {
    const results = (curr && curr.results) || {};
    results[resultId] = { tournament: tour, placing: place, points: pts, date: dt };
    return {
      name: (curr && curr.name) || cleanName,
      points: ((curr && Number(curr.points)) || 0) + pts,
      tournament: tour || (curr && curr.tournament) || "",
      placing: place || (curr && curr.placing) || 0,
      date: dt || (curr && curr.date) || "",
      results
    };
  });
}

function deleteRevoxEntry(key) {
  const db = initFirebase();
  if (!db || !key) return Promise.reject(new Error("bad input"));
  return db.ref("revoxRanking/" + key).remove();
}

// "1" -> "1st", "2" -> "2nd", "3" -> "3rd", "4".."8" -> "4th".."8th".
function ordinalPlace(n) {
  n = Number(n);
  if (!n) return "";
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// "2026-05-16" -> "16/5/2026" for display; "" when not a valid ISO date.
function formatRevoxDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  return m ? Number(m[3]) + "/" + Number(m[2]) + "/" + m[1] : "";
}

// Today as a local-time YYYY-MM-DD string (default for the date input).
function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

// Top 8 scoring: 1st = 8 pts, 2nd = 7 ... 8th = 1. Placing drives Points.
function revoxPointsForPlacing(placing) {
  const p = Number(placing);
  return (p >= 1 && p <= 8) ? 9 - p : 0;
}

// Inline icons for the Revox action buttons (fill follows currentColor).
const REVOX_ICON_ADD = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
const REVOX_ICON_DELETE = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const REVOX_ICON_EDIT = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

// Set by initRevoxAdminControls so a ranking row can open the Add popup.
let revoxAddPopupOpener = null;

// Fill the Add-result name dropdown with registered usernames that start
// with the "RvX-" club prefix, merged with any existing ranking members.
// Reading the usernames index needs the Developer/Revox-Admin read rule; if
// that's not granted the dropdown quietly falls back to ranking members only.
function populateRevoxNameOptions(memberNames) {
  const datalist = document.getElementById("revox-name-options");
  if (!datalist) return;
  const names = new Set((memberNames || []).filter(Boolean));
  const paint = () => {
    datalist.innerHTML = Array.from(names)
      .sort((a, b) => a.localeCompare(b))
      .map(n => `<option value="${escapeHtml(n)}"></option>`)
      .join("");
  };
  paint(); // existing members show immediately
  const db = initFirebase();
  if (!db) return;
  db.ref("usernames").once("value").then(snap => {
    const val = snap.val() || {};
    Object.keys(val).forEach(k => {
      const u = (val[k] && val[k].username) || "";
      if (u && u.toLowerCase().startsWith("rvx-")) names.add(u);
    });
    paint();
  }).catch(() => { /* enumeration not permitted — ranking members only */ });
}

function renderRevoxRanking() {
  const container = document.getElementById("revox-ranking-list");
  if (!container) return;
  updateRevoxAdminUI();
  if (!firebaseReady()) {
    container.innerHTML = `<p class="tournament-results-empty">Live sync isn't configured on this build.</p>`;
    return;
  }
  container.innerHTML = `<p class="tournament-results-loading">Loading members…</p>`;
  const db = initFirebase();
  db.ref("revoxRanking").once("value")
    .then(snap => {
      const data = snap.val() || {};
      const list = Object.entries(data)
        .map(([key, v]) => ({
          key,
          name: (v && v.name) || key,
          points: (v && Number(v.points)) || 0,
          tournament: (v && v.tournament) || "",
          placing: (v && Number(v.placing)) || 0,
          date: (v && v.date) || ""
        }))
        .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
      // Fill the Add-form name dropdown: registered "RvX-" usernames plus
      // any existing ranking members.
      populateRevoxNameOptions(list.map(r => r.name));
      const isAdmin = isRevoxAdminUnlocked();
      if (!list.length) {
        container.innerHTML = `<p class="tournament-results-empty">No Revox members yet.${isAdmin ? " Tap Add to record a result." : ""}</p>`;
        return;
      }
      const rows = list.map((r, i) => {
        const placeMod = i < 3 ? ` tournament-results-place-${i + 1}` : "";
        const adminBtns = isAdmin ? `
          <span class="revox-row-actions">
            <button type="button" class="revox-row-btn" data-revox-add="${escapeHtml(r.name)}" title="Add a result" aria-label="Add a result">${REVOX_ICON_ADD}</button>
            <button type="button" class="revox-row-btn revox-row-btn-delete" data-revox-delete="${escapeHtml(r.key)}" data-revox-name="${escapeHtml(r.name)}" title="Delete" aria-label="Delete">${REVOX_ICON_DELETE}</button>
          </span>` : "";
        const dateStr = formatRevoxDate(r.date);
        const subLines =
          (r.tournament ? `<span class="revox-row-meta">${escapeHtml(r.tournament)}</span>` : "") +
          (dateStr ? `<span class="revox-row-meta">${escapeHtml(dateStr)}</span>` : "");
        return `
          <div class="tournament-results-row tournament-ranking-row revox-row${placeMod}">
            <span class="tournament-results-player"><button type="button" class="revox-name-btn" data-revox-history="${escapeHtml(r.key)}" data-revox-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>${subLines}</span>
            <span class="revox-row-placing">${ordinalPlace(i + 1)}</span>
            <span class="tournament-ranking-points">${r.points} pt${r.points === 1 ? "" : "s"}</span>
            ${adminBtns}
          </div>
        `;
      }).join("");
      container.innerHTML = `<div class="tournament-results-list">${rows}</div>`;
      // Hovering a member name shows that account's profile; clicking opens
      // their tournament history (both available to anyone).
      container.querySelectorAll("[data-revox-history]").forEach(btn => {
        btn.addEventListener("click", () => {
          showRevoxHistory(btn.dataset.revoxHistory, btn.dataset.revoxName);
        });
        btn.addEventListener("mouseenter", () => {
          showProfileByUsername(btn.dataset.revoxName, btn);
        });
        btn.addEventListener("mouseleave", () => scheduleProfileDropdownHide());
      });
      // Wire row buttons (admin only).
      if (isAdmin) {
        container.querySelectorAll("[data-revox-add]").forEach(btn => {
          btn.addEventListener("click", () => {
            if (revoxAddPopupOpener) revoxAddPopupOpener(btn.dataset.revoxAdd);
          });
        });
        container.querySelectorAll("[data-revox-delete]").forEach(btn => {
          btn.addEventListener("click", () => {
            const key = btn.dataset.revoxDelete;
            if (!confirm(`Remove ${btn.dataset.revoxName} from the ranking?`)) return;
            deleteRevoxEntry(key).then(renderRevoxRanking)
              .catch(e => alert("Delete failed: " + (e?.message || e)));
          });
        });
      }
    })
    .catch(err => {
      console.warn("Revox ranking load failed:", err);
      container.innerHTML = `<p class="tournament-results-empty">Couldn't load the Revox ranking right now.</p>`;
    });
}

function updateRevoxAdminUI() {
  // The add form shows only for Revox-Admin accounts. The Revox tab is
  // already tag-gated, but a non-admin could still reach /revox/ by URL —
  // for them the page stays read-only.
  document.getElementById("revox-admin-form")?.classList.toggle("hidden", !isRevoxAdminUnlocked());
}

// Show one member's recorded tournament results in a popup, newest first.
// Recompute a member's total points and latest-result mirror from their full
// results history — run after a result is edited or deleted.
function recomputeRevoxMember(key) {
  const db = initFirebase();
  if (!db || !key) return Promise.resolve();
  const ref = db.ref("revoxRanking/" + key);
  return ref.child("results").once("value").then(snap => {
    const results = snap.val() || {};
    let total = 0, latest = null;
    Object.keys(results).forEach(k => {
      const r = results[k] || {};
      total += Number(r.points) || 0;
      if (!latest || String(r.date || "") > String(latest.date || "")) latest = r;
    });
    return ref.update({
      points: total,
      tournament: (latest && latest.tournament) || "",
      placing: (latest && Number(latest.placing)) || 0,
      date: (latest && latest.date) || ""
    });
  });
}

// Overwrite one recorded result, then recompute the member's totals.
function updateRevoxResult(key, resultId, result) {
  const db = initFirebase();
  if (!db || !key || !resultId) return Promise.reject(new Error("bad input"));
  return db.ref("revoxRanking/" + key + "/results/" + resultId).set({
    tournament: String(result.tournament || "").trim().slice(0, 80),
    placing: Number(result.placing) || 0,
    points: Number(result.points) || 0,
    date: String(result.date || "").trim().slice(0, 10)
  }).then(() => recomputeRevoxMember(key));
}

// Delete one recorded result, recompute the member, and refresh both views.
function deleteRevoxResult(key, resultId, name) {
  if (!key || !resultId) return;
  if (!confirm("Delete this tournament result?")) return;
  const db = initFirebase();
  if (!db) return;
  db.ref("revoxRanking/" + key + "/results/" + resultId).set(null)
    .then(() => recomputeRevoxMember(key))
    .then(() => { renderRevoxRanking(); showRevoxHistory(key, name); })
    .catch(e => alert("Delete failed: " + ((e && e.message) || e)));
}

// Load the member's profile (photo + tags) into the history popup header.
function loadRevoxHeaderProfile(name) {
  const photoEl = document.getElementById("revox-history-photo");
  const bannerEl = document.getElementById("revox-history-banner");
  const tagsEl = document.getElementById("revox-history-tags");
  const bioEl = document.getElementById("revox-history-bio");
  const db = initFirebase();
  if (!db || !name) return;
  db.ref("usernames/" + subHostKey(name)).once("value").then(snap => {
    const v = snap.val();
    if (!v || !v.uid) return null;
    return db.ref("users/" + v.uid).once("value");
  }).then(snap => {
    if (!snap) return;
    const p = snap.val() || {};
    if (photoEl && p.photo) photoEl.src = p.photo;
    if (bannerEl && p.banner) bannerEl.src = p.banner;
    if (tagsEl) tagsEl.innerHTML = revoxTagBadges(p);
    if (bioEl) {
      bioEl.textContent = p.bio || "";
      bioEl.style.display = p.bio ? "" : "none";
    }
  }).catch(() => {});
}

function showRevoxHistory(key, name) {
  const popup = document.getElementById("revox-history-popup");
  const titleEl = document.getElementById("revox-history-title");
  const listEl = document.getElementById("revox-history-list");
  if (!popup || !listEl || !key) return;
  if (titleEl) titleEl.textContent = name || "Member";
  // Reset the header, then load this member's profile photo + tags above the
  // joined-events list.
  const photoEl = document.getElementById("revox-history-photo");
  const bannerEl = document.getElementById("revox-history-banner");
  const tagsEl = document.getElementById("revox-history-tags");
  const bioEl = document.getElementById("revox-history-bio");
  if (photoEl) photoEl.src = PROFILE_VIEW_PHOTO_PH;
  if (bannerEl) bannerEl.src = PROFILE_VIEW_BANNER_PH;
  if (tagsEl) tagsEl.innerHTML = "";
  if (bioEl) { bioEl.textContent = ""; bioEl.style.display = "none"; }
  loadRevoxHeaderProfile(name);
  listEl.innerHTML = `<p class="tournament-results-loading">Loading…</p>`;
  popup.classList.remove("hidden");
  const db = initFirebase();
  if (!db) {
    listEl.innerHTML = `<p class="tournament-results-empty">Live sync isn't configured on this build.</p>`;
    return;
  }
  db.ref("revoxRanking/" + key).once("value").then(snap => {
    const v = snap.val() || {};
    let results = v.results
      ? Object.keys(v.results).map(k => Object.assign({ id: k }, v.results[k]))
      : [];
    // Older entries kept only the latest result at the top level.
    if (!results.length && v.tournament) {
      results = [{ tournament: v.tournament, placing: v.placing,
                   points: revoxPointsForPlacing(v.placing), date: v.date }];
    }
    if (!results.length) {
      listEl.innerHTML = `<p class="tournament-results-empty">No joined events recorded yet.</p>`;
      return;
    }
    results.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    const isAdmin = isRevoxAdminUnlocked();
    listEl.innerHTML =
      `<p class="revox-history-count">Joined events: ${results.length}</p>` +
      `<div class="revox-history-scroll">` +
      results.map(r => {
        const bits = [];
        const d = formatRevoxDate(r.date);
        if (d) bits.push(d);
        if (Number(r.placing)) bits.push(ordinalPlace(r.placing));
        const pts = Number(r.points) || 0;
        bits.push(pts + " pt" + (pts === 1 ? "" : "s"));
        // Edit / delete are offered to Revox Admins on real recorded results
        // (legacy entries with no result id stay read-only).
        const acts = (isAdmin && r.id) ? `
          <span class="revox-history-actions">
            <button type="button" class="revox-row-btn" data-rh-edit="${escapeHtml(r.id)}" data-rh-tour="${escapeHtml(r.tournament || "")}" data-rh-placing="${Number(r.placing) || ""}" data-rh-date="${escapeHtml(r.date || "")}" title="Edit" aria-label="Edit result">${REVOX_ICON_EDIT}</button>
            <button type="button" class="revox-row-btn revox-row-btn-delete" data-rh-del="${escapeHtml(r.id)}" title="Delete" aria-label="Delete result">${REVOX_ICON_DELETE}</button>
          </span>` : "";
        return `<div class="revox-history-row">
          <div class="revox-history-main">
            <span class="revox-history-tour">${escapeHtml(r.tournament || "Tournament")}</span>
            <span class="revox-history-meta">${escapeHtml(bits.join(" · "))}</span>
          </div>
          ${acts}
        </div>`;
      }).join("") +
      `</div>`;
    if (isAdmin) {
      listEl.querySelectorAll("[data-rh-del]").forEach(btn => {
        btn.addEventListener("click", () => deleteRevoxResult(key, btn.dataset.rhDel, name));
      });
      listEl.querySelectorAll("[data-rh-edit]").forEach(btn => {
        btn.addEventListener("click", () => {
          // Close the history popup and open the Add popup in edit mode.
          document.getElementById("revox-history-popup")?.classList.add("hidden");
          if (revoxAddPopupOpener) {
            revoxAddPopupOpener(name, {
              key: key,
              resultId: btn.dataset.rhEdit,
              tournament: btn.dataset.rhTour || "",
              placing: btn.dataset.rhPlacing || "",
              date: btn.dataset.rhDate || ""
            });
          }
        });
      });
    }
  }).catch(() => {
    listEl.innerHTML = `<p class="tournament-results-empty">Couldn't load the history right now.</p>`;
  });
}

(function initRevoxAdminControls() {
  // Re-render when the signed-in profile (and its tags) finishes loading, so
  // the Add button and per-row controls appear once "Revox Admin" is confirmed.
  window.addEventListener("userprofilechange", () => {
    if (document.getElementById("revox-ranking-list")) renderRevoxRanking();
  });

  const popup = document.getElementById("revox-add-popup");
  const placingDropdown = document.getElementById("revox-add-placing");
  const pointsDisplay = document.getElementById("revox-add-points");
  const nameEl = document.getElementById("revox-add-name");
  const tournamentEl = document.getElementById("revox-add-tournament");
  const dateEl = document.getElementById("revox-add-date");
  const statusEl = document.getElementById("revox-add-status");
  const setStatus = (m) => { if (statusEl) statusEl.textContent = m || ""; };

  // Mirror the chosen placing's points into the locked Points display.
  const syncPoints = () => {
    if (!pointsDisplay) return;
    const placing = placingDropdown?.querySelector(".setting-dropdown-btn")?.dataset.value || "";
    if (!placing) { pointsDisplay.textContent = "—"; return; }
    const pts = revoxPointsForPlacing(placing);
    pointsDisplay.textContent = `${pts} pt${pts === 1 ? "" : "s"}`;
  };

  // Wire the themed Placing dropdown (same pattern as the Settings dropdowns).
  if (placingDropdown) {
    const btn = placingDropdown.querySelector(".setting-dropdown-btn");
    const text = placingDropdown.querySelector(".setting-dropdown-text");
    const menu = placingDropdown.querySelector(".setting-dropdown-menu");
    const opts = placingDropdown.querySelectorAll(".setting-dropdown-option");
    btn?.addEventListener("click", e => {
      e.stopPropagation();
      menu?.classList.toggle("hidden");
    });
    opts.forEach(opt => {
      opt.addEventListener("click", () => {
        if (btn) btn.dataset.value = opt.dataset.value;
        if (text) text.textContent = opt.textContent;
        opts.forEach(o => o.classList.toggle("active", o === opt));
        menu?.classList.add("hidden");
        syncPoints();
      });
    });
    document.addEventListener("click", e => {
      if (!placingDropdown.contains(e.target)) menu?.classList.add("hidden");
    });
  }

  const resetPlacing = () => {
    if (!placingDropdown) return;
    const btn = placingDropdown.querySelector(".setting-dropdown-btn");
    const text = placingDropdown.querySelector(".setting-dropdown-text");
    if (btn) btn.dataset.value = "";
    if (text) text.textContent = "Placing";
    placingDropdown.querySelectorAll(".setting-dropdown-option").forEach(o => o.classList.remove("active"));
    syncPoints();
  };

  // Set the placing dropdown to a specific value (used when editing a result).
  const setPlacing = (value) => {
    if (!placingDropdown) return;
    const btn = placingDropdown.querySelector(".setting-dropdown-btn");
    const text = placingDropdown.querySelector(".setting-dropdown-text");
    let matched = null;
    placingDropdown.querySelectorAll(".setting-dropdown-option").forEach(o => {
      const on = o.dataset.value === String(value);
      o.classList.toggle("active", on);
      if (on) matched = o;
    });
    if (btn) btn.dataset.value = matched ? String(value) : "";
    if (text) text.textContent = matched ? matched.textContent : "Placing";
    syncPoints();
  };

  const closePopup = () => popup?.classList.add("hidden");

  // When set, the Add popup is editing this existing result instead of adding.
  let revoxEditCtx = null;

  // Open the Add Result popup. With editCtx it edits an existing result for
  // that member; without it, adds a new one. Revox Admins only.
  const openPopup = (prefillName, editCtx) => {
    if (!popup || !isRevoxAdminUnlocked()) return;
    revoxEditCtx = editCtx || null;
    const titleEl = popup.querySelector(".popup-title");
    const confirmBtn = document.getElementById("revox-add-confirm");
    if (titleEl) titleEl.textContent = editCtx ? "Edit Result" : "Add Result";
    if (confirmBtn) confirmBtn.textContent = editCtx ? "Save" : "Add";
    if (tournamentEl) tournamentEl.value = editCtx ? (editCtx.tournament || "") : "";
    // The member is fixed when pre-filled (row Add) or editing — lock the name.
    const locked = (typeof prefillName === "string" && prefillName !== "") || !!editCtx;
    if (nameEl) {
      nameEl.value = locked ? (prefillName || "") : "";
      nameEl.readOnly = locked;
      nameEl.classList.toggle("revox-name-locked", locked);
    }
    if (dateEl) dateEl.value = (editCtx && editCtx.date) ? editCtx.date : todayISO();
    if (editCtx && editCtx.placing) setPlacing(String(editCtx.placing));
    else resetPlacing();
    setStatus("");
    popup.classList.remove("hidden");
    setTimeout(() => tournamentEl?.focus(), 0);
  };
  // Exposed so a ranking row's Add button can open this pre-filled.
  revoxAddPopupOpener = openPopup;

  document.getElementById("revox-add-btn")?.addEventListener("click", () => openPopup());
  document.getElementById("revox-add-cancel")?.addEventListener("click", closePopup);
  // Click the dimmed backdrop (but not the card) to dismiss.
  popup?.addEventListener("click", e => { if (e.target === popup) closePopup(); });

  document.getElementById("revox-add-confirm")?.addEventListener("click", () => {
    if (!isRevoxAdminUnlocked()) return;
    const tournament = (tournamentEl?.value || "").trim();
    const name = (nameEl?.value || "").trim();
    const date = (dateEl?.value || "").trim();
    const placing = placingDropdown?.querySelector(".setting-dropdown-btn")?.dataset.value || "";
    if (!tournament) { setStatus("Enter a tournament name."); return; }
    if (!name) { setStatus("Enter a member name."); return; }
    if (!date) { setStatus("Pick a date."); return; }
    if (!placing) { setStatus("Pick a placing."); return; }
    const pts = revoxPointsForPlacing(placing);
    setStatus("Saving…");
    const done = () => { closePopup(); renderRevoxRanking(); };
    if (revoxEditCtx) {
      const ctx = revoxEditCtx;
      updateRevoxResult(ctx.key, ctx.resultId, { tournament, placing: Number(placing), points: pts, date })
        .then(done).catch(e => setStatus("Save failed: " + (e?.message || e)));
    } else {
      addRevoxEntry(name, pts, tournament, Number(placing), date)
        .then(done).catch(e => setStatus("Add failed: " + (e?.message || e)));
    }
  });

  // Tournament-history popup — dismissed by the Close button or the backdrop.
  const historyPopup = document.getElementById("revox-history-popup");
  const closeHistory = () => historyPopup?.classList.add("hidden");
  document.getElementById("revox-history-close")?.addEventListener("click", closeHistory);
  historyPopup?.addEventListener("click", e => { if (e.target === historyPopup) closeHistory(); });
})();
