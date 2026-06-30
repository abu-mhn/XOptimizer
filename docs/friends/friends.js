// docs/friends/friends.js — Friends + direct messages.
//
// Add a friend by username → they get a request → on accept you're friends and
// can DM each other. Built on Firebase Realtime Database, mirroring the Battle
// Royale tab's patterns (live listeners + toast / OS notifications).
//
// Data model:
//   friends/{uid}/{friendUid}: { name, status, ts }
//     status: "requested" (I sent) | "incoming" (they sent me) | "friends"
//   publicKeys/{uid}: "<ECDH P-256 public key as a JWK string>"
//   keyVault/{uid}:   { salt, iv, wrapped, pubJwk, v } — the account's private
//     key, AES-GCM-wrapped under a PBKDF2(passphrase) key (owner-read only)
//   messages/{threadId}/{pushId}: { from, ct, iv, v, ts }
//     from = sender uid (opaque; required by the rules to stop forgery)
//     ct/iv = AES-GCM ciphertext + nonce. NO sender name and NO plaintext are
//     ever stored, so a database snapshot reveals neither the message nor who
//     (by name) sent it. threadId = the two uids sorted and joined with "_".
//
// End-to-end encryption (passphrase-synced, multi-device): each account has ONE
// ECDH keypair. The private key is wrapped under a passphrase the user chooses
// and stored in keyVault/{uid}; the public half goes to publicKeys/{uid}. On a
// new device the user enters the passphrase to unwrap the same private key, so
// every device decrypts every message. A per-conversation AES-GCM key is derived
// from (my private key + friend's public key) — the identical secret both sides
// compute — so the server only ever stores ciphertext. Encryption is mandatory:
// if the friend has no published key we refuse to send rather than leak
// plaintext. Forget the passphrase → messages are unrecoverable (a reset makes a
// new key; older messages then can't be read). Legacy plaintext `text` is read
// as-is for backward compatibility.
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

  // ---- end-to-end encryption (ECDH P-256 → AES-GCM, passphrase-synced) ----
  // Each account has ONE ECDH keypair, shared across devices: the private key is
  // wrapped (AES-GCM) under a passphrase-derived key (PBKDF2) and stored in
  // keyVault/{uid}; only the public half is published to publicKeys/{uid}. On a
  // new device the user enters the passphrase to unwrap the same private key, so
  // every device decrypts every message. The server only ever sees ciphertext.
  const EC_ALGO = { name: "ECDH", namedCurve: "P-256" };
  const PBKDF2_ROUNDS = 250000;
  const RESET_SENTINEL = "__RESET__";
  let currentKeyPair = null;     // { priv: CryptoKey, pubJwk: string } once ready
  let keyReadyPromise = null;    // in-flight ensureKeyReady()
  let keySetupAttempted = false; // auto-prompted on the Friends tab this session?
  const friendPubCache = {};     // friendUid -> imported public CryptoKey
  const threadKeyCache = {};     // friendUid -> derived AES-GCM CryptoKey
  const decryptedCache = {};     // msgId -> plaintext (avoid re-decrypting on re-render)

  function cryptoOk() {
    return typeof crypto !== "undefined" && crypto.subtle && typeof indexedDB !== "undefined";
  }
  function b64(buf) {
    const b = new Uint8Array(buf); let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str); const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b.buffer;
  }

  // Minimal IndexedDB key/value access (db "xopt-e2ee", store "keys").
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      let open;
      try { open = indexedDB.open("xopt-e2ee", 1); } catch (e) { return reject(e); }
      open.onupgradeneeded = () => { try { open.result.createObjectStore("keys"); } catch (e) {} };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const dbi = open.result;
        let req;
        try {
          const tx = dbi.transaction("keys", mode);
          req = fn(tx.objectStore("keys"));
          tx.oncomplete = () => { dbi.close(); resolve(req && req.result); };
          tx.onerror = () => { dbi.close(); reject(tx.error); };
        } catch (e) { try { dbi.close(); } catch (_) {} reject(e); }
      };
    });
  }

  // Per-device cache of the unwrapped keypair (so the passphrase is only needed
  // once per device). Keyed kp2_* to sit alongside any legacy kp_* entries.
  function getLocalKeyPair() {
    const uid = myUid();
    if (!uid || !cryptoOk()) return Promise.resolve(null);
    return idb("readonly", store => store.get("kp2_" + uid))
      .then(saved => (saved && saved.priv && saved.pubJwk) ? saved : null).catch(() => null);
  }
  function saveLocalKeyPair(rec) {
    const uid = myUid();
    return idb("readwrite", store => store.put(rec, "kp2_" + uid)).catch(() => {});
  }

  function readVault() {
    const uid = myUid(), database = db();
    if (!uid || !database) return Promise.resolve(null);
    return database.ref("keyVault/" + uid).once("value").then(s => s.val()).catch(() => null);
  }

  // Derive the AES-GCM wrapping key from a passphrase + salt (PBKDF2).
  function deriveWrapKey(passphrase, saltBuf) {
    return crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"])
      .then(base => crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: saltBuf, iterations: PBKDF2_ROUNDS, hash: "SHA-256" },
        base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
      ));
  }

  // Create a fresh keypair, wrap the private half under the passphrase, and
  // upload keyVault/{uid} + publicKeys/{uid}. Used on first setup and on reset.
  function generateAndWrap(passphrase) {
    const uid = myUid(), database = db();
    if (!uid || !database) return Promise.resolve(null);
    return crypto.subtle.generateKey(EC_ALGO, true, ["deriveKey", "deriveBits"]).then(pair =>
      Promise.all([
        crypto.subtle.exportKey("jwk", pair.publicKey),
        crypto.subtle.exportKey("jwk", pair.privateKey)
      ]).then(([pubJwk, privJwk]) => {
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        return deriveWrapKey(passphrase, salt).then(wrapKey =>
          crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, new TextEncoder().encode(JSON.stringify(privJwk)))
            .then(wrappedBuf => {
              const pubStr = JSON.stringify(pubJwk);
              const updates = {};
              updates["keyVault/" + uid] = { salt: b64(salt), iv: b64(iv), wrapped: b64(wrappedBuf), pubJwk: pubStr, v: 1 };
              updates["publicKeys/" + uid] = pubStr;
              return database.ref().update(updates).then(() => {
                const rec = { priv: pair.privateKey, pubJwk: pubStr };
                return saveLocalKeyPair(rec).then(() => rec);
              });
            })
        );
      })
    );
  }

  // Unwrap the vault's private key with the passphrase. Rejects on wrong
  // passphrase (AES-GCM auth-tag failure).
  function unlockVault(vault, passphrase) {
    return deriveWrapKey(passphrase, new Uint8Array(unb64(vault.salt))).then(wrapKey =>
      crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(unb64(vault.iv)) }, wrapKey, unb64(vault.wrapped))
        .then(buf => {
          const privJwk = JSON.parse(new TextDecoder().decode(buf));
          return crypto.subtle.importKey("jwk", privJwk, EC_ALGO, true, ["deriveKey", "deriveBits"]).then(priv => {
            const rec = { priv, pubJwk: vault.pubJwk };
            return saveLocalKeyPair(rec).then(() => rec);
          });
        })
    );
  }

  // Ensure publicKeys/{uid} matches my keypair (re-publish if missing/stale).
  function ensurePublished(pubStr) {
    const uid = myUid(), database = db();
    if (!uid || !database || !pubStr) return;
    database.ref("publicKeys/" + uid).once("value").then(s => {
      if (s.val() !== pubStr) database.ref("publicKeys/" + uid).set(pubStr).catch(() => {});
    }).catch(() => {});
  }
  // Boot-time publish: only if this device already holds the key (never
  // generates — that would overwrite the synced key and orphan other devices).
  function publishMyPublicKey() {
    if (!cryptoOk()) return;
    getLocalKeyPair().then(kp => { if (kp) { currentKeyPair = currentKeyPair || kp; ensurePublished(kp.pubJwk); } });
  }

  // A styled passphrase modal. mode "setup" asks for a new password (twice);
  // "unlock" asks for the existing one and offers a reset link. Resolves the
  // entered string, RESET_SENTINEL, or null (cancelled).
  function askPassword(mode) {
    return new Promise(resolve => {
      const setup = mode === "setup";
      const overlay = document.createElement("div");
      overlay.className = "popup-overlay fr-key-popup";
      overlay.innerHTML = `
        <div class="popup-card fr-key-card">
          <h2 class="popup-title">${setup ? "Set up message encryption" : "Unlock your messages"}</h2>
          <p class="popup-text">${setup
            ? "Choose an encryption password. It keeps your messages readable across your devices and is separate from your login. If you forget it, your messages can't be recovered."
            : "Enter your encryption password to read and send messages on this device."}</p>
          <input type="password" class="tournament-name-input fr-key-pass" placeholder="Encryption password" autocomplete="off">
          ${setup ? `<input type="password" class="tournament-name-input fr-key-pass2" placeholder="Confirm password" autocomplete="off">` : ""}
          <div class="fr-key-status"></div>
          <div class="popup-actions">
            <button type="button" class="btn fr-key-ok">${setup ? "Set up" : "Unlock"}</button>
            <button type="button" class="btn popup-cancel fr-key-cancel">Cancel</button>
          </div>
          ${setup ? "" : `<button type="button" class="fr-key-reset">Forgot password? Reset encryption</button>`}
        </div>`;
      document.body.appendChild(overlay);
      const pass = overlay.querySelector(".fr-key-pass");
      const pass2 = overlay.querySelector(".fr-key-pass2");
      const status = overlay.querySelector(".fr-key-status");
      const done = (val) => { overlay.remove(); resolve(val); };
      overlay.querySelector(".fr-key-cancel").addEventListener("click", () => done(null));
      overlay.addEventListener("click", e => { if (e.target === overlay) done(null); });
      const submit = () => {
        const v = pass.value;
        if (!v || v.length < 6) { status.textContent = "Use at least 6 characters."; return; }
        if (setup && v !== (pass2 ? pass2.value : "")) { status.textContent = "Passwords don't match."; return; }
        done(v);
      };
      overlay.querySelector(".fr-key-ok").addEventListener("click", submit);
      (pass2 || pass).addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      const resetBtn = overlay.querySelector(".fr-key-reset");
      if (resetBtn) resetBtn.addEventListener("click", () => {
        if (confirm("Reset encryption with a new password? Messages you received before will no longer be readable on any device. Continue?")) done(RESET_SENTINEL);
      });
      setTimeout(() => pass.focus(), 0);
    });
  }

  // Make a usable keypair available, prompting for the passphrase when needed:
  //   • local copy on this device → use it
  //   • vault exists → ask passphrase and unwrap (or reset)
  //   • nothing yet → first-time setup (choose a passphrase, generate, upload)
  // Resolves the keypair, or null if the user cancels. Memoised while in-flight;
  // a cancel clears the memo so a later action can retry.
  function ensureKeyReady() {
    if (currentKeyPair) return Promise.resolve(currentKeyPair);
    if (keyReadyPromise) return keyReadyPromise;
    if (!cryptoOk() || !myUid()) return Promise.resolve(null);
    keyReadyPromise = (async () => {
      const local = await getLocalKeyPair();
      if (local) { currentKeyPair = local; ensurePublished(local.pubJwk); return local; }
      const vault = await readVault();
      if (vault && vault.wrapped) {
        const pass = await askPassword("unlock");
        if (!pass) return null;
        if (pass === RESET_SENTINEL) {
          const np = await askPassword("setup");
          if (!np) return null;
          const kp = await generateAndWrap(np);
          currentKeyPair = kp; return kp;
        }
        let kp = null;
        try { kp = await unlockVault(vault, pass); }
        catch (e) { notify("Wrong password", "That encryption password didn't work — try again."); return null; }
        currentKeyPair = kp; ensurePublished(kp.pubJwk); return kp;
      }
      const np = await askPassword("setup");
      if (!np) return null;
      const kp = await generateAndWrap(np);
      currentKeyPair = kp; return kp;
    })().then(kp => { if (!kp) keyReadyPromise = null; return kp; },
             () => { keyReadyPromise = null; return null; });
    return keyReadyPromise;
  }

  function getFriendPublicKey(friendUid) {
    if (friendPubCache[friendUid]) return Promise.resolve(friendPubCache[friendUid]);
    const database = db();
    if (!database || !cryptoOk()) return Promise.resolve(null);
    return database.ref("publicKeys/" + friendUid).once("value").then(snap => {
      const jwkStr = snap.val();
      if (!jwkStr) return null;
      return crypto.subtle.importKey("jwk", JSON.parse(jwkStr), EC_ALGO, false, []).then(pub => {
        friendPubCache[friendUid] = pub;
        return pub;
      });
    }).catch(() => null);
  }

  // Derive + cache the shared AES-GCM key for a conversation. Non-interactive:
  // uses whatever keypair is already unlocked (null if the key isn't ready yet
  // or the friend hasn't published a key).
  function deriveThreadKey(friendUid) {
    if (threadKeyCache[friendUid]) return Promise.resolve(threadKeyCache[friendUid]);
    if (!cryptoOk()) return Promise.resolve(null);
    const kpReady = currentKeyPair ? Promise.resolve(currentKeyPair) : getLocalKeyPair();
    return Promise.all([kpReady, getFriendPublicKey(friendUid)]).then(([kp, pub]) => {
      if (kp && !currentKeyPair) currentKeyPair = kp;
      if (!kp || !pub) return null;
      return crypto.subtle.deriveKey(
        { name: "ECDH", public: pub }, kp.priv,
        { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
      ).then(key => { threadKeyCache[friendUid] = key; return key; });
    }).catch(() => null);
  }

  function encryptText(aesKey, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, new TextEncoder().encode(text))
      .then(ctBuf => ({ ct: b64(ctBuf), iv: b64(iv) }));
  }
  function decryptText(aesKey, ctB64, ivB64) {
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(unb64(ivB64)) }, aesKey, unb64(ctB64))
      .then(buf => new TextDecoder().decode(buf));
  }

  // What to render for a message right now (no decryption side effects).
  function displayText(m) {
    if (m.text != null) return m.text;                              // legacy plaintext
    if (m.id && decryptedCache[m.id] != null) return decryptedCache[m.id];
    return currentKeyPair ? "🔒…" : "🔒 Unlock to read";
  }
  // Attempt to decrypt a ciphertext message, caching the plaintext by id. Leaves
  // it uncached when the key isn't ready yet, so it retries after an unlock.
  function ensureDecrypted(friendUid, m) {
    if (m.text != null) return Promise.resolve(m.text);
    if (m.id && decryptedCache[m.id] != null) return Promise.resolve(decryptedCache[m.id]);
    if (!m.ct || !m.iv) return Promise.resolve("");
    return deriveThreadKey(friendUid).then(key => {
      if (!key) return null;  // not unlocked / no friend key — retry later
      return decryptText(key, m.ct, m.iv).then(txt => {
        if (m.id) decryptedCache[m.id] = txt; return txt;
      }).catch(() => { if (m.id) decryptedCache[m.id] = "🔒 Unable to decrypt"; return decryptedCache[m.id]; });
    });
  }
  function decryptAll(friendUid, list) {
    return Promise.all(list.map(m => ensureDecrypted(friendUid, m)));
  }

  function resetCryptoCaches() {
    currentKeyPair = null; keyReadyPromise = null; keySetupAttempted = false;
    Object.keys(friendPubCache).forEach(k => delete friendPubCache[k]);
    Object.keys(threadKeyCache).forEach(k => delete threadKeyCache[k]);
    Object.keys(decryptedCache).forEach(k => delete decryptedCache[k]);
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
  // Encryption is mandatory: we only ever write ciphertext, never the sender's
  // name. Sending first unlocks/sets up my own key (prompting for the passphrase
  // if needed), then requires the friend's published key.
  function sendMessage(text) {
    const uid = myUid(), database = db();
    const msg = (text || "").trim();
    if (!uid || !database || !activeChat || !msg) return;
    const friendUid = activeChat;
    const tid = threadIdFor(uid, friendUid);
    const body = msg.slice(0, 1000);
    ensureKeyReady().then(myKp => {
      if (!myKp) { notify("Encryption needed", "Set up your encryption password to send messages."); return; }
      return getFriendPublicKey(friendUid).then(pub => {
        if (!pub) {
          notify("Can't send yet", `${friendsCache[friendUid]?.name || "Your friend"} needs to open X Optimizer once so messages can be encrypted.`);
          return;
        }
        return deriveThreadKey(friendUid).then(key => {
          if (!key) { notify("Can't send yet", "Couldn't set up encryption for this chat."); return; }
          return encryptText(key, body).then(({ ct, iv }) =>
            database.ref(`${MESSAGES_REF}/${tid}`).push({ from: uid, ct, iv, v: 1, ts: nowIso() })
              .catch(e => alert("Couldn't send: " + ((e && e.message) || e)))
          );
        });
      });
    }).catch(() => alert("Couldn't encrypt that message."));
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
      const list = [];
      snap.forEach(c => { list.push(Object.assign({ id: c.key }, c.val())); });
      // Mark this thread's messages as seen so the unread listener won't re-flag.
      threadSeen[tid] = threadSeen[tid] || new Set();
      list.forEach(m => threadSeen[tid].add(m.id));
      activeMessages = list;
      if (tabVisible()) render();
      // Decrypt (async); re-render as plaintext lands. Ignore stale chats.
      decryptAll(friendUid, list).then(() => {
        if (activeChat === friendUid && tabVisible()) render();
      });
    });
    // Unlock my key (prompts for the passphrase on a fresh device), then
    // re-decrypt this conversation once it's available.
    ensureKeyReady().then(kp => {
      if (kp && activeChat === friendUid) {
        decryptAll(friendUid, activeMessages).then(() => { if (activeChat === friendUid && tabVisible()) render(); });
      }
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
          const m = Object.assign({ id: child.key }, child.val() || {});
          if (m.from === uid) return;                 // my own message
          if (activeChat === fuid && tabVisible()) return; // already reading it
          unread[fuid] = (unread[fuid] || 0) + 1;
          const who = friendsCache[fuid]?.name || "a friend";
          ensureDecrypted(fuid, m).then(txt => notify(`Message from ${who}`, txt || "New message"));
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
          <div class="fr-msg-bubble">${esc(displayText(m))}</div>
          <div class="fr-msg-meta">${fmtTime(m.ts)}</div>
        </div>`;
    }).join("");
    root.innerHTML = `
      <div class="fr-chat">
        <div class="fr-chat-head">
          <button type="button" class="fr-btn fr-btn-back" id="fr-back">&larr;</button>
          <span class="fr-chat-name">${esc(f.name || "(unknown)")}</span>
          <span class="fr-chat-e2ee" title="End-to-end encrypted — unlocked with your encryption password on each device">🔒</span>
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
    // First time the tab is opened this session, set up / unlock the encryption
    // key (so your public key gets published and friends can message you).
    if (myUid() && cryptoOk() && !currentKeyPair && !keySetupAttempted) {
      keySetupAttempted = true;
      ensureKeyReady().then(() => { if (tabVisible()) render(); });
    }
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
  function boot() { if (myUid()) { bindListeners(); publishMyPublicKey(); } }
  window.addEventListener("userprofilechange", () => {
    // Account changed — reset everything (including the per-account crypto keys).
    listenersBound = false; friendsCache = {}; friendsSeen = null;
    Object.keys(threadRefs).forEach(t => { try { threadRefs[t].off(); } catch (e) {} delete threadRefs[t]; });
    closeChatRefOnly(); activeChat = null;
    resetCryptoCaches();
    boot();
    if (tabVisible()) render();
  });
  window.addEventListener("load", boot);
})();
