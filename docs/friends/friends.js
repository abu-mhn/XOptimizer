// docs/friends/friends.js — Friends + direct messages.
//
// Add a friend by username → they get a request → on accept you're friends and
// can DM each other. Built on Firebase Realtime Database, mirroring the Battle
// Royale tab's patterns (live listeners + toast / OS notifications).
//
// Data model:
//   friends/{uid}/{friendUid}: { name, status, ts }
//     status: "requested" (I sent) | "incoming" (they sent me) | "friends"
//   messages/{threadId}/{pushId}: { from, fromName, text, ts }
//     threadId = the two uids sorted and joined with "_"
(function () {
  "use strict";

  const FRIENDS_REF = "friends";
  const MESSAGES_REF = "messages";

  let dbHandle = null;
  let friendsCache = {};         // friendUid -> { name, status, ts }
  let listenersBound = false;
  let activeChat = null;         // friendUid of the open conversation
  let activeThreadRef = null;    // live ref for the open conversation
  let activeMessages = [];       // messages of the open conversation
  const unread = {};             // friendUid -> count
  const threadSeen = {};         // threadId -> Set of seen message ids
  const threadRefs = {};         // threadId -> ref (per-friend unread listener)
  let friendsSeen = null;        // friendUid -> status, for request-notification diffing

  // ---- helpers ----
  function db() {
    if (dbHandle) return dbHandle;
    try { if (typeof firebase !== "undefined" && firebase.database) dbHandle = firebase.database(); }
    catch (e) { dbHandle = null; }
    return dbHandle;
  }
  function myUid() { const u = window.getCurrentUser && window.getCurrentUser(); return u ? u.uid : null; }
  function myName() { return (window.getCurrentUsername && window.getCurrentUsername()) || ""; }
  function tabVisible() {
    const f = document.getElementById("form-friends");
    return !!(f && !f.classList.contains("hidden"));
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function nowIso() { return new Date().toISOString(); }
  function usernameKeyFor(name) {
    if (window.usernameKey) return window.usernameKey(name);
    return String(name || "").trim().toLowerCase().replace(/[.#$/\[\]]/g, "_");
  }
  function threadIdFor(a, b) { return [a, b].sort().join("_"); }
  function fmtTime(iso) {
    try { const d = new Date(iso); return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch (e) { return ""; }
  }

  function notify(title, body) {
    if (typeof showBrToast === "function") { try { showBrToast(title, body); return; } catch (e) {} }
    // Fallback toast container.
    let host = document.getElementById("match-toasts");
    if (!host) { host = document.createElement("div"); host.id = "match-toasts"; host.className = "match-toasts"; document.body.appendChild(host); }
    const card = document.createElement("div");
    card.className = "match-toast match-toast-mine";
    card.innerHTML = `<div class="match-toast-head"><span class="match-toast-tag">${esc(title)}</span></div><div class="match-toast-where">${esc(body)}</div>`;
    host.appendChild(card);
    setTimeout(() => card.remove(), 8000);
    if (typeof maybeFireSystemNotification === "function") { try { maybeFireSystemNotification(title, body); } catch (e) {} }
  }

  // ---- friend actions ----
  function addFriendByUsername(rawName) {
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const name = (rawName || "").trim();
    if (!name) return;
    if (name.toLowerCase() === myName().toLowerCase()) { alert("You can't add yourself."); return; }
    database.ref("usernames/" + usernameKeyFor(name) + "/uid").once("value").then(snap => {
      const otherUid = snap.val();
      if (!otherUid) { alert(`No player found with the username "${name}".`); return; }
      if (otherUid === uid) { alert("You can't add yourself."); return; }
      if (friendsCache[otherUid]) {
        const st = friendsCache[otherUid].status;
        alert(st === "friends" ? "You're already friends." : st === "requested" ? "You already sent them a request." : "They already sent you a request — accept it below.");
        return;
      }
      // Resolve their display name (best effort), then write both sides.
      database.ref("usernames/" + usernameKeyFor(name) + "/username").once("value").then(uSnap => {
        const otherName = uSnap.val() || name;
        const updates = {};
        updates[`${FRIENDS_REF}/${uid}/${otherUid}`] = { name: otherName, status: "requested", ts: nowIso() };
        updates[`${FRIENDS_REF}/${otherUid}/${uid}`] = { name: myName(), status: "incoming", ts: nowIso() };
        database.ref().update(updates).catch(e => alert("Couldn't send request: " + ((e && e.message) || e)));
      });
    }).catch(() => alert("Couldn't look up that username."));
  }

  function acceptRequest(otherUid) {
    const uid = myUid(), database = db();
    if (!uid || !database) return;
    const updates = {};
    updates[`${FRIENDS_REF}/${uid}/${otherUid}/status`] = "friends";
    updates[`${FRIENDS_REF}/${otherUid}/${uid}/status`] = "friends";
    database.ref().update(updates).catch(() => {});
  }
  function removeFriend(otherUid) {
    const uid = myUid(), database = db();
    if (!uid || !database) return;
    const updates = {};
    updates[`${FRIENDS_REF}/${uid}/${otherUid}`] = null;
    updates[`${FRIENDS_REF}/${otherUid}/${uid}`] = null;
    database.ref().update(updates).catch(() => {});
    if (activeChat === otherUid) closeChat();
  }

  // ---- messaging ----
  function sendMessage(text) {
    const uid = myUid(), database = db();
    const msg = (text || "").trim();
    if (!uid || !database || !activeChat || !msg) return;
    const tid = threadIdFor(uid, activeChat);
    database.ref(`${MESSAGES_REF}/${tid}`).push({
      from: uid, fromName: myName(), text: msg.slice(0, 1000), ts: nowIso()
    }).catch(e => alert("Couldn't send: " + ((e && e.message) || e)));
  }

  function openChat(friendUid) {
    if (!friendsCache[friendUid] || friendsCache[friendUid].status !== "friends") return;
    closeChatRefOnly();
    activeChat = friendUid;
    unread[friendUid] = 0;
    activeMessages = [];
    const tid = threadIdFor(myUid(), friendUid);
    activeThreadRef = db().ref(`${MESSAGES_REF}/${tid}`).limitToLast(200);
    activeThreadRef.on("value", snap => {
      activeMessages = [];
      snap.forEach(c => { activeMessages.push(Object.assign({ id: c.key }, c.val())); });
      // Mark this thread's messages as seen so the unread listener won't re-flag.
      threadSeen[tid] = threadSeen[tid] || new Set();
      activeMessages.forEach(m => threadSeen[tid].add(m.id));
      if (tabVisible()) render();
    });
    render();
  }
  function closeChatRefOnly() {
    if (activeThreadRef) { activeThreadRef.off(); activeThreadRef = null; }
  }
  function closeChat() {
    closeChatRefOnly();
    activeChat = null;
    activeMessages = [];
    render();
  }

  // ---- live data ----
  function bindListeners() {
    const database = db();
    const uid = myUid();
    if (!database || !uid || listenersBound) return;
    listenersBound = true;
    database.ref(`${FRIENDS_REF}/${uid}`).on("value", snap => {
      friendsCache = snap.val() || {};
      detectNewRequests();
      syncUnreadListeners();
      if (tabVisible()) render();
    });
  }

  // Pop a toast for any brand-new incoming friend request.
  function detectNewRequests() {
    const prev = friendsSeen;
    const cur = {};
    Object.keys(friendsCache).forEach(k => { cur[k] = friendsCache[k].status; });
    if (prev) {
      Object.keys(friendsCache).forEach(k => {
        const f = friendsCache[k];
        if (f.status === "incoming" && prev[k] !== "incoming") {
          notify("Friend request", `${f.name || "Someone"} wants to be friends.`);
        } else if (f.status === "friends" && prev[k] === "requested") {
          notify("Friend request accepted", `${f.name || "Your request"} accepted.`);
        }
      });
    }
    friendsSeen = cur;
  }

  // Attach a per-friend "unread" listener for each accepted friend; detach for
  // friends that were removed. New incoming messages bump the unread badge and
  // notify (skipped for the open conversation).
  function syncUnreadListeners() {
    const uid = myUid();
    const database = db();
    if (!uid || !database) return;
    const wantThreads = {};
    Object.keys(friendsCache).forEach(fuid => {
      if (friendsCache[fuid].status !== "friends") return;
      wantThreads[threadIdFor(uid, fuid)] = fuid;
    });
    // Detach threads no longer wanted.
    Object.keys(threadRefs).forEach(tid => {
      if (!wantThreads[tid]) { try { threadRefs[tid].off(); } catch (e) {} delete threadRefs[tid]; }
    });
    // Attach new ones (record existing message ids first so we only react to genuinely new ones).
    Object.keys(wantThreads).forEach(tid => {
      if (threadRefs[tid]) return;
      const fuid = wantThreads[tid];
      const ref = database.ref(`${MESSAGES_REF}/${tid}`).limitToLast(50);
      threadRefs[tid] = ref;
      ref.once("value").then(snap => {
        const seen = threadSeen[tid] = threadSeen[tid] || new Set();
        snap.forEach(c => seen.add(c.key));
        ref.on("child_added", child => {
          if (seen.has(child.key)) return;
          seen.add(child.key);
          const m = child.val() || {};
          if (m.from === uid) return;                 // my own message
          if (activeChat === fuid && tabVisible()) return; // already reading it
          unread[fuid] = (unread[fuid] || 0) + 1;
          notify(`Message from ${m.fromName || friendsCache[fuid]?.name || "a friend"}`, m.text || "");
          if (tabVisible()) render();
        });
      }).catch(() => {});
    });
  }

  // ---- rendering ----
  function render() {
    const root = document.getElementById("friends-content");
    if (!root) return;
    const uid = myUid();
    if (!uid) {
      root.innerHTML = `<p class="fr-empty">Sign in (Settings → Account) to add friends and message them.</p>`;
      return;
    }
    if (activeChat && friendsCache[activeChat] && friendsCache[activeChat].status === "friends") {
      renderChat(root, activeChat);
      return;
    }
    activeChat = null;

    const entries = Object.keys(friendsCache).map(k => Object.assign({ uid: k }, friendsCache[k]));
    const friends = entries.filter(f => f.status === "friends").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    const incoming = entries.filter(f => f.status === "incoming");
    const outgoing = entries.filter(f => f.status === "requested");

    let html = `
      <div class="fr-add">
        <input type="text" id="fr-add-input" class="fr-add-input" placeholder="Add friend by username" autocomplete="off" maxlength="30">
        <button type="button" id="fr-add-btn" class="fr-btn fr-btn-add">Add Friend</button>
      </div>`;

    if (incoming.length) {
      html += `<div class="fr-section"><h3 class="fr-h">Friend requests (${incoming.length})</h3>` +
        incoming.map(f => `
          <div class="fr-row">
            <span class="fr-name">${esc(f.name || "(unknown)")}</span>
            <span class="fr-actions">
              <button type="button" class="fr-btn fr-btn-accept" data-accept="${esc(f.uid)}">Accept</button>
              <button type="button" class="fr-btn fr-btn-decline" data-remove="${esc(f.uid)}">Decline</button>
            </span>
          </div>`).join("") + `</div>`;
    }

    html += `<div class="fr-section"><h3 class="fr-h">Friends (${friends.length})</h3>`;
    if (!friends.length) {
      html += `<p class="fr-empty">No friends yet. Add someone by their username above.</p>`;
    } else {
      html += friends.map(f => {
        const u = unread[f.uid] || 0;
        return `
          <div class="fr-row fr-friend" data-chat="${esc(f.uid)}">
            <span class="fr-name">${esc(f.name || "(unknown)")}${u ? ` <span class="fr-unread">${u}</span>` : ""}</span>
            <span class="fr-actions">
              <button type="button" class="fr-btn fr-btn-msg" data-chat="${esc(f.uid)}">Message</button>
              <button type="button" class="fr-btn fr-btn-decline" data-remove="${esc(f.uid)}" title="Remove friend">&times;</button>
            </span>
          </div>`;
      }).join("");
    }
    html += `</div>`;

    if (outgoing.length) {
      html += `<div class="fr-section"><h3 class="fr-h">Pending</h3>` +
        outgoing.map(f => `
          <div class="fr-row">
            <span class="fr-name">${esc(f.name || "(unknown)")} <span class="fr-pending">requested</span></span>
            <span class="fr-actions"><button type="button" class="fr-btn fr-btn-decline" data-remove="${esc(f.uid)}">Cancel</button></span>
          </div>`).join("") + `</div>`;
    }

    root.innerHTML = html;
    const addInput = root.querySelector("#fr-add-input");
    const submitAdd = () => { if (addInput) { addFriendByUsername(addInput.value); addInput.value = ""; } };
    root.querySelector("#fr-add-btn")?.addEventListener("click", submitAdd);
    addInput?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submitAdd(); } });
    root.querySelectorAll("[data-accept]").forEach(b => b.addEventListener("click", () => acceptRequest(b.dataset.accept)));
    root.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => {
      if (confirm("Remove / decline this entry?")) removeFriend(b.dataset.remove);
    }));
    root.querySelectorAll("[data-chat]").forEach(el => el.addEventListener("click", e => {
      if (e.target.closest("[data-remove]")) return;
      openChat(el.dataset.chat);
    }));
  }

  function renderChat(root, friendUid) {
    const f = friendsCache[friendUid] || {};
    const uid = myUid();
    const rows = activeMessages.map(m => {
      const mine = m.from === uid;
      return `
        <div class="fr-msg ${mine ? "fr-msg-mine" : "fr-msg-theirs"}">
          <div class="fr-msg-bubble">${esc(m.text || "")}</div>
          <div class="fr-msg-meta">${fmtTime(m.ts)}</div>
        </div>`;
    }).join("");
    root.innerHTML = `
      <div class="fr-chat">
        <div class="fr-chat-head">
          <button type="button" class="fr-btn fr-btn-back" id="fr-back">&larr;</button>
          <span class="fr-chat-name">${esc(f.name || "(unknown)")}</span>
        </div>
        <div class="fr-chat-messages" id="fr-chat-messages">${rows || `<p class="fr-empty">No messages yet — say hi!</p>`}</div>
        <div class="fr-chat-input">
          <input type="text" id="fr-msg-input" class="fr-msg-input" placeholder="Message…" autocomplete="off" maxlength="1000">
          <button type="button" id="fr-send" class="fr-btn fr-btn-send">Send</button>
        </div>
      </div>`;
    const list = root.querySelector("#fr-chat-messages");
    if (list) list.scrollTop = list.scrollHeight;
    const input = root.querySelector("#fr-msg-input");
    const doSend = () => { if (input && input.value.trim()) { sendMessage(input.value); input.value = ""; input.focus(); } };
    root.querySelector("#fr-send")?.addEventListener("click", doSend);
    input?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doSend(); } });
    root.querySelector("#fr-back")?.addEventListener("click", closeChat);
  }

  // ---- entry point (called by core.js when the tab is active) ----
  window.renderFriends = function renderFriends() {
    bindListeners();
    render();
  };

  // Add a friend by username from anywhere (e.g. the profile popup's
  // "Add Friend" button). Make sure the friends listener is live first so the
  // "already friends / already requested" guards work.
  window.addFriendByUsername = function (name) {
    if (myUid()) bindListeners();
    addFriendByUsername(name);
  };

  // Do the right thing for a username given the current friendship: send a
  // request when there's none, accept when they've already requested you, and
  // no-op when already friends / already requested. Returns a Promise of the
  // resulting status label so callers can re-render.
  window.friendActionByUsername = function (name) {
    const uid = myUid(), database = db();
    if (!uid || !database || !name) return Promise.resolve(null);
    bindListeners();
    return database.ref("usernames/" + usernameKeyFor(name) + "/uid").once("value")
      .then(snap => {
        const otherUid = snap.val();
        if (!otherUid || otherUid === uid) { addFriendByUsername(name); return "none"; }
        const st = friendsCache[otherUid] && friendsCache[otherUid].status;
        if (st === "incoming") { acceptRequest(otherUid); return "friends"; }
        if (st === "friends" || st === "requested") return st;
        addFriendByUsername(name);
        return "requested";
      }).catch(() => { addFriendByUsername(name); return "requested"; });
  };

  // Current friendship status with a username, for callers that want to label a
  // button ("Add Friend" / "Requested" / "Friends"). Returns null when unknown
  // or not signed in. Resolves the username to a uid against /usernames.
  window.friendStatusWithUsername = function (name) {
    return new Promise(resolve => {
      const uid = myUid(), database = db();
      if (!uid || !database || !name) return resolve(null);
      // Loose self-match (ignore punctuation/spacing/case).
      const loose = s => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (loose(name) && loose(name) === loose(myName())) return resolve("self");
      database.ref("usernames/" + usernameKeyFor(name) + "/uid").once("value")
        .then(snap => {
          const otherUid = snap.val();
          if (!otherUid) return resolve(null);
          if (otherUid === uid) return resolve("self");
          resolve(friendsCache[otherUid] ? friendsCache[otherUid].status : "none");
        }).catch(() => resolve(null));
    });
  };

  // Bind the request/message listeners on every page once signed in, so toasts
  // fire even while the user is on another tab.
  function boot() { if (myUid()) bindListeners(); }
  window.addEventListener("userprofilechange", () => {
    // Account changed — reset everything.
    listenersBound = false; friendsCache = {}; friendsSeen = null;
    Object.keys(threadRefs).forEach(t => { try { threadRefs[t].off(); } catch (e) {} delete threadRefs[t]; });
    closeChatRefOnly(); activeChat = null;
    boot();
    if (tabVisible()) render();
  });
  window.addEventListener("load", boot);
})();
