// docs/js/auth.js — Firebase Auth helpers + UI wiring.
//
// We gate "Create Tournament" on a signed-in user (email + password). The
// Settings tab carries the Account section; every page can open the
// sign-in popup since the popup HTML lives in every subfolder.
//
// Firebase Auth persists the session in localStorage automatically, so
// signing in once on /settings/ carries through to /tournament/ etc.
(function () {
  let authReady = false;
  let lastUser = null;

  // Lazy auth handle — re-uses the already-initialised firebase.app() from
  // the existing initFirebase() in tournament.js. Returns the auth
  // instance or null if Firebase isn't configured.
  window.getFirebaseAuth = function getFirebaseAuth() {
    if (typeof firebase === "undefined" || !firebase.auth) return null;
    try {
      if (!firebase.apps.length) {
        const cfg = window.FIREBASE_CONFIG;
        if (!cfg || !cfg.apiKey) return null;
        firebase.initializeApp(cfg);
      }
      return firebase.auth();
    } catch (e) {
      console.warn("Auth init failed:", e);
      return null;
    }
  };

  window.getCurrentUser = function getCurrentUser() {
    const a = window.getFirebaseAuth();
    return a ? a.currentUser : null;
  };

  // Subscribe to auth state changes. Callback fires immediately with the
  // current user (or null) and again on every sign-in / sign-out.
  window.onAuthChange = function onAuthChange(cb) {
    const a = window.getFirebaseAuth();
    if (!a) { cb(null); return () => {}; }
    return a.onAuthStateChanged(u => { lastUser = u; cb(u); });
  };

  window.signInWithEmail = function signInWithEmail(email, password) {
    const a = window.getFirebaseAuth();
    if (!a) return Promise.reject(new Error("Auth not configured."));
    return a.signInWithEmailAndPassword(email, password);
  };

  window.signUpWithEmail = function signUpWithEmail(email, password) {
    const a = window.getFirebaseAuth();
    if (!a) return Promise.reject(new Error("Auth not configured."));
    return a.createUserWithEmailAndPassword(email, password);
  };

  window.sendPasswordResetEmail = function sendPasswordResetEmail(email) {
    const a = window.getFirebaseAuth();
    if (!a) return Promise.reject(new Error("Auth not configured."));
    return a.sendPasswordResetEmail(email);
  };

  window.signOutCurrentUser = function signOutCurrentUser() {
    const a = window.getFirebaseAuth();
    if (!a) return Promise.resolve();
    return a.signOut();
  };

  // Maps Firebase error codes to user-friendly messages.
  window.describeAuthError = function describeAuthError(err) {
    const code = err && err.code ? err.code : "";
    switch (code) {
      case "auth/invalid-email":           return "That doesn't look like a valid email.";
      case "auth/user-not-found":          return "No account with that email. Create one below.";
      case "auth/wrong-password":          return "Wrong password.";
      case "auth/invalid-credential":      return "Wrong email or password.";
      case "auth/email-already-in-use":    return "An account with that email already exists. Sign in instead.";
      case "auth/weak-password":           return "Password is too weak — use at least 6 characters.";
      case "auth/network-request-failed":  return "Network problem — check your connection.";
      case "auth/too-many-requests":       return "Too many attempts. Wait a moment and try again.";
      default: return (err && err.message) || "Something went wrong.";
    }
  };

  // Opens the sign-in popup. Resolves with the signed-in user on success
  // or rejects if the user cancels. Optional onSignedIn callback fires
  // after a successful sign in / sign up (e.g. resume the gated action).
  window.showSignInPopup = function showSignInPopup(options = {}) {
    return new Promise((resolve, reject) => {
      const popup = document.getElementById("signin-popup");
      if (!popup) { reject(new Error("Sign-in popup missing.")); return; }
      const titleEl = popup.querySelector("#signin-title");
      const subtitleEl = popup.querySelector("#signin-subtitle");
      const emailInput = popup.querySelector("#signin-email");
      const emailLabel = popup.querySelector('label[for="signin-email"]');
      const passwordInput = popup.querySelector("#signin-password");
      const submitBtn = popup.querySelector("#signin-submit");
      const toggleBtn = popup.querySelector("#signin-toggle");
      const cancelBtn = popup.querySelector("#signin-cancel");
      const resetBtn = popup.querySelector("#signin-reset");
      const statusEl = popup.querySelector("#signin-status");
      // Sign-up-only fields (username + confirm password). The rows are
      // toggled by renderMode so they only appear when creating an account.
      const usernameRow = popup.querySelector("#signin-username-row");
      const usernameInput = popup.querySelector("#signin-username");
      const password2Row = popup.querySelector("#signin-password2-row");
      const password2Input = popup.querySelector("#signin-password2");

      let mode = "signin"; // or "signup"

      const setStatus = (msg, kind) => {
        if (!statusEl) return;
        statusEl.textContent = msg || "";
        statusEl.classList.remove("is-ok", "is-err", "is-pending");
        if (kind) statusEl.classList.add(`is-${kind}`);
      };

      const renderMode = () => {
        const signup = mode === "signup";
        if (usernameRow) usernameRow.classList.toggle("hidden", !signup);
        if (password2Row) password2Row.classList.toggle("hidden", !signup);
        if (mode === "signup") {
          if (titleEl) titleEl.textContent = "Create account";
          if (subtitleEl) subtitleEl.textContent = options.subtitle || "Sign up with your email to host tournaments.";
          if (submitBtn) submitBtn.textContent = "Sign up";
          if (toggleBtn) toggleBtn.textContent = "Already have an account? Sign in";
          if (emailLabel) emailLabel.textContent = "Email";
          if (emailInput) emailInput.placeholder = "you@example.com";
        } else {
          if (titleEl) titleEl.textContent = "Sign in";
          if (subtitleEl) subtitleEl.textContent = options.subtitle || "Sign in with your username or email.";
          if (submitBtn) submitBtn.textContent = "Sign in";
          if (toggleBtn) toggleBtn.textContent = "No account yet? Sign up";
          if (emailLabel) emailLabel.textContent = "Username or email";
          if (emailInput) emailInput.placeholder = "Username or you@example.com";
        }
      };

      if (emailInput) emailInput.value = options.email || "";
      if (passwordInput) passwordInput.value = "";
      if (usernameInput) usernameInput.value = "";
      if (password2Input) password2Input.value = "";
      setStatus("");
      renderMode();

      const close = (result, error) => {
        popup.classList.add("hidden");
        submitBtn.onclick = null;
        toggleBtn.onclick = null;
        cancelBtn.onclick = null;
        if (resetBtn) resetBtn.onclick = null;
        if (emailInput) emailInput.onkeydown = null;
        if (passwordInput) passwordInput.onkeydown = null;
        if (usernameInput) usernameInput.onkeydown = null;
        if (password2Input) password2Input.onkeydown = null;
        if (error) reject(error);
        else resolve(result);
      };

      const submit = async () => {
        const identifier = (emailInput?.value || "").trim();
        const password = passwordInput?.value || "";
        if (!identifier) {
          setStatus(mode === "signup" ? "Enter your email." : "Enter your username or email.", "err");
          emailInput?.focus();
          return;
        }
        if (!password) { setStatus("Enter your password.", "err"); passwordInput?.focus(); return; }
        let username = "";
        if (mode === "signup") {
          username = (usernameInput?.value || "").trim();
          const password2 = password2Input?.value || "";
          if (!username) { setStatus("Choose a username.", "err"); usernameInput?.focus(); return; }
          if (password !== password2) {
            setStatus("Passwords don't match — re-type it to confirm.", "err");
            password2Input?.focus();
            return;
          }
          if (identifier.indexOf("@") < 0) {
            setStatus("Sign-up needs a real email address.", "err");
            emailInput?.focus();
            return;
          }
        }
        try {
          setStatus(mode === "signup" ? "Creating account…" : "Signing in…", "pending");
          if (submitBtn) submitBtn.disabled = true;
          let cred;
          if (mode === "signup") {
            // Reject a taken username before the account is created.
            const free = await window.isUsernameAvailable(username);
            if (!free) {
              setStatus("That username is already taken — pick another.", "err");
              if (submitBtn) submitBtn.disabled = false;
              usernameInput?.focus();
              return;
            }
            cred = await window.signUpWithEmail(identifier, password);
            // Claim the username + save the profile. Non-fatal on failure —
            // the account exists; the username can still be set later.
            if (typeof window.saveUserProfile === "function") {
              try { await window.saveUserProfile({ username, photo: "" }); } catch (e) { /* non-fatal */ }
            }
          } else {
            // Sign in by email or username — a value without "@" is treated
            // as a username and resolved to its account email first.
            let email = identifier;
            if (identifier.indexOf("@") < 0) {
              email = await window.lookupUsernameEmail(identifier);
              if (!email) {
                setStatus("No account found with that username.", "err");
                if (submitBtn) submitBtn.disabled = false;
                emailInput?.focus();
                return;
              }
            }
            cred = await window.signInWithEmail(email, password);
          }
          setStatus(mode === "signup" ? "Account created ✓" : "Signed in ✓", "ok");
          if (typeof options.onSignedIn === "function") options.onSignedIn(cred.user);
          setTimeout(() => close(cred.user), 600);
        } catch (e) {
          setStatus(window.describeAuthError(e), "err");
          if (submitBtn) submitBtn.disabled = false;
        }
      };

      const toggle = () => {
        mode = mode === "signin" ? "signup" : "signin";
        setStatus("");
        renderMode();
        passwordInput?.focus();
      };

      const resetPassword = async () => {
        const email = (emailInput?.value || "").trim();
        if (!email) { setStatus("Enter your email first, then tap Reset password.", "err"); emailInput?.focus(); return; }
        try {
          setStatus("Sending reset email…", "pending");
          await window.sendPasswordResetEmail(email);
          setStatus("Reset email sent. Check your inbox.", "ok");
        } catch (e) {
          setStatus(window.describeAuthError(e), "err");
        }
      };

      submitBtn.onclick = submit;
      toggleBtn.onclick = toggle;
      cancelBtn.onclick = () => close(null, new Error("cancelled"));
      if (resetBtn) resetBtn.onclick = resetPassword;
      const keyHandler = (e) => {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
        else if (e.key === "Escape") { e.preventDefault(); close(null, new Error("cancelled")); }
      };
      if (emailInput) emailInput.onkeydown = keyHandler;
      if (passwordInput) passwordInput.onkeydown = keyHandler;
      if (usernameInput) usernameInput.onkeydown = keyHandler;
      if (password2Input) password2Input.onkeydown = keyHandler;

      popup.classList.remove("hidden");
      setTimeout(() => (options.email ? passwordInput : emailInput)?.focus(), 0);
    });
  };

  // Lightweight "require sign-in then continue" helper. Resolves with the
  // current user if already signed in; otherwise pops the sign-in modal
  // and resolves once they finish. Rejects if cancelled.
  window.requireSignIn = async function requireSignIn(options = {}) {
    const a = window.getFirebaseAuth();
    if (!a) return Promise.reject(new Error("Auth not configured."));
    if (a.currentUser) return a.currentUser;
    // Wait briefly for any pending auth restore from localStorage before
    // popping the modal — Firebase fires onAuthStateChanged once at boot.
    if (!authReady) {
      await new Promise(resolve => {
        const unsub = a.onAuthStateChanged(u => { authReady = true; lastUser = u; resolve(); unsub && unsub(); });
      });
      if (a.currentUser) return a.currentUser;
    }
    return window.showSignInPopup(options);
  };

  // ===== User profile (username + photo) — stored at users/{uid} in the
  // Realtime Database. The photo is a downscaled JPEG data-URL (no Firebase
  // Storage needed). Cached in `currentProfile` so synchronous callers (e.g.
  // the tournament room badge) can read it without a round-trip. =====
  let currentProfile = null;

  window.getUserProfile = function getUserProfile() { return currentProfile; };

  function profileDbRef(uid) {
    try {
      if (typeof firebase === "undefined" || !firebase.database || !uid) return null;
      return firebase.database().ref("users/" + uid);
    } catch (e) { return null; }
  }

  // ===== Username index — usernames/{key} → { uid, email }. Powers
  // username-or-email sign-in and username uniqueness. The key is the
  // username lowercased with Firebase-illegal chars swapped to "_". =====
  function usernameKey(name) {
    return String(name || "").trim().toLowerCase().replace(/[.#$/\[\]]/g, "_");
  }
  // Exposed so other tabs can derive the same key without re-encoding it.
  window.usernameKey = usernameKey;

  // Map of "user tag" → "public Firebase index node" that other tabs
  // read without needing access to the whole users tree:
  //   Judge          → judges/{usernameKey}: username
  //   Revox Member   → revoxAccounts/{usernameKey}: username
  //   Revox Admin    → revoxAccounts/{usernameKey}: username
  //
  // Two tags can target the same node (Revox Member / Admin both feed
  // the Revox tab's Add-Result dropdown), so the helpers below collapse
  // duplicates and only clear an index entry when the user no longer
  // carries ANY tag pointing at it.
  const PUBLIC_TAG_INDEXES = {
    "Judge":        "judges",
    "Revox Member": "revoxAccounts",
    "Revox Admin":  "revoxAccounts"
  };
  function publicIndexesForTag(tag) {
    const node = PUBLIC_TAG_INDEXES[tag];
    return node ? [node] : [];
  }
  function publicIndexesForTagList(tagList) {
    const set = new Set();
    (tagList || []).forEach(t => {
      const node = PUBLIC_TAG_INDEXES[t];
      if (node) set.add(node);
    });
    return Array.from(set);
  }
  function allPublicIndexNodes() {
    return Array.from(new Set(Object.values(PUBLIC_TAG_INDEXES)));
  }
  // Exposed so other tabs (e.g. the Revox tab's Add-Result dropdown) can
  // read the public index node names without re-encoding them.
  window.PUBLIC_TAG_INDEX_NODES = Object.freeze({ ...PUBLIC_TAG_INDEXES });
  function usernamesDbRef() {
    try {
      if (typeof firebase === "undefined" || !firebase.database) return null;
      return firebase.database().ref("usernames");
    } catch (e) { return null; }
  }

  // Resolve a username to the account email behind it (or null if unknown).
  window.lookupUsernameEmail = function lookupUsernameEmail(username) {
    const ref = usernamesDbRef();
    const key = usernameKey(username);
    if (!ref || !key) return Promise.resolve(null);
    return ref.child(key).once("value")
      .then(snap => { const v = snap.val(); return (v && v.email) || null; })
      .catch(() => null);
  };

  // Is `username` free to take? Resolves true if available. A key already
  // owned by `selfUid` counts as available (re-saving your own name is fine).
  window.isUsernameAvailable = function isUsernameAvailable(username, selfUid) {
    const ref = usernamesDbRef();
    const key = usernameKey(username);
    if (!ref || !key) return Promise.resolve(true); // no DB → can't check, allow
    return ref.child(key).once("value")
      .then(snap => {
        const v = snap.val();
        return !v || (!!selfUid && v.uid === selfUid);
      })
      .catch(() => true);
  };

  // Write the signed-in user's username index entry and free their old key.
  function claimUsername(uid, email, username, prevUsername) {
    const ref = usernamesDbRef();
    const key = usernameKey(username);
    if (!ref || !uid || !key) return Promise.resolve();
    const updates = {};
    // Store the cased username too so the Developer user list can show it.
    updates[key] = { uid, email: email || "", username: String(username || "").trim().slice(0, 30) };
    const prevKey = usernameKey(prevUsername);
    if (prevKey && prevKey !== key) updates[prevKey] = null;
    return ref.update(updates).catch(e => console.warn("Username claim failed:", e));
  }

  // Fetch the signed-in user's profile into the cache. Resolves with the
  // profile object (or null when signed out / sync unavailable).
  window.loadUserProfile = function loadUserProfile() {
    const u = window.getCurrentUser();
    if (!u) { currentProfile = null; return Promise.resolve(null); }
    const ref = profileDbRef(u.uid);
    if (!ref) return Promise.resolve(null);
    return ref.once("value")
      .then(snap => {
        const v = snap.val() || {};
        // Tags (e.g. "Developer") are admin-assigned badges. Stored as a map
        // users/{uid}/tags = { TagName: true }; a legacy single `tag` string
        // is still honoured so older entries keep working.
        const tagsMap = v.tags || {};
        const tags = Object.keys(tagsMap).filter(k => tagsMap[k]);
        if (v.tag && tags.indexOf(v.tag) < 0) tags.push(v.tag);
        currentProfile = {
          username: v.username || "", photo: v.photo || "",
          banner: v.banner || "", bio: v.bio || "",
          tags: tags
        };
        window.dispatchEvent(new Event("userprofilechange"));
        // Background pass: read /achievements/{usernameKey} and mirror any
        // awarded achievements onto the user's tags. Lets a player who
        // crossed 100 wins in a tournament see the matching title + theme
        // on their next sign-in / refresh without a manual step.
        mirrorAchievementTags(u, currentProfile);
        return currentProfile;
      })
      .catch(() => null);
  };

  // Reads /achievements/{uid} (keyed by Firebase Auth UID — see
  // js/achievements.js) and ensures every awarded achievement has its
  // matching tag on users/{uid}/tags. No-op when nothing to mirror
  // (counters not yet at target, or tag already present). Failures are
  // non-fatal so a missing rule / read denial doesn't break sign-in.
  function mirrorAchievementTags(user, profile) {
    if (!user || !profile || !profile.username) return;
    if (!window.ACHIEVEMENTS) return; // shared module not loaded on this page
    let db;
    try { db = firebase.database(); } catch (e) { db = null; }
    if (!db) return;
    db.ref("achievements/" + user.uid).once("value").then(snap => {
      const v = snap.val() || {};
      const existing = Array.isArray(profile.tags) ? profile.tags.slice() : [];
      const existingSet = new Set(existing);
      const updates = {};
      let touched = false;
      for (const def of window.ACHIEVEMENTS) {
        const node = v[def.id];
        if (!node || node.awarded !== true) continue;
        if (existingSet.has(def.tag)) continue;
        updates["tags/" + def.tag] = true;
        existing.push(def.tag);
        existingSet.add(def.tag);
        touched = true;
      }
      if (!touched) return;
      const ref = db.ref("users/" + user.uid);
      ref.update(updates).then(() => {
        // Refresh the local cache so the new tag is visible immediately —
        // medal-theme gate, profile card, settings dropdown all read from
        // currentProfile.tags, so a fire-and-forget re-dispatch keeps the
        // UI honest without a second profile read.
        currentProfile = Object.assign({}, currentProfile, { tags: existing });
        window.dispatchEvent(new Event("userprofilechange"));
      }).catch(e => console.warn("Achievement tag mirror failed:", e && e.message));
    }).catch(() => { /* read failed — try again next sign-in */ });
  }

  // Persist the signed-in user's profile. `username` is trimmed/capped and
  // must be unique across accounts; `photo` is a (downscaled) data-URL or "".
  // Rejects if the username is already taken by someone else.
  window.saveUserProfile = function saveUserProfile(profile) {
    const u = window.getCurrentUser();
    if (!u) return Promise.reject(new Error("Not signed in."));
    const ref = profileDbRef(u.uid);
    if (!ref) return Promise.reject(new Error("Live sync isn't configured on this build."));
    let db;
    try { db = firebase.database(); } catch (e) { db = null; }
    // A caller that omits photo/banner keeps the existing one (avoids wiping
    // a field when only the username is being changed). photoPos / bannerPos
    // are CSS object-position strings like "50% 30%" — they let the user
    // pick what part of the uploaded image stays in the visible crop.
    const clean = {
      username: String((profile && profile.username) || "").trim().slice(0, 30),
      photo: (profile && typeof profile.photo === "string")
        ? profile.photo : ((currentProfile && currentProfile.photo) || ""),
      banner: (profile && typeof profile.banner === "string")
        ? profile.banner : ((currentProfile && currentProfile.banner) || ""),
      photoPos: (profile && typeof profile.photoPos === "string")
        ? profile.photoPos.slice(0, 16)
        : ((currentProfile && currentProfile.photoPos) || ""),
      bannerPos: (profile && typeof profile.bannerPos === "string")
        ? profile.bannerPos.slice(0, 16)
        : ((currentProfile && currentProfile.bannerPos) || ""),
      bio: (profile && typeof profile.bio === "string")
        ? profile.bio.slice(0, 300) : ((currentProfile && currentProfile.bio) || "")
    };
    const prevUsername = (currentProfile && currentProfile.username) || "";
    return window.isUsernameAvailable(clean.username, u.uid).then(ok => {
      if (!ok) throw new Error("That username is already taken — pick another.");
      // .update (not .set) so admin-set fields like `tag` aren't wiped.
      return ref.update(clean);
    }).then(() => {
      // If the username changed, drop the stale public-profile mirror for
      // the OLD key first — the profiles write rule keys off
      // usernames/<key>/uid, and claimUsername is about to clear that
      // mapping for the old key (making the delete impossible afterwards).
      const newKey = usernameKey(clean.username);
      const oldKey = usernameKey(prevUsername);
      if (db && oldKey && oldKey !== newKey) {
        return db.ref("profiles/" + oldKey).set(null).catch(() => {});
      }
    }).then(() => {
      return claimUsername(u.uid, u.email || "", clean.username, prevUsername);
    }).then(() => {
      // Mirror the profile into the public `profiles/{usernameKey}` index
      // so other tabs (tournament registrant avatars, profile hover
      // cards) can show photo / banner / bio without read access to the
      // private users tree. .update — not .set — so the Developer-set
      // `tags` child stays intact.
      const key = usernameKey(clean.username);
      if (db && key) {
        return db.ref("profiles/" + key).update({
          username: clean.username,
          photo: clean.photo,
          banner: clean.banner,
          photoPos: clean.photoPos,
          bannerPos: clean.bannerPos,
          bio: clean.bio
        }).catch(() => {});
      }
    }).then(() => {
      currentProfile = Object.assign({}, currentProfile, clean);
      window.dispatchEvent(new Event("userprofilechange"));
      return currentProfile;
    });
  };

  // Keep the cached profile in step with auth state.
  window.onAuthChange(u => {
    if (u) window.loadUserProfile();
    else { currentProfile = null; window.dispatchEvent(new Event("userprofilechange")); }
  });

  // ===== Account tab icon — mirror the profile photo onto the nav tab on
  // every page. Falls back to a neutral silhouette when there's no photo. =====
  const ACCOUNT_TAB_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%2321262d'/%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";
  function paintAccountTabAvatar() {
    const img = document.getElementById("account-tab-avatar");
    if (!img) return;
    // Only show the photo while actually signed in — a signed-out session
    // always falls back to the blank silhouette, even if a stale profile is
    // still cached.
    const photo = window.getCurrentUser() && currentProfile && currentProfile.photo;
    img.src = photo || ACCOUNT_TAB_PLACEHOLDER;
  }
  window.addEventListener("userprofilechange", paintAccountTabAvatar);
  // Repaint on every auth change too, so signing out reverts the icon to the
  // blank silhouette immediately — not reliant on the profile-change event.
  window.onAuthChange(() => paintAccountTabAvatar());
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", paintAccountTabAvatar);
  } else {
    paintAccountTabAvatar();
  }

  // True when the current account carries the given admin-assigned tag.
  function hasTag(name) {
    return !!(currentProfile && currentProfile.tags &&
      currentProfile.tags.indexOf(name) >= 0);
  }

  // Exposed so other scripts (e.g. the Revox ranking) can gate writes on the
  // "Revox Admin" tag instead of a separate password login.
  window.isRevoxAdmin = function isRevoxAdmin() { return hasTag("Revox Admin"); };

  // Exposed so the Tournament tab can hide the "Test" button (which bulk-adds
  // synthetic participants) from accounts that aren't on the QA team.
  window.isTester = function isTester() { return hasTag("Tester"); };

  // Exposed so the Tournament tab can gate "Create Tournament" — hosting
  // requires the "Judge" tag (set by a developer).
  window.isJudge = function isJudge() { return hasTag("Judge"); };

  // The signed-in account's username ("" when signed out / no profile yet).
  // Used by the tournament sub-host list to match designated co-hosts.
  window.getCurrentUsername = function getCurrentUsername() {
    return (currentProfile && currentProfile.username) || "";
  };

  // The signed-in account's profile photo data-URL ("" when none). Lets
  // other tabs paint the current user's own avatar straight from the
  // in-memory profile, with no dependency on the public profiles mirror.
  window.getCurrentUserPhoto = function getCurrentUserPhoto() {
    return (window.getCurrentUser() && currentProfile && currentProfile.photo) || "";
  };

  // A shallow copy of the signed-in account's cached profile (username,
  // photo, banner, bio, tags[]) or null. Lets other tabs render the
  // current user's own profile card without a Firebase round-trip — and
  // without depending on the public `profiles` mirror / its read rule.
  window.getCurrentProfile = function getCurrentProfile() {
    if (!window.getCurrentUser() || !currentProfile) return null;
    return {
      username: currentProfile.username || "",
      photo: currentProfile.photo || "",
      banner: currentProfile.banner || "",
      bio: currentProfile.bio || "",
      tags: Array.isArray(currentProfile.tags) ? currentProfile.tags.slice() : []
    };
  };

  // ===== Developer area — a tab + page visible only to accounts whose
  // profile carries the "Developer" tag. Lets a developer browse every
  // registered user, search them, and assign tags. =====
  function isDeveloper() {
    return hasTag("Developer");
  }

  // Show / hide the Developer tab on every page based on the current account.
  // The current page's own tab (`.active`) is never hidden — hiding it would
  // make the tab you're standing on blink out while the profile loads.
  function paintDeveloperTab() {
    const show = isDeveloper();
    document.querySelectorAll('.tab[data-mode="developer"]').forEach(tab => {
      tab.classList.toggle("hidden", !show && !tab.classList.contains("active"));
    });
  }

  // After a conditional tab (Revox / Developer) is shown or hidden, the tab
  // bar's width changes — which can scroll the *current* page's tab out of
  // view. Nudge it back so the active tab always stays visible.
  function ensureActiveTabVisible() {
    const bar = document.querySelector(".mode-tabs");
    const active = bar && bar.querySelector(".tab.active");
    if (!bar || !active) return;
    const barRect = bar.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < barRect.left) {
      bar.scrollLeft -= (barRect.left - tabRect.left) + 8;
    } else if (tabRect.right > barRect.right) {
      bar.scrollLeft += (tabRect.right - barRect.right) + 8;
    }
  }

  // The Revox tab is shown to "Revox Admin" (full edit) and "Revox Member"
  // (view only) accounts. As with the Developer tab, the current page's own
  // tab is never hidden. Write access stays gated separately on "Revox Admin".
  function paintRevoxTab() {
    const show = hasTag("Revox Admin") || hasTag("Revox Member");
    document.querySelectorAll('.tab[data-mode="revox"]').forEach(tab => {
      tab.classList.toggle("hidden", !show && !tab.classList.contains("active"));
    });
  }

  // The Achievement tab is visible to any signed-in account (no tag gate —
  // anyone with a profile can see their own achievements). Same "current
  // page's own tab is never hidden" rule applies so a signed-out user
  // already on the page doesn't watch the tab blink out.
  function paintAchievementTab() {
    const show = !!currentProfile;
    document.querySelectorAll('.tab[data-mode="achievement"]').forEach(tab => {
      tab.classList.toggle("hidden", !show && !tab.classList.contains("active"));
    });
  }

  // Achievement themes — Dragon Tamer / Dragon Slayer / Lonewolf. Each is
  // gated on the matching achievement tag (awarded at 100 wins, see
  // tournament.js + js/achievements.js). The theme-menu entry is shown
  // only while the tag is held; if the account loses the tag and a
  // restricted achievement theme is active, it falls back to Dark.
  const ACHIEVEMENT_THEME_TAGS = {
    dragontamer: "Dragon Tamer",
    dragonslayer: "Dragon Slayer",
    lonewolf: "Lonewolf"
  };
  function applyAchievementThemeGate() {
    const unlocked = {};
    Object.keys(ACHIEVEMENT_THEME_TAGS).forEach(v => {
      unlocked[v] = hasTag(ACHIEVEMENT_THEME_TAGS[v]);
      document.querySelectorAll(
        '#setting-theme .setting-dropdown-option[data-value="' + v + '"]'
      ).forEach(opt => opt.classList.toggle("hidden", !unlocked[v]));
    });
    // Demote an active achievement theme if the tag has been revoked.
    let stored = null;
    try { stored = localStorage.getItem("theme"); } catch (e) {}
    if (stored && Object.prototype.hasOwnProperty.call(unlocked, stored) && !unlocked[stored]) {
      const theme = window.themeSetting;
      if (theme && theme.set) theme.set("dark");
      else {
        document.body.classList.remove(stored + "-mode");
        try { localStorage.setItem("theme", "dark"); } catch (e) {}
      }
    }
  }

  // The Revox theme is for Revox club accounts — "Revox Admin" and "Revox
  // Member". It's applied automatically the FIRST time an account gains
  // Revox access (club-identity default), after which the user is free to
  // pick any other theme and have it stick. For non-Revox accounts the
  // "Revox" entry in the Settings theme menu is hidden and any lingering
  // "revox" selection falls back to Dark.
  function applyRevoxThemeGate() {
    const isRevoxUser = hasTag("Revox Admin") || hasTag("Revox Member");

    // Show / hide the Revox entry in the theme menu on every page.
    document.querySelectorAll(
      '#setting-theme .setting-dropdown-option[data-value="revox"]'
    ).forEach(opt => opt.classList.toggle("hidden", !isRevoxUser));

    const theme = window.themeSetting;
    let stored = null, seeded = null;
    try {
      stored = localStorage.getItem("theme");
      seeded = localStorage.getItem("revoxThemeSeeded");
    } catch (e) {}

    if (isRevoxUser) {
      // Seed the Revox theme just once per device. After this the gate
      // never forces it again, so switching to another theme sticks.
      if (!seeded) {
        if (stored !== "revox" && theme && theme.set) theme.set("revox");
        try { localStorage.setItem("revoxThemeSeeded", "1"); } catch (e) {}
      }
    } else {
      // Not a Revox account (any more) — clear the seed flag so a future
      // re-grant re-seeds, and drop the restricted theme if it's active.
      try { localStorage.removeItem("revoxThemeSeeded"); } catch (e) {}
      if (stored === "revox") {
        if (theme && theme.set) theme.set("dark");
        else {
          document.body.classList.remove("revox-mode");
          try { localStorage.setItem("theme", "dark"); } catch (e) {}
        }
      }
    }
  }

  // True once Firebase has reported the initial auth state — lets the
  // medal gate tell a confirmed "signed out" from "auth not resolved yet".
  let medalGateAuthReady = false;

  // Medal themes — "gold" / "silver" / "bronze" — are reward themes unlocked
  // while the account holds the matching ranking medal tag (Gold / Silver /
  // Bronze Player). The matching theme-menu entry is shown only while the
  // medal is held; if the account loses the medal (drops out of the
  // ranking's top 3) and its medal theme is active, it falls back to Dark.
  // The medal status comes from tournament.js's live ranking cache.
  function applyMedalThemeGate() {
    const uname = (window.getCurrentUsername && window.getCurrentUsername()) || "";
    const medal = (typeof window.medalTagForName === "function")
      ? window.medalTagForName(uname) : "";
    const unlocked = medal === "Gold Player" ? "gold"
      : medal === "Silver Player" ? "silver"
      : medal === "Bronze Player" ? "bronze" : "";

    // Show only the unlocked medal theme in the menu; hide the others.
    ["gold", "silver", "bronze"].forEach(v => {
      document.querySelectorAll(
        '#setting-theme .setting-dropdown-option[data-value="' + v + '"]'
      ).forEach(opt => opt.classList.toggle("hidden", v !== unlocked));
    });

    // Revoking an active medal theme is only safe once we KNOW the real
    // medal status. That needs three things settled — otherwise a slow
    // profile load on a fresh page would wrongly demote a legitimate
    // medal theme before the standing is known:
    //   1. the ranking has loaded (rankingMedalsReady),
    //   2. Firebase has reported the initial auth state (medalGateAuthReady),
    //   3. if signed in, the profile (username) has actually loaded.
    if (window.rankingMedalsReady !== true) return;
    if (!medalGateAuthReady) return;
    const signedIn = !!(window.getCurrentUser && window.getCurrentUser());
    if (signedIn && !uname) return; // profile still loading — medal unknown

    let stored = null;
    try { stored = localStorage.getItem("theme"); } catch (e) {}
    if ((stored === "gold" || stored === "silver" || stored === "bronze") && stored !== unlocked) {
      const theme = window.themeSetting;
      if (theme && theme.set) theme.set("dark");
      else {
        document.body.classList.remove("gold-mode", "silver-mode", "bronze-mode");
        try { localStorage.setItem("theme", "dark"); } catch (e) {}
      }
    }
  }
  // The ranking cache loads / changes asynchronously — re-run the gate when
  // it does, so a medal won/lost flips the theme menu (and revokes a stale
  // medal theme) without needing a reload.
  window.addEventListener("rankingmedalschange", applyMedalThemeGate);
  // Mark auth resolved on the first auth callback, then re-run the gate so
  // a confirmed sign-out (or completed sign-in) is acted on.
  window.onAuthChange(() => { medalGateAuthReady = true; applyMedalThemeGate(); });

  function devEscHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  let developerUsers = [];

  // Load every registered user from the usernames index, plus each user's
  // current tags, into developerUsers.
  function loadDeveloperUsers() {
    const listEl = document.getElementById("developer-user-list");
    const countEl = document.getElementById("developer-count");
    const statusEl = document.getElementById("developer-status");
    if (!listEl) return;
    const setStatus = (m) => { if (statusEl) statusEl.textContent = m || ""; };
    let db;
    try { db = firebase.database(); } catch (e) { db = null; }
    if (!db) { setStatus("Live sync isn't configured on this build."); return; }
    setStatus("Loading users…");
    db.ref("usernames").once("value").then(snap => {
      const val = snap.val() || {};
      developerUsers = Object.keys(val).map(k => ({
        uid: (val[k] && val[k].uid) || "",
        email: (val[k] && val[k].email) || "",
        username: (val[k] && val[k].username) || k,
        tags: []
      })).filter(u => u.uid);
      developerUsers.sort((a, b) => a.username.localeCompare(b.username));
      if (countEl) countEl.textContent = "Registered users: " + developerUsers.length;
      // Pull each user's tag map + profile photo (the Developer read rule
      // covers users/*). The photo is a 128px JPEG (a few KB), so sweeping
      // it in is cheap — and it lets the profiles backfill below publish
      // avatars without waiting for each member to re-save their profile.
      return Promise.all(developerUsers.map(u =>
        db.ref("users/" + u.uid).once("value")
          .then(s => s.val() || {})
          .catch(() => ({}))
      ));
    }).then(userRecords => {
      (developerUsers || []).forEach((u, i) => {
        const rec = (userRecords && userRecords[i]) || {};
        const m = rec.tags || {};
        u.tags = Object.keys(m).filter(t => m[t]);
        u._photo = (typeof rec.photo === "string") ? rec.photo : "";
        u._banner = (typeof rec.banner === "string") ? rec.banner : "";
        u._bio = (typeof rec.bio === "string") ? rec.bio : "";
      });
      // Sync every public tag-index node (judges, revoxAccounts, …) with
      // whatever the users tree says — each visit by a Developer brings
      // the indexes back in line (covers users whose tags predate any
      // particular index's introduction). Firebase only writes the diff.
      const indexPatches = {};
      allPublicIndexNodes().forEach(node => { indexPatches[node] = {}; });
      (developerUsers || []).forEach(u => {
        if (!u.username) return;
        const key = usernameKey(u.username);
        if (!key) return;
        const coveredIndexes = new Set(publicIndexesForTagList(u.tags));
        Object.keys(indexPatches).forEach(node => {
          indexPatches[node][key] = coveredIndexes.has(node) ? u.username : null;
        });
      });
      Object.keys(indexPatches).forEach(node => {
        const patch = indexPatches[node];
        if (Object.keys(patch).length) {
          db.ref(node).update(patch).catch(() => {});
        }
      });
      // Backfill the public `profiles` index with each user's username,
      // tag set, photo, banner and bio — so hover cards, registrant
      // avatars and ranking-row banners resolve for accounts that predate
      // the profiles index, without every member having to re-save.
      (developerUsers || []).forEach(u => {
        if (!u.username) return;
        const key = usernameKey(u.username);
        if (!key) return;
        const tagMap = {};
        (u.tags || []).forEach(t => { if (t) tagMap[t] = true; });
        db.ref("profiles/" + key).update({
          username: u.username,
          photo: u._photo || "",
          banner: u._banner || "",
          bio: u._bio || "",
          tags: Object.keys(tagMap).length ? tagMap : null
        }).catch(() => {});
      });
      setStatus("");
      const search = document.getElementById("developer-search");
      renderDeveloperList(search ? search.value : "");
    }).catch(() => {
      setStatus("Couldn't load users — make sure the Developer read rule is published.");
    });
  }

  // Render the (optionally filtered) user list — each row shows the user's
  // current tags (each removable) plus an Add tag button.
  function renderDeveloperList(filter) {
    const listEl = document.getElementById("developer-user-list");
    if (!listEl) return;
    const q = String(filter || "").trim().toLowerCase();
    const rows = developerUsers.filter(u =>
      !q || u.username.toLowerCase().indexOf(q) >= 0 || u.email.toLowerCase().indexOf(q) >= 0
    );
    if (!rows.length) {
      listEl.innerHTML = '<p class="swiss-rooms-empty">' +
        (developerUsers.length ? "No users match that search." : "No registered users yet.") +
        '</p>';
      return;
    }
    listEl.innerHTML = rows.map(u => {
      const tagsHtml = (u.tags || []).map(t =>
        '<span class="developer-tag-chip">' + devEscHtml(t) +
          '<button type="button" class="developer-tag-remove" data-tag="' + devEscHtml(t) +
          '" title="Remove tag" aria-label="Remove ' + devEscHtml(t) + ' tag">&times;</button>' +
        '</span>'
      ).join("");
      return '<div class="developer-user-row" data-uid="' + devEscHtml(u.uid) +
          '" data-username="' + devEscHtml(u.username) + '">' +
          '<div class="developer-user-info">' +
            '<span class="developer-user-name developer-name-link">' + devEscHtml(u.username) + '</span>' +
            '<span class="developer-user-email">' + devEscHtml(u.email) + '</span>' +
            (tagsHtml ? '<div class="developer-user-tags">' + tagsHtml + '</div>' : '') +
          '</div>' +
          '<button type="button" class="btn btn-sm developer-tag-btn">Add tag</button>' +
        '</div>';
    }).join("");
    listEl.querySelectorAll(".developer-tag-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".developer-user-row");
        if (row) addDeveloperTag(row.dataset.uid, row.dataset.username);
      });
    });
    listEl.querySelectorAll(".developer-tag-remove").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = btn.closest(".developer-user-row");
        if (row) removeDeveloperTag(row.dataset.uid, btn.dataset.tag, row.dataset.username);
      });
    });
    // Hover or click a username to open that account's profile. The profile
    // dropdown + helpers live in tournament.js (loaded on every page).
    listEl.querySelectorAll(".developer-user-row").forEach(row => {
      const nameEl = row.querySelector(".developer-user-name");
      const uname = row.dataset.username || "";
      if (!nameEl || !uname) return;
      const show = () => {
        if (typeof window.showProfileByUsername === "function") {
          window.showProfileByUsername(uname, nameEl);
        }
      };
      nameEl.addEventListener("click", show);
      nameEl.addEventListener("mouseenter", show);
      nameEl.addEventListener("mouseleave", () => {
        if (typeof window.scheduleProfileDropdownHide === "function") {
          window.scheduleProfileDropdownHide();
        }
      });
    });
  }

  // Add a tag to one user — appends to their users/{uid}/tags map without
  // disturbing the tags they already have. For tags in PUBLIC_TAG_INDEXES
  // we also mirror the assignment into the corresponding public index node
  // (e.g. Judge → `judges/{usernameKey}`, Revox Member / Admin →
  // `revoxAccounts/{usernameKey}`) so other tabs can list those users
  // without needing read access to the whole users tree.
  function addDeveloperTag(uid, username) {
    if (!uid) return;
    let db;
    try { db = firebase.database(); } catch (e) { db = null; }
    if (!db) return;
    const userRef = db.ref("users/" + uid);
    userRef.once("value").then(snap => {
      const v = snap.val() || {};
      const existing = Object.keys(v.tags || {}).filter(k => (v.tags || {})[k]);
      if (v.tag && existing.indexOf(v.tag) < 0) existing.push(v.tag); // legacy
      const have = existing.length ? "Current tags: " + existing.join(", ") + "\n\n" : "";
      const next = prompt(have + 'Add a tag for "' + username + '":', "");
      if (next === null) return null; // cancelled
      const tag = String(next).trim().replace(/[.#$/\[\]]/g, "").slice(0, 30);
      if (!tag) return null;
      return userRef.child("tags").child(tag).set(true).then(() => tag);
    }).then(tag => {
      if (!tag) return;
      const ukey = usernameKey(username || "");
      if (ukey) {
        publicIndexesForTag(tag).forEach(node => {
          db.ref(node + "/" + ukey).set(username || "").catch(() => {});
        });
      }
      alert('Added the "' + tag + '" tag to ' + username + '.');
      loadDeveloperUsers();
    }).catch(e => {
      alert("Couldn't add the tag: " + ((e && e.message) || e));
    });
  }

  // Remove a tag from one user — clears it from the users/{uid}/tags map and,
  // if it matches the legacy single `tag` string, clears that too. For tags
  // in PUBLIC_TAG_INDEXES, we also clear the corresponding public index
  // entry — but only when the user no longer carries any OTHER tag that
  // maps to the same node (so removing "Revox Member" from a user who's
  // still "Revox Admin" keeps them in the revoxAccounts index).
  function removeDeveloperTag(uid, tag, username) {
    if (!uid || !tag) return;
    if (!confirm('Remove the "' + tag + '" tag from ' + (username || "this user") + '?')) return;
    let db;
    try { db = firebase.database(); } catch (e) { db = null; }
    if (!db) return;
    const userRef = db.ref("users/" + uid);
    const key = String(tag).replace(/[.#$/[\]]/g, "");
    const updates = {};
    if (key) updates["tags/" + key] = null;
    let remainingTags = [];
    userRef.child("tag").once("value").then(snap => {
      if (snap.val() === tag) updates["tag"] = null;
      return userRef.child("tags").once("value");
    }).then(snap => {
      const m = snap.val() || {};
      remainingTags = Object.keys(m).filter(t => m[t] && t !== tag);
      return userRef.update(updates);
    }).then(() => {
      const removedIndexes = publicIndexesForTag(tag);
      if (removedIndexes.length) {
        const stillCoveredIndexes = new Set(publicIndexesForTagList(remainingTags));
        const ukey = usernameKey(username || "");
        if (ukey) {
          removedIndexes.forEach(node => {
            if (!stillCoveredIndexes.has(node)) {
              db.ref(node + "/" + ukey).set(null).catch(() => {});
            }
          });
        }
      }
      loadDeveloperUsers();
    }).catch(e => {
      alert("Couldn't remove the tag: " + ((e && e.message) || e));
    });
  }

  // Show the right pane on the Developer page (locked vs. the dev tools).
  function renderDeveloperPage() {
    const locked = document.getElementById("developer-locked");
    const main = document.getElementById("developer-main");
    if (!locked && !main) return; // not the Developer page
    const dev = isDeveloper();
    if (locked) locked.classList.toggle("hidden", dev);
    if (main) main.classList.toggle("hidden", !dev);
    if (dev) loadDeveloperUsers();
  }

  function initDeveloperPageControls() {
    const search = document.getElementById("developer-search");
    const searchBtn = document.getElementById("developer-search-btn");
    if (search) search.addEventListener("input", () => renderDeveloperList(search.value));
    if (searchBtn && search) searchBtn.addEventListener("click", () => renderDeveloperList(search.value));

    // Users / Database sub-tab switcher. Database panel is built lazily
    // on its first activation — no point fetching tables before the
    // user clicks over.
    const tabs = document.querySelectorAll(".developer-sub-tab");
    const panels = document.querySelectorAll(".developer-sub-panel");
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        const view = tab.dataset.developerView;
        tabs.forEach(t => {
          const on = t === tab;
          t.classList.toggle("active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        panels.forEach(p => p.classList.toggle("hidden", p.id !== "developer-panel-" + view));
        if (view === "database") buildDeveloperDatabasePanel();
      });
    });

    renderDeveloperPage();
  }

  // ---------------- Developer → Database panel ----------------
  // Browses the top-level Firebase nodes in table form. Each preset
  // defines a column list; falls back to deriving columns from the first
  // entry's keys for unknown nodes. Long strings (data URLs) get
  // summarized to "[N KB]" so a profile photo blob doesn't trash the
  // viewport. Refresh re-pulls the live node. userDecks / userTournaments
  // aren't listed — those are per-user-private and the Developer's read
  // would be rejected anyway by the per-uid .read rule.
  const DB_NODES = [
    "swissRooms",
    "openTournaments",
    "users",
    "usernames",
    "profiles",
    "ranking",
    "revoxRanking",
    "winRates",
    "judges",
    "revoxAccounts",
    "swissViewCodes"
  ];

  const DB_COLUMN_PRESETS = {
    swissRooms:      ["tournamentName", "mode", "phase", "hostName", "hostUid", "topN", "createdAt"],
    openTournaments: ["name", "mode", "phase", "registrantCount", "groupCount", "roundCount", "hostUid", "createdAt"],
    users:           ["username", "tag", "tags", "bio", "photo", "banner"],
    usernames:       ["uid", "username", "email"],
    profiles:        ["username", "bio", "tags", "photo", "banner"],
    ranking:         ["points"],
    revoxRanking:    ["points", "results"],
    winRates:        ["username", "wins", "losses", "ties", "updatedAt"],
    judges:          [],  // value is a plain string
    revoxAccounts:   [],
    swissViewCodes:  []
  };

  function buildDeveloperDatabasePanel() {
    const panel = document.getElementById("developer-panel-database");
    if (!panel) return;
    if (panel.dataset.dbInit) return;
    panel.dataset.dbInit = "1";

    // One tab per node — replaces the earlier dropdown so every node is
    // visible at a glance. The row scrolls horizontally on narrow viewports
    // (touch-friendly) rather than wrapping into a tall block.
    const tabsHtml = DB_NODES.map((n, i) =>
      `<button type="button" class="developer-db-tab${i === 0 ? " active" : ""}" data-db-node="${n}">${n}</button>`
    ).join("");
    panel.innerHTML = `
      <div class="developer-db-tabs" role="tablist">${tabsHtml}</div>
      <div class="developer-db-toolbar">
        <button type="button" id="developer-db-add" class="btn btn-sm">+ Add entry</button>
        <button type="button" id="developer-db-refresh" class="btn btn-sm">Refresh</button>
      </div>
      <p class="swiss-join-status" id="developer-db-status"></p>
      <div class="developer-db-table-wrap"><div id="developer-db-table"></div></div>
    `;
    const tabs = panel.querySelectorAll(".developer-db-tab");
    const refresh = panel.querySelector("#developer-db-refresh");
    const addBtn = panel.querySelector("#developer-db-add");
    const tableEl = panel.querySelector("#developer-db-table");
    let activeNode = DB_NODES[0];
    let lastEntries = [];
    const load = () => renderDatabaseNode(activeNode, (entries) => {
      lastEntries = entries || [];
    });
    tabs.forEach(tab => {
      tab.addEventListener("click", () => {
        activeNode = tab.dataset.dbNode;
        tabs.forEach(t => t.classList.toggle("active", t === tab));
        load();
      });
    });
    refresh.addEventListener("click", load);
    addBtn.addEventListener("click", () => {
      openDbEditJsonPopup({
        nodeKey: activeNode,
        keyName: "",
        value: null,
        isNew: true,
        onSaved: load
      });
    });
    // Per-row action buttons — delegate so the handler survives re-renders.
    tableEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".developer-db-act");
      if (!btn) return;
      const act = btn.dataset.act;
      const key = btn.dataset.key;
      const entry = lastEntries.find(([k]) => k === key);
      const value = entry ? entry[1] : null;
      if (act === "delete") {
        confirmDeleteDbEntry(activeNode, key, load);
      } else if (act === "edit-fields") {
        openDbEditFieldsPopup({ nodeKey: activeNode, keyName: key, value, onSaved: load });
      } else if (act === "edit-json") {
        openDbEditJsonPopup({ nodeKey: activeNode, keyName: key, value, isNew: false, onSaved: load });
      }
    });
    load();
  }

  function renderDatabaseNode(nodeKey, onLoaded) {
    const tableEl = document.getElementById("developer-db-table");
    const statusEl = document.getElementById("developer-db-status");
    if (!tableEl || !statusEl) return;
    statusEl.textContent = "Loading…";
    statusEl.classList.remove("is-ok", "is-err", "is-pending");
    statusEl.classList.add("is-pending");
    tableEl.innerHTML = "";
    let db;
    try { db = firebase.database(); } catch (e) { db = null; }
    if (!db) {
      statusEl.textContent = "Firebase not configured.";
      statusEl.classList.replace("is-pending", "is-err");
      return;
    }
    db.ref(nodeKey).once("value").then(snap => {
      const val = snap.val();
      if (val == null) {
        statusEl.textContent = "Empty.";
        statusEl.classList.replace("is-pending", "is-ok");
        if (typeof onLoaded === "function") onLoaded([]);
        return;
      }
      const entries = Object.entries(val);
      if (typeof onLoaded === "function") onLoaded(entries);
      statusEl.textContent = `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`;
      statusEl.classList.replace("is-pending", "is-ok");
      // winRates keys are sanitized lowercase usernames — not super
      // readable. Resolve each to the actual cased username from the
      // public /profiles index so the table shows recognizable names
      // alongside the W/L/T counts. One bulk read; the rule change
      // already gives Developers a wildcard /profiles .read.
      if (nodeKey === "winRates") {
        db.ref("profiles").once("value").then(pSnap => {
          const profiles = pSnap.val() || {};
          entries.forEach(([k, v]) => {
            if (v && typeof v === "object") {
              const p = profiles[k];
              v.username = (p && p.username) || "";
            }
          });
          tableEl.innerHTML = renderDbTableHtml(nodeKey, entries);
        }).catch(() => {
          // Profiles read failed — still render winRates without names.
          tableEl.innerHTML = renderDbTableHtml(nodeKey, entries);
        });
        return;
      }
      tableEl.innerHTML = renderDbTableHtml(nodeKey, entries);
    }).catch(err => {
      console.warn("[db viewer] read failed:", nodeKey, err);
      statusEl.textContent = "Read failed: " + (err && err.message ? err.message : err);
      statusEl.classList.replace("is-pending", "is-err");
    });
  }

  function renderDbTableHtml(nodeKey, entries) {
    const escape = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    // Columns: union of every key across every entry, so no field is
    // silently hidden. Preset keys (for the nodes that have them) come
    // first in their preset order; any extra keys follow alphabetically.
    const firstVal = entries[0] && entries[0][1];
    const firstIsScalar = (firstVal == null) || typeof firstVal !== "object";
    let cols = [];
    if (!firstIsScalar) {
      const all = new Set();
      entries.forEach(([, v]) => {
        if (v && typeof v === "object") Object.keys(v).forEach(k => all.add(k));
      });
      const preset = (DB_COLUMN_PRESETS[nodeKey] || []).filter(k => all.has(k));
      const presetSet = new Set(preset);
      const remaining = Array.from(all).filter(k => !presetSet.has(k)).sort();
      cols = preset.concat(remaining);
    }
    const valueCol = firstIsScalar ? "Value" : null;
    const head = `<thead><tr><th>Key</th>${
      valueCol
        ? `<th>${escape(valueCol)}</th>`
        : cols.map(c => `<th>${escape(c)}</th>`).join("")
    }<th class="developer-db-actions-h">Actions</th></tr></thead>`;
    const rows = entries.map(([key, val]) => {
      let cells;
      if (firstIsScalar) {
        cells = `<td data-col="${escape(valueCol || "Value")}">${escape(formatDbCell(val))}</td>`;
      } else if (val == null || typeof val !== "object") {
        cells = `<td colspan="${cols.length}" data-col="Value">${escape(formatDbCell(val))}</td>`;
      } else {
        // data-col on every cell so the mobile card layout can render the
        // column name as an inline label via CSS ::before.
        cells = cols.map(c => `<td data-col="${escape(c)}">${escape(formatDbCell(val[c]))}</td>`).join("");
      }
      const actions = `
        <td class="developer-db-actions" data-col="Actions">
          <button type="button" class="developer-db-act" data-act="edit-fields" data-key="${escape(key)}" title="Edit fields">&#9998;</button>
          <button type="button" class="developer-db-act" data-act="edit-json"   data-key="${escape(key)}" title="Edit raw JSON">{}</button>
          <button type="button" class="developer-db-act developer-db-act-del" data-act="delete" data-key="${escape(key)}" title="Delete">&#128465;</button>
        </td>`;
      return `<tr><td class="developer-db-key" data-col="Key">${escape(key)}</td>${cells}${actions}</tr>`;
    }).join("");
    return `<table class="developer-db-table-inner">${head}<tbody>${rows}</tbody></table>`;
  }

  // ---- Edit / delete / add helpers ----
  // Write attempts surface PERMISSION_DENIED loudly — Developers can write
  // most public-index nodes but a few (swissRooms unless you're the host,
  // usernames unless you own the key, userDecks / userTournaments) are
  // restricted by the per-path rules. The alert tells you to update rules
  // or pick a different node rather than fail silently.
  function dbAlertOk(msg) { alert(msg); }
  function dbAlertErr(msg) { alert(msg); }

  function confirmDeleteDbEntry(nodeKey, keyName, onDone) {
    if (!keyName) return;
    if (!confirm(`Delete ${nodeKey}/${keyName}?\n\nThis can't be undone.`)) return;
    const db = firebase.database();
    db.ref(`${nodeKey}/${keyName}`).set(null).then(() => {
      onDone?.();
    }).catch(err => {
      console.warn("[db viewer] delete failed:", err);
      dbAlertErr(`Delete failed: ${err && err.message ? err.message : err}`);
    });
  }

  // Raw JSON editor — works for any node (handles nested objects). When
  // isNew is true, the popup also exposes a Key input so the user can
  // name the new entry.
  function openDbEditJsonPopup(opts) {
    const { nodeKey, keyName, value, isNew, onSaved } = opts;
    document.getElementById("dbg-edit-popup")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "dbg-edit-popup";
    overlay.className = "popup-overlay";
    const pretty = value == null ? "{\n  \n}" : JSON.stringify(value, null, 2);
    overlay.innerHTML = `
      <div class="popup-card" style="max-width:min(600px, 92vw);">
        <h2 class="popup-title">${isNew ? "Add entry" : "Edit JSON"}</h2>
        <p class="popup-text">${nodeKey}/${isNew ? "<key>" : (keyName || "")}</p>
        ${isNew ? `
          <label class="popup-text" style="display:block;margin-top:6px;">Key</label>
          <input id="dbg-edit-key" class="account-bio" type="text" maxlength="128" style="width:100%;padding:8px 10px;" value="">
        ` : ""}
        <label class="popup-text" style="display:block;margin-top:8px;">Value (JSON)</label>
        <textarea id="dbg-edit-json" class="account-bio" rows="14" style="width:100%;min-height:240px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.78rem;">${pretty.replace(/&/g,"&amp;").replace(/</g,"&lt;")}</textarea>
        <p class="popup-text" style="font-size:0.78rem;margin-top:4px;opacity:.7;">Strings, numbers, booleans, arrays and nested objects all work. Set to <code>null</code> (without quotes) to delete on save.</p>
        <div class="popup-actions">
          <button type="button" class="btn" data-act="save">Save</button>
          <button type="button" class="btn popup-cancel" data-act="cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.querySelector('[data-act="save"]').onclick = () => {
      const ta = overlay.querySelector("#dbg-edit-json");
      const keyInput = overlay.querySelector("#dbg-edit-key");
      let parsed;
      try {
        parsed = JSON.parse(ta.value);
      } catch (e) {
        dbAlertErr("Invalid JSON: " + e.message);
        return;
      }
      const useKey = isNew ? (keyInput && keyInput.value.trim()) : keyName;
      if (!useKey) { dbAlertErr("Enter a key."); return; }
      if (/[.#$/\[\]]/.test(useKey)) {
        dbAlertErr("Key can't contain . # $ / [ ]");
        return;
      }
      const db = firebase.database();
      db.ref(`${nodeKey}/${useKey}`).set(parsed).then(() => {
        close();
        onSaved?.();
      }).catch(err => {
        console.warn("[db viewer] save failed:", err);
        dbAlertErr(`Save failed: ${err && err.message ? err.message : err}`);
      });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);
  }

  // Per-field editor — top-level fields only. Inputs are type-appropriate
  // (text / number / checkbox). Nested objects show a read-only summary
  // with a "use raw JSON" hint, since editing a tree inline is messy.
  function openDbEditFieldsPopup(opts) {
    const { nodeKey, keyName, value, onSaved } = opts;
    if (value == null || typeof value !== "object") {
      // Scalar value — fall back to JSON editor.
      openDbEditJsonPopup({ nodeKey, keyName, value, isNew: false, onSaved });
      return;
    }
    document.getElementById("dbg-edit-popup")?.remove();
    const overlay = document.createElement("div");
    overlay.id = "dbg-edit-popup";
    overlay.className = "popup-overlay";
    const fields = Object.entries(value);
    const rowsHtml = fields.map(([k, v]) => {
      const fieldId = `dbg-edit-f-${k.replace(/[^A-Za-z0-9_-]/g, "_")}`;
      if (v === null || v === undefined) {
        return `<div class="dbg-field"><label class="popup-text" for="${fieldId}">${k} <em style="opacity:.6;">(null)</em></label><input id="${fieldId}" data-field="${k}" data-type="string" class="account-bio" type="text" style="width:100%;padding:6px 10px;" value=""></div>`;
      }
      if (typeof v === "boolean") {
        return `<div class="dbg-field"><label class="popup-text" style="display:flex;align-items:center;gap:6px;"><input id="${fieldId}" data-field="${k}" data-type="boolean" type="checkbox" ${v ? "checked" : ""}> ${k}</label></div>`;
      }
      if (typeof v === "number") {
        return `<div class="dbg-field"><label class="popup-text" for="${fieldId}">${k}</label><input id="${fieldId}" data-field="${k}" data-type="number" class="account-bio" type="number" step="any" style="width:100%;padding:6px 10px;" value="${v}"></div>`;
      }
      if (typeof v === "string") {
        const safe = v.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;");
        // Known image fields (photo / banner / smallBanner) always render
        // as an image picker — preview + replace + clear when there's
        // data, or just a "Select image" button when empty. Detection is
        // by field name OR by value being a data-URL image; that way an
        // unrelated field that happens to hold a data URL also gets the
        // visual treatment.
        const isImageField = (k === "photo" || k === "banner" || k === "smallBanner")
          || v.startsWith("data:image/");
        if (isImageField) {
          if (v.startsWith("data:image/")) {
            const kb = Math.round(v.length * 0.75 / 1024);
            return `<div class="dbg-field">
              <label class="popup-text">${k} <em style="opacity:.6;">(${kb} KB)</em></label>
              <div style="display:flex;gap:8px;align-items:flex-start;">
                <img class="dbg-img-preview" data-preview-for="${k}" src="${safe}" alt="" style="max-width:140px;max-height:120px;border:1px solid #30363d;border-radius:4px;object-fit:cover;background:#0d1117;">
                <div style="flex:1;display:flex;flex-direction:column;gap:6px;min-width:0;">
                  <input type="file" accept="image/*" class="dbg-img-file" data-file-for="${k}">
                  <button type="button" class="btn btn-sm dbg-img-clear" data-clear-for="${k}">Clear</button>
                </div>
              </div>
              <input type="hidden" id="${fieldId}" data-field="${k}" data-type="string" value="${safe}">
            </div>`;
          }
          // Empty image field — just the file picker, no blank preview.
          return `<div class="dbg-field">
            <label class="popup-text">${k} <em style="opacity:.6;">(empty)</em></label>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="file" accept="image/*" class="dbg-img-file" data-file-for="${k}">
              <img class="dbg-img-preview" data-preview-for="${k}" alt="" style="display:none;max-width:140px;max-height:120px;border:1px solid #30363d;border-radius:4px;object-fit:cover;background:#0d1117;">
            </div>
            <input type="hidden" id="${fieldId}" data-field="${k}" data-type="string" value="">
          </div>`;
        }
        const isLong = v.length > 80;
        if (isLong) {
          return `<div class="dbg-field"><label class="popup-text" for="${fieldId}">${k}</label><textarea id="${fieldId}" data-field="${k}" data-type="string" class="account-bio" rows="3" style="width:100%;padding:6px 10px;resize:vertical;">${safe}</textarea></div>`;
        }
        return `<div class="dbg-field"><label class="popup-text" for="${fieldId}">${k}</label><input id="${fieldId}" data-field="${k}" data-type="string" class="account-bio" type="text" style="width:100%;padding:6px 10px;" value="${safe}"></div>`;
      }
      // Nested object / array — read-only summary.
      const cnt = Object.keys(v).length;
      return `<div class="dbg-field"><label class="popup-text">${k} <em style="opacity:.6;">(nested, ${cnt} entries — use Edit JSON to change)</em></label></div>`;
    }).join("");
    overlay.innerHTML = `
      <div class="popup-card" style="max-width:min(560px, 92vw);">
        <h2 class="popup-title">Edit fields</h2>
        <p class="popup-text">${nodeKey}/${keyName || ""}</p>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;max-height:60vh;overflow-y:auto;">
          ${rowsHtml || `<p class="popup-text" style="opacity:.7;font-style:italic;">No editable fields.</p>`}
        </div>
        <div class="popup-actions">
          <button type="button" class="btn" data-act="save">Save</button>
          <button type="button" class="btn popup-cancel" data-act="cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;

    // Image upload — read the picked file as a data URL, swap the
    // hidden input value + the preview img. GIFs go through unchanged
    // (animation preserved); other types likewise go through unmodified
    // (no canvas re-encode here — the Save user is a Developer doing
    // raw editing, and re-encoding would freeze animations / strip
    // metadata they may want). Size warnings surface if the new file
    // exceeds the Firebase .validate cap for that field type.
    const sizeCapFor = (fieldName) => {
      if (fieldName === "banner") return 1000000;
      if (fieldName === "photo" || fieldName === "smallBanner") return 500000;
      return 0; // unknown — no client-side check
    };
    overlay.querySelectorAll(".dbg-img-file").forEach(input => {
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result;
          const f = input.dataset.fileFor;
          const cap = sizeCapFor(f);
          if (cap && dataUrl.length > cap) {
            const kb = Math.round(dataUrl.length * 0.75 / 1024);
            const capKb = Math.round(cap * 0.75 / 1024);
            alert(`That ${f} is ~${kb} KB — Firebase rule cap is ~${capKb} KB for this field.`);
            input.value = "";
            return;
          }
          const hidden = overlay.querySelector(`input[type="hidden"][data-field="${f}"]`);
          const preview = overlay.querySelector(`img.dbg-img-preview[data-preview-for="${f}"]`);
          if (hidden) hidden.value = dataUrl;
          if (preview) {
            preview.src = dataUrl;
            preview.style.display = ""; // reveal if previously empty
          }
        };
        reader.onerror = () => alert("Couldn't read that file.");
        reader.readAsDataURL(file);
      });
    });
    overlay.querySelectorAll(".dbg-img-clear").forEach(btn => {
      btn.addEventListener("click", () => {
        const f = btn.dataset.clearFor;
        const hidden = overlay.querySelector(`input[type="hidden"][data-field="${f}"]`);
        const preview = overlay.querySelector(`img.dbg-img-preview[data-preview-for="${f}"]`);
        if (hidden) hidden.value = "";
        if (preview) {
          preview.removeAttribute("src");
          preview.style.display = "none";
        }
      });
    });

    overlay.querySelector('[data-act="save"]').onclick = () => {
      const patch = {};
      overlay.querySelectorAll("[data-field]").forEach(input => {
        const f = input.dataset.field;
        const t = input.dataset.type;
        let raw;
        if (t === "boolean") raw = !!input.checked;
        else if (t === "number") {
          const n = Number(input.value);
          if (!Number.isFinite(n)) { return; }
          raw = n;
        } else {
          raw = input.value;
        }
        patch[f] = raw;
      });
      const db = firebase.database();
      db.ref(`${nodeKey}/${keyName}`).update(patch).then(() => {
        close();
        onSaved?.();
      }).catch(err => {
        console.warn("[db viewer] update failed:", err);
        dbAlertErr(`Save failed: ${err && err.message ? err.message : err}`);
      });
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close(); document.removeEventListener("keydown", onKey); }
    };
    document.addEventListener("keydown", onKey);
  }

  function formatDbCell(v) {
    if (v === undefined || v === null) return "—";
    if (typeof v === "boolean") return v ? "✓" : "—";
    if (typeof v === "number") return String(v);
    if (typeof v === "string") {
      // Data URLs (photo / banner blobs) — show size, not the 200KB blob.
      if (v.startsWith("data:")) {
        const kb = Math.round(v.length * 0.75 / 1024);
        return `[${kb} KB ${v.startsWith("data:image/gif") ? "gif" : "img"}]`;
      }
      if (v.length > 80) return v.slice(0, 77) + "…";
      return v;
    }
    if (typeof v === "object") {
      // Map / list — surface entry count + first few keys for orientation.
      const keys = Object.keys(v);
      if (!keys.length) return "—";
      const head = keys.slice(0, 4).join(", ");
      return keys.length > 4
        ? `{${keys.length}} ${head}…`
        : `{${keys.length}} ${head}`;
    }
    return String(v);
  }

  window.addEventListener("userprofilechange", () => {
    paintDeveloperTab();
    paintRevoxTab();
    paintAchievementTab();
    ensureActiveTabVisible();
    applyRevoxThemeGate();
    applyMedalThemeGate();
    applyAchievementThemeGate();
    renderDeveloperPage();
  });
  window.onAuthChange(() => {
    paintDeveloperTab();
    paintRevoxTab();
    paintAchievementTab();
    ensureActiveTabVisible();
    applyAchievementThemeGate();
    renderDeveloperPage();
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      paintDeveloperTab();
      paintRevoxTab();
      paintAchievementTab();
      ensureActiveTabVisible();
      applyAchievementThemeGate();
      initDeveloperPageControls();
    });
  } else {
    paintDeveloperTab();
    paintRevoxTab();
    paintAchievementTab();
    ensureActiveTabVisible();
    applyAchievementThemeGate();
    initDeveloperPageControls();
  }
})();
