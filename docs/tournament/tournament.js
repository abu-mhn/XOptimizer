// docs/js/tournament.js - Swiss/single-elim tournament logic + live sync (Firebase)
// ================= SWISS LIVE SYNC (Firebase Realtime DB) =================
// When a host generates groups, TWO room codes are created:
//   - room (edit) code: mirrors state at `swissRooms/{editCode}`
//   - participant code: view only (mapped via `swissViewCodes/{viewCode}` -> editCode)
// The room state lives at `swissRooms/{editCode}` with `viewCode` as metadata.
//
// Entering a code only decides what you SEE locally. Scoring is gated by the
// DB rules (database.rules.json): `matches` (and other state) writes are
// accepted only from the host UID or a UID listed under `coHostUids`. That
// map is populated by syncCoHostUidWrite for a SIGNED-IN user whose username
// the host added to the room's `subHosts` list — so the co-host code alone
// grants no write access; a co-host must be signed in AND on the host's
// co-host list. The host (device that created the room) additionally has
// authority to reset (wipes remote).
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
let swissHostNameCache = {};     // hostUid -> resolved username (rooms with no stored hostName)
let swissHostNameResolving = {}; // hostUid -> in-flight resolve guard
let swissSessionRole = null;     // this session's role: "host" | "co-host" | "participant" | "view"
let swissArchiveView = false;    // viewing a finished tournament from the public Past archive (read-only, no live room)
let swissArchiveState = null;    // the archived tournament being viewed — kept in memory (NOT localStorage) so it never leaks into a real local tournament across page navigation
const pastTournamentArchived = new Set(); // editCodes this session already snapshotted to pastTournaments

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

