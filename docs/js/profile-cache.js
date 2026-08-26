// =============================================================================
// Shared profile-avatar cache — the read half of the RTDB quota fix.
//
// Row avatars used to pull the FULL `profiles/{key}` node for every name on
// screen. That node carries a 256px photo AND a 1024px banner, both base64 in
// the database (a banner GIF is capped at 1,000,000 chars ≈ 750 KB), so a
// 100-row ranking could cost tens of megabytes per view — and the only cache
// was a plain JS object that died on every page navigation. This site is
// multi-page, so switching tabs re-downloaded everything.
//
// This module reads the small derived fields instead — `thumb` and
// `smallBanner`, written by saveUserProfile in auth.js — and persists them in
// localStorage, so a repeat visitor re-downloads nothing until the TTL lapses.
//
// Profiles saved before those fields existed fall back to the full-size
// originals: same bytes as the old code path, no regression, and they
// self-heal the next time their owner signs in (see backfillProfileThumbs in
// auth.js). Those oversized fallbacks are deliberately NOT persisted to
// localStorage — a couple of them would blow the ~5 MB origin budget.
// =============================================================================

(function () {
  "use strict";

  var NS = "xopt:pc:v1:";              // bump the version to invalidate everything
  var TTL_MS = 12 * 60 * 60 * 1000;    // 12h — a re-saved profile also busts on its own
  // Budget in CHARACTERS, not entries — record sizes vary a lot and this is
  // the number that actually maps to the store's limit. localStorage counts
  // UTF-16, so 1.2M chars ≈ 2.4 MB against a typical ~5 MB per-origin cap,
  // leaving room for everything else the app keeps there.
  var MAX_TOTAL_CHARS = 1200000;
  var MAX_PERSIST_CHARS = 90000;       // per record; excludes legacy full-size fallbacks

  // Output dimensions for the derived images, sized off the largest slot each
  // one actually fills:
  //   - photo: .scoreboard-avatar is the biggest at 56px, so 128px covers it
  //     at 2× DPR with room to spare (list rows are 20–34px).
  //   - banner: .fr-row-banner / ranking rows paint it as a background-size:
  //     cover strip at 16% opacity, so 512 wide is ample.
  // Roughly 6 KB and 20 KB respectively, against 15–30 KB and 120–750 KB for
  // the originals.
  var THUMB_W = 128, THUMB_H = 128, THUMB_Q = 0.72;
  var SMALL_BANNER_W = 512, SMALL_BANNER_H = 171, SMALL_BANNER_Q = 0.72;

  // Pruning walks the whole store, so it can't run on every write — but it
  // also can't be time-throttled, or hydrating a long leaderboard in one tick
  // would blow straight past the budget without a single sweep. Instead,
  // count the characters written since the last sweep and prune once that
  // slack is used up. Overshoot is bounded by PRUNE_SLACK_CHARS.
  var PRUNE_SLACK_CHARS = 150000;
  var writtenSincePrune = 0;

  var mem = Object.create(null);       // key -> record | null (null = no profile)
  var inflight = Object.create(null);  // key -> Promise, so N rows share one read

  // Mirrors getFirebaseAuth in auth.js: reuse the initialised app, or bring it
  // up from window.FIREBASE_CONFIG if this page hasn't yet.
  function db() {
    if (typeof firebase === "undefined" || !firebase.database) return null;
    try {
      if (!firebase.apps.length) {
        var cfg = window.FIREBASE_CONFIG;
        if (!cfg || !cfg.apiKey) return null;
        firebase.initializeApp(cfg);
      }
      return firebase.database();
    } catch (e) { return null; }
  }

  // ---- localStorage layer -------------------------------------------------
  // Every helper swallows its own errors: Safari private mode throws on write,
  // and a disabled/full store must degrade to memory-only, never break a render.

  function lsGet(key) {
    try {
      var raw = localStorage.getItem(NS + key);
      if (!raw) return null;
      var rec = JSON.parse(raw);
      if (!rec || typeof rec !== "object") return null;
      if (!rec.t || (Date.now() - rec.t) > TTL_MS) { lsDrop(key); return null; }
      return { photo: rec.p || "", photoPos: rec.pp || "", banner: rec.b || "", bannerPos: rec.bp || "" };
    } catch (e) { return null; }
  }

  function lsDrop(key) {
    try { localStorage.removeItem(NS + key); } catch (e) {}
  }

  // Evict oldest-first until the namespace fits in `budget` characters. Also
  // the recovery path for a QuotaExceededError, where it's called with a
  // halved budget to make real headroom rather than shaving one entry.
  function lsPrune(budget) {
    try {
      var entries = [];
      var total = 0;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || k.indexOf(NS) !== 0) continue;
        var raw = localStorage.getItem(k) || "";
        var t = 0;
        try { t = (JSON.parse(raw) || {}).t || 0; } catch (e) { t = 0; }
        entries.push({ k: k, t: t, size: raw.length });
        total += raw.length;
      }
      if (total <= budget) return;
      entries.sort(function (a, b) { return a.t - b.t; });   // oldest first
      for (var j = 0; j < entries.length && total > budget; j++) {
        try { localStorage.removeItem(entries[j].k); total -= entries[j].size; } catch (err) {}
      }
    } catch (e) {}
  }

  function lsSet(key, rec) {
    // A legacy full-size fallback is far too big to persist — serve it from
    // memory for this page and let the owner's next sign-in shrink it.
    var payload = JSON.stringify({
      p: rec.photo || "", pp: rec.photoPos || "",
      b: rec.banner || "", bp: rec.bannerPos || "",
      t: Date.now()
    });
    if (payload.length > MAX_PERSIST_CHARS) return;
    try {
      localStorage.setItem(NS + key, payload);
    } catch (e) {
      // Out of room (or a hostile store): prune hard and retry exactly once.
      writtenSincePrune = 0;
      lsPrune(Math.floor(MAX_TOTAL_CHARS / 2));
      try { localStorage.setItem(NS + key, payload); } catch (err) { return; }
      return;
    }
    writtenSincePrune += payload.length;
    if (writtenSincePrune >= PRUNE_SLACK_CHARS) {
      writtenSincePrune = 0;
      lsPrune(MAX_TOTAL_CHARS);
    }
  }

  // ---- read path ----------------------------------------------------------

  function readChild(database, key, child) {
    return database.ref("profiles/" + key + "/" + child).once("value")
      .then(function (s) { return typeof s.val() === "string" ? s.val() : ""; })
      .catch(function () { return ""; });
  }

  function fetchRow(key) {
    var database = db();
    if (!database) return Promise.resolve(null);
    // Four tiny reads instead of one huge one. They're issued in parallel over
    // the single RTDB websocket, so this is one round-trip's worth of latency.
    return Promise.all([
      readChild(database, key, "thumb"),
      readChild(database, key, "smallBanner"),
      readChild(database, key, "photoPos"),
      readChild(database, key, "bannerPos")
    ]).then(function (vals) {
      var thumb = vals[0], small = vals[1], photoPos = vals[2], bannerPos = vals[3];
      if (thumb || small) {
        // At least one derived field exists. Only fall back for the half
        // that's genuinely missing.
        return Promise.all([
          thumb ? Promise.resolve(thumb) : readChild(database, key, "photo"),
          small ? Promise.resolve(small) : readChild(database, key, "banner")
        ]).then(function (full) {
          return {
            photo: full[0], banner: full[1],
            photoPos: photoPos, bannerPos: bannerPos,
            legacy: !thumb || !small
          };
        });
      }
      // Nothing derived at all — either a pre-thumbnail profile or no profile.
      return Promise.all([
        readChild(database, key, "photo"),
        readChild(database, key, "banner")
      ]).then(function (full) {
        if (!full[0] && !full[1] && !photoPos && !bannerPos) return null;
        return {
          photo: full[0], banner: full[1],
          photoPos: photoPos, bannerPos: bannerPos,
          legacy: true
        };
      });
    }).catch(function () { return null; });
  }

  // Resolve `key` to { photo, banner, photoPos, bannerPos } sized for a list
  // row, or null when there's no public profile. Memory → localStorage → RTDB.
  function row(key) {
    key = String(key || "");
    if (!key) return Promise.resolve(null);
    if (key in mem) return Promise.resolve(mem[key]);
    if (key in inflight) return inflight[key];

    var stored = lsGet(key);
    if (stored) { mem[key] = stored; return Promise.resolve(stored); }

    var p = fetchRow(key).then(function (rec) {
      mem[key] = rec;
      delete inflight[key];
      if (rec) lsSet(key, rec);
      return rec;
    }).catch(function () {
      mem[key] = null;
      delete inflight[key];
      return null;
    });
    inflight[key] = p;
    return p;
  }

  function photo(key) { return row(key).then(function (r) { return (r && r.photo) || ""; }); }
  function banner(key) { return row(key).then(function (r) { return (r && r.banner) || ""; }); }

  // ---- profile metadata (username / bio / tags) ---------------------------
  // Deliberately separate from row(): these are tiny but they change without
  // the owner re-saving (a Developer granting a tag), so they get a short
  // memory-only TTL rather than row()'s 12h localStorage entry. A hover card
  // therefore costs a few hundred bytes of fresh reads instead of the whole
  // profile node.

  var META_TTL_MS = 60000;
  var metaMem = Object.create(null);      // key -> { at, val }
  var metaInflight = Object.create(null);

  function fetchMeta(key) {
    var database = db();
    if (!database) return Promise.resolve(null);
    var base = "profiles/" + key + "/";
    var read = function (child) {
      return database.ref(base + child).once("value")
        .then(function (s) { return s.val(); })
        .catch(function () { return null; });
    };
    return Promise.all([read("username"), read("bio"), read("tags")])
      .then(function (v) {
        var username = typeof v[0] === "string" ? v[0] : "";
        var bio = typeof v[1] === "string" ? v[1] : "";
        var tags = (v[2] && typeof v[2] === "object") ? v[2] : null;
        // Nothing at all here means there's no public profile.
        if (!username && !bio && !tags) return null;
        return { username: username, bio: bio, tags: tags };
      })
      .catch(function () { return null; });
  }

  function meta(key) {
    key = String(key || "");
    if (!key) return Promise.resolve(null);
    var hit = metaMem[key];
    if (hit && (Date.now() - hit.at) < META_TTL_MS) return Promise.resolve(hit.val);
    if (key in metaInflight) return metaInflight[key];
    var p = fetchMeta(key).then(function (val) {
      metaMem[key] = { at: Date.now(), val: val };
      delete metaInflight[key];
      return val;
    }).catch(function () {
      delete metaInflight[key];
      return null;
    });
    metaInflight[key] = p;
    return p;
  }

  // Forget `key` everywhere — called when a profile is saved or renamed.
  function invalidate(key) {
    key = String(key || "");
    if (!key) return;
    delete mem[key];
    delete inflight[key];
    delete metaMem[key];
    delete metaInflight[key];
    lsDrop(key);
  }

  // Everything a hover/profile card needs, in one call: small images from the
  // persistent cache plus fresh metadata. Resolves null when the account has
  // no public profile, so callers can decline to open the card.
  function card(key) {
    key = String(key || "");
    if (!key) return Promise.resolve(null);
    return Promise.all([meta(key), row(key)]).then(function (v) {
      var m = v[0], r = v[1];
      if (!m && !r) return null;
      return {
        username: (m && m.username) || "",
        bio: (m && m.bio) || "",
        tags: (m && m.tags) || null,
        photo: (r && r.photo) || "",
        banner: (r && r.banner) || "",
        photoPos: (r && r.photoPos) || "",
        bannerPos: (r && r.bannerPos) || ""
      };
    });
  }

  // Seed the cache without a read. The signed-in user's own record is already
  // in memory in auth.js, so their rows never need a round-trip.
  function prime(key, rec) {
    key = String(key || "");
    if (!key || !rec) return;
    var clean = {
      photo: rec.photo || "", banner: rec.banner || "",
      photoPos: rec.photoPos || "", bannerPos: rec.bannerPos || ""
    };
    mem[key] = clean;
    if (!rec.legacy) lsSet(key, clean);
  }

  // ---- write-side helper --------------------------------------------------

  // Downscale a data-URL to a JPEG data-URL no wider/taller than the given
  // box, preserving aspect. Resolves "" for empty input or an unreadable
  // image so callers can treat failure as "no thumbnail" and move on.
  //
  // Note: an animated GIF flattens to its first frame here. That's intended —
  // list rows get a cheap static preview while the profile card still loads
  // the full animated original.
  function shrink(dataUrl, maxW, maxH, quality) {
    return new Promise(function (resolve) {
      if (typeof dataUrl !== "string" || !dataUrl) { resolve(""); return; }
      var img = new Image();
      img.onerror = function () { resolve(""); };
      img.onload = function () {
        var finish = function () {
          try {
            var scale = Math.min(1, maxW / img.width, maxH / img.height);
            var w = Math.max(1, Math.round(img.width * scale));
            var h = Math.max(1, Math.round(img.height * scale));
            var canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            var out = canvas.toDataURL("image/jpeg", quality);
            // A already-tiny source (or a pathological re-encode) can come out
            // bigger than it went in — keep whichever is smaller.
            resolve(out.length < dataUrl.length ? out : dataUrl);
          } catch (e) { resolve(""); }
        };
        // iOS Safari can fire `load` before the bitmap is decoded, which paints
        // a blank canvas. Same guard the settings-tab downscaler uses.
        if (img.decode) img.decode().then(finish, finish);
        else finish();
      };
      img.src = dataUrl;
    });
  }

  function makeThumb(photoDataUrl) { return shrink(photoDataUrl, THUMB_W, THUMB_H, THUMB_Q); }
  function makeSmallBanner(bannerDataUrl) { return shrink(bannerDataUrl, SMALL_BANNER_W, SMALL_BANNER_H, SMALL_BANNER_Q); }

  window.ProfileCache = {
    row: row,
    photo: photo,
    banner: banner,
    meta: meta,
    card: card,
    invalidate: invalidate,
    prime: prime,
    shrink: shrink,
    makeThumb: makeThumb,
    makeSmallBanner: makeSmallBanner
  };

  // Invalidation is driven explicitly by saveUserProfile in auth.js, which
  // invalidates the old + new keys and re-primes the new one BEFORE it fires
  // `userprofilechange`. Listening for that event here instead would race:
  // the handler would wipe the entry auth.js had just primed.
})();
