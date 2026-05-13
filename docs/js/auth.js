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
      const passwordInput = popup.querySelector("#signin-password");
      const submitBtn = popup.querySelector("#signin-submit");
      const toggleBtn = popup.querySelector("#signin-toggle");
      const cancelBtn = popup.querySelector("#signin-cancel");
      const resetBtn = popup.querySelector("#signin-reset");
      const statusEl = popup.querySelector("#signin-status");

      let mode = "signin"; // or "signup"

      const setStatus = (msg, kind) => {
        if (!statusEl) return;
        statusEl.textContent = msg || "";
        statusEl.classList.remove("is-ok", "is-err", "is-pending");
        if (kind) statusEl.classList.add(`is-${kind}`);
      };

      const renderMode = () => {
        if (mode === "signup") {
          if (titleEl) titleEl.textContent = "Create account";
          if (subtitleEl) subtitleEl.textContent = options.subtitle || "Sign up with your email to host tournaments.";
          if (submitBtn) submitBtn.textContent = "Sign up";
          if (toggleBtn) toggleBtn.textContent = "Already have an account? Sign in";
        } else {
          if (titleEl) titleEl.textContent = "Sign in";
          if (subtitleEl) subtitleEl.textContent = options.subtitle || "Sign in with your email to host tournaments.";
          if (submitBtn) submitBtn.textContent = "Sign in";
          if (toggleBtn) toggleBtn.textContent = "No account yet? Sign up";
        }
      };

      if (emailInput) emailInput.value = options.email || "";
      if (passwordInput) passwordInput.value = "";
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
        if (error) reject(error);
        else resolve(result);
      };

      const submit = async () => {
        const email = (emailInput?.value || "").trim();
        const password = passwordInput?.value || "";
        if (!email) { setStatus("Enter your email.", "err"); emailInput?.focus(); return; }
        if (!password) { setStatus("Enter your password.", "err"); passwordInput?.focus(); return; }
        try {
          setStatus(mode === "signup" ? "Creating account…" : "Signing in…", "pending");
          if (submitBtn) submitBtn.disabled = true;
          const cred = mode === "signup"
            ? await window.signUpWithEmail(email, password)
            : await window.signInWithEmail(email, password);
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
})();