// Authoritative "is the signed-in account this room's host?" check — the
// room's hostUid matched against the current user. Unlike the device-wide
// isRoomHosted() flag, this is account-scoped, so a different account
// signing in on the same device is never mistaken for the host.
function isCurrentUserRoomHost(room) {
  const u = (typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null;
  return !!(u && u.uid && room && room.hostUid && u.uid === room.hostUid);
}

function saveJoinedRoom(info) {
  if (info) {
    // Stamp the owning account's uid. The joined-room pointer is
    // device-wide localStorage, so initSwissRoomOnLoad uses this to
    // auto-reconnect ONLY for the same account — a different account
    // signing in on the same device must not inherit this room.
    const user = (typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null;
    const rec = Object.assign({}, info, { uid: (user && user.uid) || "" });
    localStorage.setItem(SWISS_ROOM_STORAGE, JSON.stringify(rec));
  } else {
    localStorage.removeItem(SWISS_ROOM_STORAGE);
  }
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
  swissCoHostUidWritten = false;
  swissCoHostUidReady = Promise.resolve();
  swissSessionRole = null;
  saveJoinedRoom(null);
  // Drop any match-linked state on the scoreboard so leaving a room doesn't
  // leave stale match names / score / save callback on the overlay.
  if (typeof window.resetScoreboardToDefault === "function") {
    window.resetScoreboardToDefault();
  }
}

// Strip metadata fields (viewCode, subHosts, coHostUids) before persisting
// remote state locally — they aren't part of the tournament model and
// shouldn't land in loadSwiss. coHostUids is a rule-layer permission map
// (UID → true) that lets Firebase rules gate match writes to host + co-hosts.
function stripRoomMetadata(remote) {
  if (!remote) return remote;
  const { viewCode, subHosts, coHostUids, ...state } = remote;
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
  syncCoHostUidWrite();
}

// Plain-language reason a would-be co-host can't score, matched to the DB
// rules: `matches` writes are only accepted from the host or a SIGNED-IN
// user whose UID is in `coHostUids` — which is populated only when their
// USERNAME is on the host's co-host list (see syncCoHostUidWrite). Entering
// the co-host *code* is not enough. Used to turn the previously-silent
// "tap does nothing" into an actionable message.
function coHostEditBlockReason() {
  const signedIn = !!((window.getCurrentUser && window.getCurrentUser()) || null);
  if (!signedIn) {
    return "You're not signed in on this device, so scoring is locked. Sign in with the account the host added as a co-host, then reopen the tournament.";
  }
  const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  if (!uname) {
    return "Your profile is still loading. Give it a moment, then tap the match again.";
  }
  return `“${uname}” isn't on this tournament's co-host list, so scoring is locked. Ask the host to add this exact username under “Manage co-hosts,” then reopen the tournament.`;
}

function notifyCoHostEditBlocked() {
  alert(coHostEditBlockReason());
}

// Tracks whether THIS device has already written its UID into the room's
// `coHostUids` map for the current session — keeps `syncCoHostUidWrite`
// idempotent so it doesn't churn Firebase on every render. Reset on
// disconnect.
let swissCoHostUidWritten = false;

// Resolves once this device's `coHostUids/<uid>` write has committed (or
// immediately when no write is needed — host, viewer, or already written).
// Match/state pushes chain off this so a co-host who scores in the first
// moment after joining doesn't fire the match write BEFORE the permission
// write lands (which the DB rules would reject).
let swissCoHostUidReady = Promise.resolve();

// Mirror the current user's co-host status into `swissRooms/<code>/coHostUids/<uid>`
// so the security rules can rule-gate match / state writes on host + co-hosts
// (the rules can't read the username-keyed `subHosts` list because that
// requires resolving username → UID at write time, which rules can't do).
// Self-write only — auth.uid must equal the key the rule will accept.
function syncCoHostUidWrite() {
  if (!swissRoomRef) return;
  const user = (window.getCurrentUser && window.getCurrentUser()) || null;
  const uid = user && user.uid;
  if (!uid) {
    swissCoHostUidWritten = false;
    return;
  }
  // The host is already authorised via hostUid; no need to also list them
  // as a co-host. If they were previously stored there (e.g. they used
  // to be a co-host before taking the room over), clear that entry.
  if (swissIsHost) {
    if (swissCoHostUidWritten) {
      swissRoomRef.child("coHostUids/" + uid).set(null).catch(() => {});
      swissCoHostUidWritten = false;
    }
    return;
  }
  const isSub = isCurrentUserSubHost();
  if (isSub && !swissCoHostUidWritten) {
    // Capture the write promise so match pushes can wait for it to land.
    swissCoHostUidReady = swissRoomRef.child("coHostUids/" + uid).set(true).catch(() => {});
    swissCoHostUidWritten = true;
  } else if (!isSub && swissCoHostUidWritten) {
    swissRoomRef.child("coHostUids/" + uid).set(null).catch(() => {});
    swissCoHostUidWritten = false;
    swissCoHostUidReady = Promise.resolve();
  }
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
  swissSessionRole = role;
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
      // Compare the previous local state with the incoming remote and
      // pop a toast for any match that just transitioned to "started"
      // (startedAt null/missing → set). Runs BEFORE we overwrite local
      // storage so the diff has a real before-state. Skips the device
      // that started the match itself (swissLiveMatchId === id).
      // Also detect "the host removed me" by checking whether any
      // registrant entries this device owned are now gone from remote.
      try {
        const prevState = JSON.parse(localStorage.getItem(SWISS_KEY) || "null") || {};
        detectAndAnnounceMatchStarts(prevState, remote);
        detectAndAnnounceMyMatchResults(prevState, remote);
        detectSelfRemovedFromRoom(prevState, remote, editCode);
      } catch (e) { /* non-fatal */ }
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
      // Keep the room's stored host name in step with the host's account
      // (backfills older rooms and follows a profile rename).
      if (swissIsHost && !swissApplyingRemote) {
        const hn = (window.getCurrentUsername && window.getCurrentUsername()) || "";
        if (hn && remote.hostName !== hn) {
          swissRoomRef.child("hostName").set(hn).catch(() => {});
        }
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
  // Record the actual role (asHost) too — initSwissRoomOnLoad reconnects
  // with exactly this, instead of guessing from the device-wide
  // hosted-rooms flag (which would mis-promote a co-host / viewer to host
  // on a device that hosted the room under another account). sessionRole
  // carries the finer "participant" vs "view" distinction so a reload
  // keeps a participant's participant-only UI (e.g. Register Others).
  saveJoinedRoom({ editCode, viewCode: swissViewCode, role: canEdit ? "edit" : "view", asHost: !!asHost, sessionRole: role });
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
  // Wait for the coHostUids permission write to land first (resolved instantly
  // for the host / already-written case) so the rules don't reject this.
  swissCoHostUidReady
    .then(() => swissRoomRef.update(updates))
    .catch(e => console.warn("Swiss match push failed:", e));
}

// Small push for just the "match is being scored" flag so other refs see
// the in-progress state the moment someone opens the scoreboard.
function pushSwissMatchStart(matchId, startedAt) {
  if (swissApplyingRemote) return;
  if (!swissRoomRef || !swissCanEdit) return;
  swissCoHostUidReady
    .then(() => swissRoomRef.child(`matches/${matchId}/startedAt`).set(startedAt))
    .catch(e => console.warn("Swiss start push failed:", e));
}

function initSwissRoomOnLoad() {
  // A finished tournament shouldn't reopen as the Hosting landing view. The
  // completed board is rendered from the local SWISS_KEY snapshot, which
  // survives reloads independently of the room pointer — so a stale "complete"
  // state shows even when there's no reconnect pointer at all. Clear it here,
  // up front, so the load lands on the setup form / Open Tournaments list. The
  // tournament stays reachable from the Past archive and Tournament History.
  const localState = loadSwiss();
  if (localState && typeof isTournamentComplete === "function" && isTournamentComplete(localState)) {
    saveJoinedRoom(null);
    localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
    if (typeof renderSwiss === "function") renderSwiss();
    return;
  }

  const info = loadJoinedRoom();
  if (!info || !info.editCode) return;
  if (!firebaseReady()) return;

  // The joined-room pointer is device-wide localStorage. Auto-reconnect
  // ONLY for the account that saved it — otherwise a different account
  // signing in on the same device is dropped into the previous account's
  // tournament. Defer the decision until Firebase reports the auth state.
  //
  // iOS quirk: hard-killing Safari can evict Firebase's IndexedDB auth
  // persistence even when localStorage survives. The user re-opens, auth
  // comes back as null, currentUid is empty, and a strict mismatch check
  // would wipe a legitimate room. Distinguish "auth was lost on this
  // device" (info.uid set, currentUid empty) from "different account
  // signed in" (both set, but different) — the first reconnects as a
  // read-only viewer so the user keeps seeing the room and can sign in
  // again to restore host / co-host privileges. The second still wipes.
  const proceed = (user) => {
    const currentUid = (user && user.uid) || "";
    const savedUid = info.uid || "";
    const sameAccount = savedUid === currentUid;
    const authLostOnThisDevice = savedUid && !currentUid;
    if (!sameAccount && !authLostOnThisDevice) {
      // Different signed-in account on the same device — discard the
      // previous account's pointer, wipe any leftover room state, and
      // show the lobby.
      saveJoinedRoom(null);
      localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
      if (typeof renderSwiss === "function") renderSwiss();
      return;
    }
    // Reconnect with the role actually saved at join time — NOT the
    // device-wide isRoomHosted() flag, which would re-enter a co-host /
    // viewer as host on a device that once hosted this room.
    //
    // If auth was lost (authLostOnThisDevice), force read-only / viewer
    // role for this session — host / co-host writes need a matching
    // auth.uid against the Firebase rules and would just be rejected
    // anyway. The user can sign back in to regain edit privileges; until
    // then they at least see the room rather than the empty lobby.
    const asHost = !authLostOnThisDevice && !!info.asHost;
    const canEdit = !authLostOnThisDevice && (asHost || info.role === "edit");
    const sessionRole = authLostOnThisDevice
      ? (info.sessionRole === "participant" ? "participant" : "view")
      : (info.sessionRole || null);
    const reconnect = () =>
      connectSwissRoom(info.editCode, info.viewCode || null, asHost, canEdit, sessionRole);

    // A finished tournament shouldn't hijack the landing page on every load —
    // the device pointer is meant to resume LIVE rooms, not replay completed
    // ones. Peek at the room once; if it's already complete, drop the pointer
    // and fall back to the setup form / Open Tournaments list (same landing the
    // "room was deleted" branch uses). The tournament stays reachable from the
    // Past archive and Tournament History. A read failure falls through to the
    // normal reconnect so a transient network hiccup never strands the user
    // out of a live room.
    const db = initFirebase();
    if (!db) { reconnect(); return; }
    db.ref("swissRooms/" + info.editCode).once("value").then(snap => {
      const remote = snap.val();
      if (remote && typeof isTournamentComplete === "function" && isTournamentComplete(remote)) {
        saveJoinedRoom(null);
        localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
        if (typeof renderSwiss === "function") renderSwiss();
        return;
      }
      reconnect();
    }).catch(reconnect);
  };

  if (typeof window.onAuthChange === "function") {
    let handled = false;
    window.onAuthChange((user) => {
      if (handled) return; // act only on the first (initial) auth resolution
      handled = true;
      proceed(user);
    });
  } else {
    proceed((typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null);
  }
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
function tournamentFormatLabel(mode, pairing, shortElim, topN) {
  if (mode === "single-elim") return shortElim ? "Single Elim" : "Single Elimination";
  const base = pairing === "round-robin" ? "Round Robin" : "Swiss";
  if (mode === "swiss-only") return base;
  const n = (typeof topN === "number" && topN >= 2) ? topN : 8;
  return `${base} + Top ${n}`;
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
    deck: normalizeBeyCheckDeck(r && r.deck),
    paid: !!(r && r.paid)
  }));
}

// True when the signed-in account may toggle fee-paid status: the host always,
// or a Keeper who's in the room as a co-host (so the write passes the rules).
function canMarkFeePaid() {
  const isKeeperAcct = typeof window.isKeeper === "function" && window.isKeeper();
  return !!swissCanEdit && (swissIsHost || isKeeperAcct);
}

// Toggle one registrant's fee-paid flag. Writes registrants/<id>/paid; the
// room listener re-renders. Optimistically updates locally so the chip flips
// immediately.
function setRegistrantPaid(regId, paid) {
  if (!regId || !canMarkFeePaid()) return;
  const next = !!paid;
  if (swissRoomRef) {
    swissRoomRef.child("registrants/" + regId + "/paid").set(next).catch(e => {
      console.warn("Couldn't update payment status:", e);
      alert("Couldn't update the payment status — you may not have permission.");
    });
  }
  const s = loadSwiss();
  if (s && s.registrants && s.registrants[regId]) {
    s.registrants[regId].paid = next;
    persistSwiss(s);
    renderSwiss();
  }
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
  // The Past-archive view holds its (read-only) state in memory, not
  // localStorage, so it can't survive a page navigation as a fake local room.
  if (swissArchiveView && swissArchiveState) {
    try { return JSON.parse(JSON.stringify(swissArchiveState)); } catch (e) {}
  }
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
//
// `placementDepth` is any integer ≥ 2 — how many finishers the host wants
// ranked. The bracket is built in pairs (each placement match decides two
// adjacent places), so a placement match is created when its higher (odd)
// place is within the depth. Structure grows in tiers, each needing a
// deep-enough bracket:
//   - 2:    just the Final (1st/2nd)
//   - 3–4:  + 3rd-place match (needs ≥ 4 players)
//   - 5–8:  + CQF consolation → 5th and 7th matches (needs a QF round)
//   - 9–16: + a Loser Bracket off the R16 round → 9th…15th matches
//           (needs an R16 round, i.e. bracketSize ≥ 16)
// The host may enter any number, but the loser bracket only hangs off R16,
// so the deepest place the engine can actually rank is 16th. Requested
// depth is clamped down to whatever the bracket can host (effectiveDepth) —
// e.g. an 8-player bracket caps at 8, a 4-player at 4, and SE_DEPTH_CEILING
// (16) is the structural ceiling for any size.
const SE_DEPTH_MIN = 2;
const SE_DEPTH_CEILING = 16; // deepest place the current loser-bracket structure can rank
// Accepts any number ≥ 2 — no upper limit. The bracket caps the *effective*
// ranking depth at generation time (SE_DEPTH_CEILING / bracket size), so a
// large request just ranks as deep as the structure allows.
function clampPlacementDepth(v, fallback = 8) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(SE_DEPTH_MIN, n);
}
function generateSingleElimFromText(text, tournamentName, placementDepth) {
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

  const requestedDepth = clampPlacementDepth(placementDepth);
  // Each tier needs a deep-enough bracket to host its consolation rounds:
  // R16 loser bracket (9–16) needs preFinalRounds ≥ 3, the CQF consolation
  // (5–8) needs ≥ 2, the 3rd-place match (3–4) needs ≥ 1. Clamp the requested
  // depth down to what this bracket can actually rank so generation,
  // propagation and rendering all stay consistent.
  const capByBracket = preFinalRounds >= 3 ? SE_DEPTH_CEILING
    : preFinalRounds >= 2 ? 8
    : preFinalRounds >= 1 ? 4
    : 2;
  const effectiveDepth = Math.min(requestedDepth, capByBracket);

  const state = {
    groups: null,
    matches: {},
    groupRounds: [],
    mode: "single-elim",
    bracketSize,
    preFinalRounds,
    placementDepth: effectiveDepth,
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
    // Each placement match decides a pair of places — build it when its
    // higher (odd) place is within the depth (3rd ranks 3rd/4th, 5th ranks
    // 5th/6th, …). Feeder rounds (cqf, c16) are built when any placement
    // match they feed is built.
    if (unique.length >= 4 && effectiveDepth >= 3) {
      state.matches["bracket-3rd-0"] = emptyBracketMatch("3rd", 0);
    }
    // 5th–8th: QF losers feed two consolation QFs which in turn feed the
    // 5th- and 7th-place matches. Mirrors Swiss + Top 8. Requires a real
    // QF round (bracketSize ≥ 8 → preFinalRounds ≥ 2).
    if (preFinalRounds >= 2 && effectiveDepth >= 5) {
      state.matches["bracket-cqf-0"] = emptyBracketMatch("cqf", 0);
      state.matches["bracket-cqf-1"] = emptyBracketMatch("cqf", 1);
      state.matches["bracket-5th-0"] = emptyBracketMatch("5th", 0);
      if (effectiveDepth >= 7) {
        state.matches["bracket-7th-0"] = emptyBracketMatch("7th", 0);
      }
    }
    // 9th–16th: a Loser Bracket fed by R16 losers (8 players). The R16 round
    // only exists in brackets with preFinalRounds ≥ 3 (bracketSize ≥ 16).
    // Mini single-elim:
    //   c16-r0 (4 matches: 8 R16 losers play)
    //     → winners feed c16-sfw (2 matches: top-half SF)
    //       → 9th (depth ≥ 9) & 11th (depth ≥ 11) place finals
    //     → losers feed c16-sfl (2 matches: bottom-half SF — depth ≥ 13)
    //       → 13th (depth ≥ 13) & 15th (depth ≥ 15) place finals
    if (preFinalRounds >= 3 && effectiveDepth >= 9) {
      for (let j = 0; j < 4; j++) {
        state.matches[`bracket-c16-r0-${j}`] = emptyBracketMatch("c16-r0", j);
      }
      state.matches["bracket-c16-sfw-0"] = emptyBracketMatch("c16-sfw", 0);
      state.matches["bracket-c16-sfw-1"] = emptyBracketMatch("c16-sfw", 1);
      state.matches["bracket-9th-0"] = emptyBracketMatch("9th", 0);
      if (effectiveDepth >= 11) {
        state.matches["bracket-11th-0"] = emptyBracketMatch("11th", 0);
      }
      if (effectiveDepth >= 13) {
        state.matches["bracket-c16-sfl-0"] = emptyBracketMatch("c16-sfl", 0);
        state.matches["bracket-c16-sfl-1"] = emptyBracketMatch("c16-sfl", 1);
        state.matches["bracket-13th-0"] = emptyBracketMatch("13th", 0);
        if (effectiveDepth >= 15) {
          state.matches["bracket-15th-0"] = emptyBracketMatch("15th", 0);
        }
      }
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
  // Loser-bracket rounds (depth ≥ 12). c16-r0 is fed by R16 losers; the
  // c16-sfw/sfl rounds are fed by c16-r0 winners / losers; the 9-15
  // placement finals are fed by the matching sfw / sfl match.
  if (round === "c16-r0") {
    if (preFinal < 3) return null;
    const j = bracketIndex * 2 + (slot === "a" ? 0 : 1);
    return `bracket-r${preFinal - 3}-${j}`;
  }
  if (round === "c16-sfw" || round === "c16-sfl") {
    const j = bracketIndex * 2 + (slot === "a" ? 0 : 1);
    return `bracket-c16-r0-${j}`;
  }
  if (round === "9th" || round === "11th") {
    return `bracket-c16-sfw-${slot === "a" ? 0 : 1}`;
  }
  if (round === "13th" || round === "15th") {
    return `bracket-c16-sfl-${slot === "a" ? 0 : 1}`;
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

// ---------------- Self-cancel from room ----------------
// "Owned" registrant entries are ones the user can delete themselves —
// either authed (createdBy matches auth.uid) or tracked locally for
// unauthed guests (no createdBy stamp, but the device created them).
// Tracked per room so leaving one tournament doesn't affect another.
function ownedRegistrantsKey(editCode) {
  return "beyblade_owned_regs:" + editCode;
}

function loadDeviceOwnedRegIds(editCode) {
  if (!editCode) return [];
  try {
    const raw = localStorage.getItem(ownedRegistrantsKey(editCode));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(id => typeof id === "string") : [];
  } catch (e) { return []; }
}

function rememberDeviceOwnedRegIds(editCode, ids) {
  if (!editCode || !Array.isArray(ids) || !ids.length) return;
  const existing = new Set(loadDeviceOwnedRegIds(editCode));
  ids.forEach(id => { if (id) existing.add(id); });
  localStorage.setItem(ownedRegistrantsKey(editCode), JSON.stringify(Array.from(existing)));
}

function clearDeviceOwnedRegIds(editCode) {
  if (!editCode) return;
  localStorage.removeItem(ownedRegistrantsKey(editCode));
}

// Registrant IDs the current user is allowed to delete: createdBy matches
// their auth.uid OR the device tracked the ID locally (unauthed guests).
// Filters against the live state so stale localStorage entries (already
// removed by the host) don't show up.
function findMyRegistrantIds(state, editCode) {
  if (!state || !state.registrants) return [];
  const out = new Set();
  const myUid = (window.getCurrentUser && window.getCurrentUser()?.uid) || "";
  Object.entries(state.registrants).forEach(([id, r]) => {
    if (!r) return;
    if (myUid && r.createdBy === myUid) out.add(id);
  });
  loadDeviceOwnedRegIds(editCode).forEach(id => {
    if (state.registrants[id]) out.add(id);
  });
  return Array.from(out);
}

function resetSwiss() {
  const state = loadSwiss();
  const hasAny = state.groups || Object.keys(state.matches || {}).length > 0 || isRegisteringPhase(state);
  const inRoom = !!swissEditCode;
  // Self-cancel — registrant IDs the user owns in this room. Only
  // meaningful for non-hosts during the registering phase: hosts use
  // the X-next-to-name button, and a started tournament can't have its
  // registrants pulled out mid-flight without breaking pairings.
  const canSelfCancel = inRoom && !swissIsHost && isRegisteringPhase(state);
  const myRegIds = canSelfCancel ? findMyRegistrantIds(state, swissEditCode) : [];
  // The dialog only describes the live room being torn down. Past
  // tournament history entries (Tournament History tab) are stored
  // separately and never touched by reset.
  let promptMsg;
  if (inRoom && !swissIsHost) {
    promptMsg = myRegIds.length
      ? "Leave this live room? Your registration will be removed too."
      : "Leave this live room?";
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

  // Delete owned registrant entries BEFORE detaching the listener — the
  // listener has to be alive to issue the writes through swissRoomRef.
  // Failures are non-fatal (rule rejection on an unauthed-guest delete is
  // expected if the room's rule clause isn't updated yet) — surface a
  // warning rather than block the leave flow.
  if (myRegIds.length && swissRoomRef) {
    const updates = {};
    myRegIds.forEach(id => { updates[`registrants/${id}`] = null; });
    swissRoomRef.update(updates).catch(e => {
      console.warn("Self-cancel failed for some entries:", e);
      alert("Couldn't fully remove your registration — your device left the room, but the host may still see your name. Ask them to remove you, or sign in first.");
    });
    // Bump the lobby's cached count. Non-fatal — host listener also resyncs.
    if (dbHandle && codeForRemote) {
      dbHandle.ref("swissRooms/" + codeForRemote + "/registrants").once("value").then(s => {
        const total = Math.max(0, s.numChildren() - myRegIds.length);
        return dbHandle.ref("openTournaments/" + codeForRemote + "/registrantCount").set(total);
      }).catch(() => {});
    }
  }
  if (canSelfCancel) clearDeviceOwnedRegIds(codeForRemote);

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
  if (swissEditCode && !swissCanEdit) { notifyCoHostEditBlocked(); return; }
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

    let extraUpdates = null;

    // Auto-generate the knockout bracket the moment every group's final
    // round completes, so no one has to hunt for a "Start" button.
    // Only fires once — the hasSwissBracket guard makes this idempotent for
    // late edits that don't change group completion. Skipped for swiss-only
    // mode, which ends after the group stage with no knockout.
    if (s.mode !== "swiss-only" && !stored.bracket && isGroupStageComplete(s) && !hasSwissBracket(s)) {
      const bracketMatches = buildBracketMatches(s);
      Object.assign(s.matches, bracketMatches);
      newMatchIds = (newMatchIds || []).concat(Object.keys(bracketMatches));
      // buildTopNBracketMatches stamps bracketSize / preFinalRounds onto the
      // state so the renderer + propagation know the shape — push them too,
      // otherwise other devices would render an empty / mis-shaped bracket.
      if (typeof s.bracketSize === "number" || typeof s.preFinalRounds === "number") {
        extraUpdates = extraUpdates || {};
        if (typeof s.bracketSize === "number") extraUpdates["bracketSize"] = s.bracketSize;
        if (typeof s.preFinalRounds === "number") extraUpdates["preFinalRounds"] = s.preFinalRounds;
      }
    }

    // Bracket match: propagate both winner and loser into their respective
    // downstream slots. Winners go up the main bracket (SF → F) or the
    // consolation bracket (CQF → 5th); losers drop into placement matches
    // (SF → 3rd, QF → CQF, CQF → 7th). Ties leave both downstream slots
    // blank so the UI flags them for re-scoring.
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

    // Win-rate update. Bump the global /winRates counters once per match,
    // gated on a wrApplied flag so re-scoring doesn't double-count. Only
    // non-guest registrants are tracked (guests / single-elim by-name
    // entries don't have a stable account key). Runs after the bracket
    // propagation so a match's terminal state is recorded first.
    if (!isEdit) {
      const wrUpdates = maybeApplyMatchWinRate(matchId, stored, s);
      if (wrUpdates && wrUpdates.matchPatch) {
        // Mark the match as counted on the local state + Firebase so other
        // devices see the flag and don't re-apply.
        Object.assign(stored, wrUpdates.matchPatch);
        extraUpdates = extraUpdates || {};
        Object.entries(wrUpdates.matchPatch).forEach(([k, v]) => {
          extraUpdates[`matches/${matchId}/${k}`] = v;
        });
      }
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
          ${swissMatchNameCell(m.a, ' <span class="swiss-bye-tag">BYE</span>')}
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
        ${swissMatchNameCell(m.a)}
        <span class="swiss-score-cell ${aWin ? "swiss-score-win" : ""}">${aScore}</span>
      </div>
      <div class="swiss-match-row ${bWin ? "swiss-match-row-win" : done ? "swiss-match-row-lose" : ""}">
        <span class="swiss-seed">${seedB}</span>
        ${swissMatchNameCell(m.b)}
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
    const nameInner = swissNameCellInner(row.name);
    const nameCell = canEdit
      ? `<button type="button" class="swiss-name-cell swiss-name-edit" data-rename="${escapeHtml(row.name)}" title="Tap to rename">${nameInner}</button>`
      : `<span class="swiss-name-cell">${nameInner}</span>`;
    return `
    <li>
      <span class="swiss-rank">${idx + 1}</span>
      ${nameCell}
      <span class="swiss-record">${row.wins}W-${row.losses}L-${row.draws}D</span>
      <span class="swiss-tiebreak" title="Points Scored · Points Difference · Median-Buchholz">PS ${row.pointsScored} · PD ${pd} · MB ${row.medianBuchholz}</span>
    </li>
  `;
  }).join("");
  return `<ol class="swiss-members">${rows}</ol>
    <p class="swiss-tiebreak-legend">
      <span class="swiss-record">W-L-D</span> Wins-Losses-Draws ·
      <strong>PS</strong> Points Scored ·
      <strong>PD</strong> Points Difference ·
      <strong>MB</strong> Median-Buchholz (tiebreaker)
    </p>`;
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

// Inner HTML for a name cell: the player's avatar (silhouette placeholder
// until hydrateTournamentAvatars swaps in the real photo) plus the name.
// `extraHtml` is optional trailing markup, e.g. the BYE tag. A real player
// name gets data-reg-name so the hydrator can resolve it; "TBD" / empty
// slots get a plain placeholder with no lookup.
function swissNameCellInner(name, extraHtml) {
  const clean = String(name == null ? "" : name);
  const isReal = clean && clean !== "TBD";
  const attr = isReal ? ` data-reg-name="${escapeHtml(clean)}"` : "";
  return `<img class="swiss-name-avatar" src="${PROFILE_VIEW_PHOTO_PH}" alt=""${attr}>`
    + `<span class="swiss-name-text">${escapeHtml(clean || "TBD")}</span>`
    + (extraHtml || "");
}

// Full match-card name cell — the inner content wrapped in a .swiss-name-cell
// span. (Standings build their own wrapper, since the cell there is a
// tap-to-rename button — see renderSwissGroupStandings.)
function swissMatchNameCell(name, extraHtml) {
  return `<span class="swiss-name-cell">${swissNameCellInner(name, extraHtml)}</span>`;
}

function renderSwissBracketCard(label, id, m) {
  // Bracket BYE — one slot empty, auto-scored. Renders as a single-row card.
  if (m.bye) {
    const player = m.a || m.b || "";
    return `<div class="swiss-match-wrap">
      <div class="swiss-match-num">${label}</div>
      <div class="swiss-match-card swiss-match-card-bracket swiss-match-bye">
        <div class="swiss-match-row swiss-match-row-win swiss-match-row-bye">
          ${swissMatchNameCell(player, ' <span class="swiss-bye-tag">BYE</span>')}
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
        ${swissMatchNameCell(m.a || "TBD")}
        <span class="swiss-score-cell ${aWin ? "swiss-score-win" : ""}">${aScore}</span>
      </div>
      <div class="swiss-match-row ${bWin ? "swiss-match-row-win" : (done && !isTie) ? "swiss-match-row-lose" : ""}">
        ${swissMatchNameCell(m.b || "TBD")}
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
    const cleanName = String(r.name || "");
    const nameAttr = cleanName ? ` data-reg-name="${escapeHtml(cleanName)}"` : "";
    // data-rank-name / data-rank-place let hydrateTop8Banners paint the
    // row with the player's profile banner (medal-tinted scrim for 1-3).
    const rowAttr = cleanName
      ? ` data-rank-name="${escapeHtml(cleanName)}" data-rank-place="${r.rank}"`
      : "";
    return `
      <li class="swiss-top-rank${rankClass}"${rowAttr}>
        <span class="swiss-top-rank-num">${ordinal(r.rank)}</span>
        <span class="swiss-top-rank-medal">${medal(r.rank)}</span>
        <img class="swiss-name-avatar" src="${PROFILE_VIEW_PHOTO_PH}" alt=""${nameAttr}>
        <span class="swiss-top-rank-name"${cleanName ? ` data-profile-username="${escapeHtml(cleanName)}"` : ""}>${escapeHtml(cleanName)}</span>
      </li>
    `;
  }).join("");

  return `<ol class="swiss-top-8">${items}</ol>`;
}

function renderSwissBracket(state) {
  if (state.mode === "single-elim") {
    return renderSingleElimBracket(state);
  }
  // Legacy Top 8 tournaments keep their QF/SF/F structure — those matches
  // are already in Firebase under those exact ids. New tournaments with a
  // configurable topN use the single-elim renderer (round-indexed match ids).
  const hasLegacyQF = Object.keys(state.matches || {}).some(k => k.startsWith("bracket-qf-"));
  if (hasLegacyQF) return renderSwissTop8Bracket(state);
  if (typeof state.topN === "number" && state.topN >= 2) {
    return renderSwissTopNBracket(state);
  }
  return renderSwissTop8Bracket(state);
}

// Wrapper around the single-elim renderer for a Swiss+TopN knockout. Just
// swaps the section header so the "Single Elimination — N-slot bracket"
// title reads "Knockout — Top N" instead.
function renderSwissTopNBracket(state) {
  const html = renderSingleElimBracket(state);
  const n = state.topN || state.bracketSize || 8;
  return html.replace(
    /<span class="swiss-bracket-title">[^<]*<\/span>/,
    `<span class="swiss-bracket-title">Knockout — Top ${n}</span>`
  );
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

  // Loser Bracket — only present when placementDepth ≥ 9 produced the c16
  // matches. Rendered as its own section under the main bracket.
  const loserHtml = renderSingleElimLoserBracket(state);

  return `
    <section class="swiss-bracket">
      <header class="swiss-bracket-header">
        <span class="swiss-bracket-title">Single Elimination — ${bracketSize}-slot bracket</span>
      </header>
      ${topRankings}
      <div class="swiss-rounds-scroll">
        ${columnHtml.join("")}
      </div>
      ${loserHtml}
    </section>
  `;
}

// Render the depth-12/16 loser-bracket section. Returns "" when the c16
// matches don't exist (depth = 8 or bracket too small for R16).
function renderSingleElimLoserBracket(state) {
  const r0 = [
    state.matches["bracket-c16-r0-0"],
    state.matches["bracket-c16-r0-1"],
    state.matches["bracket-c16-r0-2"],
    state.matches["bracket-c16-r0-3"]
  ];
  if (!r0.some(Boolean)) return "";

  const sfw = [state.matches["bracket-c16-sfw-0"], state.matches["bracket-c16-sfw-1"]];
  const sfl = [state.matches["bracket-c16-sfl-0"], state.matches["bracket-c16-sfl-1"]];
  const ninth = state.matches["bracket-9th-0"];
  const eleventh = state.matches["bracket-11th-0"];
  const thirteenth = state.matches["bracket-13th-0"];
  const fifteenth = state.matches["bracket-15th-0"];

  const r0Cards = r0.map((m, i) => m ? renderSwissBracketCard(`L${i + 1}`, `bracket-c16-r0-${i}`, m) : "").join("");

  const semiCols = [];
  if (sfw.some(Boolean)) {
    const sfwCards = sfw.map((m, i) => m ? renderSwissBracketCard(`9-12 SF${i + 1}`, `bracket-c16-sfw-${i}`, m) : "").join("");
    semiCols.push(`
      <div class="swiss-round-col">
        <div class="swiss-round-title">9th-12th</div>
        <div class="swiss-match-list">${sfwCards}</div>
      </div>
    `);
  }
  if (sfl.some(Boolean)) {
    const sflCards = sfl.map((m, i) => m ? renderSwissBracketCard(`13-16 SF${i + 1}`, `bracket-c16-sfl-${i}`, m) : "").join("");
    semiCols.push(`
      <div class="swiss-round-col">
        <div class="swiss-round-title">13th-16th</div>
        <div class="swiss-match-list">${sflCards}</div>
      </div>
    `);
  }

  const finalsCol = [];
  if (ninth) {
    finalsCol.push(`<div class="swiss-round-subtitle">9th Place</div>`);
    finalsCol.push(`<div class="swiss-match-list">${renderSwissBracketCard("9th", "bracket-9th-0", ninth)}</div>`);
  }
  if (eleventh) {
    finalsCol.push(`<div class="swiss-round-subtitle">11th Place</div>`);
    finalsCol.push(`<div class="swiss-match-list">${renderSwissBracketCard("11th", "bracket-11th-0", eleventh)}</div>`);
  }
  if (thirteenth) {
    finalsCol.push(`<div class="swiss-round-subtitle">13th Place</div>`);
    finalsCol.push(`<div class="swiss-match-list">${renderSwissBracketCard("13th", "bracket-13th-0", thirteenth)}</div>`);
  }
  if (fifteenth) {
    finalsCol.push(`<div class="swiss-round-subtitle">15th Place</div>`);
    finalsCol.push(`<div class="swiss-match-list">${renderSwissBracketCard("15th", "bracket-15th-0", fifteenth)}</div>`);
  }

  return `
    <header class="swiss-bracket-header swiss-bracket-subheader">
      <span class="swiss-bracket-title">Loser Bracket</span>
    </header>
    <div class="swiss-rounds-scroll">
      <div class="swiss-round-col">
        <div class="swiss-round-title">R16 Losers</div>
        <div class="swiss-match-list">${r0Cards}</div>
      </div>
      ${semiCols.join("")}
      <div class="swiss-round-col">${finalsCol.join("")}</div>
    </div>
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

// Resolve a host's account id to their username — used for older rooms that
// have no stored hostName. Caches the result and re-renders. Needs the users
// read rule; fails quietly (and marks the uid tried) without it.
function resolveHostName(uid) {
  if (!uid || (uid in swissHostNameCache) || swissHostNameResolving[uid]) return;
  const db = initFirebase();
  if (!db) return;
  swissHostNameResolving[uid] = true;
  db.ref("users/" + uid + "/username").once("value").then(snap => {
    swissHostNameResolving[uid] = false;
    swissHostNameCache[uid] = snap.val() || "";
    if (swissHostNameCache[uid] && document.getElementById("swiss-view")) renderSwiss();
  }).catch(() => {
    swissHostNameResolving[uid] = false;
    swissHostNameCache[uid] = "";
  });
}

function renderSwissRoomBadge() {
  // Only the host and co-hosts see this badge — participants and viewers
  // don't need to know who's running the room.
  if (!swissCanEdit) return "";
  const pills = [];
  const st = loadSwiss();
  const prof = (typeof getUserProfile === "function") ? getUserProfile() : null;
  const myName = (prof && prof.username) ? prof.username : "";
  const namePill = (uname) => uname
    ? `<button type="button" class="swiss-room-name swiss-profile-link" data-username="${escapeHtml(uname)}">${escapeHtml(uname)}</button>`
    : "";
  // Host pill — the host's own device falls back to their profile name until
  // the room syncs it.
  let hostName = (st && st.hostName) || "";
  if (!hostName && swissIsHost) hostName = myName;
  if (!hostName) {
    // Older rooms have no stored hostName — resolve it from the host's uid.
    const hostUid = (st && st.hostUid) || "";
    if (hostUid) {
      hostName = swissHostNameCache[hostUid] || "";
      if (!hostName) resolveHostName(hostUid);
    }
  }
  if (hostName) {
    pills.push(`
      <span class="swiss-room-badge swiss-room-badge-edit">
        <span class="swiss-room-role">Host</span>
        ${namePill(hostName)}
      </span>
    `);
  }
  // Co-host pills (blue) — one for each of the room's designated sub-hosts.
  Object.keys(swissSubHosts || {})
    .map(k => swissSubHosts[k])
    .filter(Boolean)
    .sort((a, b) => String(a).localeCompare(String(b)))
    .forEach(n => {
      pills.push(`
        <span class="swiss-room-badge swiss-room-badge-view">
          <span class="swiss-room-role">Co-host</span>
          ${namePill(n)}
        </span>
      `);
    });
  if (!pills.length) return "";
  return `<div class="swiss-room-badges">${pills.join("")}</div>`;
}

const STADIUM_OPTIONS = ["Xtreme", "Infinity", "Double Xtreme"];
const RULE_OPTIONS = ["Official", "Unofficial"];
const SHARE_TOURNAMENT_URL = "https://abu-mhn.github.io/XOptimizer/tournament/";
const SHARE_TOURNAMENT_INVITE = "To the bladers that are planning to join this event, please click the link below for registration.";
const SHARE_TOURNAMENT_INSTRUCTIONS = "New here? On the Tournament page, tap the Tutorial button (next to the QR / Refresh buttons) for a step-by-step guide on how to register as a Participant.";

function renderSwissShareButton() {
  return `<button type="button" id="swiss-share" class="btn btn-icon-sm swiss-share-btn" aria-label="Copy tournament details" title="Copy tournament details to clipboard">
    <img src="assets/icons/share.png" alt=""
         onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21AA;');">
    <span class="swiss-toolbar-btn-label">Share</span>
  </button>`;
}

// --- Sub-hosts: the host designates co-hosts by username. Anyone signed in
// with a listed username gets full co-host access — no host code needed. ---
function renderCoHostsButton() {
  return `<button type="button" id="swiss-cohosts" class="btn btn-icon-sm swiss-cohosts-btn" aria-label="Manage sub-hosts" title="Manage sub-hosts">` +
    `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>` +
    `<span class="swiss-toolbar-btn-label">Sub-hosts</span>` +
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
  // Capture the removed username before mutating the local map — we use it
  // below to look up the matching UID in `usernames/{key}/uid` and clear
  // that uid from `coHostUids`, otherwise the rule-level co-host check
  // would keep trusting them even after the host revoked them.
  const removedName = (swissSubHosts && swissSubHosts[key]) || "";
  if (swissSubHosts) delete swissSubHosts[key];
  if (swissRoomRef) {
    swissRoomRef.child("subHosts/" + key).set(null)
      .catch(e => console.warn("Sub-host remove failed:", e));
    const roomRefAtRemove = swissRoomRef;
    const ukeyFn = (typeof window.usernameKey === "function") ? window.usernameKey : null;
    const ukey = ukeyFn && removedName ? ukeyFn(removedName) : "";
    const db = initFirebase();
    if (db && ukey) {
      db.ref("usernames/" + ukey + "/uid").once("value").then(snap => {
        const uid = snap.val();
        if (typeof uid === "string" && uid && roomRefAtRemove) {
          roomRefAtRemove.child("coHostUids/" + uid).set(null).catch(() => {});
        }
      }).catch(() => { /* read denied or user has no account — nothing to clear */ });
    }
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
  // Read the public `judges/{usernameKey}: displayName` index — users tagged
  // "Judge", "Guest Judge" or "Keeper" appear here (all map to this node), so
  // the sub-host typeahead surfaces every account that can be invited to
  // co-host (judges, guest judges, and fee keepers).
  db.ref("judges").once("value").then(snap => {
    const val = snap.val() || {};
    coHostUsernamePool = Object.values(val)
      .filter(v => typeof v === "string" && v.trim())
      .map(v => v.trim())
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

  lines.push("");
  lines.push(SHARE_TOURNAMENT_INVITE);
  lines.push("");
  lines.push(SHARE_TOURNAMENT_INSTRUCTIONS);
  lines.push("");
  lines.push(SHARE_TOURNAMENT_URL);
  return lines.join("\n");
}

// Briefly flash a thumbs-up on the share button to confirm the message
// was copied to the clipboard, then restore the original icon.
function flashShareButton(btn) {
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.innerHTML = `<span class="swiss-share-flash"><img src="assets/icons/thumbs-up.png" alt="Copied"
    onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x2713;')"></span>`;
  setTimeout(() => { btn.innerHTML = orig; }, 1200);
}

// Legacy clipboard path for old browsers / non-secure contexts without the
// async Clipboard API. Returns true on success; on total failure it shows
// a prompt() so the user can still copy manually, and returns false.
function legacyCopyText(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;left:-9999px;top:0;";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    if (ok) return true;
  } catch (e) { /* fall through to prompt */ }
  prompt("Copy this:", text);
  return false;
}

// Copy `text` to the clipboard — async Clipboard API first, legacy path as
// a fallback. Resolves true when the text actually reached the clipboard.
function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text)
      .then(() => true)
      .catch(() => legacyCopyText(text));
  }
  return Promise.resolve(legacyCopyText(text));
}

async function dispatchShareMessage(message, btn) {
  // Prefer the native Web Share API (system share sheet — pick WhatsApp /
  // Discord / Messages / etc. from the OS list). Falls back to clipboard
  // copy when the API isn't available (most desktop browsers). User
  // cancelling the share sheet is a no-op (no clipboard fallback —
  // they explicitly backed out).
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    try {
      await navigator.share({ text: message });
      flashShareButton(btn);
      return;
    } catch (err) {
      if (err && (err.name === "AbortError" || err.code === 20)) return; // user cancelled
      // Any other share failure falls through to clipboard.
    }
  }
  const ok = await copyTextToClipboard(message);
  if (ok) flashShareButton(btn);
}

// Tester QA aid — copy every registrant name (one per line) to the
// clipboard. Briefly relabels the button to confirm.
function copyRegistrantNames(state, btn) {
  const names = listRegistrants(state)
    .map(r => ((r && r.name) || "").trim())
    .filter(Boolean);
  if (!names.length) { alert("No registrants to copy yet."); return; }
  copyTextToClipboard(names.join("\n")).then(ok => {
    if (!ok || !btn) return;
    const orig = btn.textContent;
    btn.textContent = `Copied ${names.length}`;
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
  });
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

  // Auto-advance the focus through Date -> Time -> Stadium -> Rule -> Remark
  // so the host fills the popup without tapping each field.
  const openDropdownMenu = (root) => {
    const ddBtn = root?.querySelector(".setting-dropdown-btn");
    const ddMenu = root?.querySelector(".setting-dropdown-menu");
    if (!ddBtn || !ddMenu) return;
    ddMenu.classList.remove("hidden");
    ddBtn.focus();
  };
  const stadiumCtrl = wireShareDropdown(stadiumDd, STADIUM_OPTIONS, details.stadium, () => {
    openDropdownMenu(ruleDd);
  });
  const ruleCtrl = wireShareDropdown(ruleDd, RULE_OPTIONS, details.rule, () => {
    setTimeout(() => remarkInput?.focus(), 0);
  });
  if (dateInput) dateInput.onchange = () => { if (timeInput) timeInput.focus(); };
  if (timeInput) timeInput.onchange = () => openDropdownMenu(stadiumDd);

  const close = () => {
    popup.classList.add("hidden");
    if (submitBtn) submitBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (dateInput) dateInput.onchange = null;
    if (timeInput) timeInput.onchange = null;
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
function wireShareDropdown(root, options, initial, onPick) {
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
      if (typeof onPick === "function") onPick(opt.dataset.value);
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
// Placeholder silhouette shown when a profile has no photo. The SVG has a
// TRANSPARENT background — the surrounding <img>'s themed CSS `background`
// shows through, so the empty avatar follows the active theme instead of
// rendering as a hard-coded dark slab. The silhouette stays a neutral mid
// grey (#484f58) so it reads on both light and dark theme cards.
const PROFILE_VIEW_PHOTO_PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
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
    } else if (lower === "tester") {
      cls += " account-tag-tester";
    } else if (lower === "guest judge") {
      cls += " account-tag-guest-judge";
    } else if (lower === "keeper") {
      cls += " account-tag-keeper";
    } else if (lower === "judge") {
      cls += " account-tag-judge";
    } else if (lower === "gold player") {
      cls += " account-tag-gold";
    } else if (lower === "silver player") {
      cls += " account-tag-silver";
    } else if (lower === "bronze player") {
      cls += " account-tag-bronze";
    }
    return `<span class="${cls}">${escapeHtml(t)}</span>`;
  }).join("");
}

// ===== Auto medal tags — "Gold/Silver/Bronze Player" =====
// The top 3 of the global tournament ranking carry a medal tag. These are
// NOT stored on the account: they're derived live from the `ranking` node,
// so they always reflect the current standing and shift automatically as
// rankings change — no Firebase writes, no tag-management rules involved.
//
// Cache keyed by lowercased username; kept live by subscribeRankingMedals
// (a `ranking` listener) and also refreshed by renderTournamentRanking.
let rankingMedalCache = { gold: "", silver: "", bronze: "" };

function setRankingMedalCache(sortedList) {
  const keyOf = (r) => (r && r.name) ? subHostKey(r.name) : "";
  rankingMedalCache = {
    gold: keyOf(sortedList[0]),
    silver: keyOf(sortedList[1]),
    bronze: keyOf(sortedList[2])
  };
  // Flags that the ranking has actually been read — so consumers can tell
  // a genuine "no medal" from a not-yet-loaded cache (the medal-theme gate
  // must not revoke a theme before it knows the real standing).
  window.rankingMedalsReady = true;
  // Let tag-rendering surfaces (e.g. the Account page) and the medal-theme
  // gate refresh once the medal cache is known or changes.
  try { window.dispatchEvent(new Event("rankingmedalschange")); } catch (e) {}
}

// The medal tag a username currently holds by ranking position, or "".
function medalTagForName(name) {
  const k = subHostKey(name || "");
  if (!k) return "";
  if (k === rankingMedalCache.gold) return "Gold Player";
  if (k === rankingMedalCache.silver) return "Silver Player";
  if (k === rankingMedalCache.bronze) return "Bronze Player";
  return "";
}
window.medalTagForName = medalTagForName;

// Prepend the current medal tag (if any) to an existing tag-badges HTML
// string for `username` — the medal badge leads, then the account's real
// tags. Used wherever a profile's tags are rendered.
function withMedalTagBadge(tagsHtml, username) {
  const medal = medalTagForName(username);
  if (!medal) return tagsHtml || "";
  return revoxTagBadges({ tags: { [medal]: true } }) + (tagsHtml || "");
}
window.withMedalTagBadge = withMedalTagBadge;

// Subscribe to `ranking` and keep the medal cache live. Because the medal
// tag is computed against this cache (never stored on the account), the
// moment the top 3 changes — a tournament awards points, a player is
// overtaken — the cache updates, rankingmedalschange fires, and anyone who
// drops out of the top 3 loses their Gold/Silver/Bronze Player tag
// everywhere it's shown. New top-3 entrants gain it the same way.
let rankingMedalsSubscribed = false;
function subscribeRankingMedals() {
  if (rankingMedalsSubscribed || !firebaseReady()) return;
  const db = initFirebase();
  if (!db) return;
  rankingMedalsSubscribed = true;
  db.ref("ranking").on("value", snap => {
    const data = snap.val() || {};
    const list = Object.entries(data)
      .map(([key, v]) => ({ name: (v && v.name) || key, points: (v && Number(v.points)) || 0 }))
      .filter(r => r.points > 0 && !isTestRegistrant(r.name))
      .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
    setRankingMedalCache(list);
  }, () => {});
}

// The profile dropdown is dismissed by an outside click or by hovering away;
// these hold the active document listener and the hover grace-period timer.
let profileDropdownOutsideHandler = null;
let profileDropdownHideTimer = null;
// Bumped on every showProfileByUsername call so a slow async profile read
// whose token no longer matches (the user already hovered elsewhere) is
// discarded instead of popping a stale dropdown.
let profileDropdownRequestId = 0;

// True when `name` is (loosely) the signed-in account's own username. Compares
// with ALL non-alphanumerics stripped so "RvX-Ashwolf", "RvX Ashwolf" and
// "rvxashwolf" all match — the ranking entry and the profile username don't
// always agree on punctuation/spacing.
function isOwnUsername(name) {
  const myUname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  if (!name || !myUname) return false;
  const strip = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  return strip(myUname) === strip(name);
}

// Show/label the "Add Friend" button inside the hover profile dropdown for the
// account being viewed. Hidden when not signed in or viewing your own profile.
function refreshProfileViewAddFriendBtn(username, anchorEl) {
  const btn = document.getElementById("profile-view-add-friend");
  if (!btn) return;
  btn.dataset.member = username || "";
  btn.classList.add("hidden");
  btn.disabled = false;
  btn.textContent = "Add Friend";
  if (!username || typeof window.friendStatusWithUsername !== "function") return;
  // Inside the Friends tab these are already your friends / pending — the card
  // is just for viewing, so never show the button there.
  const frTab = document.getElementById("form-friends");
  if (frTab && !frTab.classList.contains("hidden")) return;
  // Never offer to befriend yourself.
  if (isOwnUsername(username)) return;
  window.friendStatusWithUsername(username).then(status => {
    if ((btn.dataset.member || "") !== (username || "")) return; // dropdown moved on
    if (status === null || status === "self") return;            // not signed in / own profile
    if (status === "friends") return;                            // already friends — no button
    btn.classList.remove("hidden");
    if (status === "requested")      { btn.textContent = "Requested";     btn.disabled = true; }
    else if (status === "incoming")  { btn.textContent = "Accept Friend"; }
    else                             { btn.textContent = "Add Friend"; }
    // The card just grew by one button — re-anchor it under the name.
    const panel = document.getElementById("profile-view-popup");
    if (panel && anchorEl) positionProfileDropdown(panel, anchorEl);
  });
}

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
// inside the viewport. Two passes:
//   1. Try below the anchor — if it overflows the bottom, try above.
//   2. If neither fits cleanly (tall card + short viewport on mobile),
//      clamp into the viewport with a small margin so the card stays
//      near the tap target instead of jumping to the top or bottom edge.
function positionProfileDropdown(panel, anchorEl) {
  if (!panel || !anchorEl) return;
  const r = anchorEl.getBoundingClientRect();
  const pw = panel.offsetWidth || 250;
  const ph = panel.offsetHeight || 220;
  const margin = 8;
  let left = r.left;
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - margin - pw;
  if (left < margin) left = margin;
  // Prefer below; flip above if there's room; otherwise clamp into the
  // viewport (last branch handles the small-screen "neither fits" case).
  let top = r.bottom + 6;
  const fitsBelow = top + ph <= window.innerHeight - margin;
  const aboveTop = r.top - ph - 6;
  const fitsAbove = aboveTop >= margin;
  if (!fitsBelow && fitsAbove) {
    top = aboveTop;
  } else if (!fitsBelow && !fitsAbove) {
    // Clamp into viewport — keep at least `margin` from top and bottom.
    top = Math.max(margin, window.innerHeight - margin - ph);
  }
  panel.style.left = left + "px";
  panel.style.top = top + "px";
}

// Resolve a username to its account and show that profile in a read-only
// dropdown (photo, banner, bio, tags) anchored to the clicked name. The
// dropdown is revealed ONLY when a profile actually exists — a username
// with no public profile (free-form Register Others / Test names) opens
// nothing at all.
function showProfileByUsername(username, anchorEl) {
  const panel = document.getElementById("profile-view-popup");
  if (!panel || !username) return;
  const nameEl = document.getElementById("profile-view-name");
  const photoEl = document.getElementById("profile-view-photo");
  const bannerEl = document.getElementById("profile-view-banner");
  const bioEl = document.getElementById("profile-view-bio");
  const tagsEl = document.getElementById("profile-view-tags");
  const wrEl = document.getElementById("profile-view-winrate");
  const statusEl = document.getElementById("profile-view-status");

  // The tag row is a single line with an invisible scrollbar — a normal
  // mouse wheel only scrolls vertically, so translate vertical wheel input
  // into horizontal scroll here. Bound once (guarded by a dataset flag).
  if (tagsEl && !tagsEl.dataset.wheelBound) {
    tagsEl.dataset.wheelBound = "1";
    tagsEl.addEventListener("wheel", (e) => {
      if (!e.deltaY || tagsEl.scrollWidth <= tagsEl.clientWidth) return;
      e.preventDefault();
      tagsEl.scrollLeft += e.deltaY;
    }, { passive: false });
  }

  // Each call gets a token; an async read whose token is stale (the user
  // moved on to another name) is discarded without opening anything.
  const reqId = ++profileDropdownRequestId;

  // Populate the panel fields from a profile-shaped object. The tag row
  // leads with the live medal tag (Gold/Silver/Bronze Player) if this
  // account currently sits in the ranking's top 3.
  const fill = (p) => {
    if (statusEl) statusEl.textContent = "";
    if (nameEl) nameEl.textContent = (p && p.username) || username;
    if (photoEl) {
      photoEl.src = (p && p.photo) || PROFILE_VIEW_PHOTO_PH;
      photoEl.style.objectPosition = (p && p.photoPos) || "50% 50%";
    }
    if (bannerEl) {
      bannerEl.src = (p && p.banner) || PROFILE_VIEW_BANNER_PH;
      bannerEl.style.objectPosition = (p && p.bannerPos) || "50% 50%";
    }
    if (bioEl) bioEl.textContent = (p && p.bio) || "";
    if (tagsEl) tagsEl.innerHTML = withMedalTagBadge(revoxTagBadges(p || {}), username);
    // Win rate starts hidden; the async winRates read below reveals it
    // once data lands. Reset on every open so a previous profile's stats
    // don't flash on screen before the new read resolves.
    if (wrEl) { wrEl.textContent = ""; wrEl.classList.add("hidden"); }
  };

  // Fetch and render the public win-rate counter for this username. Hides
  // the row entirely when there's no record (new players / never scored).
  const loadWinRate = () => {
    if (!wrEl) return;
    const db = initFirebase();
    if (!db) return;
    db.ref("winRates/" + winRateKey(username)).once("value").then(snap => {
      if (reqId !== profileDropdownRequestId) return; // superseded
      const v = snap.val();
      const wins = (v && v.wins) || 0;
      const losses = (v && v.losses) || 0;
      const ties = (v && v.ties) || 0;
      const total = wins + losses + ties;
      if (total === 0) return; // no data → leave hidden
      const pct = Math.round((wins / total) * 100);
      const tieBit = ties > 0 ? ` · ${ties}T` : "";
      wrEl.textContent = `Win rate ${pct}% — ${wins}W / ${losses}L${tieBit}`;
      wrEl.classList.remove("hidden");
    }).catch(() => { /* read failed → leave hidden */ });
  };

  // Reveal the (already-filled) panel and wire its dismiss handlers. Only
  // ever called once we have a real profile — so a missing profile never
  // flashes an empty / "not found" card.
  const reveal = () => {
    panel.classList.remove("is-mobile"); // legacy class from prior modal experiment
    panel.classList.remove("hidden");
    positionProfileDropdown(panel, anchorEl);
    cancelProfileDropdownHide();
    panel.onmouseenter = cancelProfileDropdownHide;
    panel.onmouseleave = scheduleProfileDropdownHide;
    refreshProfileViewAddFriendBtn(username, anchorEl);
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
  };

  // The signed-in user's own card fills straight from the in-memory
  // profile — instant, always exists, no Firebase read needed.
  const myUname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  if (myUname && subHostKey(myUname) === subHostKey(username)) {
    const mine = (window.getCurrentProfile && window.getCurrentProfile()) || null;
    if (mine) {
      // currentProfile.tags is an array; revoxTagBadges wants a {tag:true} map.
      const tagMap = {};
      (mine.tags || []).forEach(t => { if (t) tagMap[t] = true; });
      fill({ username: mine.username, photo: mine.photo, banner: mine.banner, bio: mine.bio, tags: tagMap });
      reveal();
      loadWinRate();
      return;
    }
  }

  const db = initFirebase();
  if (!db) return;
  // Read the public `profiles/{usernameKey}` mirror FIRST — the dropdown
  // opens only if a profile is found. No profile (or a denied/failed
  // read) → nothing pops up.
  db.ref("profiles/" + subHostKey(username)).once("value").then(snap => {
    if (reqId !== profileDropdownRequestId) return; // superseded by a newer hover/click
    const p = snap.val();
    if (!p) return;                                 // no profile → don't open
    fill(p);
    reveal();
    loadWinRate();
  }).catch(() => { /* read failed → don't open the dropdown */ });
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

// Wire any element carrying data-profile-username so click / hover opens
// that account's profile dropdown. Used by the results lists (final
// placement list, tournament ranking) where the name has no competing
// click handler. Mirrors the .swiss-profile-link behaviour above.
function bindTournamentProfileNames(root) {
  if (!root) return;
  root.querySelectorAll("[data-profile-username]").forEach(el => {
    const uname = el.dataset.profileUsername || "";
    if (!uname) return;
    el.addEventListener("click", () => showProfileByUsername(uname, el));
    el.addEventListener("mouseenter", () => showProfileByUsername(uname, el));
    el.addEventListener("mouseleave", () => scheduleProfileDropdownHide());
  });
}

// ===== Calling Monitor =====
// A big-screen "who's up" board for a projector / TV at the venue. Opens in a
// SEPARATE window (the host keeps the control view on their laptop) and shows
// live matches as "NOW CALLING" plus the next unplayed ones as "UP NEXT". The
// parent window owns the data (loadSwiss) and repaints the monitor on every
// renderSwiss, so it stays live without its own Firebase connection. Desktop
// only — the toolbar button is hidden on touch / narrow screens via CSS.
// Optional voice call-outs use the monitor window's built-in Web Speech API
// (speechSynthesis / "Google voice" on Chrome) — enabled by a one-time click
// in the monitor (browsers block audio until a user gesture).
let callingMonitorWin = null;
let announcedLiveIds = new Set(); // match ids already voiced this session
let prevMonitorVoiceOn = false;   // detect the off→on flip to announce current calls

const CALLING_MONITOR_SHELL = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Calling Monitor</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d1117;color:#e6edf3;font-family:system-ui,"Segoe UI",Roboto,sans-serif;min-height:100vh;padding:3vh 4vw}
.mon-head{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid #30363d;padding-bottom:12px;margin-bottom:3vh}
.mon-title{font-size:3.2vw;font-weight:800;letter-spacing:.5px}
.mon-clock{font-size:2.4vw;font-weight:700;color:#8b949e;font-variant-numeric:tabular-nums}
.mon-now h2{font-size:1.8vw;letter-spacing:3px;color:#3fb950;margin-bottom:1.5vh}
.mon-upnext h2{font-size:1.8vw;letter-spacing:3px;color:#8b949e;margin:4vh 0 1.5vh}
.mon-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(38vw,1fr));gap:2vh 2vw}
.mon-card{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:3vh 2vw;text-align:center}
.mon-live{border-color:#3fb950;box-shadow:0 0 0 2px rgba(63,185,80,.25)}
.mon-players{display:flex;align-items:center;justify-content:center;gap:1.5vw;flex-wrap:wrap}
.mon-p{font-size:4vw;font-weight:800;line-height:1.1}
.mon-vs{font-size:2vw;font-weight:700;color:#8b949e}
.mon-ctx{margin-top:1.5vh;font-size:1.6vw;color:#8b949e;font-weight:600}
.mon-next{display:flex;flex-direction:column;gap:1vh}
.mon-next-row{display:flex;justify-content:space-between;align-items:baseline;background:#161b22;border:1px solid #30363d;border-radius:10px;padding:1.4vh 1.6vw}
.mon-next-players{font-size:2.2vw;font-weight:700}
.mon-next-players em{color:#8b949e;font-style:normal;font-weight:600;font-size:1.6vw;margin:0 .6vw}
.mon-next-ctx{font-size:1.5vw;color:#8b949e;font-weight:600}
.mon-empty{font-size:2.4vw;color:#8b949e;padding:3vh 0}
.mon-empty-sm{font-size:1.8vw;padding:1.5vh 0}
.mon-fs{position:fixed;bottom:2vh;right:2vw;z-index:10;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:10px;padding:.8vh 1.2vw;font-size:1.8vw;line-height:1;cursor:pointer;font-family:inherit;opacity:.55}
.mon-fs:hover{opacity:1;background:#30363d}
:fullscreen .mon-fs{opacity:.25}
</style></head><body>
<button id="mon-fs" class="mon-fs" title="Toggle fullscreen (or press F11)" aria-label="Toggle fullscreen">⛶</button>
<div id="mon"></div>
<script>
window.__voiceOn=true;window.__voiceObj=null;
window.__goFullscreen=function(){try{var d=document.documentElement,r=d.requestFullscreen||d.webkitRequestFullscreen;if(r){var p=r.call(d);if(p&&p.catch)p.catch(function(){});}}catch(e){}};
(function(){
  var SS=window.speechSynthesis;
  window.__goFullscreen();   // best-effort: some browsers honor this on a gesture-opened window
  function pickVoice(){
    var vs=[];try{vs=SS?SS.getVoices():[];}catch(e){}
    if(!vs||!vs.length)return null;
    function by(re){return vs.find(function(v){return re.test(v.name);});}
    return by(/female/i)
      ||by(/\b(Samantha|Victoria|Karen|Moira|Tessa|Zira|Susan|Fiona|Serena|Allison|Ava|Joanna|Salli|Kimberly|Aria|Jenny|Sonia|Michelle|Emma)\b/i)
      ||by(/Google US English/i)||by(/Google UK English Female/i)
      ||vs.find(function(v){return /^en/i.test(v.lang)&&!/\b(David|Mark|Guy|George|Daniel|Alex|Fred|Thomas|Ryan|James|Male)\b/i.test(v.name);})
      ||vs.find(function(v){return /^en/i.test(v.lang);})||vs[0]||null;
  }
  window.__speak=function(text){
    try{
      if(!SS||!window.__voiceOn)return;
      if(!window.__voiceObj)window.__voiceObj=pickVoice();
      var u=new SpeechSynthesisUtterance(text);
      u.rate=1.1;u.pitch=1.05;
      if(window.__voiceObj){u.voice=window.__voiceObj;u.lang=window.__voiceObj.lang;}
      SS.speak(u);
    }catch(e){}
  };
  // Silent, gesture-time utterance the opener fires to unlock audio autoplay.
  window.__prime=function(){try{if(!SS)return;var u=new SpeechSynthesisUtterance(" ");u.volume=0;SS.speak(u);}catch(e){}};
  try{if(SS){SS.getVoices();SS.onvoiceschanged=function(){window.__voiceObj=pickVoice();};}}catch(e){}
  window.__voiceObj=pickVoice();
  var fs=document.getElementById("mon-fs");
  if(fs)fs.addEventListener("click",function(){
    try{
      if(document.fullscreenElement||document.webkitFullscreenElement){(document.exitFullscreen||document.webkitExitFullscreen||function(){}).call(document);}
      else{var el=document.documentElement;(el.requestFullscreen||el.webkitRequestFullscreen||function(){}).call(el);}
    }catch(e){}
  });
  setInterval(function(){var c=document.getElementById("mon-clock");if(c)c.textContent=new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});},1000);
})();
</script>
</body></html>`;

function callingMatchLabel(state, m) {
  if (m.bracket) {
    const roundMs = Object.values(state.matches || {}).filter(x => x.bracket && x.round === m.round);
    const nm = (typeof getBracketRoundName === "function") ? getBracketRoundName(roundMs) : "";
    return nm || "Knockout";
  }
  const parts = [];
  if (typeof m.groupIndex === "number") parts.push("Group " + String.fromCharCode(65 + m.groupIndex));
  if (typeof m.round === "number") parts.push("Round " + (m.round + 1));
  return parts.join(" · ");
}

function computeCallingLists(state) {
  const matches = state.matches || {};
  const list = Object.keys(matches).map(id => Object.assign({ id }, matches[id]));
  const playable = m => m && m.a && m.b && !m.bye;
  const unscored = m => m.scoreA == null && m.scoreB == null;
  const live = list.filter(m => playable(m) && unscored(m) && m.startedAt != null)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const upNext = list.filter(m => playable(m) && unscored(m) && m.startedAt == null)
    .sort((a, b) => (a.round || 0) - (b.round || 0) || (a.groupIndex || 0) - (b.groupIndex || 0))
    .slice(0, 8);
  return { live, upNext };
}

function callingMonitorBoardHtml(state) {
  const { live, upNext } = computeCallingLists(state);
  const liveHtml = live.length
    ? live.map(m => `<div class="mon-card mon-live"><div class="mon-players"><span class="mon-p">${escapeHtml(m.a)}</span><span class="mon-vs">VS</span><span class="mon-p">${escapeHtml(m.b)}</span></div><div class="mon-ctx">${escapeHtml(callingMatchLabel(state, m))}</div></div>`).join("")
    : `<div class="mon-empty">No match is live right now.</div>`;
  const nextHtml = upNext.length
    ? upNext.map(m => `<div class="mon-next-row"><span class="mon-next-players">${escapeHtml(m.a)} <em>vs</em> ${escapeHtml(m.b)}</span><span class="mon-next-ctx">${escapeHtml(callingMatchLabel(state, m))}</span></div>`).join("")
    : `<div class="mon-empty mon-empty-sm">Nothing queued.</div>`;
  return `
    <div class="mon-head"><span class="mon-title">${escapeHtml(state.tournamentName || "Tournament")}</span><span class="mon-clock" id="mon-clock"></span></div>
    <section class="mon-now"><h2>NOW CALLING</h2><div class="mon-cards">${liveHtml}</div></section>
    <section class="mon-upnext"><h2>UP NEXT</h2><div class="mon-next">${nextHtml}</div></section>`;
}

// Speak the call-out in the monitor window's own audio context. All the TTS
// (voice selection, rate, pitch) lives in the monitor window's __speak — that's
// where speechSynthesis and its voice list actually load, so picking a female
// voice cross-window is reliable.
function announceCall(state, m) {
  try {
    if (!callingMonitorWin || callingMonitorWin.closed) return;
    if (typeof callingMonitorWin.__speak !== "function") return;
    const label = callingMatchLabel(state, m);
    callingMonitorWin.__speak("Now calling. " + m.a + ". versus. " + m.b + "." + (label ? " " + label + "." : ""));
  } catch (e) { /* TTS unavailable — silent */ }
}

function updateCallingMonitor() {
  if (!callingMonitorWin || callingMonitorWin.closed) {
    callingMonitorWin = null; announcedLiveIds = new Set(); prevMonitorVoiceOn = false; return;
  }
  let state;
  try {
    state = loadSwiss();
    const mon = callingMonitorWin.document && callingMonitorWin.document.getElementById("mon");
    if (mon) mon.innerHTML = callingMonitorBoardHtml(state);
  } catch (e) { callingMonitorWin = null; return; }
  // Voice call-outs: announce each match the moment it goes LIVE (once).
  try {
    const voiceOn = !!callingMonitorWin.__voiceOn;
    // On the off→on flip, forget history so current calls get announced now.
    if (voiceOn && !prevMonitorVoiceOn) announcedLiveIds = new Set();
    prevMonitorVoiceOn = voiceOn;
    const live = computeCallingLists(state).live;
    if (voiceOn) live.forEach(m => { if (!announcedLiveIds.has(m.id)) announceCall(state, m); });
    announcedLiveIds = new Set(live.map(m => m.id));
  } catch (e) { /* non-fatal */ }
}

function openCallingMonitor() {
  if (callingMonitorWin && !callingMonitorWin.closed) {
    try { callingMonitorWin.focus(); } catch (e) {}
    updateCallingMonitor();
    return;
  }
  const w = (window.screen && screen.availWidth) || 1280;
  const h = (window.screen && screen.availHeight) || 720;
  const win = window.open("", "xoCallingMonitor",
    "width=" + w + ",height=" + h + ",left=0,top=0,menubar=no,toolbar=no,location=no");
  if (!win) { alert("Couldn't open the monitor — allow pop-ups for this site, then tap Monitor again."); return; }
  callingMonitorWin = win;
  win.document.open();
  win.document.write(CALLING_MONITOR_SHELL);
  win.document.close();
  try { win.moveTo(0, 0); win.resizeTo(w, h); } catch (e) {}  // fill the screen
  // Unlock audio + try true fullscreen while still inside the toolbar-button
  // click gesture (browsers only allow both from a user gesture). If the
  // browser blocks the auto-fullscreen, the ⛶ button / F11 still work.
  try { if (typeof win.__prime === "function") win.__prime(); } catch (e) {}
  try { if (typeof win.__goFullscreen === "function") win.__goFullscreen(); } catch (e) {}
  updateCallingMonitor();
}

function renderSwiss() {
  const view = document.getElementById("swiss-view");
  const setup = document.getElementById("swiss-setup");
  updateCallingMonitor();  // keep any open monitor in step with every render
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
    ? singleElimPlacementIds(state.matches)
    : ["bracket-f-0", "bracket-3rd-0", "bracket-5th-0", "bracket-7th-0"];
  const allPlacementsDone = bracketActive && placementIds.every(id => isMatchDecided(state.matches[id]));
  const isSwissOnly = state.mode === "swiss-only";
  const tournamentComplete = isTournamentComplete(state);
  // Archive view is always read-only. Otherwise: a local (non-room) tournament
  // is owner-editable, and a room is editable only with edit rights.
  const canEdit = !swissArchiveView && (!inRoom || swissCanEdit);

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
      </div>
      <div class="swiss-toolbar-row swiss-toolbar-actions-row">
        ${showStartKnockoutBtn ? `<button type="button" id="swiss-start-bracket" class="btn">Start Knockout</button>` : ""}
        <div class="swiss-toolbar-actions">
          ${tournamentComplete ? "" : renderSwissShareButton()}
          ${canEdit && !tournamentComplete && state.matches && Object.keys(state.matches).length ? `<button type="button" id="swiss-monitor" class="btn btn-icon-sm swiss-monitor-btn" aria-label="Open calling monitor" title="Open the calling monitor on a second screen / projector"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:15px;height:15px;flex:0 0 auto;"><path d="M20 3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h6l-2 3v1h8v-1l-2-3h6c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 13H4V5h16v11z"/></svg><span class="swiss-toolbar-btn-label">Monitor</span></button>` : ""}
          ${swissIsHost && !tournamentComplete ? renderCoHostsButton() : ""}
          ${canEdit && !tournamentComplete && canAddParticipant(state) ? `<button type="button" id="swiss-edit-participants" class="btn btn-icon-sm btn-icon-plus" aria-label="Add participant" title="Add participant"><span class="swiss-toolbar-btn-plus-icon">+</span><span class="swiss-toolbar-btn-label">Add</span></button>` : ""}
          ${canEdit && !tournamentComplete && canAddParticipant(state) ? `<button type="button" id="swiss-remove-participants" class="btn btn-icon-sm btn-icon-minus" aria-label="Remove participant" title="Remove participant"><span class="swiss-toolbar-btn-plus-icon">&minus;</span><span class="swiss-toolbar-btn-label">Remove</span></button>` : ""}
          ${canEdit && !tournamentComplete && canReshuffleTournament(state) ? `<button type="button" id="swiss-reshuffle" class="btn btn-icon-sm" aria-label="Reshuffle draw" title="Reshuffle the Round 1 draw"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:15px;height:15px;flex:0 0 auto;"><path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.66 6.83-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-2.8-2.71z"/></svg><span class="swiss-toolbar-btn-label">Reshuffle</span></button>` : ""}
          ${canEdit && !tournamentComplete && canReshuffleTournament(state) && state.groups && state.groups.length > 1 ? `<button type="button" id="swiss-move-participant" class="btn btn-icon-sm" aria-label="Move participant" title="Move a player to another group"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="width:15px;height:15px;flex:0 0 auto;"><path d="M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z"/></svg><span class="swiss-toolbar-btn-label">Move</span></button>` : ""}
          ${swissArchiveView
            ? `<button type="button" id="swiss-archive-back" class="btn btn-reset btn-icon-sm" title="Back to Past tournaments">
                <img src="assets/icons/exit-button.png" alt=""
                     onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
                <span class="swiss-toolbar-btn-label">Back</span>
              </button>`
            : `<button type="button" id="swiss-clear" class="btn btn-reset btn-icon-sm" title="${resetTitle}">
                <img src="assets/icons/exit-button.png" alt=""
                     onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
                <span class="swiss-toolbar-btn-label">${inRoomNonHost ? "Leave" : "Reset"}</span>
              </button>`}
        </div>
      </div>
    </div>
    ${groupsHtml}
    ${bracketHtml}
    ${isSwissOnly && groupStageDone ? renderCombinedSwissStandings(state) : ""}
    ${renderMyTournamentRecap(state)}
    ${tournamentComplete ? renderPartUsageCharts(state) : ""}
  `;

  // The instant we render a "complete" state — Swiss, Round Robin, or
  // Single Elimination — push the parts-usage snapshot the Dashboard's
  // Best Parts panel reads from. This decouples the snapshot from the
  // Dashboard being open at the right moment: a host can finish a
  // tournament here, hit Reset, then open Dashboard and still see the
  // just-finished result. Mirrors aggregatePartUsage + the sort/slice
  // the Dashboard does in dashboardBuildTopParts.
  if (tournamentComplete && !swissArchiveView) snapshotBestPartsForDashboard(state);

  // When the host reaches the final results, archive the whole tournament to
  // the public Past list so it stays viewable after a reset. Host-only (the DB
  // rule enforces it); runs once per code per session.
  if (tournamentComplete && !swissArchiveView && swissIsHost && swissEditCode) {
    publishPastTournament(swissEditCode, state);
  }

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
  hydrateTournamentAvatars(view);
  bindTournamentProfileNames(view);
  hydrateTop8Banners(view);
  // Let a vertical mouse wheel scroll the toolbar actions row sideways on
  // desktop (it has no touch-scroll and its scrollbar is hidden).
  if (typeof enableHorizontalWheelScroll === "function") {
    view.querySelectorAll(".swiss-toolbar-actions").forEach(el => enableHorizontalWheelScroll(el));
  }
  view.querySelector("#swiss-start-bracket")?.addEventListener("click", startSwissBracket);
  view.querySelector("#swiss-edit-participants")?.addEventListener("click", showBulkAddParticipantsPopup);
  view.querySelector("#swiss-remove-participants")?.addEventListener("click", showRemoveParticipantsPopup);
  view.querySelector("#swiss-reshuffle")?.addEventListener("click", reshuffleTournament);
  view.querySelector("#swiss-move-participant")?.addEventListener("click", showMoveParticipantsPopup);
  view.querySelector("#swiss-cohosts")?.addEventListener("click", showCoHostsPopup);
  view.querySelector("#swiss-monitor")?.addEventListener("click", openCallingMonitor);
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
  } else if (swissSessionRole === "co-host") {
    // Joined as a co-host but edit access isn't active (not signed in, or the
    // account's username isn't on the host's co-host list, or auth was evicted
    // — see coHostEditBlockReason). Keep the cards tappable so the tap explains
    // WHY nothing happens instead of silently doing nothing.
    view.querySelectorAll(".swiss-match-card-play").forEach(el => {
      const id = el.dataset.match;
      if (!id) return;
      el.setAttribute("title", "Tap for co-host access help");
      el.addEventListener("click", notifyCoHostEditBlocked);
      el.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); notifyCoHostEditBlocked(); }
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
  view.querySelector("#swiss-archive-back")?.addEventListener("click", exitArchiveView);

  // Wire up any part-usage carousels rendered into the view.
  if (typeof setupDashboardCarousel === "function") {
    view.querySelectorAll(".part-usage-carousel").forEach(setupDashboardCarousel);
  }
}

// Small muted line under the Registrants heading: the minimum needed to start
// and (for the host / Keeper) the fee-paid tally. Returns "" when empty.
function swissRegSubmeta(minTotal, paidCount) {
  const parts = [];
  if (minTotal) parts.push(`${minTotal} min`);
  if (typeof paidCount === "number") parts.push(`${paidCount} paid`);
  return parts.length ? `<span class="swiss-reg-submeta">${parts.join(" · ")}</span>` : "";
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
  const capVal = participantCap(state);
  const isFull = capVal != null && registrants.length >= capVal;
  // Fee tracking — the host and any Keeper (joined as co-host) can mark who
  // has paid; everyone in the room sees the "Paid" badge.
  const canMarkPaid = canMarkFeePaid();
  const paidCount = registrants.filter(r => r.paid).length;

  const modeLabel = tournamentFormatLabel(state.mode, state.pairing, false, state.topN);
  // Hosts / co-hosts can tweak the format while still waiting for players —
  // no matches exist yet, so changing groups / rounds / Top-8 is safe.
  const isSwiss = state.mode !== "single-elim";
  // Round robin has no round count to set — its rounds are generated from the
  // group size so every participant plays every other one.
  const isRoundRobin = state.pairing === "round-robin";
  const formatBits = [];
  // The format chip is editable for any format — tapping it opens the
  // Swiss / Round Robin / Single Elimination picker (single-elim included,
  // so the host can switch away from it too).
  if (canEdit) {
    formatBits.push(`<button type="button" class="swiss-reg-format-mode swiss-reg-format-editable" id="swiss-edit-mode" title="Tap to change format">${modeLabel}</button>`);
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
  } else {
    // Single elimination — show (and let the host edit) the placement depth.
    const depthLabel = `Top ${clampPlacementDepth(state.placementDepth)}`;
    if (canEdit) {
      formatBits.push(`<button type="button" class="swiss-reg-format-bit swiss-reg-format-editable" id="swiss-edit-depth" title="Tap to change placement depth">${depthLabel}</button>`);
    } else {
      formatBits.push(`<span class="swiss-reg-format-bit">${depthLabel}</span>`);
    }
  }
  // Participant cap — applies to every format. The host can set a maximum or
  // clear it; others only see the chip once a cap is set.
  if (canEdit) {
    const capLabel = capVal != null ? `Cap ${capVal}` : "No cap";
    formatBits.push(`<button type="button" class="swiss-reg-format-bit swiss-reg-format-editable" id="swiss-edit-cap" title="Tap to set a participant limit">${capLabel}</button>`);
  } else if (capVal != null) {
    formatBits.push(`<span class="swiss-reg-format-bit">Cap ${capVal}</span>`);
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

  // Registrant IDs this device is allowed to self-manage (signed-in
  // createdBy match + localStorage-tracked unauthed guest entries).
  // Used to also let a participant tap THEIR OWN row to re-open the
  // edit popup, not just hosts / co-hosts.
  const myRegIdSet = new Set(
    (typeof findMyRegistrantIds === "function" && swissEditCode)
      ? findMyRegistrantIds(state, swissEditCode)
      : []
  );

  const registrantRows = registrants.length
    ? registrants.map((r, i) => {
        const isMyRow = myRegIdSet.has(r.id);
        const canEditRow = canEdit || isMyRow;
        const removeBtn = canEdit
          ? `<button type="button" class="swiss-reg-remove" data-reg-id="${escapeHtml(r.id)}" title="Remove ${escapeHtml(r.name)}" aria-label="Remove ${escapeHtml(r.name)}">&times;</button>`
          : "";
        // Deck states from the registrant row's POV, in priority order:
        //   1. every slot is empty                  → red    "No deck"
        //   2. deck contains a banned part          → red    "Banned parts"  (host added a ban
        //      after registration — pre-existing entries aren't auto-blocked)
        //   3. some slot is missing a required part → amber  "Incomplete"
        //   4. otherwise                            → green  "Deck ✓"
        // Banned takes precedence over Incomplete / Deck ✓ since a banned
        // part makes the deck unusable regardless of how complete the slots
        // are. The tooltip on each non-green badge names the issue.
        const emptySlots = emptyBeyCheckDeckSlotNumbers(r.deck);
        const incompleteSlots = incompleteBeyCheckDeckSlotNumbers(r.deck);
        const bannedHits = findBannedPartsInDeck(r.deck, getBannedParts(state));
        const deckSlotsTotal = BEY_CHECK_DECK_SIZE;
        let deckBadge;
        if (emptySlots.length === deckSlotsTotal) {
          deckBadge = `<span class="swiss-reg-deck-badge swiss-reg-deck-badge-missing">No deck</span>`;
        } else if (bannedHits.length > 0) {
          const names = bannedHits.map(h => `${h.name} (Slot ${h.slot})`).join(", ");
          deckBadge = `<span class="swiss-reg-deck-badge swiss-reg-deck-badge-banned" title="Banned: ${escapeHtml(names)}">Banned parts</span>`;
        } else if (incompleteSlots.length > 0) {
          deckBadge = `<span class="swiss-reg-deck-badge swiss-reg-deck-badge-partial" title="Slot${incompleteSlots.length === 1 ? "" : "s"} ${incompleteSlots.join(", ")} missing parts">Incomplete</span>`;
        } else {
          deckBadge = `<span class="swiss-reg-deck-badge">Deck ✓</span>`;
        }
        // Hosts and co-hosts can tap any registrant's name to edit it.
        // Participants can tap their OWN row to re-open the edit popup
        // (canEditRow). Everyone else gets the profile dropdown on
        // click / hover (data-profile-username → bindTournamentProfileNames).
        const profileAttr = r.name ? ` data-profile-username="${escapeHtml(r.name)}"` : "";
        const nameEl = canEditRow
          ? `<button type="button" class="swiss-reg-name swiss-reg-name-edit" data-reg-id="${escapeHtml(r.id)}" title="${isMyRow && !canEdit ? "Edit your deck" : "Edit name or deck"}">${escapeHtml(r.name || "(unnamed)")}</button>`
          : `<span class="swiss-reg-name"${profileAttr}>${escapeHtml(r.name || "(unnamed)")}</span>`;
        // Avatar starts on the silhouette placeholder; hydrateRegistrantAvatars
        // (run after render) swaps in the real photo from the public
        // `profiles` index when the registrant name maps to an account.
        const avatarEl = `<img class="swiss-reg-avatar" src="${PROFILE_VIEW_PHOTO_PH}" alt="" data-reg-name="${escapeHtml(r.name || "")}">`;
        // Fee status — a clickable toggle for the host / Keeper, a read-only
        // badge (only when paid) for everyone else.
        let paidEl = "";
        if (canMarkPaid) {
          paidEl = `<button type="button" class="swiss-reg-paid${r.paid ? " is-paid" : ""}" data-reg-id="${escapeHtml(r.id)}" data-paid="${r.paid ? "1" : "0"}" title="${r.paid ? "Fee paid — tap to mark unpaid" : "Tap to mark fee paid"}">${r.paid ? "Paid ✓" : "Unpaid"}</button>`;
        } else if (r.paid) {
          paidEl = `<span class="swiss-reg-paid is-paid" title="Fee paid">Paid ✓</span>`;
        }
        // data-rank-name drives the banner background (hydrateRegistrantBanners).
        const rowNameAttr = r.name ? ` data-rank-name="${escapeHtml(r.name)}"` : "";
        return `<li class="swiss-reg-row"${rowNameAttr}>
          <span class="swiss-reg-num">${i + 1}</span>
          ${avatarEl}
          <div class="swiss-reg-body">
            ${nameEl}
            <span class="swiss-reg-badges">${deckBadge}${paidEl}</span>
          </div>
          ${removeBtn}
        </li>`;
      }).join("")
    : `<li class="swiss-reg-empty">No one has registered yet. Players can find this tournament under Open Tournaments and sign up there.</li>`;

  const selfRegBtnHtml = canRegisterSelf
    ? `<button type="button" id="swiss-reg-self" class="swiss-reg-self"${isFull ? ' disabled title="Tournament is full"' : ""}>+ Register Myself</button>`
    : "";
  // "Register Others" adds a deck-optional guest player. Open to hosts /
  // co-hosts and to registered participants — a participant signing up
  // friends on their device uses the same selfRegister write path (no
  // disconnect, so they keep their participant session).
  // Bulk Guests — the single "add others as guests" entry point. Pastes a
  // name list (one per line) and creates every entry as a deck-less guest
  // in a single Firebase update. Open to hosts / co-hosts and registered
  // participants; viewers can't see it. Handles single-add too — just type
  // one line.
  const canRegisterOthers = canEdit || swissSessionRole === "participant";
  const bulkGuestsBtnHtml = canRegisterOthers
    ? `<button type="button" id="swiss-reg-bulk-guests" class="swiss-reg-self"${isFull ? ' disabled title="Tournament is full"' : ""}>+ Bulk Guests</button>`
    : "";
  // Banned Parts management — host-only. Co-hosts can't edit because the
  // bannedParts field isn't listed in the per-child rule set, so writes
  // fall to the parent rule (host only). The "Banned Parts" panel below
  // shows everyone (host / co-host / participants / viewers) what's banned.
  const banPartsBtnHtml = swissIsHost
    ? `<button type="button" id="swiss-reg-banned" class="swiss-reg-self">Banned Parts</button>`
    : "";
  // Banned-list display — only renders when there's at least one ban.
  // Visible to every audience so participants see what they can't use.
  const bannedPartsPanelHtml = (() => {
    const banned = getBannedParts(state);
    const sections = BANNABLE_FIELDS
      .filter(f => banned[f].length > 0)
      .map(f => {
        const chips = banned[f]
          .map(n => `<span class="swiss-banned-chip">${escapeHtml(n)}</span>`)
          .join("");
        return `<div class="swiss-banned-section"><span class="swiss-banned-label">${BANNABLE_FIELD_LABEL[f]}:</span> ${chips}</div>`;
      });
    if (!sections.length) return "";
    return `<div class="swiss-banned-panel" role="region" aria-label="Banned parts">
      <div class="swiss-banned-heading">Banned Parts</div>
      ${sections.join("")}
    </div>`;
  })();
  // The Test button bulk-adds synthetic participants — gate it on the
  // "Tester" tag so regular hosts don't see (or accidentally use) it.
  const isTesterAcct = typeof window.isTester === "function" && window.isTester();
  const testRegBtnHtml = (canEdit && isTesterAcct)
    ? `<button type="button" id="swiss-reg-test" class="swiss-reg-self swiss-reg-test">Test</button>`
    : "";
  // Bulk-copy every registrant name to the clipboard (QA aid) — Tester-only.
  const copyNamesBtnHtml = (canEdit && isTesterAcct && registrants.length)
    ? `<button type="button" id="swiss-reg-copy-names" class="swiss-reg-self swiss-reg-test">Copy Names</button>`
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
            <img src="assets/icons/exit-button.png" alt=""
                 onerror="this.style.display='none';this.parentNode.insertAdjacentHTML('beforeend','&#x21BA;');">
            <span class="swiss-toolbar-btn-label">${isHost ? "Reset" : "Leave"}</span>
          </button>
        </div>
      </div>
      <div class="swiss-toolbar-row swiss-toolbar-info-row">
        <div class="swiss-toolbar-idgroup">
          <div class="swiss-toolbar-pills">
            <span class="swiss-reg-pill">Registration open</span>
            ${state.visibility === "closed" ? `<span class="swiss-reg-pill swiss-reg-pill-closed" title="Private — not listed in the lobby; players join with the code">Closed</span>` : ""}
            ${(state.visibility === "closed" && canEdit && (swissViewCode || state.viewCode))
              ? `<button type="button" class="swiss-reg-joincode" id="swiss-share-joincode" data-code="${escapeHtml(swissViewCode || state.viewCode)}" title="Tap to copy — share this code so players can join">Join code: <strong>${escapeHtml(swissViewCode || state.viewCode)}</strong></button>`
              : ""}
          </div>
          ${renderSwissRoomBadge()}
        </div>
      </div>
    </div>
    <section class="swiss-registering">
      <div class="swiss-reg-format">${formatBits.join("")}</div>
      <div class="swiss-reg-heading-row">
        <h3 class="swiss-reg-heading">Registrants <span class="swiss-reg-count">${capVal != null ? `${registrants.length} / ${capVal}` : registrants.length}</span>${isFull ? `<span class="swiss-reg-full-pill">Full</span>` : ""}</h3>
        ${swissRegSubmeta(minTotal, canMarkPaid ? paidCount : null)}
      </div>
      ${bannedPartsPanelHtml}
      ${(selfRegBtnHtml || bulkGuestsBtnHtml || banPartsBtnHtml || testRegBtnHtml || copyNamesBtnHtml)
        ? `<div class="swiss-reg-host-actions">${selfRegBtnHtml}${bulkGuestsBtnHtml}${banPartsBtnHtml}${testRegBtnHtml}${copyNamesBtnHtml}</div>`
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
  view.querySelector("#swiss-edit-mode")?.addEventListener("click", showSwissFormatPopup);
  view.querySelector("#swiss-edit-groups")?.addEventListener("click", () => {
    showSwissGroupsPopup((gc) => updateRegisteringSetting({ groupCount: gc }), state.pairing === "round-robin");
  });
  view.querySelector("#swiss-edit-rounds")?.addEventListener("click", () => {
    showSwissRoundsPopup((rc) => updateRegisteringSetting({ roundCount: rc }));
  });
  view.querySelector("#swiss-edit-depth")?.addEventListener("click", () => {
    showSingleElimDepthPopup((depth) => {
      if (depth == null) return;
      updateRegisteringSetting({ placementDepth: clampPlacementDepth(depth) });
    }, state.placementDepth);
  });
  view.querySelector("#swiss-edit-cap")?.addEventListener("click", () => {
    // Floor: can't cap below the minimum to run, nor below who's registered.
    const floor = Math.max(swissRegistrationMinimum(state), listRegistrants(state).length);
    showParticipantCapPopup((n) => {
      if (n == null) return; // cancelled
      updateRegisteringSetting({ maxParticipants: n > 0 ? n : null });
    }, participantCap(state), floor);
  });
  view.querySelector("#swiss-reg-start")?.addEventListener("click", startRegisteringTournament);
  view.querySelector("#swiss-reg-self")?.addEventListener("click", showSelfRegisterPopup);
  view.querySelector("#swiss-reg-bulk-guests")?.addEventListener("click", showBulkGuestsPopup);
  view.querySelector("#swiss-reg-banned")?.addEventListener("click", showBannedPartsPopup);
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
  view.querySelector("#swiss-reg-copy-names")?.addEventListener("click", (e) => {
    copyRegistrantNames(state, e.currentTarget);
  });
  bindSwissShareButton(view);
  // Copy the join code (Closed tournaments) to the clipboard.
  view.querySelector("#swiss-share-joincode")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    const code = btn.dataset.code || "";
    if (!code) return;
    const flash = () => {
      const strong = btn.querySelector("strong");
      const prev = strong ? strong.textContent : "";
      if (strong) strong.textContent = "Copied!";
      setTimeout(() => { if (strong) strong.textContent = prev; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(flash).catch(flash);
    } else {
      flash();
    }
  });
  // Fee-paid toggle (host / Keeper only — read-only badges aren't buttons).
  view.querySelectorAll("button.swiss-reg-paid[data-reg-id]").forEach(btn => {
    btn.addEventListener("click", () => {
      setRegistrantPaid(btn.dataset.regId, btn.dataset.paid !== "1");
    });
  });
  view.querySelectorAll(".swiss-reg-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.regId;
      if (!id) return;
      // Confirm before removing — the auto-kick flow also disconnects
      // the player's own device, so an accidental tap on × can boot
      // someone out of the room with no undo.
      const reg = (loadSwiss().registrants || {})[id];
      const name = (reg && reg.name) || "this registrant";
      if (!confirm(`Are you sure you want to remove ${name}?`)) return;
      removeRegistrant(id);
    });
  });
  view.querySelectorAll(".swiss-reg-name-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.regId;
      if (id) showEditRegistrantPopup(id);
    });
  });
  hydrateTournamentAvatars(view);
  hydrateRegistrantBanners(view);
  // Viewer / participant registrant names open the profile dropdown
  // (host / co-host names are edit buttons instead, so they carry no
  // data-profile-username and are skipped here).
  bindTournamentProfileNames(view);
}

// Per-session cache of resolved profile photos, keyed by username key.
// Value is the photo data-URL, or "" when the name has no public profile
// (free-form Register Others / Test names, or accounts that haven't saved
// a profile yet) — caching the empty result avoids re-querying every render.
const swissRegistrantPhotoCache = Object.create(null);

// Resolve a player name to a profile photo data-URL (""=no photo / no
// account). The signed-in user's own photo comes straight from the
// in-memory profile (instant, no Firebase read, works before the public
// mirror is populated); everyone else's from the public
// `profiles/{usernameKey}` index, cached per session. Exposed on window
// so the scoreboard overlay (a separate file) can reuse it.
function resolveProfilePhoto(name) {
  const key = subHostKey(name || "");
  if (!key) return Promise.resolve("");
  const myKey = subHostKey((window.getCurrentUsername && window.getCurrentUsername()) || "");
  if (myKey && key === myKey) {
    return Promise.resolve((window.getCurrentUserPhoto && window.getCurrentUserPhoto()) || "");
  }
  if (key in swissRegistrantPhotoCache) return Promise.resolve(swissRegistrantPhotoCache[key]);
  const db = initFirebase();
  if (!db) return Promise.resolve("");
  return db.ref("profiles/" + key + "/photo").once("value").then(snap => {
    const photo = (typeof snap.val() === "string") ? snap.val() : "";
    swissRegistrantPhotoCache[key] = photo;
    return photo;
  }).catch(() => { swissRegistrantPhotoCache[key] = ""; return ""; });
}
window.resolveProfilePhoto = resolveProfilePhoto;

// Per-session cache of resolved profile-banner data-URLs, keyed by
// username key. Same shape / fallback rules as swissRegistrantPhotoCache.
const swissRegistrantBannerCache = Object.create(null);

// Resolve a player name to their profile banner data-URL (""=none), used
// as the tournament-ranking row background. Mirrors resolveProfilePhoto:
// own profile from memory, others from the public
// `profiles/{usernameKey}/banner`.
function resolveProfileBanner(name) {
  const key = subHostKey(name || "");
  if (!key) return Promise.resolve("");
  const myKey = subHostKey((window.getCurrentUsername && window.getCurrentUsername()) || "");
  if (myKey && key === myKey) {
    const mine = (window.getCurrentProfile && window.getCurrentProfile()) || null;
    return Promise.resolve((mine && mine.banner) || "");
  }
  if (key in swissRegistrantBannerCache) return Promise.resolve(swissRegistrantBannerCache[key]);
  const db = initFirebase();
  if (!db) return Promise.resolve("");
  return db.ref("profiles/" + key + "/banner").once("value").then(snap => {
    const v = (typeof snap.val() === "string") ? snap.val() : "";
    swissRegistrantBannerCache[key] = v;
    return v;
  }).catch(() => { swissRegistrantBannerCache[key] = ""; return ""; });
}

// When the signed-in user updates their own profile (saveUserProfile
// dispatches `userprofilechange`), invalidate THEIR cached photo /
// banner so the next render reads the fresh data, then re-render any
// visible list that paints those — Revox ranking and tournament ranking
// are the two surfaces. Rows for the user's own name are served from
// the in-memory currentProfile (not the cache), so the cache delete is
// mostly a belt-and-braces for any stale entry from earlier in the
// session — the real fix is the re-render.
window.addEventListener("userprofilechange", () => {
  const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  const k = subHostKey(uname);
  if (k) {
    delete swissRegistrantPhotoCache[k];
    delete swissRegistrantBannerCache[k];
  }
  if (document.getElementById("revox-ranking-list") && typeof renderRevoxRanking === "function") {
    renderRevoxRanking();
  }
  if (typeof renderTournamentRanking === "function") {
    // Only re-render if the ranking panel is the active tournament sub-tab,
    // otherwise we trigger a fetch the user can't see.
    const active = document.querySelector('.tournament-sub-tab.active');
    if (active && active.dataset.tournamentView === "ranking") renderTournamentRanking();
  }
});

// Gradient scrims layered over a profile-banner row background. The top-3
// places get a gold / silver / bronze-tinted scrim so the podium identity
// reads through the banner; everyone else gets a neutral dark scrim. Both
// keep the row text legible (paired with the .has-rank-banner white-text
// CSS rules).
const BANNER_PLACE_SCRIM = {
  1: "linear-gradient(rgba(227, 179, 65, 0.40), rgba(22, 16, 4, 0.72))",
  2: "linear-gradient(rgba(177, 186, 196, 0.40), rgba(15, 17, 20, 0.72))",
  3: "linear-gradient(rgba(198, 128, 68, 0.40), rgba(22, 15, 8, 0.72))"
};
const BANNER_NEUTRAL_SCRIM = "linear-gradient(rgba(13, 17, 23, 0.55), rgba(13, 17, 23, 0.55))";

// Paint `rowEl` with `name`'s profile banner as a full background, scrimmed
// by `place` (1/2/3 → medal tint, anything else → neutral). Adds the
// .has-rank-banner class so the white-text legibility rules kick in.
// No-op when the player has no banner.
// ---- Match-start notifications ----
// Diff the previous room state against the incoming remote — every match
// that just transitioned to "started" (startedAt was null / missing, now
// is set) gets a toast on this device. Skip the device that itself
// started the match (swissLiveMatchId === id), bye matches, and matches
// without both players assigned. If we recognize the signed-in user's
// name as one of the players, the toast carries an extra "You're up!"
// emphasis line.
function detectAndAnnounceMatchStarts(prevState, remote) {
  if (!remote || !remote.matches) return;
  const prevMatches = (prevState && prevState.matches) || {};
  // "My names" — every name on this device that should be treated as "me".
  //   - signed-in username (if any)
  //   - any registrant entries this device created locally (covers the
  //     unauthed Become Guest path where the user's name isn't stored as
  //     a username anywhere)
  const myNames = new Set();
  const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  if (uname) myNames.add(uname);
  if (swissEditCode && typeof loadDeviceOwnedRegIds === "function") {
    const ownedIds = loadDeviceOwnedRegIds(swissEditCode);
    const regs = (remote && remote.registrants) || {};
    ownedIds.forEach(id => {
      const r = regs[id];
      if (r && typeof r.name === "string" && r.name) myNames.add(r.name);
    });
  }
  // Every connected device in the room gets notified — host, co-host,
  // participant, viewer. The isMine flag below is still computed so the
  // toast can carry the "You're up!" highlight when the signed-in user
  // is one of the players.
  Object.entries(remote.matches).forEach(([id, m]) => {
    if (!m || !m.startedAt) return;
    if (m.bye) return;
    if (!m.a || !m.b) return;
    const before = prevMatches[id];
    const wasStarted = !!(before && before.startedAt);
    if (wasStarted) return; // already started — not a fresh transition
    if (swissLiveMatchId === id) return; // THIS device started it
    const isMine = myNames.has(m.a) || myNames.has(m.b);
    showMatchStartToast({ a: m.a, b: m.b, where: matchWhereLabel(m), isMine });
  });
}

// Best-effort label for where a match sits: "Round X · Group N" /
// "Quarterfinal" / "Final" etc. Shared by the match-start and match-result
// announcers.
function matchWhereLabel(m) {
  if (!m) return "";
  if (typeof m.groupIndex === "number") {
    const letter = String.fromCharCode(65 + m.groupIndex); // 0→A
    const round = (typeof m.round === "number") ? (m.round + 1) : null;
    return round != null ? `Round ${round} · Group ${letter}` : `Group ${letter}`;
  }
  if (m.bracket) {
    const labels = { qf: "Quarterfinal", sf: "Semifinal", cqf: "Consolation QF", f: "Final", "3rd": "3rd Place", "5th": "5th Place", "7th": "7th Place" };
    return labels[m.round] || (typeof m.round === "number" ? `Round ${m.round + 1}` : "Bracket");
  }
  return "";
}

// Persistent "Your Matches" panel for a signed-in participant: their own deck
// plus a win/lose record where each row names the OPPONENT's deck (the deck
// they won/lost to). Only rendered when the player themselves registered a deck
// (no deck → no panel, matching the per-match toast rule). Stays in the
// tournament view through to the end of the tournament.
function renderMyTournamentRecap(state, ownerCode) {
  if (!state || !state.matches) return "";

  // My names (signed-in username + any device-owned registrant names). The
  // device-reg lookup uses the live room code, or the passed code when this is
  // a past tournament opened from History.
  const myNamesList = [];
  const myNamesLower = new Set();
  const addMy = (n) => {
    const name = (n || "").trim();
    if (!name) return;
    const lc = name.toLowerCase();
    if (!myNamesLower.has(lc)) { myNamesLower.add(lc); myNamesList.push(name); }
  };
  addMy((window.getCurrentUsername && window.getCurrentUsername()) || "");
  const regCode = ownerCode || swissEditCode;
  if (regCode && typeof loadDeviceOwnedRegIds === "function") {
    const ownedIds = loadDeviceOwnedRegIds(regCode);
    const regs = state.registrants || {};
    ownedIds.forEach(id => { const r = regs[id]; if (r) addMy(r.name); });
  }
  if (!myNamesList.length) return "";

  // The player must have registered a deck themselves — otherwise no panel.
  let myDeck = null, myDisplayName = "";
  for (const name of myNamesList) {
    const d = getRegisteredDeckForParticipant(state, name);
    if (d) { myDeck = d; myDisplayName = name; break; }
  }
  if (!myDeck) return "";

  const isMe = (n) => n && myNamesLower.has(String(n).trim().toLowerCase());

  // My decided matches, ordered chronologically (group rounds first, then the
  // knockout bracket — QF → SF → … → Final last).
  const results = [];
  Object.entries(state.matches).forEach(([id, m]) => {
    if (!m || m.bye || !m.a || !m.b) return;
    if (m.scoreA == null || m.scoreB == null || m.scoreA === m.scoreB) return;
    const iAmA = isMe(m.a), iAmB = isMe(m.b);
    if (!iAmA && !iAmB) return;
    const myScore = iAmA ? m.scoreA : m.scoreB;
    const oppScore = iAmA ? m.scoreB : m.scoreA;
    results.push({
      id,
      sortKey: recapMatchOrder(m),
      oppName: iAmA ? m.b : m.a,
      won: myScore > oppScore,
      myScore, oppScore,
      where: matchWhereLabel(m)
    });
  });
  results.sort((a, b) => a.sortKey - b.sortKey);

  const wins = results.filter(r => r.won).length;
  const losses = results.length - wins;

  // Each match's opponent deck is collapsible (tap the result to expand). The
  // set of expanded match ids persists, so the live view's frequent re-renders
  // keep your open/closed choices. Decks start collapsed to keep the list short.
  let openSet;
  try { openSet = new Set(JSON.parse(localStorage.getItem("myRecapOpenMatches") || "[]")); }
  catch (e) { openSet = new Set(); }

  const rows = results.map(r => {
    const oppDeck = getRegisteredDeckForParticipant(state, r.oppName);
    const open = openSet.has(r.id);
    return `
      <div class="my-recap-row ${r.won ? "my-recap-win" : "my-recap-loss"}${open ? " my-recap-row-open" : ""}">
        <div class="my-recap-line" role="button" tabindex="0" data-recap-match="${escapeHtml(r.id)}" aria-expanded="${open ? "true" : "false"}">
          <span class="my-recap-result">${r.won ? "Won" : "Lost"}</span>
          <span class="my-recap-vs">${r.won ? "vs" : "to"} ${escapeHtml(r.oppName)}</span>
          <span class="my-recap-score">${r.myScore}–${r.oppScore}</span>
          ${r.where ? `<span class="my-recap-where">${escapeHtml(r.where)}</span>` : ""}
          <span class="my-recap-chevron">${open ? "−" : "+"}</span>
        </div>
        <div class="my-recap-deck my-recap-row-deck">
          <span class="my-recap-deck-label">${escapeHtml(r.oppName)}'s deck${oppDeck ? "" : " — none registered"}</span>
          ${oppDeck ? renderDeckCombos(oppDeck) : ""}
        </div>
      </div>`;
  }).join("");

  return `
    <fieldset class="my-recap">
      <legend>Your Matches</legend>
      <div class="my-recap-deck my-recap-mydeck">
        <span class="my-recap-deck-label">Your deck</span>
        ${renderDeckCombos(myDeck)}
      </div>
      ${results.length ? `<div class="my-recap-record"><span class="my-recap-w">${wins}W</span> – <span class="my-recap-l">${losses}L</span></div>` : ""}
      ${rows || `<p class="my-recap-empty">No results yet — your matches will appear here as they finish.</p>`}
    </fieldset>`;
}

// Expand/collapse a single match's opponent-deck in the recap (tap the result
// line). Persists the open set so the live view's re-renders keep your choices.
// Works in both the live tournament view and the History results popup.
document.addEventListener("click", (e) => {
  const line = e.target.closest && e.target.closest(".my-recap-line[data-recap-match]");
  if (!line) return;
  const id = line.getAttribute("data-recap-match");
  const row = line.closest(".my-recap-row");
  if (!row) return;
  const open = row.classList.toggle("my-recap-row-open");
  line.setAttribute("aria-expanded", open ? "true" : "false");
  const chev = line.querySelector(".my-recap-chevron");
  if (chev) chev.textContent = open ? "−" : "+";
  try {
    const set = new Set(JSON.parse(localStorage.getItem("myRecapOpenMatches") || "[]"));
    if (open) set.add(id); else set.delete(id);
    localStorage.setItem("myRecapOpenMatches", JSON.stringify([...set]));
  } catch (e2) { /* non-fatal */ }
});

// Full combo name for one deck slot — every part joined with " · "
// (e.g. "Meteor Dragoon · 3-60 · Low Flat").
function comboFullName(slot) {
  const mode = (slot && BEY_CHECK_MODES.includes(slot.mode)) ? slot.mode : "standard";
  const parts = (slot && slot.parts) || {};
  return (BEY_CHECK_FIELDS[mode] || [])
    .map(f => parts[f])
    .filter(v => v && v !== NO_RATCHET)
    .join(" · ");
}

// One small thumbnail for a slot — the lead blade (or lock chip) image.
function comboLeadImg(slot) {
  const parts = (slot && slot.parts) || {};
  for (const f of ["blade", "mainBlade", "metalBlade", "lockChip"]) {
    if (parts[f]) {
      const src = beyCheckPartImg(f, parts[f]);
      if (src) return src;
    }
  }
  return null;
}

// Render a registered deck compactly: one line per combo — a small thumbnail
// plus the full combo name.
function renderDeckCombos(deck) {
  if (!Array.isArray(deck)) return "";
  const combos = deck
    .map((slot) => {
      if (isBeyCheckSlotEmpty(slot)) return "";
      const src = comboLeadImg(slot);
      const img = src
        ? `<img src="${src}" class="my-recap-combo-img" alt="" onerror="this.style.visibility='hidden'">`
        : `<span class="my-recap-combo-img"></span>`;
      return `<div class="my-recap-combo">
        ${img}
        <span class="my-recap-combo-name">${escapeHtml(comboFullName(slot))}</span>
      </div>`;
    })
    .filter(Boolean)
    .join("");
  return `<div class="my-recap-combos">${combos}</div>`;
}

// Chronological sort weight for the recap: group/swiss rounds first (by round
// number), then the knockout bracket (QF → consolation → SF → placements →
// Final). Lower sorts earlier; the Final ends up last.
function recapMatchOrder(m) {
  if (!m) return 9999;
  if (typeof m.groupIndex === "number") {
    return typeof m.round === "number" ? m.round : 0; // Round 1, 2, 3 …
  }
  if (m.bracket) {
    const order = { qf: 0, cqf: 1, sf: 2, "7th": 3, "5th": 4, "3rd": 5, f: 6 };
    const base = 1000;
    if (typeof m.round === "number") return base + m.round;     // Swiss top-N numeric rounds
    return base + (order[m.round] != null ? order[m.round] : 99);
  }
  return 500; // unknown — between group rounds and bracket
}

// Short, readable summary of a registered deck for a result toast — the lead
// part of each of the 3 combos (blade / main blade / metal blade / lock chip).
function deckSummaryText(deck) {
  if (!Array.isArray(deck)) return "";
  const names = [];
  deck.forEach(slot => {
    const p = (slot && slot.parts) || {};
    const lead = p.blade || p.mainBlade || p.metalBlade || p.lockChip || "";
    if (lead) names.push(lead);
  });
  return names.join(" · ");
}

// When a match the signed-in player (or a device-owned registrant) is in
// transitions to a decided score, pop a win/lose toast naming the deck they
// played. Players who fought WITHOUT a registered deck (guests / empty deck)
// get nothing — they have no deck to report.
function detectAndAnnounceMyMatchResults(prevState, remote) {
  if (!remote || !remote.matches) return;
  const prevMatches = (prevState && prevState.matches) || {};

  // "My names" — same set the match-start announcer uses.
  const myNames = new Set();
  const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  if (uname) myNames.add(uname);
  if (swissEditCode && typeof loadDeviceOwnedRegIds === "function") {
    const ownedIds = loadDeviceOwnedRegIds(swissEditCode);
    const regs = (remote && remote.registrants) || {};
    ownedIds.forEach(id => {
      const r = regs[id];
      if (r && typeof r.name === "string" && r.name) myNames.add(r.name);
    });
  }
  if (!myNames.size) return;

  const isDecided = (mm) => mm && mm.scoreA != null && mm.scoreB != null && mm.scoreA !== mm.scoreB;

  Object.entries(remote.matches).forEach(([id, m]) => {
    if (!m || m.bye || !m.a || !m.b) return;
    if (!isDecided(m)) return;
    const before = prevMatches[id];
    if (!before) return;        // first time we've seen this match (fresh load) — not a live result
    if (isDecided(before)) return; // already decided before this update — already announced

    const iAmA = myNames.has(m.a);
    const iAmB = myNames.has(m.b);
    if (!iAmA && !iAmB) return;  // not my match

    const myName = iAmA ? m.a : m.b;
    // Only announce when the player actually registered a deck.
    const deck = getRegisteredDeckForParticipant(remote, myName);
    if (!deck) return;

    const myScore = iAmA ? m.scoreA : m.scoreB;
    const oppScore = iAmA ? m.scoreB : m.scoreA;
    showMatchResultToast({
      won: myScore > oppScore,
      opp: iAmA ? m.b : m.a,
      myScore, oppScore,
      deck,
      where: matchWhereLabel(m)
    });
  });
}

// ---- Auto-kick when the host removes you ----
// Fires from the room listener after every remote update. If any
// registrant entry this device owned in the previous state is no
// longer present in the incoming state, the host (or co-host)
// removed us — disconnect cleanly and surface a clear notice so the
// player understands why they were dropped. Skips:
//   - hosts / co-hosts (they're managing the room, not registered)
//   - the device that itself ran the removal (it already navigated
//     away or knows what it did)
//   - cases where the room was reset entirely (no registrants left;
//     covered by other paths)
function detectSelfRemovedFromRoom(prevState, remote, editCode) {
  if (!remote || remote.phase !== "registering") return;
  if (swissCanEdit) return; // host / co-host bypass
  if (!editCode) return;
  const myIds = (typeof findMyRegistrantIds === "function")
    ? findMyRegistrantIds(prevState || {}, editCode)
    : [];
  if (!myIds.length) return; // we didn't have an entry — nothing to detect
  const nowRegs = (remote && remote.registrants) || {};
  const stillThere = myIds.some(id => !!nowRegs[id]);
  if (stillThere) return; // at least one entry remains → not a removal
  // All of MY entries are gone — host removed us. Tear down local state
  // and pop a clear notice. Wrap in setTimeout so the listener body
  // finishes (avoids fighting the in-progress remote-apply).
  setTimeout(() => {
    try { clearDeviceOwnedRegIds(editCode); } catch (e) {}
    try { disconnectSwissRoom(); } catch (e) {}
    try {
      localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
    } catch (e) {}
    try { if (typeof renderSwiss === "function") renderSwiss(); } catch (e) {}
    alert("You were removed from the tournament by the host.");
  }, 0);
}

// Single shared container holding every toast — created lazily on first
// toast. Toasts auto-dismiss after 8s; clicking dismisses immediately.
function ensureToastContainer() {
  let host = document.getElementById("match-toasts");
  if (host) return host;
  host = document.createElement("div");
  host.id = "match-toasts";
  host.className = "match-toasts";
  document.body.appendChild(host);
  return host;
}

// Browser-level Notification API support — works when the tab is open
// but the phone is locked or the browser is backgrounded, without
// needing a service worker. Requires the user to grant permission via a
// real click (handled by the "Turn on alerts" button in the first toast
// where permission is still "default"). iOS Safari only honors this
// when the site is installed as a PWA on the home screen — the request
// silently no-ops on regular iOS Safari, which is fine.
function notifApiAvailable() {
  return typeof window !== "undefined" && typeof window.Notification === "function";
}

function notifPermissionState() {
  return notifApiAvailable() ? Notification.permission : "unsupported";
}

function maybeFireSystemNotification(title, body) {
  if (!notifApiAvailable()) return;
  if (Notification.permission !== "granted") return;
  // Per-device mute toggle set in Settings → Match Alerts. Lets the user
  // keep browser permission granted but silence the OS notifications on
  // this device specifically. In-app toasts still fire either way.
  try { if (localStorage.getItem("matchAlertsOff") === "1") return; } catch (e) {}

  const opts = {
    body,
    tag: "match-start",
    icon: "/assets/icons/M.webp",
    badge: "/assets/icons/M.webp"
  };

  // Mobile Chromium (Android Chrome / Edge / Brave) rejects the
  // `new Notification(...)` constructor and only honors notifications
  // dispatched through a service-worker registration. Desktop browsers
  // accept both, but going through the SW path is the universal answer.
  // Fall back to the constructor only if the SW isn't ready (e.g. very
  // first visit before registration completes).
  if ("serviceWorker" in navigator && navigator.serviceWorker.ready) {
    navigator.serviceWorker.ready.then(reg => {
      return reg.showNotification(title, opts);
    }).catch(err => {
      console.info("SW notification failed, falling back:", err && err.message);
      tryConstructorNotification(title, opts);
    });
  } else {
    tryConstructorNotification(title, opts);
  }
}

function tryConstructorNotification(title, opts) {
  try {
    const n = new Notification(title, opts);
    n.onclick = () => { try { window.focus(); n.close(); } catch (e) {} };
  } catch (e) {
    console.info("Constructor notification failed:", e && e.message);
  }
}

function showMatchStartToast({ a, b, where, isMine }) {
  const host = ensureToastContainer();
  const card = document.createElement("div");
  card.className = "match-toast" + (isMine ? " match-toast-mine" : "");
  const perm = notifPermissionState();
  const showEnable = perm === "default"; // unsupported / granted / denied → hide
  card.innerHTML = `
    <div class="match-toast-head">
      ${isMine ? `<span class="match-toast-tag">You're up!</span>` : `<span class="match-toast-tag-neutral">Match started</span>`}
      <button type="button" class="match-toast-close" aria-label="Dismiss">&times;</button>
    </div>
    <div class="match-toast-players">${escapeHtml(a)} <span class="match-toast-vs">vs</span> ${escapeHtml(b)}</div>
    ${where ? `<div class="match-toast-where">${escapeHtml(where)}</div>` : ""}
    ${showEnable ? `<button type="button" class="match-toast-enable">Turn on alerts</button>` : ""}
  `;
  host.appendChild(card);
  const dismiss = () => {
    if (!card.parentNode) return;
    card.classList.add("match-toast-leaving");
    setTimeout(() => card.remove(), 220);
  };
  card.querySelector(".match-toast-close").addEventListener("click", dismiss);
  // "Turn on alerts" — request Notification permission. Stop the click
  // from bubbling so it doesn't also dismiss the toast.
  const enableBtn = card.querySelector(".match-toast-enable");
  if (enableBtn) {
    enableBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!notifApiAvailable()) return;
      try {
        const result = Notification.requestPermission();
        // Some browsers return a Promise; others use callback. Handle both.
        const handle = (perm) => {
          if (perm === "granted") {
            enableBtn.remove();
            // Fire a confirmation notification so the user sees it works.
            maybeFireSystemNotification("Match alerts on", "You'll get a system notification when matches start.");
          }
        };
        if (result && typeof result.then === "function") result.then(handle);
        else if (typeof result === "string") handle(result);
      } catch (err) {
        console.warn("Notification permission request failed:", err);
      }
    });
  }
  // Tapping the card body (not buttons) also dismisses.
  card.addEventListener("click", (e) => {
    if (e.target.closest(".match-toast-close")) return;
    if (e.target.closest(".match-toast-enable")) return;
    dismiss();
  });
  setTimeout(dismiss, 8000);
  // ALSO fire a real OS notification — kicks in when the tab is backgrounded
  // or the phone screen is off. Always fires when permission is granted; the
  // in-app toast is the foreground complement.
  const title = isMine ? "You're up!" : "Match started";
  const body = `${a} vs ${b}${where ? ` · ${where}` : ""}`;
  maybeFireSystemNotification(title, body);
}

// Win/lose toast for the player whose match just finished, naming the deck
// they played. Mirrors showMatchStartToast's lifecycle + OS notification.
function showMatchResultToast({ won, opp, myScore, oppScore, deck, where }) {
  const host = ensureToastContainer();
  const card = document.createElement("div");
  card.className = "match-toast match-toast-mine match-toast-result " + (won ? "match-toast-win" : "match-toast-loss");
  const deckText = deckSummaryText(deck);
  const verb = won ? "Beat" : "Lost to";
  card.innerHTML = `
    <div class="match-toast-head">
      <span class="match-toast-tag">${won ? "You won! 🏆" : "You lost"}</span>
      <button type="button" class="match-toast-close" aria-label="Dismiss">&times;</button>
    </div>
    <div class="match-toast-players">${escapeHtml(verb)} ${escapeHtml(opp)} · ${escapeHtml(String(myScore))}–${escapeHtml(String(oppScore))}</div>
    ${where ? `<div class="match-toast-where">${escapeHtml(where)}</div>` : ""}
    ${deckText ? `<div class="match-toast-deck">Your deck: ${escapeHtml(deckText)}</div>` : ""}
  `;
  host.appendChild(card);
  const dismiss = () => {
    if (!card.parentNode) return;
    card.classList.add("match-toast-leaving");
    setTimeout(() => card.remove(), 220);
  };
  card.querySelector(".match-toast-close").addEventListener("click", dismiss);
  card.addEventListener("click", (e) => {
    if (e.target.closest(".match-toast-close")) return;
    dismiss();
  });
  setTimeout(dismiss, 9000);
  const title = won ? "You won!" : "You lost";
  const body = `${verb} ${opp} ${myScore}–${oppScore}${where ? ` · ${where}` : ""}`;
  maybeFireSystemNotification(title, body);
}

function paintProfileBannerRow(rowEl, name, place) {
  if (!rowEl || !name) return;
  resolveProfileBanner(name).then(banner => {
    if (!banner) return;
    rowEl.style.backgroundImage = `${BANNER_PLACE_SCRIM[place] || BANNER_NEUTRAL_SCRIM}, url("${banner}")`;
    rowEl.style.backgroundSize = "cover";
    rowEl.style.backgroundPosition = "center";
    rowEl.classList.add("has-rank-banner");
  });
}

// Paint each tournament-ranking row (carrying data-rank-name) with that
// player's profile banner as a full-row background.
function hydrateRankingBanners(container) {
  if (!container) return;
  container.querySelectorAll(".tournament-ranking-row[data-rank-name]").forEach(row => {
    const name = row.dataset.rankName || "";
    if (!name) return;
    const place = row.classList.contains("tournament-results-place-1") ? 1
      : row.classList.contains("tournament-results-place-2") ? 2
      : row.classList.contains("tournament-results-place-3") ? 3 : 0;
    paintProfileBannerRow(row, name, place);
  });
}

// Paint each final-placement row (.swiss-top-rank, carrying data-rank-name
// + data-rank-place) with that player's profile banner.
function hydrateTop8Banners(view) {
  if (!view) return;
  view.querySelectorAll(".swiss-top-rank[data-rank-name]").forEach(li => {
    const name = li.dataset.rankName || "";
    if (!name) return;
    paintProfileBannerRow(li, name, parseInt(li.dataset.rankPlace, 10) || 0);
  });
}

// Paint each registering-phase registrant row with that player's profile
// banner. Registrants aren't ranked, so they always get the neutral scrim.
function hydrateRegistrantBanners(view) {
  if (!view) return;
  view.querySelectorAll(".swiss-reg-row[data-rank-name]").forEach(li => {
    const name = li.dataset.rankName || "";
    if (name) paintProfileBannerRow(li, name, 0);
  });
}

// Swap every tournament avatar placeholder inside `view` for the account's
// real photo. Covers the registering-view registrant rows (.swiss-reg-avatar)
// and the running-view match-card / standings name cells (.swiss-name-avatar)
// — both carry data-reg-name. Names with no public profile keep the
// silhouette placeholder.
function hydrateTournamentAvatars(view) {
  if (!view) return;
  const imgs = view.querySelectorAll("img[data-reg-name]");
  if (!imgs.length) return;
  // Group the <img>s by name so each distinct player resolves once, even
  // if they appear in more than one card.
  const byName = Object.create(null);
  imgs.forEach(img => {
    const name = img.dataset.regName || "";
    if (!name) return;
    (byName[name] = byName[name] || []).push(img);
  });
  Object.keys(byName).forEach(name => {
    resolveProfilePhoto(name).then(photo => {
      if (photo) byName[name].forEach(img => { img.src = photo; });
    });
  });
}

// Edit an existing registrant — re-opens the registration popup pre-filled
// with their current name and deck, and routes the submit through an
// update path (overwrites the same registrant entry, no new id).
function showEditRegistrantPopup(registrantId) {
  if (!swissEditCode || !registrantId) return;
  const state = loadSwiss();
  if (!isRegisteringPhase(state)) return;
  const reg = state.registrants && state.registrants[registrantId];
  if (!reg) return;
  // Open if the user is host / co-host OR the registrant entry belongs
  // to this device (signed-in createdBy match or unauthed-guest local
  // tracking). Firebase rules already allow the same set of writers, so
  // the Save attempt will succeed.
  const myIds = (typeof findMyRegistrantIds === "function")
    ? new Set(findMyRegistrantIds(state, swissEditCode))
    : new Set();
  if (!swissCanEdit && !myIds.has(registrantId)) return;
  const room = {
    editCode: swissEditCode,
    viewCode: swissViewCode,
    name: state.tournamentName || "",
    mode: state.mode || "swiss",
    roundCount: state.roundCount || null,
    groupCount: state.groupCount || null
  };
  // A registrant created by a signed-in account carries no isGuest flag —
  // its name must stay equal to that account's username (it keys ranking),
  // so lock the field on edit. Only guest / "Register Others" entries, which
  // have no account attached, keep an editable name.
  showRegistrationPopup(room, {
    editRegistrantId: registrantId,
    initialName: reg.name || "",
    initialDeck: normalizeBeyCheckDeck(reg.deck),
    lockName: !reg.isGuest,
    // Guests may stay deck-less on edit too — only account registrations
    // are held to a full 3-combo deck.
    allowEmptyDeck: !!reg.isGuest
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
  // Pre-fill the name with the signed-in user's username and lock the field —
  // the host can't impersonate another player from their own device.
  const myUname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  showRegistrationPopup(room, { selfRegister: true, lockName: true, initialName: myUname });
}

// Host-only "Manage Banned Parts" popup. Built dynamically so it works on
// every per-tab index.html without separate HTML. Lets the host pick parts
// across every category that can't appear in any registrant's deck. Locked
// to the registering phase — once Start fires the list is final.
function showBannedPartsPopup() {
  if (!swissEditCode) return;
  // Host-only. Co-hosts can't edit because the swissRooms/$code/.write rule
  // restricts unspecified children (bannedParts isn't in the per-child rule
  // list) to hostUid only — a co-host write would be rejected by Firebase.
  if (!swissIsHost) return;
  const state = loadSwiss();
  if (!isRegisteringPhase(state)) return;
  if (typeof makeSearchable !== "function" || typeof DATA === "undefined") return;

  // Re-open: drop any stale instance first.
  document.getElementById("banned-parts-popup")?.remove();

  // Working copy — committed via updateRegisteringSetting on Save.
  const working = {};
  const initial = getBannedParts(state);
  BANNABLE_FIELDS.forEach(f => { working[f] = initial[f].slice(); });

  const overlay = document.createElement("div");
  overlay.id = "banned-parts-popup";
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Banned Parts</h2>
      <p class="popup-text">Pick parts that registrants can't use in any deck. Deck registration blocks any deck containing a banned part; Bey Check shows a warning so the judge can still record the deck if needed.</p>
      <label class="popup-text" style="display:block; margin-top:8px;">Add a part to ban:</label>
      <select id="banned-parts-add" style="display:none;"></select>
      <div id="banned-parts-list" style="margin-top:10px; display:flex; flex-direction:column; gap:6px;"></div>
      <div id="banned-parts-status" class="swiss-join-status"></div>
      <div class="popup-actions">
        <button type="button" id="banned-parts-save" class="btn">Save</button>
        <button type="button" id="banned-parts-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const sel = overlay.querySelector("#banned-parts-add");
  const listHost = overlay.querySelector("#banned-parts-list");
  const status = overlay.querySelector("#banned-parts-status");
  const saveBtn = overlay.querySelector("#banned-parts-save");
  const cancelBtn = overlay.querySelector("#banned-parts-cancel");

  // Combined picker: every part across every bannable category. The option
  // label is "Category — Part Name". Value is "field:partName" so the
  // selection handler can route it back to the right category.
  const combinedItems = [];
  BANNABLE_FIELDS.forEach(f => {
    const dataKey = BEY_CHECK_DATA_BY_FIELD[f];
    const arr = (dataKey && DATA[dataKey]) || [];
    arr.forEach(item => {
      if (!item || !item.name) return;
      combinedItems.push({
        field: f,
        partName: item.name,
        // `name` + `_folder` let makeSearchable draw the part thumbnail; the
        // list mixes categories, so each item carries its own folder (a
        // ratchet-bit keeps its `ratchetBits` folder). `modes` makes multi-mode
        // parts thumbnail at mode 0 (they have no plain name.webp).
        name: item.name,
        _folder: item._folder || dataKey,
        modes: item.modes,
        _label: item.name
      });
    });
  });
  // Sort within each category alphabetically; categories follow BANNABLE_FIELDS.
  const orderIdx = BANNABLE_FIELDS.reduce((acc, f, i) => { acc[f] = i; return acc; }, {});
  combinedItems.sort((a, b) =>
    (orderIdx[a.field] - orderIdx[b.field]) ||
    a.partName.localeCompare(b.partName)
  );

  const renderList = () => {
    const sections = [];
    BANNABLE_FIELDS.forEach(f => {
      const list = working[f];
      if (!list.length) return;
      const chips = list.map(name =>
        `<button type="button" class="banned-chip" data-field="${f}" data-name="${escapeHtml(name)}" title="Remove" style="display:inline-flex; align-items:center; gap:4px; padding:3px 6px 3px 10px; border-radius:999px; border:1px solid currentColor; background:transparent; color:inherit; font:inherit; font-size:.78rem; cursor:pointer;">${escapeHtml(name)}<span style="font-size:1rem; line-height:1; opacity:.65;">×</span></button>`
      ).join("");
      sections.push(`
        <div>
          <div style="font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; opacity:.65; margin-bottom:4px;">${BANNABLE_FIELD_LABEL[f]}</div>
          <div style="display:flex; flex-wrap:wrap; gap:4px;">${chips}</div>
        </div>
      `);
    });
    listHost.innerHTML = sections.length
      ? sections.join("")
      : `<div class="popup-text" style="font-style:italic; opacity:.7;">No bans yet.</div>`;
    listHost.querySelectorAll(".banned-chip").forEach(btn => {
      btn.onclick = () => {
        const f = btn.dataset.field;
        const n = btn.dataset.name;
        working[f] = (working[f] || []).filter(x => x !== n);
        renderList();
      };
    });
  };

  // Wire makeSearchable on the combined picker, then capture selections.
  makeSearchable(sel, combinedItems, item => item._label);
  sel.addEventListener("change", () => {
    const idx = parseInt(sel.value, 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= combinedItems.length) return;
    const item = combinedItems[idx];
    if (!item) return;
    const list = working[item.field] || (working[item.field] = []);
    if (!list.some(n => n.toLowerCase() === item.partName.toLowerCase())) {
      list.push(item.partName);
    }
    // Clear the picker so the same input stays ready for the next pick.
    sel.value = "";
    const wrapperInput = sel.nextElementSibling?.querySelector("input");
    if (wrapperInput) wrapperInput.value = "";
    renderList();
  });

  renderList();

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey);
  cancelBtn.onclick = close;

  saveBtn.onclick = () => {
    // Prune empty categories so we don't write {blade: [], lockChip: [], …}.
    const patch = {};
    BANNABLE_FIELDS.forEach(f => {
      if (working[f] && working[f].length) patch[f] = working[f].slice();
    });
    // Persist via the same patcher the other registering-time settings use.
    // updateRegisteringSetting handles both local persist and Firebase push.
    updateRegisteringSetting({ bannedParts: Object.keys(patch).length ? patch : null });
    setStatus("Saved ✓", "ok");
    setTimeout(close, 500);
  };
}

// Bulk Guests — the single "add others" path. Pastes a name list (one per
// line) and creates every entry as a deck-less guest in a single Firebase
// update. Same audience as Register Myself: hosts / co-hosts and registered
// participants; plain viewers can't reach the button. Mirrors the Test
// path's batched .update() so the listener fires once and every entry
// appears in the same render tick. Handles single-add too — the host can
// just type one line for one guest.
//
// The popup is built dynamically so this works on any page (every per-tab
// index.html is a full app copy, but we don't need a new <div> in each).
const BULK_GUESTS_MAX = 50;

// opts:
//   editCode — defaults to the currently connected room's code (in-room use).
//             Pass explicitly from the lobby (Become Guest), where the device
//             isn't connected to a room yet.
//   fromLobby — when true, skip the in-room guards and use a lobby-tailored
//             title / hint text ("Join + register friends" framing).
//   afterAdd — optional callback fired after a successful bulk write; the
//             lobby flow uses this to auto-connect the user to the room as
//             participant + switch tabs.
function showBulkGuestsPopup(opts) {
  opts = opts || {};
  const fromLobby = !!opts.fromLobby;
  const editCode = opts.editCode || swissEditCode;
  if (!editCode) return;

  // In-room invocation needs the registering-phase + role guards. Lobby
  // invocation has already validated the room exists and is open.
  if (!fromLobby) {
    if (!swissCanEdit && swissSessionRole !== "participant") return;
    const state = loadSwiss();
    if (!isRegisteringPhase(state)) return;
  }

  // Re-open: drop any stale instance first.
  document.getElementById("bulk-guests-popup")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "bulk-guests-popup";
  overlay.className = "popup-overlay";
  const title = fromLobby ? "Join as Guest" : "Bulk Add Guests";
  const blurb = fromLobby
    ? "Enter your name (and any friends, one per line). Each becomes a deck-less guest entry — guests don't earn ranking points. You'll be dropped into the tournament view after."
    : "Enter one name per line — each becomes a deck-less guest entry. Guests don't earn ranking points.";
  const submitLabel = fromLobby ? "Join" : "Add Guests";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">${title}</h2>
      <p class="popup-text">${blurb}</p>
      <textarea id="bulk-guests-input" class="account-bio" rows="8" placeholder="Alice
Bob
Charlie" style="width:100%; min-height:140px; resize:vertical;"></textarea>
      <p class="popup-text" style="font-size:0.78rem; margin-top:6px;">Max ${BULK_GUESTS_MAX} per batch. Duplicate names (matching existing registrants or each other) are skipped.</p>
      <div id="bulk-guests-status" class="swiss-join-status"></div>
      <div class="popup-actions">
        <button type="button" id="bulk-guests-submit" class="btn">${submitLabel}</button>
        <button type="button" id="bulk-guests-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const textarea = overlay.querySelector("#bulk-guests-input");
  const status = overlay.querySelector("#bulk-guests-status");
  const submitBtn = overlay.querySelector("#bulk-guests-submit");
  const cancelBtn = overlay.querySelector("#bulk-guests-cancel");

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  const close = () => overlay.remove();
  cancelBtn.onclick = close;

  // Esc closes, like the other popups.
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); document.removeEventListener("keydown", onKey); }
  };
  document.addEventListener("keydown", onKey);

  setTimeout(() => textarea?.focus(), 0);

  submitBtn.onclick = () => {
    const seen = new Set();
    const names = (textarea.value || "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .filter(s => {
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (names.length === 0) {
      setStatus("Enter at least one name (one per line).", "err");
      return;
    }
    const tooLong = names.find(n => n.length > 60);
    if (tooLong) {
      setStatus(`"${tooLong.slice(0, 40)}" is over 60 characters.`, "err");
      return;
    }
    if (names.length > BULK_GUESTS_MAX) {
      setStatus(`Too many names — max ${BULK_GUESTS_MAX} per batch (got ${names.length}).`, "err");
      return;
    }
    submitBtn.disabled = true;
    bulkAddGuests(editCode, names, setStatus, () => {
      document.removeEventListener("keydown", onKey);
      close();
      if (typeof opts.afterAdd === "function") opts.afterAdd();
    }, () => { submitBtn.disabled = false; });
  };
}

function bulkAddGuests(editCode, names, setStatus, onSuccess, onFail) {
  if (!editCode) { onFail?.(); return; }
  const db = initFirebase();
  if (!db) { setStatus("Firebase not available.", "err"); onFail?.(); return; }
  setStatus(`Adding ${names.length} guest${names.length === 1 ? "" : "s"}…`, "pending");

  const roomRef = db.ref("swissRooms/" + editCode);
  roomRef.once("value").then(snap => {
    const remote = snap.val();
    if (!remote || remote.phase !== "registering") {
      throw new Error("This tournament is no longer accepting registrations.");
    }
    const usedNames = new Set(
      Object.values(remote.registrants || {})
        .map(r => (r && typeof r.name === "string") ? r.name.trim().toLowerCase() : "")
        .filter(Boolean)
    );
    const dupes = [];
    const toAdd = [];
    for (const n of names) {
      const k = n.toLowerCase();
      if (usedNames.has(k)) { dupes.push(n); continue; }
      usedNames.add(k);
      toAdd.push(n);
    }
    if (toAdd.length === 0) {
      throw new Error("All those names are already registered.");
    }

    // Participant cap — trim the batch to whatever room is left. If nothing
    // fits, reject; otherwise add what we can and report the overflow.
    const remaining = capSlotsRemaining(remote);
    let capOverflow = [];
    if (remaining <= 0) {
      throw new Error("This tournament is full — no more guests can be added.");
    }
    if (toAdd.length > remaining) {
      capOverflow = toAdd.slice(remaining);
      toAdd.length = remaining;
    }

    // Bulk write: one .update() so the listener fires once, every entry
    // shows up together. Each entry mirrors Register Others — isGuest:true,
    // empty deck (guests may skip the deck), createdBy = writer's uid when
    // signed in (host / co-host / participant; the rule's third clause
    // accepts it). Unauthed callers can't reach this popup, so we always
    // expect a writerUid here.
    const writerUid = (window.getCurrentUser && window.getCurrentUser()?.uid) || null;
    const emptyDeck = emptyBeyCheckDeck();
    const updates = {};
    const newIds = [];
    for (const name of toAdd) {
      const id = generateRegistrantId();
      const entry = { name, deck: emptyDeck, isGuest: true };
      if (writerUid) entry.createdBy = writerUid;
      updates[`registrants/${id}`] = entry;
      newIds.push(id);
    }

    return roomRef.update(updates).then(() => {
      // Remember every entry created in this batch so the user can self-
      // cancel via Leave Room. Critical for unauthed guests (no createdBy).
      rememberDeviceOwnedRegIds(editCode, newIds);
      // Refresh the lobby count (non-fatal — host listener also publishes).
      return roomRef.child("registrants").once("value").then(s => {
        const total = s.numChildren();
        return db.ref("openTournaments/" + editCode + "/registrantCount").set(total).catch(() => {});
      });
    }).then(() => {
      const addedTxt = `${toAdd.length} guest${toAdd.length === 1 ? "" : "s"}`;
      const dupeTxt = dupes.length ? ` (skipped ${dupes.length} duplicate${dupes.length === 1 ? "" : "s"})` : "";
      const fullTxt = capOverflow.length ? ` — ${capOverflow.length} didn't fit (tournament full)` : "";
      setStatus(`Added ${addedTxt} ✓${dupeTxt}${fullTxt}`, "ok");
      setTimeout(() => onSuccess?.(), 900);
    });
  }).catch(e => {
    console.warn("Bulk add guests failed:", e);
    setStatus(e.message || "Couldn't add guests. Try again.", "err");
    onFail?.();
  });
}

// ---------------- Banned parts ----------------
// The host can ban specific parts during the registering phase. Banned
// parts are stored on state.bannedParts as a per-category name list and
// blocked at deck submission, warned at Bey Check, and shown to every
// participant in the registering view. The list locks the moment the
// tournament starts (Start clears the registering phase).
const BANNABLE_FIELDS = ["blade", "lockChip", "mainBlade", "metalBlade", "overBlade", "assistBlade", "ratchet", "bit"];
const BANNABLE_FIELD_LABEL = {
  blade: "Blade",
  lockChip: "Lock Chip",
  mainBlade: "Main Blade",
  metalBlade: "Metal Blade",
  overBlade: "Over Blade",
  assistBlade: "Assist Blade",
  ratchet: "Ratchet",
  bit: "Bit"
};

// Return banned parts grouped by category, with every category present and
// an empty array when nothing is banned. Defensive — handles missing /
// non-array storage gracefully.
function getBannedParts(state) {
  const src = (state && state.bannedParts) || {};
  const out = {};
  BANNABLE_FIELDS.forEach(f => {
    const list = Array.isArray(src[f]) ? src[f].filter(n => typeof n === "string" && n) : [];
    out[f] = list;
  });
  return out;
}

// True iff at least one category has any banned part.
function hasAnyBannedParts(state) {
  const b = getBannedParts(state);
  return BANNABLE_FIELDS.some(f => b[f].length > 0);
}

// Walk a deck and return every banned part it carries as
// [{ slot: 1-based, field, name }]. Case-insensitive name match.
//
// Cross-field — banning a part by name covers it wherever it appears in
// the deck (blade / mainBlade / lockChip / etc.), since part names are
// unique to one physical part. Earlier this was per-field, which let a
// blade-banned name slip through when used under mainBlade in CX mode
// or vice versa.
function findBannedPartsInDeck(deck, bannedParts) {
  const hits = [];
  if (!Array.isArray(deck)) return hits;
  const banned = new Set();
  Object.values(bannedParts || {}).forEach(list => {
    (list || []).forEach(n => {
      const k = String(n).trim().toLowerCase();
      if (k) banned.add(k);
    });
  });
  if (!banned.size) return hits;
  deck.forEach((slot, slotIdx) => {
    if (!slot || !slot.parts) return;
    Object.entries(slot.parts).forEach(([f, name]) => {
      if (!name || name === NO_RATCHET) return;
      if (banned.has(String(name).trim().toLowerCase())) {
        hits.push({ slot: slotIdx + 1, field: f, name });
      }
    });
  });
  return hits;
}

// ---------------- Win rate ----------------
// Each user has a running W / L / Tie tally at /winRates/$key. Public read,
// any authed write — same pattern as /ranking. The host's device bumps
// counters once per match via a wrApplied flag on the match record so
// re-scoring (or another device replaying the listener) doesn't double-
// count. Only non-guest registrants are tracked: guest / single-elim
// by-name entries have no stable account key.
//
// Known limitation: if a match is re-scored with the winner flipped, the
// original win/loss stays on the books (because wrApplied is set). The
// host can manually adjust if needed. Trade-off for keeping the writes
// simple (one bump per match instead of a delta).

// True if `name` matches a non-guest registrant in this tournament.
// Returns false for guests, single-elim by-name participants (no
// registrants[] entry), and missing / blank names.
function nameIsAccountRegistrant(state, name) {
  if (!name || !state || !state.registrants) return false;
  const lower = String(name).trim().toLowerCase();
  for (const id in state.registrants) {
    const r = state.registrants[id];
    if (r && typeof r.name === "string" && r.name.trim().toLowerCase() === lower) {
      return r.isGuest !== true;
    }
  }
  return false;
}

// Lowercase / Firebase-safe key for a player name. Mirrors usernameKey in
// auth.js so the winRates entry shares the same key the profiles index uses.
function winRateKey(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[.#$/\[\]]/g, "_");
}

// Transactional +1 to a single achievement counter, keyed by the player's
// Firebase Auth UID (resolved via the public usernames index). When the
// bumped count reaches the achievement's target, sets `awarded: true` on
// the same node so the player's own client (auth.js) can mirror the
// matching tag onto their profile next time they sign in. Forward-only.
function bumpAchievement(name, achievementId) {
  if (!name || !achievementId) {
    console.warn("[achievement] bumpAchievement called with empty name/id", { name, achievementId });
    return;
  }
  if (!window.ACHIEVEMENTS || !window.achievementUsernameKeyFor) {
    console.warn("[achievement] shared module (achievements.js) not loaded — bump aborted");
    return;
  }
  const def = window.ACHIEVEMENTS.find(a => a.id === achievementId);
  if (!def) {
    console.warn("[achievement] unknown achievementId", achievementId);
    return;
  }
  const db = (typeof initFirebase === "function") ? initFirebase() : null;
  if (!db) {
    console.warn("[achievement] Firebase not initialised — bump aborted");
    return;
  }
  const uKey = window.achievementUsernameKeyFor(name);
  if (!uKey) {
    console.warn("[achievement] couldn't derive usernameKey for", name);
    return;
  }
  // Look up the player's UID first — /achievements is keyed by UID so the
  // tag-claim rule in /users/{uid}/tags can verify the awarded flag with a
  // direct lookup. Skips silently if the name has no usernames entry
  // (guests / test players — already filtered out by the caller via
  // nameIsAccountRegistrant, this is belt-and-suspenders).
  db.ref(`usernames/${uKey}/uid`).once("value").then(snap => {
    const uid = snap.val();
    if (!uid || typeof uid !== "string") {
      console.warn("[achievement] no /usernames/" + uKey + "/uid lookup — winner is likely a guest or unregistered. Achievement skipped.");
      return;
    }
    console.info("[achievement] writing", achievementId, "for uid", uid);
    const ref = db.ref(`achievements/${uid}/${achievementId}`);
    return ref.transaction(curr => {
      const c = (curr && typeof curr === "object") ? curr : {};
      // Only include `awardedAt` when it has a real ISO string value —
      // emitting `awardedAt: null` on the first bump trips the Firebase
      // .validate rule (newData.isString() is false for null), aborting
      // the transaction silently.
      const next = {
        count: (c.count || 0) + 1,
        awarded: !!c.awarded,
        updatedAt: new Date().toISOString()
      };
      if (typeof c.awardedAt === "string" && c.awardedAt) {
        next.awardedAt = c.awardedAt;
      }
      if (!next.awarded && next.count >= def.target) {
        next.awarded = true;
        next.awardedAt = next.updatedAt;
      }
      return next;
    });
  }).then(result => {
    if (result && typeof result === "object" && result.committed === false) {
      console.warn("[achievement] transaction aborted for", uKey, achievementId, "— likely a Firebase rule rejection. Check that the rules whitelist includes this achievementId.");
    }
  }).catch(e => console.warn("[achievement] bump failed for", uKey, achievementId, e && e.message));
}

// Inspect a freshly-scored match and bump every achievement the WINNER
// qualified for under the match's decks. Called from maybeApplyMatchWinRate
// alongside the win-rate bump — same gating, same idempotency via wrApplied.
//
// Format-agnostic: a match record is the same shape whether it came from
// a Swiss group, a Round Robin group, or a Single Elimination bracket
// node. As long as match.a / match.b / scoreA / scoreB are populated and
// the players are non-guest registrants, the credit fires.
//
// Deck resolution falls back through three sources so that scoring a
// match without first running Bey Check (which would normally write
// match.decks) doesn't silently break the achievement check:
//   1. match.decks.a / match.decks.b — the per-match judge override
//      written by Bey Check (most accurate, includes any overrides).
//   2. the player's registered deck (state.registrants → r.deck).
//   3. the most recent deck the player used in a prior match (legacy
//      pre-self-registration tournaments).
function applyMatchAchievements(match, winnerName, loserName, state) {
  if (!winnerName) {
    console.info("[achievement] no winner (tie?) — skipping");
    return;
  }
  const defs = window.ACHIEVEMENTS || [];
  if (!defs.length) {
    console.warn("[achievement] window.ACHIEVEMENTS empty — achievements.js may not have loaded");
    return;
  }
  const decks = (match && match.decks) || {};
  const matchId = match && match.id;
  const resolveDeck = (name) => {
    if (!name) return null;
    let raw = (match.a === name) ? decks.a : (match.b === name) ? decks.b : null;
    if (!isBeyCheckDeckEmpty(raw)) return raw;
    if (typeof getRegisteredDeckForParticipant === "function") {
      const reg = getRegisteredDeckForParticipant(state, name);
      if (!isBeyCheckDeckEmpty(reg)) return reg;
    }
    if (typeof findLatestDeckForParticipant === "function") {
      const prev = findLatestDeckForParticipant(state, name, matchId);
      if (!isBeyCheckDeckEmpty(prev)) return prev;
    }
    return null;
  };
  const winnerDeck = resolveDeck(winnerName);
  const loserDeck = resolveDeck(loserName);
  console.info("[achievement] evaluating", { winner: winnerName, loser: loserName, hasWinnerDeck: !!winnerDeck, hasLoserDeck: !!loserDeck });
  if (!winnerDeck) {
    console.warn("[achievement] no deck resolved for winner — every deck-based check will fail. Open Bey Check before scoring, or register a deck.");
  }
  for (const def of defs) {
    let credit = false;
    try { credit = !!def.creditOnWin(winnerDeck, loserDeck); } catch (e) {
      console.warn("[achievement] creditOnWin threw for", def.id, e);
      credit = false;
    }
    if (credit) {
      console.info("[achievement] CREDIT", def.id, "for", winnerName);
      bumpAchievement(winnerName, def.id);
    }
  }
}

// Transactional +1 to wins / losses / ties for a single player.
function bumpWinRate(name, kind) {
  if (!name) return;
  if (kind !== "win" && kind !== "loss" && kind !== "tie") return;
  const db = (typeof initFirebase === "function") ? initFirebase() : null;
  if (!db) return;
  const key = winRateKey(name);
  if (!key) return;
  const ref = db.ref(`winRates/${key}`);
  ref.transaction(curr => {
    const c = (curr && typeof curr === "object") ? curr : {};
    const inc = { wins: c.wins || 0, losses: c.losses || 0, ties: c.ties || 0 };
    if (kind === "win") inc.wins++;
    else if (kind === "loss") inc.losses++;
    else inc.ties++;
    inc.updatedAt = new Date().toISOString();
    return inc;
  }).catch(e => console.warn("winRate bump failed for", key, e));
}

// Inspect a freshly-scored match and bump the win-rate counters for each
// non-guest player. Idempotent via match.wrApplied. Returns a small patch
// to merge onto the match record (the wrApplied flag) so the caller can
// push it alongside the score update — that way every device sees the
// match as "counted" and the host listener doesn't re-apply on the way
// back through Firebase.
function maybeApplyMatchWinRate(matchId, storedBefore, state) {
  if (!swissCanEdit) { console.info("[achievement] skip — not host/co-host"); return null; }
  const match = state.matches && state.matches[matchId];
  if (!match) { console.info("[achievement] skip — match not in state", matchId); return null; }
  if (match.wrApplied) { console.info("[achievement] skip — match already counted (wrApplied)", matchId); return null; }
  if (match.bye) { console.info("[achievement] skip — bye match", matchId); return null; }
  if (!match.a || !match.b) { console.info("[achievement] skip — half-filled match", matchId); return null; }
  const scoreA = match.scoreA, scoreB = match.scoreB;
  if (scoreA == null || scoreB == null) { console.info("[achievement] skip — match not scored yet", matchId); return null; }

  const aCounts = nameIsAccountRegistrant(state, match.a);
  const bCounts = nameIsAccountRegistrant(state, match.b);
  console.info("[achievement] match qualifies", matchId, { a: match.a, b: match.b, scoreA, scoreB, aCounts, bCounts });
  if (!aCounts && !bCounts) { console.info("[achievement] skip — both players are guests"); return null; }

  if (scoreA > scoreB) {
    if (aCounts) bumpWinRate(match.a, "win");
    if (bCounts) bumpWinRate(match.b, "loss");
    // Achievements: winner = a. Only credit the winner if they have an
    // account (guests don't earn achievements, same gate as ranking).
    if (aCounts) applyMatchAchievements(match, match.a, match.b, state);
  } else if (scoreB > scoreA) {
    if (aCounts) bumpWinRate(match.a, "loss");
    if (bCounts) bumpWinRate(match.b, "win");
    if (bCounts) applyMatchAchievements(match, match.b, match.a, state);
  } else {
    if (aCounts) bumpWinRate(match.a, "tie");
    if (bCounts) bumpWinRate(match.b, "tie");
    // Ties don't credit any achievement (all achievements require a win).
  }
  // Mark the match locally so the host's own listener tick (and any sibling
  // tab) won't re-apply, and return the patch for the Firebase push.
  match.wrApplied = true;
  return { matchPatch: { wrApplied: true } };
}

// Minimum registrants needed before Start can fire. Mirrors the same checks
// the underlying generators apply, so the host can never click Start and
// then get an alert from the generator.
function swissRegistrationMinimum(state) {
  if (!state) return 0;
  if (state.mode === "single-elim") return 2;
  // Swiss / Swiss + Top N: need enough per group for SWISS_MIN_PER_GROUP and
  // enough total for the knockout's slots. New tournaments carry state.topN
  // (configurable), legacy ones fall back to the original 8.
  const gc = getGroupCount(state);
  const bracketN = state.mode === "swiss-only"
    ? 0
    : (typeof state.topN === "number" && state.topN >= 2 ? state.topN : SWISS_BRACKET_SIZE);
  const minPerGroupForBracket = bracketN > 0 ? Math.ceil(bracketN / gc) : SWISS_MIN_PER_GROUP;
  return gc * Math.max(SWISS_MIN_PER_GROUP, minPerGroupForBracket);
}

// ---- Participant cap (host-set maximum) ----
// A tournament may carry an optional `maxParticipants` ceiling. null / absent
// or < 2 means "no cap". Works on either the local state or a fresh Firebase
// snapshot (both carry `maxParticipants` + `registrants`).
function participantCap(stateOrRemote) {
  const v = stateOrRemote && stateOrRemote.maxParticipants;
  return (typeof v === "number" && v >= 2) ? Math.floor(v) : null;
}
function registrantTotal(stateOrRemote) {
  return Object.keys((stateOrRemote && stateOrRemote.registrants) || {}).length;
}
// Slots left before the cap (Infinity when uncapped). Pass a fresh Firebase
// snapshot when enforcing a write so the count is authoritative against
// concurrent registrations.
function capSlotsRemaining(stateOrRemote) {
  const cap = participantCap(stateOrRemote);
  if (cap == null) return Infinity;
  return Math.max(0, cap - registrantTotal(stateOrRemote));
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
  // Combined deck-quality warning. Three categories, listed separately so
  // the host can see exactly what's wrong and decide whether to proceed.
  // All three are overridable — the host can still start if (e.g.) a known
  // guest is going to fill in their deck at the judge's table.
  const bannedNames = getBannedParts(state);
  const missingDecks = [];
  const incompleteDecks = [];
  const bannedDecks = [];
  // listRegistrants() returns only {id, name, deck} — the isGuest flag is
  // dropped, so read it from the raw state map here.
  const rawRegistrants = (state && state.registrants) || {};
  registrants.forEach(r => {
    const display = r.name || "(unnamed)";
    const raw = rawRegistrants[r.id] || {};
    const isGuest = raw.isGuest === true;
    if (isBeyCheckDeckEmpty(r.deck)) {
      // Guests are allowed to skip the deck entirely (the judge fills it
      // in at match time), so a fully empty guest deck doesn't warrant a
      // warning. Account registrants still surface here.
      if (!isGuest) missingDecks.push(display);
      return; // already covered by the missing-deck bucket
    }
    const incompleteSlots = incompleteBeyCheckDeckSlotNumbers(r.deck);
    if (incompleteSlots.length) {
      incompleteDecks.push(`${display} — Slot${incompleteSlots.length === 1 ? "" : "s"} ${incompleteSlots.join(", ")}`);
    }
    const bannedHits = findBannedPartsInDeck(r.deck, bannedNames);
    if (bannedHits.length) {
      const parts = bannedHits.map(h => `${h.name} (Slot ${h.slot})`).join(", ");
      bannedDecks.push(`${display} — ${parts}`);
    }
  });
  if (missingDecks.length || incompleteDecks.length || bannedDecks.length) {
    const sections = [];
    if (missingDecks.length) {
      sections.push(`No deck submitted:\n${missingDecks.join("\n")}`);
    }
    if (incompleteDecks.length) {
      sections.push(`Deck has incomplete slots:\n${incompleteDecks.join("\n")}`);
    }
    if (bannedDecks.length) {
      sections.push(`Deck contains banned parts:\n${bannedDecks.join("\n")}`);
    }
    const proceed = confirm(`${sections.join("\n\n")}\n\nStart anyway?`);
    if (!proceed) return;
  }
  const names = registrants.map(r => (r.name || "").trim()).filter(Boolean);
  if (names.length < minTotal) {
    alert("Some registrants are missing a name.");
    return;
  }
  const namesText = names.join("\n");
  const generated = state.mode === "single-elim"
    ? generateSingleElimFromText(namesText, state.tournamentName, state.placementDepth)
    : generateSwissFromText(namesText, state.tournamentName, getRoundCount(state), getGroupCount(state), state.pairing);
  if (!generated) return; // generator already alerted
  // Carry forward registrants + metadata; flip phase to running. hostUid must
  // be carried too — the room push below is a full overwrite, so dropping it
  // would wipe the room's owner field.
  generated.registrants = state.registrants;
  generated.phase = "running";
  generated.ranked = state.ranked;
  generated.hostUid = state.hostUid || null;
  generated.hostName = state.hostName || null;
  if (state.mode === "swiss-only") generated.mode = "swiss-only";
  if (state.createdAt) generated.createdAt = state.createdAt;
  persistSwiss(generated);

  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    // Write the generated structure with update() (NOT a full-root set()): a
    // set() at the room root is gated by the host-only root .write rule and
    // would be rejected for a CO-HOST, whereas these child fields each allow
    // host + co-hosts. update() also merges — the room's existing metadata
    // (registrants, hostUid, hostName, subHosts, viewCode…) is preserved
    // automatically, so nothing needs carrying forward.
    const updates = { phase: "running" };
    ["groups", "matches", "groupRounds", "bracket", "bracketSize", "preFinalRounds", "ranked"]
      .forEach(k => { if (generated[k] !== undefined) updates[k] = generated[k]; });
    swissApplyingRemote = true;
    swissRoomRef.update(updates)
      .catch(e => console.warn("Start tournament push failed:", e))
      .finally(() => { swissApplyingRemote = false; });
  }
  // Keep the room in the Open Tournaments lobby once it's running. Registration
  // is closed, but co-hosts and viewers can still find and join it — the entry
  // is only removed when the host resets/closes the room.
  if (swissEditCode) publishOpenRoomIndex(swissEditCode, generated);
  // Refresh the host's account-scoped index so the phase flips to running. Only
  // the host may write their own userTournaments node (rule: auth.uid === uid),
  // so skip this for a co-host — a co-host write there is rejected anyway, and
  // the host's own device refreshes the index when it receives the update.
  if (swissEditCode && generated.hostUid && swissIsHost) {
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
      // penalised. It counts as a clean 4-0: a win plus 4 points scored (0
      // against). A round-robin bye is just a sit-out (everyone still faces
      // everyone else over the full schedule), so it scores nothing.
      if (!isRoundRobin) { stats[m.a].wins++; stats[m.a].pointsScored += 4; }
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
  // (f, 3rd, 5th, 7th, 9th, 11th, 13th, 15th) are terminal and return null.
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
    // The 7th-place match only exists at depth ≥ 7; below that the CQF
    // losers are simply unranked.
    const has7th = !!(state && state.matches && state.matches["bracket-7th-0"]);
    return {
      winner: { toId: "bracket-5th-0", slot },
      loser:  has7th ? { toId: "bracket-7th-0", slot } : null
    };
  }
  // Loser-bracket placement rounds (single-elim, depth ≥ 12).
  // c16-r0 (4 matches, 8 R16 losers) →
  //   winners feed c16-sfw (top-half SF) which produces 9th/11th
  //   losers feed c16-sfl (bottom-half SF — depth-16 only) which produces 13th/15th
  if (round === "c16-r0") {
    const downIdx = Math.floor(bracketIndex / 2);
    const slot = bracketIndex % 2 === 0 ? "a" : "b";
    const hasSfl = !!(state && state.matches && state.matches["bracket-c16-sfl-0"]);
    return {
      winner: { toId: `bracket-c16-sfw-${downIdx}`, slot },
      loser:  hasSfl ? { toId: `bracket-c16-sfl-${downIdx}`, slot } : null
    };
  }
  if (round === "c16-sfw") {
    const slot = bracketIndex === 0 ? "a" : "b";
    // The 11th match only exists at depth ≥ 11.
    const has11th = !!(state && state.matches && state.matches["bracket-11th-0"]);
    return {
      winner: { toId: "bracket-9th-0", slot },
      loser:  has11th ? { toId: "bracket-11th-0", slot } : null
    };
  }
  if (round === "c16-sfl") {
    const slot = bracketIndex === 0 ? "a" : "b";
    // The 15th match only exists at depth ≥ 15.
    const has15th = !!(state && state.matches && state.matches["bracket-15th-0"]);
    return {
      winner: { toId: "bracket-13th-0", slot },
      loser:  has15th ? { toId: "bracket-15th-0", slot } : null
    };
  }
  // Single-elimination (variable size) — numeric round index.
  if (typeof round === "number") {
    const preFinal = state && typeof state.preFinalRounds === "number" ? state.preFinalRounds : 0;
    const isSemi = round === preFinal - 1;
    const isQuarter = round === preFinal - 2;
    const isR16 = round === preFinal - 3;
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
    if (isR16) {
      // Depth 12/16: R16 losers seed bracket-c16-r0-{floor(r16Idx/2)}.
      // The slot inside the c16-r0 mirrors the R16 index parity, so
      // sibling R16 matches' losers face each other in the loser bracket.
      const hasC16 = !!(state && state.matches && state.matches["bracket-c16-r0-0"]);
      return {
        winner: { toId: `bracket-r${round + 1}-${Math.floor(bracketIndex / 2)}`, slot },
        loser:  hasC16 ? { toId: `bracket-c16-r0-${Math.floor(bracketIndex / 2)}`, slot } : null
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
  // New tournaments carry state.topN (the configurable bracket size). They
  // go through the round-indexed single-elim structure so any N works.
  // Legacy tournaments (no topN) keep the hard-coded QF/SF/F bracket — their
  // in-flight matches and listeners depend on those exact ids.
  if (typeof state.topN === "number" && state.topN >= 2) {
    return buildTopNBracketMatches(state);
  }

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

// Build a single-elim-style knockout for an arbitrary top-N from group
// standings. Reuses the same match-id structure that single-elim mode uses
// (bracket-r0-*, bracket-r1-*, ..., bracket-f-0, bracket-3rd-0, plus the
// consolation chain bracket-cqf-*/5th/7th when there's a quarterfinal),
// so the existing renderSingleElimBracket renderer and bracketUpstreamSource
// resolver work without changes. Non-power-of-2 N pads to the next power of
// 2 with BYE slots, which autoAdvanceByes will collapse on entry.
function buildTopNBracketMatches(state) {
  const topN = Math.max(2, Number(state.topN) || 8);
  const seeded = topNSeededParticipants(state, topN); // length = topN
  let bracketSize = 2;
  while (bracketSize < topN) bracketSize *= 2;
  // Pad with null BYEs.
  const slots = seeded.slice();
  while (slots.length < bracketSize) slots.push(null);
  const preFinalRounds = Math.round(Math.log2(bracketSize)) - 1;

  // Stash for the renderer / autoAdvanceByes. preFinalRounds is also what
  // bracketUpstreamSource reads to resolve placement-match upstreams.
  state.bracketSize = bracketSize;
  state.preFinalRounds = preFinalRounds;

  const emptyBracketMatch = (round, idx) => ({
    bracket: true, round, bracketIndex: idx,
    groupIndex: null, a: null, b: null,
    scoreA: null, scoreB: null, startedAt: null, bye: false
  });
  const newMatches = {};

  if (preFinalRounds === 0) {
    // 2-player bracket — just the final.
    newMatches["bracket-f-0"] = {
      ...emptyBracketMatch("f", 0),
      a: slots[0], b: slots[1]
    };
    return newMatches;
  }

  // Round 0: filled with seeded pairs (and any tail BYEs).
  for (let j = 0; j < bracketSize / 2; j++) {
    newMatches[`bracket-r0-${j}`] = {
      ...emptyBracketMatch(0, j),
      a: slots[j * 2], b: slots[j * 2 + 1]
    };
  }
  // Intermediate rounds 1..preFinalRounds-1 — empty, filled via propagation.
  for (let r = 1; r < preFinalRounds; r++) {
    const matchesInRound = bracketSize / Math.pow(2, r + 1);
    for (let j = 0; j < matchesInRound; j++) {
      newMatches[`bracket-r${r}-${j}`] = emptyBracketMatch(r, j);
    }
  }
  newMatches["bracket-f-0"] = emptyBracketMatch("f", 0);
  if (topN >= 4) {
    newMatches["bracket-3rd-0"] = emptyBracketMatch("3rd", 0);
  }
  // 5th/7th consolation chain — only when there's a real quarterfinal round
  // (bracketSize >= 8). bracketUpstreamSource feeds CQF off the QF round
  // (preFinal - 2 in the round-indexed numbering).
  if (preFinalRounds >= 2) {
    newMatches["bracket-cqf-0"] = emptyBracketMatch("cqf", 0);
    newMatches["bracket-cqf-1"] = emptyBracketMatch("cqf", 1);
    newMatches["bracket-5th-0"] = emptyBracketMatch("5th", 0);
    newMatches["bracket-7th-0"] = emptyBracketMatch("7th", 0);
  }
  return newMatches;
}

// Pick the top-N participants from group standings in seeded order, cross-
// group interleaved so the top seed in each group lands on a different half
// of the bracket. The returned array is length topN — slot 0 plays slot 1 in
// round 0, slot 2 plays slot 3, etc. (matches the single-elim seeding the
// generic engine expects).
function topNSeededParticipants(state, topN) {
  const groups = (state && Array.isArray(state.groups)) ? state.groups : [];
  if (groups.length === 0) return Array.from({ length: topN }, () => null);
  // Standings per group, sorted best-first.
  const standings = groups.map((members, gi) =>
    computeStandings(members, state.matches, gi, state.pairing === "round-robin")
  );
  // Flatten into a global pool of {rank-in-group, group-index, entry}. Then
  // sort by rank-in-group asc, then by the same tiebreakers computeStandings
  // applies across groups, so the best 1sts come before the best 2nds, etc.
  const pool = [];
  standings.forEach((st, gi) => {
    st.forEach((entry, rankInGroup) => {
      pool.push({ rankInGroup, gi, entry });
    });
  });
  pool.sort((a, b) =>
    a.rankInGroup - b.rankInGroup ||
    ((b.entry.wins || 0) - (a.entry.wins || 0)) ||
    ((b.entry.pointsScored || 0) - (a.entry.pointsScored || 0)) ||
    ((b.entry.pointsDiff || 0) - (a.entry.pointsDiff || 0)) ||
    ((b.entry.medianBuchholz || 0) - (a.entry.medianBuchholz || 0)) ||
    (a.entry.name || "").localeCompare(b.entry.name || "")
  );
  const top = pool.slice(0, topN).map(p => p.entry.name || null);
  // Standard cross-bracket seeding: pair seed 1 vs seed N, 2 vs N-1, etc.,
  // and interleave halves so the top two seeds sit on opposite sides of
  // the bracket. Build with the standard "fold" sequence — for size S,
  // round-0 order is [1, S, S-1, 2, ... ] which keeps 1 vs S in match 0
  // and pushes top seeds apart through subsequent rounds.
  let bracketSize = 2;
  while (bracketSize < topN) bracketSize *= 2;
  while (top.length < bracketSize) top.push(null);
  return foldBracketSeeding(top);
}

// Standard tournament fold seeding: turns a seed-ordered array [1,2,3,4,...]
// into the round-0 slot order that puts top seeds on opposite halves and
// only lets them meet in the final. For size 8 this yields [1,8,4,5,2,7,3,6]
// — match 0 is 1v8, match 1 is 4v5, etc. Works for any power-of-2 size.
function foldBracketSeeding(seeds) {
  const n = seeds.length;
  if (n <= 2) return seeds.slice();
  let order = [0, 1];
  while (order.length < n) {
    const sz = order.length * 2;
    const next = [];
    for (const i of order) {
      next.push(i);
      next.push(sz - 1 - i);
    }
    order = next;
  }
  return order.map(i => seeds[i]);
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
    // buildTopNBracketMatches sets bracketSize / preFinalRounds on the
    // state so the renderer can shape the bracket — push them too.
    if (typeof s.bracketSize === "number") updates["bracketSize"] = s.bracketSize;
    if (typeof s.preFinalRounds === "number") updates["preFinalRounds"] = s.preFinalRounds;
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

// Stricter check: a slot counts as "complete" only when every field its
// mode declares is present (non-empty). For standard mode that's blade
// + ratchet + bit, with the ratchet allowed to be the NO_RATCHET
// sentinel when the bit is a ratchet-bit (the bit then carries the
// ratchet portion). Bullet Griffon has a built-in ratchet so its
// ratchet field is OPTIONAL — a missing ratchet for a BG slot counts
// as complete, same as if NO_RATCHET were set explicitly. For CX /
// CX Expand modes every listed field must have a name. Used by the
// registrant-row "Incomplete" badge so a slot that only has a blade
// picked doesn't pass as "filled".
function isBeyCheckSlotComplete(slot) {
  if (!slot || !slot.parts) return false;
  const mode = (slot.mode && BEY_CHECK_MODES.includes(slot.mode)) ? slot.mode : "standard";
  const fields = BEY_CHECK_FIELDS[mode] || [];
  if (!fields.length) return false;
  const bladeName = (slot.parts.blade || "").trim();
  // expandCx blades (Bullet Griffon, Glory Valkyrie, …) have a built-in ratchet,
  // so their ratchet field is optional.
  const bladeRec = bladeName ? (DATA.blades || []).find(b => b.name === bladeName) : null;
  const bladeHasBuiltInRatchet = isExpandCxBlade(bladeRec);
  for (const f of fields) {
    const v = slot.parts[f];
    if (f === "ratchet") {
      // A built-in-ratchet blade makes the ratchet field optional — any value
      // (including missing) is fine.
      if (bladeHasBuiltInRatchet) continue;
      if (!v) return false; // missing entirely
      // empty string fails, NO_RATCHET sentinel passes, real name passes
      if (v !== NO_RATCHET && typeof v !== "string") return false;
      if (v !== NO_RATCHET && !v.length) return false;
    } else {
      if (typeof v !== "string" || !v) return false;
    }
  }
  return true;
}

function isBeyCheckDeckEmpty(deck) {
  return !Array.isArray(deck) || deck.every(isBeyCheckSlotEmpty);
}

// Registration requires all 3 slots built (the bey-check / format pages
// expect a 3-combo deck per registrant). Returns the 1-based index list
// of slots that still read empty so callers can name them in the error.
function emptyBeyCheckDeckSlotNumbers(deck) {
  if (!Array.isArray(deck)) return [1, 2, 3];
  const out = [];
  for (let i = 0; i < BEY_CHECK_DECK_SIZE; i++) {
    if (isBeyCheckSlotEmpty(deck[i])) out.push(i + 1);
  }
  return out;
}

// Stricter variant of the helper above — returns the 1-based slot
// numbers that aren't COMPLETE (missing one or more required parts for
// their mode). Catches the "blade only, no ratchet / bit" case the
// empty-check misses.
function incompleteBeyCheckDeckSlotNumbers(deck) {
  if (!Array.isArray(deck)) return [1, 2, 3];
  const out = [];
  for (let i = 0; i < BEY_CHECK_DECK_SIZE; i++) {
    if (!isBeyCheckSlotComplete(deck[i])) out.push(i + 1);
  }
  return out;
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

// Mirror of the inline completion check in renderSwiss. Works for every
// supported format: Swiss, Round Robin (a `pairing: "round-robin"`
// variant of Swiss / Swiss-only), and Single Elimination. The shared
// `state` shape means the same placement-match / group-stage logic
// applies across all three. Exposed on window so the Dashboard's Best
// Parts panel can snapshot parts usage at the moment a tournament
// finishes — and only then.
//   - mode === "swiss-only"      → group stage fully resolved
//   - mode === "single-elim"     → final (+ any present 3rd / 5th / 7th
//                                  place playoff) decided
//   - otherwise (swiss + top 8)  → all four placement matches decided
function isTournamentComplete(state) {
  if (!state) return false;
  const isSwissOnly = state.mode === "swiss-only";
  const isSingleElim = state.mode === "single-elim";
  const bracketActive = typeof hasSwissBracket === "function" ? hasSwissBracket(state) : !!state.bracket;
  if (isSwissOnly) {
    return typeof isGroupStageComplete === "function" ? isGroupStageComplete(state) : false;
  }
  if (!bracketActive) return false;
  const matches = state.matches || {};
  const decided = (m) => m && m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB;
  const placementIds = isSingleElim
    ? singleElimPlacementIds(matches)
    : ["bracket-f-0", "bracket-3rd-0", "bracket-5th-0", "bracket-7th-0"];
  return placementIds.every(id => decided(matches[id]));
}
window.isTournamentComplete = isTournamentComplete;

// Collect every placement-final match id present on a single-elim state.
// Covers the main bracket (Final + 3rd) and the optional consolation /
// loser-bracket finals, each built only when the depth reaches its place
// (5th≥5, 7th≥7 from cqf; 9th≥9, 11th≥11 from c16-sfw; 13th≥13, 15th≥15
// from c16-sfl). Filtering by presence keeps completion depth-agnostic.
const SINGLE_ELIM_PLACEMENT_FINAL_IDS = [
  "bracket-f-0", "bracket-3rd-0",
  "bracket-5th-0", "bracket-7th-0",
  "bracket-9th-0", "bracket-11th-0",
  "bracket-13th-0", "bracket-15th-0"
];
function singleElimPlacementIds(matches) {
  if (!matches) return ["bracket-f-0"];
  return SINGLE_ELIM_PLACEMENT_FINAL_IDS.filter(id => matches[id]);
}

// Write the Best Parts panel snapshot the Dashboard reads, using the
// finished tournament's parts usage. The storage key MUST match the
// one in dashboard.js (which already owns its own
// `const DASHBOARD_BEST_PARTS_KEY = "dashboard_best_parts_snapshot"`
// at script scope; declaring it again here would collide and throw a
// SyntaxError on every page that loads both files). Sort/slice mirrors
// dashboardBuildTopParts (top 3 per field, by raw count desc). Safe to
// call from any renderSwiss tick — only writes when there's at least
// one non-empty group.
function snapshotBestPartsForDashboard(state) {
  try {
    const usage = aggregatePartUsage(state);
    const fieldOrder = typeof BEY_CHECK_FIELD_ORDER !== "undefined"
      ? BEY_CHECK_FIELD_ORDER
      : ["lockChip", "blade", "mainBlade", "metalBlade", "overBlade", "assistBlade", "ratchet", "bit"];
    const groups = [];
    for (const field of fieldOrder) {
      const counts = usage[field];
      if (!counts) continue;
      const parts = Object.entries(counts)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
      if (parts.length) groups.push({ field, parts });
    }
    if (groups.length) localStorage.setItem("dashboard_best_parts_snapshot", JSON.stringify(groups));
  } catch (e) { /* non-fatal — Dashboard falls back to its prior snapshot */ }
}

function aggregatePartUsage(state) {
  const usage = {};
  const participants = getParticipants(state);
  for (const name of participants) {
    if (!name) continue;
    const deck = findLatestDeckForParticipant(state, name, null);
    if (!deck) continue;
    // A deck-less guest contributes nothing to the part-usage pie chart.
    if (isBeyCheckDeckEmpty(deck)) continue;
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
  // Metallic + revox themes — narrow hue bands tinted to each theme's accent.
  if (cls.contains("gold-mode"))     return { type: "hue", hueStart: 30,  hueRange: 50,  sat: 70, light: 55 };
  if (cls.contains("silver-mode"))   return { type: "hue", hueStart: 200, hueRange: 50,  sat: 20, light: 65 };
  if (cls.contains("bronze-mode"))   return { type: "hue", hueStart: 10,  hueRange: 40,  sat: 60, light: 50 };
  if (cls.contains("revox-mode"))    return { type: "hue", hueStart: 350, hueRange: 60,  sat: 70, light: 55 };
  // Achievement themes — narrow hue bands tinted to each theme's accent.
  if (cls.contains("dragontamer-mode"))    return { type: "hue", hueStart: 350, hueRange: 50,  sat: 65, light: 54 };
  if (cls.contains("dragonslayer-mode"))   return { type: "hue", hueStart: 205, hueRange: 70,  sat: 60, light: 58 };
  if (cls.contains("lonewolf-mode"))       return { type: "hue", hueStart: 200, hueRange: 50,  sat: 25, light: 62 };
  if (cls.contains("rushhour-mode"))       return { type: "hue", hueStart: 25,  hueRange: 55,  sat: 72, light: 55 };
  if (cls.contains("kingofjungle-mode"))   return { type: "hue", hueStart: 80,  hueRange: 70,  sat: 55, light: 48 };
  if (cls.contains("sharknado-mode"))      return { type: "hue", hueStart: 180, hueRange: 60,  sat: 60, light: 55 };
  if (cls.contains("sorcerersupreme-mode"))return { type: "hue", hueStart: 270, hueRange: 70,  sat: 62, light: 60 };
  if (cls.contains("paleonerd-mode"))      return { type: "hue", hueStart: 35,  hueRange: 55,  sat: 55, light: 52 };
  if (cls.contains("kingofalltypes-mode")) return { type: "hue", hueStart: 205, hueRange: 90,  sat: 60, light: 58 };
  // Default (Dark) theme — a blue-centered band matching the dark theme's accent
  // (cyan → blue → violet), still wide enough to tell slices apart.
  return                                    { type: "hue", hueStart: 190, hueRange: 140, sat: 62, light: 58 };
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
  // Metallic + revox — match each theme's deep card-bg tone so the stroke
  // reads as a separator rather than a bright outline against the slices.
  if (cls.contains("gold-mode"))     return "#3a2f12";
  if (cls.contains("silver-mode"))   return "#2e343c";
  if (cls.contains("bronze-mode"))   return "#3a2818";
  if (cls.contains("revox-mode"))    return "#2a1010";
  // Achievement themes — match each theme's deep card-bg tone.
  if (cls.contains("dragontamer-mode"))    return "#1a0d0d";
  if (cls.contains("dragonslayer-mode"))   return "#0e1320";
  if (cls.contains("lonewolf-mode"))       return "#0c1014";
  if (cls.contains("rushhour-mode"))       return "#1a1206";
  if (cls.contains("kingofjungle-mode"))   return "#1a1404";
  if (cls.contains("sharknado-mode"))      return "#081420";
  if (cls.contains("sorcerersupreme-mode"))return "#160a24";
  if (cls.contains("paleonerd-mode"))      return "#1a1208";
  if (cls.contains("kingofalltypes-mode")) return "#0e1320";
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

  // CX / CX Expand: render the lock chip + blade(s) + assist blade as one
  // combined thumbnail (matches the calculator / deck / history view).
  let combinedHtml = "";
  let usedKeys = new Set();
  if (typeof combinedBladeTileHTML === "function") {
    const resolvePart = (key, name) => ({
      src: beyCheckPartImg(key, name),
      codename: typeof partRecordCodename === "function"
        ? partRecordCodename(BEY_CHECK_FIELD_FOLDER[key], name, null)
        : (name || "")
    });
    const combined = combinedBladeTileHTML(parts, resolvePart);
    if (combined) {
      combinedHtml = combined.html;
      usedKeys = combined.usedKeys;
    }
  }

  const tilesHtml = BEY_CHECK_FIELDS[mode]
    .filter(f => parts[f] && parts[f] !== NO_RATCHET && !usedKeys.has(f))
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

  return combinedHtml + tilesHtml;
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

// Calculator-style combo builder for the bey check slot popup — no mode tabs.
// The user moves between lines (BX / CX / CX Expand) and toggles the two
// Combine modes through the dropdowns themselves, exactly like the Deck editor.
// A single host (#bey-check-slot-fields) is rebuilt on every state change.
const BEY_SLOT_FIELD_LABELS = {
  blade: "Blade", lockChip: "Lock Chip", mainBlade: "Main Blade",
  metalBlade: "Metal Blade", overBlade: "Over Blade", assistBlade: "Assist Blade",
  ratchet: "Ratchet", bit: "Bit"
};

// Line-switch sentinels (shared with the calculator) → destination bey-check mode.
const BEY_SLOT_LINE_SWITCH = {
  [SPLIT_BLADE]: "cx",        // Blade "Split …" and Metal Blade "Revert"
  [LINE_BX]: "standard",      // Lock Chip "Revert"
  [LINE_CXE]: "cxExpand",     // Main Blade "Split (Over + Metal)"
};

// Working state for the open slot (index strings / NO_RATCHET per field).
let beySlotMode = "standard";
let beySlotValues = {};
let beySlotBladeCombine = false;   // Combine (Blade + Ratchet): an expandCx blade

function beySlotLineSwitchChoice(key) {
  if (beySlotMode === "standard" && key === "blade")
    return { value: SPLIT_BLADE, label: "Split (Lock Chip + Main Blade + Assist Blade)" };
  if (beySlotMode === "cx" && key === "lockChip")
    return { value: LINE_BX, label: "Revert" };
  if (beySlotMode === "cx" && key === "mainBlade")
    return { value: LINE_CXE, label: "Split (Over Blade + Metal Blade)" };
  if (beySlotMode === "cxExpand" && key === "metalBlade")
    return { value: SPLIT_BLADE, label: "Revert" };
  return null;
}

function beySlotBitIsRatchetBit() {
  const v = beySlotValues.bit;
  if (v == null || v === "") return false;
  const bit = (DATA.bits || [])[Number(v)];
  return !!(bit && bit.isRatchetBit);
}

// Codename of the blade chosen in Standard mode (drives the Clock Mirage rule).
function beySlotStdBladeCodename() {
  if (beySlotMode !== "standard") return "";
  const v = beySlotValues.blade;
  const blade = (v != null && v !== "" && v !== NO_RATCHET) ? (DATA.blades || [])[Number(v)] : null;
  return blade ? (blade.codename || "") : "";
}

function beySlotPrepend(key, bladeCombine, ratchetCombine) {
  const list = [];
  const lineChoice = beySlotLineSwitchChoice(key);
  if (lineChoice && !(bladeCombine && key === "blade")) list.push(lineChoice);
  if (beySlotMode === "standard" && key === "blade")
    list.push({ value: COMBINE_BLADE_RATCHET, label: bladeCombine ? "Revert" : "Combine (Blade + Ratchet)" });
  if (key === "ratchet")
    list.push({ value: NO_RATCHET, label: "Combine (Ratchet + Bit)" });
  if (key === "bit" && ratchetCombine)
    list.push({ value: SPLIT_RATCHET_BIT, label: "Revert" });
  return list;
}

function openBeySlotDropdown(key) {
  const host = document.getElementById("bey-check-slot-fields");
  const wrapper = host && host.querySelector(`select[data-field="${key}"]`)?.nextElementSibling;
  if (!wrapper || !wrapper._open) return;
  requestAnimationFrame(() => { wrapper.querySelector("input")?.focus(); wrapper._open(); });
}

function captureBeySlotValues() {
  document.querySelectorAll("#bey-check-slot-fields select[data-field]").forEach(sel => {
    beySlotValues[sel.dataset.field] = sel.value;
  });
}

function renderBeySlotFields() {
  const host = document.getElementById("bey-check-slot-fields");
  if (!host) return;
  const fields = BEY_CHECK_FIELDS[beySlotMode] || BEY_CHECK_FIELDS.standard;
  host.innerHTML = fields.map(key =>
    `<div class="deck-edit-field-group" data-field-group="${key}">
      <label class="deck-edit-field">
        <span class="deck-edit-field-label">${BEY_SLOT_FIELD_LABELS[key] || key}</span>
        <select data-field="${key}"></select>
      </label>
    </div>`
  ).join("");

  // Combine state (mirrors the calculator): the blade may carry its ratchet
  // (expandCx), or the ratchet may fold into a ratchet-bit. Both hide the
  // Ratchet row and drive different Blade / Bit list filters.
  const bladeCombine = beySlotMode === "standard" && beySlotBladeCombine;
  const ratchetCombine = beySlotValues.ratchet === NO_RATCHET && !bladeCombine;

  fields.forEach(key => {
    const sel = host.querySelector(`select[data-field="${key}"]`);
    if (!sel) return;
    const list = getBeyCheckPartList(key);
    const prepend = beySlotPrepend(key, bladeCombine, ratchetCombine);
    const folder = BEY_CHECK_DATA_BY_FIELD[key] || null;
    makeSearchable(sel, list, p => p.name, prepend, folder);
    const wrapper = sel.nextElementSibling;

    // List filters that mirror the calculator: expandCx blades only in
    // blade-combine (else hidden), Clock Mirage forces "…5" ratchets, and
    // ratchet-bits only while ratchet-combine is on (else regular bits).
    if (wrapper) {
      if (key === "blade") wrapper._filterFn = bladeCombine ? isExpandCxBlade : (b => !isExpandCxBlade(b));
      else if (key === "ratchet") wrapper._filterFn = beySlotStdBladeCodename() === "CLOCKMIRAGE" ? (r => r.name.endsWith("5")) : null;
      else if (key === "bit") wrapper._filterFn = ratchetCombine ? (b => !!b.isRatchetBit) : (b => !b.isRatchetBit);
    }

    const cur = beySlotValues[key];
    if (wrapper && wrapper._select) {
      if (cur === NO_RATCHET) wrapper._select(NO_RATCHET);
      else if (cur != null && cur !== "" && list[Number(cur)]) wrapper._select(Number(cur));
    }

    if (key === "ratchet") {
      const group = host.querySelector('[data-field-group="ratchet"]');
      if (group) group.hidden = beySlotValues.ratchet === NO_RATCHET;
    }

    sel.addEventListener("change", () => {
      const v = sel.value;

      // Line switch → another line, carrying the still-relevant selections.
      const nextMode = BEY_SLOT_LINE_SWITCH[v];
      if (nextMode) {
        captureBeySlotValues();
        delete beySlotValues[key];
        beySlotBladeCombine = false;   // blade-combine is Standard-only
        beySlotMode = nextMode;
        renderBeySlotFields();
        return;
      }

      // Combine (Blade + Ratchet): toggle expandCx mode.
      if (v === COMBINE_BLADE_RATCHET) {
        captureBeySlotValues();
        beySlotBladeCombine = !beySlotBladeCombine;
        delete beySlotValues.blade;
        if (beySlotBladeCombine) {
          beySlotValues.ratchet = NO_RATCHET;
          if (beySlotBitIsRatchetBit()) delete beySlotValues.bit;
        } else {
          delete beySlotValues.ratchet;
        }
        renderBeySlotFields();
        openBeySlotDropdown("blade");
        return;
      }

      // Combine (Ratchet + Bit): fold the ratchet into a ratchet-bit.
      if (key === "ratchet" && v === NO_RATCHET) {
        captureBeySlotValues();
        beySlotValues.ratchet = NO_RATCHET;
        if (!beySlotBitIsRatchetBit()) delete beySlotValues.bit;
        renderBeySlotFields();
        openBeySlotDropdown("bit");
        return;
      }

      // "Revert" in the Bit dropdown undoes ratchet-bit combine.
      if (key === "bit" && v === SPLIT_RATCHET_BIT) {
        captureBeySlotValues();
        delete beySlotValues.bit;
        delete beySlotValues.ratchet;
        renderBeySlotFields();
        openBeySlotDropdown("ratchet");
        return;
      }

      beySlotValues[key] = v;
      // A new Standard blade changes the expandCx / Clock Mirage rules, so
      // re-render to refresh the ratchet/bit filters and flow into the ratchet.
      if (beySlotMode === "standard" && key === "blade") {
        renderBeySlotFields();
        openBeySlotDropdown("ratchet");
      }
    });
  });
}

// Seed the working state from a saved slot ({ mode, parts:{ field: name } }).
function loadBeySlotFromSlot(slot) {
  beySlotMode = BEY_CHECK_MODES.includes(slot && slot.mode) ? slot.mode : "standard";
  const parts = (slot && slot.parts) || {};
  beySlotValues = {};
  Object.keys(BEY_CHECK_DATA_BY_FIELD).forEach(key => {
    const name = parts[key];
    if (!name || name === NO_RATCHET) return;
    const list = getBeyCheckPartList(key);
    const i = list.findIndex(p => p.name === name);
    if (i >= 0) beySlotValues[key] = String(i);
  });

  // An expandCx blade carries its own ratchet, so open in blade-combine mode.
  beySlotBladeCombine = false;
  if (beySlotMode === "standard") {
    const v = beySlotValues.blade;
    const blade = (v != null && v !== "") ? (DATA.blades || [])[Number(v)] : null;
    if (blade && isExpandCxBlade(blade)) beySlotBladeCombine = true;
  }

  // The Ratchet folds away ONLY when the combo actually says so — an explicit
  // NO_RATCHET, an expandCx blade, or a ratchet-bit bit. A fresh/empty slot (or
  // any combo with a real ratchet) keeps the Ratchet field visible.
  if (parts.ratchet === NO_RATCHET || beySlotBladeCombine || beySlotBitIsRatchetBit()) {
    beySlotValues.ratchet = NO_RATCHET;
  }
}

// Read the working state back into a slot. Mirrors the old readBeyCheckForm
// output (ratchet stored as NO_RATCHET when combined).
function readBeySlot() {
  const parts = {};
  (BEY_CHECK_FIELDS[beySlotMode] || []).forEach(key => {
    const v = beySlotValues[key];
    if (v == null || v === "") return;
    if (v === NO_RATCHET) { parts[key] = NO_RATCHET; return; }
    const item = getBeyCheckPartList(key)[Number(v)];
    if (item) parts[key] = item.name;
  });
  return { mode: beySlotMode, parts };
}

// Combo-builder sub-popup. Opens on top of the bey check popup; on Save it
// hands the working draft back to the caller via onSave(slot). Edits stay
// local to the draft until Save — Cancel discards. `deck` is the full 3-slot
// deck for the active side, used to detect duplicate parts at save time.
function showBeyCheckSlotPopup(slotIdx, slot, deck, onSave) {
  const popup = document.getElementById("bey-check-slot-popup");
  if (!popup) return;
  const subtitle = popup.querySelector("#bey-check-slot-subtitle");
  const statusEl = popup.querySelector("#bey-check-slot-status");
  const saveBtn = popup.querySelector("#bey-check-slot-save");
  const clearBtn = popup.querySelector("#bey-check-slot-clear");
  const cancelBtn = popup.querySelector("#bey-check-slot-cancel");

  if (subtitle) subtitle.textContent = `Slot ${slotIdx + 1}`;
  if (statusEl) statusEl.textContent = "";

  loadBeySlotFromSlot(slot);
  renderBeySlotFields();

  popup.classList.remove("hidden");

  const close = () => {
    popup.classList.add("hidden");
    saveBtn.onclick = null;
    clearBtn.onclick = null;
    cancelBtn.onclick = null;
  };

  cancelBtn.onclick = close;
  saveBtn.onclick = () => {
    const next = readBeySlot();
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
    onSave({ mode: beySlotMode, parts: {} });
    close();
  };
}

function showBeyCheckPopup(matchId) {
  const popup = document.getElementById("bey-check-popup");
  if (!popup) return;
  if (swissEditCode && !swissCanEdit) { notifyCoHostEditBlocked(); return; } // viewers don't get bey check

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
    // Soft banned-parts warning — the judge can still record the deck. The
    // ban list is read live from local state (kept fresh by the listener),
    // so updates made mid-tournament are picked up if any.
    const banned = findBannedPartsInDeck(deck, getBannedParts(loadSwiss()));
    const banner = banned.length
      ? `<div class="bey-check-banned" role="alert" style="margin:0 0 8px; padding:8px 10px; border:1px solid #f85149; border-radius:6px; background:rgba(248,81,73,0.12); color:#ff7b72; font-size:0.85rem;"><strong>Banned parts in this deck:</strong> ${
          banned.map(h => `${escapeHtml(h.name)} (Slot ${h.slot})`).join(", ")
        }. You can still record, but the host marked these as not allowed.</div>`
      : "";
    slotsHost.innerHTML = banner + deck.map((s, i) => renderBeyCheckSlot(i, s)).join("");
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
function addSwissParticipantRound1(name, deck, opts) {
  opts = opts || {};
  const s = loadSwiss();
  if (!Array.isArray(s.groups) || !s.groups.length) return false;
  if (!canAddParticipant(s)) {
    if (!opts.silent) alert("Participants can only be added during round 1 — round 2 has already started.");
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
  // Stamp the host/co-host's UID onto the entry — this path only fires
  // during a running tournament where the registrants rule already
  // requires host/co-host, but recording createdBy keeps the data
  // consistent with how submitRegistration writes new entries.
  const writerUid = (window.getCurrentUser && window.getCurrentUser()?.uid) || null;
  const entry = { name, deck };
  if (writerUid) entry.createdBy = writerUid;
  if (opts.isGuest) entry.isGuest = true;
  s.registrants[regId] = entry;
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    // Targeted update — only the touched group, match, participant list and
    // the new registrant. Nothing else in the room is rewritten.
    updates[`groups/${target}`] = s.groups[target];
    updates[`registrants/${regId}`] = entry;
    if (Array.isArray(s.participants)) updates.participants = s.participants;
    swissRoomRef.update(updates).catch(e => console.warn("Add participant push failed:", e));
  }
  return true;
}

// Remove a participant from a running tournament — same gate as add
// (canAddParticipant — only allowed before round 2 starts). Both formats
// regenerate from scratch with the named player dropped: simplest and
// avoids fragile per-format match-unwinding logic. The host is warned
// that current round-1 matches and scores will be lost.
function showRemoveParticipantsPopup() {
  if (!swissCanEdit) return;
  const state = loadSwiss();
  if (!canAddParticipant(state)) {
    alert("Participants can only be removed during round 1 — round 2 has already started.");
    return;
  }
  const current = getParticipants(state);
  if (!current.length) {
    alert("No participants to remove.");
    return;
  }

  document.getElementById("remove-participants-popup")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "remove-participants-popup";
  overlay.className = "popup-overlay";
  const rowsHtml = current.map((name, i) => `
    <li class="remove-participant-row">
      <span class="remove-participant-name">${i + 1}. ${escapeHtml(name)}</span>
      <button type="button" class="swiss-reg-remove remove-participant-btn" data-name="${escapeHtml(name)}" title="Remove ${escapeHtml(name)}" aria-label="Remove ${escapeHtml(name)}">&times;</button>
    </li>
  `).join("");
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Remove Participant</h2>
      <p class="popup-text" style="text-align: justify;">Tap × next to a name to remove that player. The bracket (or groups) regenerates from scratch, so any current round-1 matches and scores will be lost. You'll confirm before that happens.</p>
      <ul class="remove-participant-list">${rowsHtml}</ul>
      <div id="remove-participants-status" class="swiss-join-status"></div>
      <div class="popup-actions">
        <button type="button" id="remove-participants-close" class="btn popup-cancel">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const status = overlay.querySelector("#remove-participants-status");
  const closeBtn = overlay.querySelector("#remove-participants-close");
  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey);
  closeBtn.onclick = close;

  overlay.querySelectorAll(".remove-participant-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.name;
      if (!name) return;
      if (!confirm(`Remove ${name}? The bracket will regenerate and any current round-1 matches will be lost.`)) return;
      const ok = removeRunningParticipantByRegen(name);
      if (!ok) {
        setStatus(`Couldn't remove ${name}. Try again.`, "err");
        return;
      }
      setStatus(`Removed ${name} ✓`, "ok");
      // Re-render the room view (it has fewer rows now) — and close after
      // a short pause so the host can read the confirmation.
      renderSwiss();
      setTimeout(close, 600);
    });
  });
}

// A→B, C→… group labels, matching what the group headers render.
function swissGroupLetter(gi) { return String.fromCharCode(65 + gi); }

// Move one player from their current group into another, then re-draw the
// round-1 pairings of BOTH affected groups (membership everywhere else is
// untouched). Same gate as reshuffle: group formats, round 1, no scores yet.
function moveParticipantBetweenGroups(name, fromGi, toGi) {
  const s = loadSwiss();
  if (!s || !canReshuffleTournament(s)) return false;
  const groups = s.groups || [];
  if (fromGi === toGi || !groups[fromGi] || !groups[toGi]) return false;
  const idx = groups[fromGi].findIndex(n => (n || "").toLowerCase() === (name || "").toLowerCase());
  if (idx === -1) return false;
  if (groups[fromGi].length <= 1) {
    alert("Can't move the last player out of a group — it would leave an empty group.");
    return false;
  }
  groups[fromGi].splice(idx, 1);
  groups[toGi].push(name);
  // Rebuild round 1 for just the two touched groups.
  [fromGi, toGi].forEach(gi => {
    Object.keys(s.matches || {}).forEach(id => {
      if (s.matches[id] && s.matches[id].groupIndex === gi) delete s.matches[id];
    });
    s.groupRounds[gi] = 0;
    appendGroupRound(s, gi);
  });
  persistSwiss(s);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    const payload = { ...s };
    if (swissViewCode) payload.viewCode = swissViewCode;
    swissRoomRef.set(payload).catch(e => console.warn("Move participant push failed:", e));
  }
  return true;
}

// Host popup: pick a player and tap a target group letter to move them.
function showMoveParticipantsPopup() {
  if (!swissCanEdit) return;
  let state = loadSwiss();
  if (!canReshuffleTournament(state) || !(state.groups && state.groups.length > 1)) {
    alert("Players can only be moved between groups during round 1, before any scores are entered.");
    return;
  }

  document.getElementById("move-participants-popup")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "move-participants-popup";
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Move Participant</h2>
      <p class="popup-text" style="text-align: justify;">Tap a group letter next to a player to move them there. The round-1 pairings of both affected groups are re-drawn. Only available before any scores are entered.</p>
      <div id="move-participants-body" class="move-body"></div>
      <div id="move-participants-status" class="swiss-join-status"></div>
      <div class="popup-actions">
        <button type="button" id="move-participants-close" class="btn popup-cancel">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const body = overlay.querySelector("#move-participants-body");
  const status = overlay.querySelector("#move-participants-status");
  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err");
    if (kind) status.classList.add(`is-${kind}`);
  };
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
  document.addEventListener("keydown", onKey);
  overlay.querySelector("#move-participants-close").onclick = close;

  const paint = () => {
    state = loadSwiss();
    if (!canReshuffleTournament(state)) {
      body.innerHTML = `<p class="popup-text">Moving is no longer available — the tournament has advanced.</p>`;
      return;
    }
    const groups = state.groups || [];
    body.innerHTML = groups.map((members, gi) => `
      <div class="move-group">
        <div class="move-group-title">Group ${swissGroupLetter(gi)}</div>
        ${(members || []).map(name => `
          <div class="move-row">
            <span class="move-name">${escapeHtml(name)}</span>
            <span class="move-targets">
              ${groups.map((_, tgi) => tgi === gi ? "" :
                `<button type="button" class="move-to-btn" data-name="${escapeHtml(name)}" data-from="${gi}" data-to="${tgi}" title="Move ${escapeHtml(name)} to Group ${swissGroupLetter(tgi)}">${swissGroupLetter(tgi)}</button>`).join("")}
            </span>
          </div>`).join("")}
      </div>`).join("");
    body.querySelectorAll(".move-to-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.name;
        const from = Number(btn.dataset.from);
        const to = Number(btn.dataset.to);
        if (!moveParticipantBetweenGroups(name, from, to)) { setStatus(`Couldn't move ${name}.`, "err"); return; }
        setStatus(`Moved ${name} to Group ${swissGroupLetter(to)} ✓`, "ok");
        renderSwiss();
        paint();
      });
    });
  };
  paint();
}

// Drop `name` from a running tournament and regenerate the format from the
// remaining participants. Carries registrants forward (minus the removed
// entries — matched by name). Returns true on success.
function removeRunningParticipantByRegen(name) {
  const state = loadSwiss();
  if (!canAddParticipant(state)) return false;
  const current = getParticipants(state);
  const remaining = current.filter(n => (n || "").toLowerCase() !== name.toLowerCase());
  if (remaining.length === current.length) return false; // not found
  if (remaining.length === 0) {
    alert("Can't remove the last participant — reset the tournament from the toolbar instead.");
    return false;
  }
  let next;
  if (state.mode === "single-elim") {
    next = generateSingleElimFromText(remaining.join("\n"), state.tournamentName, state.placementDepth);
  } else {
    next = generateSwissFromText(remaining.join("\n"), state.tournamentName,
      getRoundCount(state), getGroupCount(state), state.pairing);
    if (next && state.mode === "swiss-only") next.mode = "swiss-only";
  }
  if (!next) return false; // generator already alerted
  if (typeof state.ranked === "boolean") next.ranked = state.ranked;
  next.hostUid = state.hostUid || null;
  // Carry registrants forward minus any entries that match the removed name
  // (case-insensitive). Multiple registrants can share a name in odd edge
  // cases — drop them all so the regenerated list stays consistent.
  const droppedKey = name.toLowerCase();
  next.registrants = {};
  Object.entries(state.registrants || {}).forEach(([id, r]) => {
    if (r && typeof r.name === "string" && r.name.toLowerCase() === droppedKey) return;
    next.registrants[id] = r;
  });
  persistSwiss(next);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    const payload = { ...next };
    if (swissViewCode) payload.viewCode = swissViewCode;
    swissRoomRef.set(payload).catch(e => console.warn("Remove participant push failed:", e));
  }
  return true;
}

// True while a group-stage tournament can still be re-drawn: it's a group
// format (not single-elim / not into the knockout bracket), every group is
// only on round 1, and no scores have been entered yet.
function canReshuffleTournament(state) {
  if (!state || state.mode === "single-elim") return false;
  if (state.bracket) return false; // knockout already started
  const gr = state.groupRounds || [];
  const onRound1 = gr.length > 0 && gr.every(r => (r || 0) <= 1);
  if (!onRound1) return false;
  const scored = Object.values(state.matches || {}).some(
    m => m && !m.bracket && !m.bye && (m.scoreA != null || m.scoreB != null));
  return !scored;
}

// Re-draw the round-1 groups and pairings from the same participants so the
// host can get a different random arrangement. Preserves every bit of
// tournament metadata (registrants, mode, ranked, codes, banned parts, event
// details, co-hosts) — only the draw changes.
function reshuffleTournament() {
  const state = loadSwiss();
  if (!state || !canReshuffleTournament(state)) return;
  const participants = getParticipants(state);
  if (participants.length < 2) return;
  if (!confirm("Reshuffle the draw? The groups and Round 1 pairings are re-randomised from the same players — the current pairings are replaced.")) return;
  const regenerated = generateSwissFromText(
    participants.join("\n"), state.tournamentName,
    getRoundCount(state), getGroupCount(state), state.pairing);
  if (!regenerated) return; // generator alerts on its own if it can't
  const next = {
    ...state,
    groups: regenerated.groups,
    groupRounds: regenerated.groupRounds,
    matches: regenerated.matches,
    participants: regenerated.participants,
    mode: state.mode // regen forces "swiss"; keep swiss-only / round-robin intact
  };
  persistSwiss(next);
  if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
    const payload = { ...next };
    if (swissViewCode) payload.viewCode = swissViewCode;
    swissRoomRef.set(payload).catch(e => console.warn("Reshuffle push failed:", e));
  }
  renderSwiss();
}

// Bulk-add participants to a running tournament — names only, one per line.
// Each entry is created as a deckless guest (isGuest:true, empty deck) so the
// host can paste a name list in one shot; the judge fills in decks at match
// time. Mirrors the registering-phase Bulk Guests popup, but routed through
// the mid-tournament code paths:
//   - Swiss / Round Robin in round 1: addSwissParticipantRound1 per name
//     (each newcomer gets a free-win bye or pairs against an existing bye).
//   - Single Elim, or Swiss/RR past round 1: the bracket can't slot anyone
//     in, so we regenerate from scratch with the combined name list after a
//     single confirm.
function showBulkAddParticipantsPopup() {
  if (!swissCanEdit) return;
  const state = loadSwiss();
  if (!canAddParticipant(state)) {
    alert("Participants can only be added during round 1 — round 2 has already started.");
    return;
  }

  // Re-open: drop any stale instance first.
  document.getElementById("bulk-add-participants-popup")?.remove();

  const hasGroups = Array.isArray(state.groups) && state.groups.length;
  const canSlotIn = state.mode !== "single-elim" && hasGroups;
  const blurb = canSlotIn
    ? "Enter one name per line. Each player slots into round 1 as a free win (or pairs against an existing bye) — no reset, no decks required. The judge fills in decks at match time."
    : "Enter one name per line. Single-elimination brackets can't take new players mid-tournament, so the bracket regenerates from scratch — current matches and scores will be lost. You'll confirm before that happens.";

  const overlay = document.createElement("div");
  overlay.id = "bulk-add-participants-popup";
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Add Participants</h2>
      <p class="popup-text" style="text-align: justify;">${blurb}</p>
      <textarea id="bulk-add-input" class="account-bio" rows="8" placeholder="Alice
Bob
Charlie" style="width:100%; min-height:140px; resize:vertical;"></textarea>
      <p class="popup-text" style="font-size:0.78rem; margin-top:6px; text-align: justify;">Duplicate names (matching existing participants or each other) are skipped.</p>
      <div id="bulk-add-status" class="swiss-join-status"></div>
      <div class="popup-actions">
        <button type="button" id="bulk-add-submit" class="btn">Add</button>
        <button type="button" id="bulk-add-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const textarea = overlay.querySelector("#bulk-add-input");
  const status = overlay.querySelector("#bulk-add-status");
  const submitBtn = overlay.querySelector("#bulk-add-submit");
  const cancelBtn = overlay.querySelector("#bulk-add-cancel");

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  };
  document.addEventListener("keydown", onKey);
  cancelBtn.onclick = close;
  setTimeout(() => textarea?.focus(), 0);

  submitBtn.onclick = () => {
    const seen = new Set();
    const names = (textarea.value || "")
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .filter(s => {
        const k = s.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (names.length === 0) {
      setStatus("Enter at least one name (one per line).", "err");
      return;
    }
    const tooLong = names.find(n => n.length > 60);
    if (tooLong) {
      setStatus(`"${tooLong.slice(0, 40)}" is over 60 characters.`, "err");
      return;
    }
    // Filter out names already in the tournament.
    const current = getParticipants(loadSwiss());
    const existing = new Set(current.map(n => (n || "").toLowerCase()));
    const dupes = [];
    const toAdd = [];
    for (const n of names) {
      if (existing.has(n.toLowerCase())) { dupes.push(n); continue; }
      toAdd.push(n);
    }
    if (toAdd.length === 0) {
      setStatus("All those names are already in the tournament.", "err");
      return;
    }

    submitBtn.disabled = true;
    if (canSlotIn) {
      // Loop the round-1 slot helper per name. Each call writes its own
      // targeted Firebase update (group + match + registrant), so all the
      // entries land separately — fine for low-N batches.
      let added = 0;
      for (const n of toAdd) {
        if (addSwissParticipantRound1(n, emptyBeyCheckDeck(), { isGuest: true, silent: true })) added++;
      }
      renderSwiss();
      const dupeTxt = dupes.length ? ` (skipped ${dupes.length} duplicate${dupes.length === 1 ? "" : "s"})` : "";
      setStatus(`Added ${added} participant${added === 1 ? "" : "s"} ✓${dupeTxt}`, "ok");
      setTimeout(close, 700);
      return;
    }

    // Single-elim (or RR with no groups) → regen from scratch with the
    // combined name list. ONE confirm covers the whole batch.
    const combined = current.concat(toAdd);
    const isRR = state.pairing === "round-robin";
    const reason = isRR
      ? "a round robin re-pairs everyone against everyone, so it"
      : "a single-elimination bracket can't take new players mid-tournament, so it";
    const msg = `Adding ${toAdd.length} player${toAdd.length === 1 ? "" : "s"} brings the tournament to ${combined.length} participants. ` +
                `Because ${reason} will be regenerated — all current matches and scores will be lost. Continue?`;
    if (!confirm(msg)) { submitBtn.disabled = false; return; }

    const namesText = combined.join("\n");
    let next;
    if (state.mode === "single-elim") {
      next = generateSingleElimFromText(namesText, state.tournamentName, state.placementDepth);
    } else {
      next = generateSwissFromText(namesText, state.tournamentName,
        getRoundCount(state), getGroupCount(state), state.pairing);
      if (next && state.mode === "swiss-only") next.mode = "swiss-only";
    }
    if (!next) { submitBtn.disabled = false; return; } // generator already alerted
    if (typeof state.ranked === "boolean") next.ranked = state.ranked;
    next.hostUid = state.hostUid || null;
    // Carry registrants forward so existing players keep their registered
    // decks, then add a deckless isGuest entry for each new name.
    next.registrants = { ...(state.registrants || {}) };
    const writerUid = (window.getCurrentUser && window.getCurrentUser()?.uid) || null;
    for (const n of toAdd) {
      const id = generateRegistrantId();
      const entry = { name: n, deck: emptyBeyCheckDeck(), isGuest: true };
      if (writerUid) entry.createdBy = writerUid;
      next.registrants[id] = entry;
    }
    persistSwiss(next);
    if (swissRoomRef && swissCanEdit && !swissApplyingRemote) {
      const payload = { ...next };
      if (swissViewCode) payload.viewCode = swissViewCode;
      swissRoomRef.set(payload).catch(e => console.warn("Bulk add participants push failed:", e));
    }
    renderSwiss();
    const dupeTxt = dupes.length ? ` (skipped ${dupes.length} duplicate${dupes.length === 1 ? "" : "s"})` : "";
    setStatus(`Added ${toAdd.length} participant${toAdd.length === 1 ? "" : "s"} ✓${dupeTxt}`, "ok");
    setTimeout(close, 700);
  };
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
    const missingSlots = emptyBeyCheckDeckSlotNumbers(deck);
    if (missingSlots.length) {
      // Hard block — every participant needs all 3 slots built (same
      // rule as the registration popup). Empty / partial decks break
      // bey-check at match time.
      const slotList = missingSlots.length === 1
        ? `Slot ${missingSlots[0]}`
        : missingSlots.length === BEY_CHECK_DECK_SIZE
          ? "all 3 slots"
          : "Slots " + missingSlots.join(" & ");
      setStatus(`"${name}" needs a full 3-combo deck — fill ${slotList} before adding.`, "err");
      return;
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
      next = generateSingleElimFromText(names.join("\n"), state.tournamentName, state.placementDepth);
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

function showSwissGroupsPopup(onPick, isRoundRobin) {
  const popup = document.getElementById("swiss-groups-popup");
  if (!popup) { onPick(SWISS_GROUP_COUNT_DEFAULT); return; }
  // The popup is shared by the Swiss and Round Robin setup flows — word the
  // description for whichever format opened it.
  const subtitle = popup.querySelector(".popup-subtitle");
  if (subtitle) {
    subtitle.textContent = (isRoundRobin
      ? "Split participants into how many Round Robin groups? "
      : "Split participants into how many Swiss groups? ")
      + "Top finishers from each group feed the Top-8 bracket.";
  }
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
// a knockout bracket at all. Resolves the callback with the corresponding
// mode key ("swiss" = with knockout, "swiss-only" = group stage only). The
// caller follows up with showTopNPickerPopup to pick the bracket size when
// the user picks "yes".
// After the user chooses "yes, add a knockout", pick the bracket size N. Any
// integer >= 2 is allowed — power-of-2 sizes (4, 8, 16) run a clean bracket,
// non-power-of-2 (10, 12, …) pad with byes via the same engine single-elim
// uses. Dynamically built so it works on every per-tab index.html without
// adding new HTML.
const TOPN_PRESETS = [2, 4, 8, 16, 32];
function showTopNPickerPopup(onPick, defaultN) {
  defaultN = Number.isFinite(defaultN) && defaultN >= 2 ? defaultN : 8;
  document.getElementById("topn-picker-popup")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "topn-picker-popup";
  overlay.className = "popup-overlay";
  const presetBtns = TOPN_PRESETS.map(n =>
    `<button type="button" class="btn topn-preset" data-n="${n}">Top ${n}</button>`
  ).join("");
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Knockout Bracket Size</h2>
      <p class="popup-text">How many players advance from the group stage into the knockout?</p>
      <div class="popup-actions" style="flex-wrap:wrap; gap:6px; margin-bottom:8px;">${presetBtns}</div>
      <label class="popup-text" style="display:block; margin-top:6px;">Or pick a custom size (2–64):</label>
      <input type="number" id="topn-custom" class="account-bio" min="2" max="64" step="1" value="${defaultN}" style="width:100%; padding:8px 10px;">
      <div class="popup-actions">
        <button type="button" id="topn-confirm" class="btn">Confirm</button>
        <button type="button" id="topn-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#topn-custom");
  const close = () => overlay.remove();
  const finish = (n) => {
    close();
    document.removeEventListener("keydown", onKey);
    onPick(n);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(null); }
    else if (e.key === "Enter" && document.activeElement === input) {
      e.preventDefault();
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v) && v >= 2 && v <= 64) finish(v);
    }
  };
  document.addEventListener("keydown", onKey);

  overlay.querySelectorAll(".topn-preset").forEach(btn => {
    btn.onclick = () => finish(Number(btn.dataset.n));
  });
  overlay.querySelector("#topn-confirm").onclick = () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < 2 || v > 64) {
      alert("Pick a number between 2 and 64.");
      return;
    }
    finish(v);
  };
  overlay.querySelector("#topn-cancel").onclick = () => finish(null);
  setTimeout(() => input?.focus(), 0);
}

// After the host picks Single Elimination, ask how deep to rank the
// finishers — any number ≥ 2 (no upper limit on the input). Same shape as
// the Knockout Bracket Size picker: quick presets plus a free-form custom
// field. The depth is clamped down to whatever the bracket can host inside
// generateSingleElimFromText — the loser bracket only hangs off R16, so the
// engine ranks at most 16 places; bigger requests just rank as deep as the
// structure allows (and a Top 16 pick on an 8-player field ranks Top 8).
// The bracket builds matches in pairs, so an odd depth also reveals the
// next even place. Dynamically built so no new HTML is required on the
// per-tab index.html files.
const SE_DEPTH_PRESETS = [4, 8, 12, 16];
function showSingleElimDepthPopup(onPick, defaultDepth) {
  document.getElementById("se-depth-popup")?.remove();
  const def = clampPlacementDepth(defaultDepth);
  const overlay = document.createElement("div");
  overlay.id = "se-depth-popup";
  overlay.className = "popup-overlay";
  const presetBtns = SE_DEPTH_PRESETS.map(n =>
    `<button type="button" class="btn topn-preset se-depth-option" data-depth="${n}">Top ${n}</button>`
  ).join("");
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Placement Depth</h2>
      <p class="popup-text">How many finishers should the tournament rank?</p>
      <div class="popup-actions" style="flex-wrap:wrap; gap:6px; margin-bottom:8px;">${presetBtns}</div>
      <label class="popup-text" style="display:block; margin-top:6px;">Or pick a custom depth (2 or more):</label>
      <input type="number" id="se-depth-custom" class="account-bio" min="2" step="1" value="${def}" style="width:100%; padding:8px 10px;">
      <p class="popup-text" style="opacity:.7; font-size:.85em; margin-top:4px;">The bracket ranks as deep as it can — currently up to 16th place.</p>
      <div class="popup-actions">
        <button type="button" id="se-depth-confirm" class="btn">Confirm</button>
        <button type="button" id="se-depth-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#se-depth-custom");
  const valid = v => Number.isFinite(v) && v >= SE_DEPTH_MIN;
  const finish = (n) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    onPick(n);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(null); }
    else if (e.key === "Enter" && document.activeElement === input) {
      e.preventDefault();
      const v = parseInt(input.value, 10);
      if (valid(v)) finish(v);
    }
  };
  document.addEventListener("keydown", onKey);

  overlay.querySelectorAll(".se-depth-option").forEach(btn => {
    btn.onclick = () => finish(Number(btn.dataset.depth));
  });
  overlay.querySelector("#se-depth-confirm").onclick = () => {
    const v = parseInt(input.value, 10);
    if (!valid(v)) { alert("Pick a number of 2 or more."); return; }
    finish(v);
  };
  overlay.querySelector("#se-depth-cancel").onclick = () => finish(null);
  setTimeout(() => input?.focus(), 0);
}

// Set or clear the participant cap. `minAllowed` is the floor — at least the
// registration minimum and never below who's already registered. onPick gets
// a positive number to set the cap, 0 to remove it, or null on cancel.
function showParticipantCapPopup(onPick, currentCap, minAllowed) {
  document.getElementById("participant-cap-popup")?.remove();
  const floor = Math.max(2, Math.floor(minAllowed || 2));
  const def = (typeof currentCap === "number" && currentCap >= floor) ? currentCap : floor;
  const overlay = document.createElement("div");
  overlay.id = "participant-cap-popup";
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Participant Limit</h2>
      <p class="popup-text">Cap how many players can register. Turn it off for unlimited.</p>
      <label class="popup-text" style="display:block; margin-top:6px;">Maximum participants (${floor} or more):</label>
      <div class="participant-cap-stepper">
        <button type="button" id="participant-cap-minus" class="participant-cap-step" aria-label="Decrease limit">&minus;</button>
        <input type="number" id="participant-cap-input" class="account-bio" min="${floor}" step="1" value="${def}">
        <button type="button" id="participant-cap-plus" class="participant-cap-step" aria-label="Increase limit">+</button>
      </div>
      <p class="popup-text" style="opacity:.7; font-size:.85em; margin-top:4px;">Can't be below ${floor} — the number needed to run, or already registered.</p>
      <div class="popup-actions">
        <button type="button" id="participant-cap-confirm" class="btn">Set limit</button>
        <button type="button" id="participant-cap-none" class="btn popup-cancel">No limit</button>
      </div>
      <div class="popup-actions">
        <button type="button" id="participant-cap-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("#participant-cap-input");
  // −/+ steppers nudge the value, clamped to the floor (no upper bound).
  const nudge = (delta) => {
    const cur = parseInt(input.value, 10);
    const base = Number.isFinite(cur) ? cur : floor;
    input.value = String(Math.max(floor, base + delta));
    input.focus();
  };
  overlay.querySelector("#participant-cap-minus").onclick = () => nudge(-1);
  overlay.querySelector("#participant-cap-plus").onclick = () => nudge(1);
  const finish = (n) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    onPick(n);
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); finish(null); }
    else if (e.key === "Enter" && document.activeElement === input) {
      e.preventDefault();
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v) && v >= floor) finish(v);
    }
  };
  document.addEventListener("keydown", onKey);

  overlay.querySelector("#participant-cap-confirm").onclick = () => {
    const v = parseInt(input.value, 10);
    if (!Number.isFinite(v) || v < floor) { alert(`Pick a number of ${floor} or more.`); return; }
    finish(v);
  };
  overlay.querySelector("#participant-cap-none").onclick = () => finish(0);
  overlay.querySelector("#participant-cap-cancel").onclick = () => finish(null);
  setTimeout(() => input?.focus(), 0);
}

