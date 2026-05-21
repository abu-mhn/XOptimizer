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
        return currentProfile;
      })
      .catch(() => null);
  };

  // Persist the signed-in user's profile. `username` is trimmed/capped and
  // must be unique across accounts; `photo` is a (downscaled) data-URL or "".
  // Rejects if the username is already taken by someone else.
  window.saveUserProfile = function saveUserProfile(profile) {
    const u = window.getCurrentUser();
    if (!u) return Promise.reject(new Error("Not signed in."));
    const ref = profileDbRef(u.uid);
    if (!ref) return Promise.reject(new Error("Live sync isn't configured on this build."));
    // A caller that omits photo/banner keeps the existing one (avoids wiping
    // a field when only the username is being changed).
    const clean = {
      username: String((profile && profile.username) || "").trim().slice(0, 30),
      photo: (profile && typeof profile.photo === "string")
        ? profile.photo : ((currentProfile && currentProfile.photo) || ""),
      banner: (profile && typeof profile.banner === "string")
        ? profile.banner : ((currentProfile && currentProfile.banner) || ""),
      bio: (profile && typeof profile.bio === "string")
        ? profile.bio.slice(0, 300) : ((currentProfile && currentProfile.bio) || "")
    };
    const prevUsername = (currentProfile && currentProfile.username) || "";
    return window.isUsernameAvailable(clean.username, u.uid).then(ok => {
      if (!ok) throw new Error("That username is already taken — pick another.");
      // .update (not .set) so admin-set fields like `tag` aren't wiped.
      return ref.update(clean);
    }).then(() => {
      return claimUsername(u.uid, u.email || "", clean.username, prevUsername);
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

  // The Revox theme is for Revox club accounts — "Revox Admin" and "Revox
  // Member" both get it applied automatically while signed in. For everyone
  // else the "Revox" entry in the Settings theme menu is hidden and any
  // lingering "revox" selection falls back to Dark.
  function applyRevoxThemeGate() {
    const isRevoxUser = hasTag("Revox Admin") || hasTag("Revox Member");

    // Show / hide the Revox entry in the theme menu on every page.
    document.querySelectorAll(
      '#setting-theme .setting-dropdown-option[data-value="revox"]'
    ).forEach(opt => opt.classList.toggle("hidden", !isRevoxUser));

    const theme = window.themeSetting;
    let stored = null;
    try { stored = localStorage.getItem("theme"); } catch (e) {}

    if (isRevoxUser) {
      // A signed-in Revox account always gets the Revox theme.
      if (stored !== "revox" && theme && theme.set) theme.set("revox");
    } else if (stored === "revox") {
      // Not a Revox account (any more) — drop the restricted theme.
      if (theme && theme.set) theme.set("dark");
      else {
        document.body.classList.remove("revox-mode");
        try { localStorage.setItem("theme", "dark"); } catch (e) {}
      }
    }
  }

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
      // Pull each user's tag map (the Developer read rule covers users/*).
      return Promise.all(developerUsers.map(u =>
        db.ref("users/" + u.uid + "/tags").once("value")
          .then(s => s.val() || {})
          .catch(() => ({}))
      ));
    }).then(tagMaps => {
      (developerUsers || []).forEach((u, i) => {
        const m = (tagMaps && tagMaps[i]) || {};
        u.tags = Object.keys(m).filter(t => m[t]);
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
    renderDeveloperPage();
  }

  window.addEventListener("userprofilechange", () => {
    paintDeveloperTab();
    paintRevoxTab();
    ensureActiveTabVisible();
    applyRevoxThemeGate();
    renderDeveloperPage();
  });
  window.onAuthChange(() => {
    paintDeveloperTab();
    paintRevoxTab();
    ensureActiveTabVisible();
    renderDeveloperPage();
  });
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      paintDeveloperTab();
      paintRevoxTab();
      ensureActiveTabVisible();
      initDeveloperPageControls();
    });
  } else {
    paintDeveloperTab();
    paintRevoxTab();
    ensureActiveTabVisible();
    initDeveloperPageControls();
  }
})();
