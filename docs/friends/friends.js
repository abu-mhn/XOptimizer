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
//   keyVault/{uid}:   v2 → { priv, pubJwk, v: 2 } — the account's private key
//     stored directly, readable/writable ONLY by the owner (auth.uid === uid,
//     enforced in database.rules.json). Legacy v1 → { salt, iv, wrapped, pubJwk,
//     v: 1 }, a passphrase-wrapped private key (still readable for migration).
//   messages/{threadId}/{pushId}: { from, ct, iv, v, ts }
//     from = sender uid (opaque; required by the rules to stop forgery)
//     ct/iv = AES-GCM ciphertext + nonce. NO sender name and NO plaintext are
//     ever stored, so a database snapshot reveals neither the message nor who
//     (by name) sent it. threadId = the two uids sorted and joined with "_".
//
// Auto-unlock encryption (no password, multi-device): each account has ONE ECDH
// keypair. The private key lives in keyVault/{uid} under owner-only rules, so any
// device the owner signs into fetches and imports it automatically — no setup,
// no password, ever. The public half goes to publicKeys/{uid}. A per-conversation
// AES-GCM key is derived from (my private key + friend's public key) — the same
// secret both sides compute — so message rows only ever hold ciphertext.
// Encryption is mandatory: if the friend has no published key we refuse to send
// rather than leak plaintext.
//
// SECURITY NOTE: this is convenience-first, NOT zero-knowledge. Because the
// private key is stored server-side (protected by DB rules, not a passphrase),
// whoever controls the database could in principle read messages. That is the
// deliberate trade for zero-setup across devices. Legacy v1 (passphrase) vaults
// still unlock with the old password once, then migrate themselves to v2.
// Legacy plaintext `text` is read as-is for backward compatibility.
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
  const threadSeen = {};         // threadId -> Set of message ids seen this session
  const threadRefs = {};         // threadId -> ref (per-friend unread listener)
  let friendsSeen = null;        // friendUid -> status, for request-notification diffing

  // Persistent per-thread read marker (localStorage) so that reading a
  // conversation sticks across page navigations — each tab is a full page load,
  // so an in-memory unread count alone would reappear every time. The value is
  // the newest message push-key that's been read; push-keys are chronological,
  // so a lexicographic compare separates read from unread.
  const LAST_READ_KEY = "frLastRead";
  let lastReadMap = (function () {
    try { return JSON.parse(localStorage.getItem(LAST_READ_KEY) || "{}") || {}; } catch (e) { return {}; }
  })();
  function saveLastRead() { try { localStorage.setItem(LAST_READ_KEY, JSON.stringify(lastReadMap)); } catch (e) {} }
  function markThreadRead(tid, latestKey) {
    if (!tid || !latestKey) return;
    if (!lastReadMap[tid] || latestKey > lastReadMap[tid]) { lastReadMap[tid] = latestKey; saveLastRead(); }
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

  // ---- auto-unlock encryption (ECDH P-256 → AES-GCM, server-synced key) ----
  // Each account has ONE ECDH keypair, shared across devices: the private key is
  // stored in keyVault/{uid} under owner-only DB rules, so any signed-in device
  // fetches + imports it automatically — no password. The public half is
  // published to publicKeys/{uid}. Message rows only ever hold ciphertext.
  // Not zero-knowledge (see the SECURITY NOTE at the top of this file).
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

  // Write a v2 vault (private key stored directly, owner-read-only) + publish the
  // public half. Shared by first-time setup, reset, and legacy-v1 migration.
  function storeVaultV2(privStr, pubStr) {
    const uid = myUid(), database = db();
    if (!uid || !database) return Promise.resolve();
    const updates = {};
    updates["keyVault/" + uid] = { priv: privStr, pubJwk: pubStr, v: 2 };
    updates["publicKeys/" + uid] = pubStr;
    return database.ref().update(updates);
  }

  // Create a fresh keypair and upload it as a v2 vault — no passphrase. Used on
  // first setup and on reset. Any of the owner's devices can then auto-import it.
  function generateAuto() {
    const uid = myUid(), database = db();
    if (!uid || !database) return Promise.resolve(null);
    return crypto.subtle.generateKey(EC_ALGO, true, ["deriveKey", "deriveBits"]).then(pair =>
      Promise.all([
        crypto.subtle.exportKey("jwk", pair.publicKey),
        crypto.subtle.exportKey("jwk", pair.privateKey)
      ]).then(([pubJwk, privJwk]) => {
        const pubStr = JSON.stringify(pubJwk);
        return storeVaultV2(JSON.stringify(privJwk), pubStr).then(() => {
          const rec = { priv: pair.privateKey, pubJwk: pubStr };
          return saveLocalKeyPair(rec).then(() => rec);
        });
      })
    );
  }

  // Import a v2 vault's private key straight into a usable keypair (no password),
  // caching it on this device.
  function importVaultV2(vault) {
    const privJwk = JSON.parse(vault.priv);
    return crypto.subtle.importKey("jwk", privJwk, EC_ALGO, true, ["deriveKey", "deriveBits"]).then(priv => {
      const rec = { priv, pubJwk: vault.pubJwk };
      return saveLocalKeyPair(rec).then(() => rec);
    });
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

  // Make a usable keypair available — no password in the common paths:
  //   • local copy on this device → use it
  //   • v2 vault → import the stored private key directly (auto-unlock)
  //   • legacy v1 (passphrase) vault → ask the old password ONCE, then migrate
  //     the account to v2 so no device needs a password again
  //   • nothing yet → first-time setup: generate + upload a v2 vault, no password
  // Resolves the keypair, or null on failure/cancel. Memoised while in-flight; a
  // failure clears the memo so a later action can retry.
  function ensureKeyReady() {
    if (currentKeyPair) return Promise.resolve(currentKeyPair);
    if (keyReadyPromise) return keyReadyPromise;
    if (!cryptoOk() || !myUid()) return Promise.resolve(null);
    keyReadyPromise = (async () => {
      const local = await getLocalKeyPair();
      if (local) { currentKeyPair = local; ensurePublished(local.pubJwk); return local; }
      const vault = await readVault();
      // v2: private key stored directly — import with no password.
      if (vault && vault.priv) {
        const kp = await importVaultV2(vault);
        currentKeyPair = kp; ensurePublished(kp.pubJwk); return kp;
      }
      // Legacy v1: still passphrase-wrapped. Unlock once with the old password,
      // then rewrite as v2 so future devices auto-unlock.
      if (vault && vault.wrapped) {
        const pass = await askPassword("unlock");
        if (!pass) return null;
        if (pass === RESET_SENTINEL) {
          const kp = await generateAuto();
          currentKeyPair = kp; return kp;
        }
        let kp = null;
        try { kp = await unlockVault(vault, pass); }
        catch (e) { notify("Wrong password", "That encryption password didn't work — try again."); return null; }
        currentKeyPair = kp; ensurePublished(kp.pubJwk);
        try {
          const privJwk = await crypto.subtle.exportKey("jwk", kp.priv);
          await storeVaultV2(JSON.stringify(privJwk), kp.pubJwk);
        } catch (e) { /* migration is best-effort; unlock still succeeded */ }
        return kp;
      }
      // Nothing yet — set up automatically, no password.
      const kp = await generateAuto();
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

  function clearThreadCaches() {
    Object.keys(threadKeyCache).forEach(k => delete threadKeyCache[k]);
    Object.keys(decryptedCache).forEach(k => delete decryptedCache[k]);
  }
  function resetCryptoCaches() {
    currentKeyPair = null; keyReadyPromise = null; keySetupAttempted = false;
    Object.keys(friendPubCache).forEach(k => delete friendPubCache[k]);
    clearThreadCaches();
  }

  // Snapshot of this account's encryption state for the status panel.
  function encryptionState() {
    const uid = myUid(), database = db();
    if (!uid || !cryptoOk()) return Promise.resolve(null);
    return Promise.all([
      getLocalKeyPair(),
      readVault(),
      database ? database.ref("publicKeys/" + uid).once("value").then(s => s.val()).catch(() => null) : Promise.resolve(null)
    ]).then(([local, vault, pub]) => ({
      unlocked: !!(currentKeyPair || local),
      // A legacy v1 vault that hasn't been unlocked on this device yet still
      // needs the old password once (to migrate it to auto-unlock).
      legacyLocked: !!(vault && vault.wrapped) && !(currentKeyPair || local),
      published: !!pub
    }));
  }
  // Break-glass recovery: generate a brand-new key (no password). Old messages
  // encrypted to the previous key become unreadable everywhere. Not part of the
  // routine flow — exposed on window so the Settings tab can offer it.
  function regenerateEncryptionKey() {
    if (!confirm("Regenerate your encryption key?\n\nOnly do this if messages stopped decrypting or you want a fresh key. Messages you received before will become unreadable on ALL your devices. This can't be undone.")) return;
    generateAuto().then(kp => {
      if (!kp) { notify("Couldn't regenerate", "Couldn't regenerate your key right now. Check your connection and try again."); return; }
      currentKeyPair = kp; keyReadyPromise = null; clearThreadCaches();
      notify("New key generated", "A fresh encryption key is set on your account — it unlocks automatically on all your devices.");
      if (tabVisible()) render();
    }).catch(() => notify("Couldn't regenerate", "Couldn't regenerate your key right now. Check your connection and try again."));
  }
  // Let other tabs (Settings) trigger recovery without importing this module.
  window.regenerateEncryptionKey = regenerateEncryptionKey;

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

  // ---- profile pictures / banners ----
  // Placeholder avatar (matches the profile popup's silhouette).
  const FR_AVATAR_PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
  const profileInfoCache = {}; // profileKey -> {photo, banner, smallBanner, ...} | null

  function fetchProfileInfo(key) {
    if (key in profileInfoCache) return Promise.resolve(profileInfoCache[key]);
    const database = db();
    if (!database || !key) return Promise.resolve(null);
    return database.ref("profiles/" + key).once("value")
      .then(s => (profileInfoCache[key] = s.val() || null))
      .catch(() => (profileInfoCache[key] = null));
  }
  // Avatar + banner markup for a friend/request row, keyed by profile so the
  // photo and banner can be hydrated in after render.
  function rowAvatarHtml(name) {
    return `<span class="fr-row-banner" data-banner></span><img class="fr-avatar fr-profile-trigger" data-avatar data-profile-username="${esc(name || "")}" title="View profile" alt="" src="${FR_AVATAR_PH}">`;
  }
  // Name span that opens the profile card on hover/click.
  function profileNameHtml(name, extraInner) {
    return `<span class="fr-name fr-profile-trigger" data-profile-username="${esc(name || "")}" title="View profile">${esc(name || "(unknown)")}${extraInner || ""}</span>`;
  }

  // Reuse the tournament tab's proven profile-card wiring: click AND hover on
  // any [data-profile-username] opens the hover-profile dropdown.
  function wireProfileTriggers(root) {
    if (typeof window.bindTournamentProfileNames === "function") window.bindTournamentProfileNames(root);
  }
  // Fill each row's avatar photo + banner background from the public profile
  // mirror (one read per unique key, cached).
  function hydrateFriendAvatars(root) {
    root.querySelectorAll("[data-pkey]").forEach(rowEl => {
      const key = rowEl.dataset.pkey;
      if (!key) return;
      fetchProfileInfo(key).then(p => {
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
    updateFriendsNavBadges();
    activeMessages = [];
    const tid = threadIdFor(myUid(), friendUid);
    activeThreadRef = db().ref(`${MESSAGES_REF}/${tid}`).limitToLast(200);
    activeThreadRef.on("value", snap => {
      const list = [];
      snap.forEach(c => { list.push(Object.assign({ id: c.key }, c.val())); });
      threadSeen[tid] = threadSeen[tid] || new Set();
      list.forEach(m => threadSeen[tid].add(m.id));
      activeMessages = list;
      // Reading this conversation → clear its unread and persist the read marker
      // (newest message key) so it stays read after navigating away.
      if (activeChat === friendUid) {
        unread[friendUid] = 0;
        updateFriendsNavBadges();
        if (list.length) markThreadRead(tid, list[list.length - 1].id);
      }
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
    // Attach new ones. Seed the unread count from the persistent read marker
    // (messages newer than lastReadMap[tid] and not sent by me), then keep it
    // live via child_added.
    Object.keys(wantThreads).forEach(tid => {
      if (threadRefs[tid]) return;
      const fuid = wantThreads[tid];
      const ref = database.ref(`${MESSAGES_REF}/${tid}`).limitToLast(50);
      threadRefs[tid] = ref;
      ref.once("value").then(snap => {
        const seen = threadSeen[tid] = threadSeen[tid] || new Set();
        let count = 0;
        snap.forEach(c => {
          seen.add(c.key);
          const m = c.val() || {};
          if (m.from !== uid && (!lastReadMap[tid] || c.key > lastReadMap[tid])) count++;
        });
        unread[fuid] = count;
        updateFriendsNavBadges();
        if (tabVisible()) render();
        ref.on("child_added", child => {
          if (seen.has(child.key)) return;            // already counted in the snapshot
          seen.add(child.key);
          const m = Object.assign({ id: child.key }, child.val() || {});
          if (m.from === uid) return;                 // my own message
          if (lastReadMap[tid] && child.key <= lastReadMap[tid]) return; // already read elsewhere
          if (activeChat === fuid && tabVisible()) { markThreadRead(tid, child.key); return; } // reading it now
          unread[fuid] = (unread[fuid] || 0) + 1;
          updateFriendsNavBadges();
          const who = friendsCache[fuid]?.name || "a friend";
          ensureDecrypted(fuid, m).then(txt => notify(`Message from ${who}`, txt || "New message"));
          if (tabVisible()) render();
        });
      }).catch(() => {});
    });
    // Drop counts for friends no longer present, then refresh the nav badges.
    const wantedFuids = Object.values(wantThreads);
    Object.keys(unread).forEach(fuid => { if (wantedFuids.indexOf(fuid) === -1) delete unread[fuid]; });
    updateFriendsNavBadges();
  }

  // Total unread across all conversations.
  function totalUnread() {
    if (!myUid()) return 0;
    return Object.keys(unread).reduce((n, k) => n + (unread[k] || 0), 0);
  }

  // Reflect unread messages on the nav: a "!" on the More tab (Friends lives
  // inside the More menu) and the numeric count on the Friends menu item.
  // friends.js runs on every page, so these stay current app-wide.
  function updateFriendsNavBadges() {
    const total = totalUnread();
    const label = total > 99 ? "99+" : String(total);
    const moreBtn = document.getElementById("tab-more-btn");
    if (moreBtn) {
      let dot = moreBtn.querySelector(".tab-alert");
      if (total > 0) {
        if (!dot) {
          dot = document.createElement("span");
          dot.className = "tab-alert";
          moreBtn.appendChild(dot);
        }
        dot.textContent = label;
        dot.setAttribute("aria-label", `${total} unread message${total === 1 ? "" : "s"}`);
        dot.title = "Unread messages";
      } else if (dot) {
        dot.remove();
      }
    }
    const friendsItem = document.querySelector('a.tab-more-item[data-mode="friends"]');
    if (friendsItem) {
      let cnt = friendsItem.querySelector(".tab-count");
      if (total > 0) {
        if (!cnt) {
          cnt = document.createElement("span");
          cnt.className = "tab-count";
          friendsItem.appendChild(cnt);
        }
        cnt.textContent = label;
        cnt.setAttribute("aria-label", `${total} unread message${total === 1 ? "" : "s"}`);
      } else if (cnt) {
        cnt.remove();
      }
    }
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
      <div id="fr-enc-panel"></div>
      <div class="fr-add">
        <input type="text" id="fr-add-input" class="fr-add-input" placeholder="Add friend by username" autocomplete="off" maxlength="30">
        <button type="button" id="fr-add-btn" class="fr-btn fr-btn-add">Add Friend</button>
      </div>`;

    if (incoming.length) {
      html += `<div class="fr-section"><h3 class="fr-h">Friend requests (${incoming.length})</h3>` +
        incoming.map(f => `
          <div class="fr-row" data-pkey="${esc(usernameKeyFor(f.name || ""))}">
            ${rowAvatarHtml(f.name)}
            ${profileNameHtml(f.name)}
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
          <div class="fr-row fr-friend" data-pkey="${esc(usernameKeyFor(f.name || ""))}">
            ${rowAvatarHtml(f.name)}
            ${profileNameHtml(f.name, u ? ` <span class="fr-unread">${u}</span>` : "")}
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
          <div class="fr-row" data-pkey="${esc(usernameKeyFor(f.name || ""))}">
            ${rowAvatarHtml(f.name)}
            ${profileNameHtml(f.name, ` <span class="fr-pending">requested</span>`)}
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
    paintEncryptionPanel();
    hydrateFriendAvatars(root);
    wireProfileTriggers(root);
  }

  // Fill the encryption status panel (set up / published / unlocked) and wire its
  // Set up / Unlock / Reset buttons. Refreshed on every list render.
  function paintEncryptionPanel() {
    const panel = document.getElementById("fr-enc-panel");
    if (!panel) return;
    if (!myUid() || !cryptoOk()) { panel.innerHTML = ""; return; }
    encryptionState().then(st => {
      if (!st) { panel.innerHTML = ""; return; }
      // Healthy = key ready + published: nothing to do. Show a small passive
      // pill (reassurance only, not interactive) and stop. The full panel is
      // reserved for states that actually need the user — a legacy account that
      // still needs the one-time unlock, a key that hasn't published yet, or
      // first-time setup. Recovery (Regenerate key) lives in Settings.
      if (st.unlocked && st.published) {
        panel.innerHTML = `<span class="fr-enc-pill" title="Your messages are encrypted"><span class="fr-enc-dot fr-enc-dot-ok"></span>🔒 Encrypted</span>`;
        return;
      }
      let statusLine, btns, dot;
      if (st.unlocked) {              // key ready but not published to friends yet
        statusLine = "Key ready, publishing… reopen if friends still can't message you.";
        btns = ""; dot = "warn";
      } else if (st.legacyLocked) {
        statusLine = "This account still uses an encryption password. Enter it once to unlock — after that, no password on any device.";
        btns = `<button type="button" class="fr-enc-btn fr-enc-primary" data-enc="unlock">Unlock</button>`;
        dot = "warn";
      } else {
        statusLine = "Setting up encryption…";
        btns = ""; dot = "off";
      }
      const chip = (on, yes, no) => `<span class="fr-enc-chip ${on ? "on" : "off"}">${on ? yes : no}</span>`;
      panel.innerHTML = `
        <div class="fr-enc">
          <div class="fr-enc-head">
            <span class="fr-enc-dot fr-enc-dot-${dot}"></span>
            <span class="fr-enc-title">Message encryption</span>
          </div>
          <div class="fr-enc-chips">
            ${chip(st.unlocked, "Key set up ✓", "Key not set up")}
            ${chip(st.published, "Published ✓", "Not published")}
            ${chip(st.unlocked, "Unlocked here ✓", "Locked here")}
          </div>
          <p class="fr-enc-status">${esc(statusLine)}</p>
          <div class="fr-enc-actions">${btns}</div>
        </div>`;
      panel.querySelectorAll("[data-enc]").forEach(b => b.addEventListener("click", () => {
        ensureKeyReady().then(() => { if (tabVisible()) render(); }); // unlock (legacy)
      }));
    }).catch(() => { panel.innerHTML = ""; });
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
        <div class="fr-chat-head" data-pkey="${esc(usernameKeyFor(f.name || ""))}">
          <span class="fr-row-banner" data-banner></span>
          <button type="button" class="fr-btn fr-btn-back" id="fr-back">&larr;</button>
          <img class="fr-avatar fr-profile-trigger" data-avatar data-profile-username="${esc(f.name || "")}" title="View profile" alt="" src="${FR_AVATAR_PH}">
          <span class="fr-chat-name fr-profile-trigger" data-profile-username="${esc(f.name || "")}" title="View profile">${esc(f.name || "(unknown)")}</span>
          <span class="fr-chat-e2ee" title="Encrypted — unlocks automatically on your signed-in devices">🔒</span>
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
    hydrateFriendAvatars(root);
    wireProfileTriggers(root);
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
  function boot() { if (myUid()) { bindListeners(); publishMyPublicKey(); } updateFriendsNavBadges(); }
  window.addEventListener("userprofilechange", () => {
    // Account changed — reset everything (including the per-account crypto keys).
    listenersBound = false; friendsCache = {}; friendsSeen = null;
    Object.keys(threadRefs).forEach(t => { try { threadRefs[t].off(); } catch (e) {} delete threadRefs[t]; });
    Object.keys(unread).forEach(k => delete unread[k]);   // don't carry counts across accounts
    closeChatRefOnly(); activeChat = null;
    resetCryptoCaches();
    updateFriendsNavBadges();
    boot();
    if (tabVisible()) render();
  });
  window.addEventListener("load", boot);
})();