// Open vs Closed access. Open → listed in the public Open Tournaments lobby.
// Closed → private: hidden from the lobby, joinable only via the room code the
// host shares. onPick gets "open", "closed", or null on cancel.
function showTournamentVisibilityPopup(onPick) {
  document.getElementById("tournament-visibility-popup")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "tournament-visibility-popup";
  overlay.className = "popup-overlay";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Tournament Access</h2>
      <p class="popup-subtitle">Who can find this tournament?</p>
      <div class="tournament-mode-choices">
        <button type="button" class="tournament-mode-btn" data-visibility="open">
          <span class="tournament-mode-name">Open</span>
          <span class="tournament-mode-desc">Listed in the public Open Tournaments lobby — anyone can find it and register.</span>
        </button>
        <button type="button" class="tournament-mode-btn" data-visibility="closed">
          <span class="tournament-mode-name">Closed</span>
          <span class="tournament-mode-desc">Private — hidden from the lobby. Players join only by entering the room code you share.</span>
        </button>
      </div>
      <button type="button" id="tournament-visibility-cancel" class="btn popup-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);
  const finish = (v) => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    onPick(v);
  };
  const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } };
  document.addEventListener("keydown", onKey);
  overlay.querySelectorAll(".tournament-mode-btn").forEach(btn => {
    btn.onclick = () => finish(btn.dataset.visibility);
  });
  overlay.querySelector("#tournament-visibility-cancel").onclick = () => finish(null);
}

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
  const nameLabel = popup.querySelector('label[for="tournament-name-input"]');
  // The format-change reuse (showSwissFormatPopup) hides the name field —
  // always restore it here so the creation flow shows it.
  if (nameInput) { nameInput.value = ""; nameInput.classList.remove("hidden"); }
  if (nameLabel) nameLabel.classList.remove("hidden");
  const teardown = () => {
    popup.classList.add("hidden");
    swissBtn.onclick = null;
    if (rrBtn) rrBtn.onclick = null;
    singleBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  // Last step of every chain: ask for an optional participant limit, then
  // hand the full config to onPick (maxParticipants appended; null = no cap).
  // Cancelling here aborts creation, like cancelling any earlier step.
  const finishWithCap = (mode, name, rc, ranked, gc, pairing, topN, depth) => {
    const floor = swissRegistrationMinimum({ mode, groupCount: gc, topN, pairing }) || 2;
    showParticipantCapPopup((cap) => {
      if (cap == null) return; // cancelled at the limit step
      // Final step: Open (public lobby) vs Closed (private, join by code).
      showTournamentVisibilityPopup((visibility) => {
        if (visibility == null) return; // cancelled at the access step
        onPick(mode, name, rc, ranked, gc, pairing, topN, depth, cap > 0 ? cap : null, visibility);
      });
    }, null, floor);
  };
  // Every tournament is ranked now — no password gate. Pass ranked=true
  // through unchanged for compatibility with existing call sites.
  swissBtn.onclick = () => {
    const name = nameInput ? nameInput.value.trim() : "";
    teardown();
    // Ask whether to add a knockout, and if so for what N.
    showTopEightPopup((mode) => {
      if (!mode) return; // user cancelled at the knockout step
      const proceed = (topN) => {
        showSwissRoundsPopup((rc) => {
          showSwissGroupsPopup((gc) => finishWithCap(mode, name, rc, true, gc, undefined, topN), false);
        });
      };
      if (mode === "swiss-only") { proceed(null); return; }
      showTopNPickerPopup((n) => {
        if (n == null) return; // cancelled at the size step
        proceed(n);
      });
    });
  };
  if (rrBtn) rrBtn.onclick = () => {
    const name = nameInput ? nameInput.value.trim() : "";
    teardown();
    // Round robin asks knockout + group count, but skips the round picker —
    // rounds are fixed by group size (everyone plays everyone once).
    showTopEightPopup((mode) => {
      if (!mode) return;
      const proceed = (topN) => {
        showSwissGroupsPopup((gc) => finishWithCap(mode, name, undefined, true, gc, "round-robin", topN), true);
      };
      if (mode === "swiss-only") { proceed(null); return; }
      showTopNPickerPopup((n) => {
        if (n == null) return;
        proceed(n);
      });
    }, true);
  };
  singleBtn.onclick = () => {
    const name = nameInput ? nameInput.value.trim() : "";
    teardown();
    showSingleElimDepthPopup((depth) => {
      if (depth == null) return; // cancelled at the depth step
      finishWithCap("single-elim", name, undefined, true, undefined, undefined, undefined, depth);
    });
  };
  cancelBtn.onclick = () => teardown();
  popup.classList.remove("hidden");
  if (nameInput) setTimeout(() => nameInput.focus(), 0);
}

// Switch the tournament FORMAT (Swiss / Round Robin / Single Elimination)
// while still in the registering phase. Reuses the creation-time format
// popup, but hides its name field — the tournament already has a name.
// The chosen format is applied via updateRegisteringSetting, so registrants
// are kept and nothing is reset.
function showSwissFormatPopup() {
  const s = loadSwiss();
  if (!isRegisteringPhase(s)) return;
  const popup = document.getElementById("tournament-mode-popup");
  if (!popup) return;
  const swissBtn = popup.querySelector("#tournament-mode-swiss");
  const rrBtn = popup.querySelector("#tournament-mode-roundrobin");
  const singleBtn = popup.querySelector("#tournament-mode-single");
  const cancelBtn = popup.querySelector("#tournament-mode-cancel");
  const nameInput = popup.querySelector("#tournament-name-input");
  const nameLabel = popup.querySelector('label[for="tournament-name-input"]');
  // The name field is a creation-only concern — hide it for the switch.
  if (nameInput) nameInput.classList.add("hidden");
  if (nameLabel) nameLabel.classList.add("hidden");
  const teardown = () => {
    popup.classList.add("hidden");
    if (swissBtn) swissBtn.onclick = null;
    if (rrBtn) rrBtn.onclick = null;
    if (singleBtn) singleBtn.onclick = null;
    if (cancelBtn) cancelBtn.onclick = null;
    if (nameInput) nameInput.classList.remove("hidden");
    if (nameLabel) nameLabel.classList.remove("hidden");
  };
  // Swiss / Round Robin then ask whether to keep a Top N knockout;
  // Single Elimination applies straight away. pairing is cleared for
  // Swiss / Single Elim and set for Round Robin. When switching INTO a
  // knockout format ("Yes — add a knockout"), open the Top-N picker so
  // the host picks the bracket size right there — same flow as the
  // create-tournament path. Cancelling the size picker cancels the
  // whole format change. Existing topN is the picker default.
  const applyWithTopN = (basePatch) => {
    const currentTopN = (typeof s.topN === "number" && s.topN >= 2) ? s.topN : 8;
    showTopNPickerPopup((n) => {
      if (n == null) return; // user cancelled the size step → keep current format
      updateRegisteringSetting(Object.assign({}, basePatch, { topN: n }));
    }, currentTopN);
  };
  if (swissBtn) swissBtn.onclick = () => {
    teardown();
    showTopEightPopup((mode) => {
      if (!mode) return;
      if (mode === "swiss") applyWithTopN({ mode, pairing: null });
      else updateRegisteringSetting({ mode, pairing: null });
    }, false);
  };
  if (rrBtn) rrBtn.onclick = () => {
    teardown();
    showTopEightPopup((mode) => {
      if (!mode) return;
      if (mode === "swiss") applyWithTopN({ mode, pairing: "round-robin" });
      else updateRegisteringSetting({ mode, pairing: "round-robin" });
    }, true);
  };
  if (singleBtn) singleBtn.onclick = () => {
    teardown();
    const currentDepth = (typeof s.placementDepth === "number") ? s.placementDepth : 8;
    showSingleElimDepthPopup((depth) => {
      if (depth == null) return; // cancelled the format change at the depth step
      updateRegisteringSetting({ mode: "single-elim", pairing: null, placementDepth: depth });
    }, currentDepth);
  };
  if (cancelBtn) cancelBtn.onclick = teardown;
  popup.classList.remove("hidden");
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
  showTournamentModePopup((mode, tournamentName, roundCount, ranked, groupCount, pairing, topN, placementDepth, maxParticipants, visibility) => {
    // Open Registration only — empty room in registering phase. Players
    // self-register with their decks via the Rooms tab, then the host
    // clicks Start to generate groups / bracket from the registrants.
    const next = createRegisteringTournamentState({
      mode, tournamentName, roundCount, ranked, groupCount, pairing, topN, placementDepth, maxParticipants, visibility,
      hostUid: user ? user.uid : null
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
function createRegisteringTournamentState({ mode, tournamentName, roundCount, ranked, groupCount, pairing, topN, placementDepth, maxParticipants, visibility, hostUid }) {
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
    hostUid: hostUid || null,
    // The host's username, so the room badge can name the host on every
    // device. Kept in step by the host's listener (handles renames).
    hostName: (window.getCurrentUsername && window.getCurrentUsername()) || null
  };
  // Optional participant cap chosen at create time (null / absent = no cap).
  const capN = Number(maxParticipants);
  if (Number.isFinite(capN) && capN >= 2) state.maxParticipants = Math.floor(capN);
  // Closed = private (not listed in the public lobby; join by code). Open is
  // the default, so only the "closed" flag is stored.
  if (visibility === "closed") state.visibility = "closed";
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
    // Knockout bracket size — null / swiss-only skips the bracket entirely;
    // otherwise default 8 for back-compat with old call sites.
    if (safeMode === "swiss") {
      const nVal = Number(topN);
      state.topN = (Number.isFinite(nVal) && nVal >= 2 && nVal <= 64) ? nVal : 8;
    }
  } else {
    // Single-elim placement depth — any integer 2–16 (default 8). Carried
    // through generateSingleElimFromText, which clamps it down to whatever
    // the bracket can actually host and builds the matching consolation
    // matches.
    state.placementDepth = clampPlacementDepth(placementDepth);
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

function renderTournamentResultsMarkup(state, ownerCode) {
  const name = state.tournamentName && state.tournamentName.trim()
    ? escapeHtml(state.tournamentName)
    : "(unnamed tournament)";
  const modeLabel = tournamentFormatLabel(state.mode, state.pairing, false, state.topN);
  const header = `
    <div class="tournament-results-heading">
      <div class="tournament-results-name">${name}</div>
      <div class="tournament-results-mode">${escapeHtml(modeLabel)}</div>
    </div>
  `;
  // The viewer's own win/lose record + decks for this tournament (empty unless
  // they participated with a registered deck), then the parts-usage pie charts.
  const recap = renderMyTournamentRecap(state, ownerCode);
  const partsCharts = recap + renderPartUsageCharts(state);

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
      const nm = s.name || "";
      const rankAttr = nm ? ` data-rank-name="${escapeHtml(nm)}" data-rank-place="${place}"` : "";
      const profAttr = nm ? ` data-profile-username="${escapeHtml(nm)}"` : "";
      return `
        <div class="tournament-results-row swiss-final-row${placeMod}"${rankAttr}>
          <span class="tournament-results-place">${placementLabel(place)}</span>
          <span class="tournament-results-player"${profAttr}>${nm ? swissNameCellInner(nm) : "—"}</span>
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
  const rows = placements.map(p => {
    const nm = p.name || "";
    const rankAttr = nm ? ` data-rank-name="${escapeHtml(nm)}" data-rank-place="${p.place}"` : "";
    const profAttr = nm ? ` data-profile-username="${escapeHtml(nm)}"` : "";
    return `
    <div class="tournament-results-row tournament-results-place-${p.place}"${rankAttr}>
      <span class="tournament-results-place">${placementLabel(p.place)}</span>
      <span class="tournament-results-player"${profAttr}>${nm ? swissNameCellInner(nm) : "—"}</span>
    </div>
  `;
  }).join("");
  return header + `<div class="tournament-results-list">${rows}</div>` + partsCharts;
}

// Paint each history-results placement row (carrying data-rank-name +
// data-rank-place) with that player's profile banner, same as the live views.
function hydrateResultsBanners(container) {
  if (!container) return;
  container.querySelectorAll(".tournament-results-row[data-rank-name]").forEach(row => {
    const nm = row.dataset.rankName || "";
    if (!nm) return;
    paintProfileBannerRow(row, nm, parseInt(row.dataset.rankPlace, 10) || 0);
  });
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
    // Profile photos, click-to-open-profile, and banner backgrounds on the
    // placement rows — same treatment as the live ranking / results views.
    hydrateTournamentAvatars(body);
    bindTournamentProfileNames(body);
    hydrateResultsBanners(body);
  };
  const cached = findCachedTournamentByCode(code);
  if (!firebaseReady()) {
    if (cached) { body.innerHTML = renderTournamentResultsMarkup(cached, code); wirePartUsageCarousels(); return; }
    body.innerHTML = `<p class="tournament-results-empty">Live sync isn't configured on this build, so results can't be fetched.</p>`;
    return;
  }
  fetchTournamentState(code.toUpperCase(), state => {
    if (state) {
      body.innerHTML = renderTournamentResultsMarkup(state, code);
      wirePartUsageCarousels();
      return;
    }
    if (cached) {
      body.innerHTML = renderTournamentResultsMarkup(cached, code);
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

// Flag the Tournament tab with a "!" — live — when the signed-in user is a
// co-host on any open tournament. Runs on every page (tournament.js is app-wide).
// The username often resolves after load, so also (re)start on userprofilechange;
// startSubHostInviteWatch tears down any prior listeners first.
window.addEventListener("load", startSubHostInviteWatch);
window.addEventListener("userprofilechange", startSubHostInviteWatch);

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

// Subscribe to the ranking on load so profile cards show — and live-update —
// Gold / Silver / Bronze Player tags even before the Ranking tab is opened.
subscribeRankingMedals();

// The monthly BR rollover needs the Judge tag, which loads after auth resolves;
// retry the check whenever the profile (and its tags) lands.
window.addEventListener("userprofilechange", maybeRunBattleRoyaleMonthlyRollover);

(function initTournamentSubTabs() {
  const tabs = document.querySelectorAll(".tournament-sub-tab");
  if (!tabs.length) return;
  const panels = document.querySelectorAll(".tournament-panel");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const view = tab.dataset.tournamentView;
      // Leaving an open archive: move #swiss-view back to Hosting first.
      if (typeof teardownArchiveView === "function") teardownArchiveView();
      tabs.forEach(t => t.classList.toggle("active", t === tab));
      panels.forEach(p => p.classList.toggle("hidden", p.id !== "tournament-panel-" + view));
      if (view === "ranking") renderTournamentRanking();
      if (view === "past") refreshPastTournaments();
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
  document.getElementById("past-tournaments-refresh")?.addEventListener("click", refreshPastTournaments);
  document.getElementById("swiss-rooms-qr")?.addEventListener("click", showTournamentQrPopup);
  document.getElementById("swiss-rooms-tutorial")?.addEventListener("click", showTutorialPopup);

  // Only accounts tagged "Judge" may create a tournament. The button (and the
  // surrounding helper hint + divider) hide for everyone else, including
  // signed-out visitors. The auth/profile order is racy on sign-out — the
  // user object goes null before the profile cache clears — so we gate on
  // BOTH: there must be a signed-in user AND that user must be a Judge.
  function paintCreateTournamentBtn() {
    const u = (typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null;
    const allowed = !!(u && u.uid && typeof window.isJudge === "function" && window.isJudge());
    const btn = document.getElementById("swiss-generate");
    if (btn) {
      const wrap = btn.closest(".swiss-actions") || btn;
      wrap.classList.toggle("hidden", !allowed);
    }
    const hint = document.querySelector("#swiss-setup .swiss-hint");
    if (hint) hint.classList.toggle("hidden", !allowed);
  }
  paintCreateTournamentBtn();
  // Profile fetches resolve after onAuthChange fires; re-paint when it lands
  // so a freshly signed-in Judge sees the button without a refresh.
  window.addEventListener("userprofilechange", paintCreateTournamentBtn);

  // ===== Tutorial popup =====
  // Two tabs (Participant / Guest) — each shows a single demo gif with a
  // caption. Replaced the older 9-slide jpeg carousel because the gifs
  // walk through the flow on their own; nothing to swipe or auto-advance.
  function buildTutorialPopup() {
    if (document.getElementById("tutorial-popup")) return;
    const overlay = document.createElement("div");
    overlay.id = "tutorial-popup";
    overlay.className = "popup-overlay hidden";
    overlay.innerHTML = `
      <div class="popup-card tutorial-card">
        <h2 class="popup-title">How to Join</h2>
        <div class="tutorial-tabs" role="tablist">
          <button type="button" class="tutorial-tab active" data-tab="participant" role="tab" aria-selected="true">Sign In</button>
          <button type="button" class="tutorial-tab" data-tab="guest" role="tab" aria-selected="false">Guest</button>
        </div>
        <div class="tutorial-pane tutorial-pane-participant active" data-pane="participant">
          <div class="tutorial-guest-frame">
            <figure class="tutorial-slide tutorial-slide-guest active">
              <img src="assets/tutorial/signin/signin.gif" alt="How to join as a participant">
              <figcaption class="tutorial-caption">Sign in (or create an account), pick Participant from the join popup, paste your 3-combo deck, and hit Register. Signed-in players earn ranking points on finish.</figcaption>
            </figure>
          </div>
        </div>
        <div class="tutorial-pane tutorial-pane-guest" data-pane="guest">
          <div class="tutorial-guest-frame">
            <figure class="tutorial-slide tutorial-slide-guest active">
              <img src="assets/tutorial/guest/guest.gif" alt="How to join as a guest">
              <figcaption class="tutorial-caption">Tap Become Guest, enter your name (or paste several for friends, one per line), and you're in — no account or deck needed.</figcaption>
            </figure>
          </div>
        </div>
        <div class="popup-actions">
          <button type="button" class="btn popup-cancel" id="tutorial-close">
            <img src="assets/icons/exit-button.png" alt="" onerror="this.style.display='none'">
            <span class="btn-label">Close</span>
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeTutorialPopup(); });
    document.getElementById("tutorial-close").addEventListener("click", closeTutorialPopup);

    overlay.querySelectorAll(".tutorial-tab").forEach(btn => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        overlay.querySelectorAll(".tutorial-tab").forEach(b => {
          const on = b.dataset.tab === tab;
          b.classList.toggle("active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        overlay.querySelectorAll(".tutorial-pane").forEach(p => {
          p.classList.toggle("active", p.dataset.pane === tab);
        });
      });
    });
  }

  function showTutorialPopup() {
    buildTutorialPopup();
    document.getElementById("tutorial-popup").classList.remove("hidden");
  }

  function closeTutorialPopup() {
    document.getElementById("tutorial-popup")?.classList.add("hidden");
  }

  // ===== Tutorial popup =====
  // The tutorial no longer auto-opens on idle — it's shown only when the
  // user taps the Tutorial button in the Open Tournaments header.

  // Build (once) and show a popup with a QR code pointing to /tournament/
  // so participants can scan and open the lobby on their phone.
  function buildTournamentQrPopup() {
    if (document.getElementById("tournament-qr-popup")) return;
    const overlay = document.createElement("div");
    overlay.id = "tournament-qr-popup";
    overlay.className = "popup-overlay hidden";
    overlay.innerHTML = `
      <div class="popup-card tournament-qr-card">
        <h2 class="popup-title">Tournament QR</h2>
        <p class="popup-text">Scan to open the tournament page on another device.</p>
        <div class="tournament-qr-image-wrap">
          <img id="tournament-qr-image" alt="Tournament QR code">
        </div>
        <p class="tournament-qr-url" id="tournament-qr-url"></p>
        <div class="popup-actions">
          <button type="button" class="btn popup-cancel" id="tournament-qr-close">Close</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", e => { if (e.target === overlay) closeTournamentQrPopup(); });
    document.getElementById("tournament-qr-close").addEventListener("click", closeTournamentQrPopup);
  }

  function closeTournamentQrPopup() {
    document.getElementById("tournament-qr-popup")?.classList.add("hidden");
  }

  function showTournamentQrPopup() {
    buildTournamentQrPopup();
    // Resolve /tournament/ relative to the current page so it works whether
    // the app is hosted at the domain root or under a subfolder.
    const url = new URL("../tournament/", window.location.href).href;
    document.getElementById("tournament-qr-image").src =
      "https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=10&data=" + encodeURIComponent(url);
    document.getElementById("tournament-qr-url").textContent = url;
    document.getElementById("tournament-qr-popup").classList.remove("hidden");
  }

  // Re-list the host's own tournaments whenever auth resolves or changes —
  // this also fires once at boot, populating the list on first load.
  if (typeof onAuthChange === "function") {
    onAuthChange(user => {
      refreshMyTournaments();
      paintCreateTournamentBtn();
      // Settle last month's ranking into Battle Royale if the month has turned.
      // Runs only for Judges; harmless no-op otherwise. Also retried on
      // userprofilechange below, since the Judge tag loads after auth resolves.
      maybeRunBattleRoyaleMonthlyRollover();
      // Hosting / co-hosting requires a signed-in account. On sign-out, drop
      // the local room state unconditionally — even when this page's runtime
      // didn't have an active swissRoomRef (sign-out can come from another
      // tab, leaving stale localStorage that would auto-reconnect the next
      // time the user opens the Tournament tab). The Firebase room data
      // stays intact, so signing back in puts the host straight back in.
      if (!user) {
        if (swissRoomRef) disconnectSwissRoom();
        saveJoinedRoom(null);
        localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [] }));
        if (typeof renderSwiss === "function") renderSwiss();
        if (typeof refreshOpenTournamentRooms === "function") refreshOpenTournamentRooms();
      }
    });
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
    const modeLabel = tournamentFormatLabel(r.mode, r.pairing, true, r.topN);
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

// ===== Tournament tab "co-host invite" alert =====
// Show a "!" on the Tournament nav tab when the signed-in user has been added
// as a sub-host (co-host) to any open tournament — so they notice the invite
// from ANY page, not only inside the Open Tournaments list. tournament.js loads
// on every page, so this runs app-wide. Cheap: one openTournaments read plus a
// single leaf read per open room (subHosts/<myKey>).
function setSubHostTabAlert(on) {
  const tab = document.querySelector('a.tab[data-mode="swiss"]');
  if (!tab) return;
  let dot = tab.querySelector(".tab-alert");
  if (on && !dot) {
    dot = document.createElement("span");
    dot.className = "tab-alert";
    dot.textContent = "!";
    dot.title = "You're invited as co-host";
    dot.setAttribute("aria-label", "You're invited as co-host");
    tab.appendChild(dot);
  } else if (!on && dot) {
    dot.remove();
  }
}

// Per-account record of co-host invites the user has acted on (opened that
// tournament's join screen). Stored locally so the "!" behaves like a
// dismissible notification: it shows for a NEW invite — on ANY tab, including
// the Tournament tab — and clears for a tournament only once the user opens it.
function coHostSeenKey(uid) { return "swissCoHostSeen_" + uid; }
function loadSeenCoHostInvites(uid) {
  if (!uid) return [];
  try { return JSON.parse(localStorage.getItem(coHostSeenKey(uid)) || "[]") || []; }
  catch (e) { return []; }
}
function storeSeenCoHostInvites(uid, codes) {
  if (!uid) return;
  try { localStorage.setItem(coHostSeenKey(uid), JSON.stringify(codes || [])); } catch (e) {}
}

// Show the badge whenever the user is a co-host on a tournament they haven't
// opened yet — regardless of which tab they're currently on.
function applyCoHostInviteState(uid, invitedCodes) {
  const seen = loadSeenCoHostInvites(uid);
  setSubHostTabAlert(invitedCodes.some(c => seen.indexOf(c) === -1));
}

// Acting on an invite (opening that tournament's join screen) dismisses the "!"
// for that tournament only, then re-evaluates any remaining invites.
function markCoHostInviteSeen(uid, editCode) {
  if (!uid || !editCode) return;
  const seen = loadSeenCoHostInvites(uid);
  if (seen.indexOf(editCode) === -1) {
    seen.push(editCode);
    storeSeenCoHostInvites(uid, seen);
  }
  applyCoHostInviteState(uid, Object.keys(coHostInvited));
}

// Live watch that keeps the Tournament-tab "!" current in real time. A listener
// on `openTournaments` tracks which tournaments exist; for each, a listener on
// `subHosts/<myKey>` fires the instant the host adds or removes you as a
// co-host — so the badge updates on its own, with no refresh or tab switch.
let coHostOpenRef = null;   // listener on openTournaments (child add/remove)
const coHostSubRefs = {};   // editCode -> ref on subHosts/<myKey>
let coHostInvited = {};     // editCode -> true (you're currently a co-host there)

function stopSubHostInviteWatch() {
  if (coHostOpenRef) { try { coHostOpenRef.off(); } catch (e) {} coHostOpenRef = null; }
  Object.keys(coHostSubRefs).forEach(code => { try { coHostSubRefs[code].off(); } catch (e) {} delete coHostSubRefs[code]; });
  coHostInvited = {};
}

function startSubHostInviteWatch() {
  stopSubHostInviteWatch();
  if (!document.querySelector('a.tab[data-mode="swiss"]')) return;
  if (!firebaseReady()) { setSubHostTabAlert(false); return; }
  const user = (typeof getCurrentUser === "function" && getCurrentUser()) || null;
  const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  const myKey = uname ? subHostKey(uname) : "";
  if (!user || !myKey) { setSubHostTabAlert(false); return; }
  const uid = user.uid;
  const db = initFirebase();
  setSubHostTabAlert(false); // baseline until the listeners report in
  const recompute = () => applyCoHostInviteState(uid, Object.keys(coHostInvited));
  // openTournaments keys ARE the edit codes (openTournaments/<editCode>).
  const watchRoom = (code) => {
    if (!code || coHostSubRefs[code]) return;
    const ref = db.ref("swissRooms/" + code + "/subHosts/" + myKey);
    coHostSubRefs[code] = ref;
    ref.on("value", s => {
      if (s.val()) coHostInvited[code] = true; else delete coHostInvited[code];
      recompute();
    }, () => {});
  };
  const unwatchRoom = (code) => {
    if (coHostSubRefs[code]) { try { coHostSubRefs[code].off(); } catch (e) {} delete coHostSubRefs[code]; }
    if (coHostInvited[code]) { delete coHostInvited[code]; recompute(); }
  };
  coHostOpenRef = db.ref("openTournaments");
  coHostOpenRef.on("child_added", s => watchRoom(s.key), () => {});
  coHostOpenRef.on("child_removed", s => unwatchRoom(s.key), () => {});
}

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
        setSubHostTabAlert(false);
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
        // `pairing` and `subHosts` live on the room, not the lobby summary.
        const pairP = db.ref("swissRooms/" + r.editCode + "/pairing").once("value")
          .then(s => s.val())
          .catch(() => null);
        const subP = db.ref("swissRooms/" + r.editCode + "/subHosts").once("value")
          .then(s => s.val() || {})
          .catch(() => ({}));
        // Read the name live — a rename (especially by a co-host) doesn't
        // re-publish the lobby summary, so the summary's `name` can be stale.
        const nameP = db.ref("swissRooms/" + r.editCode + "/tournamentName").once("value")
          .then(s => s.val())
          .catch(() => undefined);
        // Participant cap lives on the room (not the lobby summary, which has
        // a field whitelist) — read it live so the lobby can show the limit.
        const capP = db.ref("swissRooms/" + r.editCode + "/maxParticipants").once("value")
          .then(s => s.val())
          .catch(() => null);
        // Visibility (open / closed) — read live so the lobby can tag Closed
        // rooms and gate them behind a code prompt.
        const visP = db.ref("swissRooms/" + r.editCode + "/visibility").once("value")
          .then(s => s.val())
          .catch(() => null);
        return Promise.all([phaseP, regP, pairP, subP, nameP, capP, visP]).then(([phase, count, pairing, subHosts, liveName, maxParticipants, visibility]) => ({
          room: r, phase, count, pairing, subHosts, liveName, maxParticipants, visibility
        }));
      })).then(results => {
        const live = [];
        results.forEach(({ room, phase, count, pairing, subHosts, liveName, maxParticipants, visibility }) => {
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
            room.subHosts = subHosts || {};
            room.maxParticipants = (typeof maxParticipants === "number" && maxParticipants >= 2) ? maxParticipants : null;
            room.visibility = visibility === "closed" ? "closed" : "open";
            if (liveName !== undefined) room.name = liveName || "";
            live.push(room);
          } else {
            // Underlying room is gone — drop the stale lobby entry.
            db.ref("openTournaments/" + room.editCode).set(null)
              .catch(() => {});
          }
        });
        live.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
        // Refresh the tab "!" from what we just read (reuses subHosts — no extra
        // requests). It stays lit for any invite the user hasn't opened yet; it
        // clears per-tournament when they open that tournament's join screen.
        const myUnameLA = (window.getCurrentUsername && window.getCurrentUsername()) || "";
        const myKeyLA = myUnameLA ? subHostKey(myUnameLA) : "";
        const uidLA = (typeof getCurrentUser === "function" && getCurrentUser()) ? getCurrentUser().uid : "";
        if (myKeyLA && uidLA) {
          applyCoHostInviteState(uidLA, live.filter(r => r.subHosts && r.subHosts[myKeyLA]).map(r => r.editCode));
        } else {
          setSubHostTabAlert(false);
        }
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
  // Tag rooms the signed-in account hosts, or has been added to as a
  // sub-host, so the user can spot them in the lobby.
  const myUid = (typeof getCurrentUser === "function" && getCurrentUser())
    ? getCurrentUser().uid : null;
  const myUname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
  const myKey = myUname ? subHostKey(myUname) : "";
  list.innerHTML = rooms.map(r => {
    const name = (r.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(r.mode, r.pairing, true, r.topN);
    const isRunning = r.phase === "running";
    const count = r.registrantCount || 0;
    const cap = (typeof r.maxParticipants === "number" && r.maxParticipants >= 2) ? r.maxParticipants : null;
    const countLabel = isRunning ? "players" : "registered";
    // Show the cap so players see the limit before joining (e.g. "5 / 16").
    const meta = [cap != null ? `${count} / ${cap} ${countLabel}` : `${count} ${countLabel}`];
    if (r.mode !== "single-elim") {
      if (r.groupCount) meta.push(`${r.groupCount} groups`);
      if (r.roundCount) meta.push(`${r.roundCount} rounds`);
    }
    const isFull = cap != null && count >= cap && !isRunning;
    const fullBadge = isFull
      ? `<span class="swiss-room-full-badge" title="Registration full">Full</span>`
      : "";
    const hostingBadge = (myUid && r.hostUid && r.hostUid === myUid)
      ? `<span class="swiss-room-hosting-badge">Hosting</span>`
      : "";
    // You were added to this room's sub-host list — you'll join as co-host.
    // Show a "!" alert badge so the user spots the invitation at a glance.
    const cohostBadge = (myKey && r.subHosts && r.subHosts[myKey])
      ? `<span class="swiss-room-cohost-badge swiss-room-cohost-alert" title="You're invited as co-host" aria-label="You're invited as co-host">!</span>`
      : "";
    const runningBadge = isRunning
      ? `<span class="swiss-room-running-badge">In progress</span>`
      : "";
    // Closed (private) rooms are listed but locked — tapping asks for the code.
    const closedBadge = r.visibility === "closed"
      ? `<span class="swiss-room-closed-badge" title="Private — a code is required to join">Closed</span>`
      : "";
    return `
      <button type="button" class="swiss-room-card" data-edit-code="${escapeHtml(r.editCode)}">
        <div class="swiss-room-card-name">
          <span class="swiss-room-card-title">${escapeHtml(name)}</span>
        </div>
        <div class="swiss-room-card-mode">${modeLabel}</div>
        <div class="swiss-room-card-meta">
          ${hostingBadge}
          <span class="swiss-room-card-meta-text">${meta.map(escapeHtml).join(" · ")}</span>
          ${runningBadge}
          ${fullBadge}
          ${closedBadge}
          ${cohostBadge}
        </div>
      </button>
    `;
  }).join("");
  list.querySelectorAll(".swiss-room-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const editCode = btn.dataset.editCode;
      const room = rooms.find(r => r.editCode === editCode);
      if (!room) return;
      // Closed rooms require the room code before the join picker opens — but
      // the host (and invited sub-hosts) skip the gate since they own/run it.
      const amSubHost = !!(myKey && room.subHosts && room.subHosts[myKey]);
      // Opening your invited tournament dismisses the tab "!" for it.
      if (amSubHost) {
        const uid = (typeof getCurrentUser === "function" && getCurrentUser()) ? getCurrentUser().uid : "";
        markCoHostInviteSeen(uid, room.editCode);
      }
      if (room.visibility === "closed" && !isCurrentUserRoomHost(room) && !amSubHost) {
        showClosedRoomCodePrompt(room);
      } else {
        showTournamentJoinChoicePopup(room);
      }
    });
  });
}

// ===== Past Tournaments =====
// A public, sign-in-free archive of finished tournaments. When a tournament
// completes, its host snapshots the full state (groups, bracket, every match,
// registrants) into the world-readable `pastTournaments/{editCode}` node. The
// Past tab lists those snapshots and opens each one READ-ONLY — so all matches
// survive even after the host resets the live room.

// Champion name for a finished tournament state (bracket winner, or the top of
// the combined standings for swiss-only).
function pastTournamentChampion(state) {
  const podium = computeTournamentPlacements(state).find(p => p.place === 1);
  if (podium && podium.name) return podium.name;
  if (state && state.mode === "swiss-only" && typeof computeCombinedSwissStandings === "function") {
    const st = computeCombinedSwissStandings(state);
    if (st && st[0] && st[0].name) return st[0].name;
  }
  return "";
}

// Host-side: archive a completed tournament to the public `pastTournaments`
// node so it stays viewable after the room is reset. Once per session per code.
function publishPastTournament(editCode, state) {
  if (!editCode || !state || pastTournamentArchived.has(editCode)) return;
  const db = initFirebase();
  if (!db || !isTournamentComplete(state)) return;
  pastTournamentArchived.add(editCode);
  const uid = (typeof getCurrentUser === "function" && getCurrentUser()) ? getCurrentUser().uid : null;
  const snap = {
    editCode,
    viewCode: swissViewCode || null,
    hostUid: state.hostUid || uid || null,
    tournamentName: state.tournamentName || "",
    mode: state.mode || "swiss",
    pairing: state.pairing || "",
    topN: state.topN || null,
    placementDepth: state.placementDepth || null,
    groups: state.groups || null,
    groupRounds: state.groupRounds || null,
    bracket: state.bracket || null,
    matches: state.matches || null,
    registrants: state.registrants || null,
    createdAt: state.createdAt || new Date().toISOString(),
    archivedAt: new Date().toISOString()
  };
  // JSON round-trip drops undefined so Firebase accepts the payload.
  db.ref("pastTournaments/" + editCode).set(JSON.parse(JSON.stringify(snap)))
    .catch(e => { pastTournamentArchived.delete(editCode); console.warn("Past tournament archive failed:", e); });
}

function refreshPastTournaments() {
  const list = document.getElementById("past-tournaments-list");
  const status = document.getElementById("past-tournaments-status");
  if (!list) return;
  const setStatus = msg => { if (status) status.textContent = msg || ""; };
  if (!firebaseReady()) {
    list.innerHTML = "";
    setStatus("Live sync isn't configured on this build.");
    return;
  }
  setStatus("Loading…");
  const db = initFirebase();
  db.ref("pastTournaments").once("value")
    .then(snap => {
      const arr = Object.values(snap.val() || {}).filter(s => s && s.editCode);
      const done = arr.map(s => ({
        editCode: s.editCode,
        name: (s.tournamentName || "").trim(),
        mode: s.mode || "swiss",
        pairing: s.pairing || null,
        topN: s.topN || null,
        players: s.registrants ? Object.keys(s.registrants).length : 0,
        champion: pastTournamentChampion(s),
        createdAt: s.createdAt || s.archivedAt || "",
        snapshot: s
      }));
      done.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      if (!done.length) {
        list.innerHTML = `<p class="swiss-rooms-empty">No finished tournaments yet. A tournament shows up here once its host reaches the final results.</p>`;
        setStatus("");
        return;
      }
      renderPastTournamentsList(list, done);
      setStatus("");
    })
    .catch(err => {
      console.warn("Past tournaments fetch failed:", err);
      setStatus("Couldn't load past tournaments. Check your connection.");
    });
}

function renderPastTournamentsList(list, rooms) {
  list.innerHTML = rooms.map(r => {
    const name = (r.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(r.mode, r.pairing, false, r.topN);
    return `
      <button type="button" class="swiss-room-card" data-edit-code="${escapeHtml(r.editCode)}">
        <div class="swiss-room-card-name">
          <span class="swiss-room-card-title">${escapeHtml(name)}</span>
        </div>
        <div class="swiss-room-card-mode">${modeLabel}</div>
        <div class="swiss-room-card-meta">
          <span class="swiss-room-card-meta-text">${escapeHtml(r.players + " players")}</span>
          ${r.champion ? `<span class="swiss-room-card-meta-text swiss-room-champion">🏆 ${escapeHtml(r.champion)}</span>` : ""}
          <span class="swiss-room-complete-badge">Completed</span>
        </div>
      </button>`;
  }).join("");
  list.querySelectorAll(".swiss-room-card").forEach(btn => {
    btn.addEventListener("click", () => {
      const room = rooms.find(r => r.editCode === btn.dataset.editCode);
      if (room) openArchivedTournament(room.snapshot); // read-only, shows all matches
    });
  });
}

// Load an archived snapshot into a read-only render (no live room, no writes),
// so every group / bracket / match is visible. `swissArchiveView` flips the
// toolbar's Reset button to a Back button.
function openArchivedTournament(snap) {
  if (!snap) return;
  disconnectSwissRoom();
  swissArchiveView = true;
  swissEditCode = null;
  swissViewCode = null;
  swissIsHost = false;
  swissCanEdit = false;
  swissSessionRole = "view";
  const state = {
    groups: snap.groups || null,
    groupRounds: snap.groupRounds || [],
    bracket: snap.bracket || null,
    matches: snap.matches || {},
    registrants: snap.registrants || {},
    phase: "running",
    mode: snap.mode || "swiss",
    pairing: snap.pairing || "",
    topN: snap.topN || null,
    placementDepth: snap.placementDepth || null,
    tournamentName: snap.tournamentName || "",
    hostUid: snap.hostUid || null,
    createdAt: snap.createdAt || ""
  };
  // Keep the archive in memory (loadSwiss serves it while swissArchiveView is
  // on) — NOT in localStorage, so navigating to another page and back doesn't
  // restore it as a live tournament on the Hosting tab.
  swissArchiveState = state;
  // Render the archive read-only WITHIN the Past panel (move the shared
  // #swiss-view there and hide the list) so it stays under the Past tab instead
  // of jumping to Hosting. `renderSwiss` still targets #swiss-view by id.
  const view = document.getElementById("swiss-view");
  const pastPanel = document.getElementById("tournament-panel-past");
  if (view && pastPanel) {
    pastPanel.appendChild(view);
    pastPanel.classList.add("past-archive-open");
  }
  renderSwiss();
}

// Move #swiss-view back to the Hosting panel and clear the archive state.
// Shared by the Back button and by any top-level tab switch (so Hosting isn't
// left without its view).
function teardownArchiveView() {
  if (!swissArchiveView) return;
  swissArchiveView = false;
  swissArchiveState = null;
  disconnectSwissRoom();
  const view = document.getElementById("swiss-view");
  const hostingFieldset = document.querySelector("#tournament-panel-hosting fieldset");
  if (view && hostingFieldset) hostingFieldset.appendChild(view);
  document.getElementById("tournament-panel-past")?.classList.remove("past-archive-open");
  renderSwiss();
}

// Leave the read-only archive view and go back to the Past list (stays on the
// Past tab, which is already active).
function exitArchiveView() {
  teardownArchiveView();
  refreshPastTournaments();
}

// Code gate for a Closed (private) lobby room — verify the host's shared code
// (matches the room's view OR host code) before opening the join picker.
function showClosedRoomCodePrompt(room) {
  document.getElementById("closed-room-code-popup")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "closed-room-code-popup";
  overlay.className = "popup-overlay";
  const name = (room.name || "").trim() || "(unnamed tournament)";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Closed Tournament</h2>
      <p class="popup-subtitle">${escapeHtml(name)} is private. Enter the code the host shared to join.</p>
      <input type="text" id="closed-room-code-input" class="tournament-name-input" placeholder="Room code" maxlength="16" autocomplete="off" spellcheck="false" autocapitalize="characters">
      <div id="closed-room-code-status" class="swiss-join-status"></div>
      <div class="popup-actions">
        <button type="button" id="closed-room-code-submit" class="btn">Join</button>
        <button type="button" id="closed-room-code-cancel" class="btn popup-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector("#closed-room-code-input");
  const status = overlay.querySelector("#closed-room-code-status");
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const submit = () => {
    const entered = String(input.value || "").trim().toUpperCase();
    if (!entered) { status.textContent = "Enter the room code."; return; }
    const view = String(room.viewCode || "").toUpperCase();
    const edit = String(room.editCode || "").toUpperCase();
    if (entered === view || entered === edit) {
      close();
      showTournamentJoinChoicePopup(room);
    } else {
      status.textContent = "That code doesn't match. Try again.";
    }
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Enter" && document.activeElement === input) { e.preventDefault(); submit(); }
  };
  document.addEventListener("keydown", onKey);
  overlay.querySelector("#closed-room-code-submit").onclick = submit;
  overlay.querySelector("#closed-room-code-cancel").onclick = close;
  overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
  setTimeout(() => input?.focus(), 0);
}

// Three-way join picker shown when a user taps an entry in the Open
// Tournaments list. Co-host requires the host code (matched against the
// lobby summary's editCode), participant opens the registration form,
// viewer connects view-only directly via the lobby's viewCode.
function showTournamentJoinChoicePopup(room) {
  // The signed-in account IS this room's host — rejoin straight as host,
  // no role pick. Checked against the room's hostUid (account-scoped), so
  // a DIFFERENT account on the same device is NOT auto-joined as host of
  // someone else's tournament — it falls through to the role choice.
  if (isCurrentUserRoomHost(room)) {
    if (typeof markRoomHosted === "function") markRoomHosted(room.editCode);
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
    const modeLabel = tournamentFormatLabel(room.mode, room.pairing, true, room.topN);
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
      if (desc) desc.textContent = "Sign in with your name and deck (deck pre-fills every match), or play as a guest — guests can skip the deck.";
      participantBtn.onclick = () => {
        close();
        showParticipantModeChoice(room);
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

// After Participant is picked, ask the user whether to sign in (so their
// finish earns global ranking points) or play as a guest (no ranking).
function buildParticipantModePopup() {
  if (document.getElementById("participant-mode-popup")) return;
  const overlay = document.createElement("div");
  overlay.id = "participant-mode-popup";
  overlay.className = "popup-overlay hidden";
  overlay.innerHTML = `
    <div class="popup-card">
      <h2 class="popup-title">Join as Participant</h2>
      <p class="popup-text" id="participant-mode-subtitle"></p>
      <div class="tournament-mode-grid">
        <button type="button" id="participant-mode-signin" class="tournament-mode-btn">
          <span class="tournament-mode-title">Sign in</span>
          <span class="tournament-mode-desc">Bring a 3-combo deck; your final placing counts toward the global ranking.</span>
        </button>
        <button type="button" id="participant-mode-guest" class="tournament-mode-btn">
          <span class="tournament-mode-title">Become Guest</span>
          <span class="tournament-mode-desc">Play with just a name — no deck or account needed. Doesn't affect the leaderboard.</span>
        </button>
      </div>
      <button type="button" id="participant-mode-cancel" class="btn popup-cancel">Cancel</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.add("hidden"); });
}

function showParticipantModeChoice(room) {
  buildParticipantModePopup();
  const popup = document.getElementById("participant-mode-popup");
  const subtitle = popup.querySelector("#participant-mode-subtitle");
  if (subtitle) {
    const name = (room.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(room.mode, room.pairing, true, room.topN);
    subtitle.textContent = `${name} · ${modeLabel}`;
  }
  const close = () => popup.classList.add("hidden");
  const signinBtn = popup.querySelector("#participant-mode-signin");
  const guestBtn = popup.querySelector("#participant-mode-guest");
  const cancelBtn = popup.querySelector("#participant-mode-cancel");

  // After sign-in, if the signed-in account is THIS room's host, drop them
  // straight into the host view instead of going through registration; any
  // other account proceeds to ranked participant registration with the name
  // pre-filled (and locked) to their account's username. If the account is
  // ALREADY registered in this room (same username), the registration step
  // is skipped entirely — they go straight into the participant view.
  const enterAfterSignin = (signedInUser) => {
    if (signedInUser && room.hostUid && signedInUser.uid === room.hostUid) {
      // Mark this room as hosted on the local device so joinTournamentAsCoHost
      // wires it up with full host rights — covers the case where the host
      // is signing in on a fresh device.
      if (typeof markRoomHosted === "function") markRoomHosted(room.editCode);
      joinTournamentAsCoHost(room);
      return;
    }
    const myUname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
    if (!myUname) {
      showRegistrationPopup(room);
      return;
    }
    // Check the room for a registrant already under this username — if
    // found, skip the deck-registration form and join straight away.
    const db = initFirebase();
    if (!db || !room.editCode) {
      showRegistrationPopup(room, { initialName: myUname, lockName: true });
      return;
    }
    const lower = myUname.trim().toLowerCase();
    db.ref("swissRooms/" + room.editCode + "/registrants").once("value").then(snap => {
      const regs = snap.val() || {};
      const alreadyRegistered = Object.keys(regs).some(k => {
        const r = regs[k];
        return r && typeof r.name === "string" && r.name.trim().toLowerCase() === lower;
      });
      if (alreadyRegistered) {
        joinTournamentAsParticipant(room);
      } else {
        showRegistrationPopup(room, { initialName: myUname, lockName: true });
      }
    }).catch(() => {
      // Lookup failed — fall back to the registration form.
      showRegistrationPopup(room, { initialName: myUname, lockName: true });
    });
  };

  signinBtn.onclick = () => {
    close();
    const user = (typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null;
    if (user && user.uid) {
      enterAfterSignin(user);
    } else if (typeof window.showSignInPopup === "function") {
      window.showSignInPopup({})
        .then(() => {
          const u = (typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null;
          enterAfterSignin(u);
        })
        .catch(() => { /* user cancelled the sign-in popup */ });
    } else {
      // Auth isn't wired on this build — fall through to ranked registration.
      showRegistrationPopup(room);
    }
  };
  // After a successful bulk write the lobby user is connected to the room
  // as participant and dropped into the tournament view — same as the
  // legacy single-name lobby guest flow used to do.
  const joinAsParticipantAfterAdd = () => {
    if (!firebaseReady()) return;
    disconnectSwissRoom();
    localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
    connectSwissRoom(room.editCode, room.viewCode || null, false, false, "participant");
    const hostingTab = document.querySelector('.tournament-sub-tab[data-tournament-view="hosting"]');
    hostingTab?.click();
  };
  const openLobbyBulk = () => {
    showBulkGuestsPopup({
      fromLobby: true,
      editCode: room.editCode,
      afterAdd: joinAsParticipantAfterAdd
    });
  };
  guestBtn.onclick = () => {
    close();
    const user = (typeof window.getCurrentUser === "function") ? window.getCurrentUser() : null;
    if (user && user.uid) { openLobbyBulk(); return; }
    // Best-effort anonymous sign-in for ownership stamping (createdBy = anon
    // uid). If the Anonymous provider isn't enabled, fall through unauthed —
    // the relaxed registrants/$regId rule accepts new isGuest entries with
    // no createdBy during the registering phase.
    const auth = (typeof firebase !== "undefined" && firebase.auth) ? firebase.auth() : null;
    if (!auth || typeof auth.signInAnonymously !== "function") { openLobbyBulk(); return; }
    auth.signInAnonymously()
      .then(openLobbyBulk)
      .catch(err => {
        console.info("Proceeding without anonymous auth:", err && err.code);
        openLobbyBulk();
      });
  };
  cancelBtn.onclick = close;
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
  // asHost is account-scoped (hostUid match) — a co-host joining a room
  // that happens to have been hosted from this device by another account
  // must NOT inherit host rights.
  const asHost = isCurrentUserRoomHost(room);
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

// Drop an already-registered, signed-in player straight into the tournament
// as a participant — no registration popup, since their name + deck are
// already on file. Mirrors joinTournamentAsViewer but tags the session
// role "participant" so the History tab records it correctly.
function joinTournamentAsParticipant(room) {
  if (!firebaseReady()) {
    alert("Live sync isn't configured on this build.");
    return;
  }
  disconnectSwissRoom();
  localStorage.setItem(SWISS_KEY, JSON.stringify({ groups: null, matches: {}, groupRounds: [], phase: "running", registrants: {} }));
  connectSwissRoom(room.editCode, room.viewCode || null, false, false, "participant");
  const hostingTab = document.querySelector('.tournament-sub-tab[data-tournament-view="hosting"]');
  hostingTab?.click();
}

// Tester-only deck builder — produces a 3-slot deck guaranteed to satisfy
// the chosen achievement's creditOnWin condition. Bound to the Auto-build
// button in the Register popup so a tester can quickly verify each
// achievement without hand-rolling parts. Each branch returns hard-coded
// part names sourced from data.js; if a name doesn't match the local DATA
// (e.g. data.js was updated mid-development) the slot's part field will
// be empty and the user can paste a corrected deck.
function buildTestDeckForAchievement(id) {
  // Helper — a standard (BX) slot.
  const std = (blade, ratchet, bit) => ({
    mode: "standard",
    parts: { blade, ratchet, bit }
  });
  switch (id) {
    case "dragonTamer":
      // Needs a Dran / Drake / Dragoon / Wyvern / Bahamut / Ragna part
      // anywhere in the deck — any slot works.
      return [
        std("Dran Sword", "4-50", "Flat"),
        std("Phoenix Wing", "4-55", "Free Flat"),
        std("Knight Lance", "9-65", "Low Flat")
      ];
    case "dragonSlayer":
      // Your deck needs a Knight part. Opponent's deck must have a
      // dragon name — make sure your test opponent's deck does.
      return [
        std("Knight Shield", "4-50", "Flat"),
        std("Knight Lance", "4-55", "Free Flat"),
        std("Dran Sword", "9-65", "Low Flat")
      ];
    case "lonewolf":
      // Exactly one Wolf-named part, on a slot whose combo type is
      // different from the other two. Silver Wolf (15/30/65) + 1-50
      // (18/9/3) + Low Orb (5/25/55) totals 38/64/123 — STA hits 100+,
      // so slot 1 classifies as Stamina. Slot 2 = Attack (Dran Sword
      // pushes ATK ≥ 100). Slot 3 = Balance (Knight Lance + M-85 +
      // Free Flat totals 73/94/40 — no single stat hits 100). Either
      // way, neither slot 2 nor slot 3 is Stamina, so the wolf slot's
      // type is unique across the deck.
      return [
        std("Silver Wolf", "1-50", "Low Orb"),
        std("Dran Sword", "4-50", "Flat"),
        std("Knight Lance", "M-85", "Free Flat")
      ];
    case "rushHour":
      // Clock Mirage (blade) + any Rush-named bit in the SAME slot.
      // Clock Mirage needs a ratchet ending in 5 — 4-55 works.
      return [
        std("Clock Mirage", "4-55", "Rush"),
        std("Dran Sword", "4-50", "Flat"),
        std("Phoenix Wing", "9-65", "Low Flat")
      ];
    case "kingOfJungle":
      // Slot 1: Leon. Slots 2 & 3: each carry a Rhino / Fox / Wolf /
      // Viper / Tiger / Bear / Goat part.
      return [
        std("Leon Claw", "4-50", "Flat"),
        std("Rhino Horn", "4-55", "Free Flat"),
        std("Viper Tail", "9-65", "Low Flat")
      ];
    case "sharknado":
      // Shark Edge on a slot whose total stays Balance (no stat ≥ 100).
      // Shark Edge (60/25/15) + 1-50 (18/9/3) + Low Orb (5/25/55) =
      // 83/59/73 — all under 100 → Balance.
      return [
        std("Shark Edge", "1-50", "Low Orb"),
        std("Dran Sword", "4-50", "Flat"),
        std("Phoenix Wing", "9-65", "Low Flat")
      ];
    case "sorcererSupreme":
      // Every slot must contain a Wizard part. Wizard Arrow and Wizard
      // Rod are blades; the 3rd slot uses CX mode with the "Wizard"
      // lockChip so it also has a Wizard part.
      return [
        std("Wizard Arrow", "4-50", "Flat"),
        std("Wizard Rod", "4-55", "Free Flat"),
        {
          mode: "cx",
          parts: {
            lockChip: "Wizard",
            mainBlade: "Blast",
            assistBlade: "Heavy",
            ratchet: "1-50",
            bit: "Low Orb"
          }
        }
      ];
    case "paleonerd":
      // Every slot must carry a Tyranno / Tricera / Ptera / Mammoth /
      // Brachio part. Three different prehistoric blades fill it cleanly.
      return [
        std("Tyranno Beat", "4-50", "Flat"),
        std("Tricera Press", "4-55", "Free Flat"),
        std("Mammoth Tusk", "9-65", "Low Flat")
      ];
    case "kingOfAllTypes":
      // At least one slot must have Bullet Griffon AND be tuned out of
      // Balance. BG's blade is 45/45/40; pairing it with Quake (55/15/5)
      // pushes the slot to 100/60/45 — ATK hits 100 → Attack type.
      // BG's built-in ratchet means the ratchet field uses the shared
      // NO_RATCHET sentinel so the slot still passes deck validation.
      return [
        { mode: "standard", parts: { blade: "Bullet Griffon", ratchet: NO_RATCHET, bit: "Quake" } },
        std("Dran Sword", "4-50", "Flat"),
        std("Phoenix Wing", "9-65", "Low Flat")
      ];
  }
  return null;
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
  const autoBuildBtn = popup.querySelector("#register-autobuild");
  const selfRegister = !!options.selfRegister;
  const editRegistrantId = options.editRegistrantId || null;
  // Edit mode is implicitly self-managed too (writes via swissRoomRef,
  // no disconnect/reconnect).
  const isEdit = !!editRegistrantId;
  // Guest registrants play normally but don't earn ranking points when
  // the tournament finishes.
  const asGuest = !!options.asGuest;
  // Guests may register without building a deck — the all-3-slots block
  // is lifted for them. Their empty deck contributes nothing to the
  // finish part-usage pie chart (aggregatePartUsage skips empty decks).
  // Real account registrations still need a full 3-combo deck.
  const allowEmptyDeck = asGuest || !!options.allowEmptyDeck;

  const setStatus = (msg, kind) => {
    if (!status) return;
    status.textContent = msg || "";
    status.classList.remove("is-ok", "is-err", "is-pending");
    if (kind) status.classList.add(`is-${kind}`);
  };

  if (subtitle) {
    const name = (room.name || "").trim() || "(unnamed tournament)";
    const modeLabel = tournamentFormatLabel(room.mode, room.pairing, true, room.topN);
    subtitle.textContent = `${name} · ${modeLabel}`;
  }
  // Swap the deck-building hint for guests so it's clear the deck is
  // optional — they can register with the slots left empty. Set both
  // ways explicitly: the popup is shared, so a prior guest open must not
  // leave the guest wording on a later account registration.
  const deckHint = popup.querySelector(".register-deck-hint");
  if (deckHint) {
    deckHint.textContent = allowEmptyDeck
      ? "Deck is optional for guests — you can skip it and leave the slots empty. To add combos, tap a slot or paste a deck from the Deck tab."
      : "Build the 3-combo deck you'll bring. The judge sees this deck at every match. Tip: copy a deck from the Deck tab, then paste it here.";
  }
  // `lockName` makes the name field read-only (used by the "Register myself"
  // flow so the host can't impersonate someone else from their own device).
  const lockName = !!options.lockName;
  if (nameInput) {
    nameInput.value = options.initialName || "";
    nameInput.readOnly = lockName;
    nameInput.classList.toggle("is-readonly", lockName);
  }
  if (submitBtn) {
    // Submit button shows an icon next to its label; the label flips between
    // Save (when editing a registrant) and Register (for new registrations).
    const submitIcon = isEdit ? "assets/icons/diskette.png" : "assets/icons/verify.png";
    const submitLabel = isEdit ? "Save" : "Register";
    submitBtn.innerHTML = `<img src="${submitIcon}" alt="" onerror="this.style.display='none'"><span class="btn-label">${submitLabel}</span>`;
  }
  setStatus("");
  // Deck source, in priority order:
  //   1. an explicit initialDeck (editing an existing registrant)
  //   2. the user's pinned "default" deck from the Deck tab — but only when
  //      registering THEMSELVES (lockName / selfRegister), so a host adding a
  //      guest or another player still starts from an empty deck
  //   3. an empty deck
  let usedPinnedDeck = false;
  let deck;
  if (options.initialDeck && Array.isArray(options.initialDeck)) {
    deck = normalizeBeyCheckDeck(options.initialDeck);
  } else {
    let pinned = null;
    if ((options.selfRegister || options.lockName) && typeof window.getDefaultRegistrationDeck === "function") {
      try { pinned = window.getDefaultRegistrationDeck(); } catch (e) { pinned = null; }
    }
    if (pinned) { deck = normalizeBeyCheckDeck(pinned); usedPinnedDeck = true; }
    else deck = emptyBeyCheckDeck();
  }

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
  if (usedPinnedDeck) setStatus("Loaded your pinned deck — review it before registering.", "ok");

  popup.classList.remove("hidden");
  // No auto-focus when the name field is locked — nothing to type there.
  if (!lockName) setTimeout(() => nameInput?.focus(), 0);

  const close = () => {
    popup.classList.add("hidden");
    submitBtn.onclick = null;
    cancelBtn.onclick = null;
    if (pasteBtn) pasteBtn.onclick = null;
    if (autoBuildBtn) autoBuildBtn.onclick = null;
    if (nameInput) nameInput.onkeydown = null;
  };
  cancelBtn.onclick = close;

  // Tester-only Auto-build button. Hidden by default; revealed only for
  // accounts tagged "Tester" so a tester can quickly drop in a deck that
  // satisfies a specific achievement and verify the counter increments.
  if (autoBuildBtn) {
    const showAuto = typeof window.isTester === "function" && window.isTester();
    autoBuildBtn.classList.toggle("hidden", !showAuto);
    if (showAuto) {
      autoBuildBtn.onclick = () => {
        const defs = (window.ACHIEVEMENTS || []);
        if (!defs.length) {
          setStatus("Achievements module not loaded — can't auto-build.", "err");
          return;
        }
        // Number-picker prompt. Cheap UX for a dev tool — no separate popup
        // needed.
        const lines = defs.map((d, i) => `${i + 1}. ${d.title}`).join("\n");
        const raw = window.prompt(
          "Auto-build a test deck for which achievement?\n\n" + lines + "\n\nEnter a number 1-" + defs.length + ":",
          "1"
        );
        if (raw == null) return; // cancelled
        const idx = parseInt(String(raw).trim(), 10) - 1;
        if (!(idx >= 0 && idx < defs.length)) {
          setStatus("Invalid selection — pick a number from the list.", "err");
          return;
        }
        const built = buildTestDeckForAchievement(defs[idx].id);
        if (!built) {
          setStatus("No builder for that achievement.", "err");
          return;
        }
        deck = normalizeBeyCheckDeck(built);
        renderSlots();
        setStatus(`Built test deck for "${defs[idx].title}".`, "ok");
      };
    }
  }

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
    const missingSlots = emptyBeyCheckDeckSlotNumbers(deck);
    if (missingSlots.length && !allowEmptyDeck) {
      // Hard block — every registrant needs all 3 slots built. The judge
      // sees this 3-combo deck at every match, so a partial registration
      // breaks the bey-check flow. Tap any empty slot to build it, or
      // paste a copied 3-slot deck from the Deck tab.
      const slotList = missingSlots.length === 1
        ? `Slot ${missingSlots[0]}`
        : missingSlots.length === BEY_CHECK_DECK_SIZE
          ? "all 3 slots"
          : "Slots " + missingSlots.join(" & ");
      const msg = isEdit
        ? `Fill ${slotList} before saving — every registrant needs a full 3-combo deck.`
        : `Fill ${slotList} before registering — every registrant needs a full 3-combo deck. Tap an empty slot, or paste from the Deck tab.`;
      setStatus(msg, "err");
      return;
    }
    // Stricter check for signed-in registrants: every slot must be COMPLETE
    // for its mode (blade-only / blade+ratchet-only counts as incomplete).
    // Guests are exempt (allowEmptyDeck covers both "skip the deck" and
    // "save a partial deck").
    if (!allowEmptyDeck) {
      const incompleteSlots = incompleteBeyCheckDeckSlotNumbers(deck);
      if (incompleteSlots.length) {
        const slotList = incompleteSlots.length === 1
          ? `Slot ${incompleteSlots[0]}`
          : incompleteSlots.length === BEY_CHECK_DECK_SIZE
            ? "all 3 slots"
            : "Slots " + incompleteSlots.join(" & ");
        const msg = isEdit
          ? `${slotList} ${incompleteSlots.length === 1 ? "is" : "are"} missing parts — every slot needs every required part (blade, ratchet, bit, plus any mode-specific parts) before saving.`
          : `${slotList} ${incompleteSlots.length === 1 ? "is" : "are"} missing parts — every slot needs every required part (blade, ratchet, bit, plus any mode-specific parts) before registering.`;
        setStatus(msg, "err");
        return;
      }
    }
    // Banned-parts check — reject the deck if it uses any part the host
    // banned for this tournament. We read the latest local state so an
    // updated ban list (pushed live from the host) blocks immediately.
    const banned = findBannedPartsInDeck(deck, getBannedParts(loadSwiss()));
    if (banned.length) {
      const names = banned.map(h => `${h.name} (Slot ${h.slot})`).join(", ");
      setStatus(`This tournament bans: ${names}. Swap them out before submitting.`, "err");
      return;
    }
    submitRegistration(room, name, deck, setStatus, close, { selfRegister, editRegistrantId, asGuest });
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

// Uniform random ratchet ending in "5", honouring the per-deck `used`
// exclusion. Falls back to ignoring `used` only when every -5 ratchet has
// already been taken by another slot — better to repeat than to leave a
// Clock Mirage slot with no ratchet at all.
function pickClockMirageRatchet(used) {
  const arr = DATA.ratchets || [];
  const baseFilter = p => p && !isExclusive(p) && p.name && p.name.endsWith("5");
  const tiers = [
    arr.filter(p => baseFilter(p) && !used.has(p.name)),
    arr.filter(baseFilter)
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

  // standard — honour expandCx blades (no ratchet, e.g. Bullet Griffon) and
  // Clock Mirage (ratchet must end in "5") the same way the calculator's
  // selectMeta does.
  const blade = pickMetaFrom(DATA.blades || [], used);
  const codename = blade?.codename || "";
  if (isExpandCxBlade(blade)) {
    // No ratchet slot → record NO_RATCHET explicitly so the slot reads as
    // "complete" everywhere (matches what the form auto-fills when a user
    // picks an expandCx blade in Bey Check).
    return { mode, parts: { blade: blade.name, ratchet: NO_RATCHET, bit: bitName } };
  }
  if (codename === "CLOCKMIRAGE") {
    // Clock Mirage requires a ratchet ending in "5", and no -5 ratchet is
    // flagged meta in DATA. The generic pickMetaFrom would just churn
    // through empty meta tiers before falling back to a uniform pick from
    // the -5 pool — short-circuit straight to that pool (still honouring
    // the deck-wide `used` exclusion so a Clock Mirage slot can't repeat
    // a ratchet already locked in by another slot in the same deck).
    const ratchet = pickClockMirageRatchet(used);
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

    // The host (or co-host) running Test mode owns every synthetic entry —
    // stamp their UID so the registrants/$regId rule treats these like any
    // other host-created registrant (host/co-host can edit/delete them
    // anytime, the originating account additionally retains "creator"
    // rights during registering).
    const writerUid = (window.getCurrentUser && window.getCurrentUser()?.uid) || null;
    // Don't blow past the participant cap — trim the batch to what fits.
    const remaining = capSlotsRemaining(remote);
    if (remaining <= 0) { alert("This tournament is full."); return; }
    const target = Math.min(count, remaining);
    const updates = {};
    let added = 0;
    let nextNum = 1;
    while (added < target) {
      const name = `Tester ${nextNum++}`;
      if (usedNames.has(name.toLowerCase())) continue;
      usedNames.add(name.toLowerCase());
      const id = generateRegistrantId();
      const entry = { name, deck: buildMetaDeck() };
      if (writerUid) entry.createdBy = writerUid;
      updates[`registrants/${id}`] = entry;
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
  const asGuest = !!options.asGuest;
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

      // Participant cap — block NEW registrants once the room is full. Edits
      // (same regId) don't count against the cap. Checked against the fresh
      // snapshot so concurrent sign-ups can't slip past the limit.
      if (!isEdit && capSlotsRemaining(remote) <= 0) {
        throw new Error("This tournament is full — registration is closed.");
      }

      const id = editRegistrantId || generateRegistrantId();
      const payload = { name: name.trim(), deck };
      // Preserve the existing guest flag when editing in place — the
      // edit popup doesn't carry asGuest, but the overwrite below would
      // otherwise drop the flag and silently grant ranking points to
      // someone who was registered as a guest or via Register Others.
      const prevReg = (remote.registrants && remote.registrants[id]) || null;
      if (asGuest || (isEdit && prevReg && prevReg.isGuest)) payload.isGuest = true;
      // Editing a registrant overwrites the whole entry — keep their fee-paid
      // flag so a deck/name edit doesn't silently reset "Paid" to unpaid.
      if (isEdit && prevReg && prevReg.paid) payload.paid = true;
      // Stamp the writer's UID onto the entry so the registrants/$regId
      // rule can scope edits during the registering phase to the
      // original creator (otherwise any authed user could rewrite anyone
      // else's deck/name before Start). On edit we preserve the existing
      // createdBy — host/co-host edits must NOT change the owner.
      const writerUid = (window.getCurrentUser && window.getCurrentUser()?.uid) || null;
      if (prevReg && typeof prevReg.createdBy === "string" && prevReg.createdBy) {
        payload.createdBy = prevReg.createdBy;
      } else if (writerUid) {
        payload.createdBy = writerUid;
      }
      if (!isEdit) setStatus("Submitting…", "pending");
      return roomRef.child("registrants/" + id).set(payload)
        .then(() => {
          // Remember this entry locally so the user can self-cancel later
          // via Leave Room. Authed registrants don't strictly need this
          // (createdBy matches their uid for the rule check), but tracking
          // both keeps the code path uniform — and is the only way to
          // cancel an unauthed guest entry (no createdBy stamp).
          if (!isEdit) rememberDeviceOwnedRegIds(editCode, [id]);
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

// ===================== BATTLE ROYALE MONTHLY ROLLOVER =====================
// BR points are no longer minted per-tournament. Instead, at the turn of each
// month the global /ranking leaderboard is "settled": every player's accumulated
// ranking total is converted into Battle Royale points (credited to the matching
// account's BR balance), then /ranking is wiped so the new month starts at zero.
//
// There's no server cron, so this runs lazily on the client — the first eligible
// visitor after the month changes performs the settlement. Eligible = a Judge,
// because the DB rules require the Judge tag to write another player's BR points;
// a non-Judge would clear the ranking without crediting anyone. A claimed month
// marker at battleRoyale/meta/lastRolloverMonth makes it run at most once a month.

// Current accrual month as "YYYY-MM" (local time).
function currentRolloverMonth() {
  const d = new Date();
  const m = d.getMonth() + 1;
  return d.getFullYear() + "-" + (m < 10 ? "0" + m : "" + m);
}

let brRolloverChecked = false;
function maybeRunBattleRoyaleMonthlyRollover() {
  if (brRolloverChecked) return;
  if (!firebaseReady()) return;
  // Only a Judge can write other players' BR points, so only a Judge runs the
  // settlement. Bail WITHOUT latching the flag until the Judge tag is known —
  // tags load after auth, so an early call must be allowed to retry.
  if (typeof window.isJudge !== "function" || !window.isJudge()) return;
  const db = initFirebase();
  if (!db) return;
  brRolloverChecked = true; // Judge confirmed — run the check at most once per load.

  const month = currentRolloverMonth();
  const markerRef = db.ref("battleRoyale/meta/lastRolloverMonth");
  markerRef.once("value").then(snap => {
    const prev = snap.val();
    if (prev === month) return; // already settled for the current month
    // Claim the new month atomically so two clients can't both settle it.
    markerRef.transaction(
      cur => (cur === month ? undefined : month),
      (err, committed) => {
        if (err || !committed) return; // another client claimed it first
        // First run ever (no prior marker): just establish the baseline month.
        // The existing ranking pre-dates this system, so don't credit/reset it.
        if (prev == null) return;
        settleRankingIntoBattleRoyale(db);
      }
    );
  }).catch(() => {});
}

// Read the leaderboard + username index once, credit each matched account's BR
// balance with its ranking total, then wipe /ranking. Names with no matching
// account (guests / unregistered) are dropped — they can't hold BR points.
function settleRankingIntoBattleRoyale(db) {
  Promise.all([
    db.ref("ranking").once("value"),
    db.ref("usernames").once("value")
  ]).then(([rankSnap, userSnap]) => {
    const ranking = rankSnap.val() || {};
    const usernames = userSnap.val() || {};
    const credit = {}; // uid -> { points, name }
    Object.entries(ranking).forEach(([key, v]) => {
      const pts = (v && Number(v.points)) || 0;
      const name = (v && v.name) || key;
      if (pts <= 0 || isTestRegistrant(name)) return;
      const uid = usernames[key] && usernames[key].uid;
      if (!uid) return; // guest / unregistered -> dropped on reset
      if (!credit[uid]) credit[uid] = { points: 0, name };
      credit[uid].points += pts;
    });
    const writes = Object.entries(credit).map(([uid, info]) =>
      new Promise(resolve => {
        const ref = db.ref("battleRoyale/players/" + uid);
        ref.child("points").transaction(
          p => (Number(p) || 0) + info.points,
          () => {
            if (info.name) ref.child("username").set(String(info.name).slice(0, 30)).catch(() => {});
            resolve();
          }
        );
      })
    );
    // Wipe the leaderboard only once every credit has landed, so a mid-way
    // failure never clears ranking without writing the matching BR points.
    Promise.all(writes).then(() => {
      db.ref("ranking").set(null).catch(() => {});
    }).catch(() => {});
  }).catch(() => {});
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
      // Battle Royale points are NOT minted per-tournament anymore. The global
      // ranking accumulates through the month and is converted into BR points
      // at the monthly rollover (see maybeRunBattleRoyaleMonthlyRollover).
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
  const registrants = state?.registrants || {};
  // Guests play the bracket like normal participants but never earn ranking
  // points — collect their names so set() can short-circuit on them.
  const guestNames = new Set();
  Object.values(registrants).forEach(r => {
    if (r && r.isGuest && typeof r.name === "string") guestNames.add(r.name);
  });
  const matchResult = m => {
    if (!m || m.scoreA == null || m.scoreB == null || m.scoreA === m.scoreB) return null;
    const aWon = m.scoreA > m.scoreB;
    return { winner: aWon ? m.a : m.b, loser: aWon ? m.b : m.a };
  };
  const awards = {};
  const set = (name, pts) => {
    if (!name || !pts) return;
    if (guestNames.has(name)) return;
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
  // Everyone else who participated → +1. Guests still play but skip the
  // participation point so they stay off the leaderboard entirely.
  getParticipants(state).forEach(name => {
    if (!name || guestNames.has(name)) return;
    if (awards[name] == null) awards[name] = 1;
  });
  return awards;
}

function syncTournamentRankingAwards(state) {
  if (!swissCanEdit || !swissRoomRef) return;
  if (state?.ranked !== true) return; // unranked tournament → skip ranking writes
  if (!tournamentIsDecided(state)) return; // wait until final + 3rd-place are settled
  const awards = computeTournamentRankingAwards(state);
  Object.entries(awards).forEach(([name, points]) => awardPlayerIfNew(name, points));
  // Any participant whose account is tagged "Revox Member" or "Revox Admin"
  // (looked up via the public `revoxAccounts` index — see auth.js
  // PUBLIC_TAG_INDEXES) and finishes in the Top 8 also gets a Revox ranking
  // entry, scored Top-8-style. Fetch the index once and pass the resolved
  // name-set down so we don't fan out one read per placing.
  const placings = computeTournamentRevoxPlacings(state);
  if (!Object.keys(placings).length) return;
  const tName = (state.tournamentName || "").trim();
  const dateStr = todayISO();
  fetchRevoxAccountNameSet().then(revoxNameSet => {
    Object.entries(placings).forEach(([name, placing]) => {
      awardRevoxIfNew(name, placing, tName, dateStr, revoxNameSet);
    });
  }).catch(e => console.warn("Revox auto-award lookup failed:", e));
}

// Read the public `revoxAccounts` index once and return a Set of
// case-folded usernames covered by it. Used to gate auto-Revox-ranking
// entries on the Revox Member / Revox Admin tags. Falls back to an
// empty set on read failure (rule not published, offline, etc.) so a
// failed lookup never accidentally awards everyone.
function fetchRevoxAccountNameSet() {
  const db = initFirebase();
  if (!db) return Promise.resolve(new Set());
  const indexMap = window.PUBLIC_TAG_INDEX_NODES || {};
  const node = indexMap["Revox Member"] || indexMap["Revox Admin"] || "revoxAccounts";
  return db.ref(node).once("value").then(snap => {
    const v = snap.val() || {};
    const set = new Set();
    Object.values(v).forEach(u => {
      if (typeof u === "string" && u) set.add(u.trim().toLowerCase());
    });
    return set;
  });
}

// Compute each Top-8 finisher's placing (1–4 by bracket, 5 for everyone else
// in the knockout bracket). Guests and test registrants are excluded.
function computeTournamentRevoxPlacings(state) {
  const matches = state?.matches || {};
  const registrants = state?.registrants || {};
  const guestNames = new Set();
  Object.values(registrants).forEach(r => {
    if (r && r.isGuest && typeof r.name === "string") guestNames.add(r.name);
  });
  const matchResult = m => {
    if (!m || m.scoreA == null || m.scoreB == null || m.scoreA === m.scoreB) return null;
    const aWon = m.scoreA > m.scoreB;
    return { winner: aWon ? m.a : m.b, loser: aWon ? m.b : m.a };
  };
  const placings = {};
  const set = (name, p) => {
    if (!name || guestNames.has(name) || isTestRegistrant(name)) return;
    if (placings[name] == null || p < placings[name]) placings[name] = p;
  };
  const f = matchResult(matches["bracket-f-0"]);
  if (f) { set(f.winner, 1); set(f.loser, 2); }
  const third = matchResult(matches["bracket-3rd-0"]);
  if (third) { set(third.winner, 3); set(third.loser, 4); }
  // Top 8 = anyone who reached the knockout bracket.
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
  topEight.forEach(name => set(name, 5));
  return placings;
}

// Award Revox ranking once per tournament per player, guarded by an
// `awarded/revox/{key}` slot inside the room so a re-firing listener
// can't double-count. Gated on the `revoxAccounts` index (= accounts
// tagged "Revox Member" or "Revox Admin") — `revoxNameSet` is the
// lowercased Set produced by fetchRevoxAccountNameSet.
function awardRevoxIfNew(name, placing, tournamentName, dateStr, revoxNameSet) {
  if (!swissRoomRef || !placing) return;
  const cleanName = String(name || "").trim();
  if (!cleanName) return;
  if (!revoxNameSet || !revoxNameSet.has(cleanName.toLowerCase())) return;
  if (isTestRegistrant(cleanName)) return;
  const key = rankingKey(cleanName);
  if (!key) return;
  const slotRef = swissRoomRef.child("awarded/revox/" + key);
  slotRef.transaction(
    prev => prev != null ? undefined : { name: cleanName, placing },
    (err, committed) => {
      if (err || !committed) return;
      const pts = revoxPointsForPlacing(placing);
      if (pts > 0) {
        addRevoxEntry(cleanName, pts, tournamentName, placing, dateStr).catch(e => {
          console.warn("Revox auto-award failed:", e);
        });
      }
    }
  );
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
      // Seed the medal cache so profile cards can show Gold / Silver /
      // Bronze Player tags for the current top 3.
      setRankingMedalCache(list);
      if (!list.length) {
        container.innerHTML = `<p class="tournament-results-empty">No tournament results yet. Finish an online tournament to start earning ranking points (1st = +5, 2nd = +4, 3rd = +3, top 8 = +2, participation = +1). Same names merge across tournaments.</p>`;
        return;
      }
      const rows = list.map((r, i) => {
        const placeMod = i < 3 ? ` tournament-results-place-${i + 1}` : "";
        const rankNameAttr = r.name ? ` data-rank-name="${escapeHtml(r.name)}"` : "";
        return `
          <div class="tournament-results-row tournament-ranking-row${placeMod}"${rankNameAttr}>
            <span class="tournament-results-place">#${i + 1}</span>
            <span class="tournament-results-player"${r.name ? ` data-profile-username="${escapeHtml(r.name)}"` : ""}>${swissNameCellInner(r.name)}</span>
            <span class="tournament-ranking-points">${r.points} pt${r.points === 1 ? "" : "s"}</span>
          </div>
        `;
      }).join("");
      container.innerHTML = `<div class="tournament-results-list">${rows}</div>`;
      // Swap the silhouette placeholders for real profile photos, make each
      // name open the profile dropdown on click / hover, and paint each
      // row with the player's profile banner as its background.
      hydrateTournamentAvatars(container);
      bindTournamentProfileNames(container);
      hydrateRankingBanners(container);
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
    // The row mirror is the most recent result by date — not whichever was
    // added last (results can be entered out of chronological order).
    let latest = null;
    Object.keys(results).forEach(k => {
      const r = results[k] || {};
      if (!latest || String(r.date || "") > String(latest.date || "")) latest = r;
    });
    return {
      name: (curr && curr.name) || cleanName,
      points: ((curr && Number(curr.points)) || 0) + pts,
      tournament: (latest && latest.tournament) || "",
      placing: (latest && Number(latest.placing)) || 0,
      date: (latest && latest.date) || "",
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

// Fill the Add-result name dropdown with accounts tagged "Revox Member"
// or "Revox Admin", merged with any existing ranking members. The list is
// sourced from the public `revoxAccounts` index node (maintained by the
// Developer page's tag controls — see auth.js PUBLIC_TAG_INDEXES) so this
// works without read access to the whole users tree. If the read fails
// (rule not yet published, offline, etc.) the dropdown quietly falls
// back to existing ranking members only.
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
  paint(); // existing ranking members show immediately
  const db = initFirebase();
  if (!db) return;
  // Resolve the index node from the shared tag→index map so the key never
  // drifts between auth.js and this read site.
  const indexMap = window.PUBLIC_TAG_INDEX_NODES || {};
  const node = indexMap["Revox Member"] || indexMap["Revox Admin"] || "revoxAccounts";
  db.ref(node).once("value").then(snap => {
    const val = snap.val() || {};
    Object.values(val).forEach(u => {
      if (typeof u === "string" && u) names.add(u);
    });
    paint();
  }).catch(() => { /* index not readable yet — ranking members only */ });
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
        .map(([key, v]) => {
          // The tournament + date shown are the member's most recent result
          // (by date), derived from their results history — so it stays
          // correct even if results were entered out of order.
          let latest = null;
          const results = (v && v.results) || {};
          Object.keys(results).forEach(k => {
            const r = results[k] || {};
            if (!latest || String(r.date || "") > String(latest.date || "")) latest = r;
          });
          return {
            key,
            name: (v && v.name) || key,
            points: (v && Number(v.points)) || 0,
            tournament: latest ? (latest.tournament || "") : ((v && v.tournament) || ""),
            placing: latest ? (Number(latest.placing) || 0) : ((v && Number(v.placing)) || 0),
            date: latest ? (latest.date || "") : ((v && v.date) || "")
          };
        })
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
        // data-rank-name / data-rank-place on the row drive the banner
        // background; the avatar img's data-reg-name drives the photo —
        // both hydrated below via the shared tournament helpers.
        const rankNameAttr = r.name ? ` data-rank-name="${escapeHtml(r.name)}" data-rank-place="${i + 1}"` : "";
        return `
          <div class="tournament-results-row tournament-ranking-row revox-row${placeMod}"${rankNameAttr}>
            <span class="tournament-results-player">
              <img class="swiss-name-avatar" src="${PROFILE_VIEW_PHOTO_PH}" alt=""${r.name ? ` data-reg-name="${escapeHtml(r.name)}"` : ""}>
              <span class="revox-name-stack">
                <button type="button" class="revox-name-btn" data-revox-history="${escapeHtml(r.key)}" data-revox-name="${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>
                ${subLines}
              </span>
            </span>
            <span class="revox-row-placing">${ordinalPlace(i + 1)}</span>
            <span class="tournament-ranking-points">${r.points} pt${r.points === 1 ? "" : "s"}</span>
            ${adminBtns}
          </div>
        `;
      }).join("");
      container.innerHTML = `<div class="tournament-results-list">${rows}</div>`;
      // Profile photos beside each name, and the member's banner behind
      // each row — same helpers as the tournament ranking.
      hydrateTournamentAvatars(container);
      hydrateRankingBanners(container);
      // Clicking a member name opens their tournament history popup, which
      // already leads with the full profile (banner, photo, tags, bio) — so
      // there's no separate hover profile dropdown here (it would otherwise
      // race the history popup and float on top of it).
      container.querySelectorAll("[data-revox-history]").forEach(btn => {
        btn.addEventListener("click", () => {
          showRevoxHistory(btn.dataset.revoxHistory, btn.dataset.revoxName);
        });
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
    if (photoEl) {
      if (p.photo) photoEl.src = p.photo;
      photoEl.style.objectPosition = p.photoPos || "50% 50%";
    }
    if (bannerEl) {
      if (p.banner) bannerEl.src = p.banner;
      bannerEl.style.objectPosition = p.bannerPos || "50% 50%";
    }
    if (tagsEl) tagsEl.innerHTML = withMedalTagBadge(revoxTagBadges(p), name);
    if (bioEl) {
      bioEl.textContent = p.bio || "";
      bioEl.style.display = p.bio ? "" : "none";
    }
  }).catch(() => {});
}

// Show/label the "Add Friend" button in the profile popup for the member being
// viewed. Hidden when not signed in, viewing your own profile, or the Friends
// feature isn't loaded. Labelled by current friendship status.
function refreshHistoryAddFriendBtn(name) {
  const btn = document.getElementById("revox-history-add-friend");
  if (!btn) return;
  btn.dataset.member = name || "";
  btn.classList.add("hidden");
  btn.disabled = false;
  btn.textContent = "Add Friend";
  if (!name || typeof window.friendStatusWithUsername !== "function") return;
  // Never offer to befriend yourself.
  if (isOwnUsername(name)) return;
  window.friendStatusWithUsername(name).then(status => {
    if ((btn.dataset.member || "") !== (name || "")) return; // popup moved on
    if (status === null || status === "self") return;        // not signed in / own profile
    if (status === "friends") return;                        // already friends — no button
    btn.classList.remove("hidden");
    if (status === "requested")     { btn.textContent = "Requested"; btn.disabled = true; }
    else if (status === "incoming") { btn.textContent = "Accept Friend"; }
    else                            { btn.textContent = "Add Friend"; }
  });
}

function showRevoxHistory(key, name) {
  const popup = document.getElementById("revox-history-popup");
  const titleEl = document.getElementById("revox-history-title");
  const listEl = document.getElementById("revox-history-list");
  if (!popup || !listEl || !key) return;
  // The name was hovered before this click — close that hover profile card
  // so it doesn't float over the history popup.
  hideProfileDropdown();
  if (titleEl) titleEl.textContent = name || "Member";
  refreshHistoryAddFriendBtn(name);
  // Reset the header, then load this member's profile photo + tags above the
  // joined-events list.
  const photoEl = document.getElementById("revox-history-photo");
  const bannerEl = document.getElementById("revox-history-banner");
  const tagsEl = document.getElementById("revox-history-tags");
  const bioEl = document.getElementById("revox-history-bio");
  const wrEl = document.getElementById("revox-history-winrate");
  if (photoEl) photoEl.src = PROFILE_VIEW_PHOTO_PH;
  if (bannerEl) bannerEl.src = PROFILE_VIEW_BANNER_PH;
  if (tagsEl) tagsEl.innerHTML = "";
  if (bioEl) { bioEl.textContent = ""; bioEl.style.display = "none"; }
  if (wrEl) { wrEl.textContent = ""; wrEl.classList.add("hidden"); }
  loadRevoxHeaderProfile(name);
  // Public /winRates read. Same shape and rendering as the profile dropdown
  // and account card, so the same person sees the same numbers wherever
  // their stats appear.
  if (wrEl && name) {
    const db = initFirebase();
    if (db) {
      db.ref("winRates/" + winRateKey(name)).once("value").then(snap => {
        const v = snap.val();
        const wins = (v && v.wins) || 0;
        const losses = (v && v.losses) || 0;
        const ties = (v && v.ties) || 0;
        const total = wins + losses + ties;
        if (total === 0) return; // no data → leave hidden
        const pct = Math.round((wins / total) * 100);
        const tieBit = ties > 0 ? ` · ${ties}T` : "";
        wrEl.textContent = `Win rate ${pct}% — ${wins}W / ${losses}L${tieBit}`;
        wrEl.classList.remove("hidden");
      }).catch(() => { /* read failed → leave hidden */ });
    }
  }
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

  // Auto-advance the focus through Tournament -> Date -> Name -> Placing so
  // the admin doesn't have to tap each field as they go.
  const openPlacingDropdown = () => {
    const ddBtn = placingDropdown?.querySelector(".setting-dropdown-btn");
    const ddMenu = placingDropdown?.querySelector(".setting-dropdown-menu");
    if (!ddBtn || !ddMenu) return;
    ddMenu.classList.remove("hidden");
    ddBtn.focus();
  };
  if (tournamentEl) {
    tournamentEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); dateEl?.focus(); }
    });
  }
  if (dateEl) {
    dateEl.addEventListener("change", () => {
      if (nameEl && !nameEl.readOnly) nameEl.focus();
      else openPlacingDropdown();
    });
  }
  if (nameEl) {
    nameEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); openPlacingDropdown(); }
    });
  }

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

  // "Add Friend" in the profile popup — send (or accept) a friend request to the
  // member being viewed, then re-label the button.
  document.getElementById("revox-history-add-friend")?.addEventListener("click", () => {
    const btn = document.getElementById("revox-history-add-friend");
    const member = btn?.dataset.member || "";
    if (!member || typeof window.friendActionByUsername !== "function") return;
    btn.disabled = true;
    window.friendActionByUsername(member).then(() => {
      setTimeout(() => refreshHistoryAddFriendBtn(member), 500);
    });
  });

  // "Add Friend" inside the hover profile dropdown.
  document.getElementById("profile-view-add-friend")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = document.getElementById("profile-view-add-friend");
    const member = btn?.dataset.member || "";
    if (!member || typeof window.friendActionByUsername !== "function") return;
    btn.disabled = true;
    cancelProfileDropdownHide();
    window.friendActionByUsername(member).then(() => {
      setTimeout(() => refreshProfileViewAddFriendBtn(member), 500);
    });
  });
})();
