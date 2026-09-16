// docs/js/scoreboard.js - landscape-activated match scoreboard overlay
// ================= SCOREBOARD =================
let scoreboardEnabled = false;
let scoreboardSaveCallback = null;

(function () {
  let scoreA = 0;
  let scoreB = 0;
  // Round indicator. Each scoring button press counts; every 3 presses
  // (across both sides combined) advances the displayed round.
  //
  // The same counter drives the bey indicator: a round is fought with three
  // beys, so the press count within the current round IS the bey in play.
  // Press 1st Bey → 2nd → 3rd, and rolling into the next round puts the 1st
  // bey back up.
  let scorePresses = 0;
  const PRESSES_PER_ROUND = 3;
  const BEYS_PER_ROUND = PRESSES_PER_ROUND;

  // Undo history, one stack per side. Every scoring press records the points
  // it actually applied, so a swipe-down can put the score back exactly as it
  // was before that tap — undoing a Burst returns 2 points, not 1.
  let pressHistory = { a: [], b: [] };
  function clearPressHistory() {
    pressHistory = { a: [], b: [] };
  }
  // Optional callback fired on every score change (re-keyed to the original
  // A/B order), so the running score can be pushed to the room and shown live
  // on the tournament Calling Monitor.
  let scoreboardScoreChange = null;
  // Fired once when the board is closed without saving (X / Escape).
  let scoreboardCancelCallback = null;

  const overlay = document.getElementById("scoreboard-overlay");
  const scoreAEl = document.getElementById("score-a");
  const scoreBEl = document.getElementById("score-b");
  const labelA = overlay?.querySelector(".scoreboard-left .scoreboard-player-label");
  const labelB = overlay?.querySelector(".scoreboard-right .scoreboard-player-label");
  const resetBtn = document.getElementById("scoreboard-reset");
  const closeBtn = document.getElementById("scoreboard-close");
  const exitBtn = document.getElementById("scoreboard-exit");
  const leftSide = document.getElementById("scoreboard-left");
  const rightSide = document.getElementById("scoreboard-right");
  const roundEl = document.getElementById("scoreboard-round");
  const beyEl = document.getElementById("scoreboard-bey");

  if (!overlay) return;

  // Neutral silhouette shown until a real photo resolves (or kept for
  // accounts with no photo). Matches the placeholder used elsewhere.
  const SB_AVATAR_PH = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%2321262d'/%3E%3Ccircle cx='32' cy='24' r='12' fill='%23484f58'/%3E%3Cpath d='M11 57c0-12 10-20 21-20s21 8 21 20z' fill='%23484f58'/%3E%3C/svg%3E";

  // Paint a player label: avatar above the name. `name` empty / "A" / "B"
  // is the standalone (no-match) board, where the avatar is hidden. For a
  // real player the avatar starts on the placeholder, then the photo is
  // resolved via window.resolveProfilePhoto (defined in tournament.js).
  function setScoreboardLabel(labelEl, name) {
    if (!labelEl) return;
    const display = name || "A";
    const real = !!name && name !== "A" && name !== "B";
    labelEl.innerHTML = '<img class="scoreboard-avatar" alt="">'
      + '<span class="scoreboard-player-name"></span>';
    const img = labelEl.querySelector(".scoreboard-avatar");
    const nameSpan = labelEl.querySelector(".scoreboard-player-name");
    if (nameSpan) nameSpan.textContent = display;
    if (!img) return;
    if (!real) { img.classList.add("hidden"); return; }
    img.src = SB_AVATAR_PH;
    if (typeof window.resolveProfilePhoto === "function") {
      window.resolveProfilePhoto(name).then(photo => {
        if (photo) img.src = photo;
      }).catch(() => {});
    }
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function currentRound() {
    return Math.floor(scorePresses / PRESSES_PER_ROUND) + 1;
  }

  // Which bey is up: 1–3, restarting at 1 on every new round.
  function currentBey() {
    return (scorePresses % BEYS_PER_ROUND) + 1;
  }

  // Revert the most recent scoring press on `side`, restoring the score to
  // what it was before that tap. The shared press counter steps back too, so
  // the bey chip and the round counter rewind with it — undoing the 1st bey of
  // a new round drops back to the 3rd bey of the round before. Does nothing
  // when that side has nothing left to undo, so the score can't fall below
  // whatever it was loaded with.
  function undoLastPress(side) {
    const stack = pressHistory[side];
    if (!stack || !stack.length) return;
    const delta = stack.pop();
    if (side === "a") scoreA = Math.max(0, scoreA - delta);
    else scoreB = Math.max(0, scoreB - delta);
    scorePresses = Math.max(0, scorePresses - 1);
    updateDisplay();
  }

  function updateDisplay() {
    scoreAEl.textContent = scoreA;
    scoreBEl.textContent = scoreB;
    if (roundEl) roundEl.textContent = `${ordinal(currentRound())} Round`;
    if (beyEl) beyEl.textContent = `${ordinal(currentBey())} Bey`;
    if (typeof scoreboardScoreChange === "function") {
      // `swapped` (declared below) flips the visible sides — re-key so the
      // callback always receives scores in the original m.a / m.b order.
      const out = swapped ? { scoreA: scoreB, scoreB: scoreA } : { scoreA, scoreB };
      try { scoreboardScoreChange(out); } catch (e) { /* non-fatal */ }
    }
  }

  // iPadOS 13+ Safari/Chrome report the UA as desktop "Macintosh" (no "iPad"),
  // so detect an iPad by its multi-touch MacIntel platform — a real Mac reports
  // 0 touch points, so this stays false on desktop.
  const isIPadOS = navigator.maxTouchPoints > 1 &&
    (navigator.platform === "MacIntel" || /Macintosh/.test(navigator.userAgent));
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || isIPadOS;

  if (isMobile) {
    const addSwipe = (el, onChange) => {
      let startY = 0;
      let swiping = false;
      el.addEventListener("touchstart", e => { startY = e.touches[0].clientY; swiping = true; }, { passive: true });
      el.addEventListener("touchend", e => {
        if (!swiping) return;
        swiping = false;
        const dy = startY - e.changedTouches[0].clientY;
        if (Math.abs(dy) < 30) return;
        onChange(dy > 0 ? 1 : -1);
      });
    };
    // Swipe down on a side = undo that side's last scoring tap. It used to be a
    // flat -1, which couldn't take back a Burst or an Extreme and left the bey
    // and round counters where they were.
    addSwipe(leftSide, d => { if (d < 0) undoLastPress("a"); });
    addSwipe(rightSide, d => { if (d < 0) undoLastPress("b"); });
    // The gate sits over the board after every score, so the same gesture has
    // to work on its panels — otherwise undo is unreachable for the whole of
    // the match except the opening bey.
    const gateA = overlay.querySelector(".sb-ready-a");
    const gateB = overlay.querySelector(".sb-ready-b");
    if (gateA) addSwipe(gateA, d => { if (d < 0) undoLastPress("a"); });
    if (gateB) addSwipe(gateB, d => { if (d < 0) undoLastPress("b"); });
  }

  const finishSounds = {
    Spin: new Audio("assets/voices/spinFinish.wav"),
    Over: new Audio("assets/voices/overFinish.wav"),
    Burst: new Audio("assets/voices/burstFinish.wav"),
    Extreme: new Audio("assets/voices/extremeFinish.wav")
  };

  const countdownClips = [
    new Audio("assets/voices/3.wav"),
    new Audio("assets/voices/2.wav"),
    new Audio("assets/voices/1.wav"),
    new Audio("assets/voices/goShoot.wav")
  ];

  // Boost the countdown clips above their source volume. HTMLAudio.volume
  // caps at 1.0, so we route them through a Web Audio GainNode set >1 to
  // amplify. Initialised lazily on the first play tap (user gesture, so
  // iOS/Safari will let AudioContext start).
  const COUNTDOWN_GAIN = 2.0;
  let audioCtx = null;
  function ensureCountdownAmplifier() {
    if (audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return; // unsupported — clips just play at native volume
    try {
      audioCtx = new Ctx();
      const gain = audioCtx.createGain();
      gain.gain.value = COUNTDOWN_GAIN;
      gain.connect(audioCtx.destination);
      countdownClips.forEach(clip => {
        try {
          const src = audioCtx.createMediaElementSource(clip);
          src.connect(gain);
        } catch (e) { /* already wired or CORS — skip */ }
      });
    } catch (e) { audioCtx = null; }
  }

  // Time between the START of consecutive countdown clips. Tight enough to
  // feel like the real "Three! Two! One! Let it Rip!" cadence even when the
  // wav files have trailing silence.
  //
  // There used to be a ▶ button in the divider that replayed this on demand.
  // The pre-start gate now runs the countdown itself, before the board is even
  // on screen, so the button had nothing left to do.
  const COUNTDOWN_STEP_MS = 850;

  // ===== Pre-start gate =====
  // The board doesn't go straight to 0-0. Both sides tap Ready, then a
  // 3 - 2 - 1 - Go - Shoot countdown plays, then the board fades in. The gate
  // is a layer INSIDE the overlay rather than a separate screen, so every
  // existing reveal path (tilt, desktop modal, "Show anyway") is untouched:
  // whatever reveals the overlay now reveals the gate, and the board waits
  // underneath it.
  const prestartEl = document.getElementById("sb-prestart");
  const countEl = document.getElementById("sb-count");
  const readyNameA = document.getElementById("sb-ready-name-a");
  const readyNameB = document.getElementById("sb-ready-name-b");

  // Each step's `ms` is how long until the NEXT one. 3 / 2 / 1 sit on the clip
  // cadence; "Go" and "Shoot" are the two halves of the single goShoot clip,
  // so they run tighter and only the first of them plays audio.
  const PRESTART_STEPS = [
    { text: "3",     ms: COUNTDOWN_STEP_MS, clip: 0 },
    { text: "2",     ms: COUNTDOWN_STEP_MS, clip: 1 },
    { text: "1",     ms: COUNTDOWN_STEP_MS, clip: 2 },
    { text: "Go",    ms: 430,               clip: 3 },
    { text: "Shoot", ms: 620,               clip: null }
  ];

  let readySides = { a: false, b: false };
  let prestartTimers = [];
  function clearPrestartTimers() {
    prestartTimers.forEach(t => clearTimeout(t));
    prestartTimers = [];
  }

  // Put the gate back up: both sides un-ready, no countdown, board hidden.
  // Called whenever a board is loaded or reset, so every match starts here.
  function armPrestart() {
    clearPrestartTimers();
    countdownRunning = false;
    readySides = { a: false, b: false };
    overlay.classList.add("sb-prestarting");
    prestartEl?.classList.remove("sb-counting");
    if (countEl) { countEl.textContent = ""; countEl.classList.remove("is-pop"); }
    paintReadyButtons();
    syncPrestartNames();
    // Restart the entrance animation. The element is never recreated, so the
    // class has to be dropped and re-added around a forced reflow or the
    // browser coalesces the two and nothing replays.
    if (prestartEl) {
      prestartEl.classList.remove("sb-gate-in");
      void prestartEl.offsetWidth;
      prestartEl.classList.add("sb-gate-in");
    }
  }

  // Render both Ready buttons from `readySides`. Driven off state rather than
  // toggled in place, so a side swap can just move the flags and repaint.
  function paintReadyButtons() {
    overlay.querySelectorAll(".sb-ready-btn").forEach(btn => {
      const side = btn.dataset.readySide === "a" ? "a" : "b";
      const on = !!readySides[side];
      btn.classList.toggle("is-ready", on);
      btn.disabled = on;
      btn.textContent = on ? "Ready ✓" : "Ready";
      btn.closest(".sb-ready")?.classList.toggle("is-ready", on);
    });
  }

  // Mirror the board's player names onto the gate, so each Ready button says
  // who it belongs to. Reads the rendered labels rather than taking the names
  // again, which keeps it correct after a side swap.
  function syncPrestartNames() {
    // The page SHIPS the label as bare text — <div class="...-label">A</div>.
    // The inner .scoreboard-player-name span only exists once
    // setScoreboardLabel has run, which happens when a match is loaded. On the
    // standalone board that never happens, so reading only the span found
    // nothing, fell back to the hard-coded "A" / "B", and a swap looked like
    // it did nothing even though the labels underneath had swapped.
    const nameOf = (labelEl) => {
      if (!labelEl) return "";
      const span = labelEl.querySelector(".scoreboard-player-name");
      return ((span ? span.textContent : labelEl.textContent) || "").trim();
    };
    if (readyNameA) readyNameA.textContent = nameOf(labelA) || "A";
    if (readyNameB) readyNameB.textContent = nameOf(labelB) || "B";
  }

  // Show one countdown word, restarting the pop animation each time. Removing
  // the class and forcing a reflow is what makes it replay — without the
  // reflow the browser coalesces the remove/add and nothing animates.
  function showCountWord(text) {
    if (!countEl) return;
    countEl.classList.remove("is-pop");
    void countEl.offsetWidth;
    countEl.textContent = text;
    countEl.classList.add("is-pop");
  }

  // Run 3 - 2 - 1 - Go - Shoot, then call `onDone`. Shared by the pre-start
  // gate (where it ends by revealing the board) and the divider's Countdown
  // button (where it just plays over the live board). The word element lives
  // OUTSIDE the gate layer, so it paints over either one.
  //
  // True while a sequence is in flight, so a second trigger can't interleave
  // two sets of words.
  let countdownRunning = false;
  function playCountdownWords(onDone) {
    clearPrestartTimers();
    countdownRunning = true;
    // The tap that got us here is the user gesture, so this is the moment
    // iOS / Safari will let the audio context start.
    ensureCountdownAmplifier();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});

    let at = 0;
    PRESTART_STEPS.forEach(step => {
      const fire = () => {
        showCountWord(step.text);
        const clip = step.clip == null ? null : countdownClips[step.clip];
        if (clip) { clip.currentTime = 0; clip.play().catch(() => {}); }
      };
      // The first word runs synchronously off the tap. Through a 0ms timer it
      // would land a frame late, so the panels would fade out to a blank
      // screen before the "3" arrived.
      if (at === 0) fire();
      else prestartTimers.push(setTimeout(fire, at));
      at += step.ms;
    });
    // `at` is now the end of the last word.
    prestartTimers.push(setTimeout(() => {
      countdownRunning = false;
      if (countEl) { countEl.textContent = ""; countEl.classList.remove("is-pop"); }
      if (onDone) onDone();
    }, at));
  }

  function runPrestartCountdown() {
    prestartEl?.classList.add("sb-counting");
    playCountdownWords(revealBoard);
  }

  function revealBoard() {
    clearPrestartTimers();
    countdownRunning = false;
    overlay.classList.remove("sb-prestarting");
    prestartEl?.classList.remove("sb-counting");
    if (countEl) { countEl.textContent = ""; countEl.classList.remove("is-pop"); }
  }

  // Arm once at load, not only when a match is loaded. The STANDALONE board
  // (no match, sides still "A" / "B") is revealed straight from the
  // orientation handler whenever scoreboardEnabled is true — app.js sets that
  // on every page — so it never passes through setupScoreboard. Without this
  // the gate simply never appeared for anyone who just tilted their phone.
  armPrestart();

  // Sides can be put right before the match starts. Ignored once the
  // countdown is running — at that point the match is already under way.
  document.getElementById("sb-swap")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (prestartEl?.classList.contains("sb-counting")) return;
    swapSides();
  });

  overlay.querySelectorAll(".sb-ready-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = btn.dataset.readySide === "a" ? "a" : "b";
      if (readySides[side]) return;      // already in, no un-readying mid-gate
      readySides[side] = true;
      paintReadyButtons();
      if (readySides.a && readySides.b) runPrestartCountdown();
    });
  });

  overlay.querySelectorAll(".sb-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = btn.dataset.side === "a" ? "a" : "b";
      const delta = parseInt(btn.dataset.delta, 10);
      // Record what the press actually changed (not the nominal delta), so an
      // undo is exact even if the score was clamped at 0.
      const before = side === "a" ? scoreA : scoreB;
      const after = Math.max(0, before + delta);
      if (side === "a") scoreA = after; else scoreB = after;
      pressHistory[side].push(after - before);
      scorePresses += 1;
      updateDisplay();
      const sound = finishSounds[btn.textContent.trim()];
      if (sound) {
        sound.currentTime = 0;
        sound.play().catch(() => {});
      }
      // A finish ends that bey, so hand straight back to the Ready gate for
      // the next one: both sides confirm, the countdown runs, the board comes
      // back. The SCORE is kept — only the launch repeats.
      armPrestart();
    });
  });

  // Back to 0-0, 1st Round, 1st Bey, with nothing left to undo. Shared by the
  // Reset button and the untilt restart so the two can't drift apart.
  //
  // `swapped` is deliberately left alone: it records that the visible sides
  // are flipped from the original m.a / m.b order, and the save callback is
  // re-keyed through it. Clearing it without also swapping the labels back
  // would hand the match's scores to the wrong players.
  function clearScores() {
    scoreA = 0;
    scoreB = 0;
    scorePresses = 0;
    clearPressHistory();
    updateDisplay();
  }

  resetBtn.addEventListener("click", clearScores);

  // True when the visible left/right have been swapped from the original
  // m.a/m.b. We re-swap on save so the callback receives scores keyed to the
  // ORIGINAL player order (avoids mis-attributing scores after a visual flip).
  let swapped = false;
  const swapBtn = document.getElementById("scoreboard-swap");
  // Shared by the divider's swap button and the one on the pre-start gate, so
  // sides can be put right BEFORE the match starts as well as during it.
  function swapSides() {
    const tmpScore = scoreA;
    scoreA = scoreB;
    scoreB = tmpScore;
    // The undo stacks follow their scores across, or a swipe-down would take
    // points off the player who didn't earn them.
    const tmpHist = pressHistory.a;
    pressHistory.a = pressHistory.b;
    pressHistory.b = tmpHist;
    // Ready state belongs to the PLAYER, not the side, so it travels with
    // them — swapping must not make someone who already tapped Ready tap
    // again, nor mark the other player ready on their behalf.
    const tmpReady = readySides.a;
    readySides.a = readySides.b;
    readySides.b = tmpReady;
    if (labelA && labelB) {
      // Swap the FULL label (avatar + name), not just text — `.textContent`
      // dropped the avatar <img>, so the profile pic vanished on swap.
      // Swapping innerHTML moves the already-resolved photo across, no reload.
      const tmpLabel = labelA.innerHTML;
      labelA.innerHTML = labelB.innerHTML;
      labelB.innerHTML = tmpLabel;
    }
    swapped = !swapped;
    syncPrestartNames();
    paintReadyButtons();
    updateDisplay();
  }

  swapBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    swapSides();
  });

  // Set when the user taps check to save — the scoreboard keeps the just-
  // scored names/scores on screen, and only resets to the default board once
  // the user tilts back to portrait (see handleOrientation below).
  let pendingResetOnPortrait = false;

  closeBtn?.addEventListener("click", () => {
    const cb = scoreboardSaveCallback;
    scoreboardSaveCallback = null;
    scoreboardCancelCallback = null; // saved, so the dismiss hook must not fire
    closeBtn.classList.add("hidden");
    scoreboardScoreChange = null; // stop pushing live score once the match is saved
    if (cb) {
      // Re-key to original m.a/m.b order if the user swapped sides.
      const out = swapped
        ? { scoreA: scoreB, scoreB: scoreA }
        : { scoreA, scoreB };
      cb(out);
    }
    pendingResetOnPortrait = true;
    // Desktop: no portrait tilt will follow, so hide + reset the modal now.
    if (!isMobile && desktopModalOpen) closeScoreboardDesktopModal();
    // Mobile: if we're the ones holding the screen in landscape, let go — the
    // reset above is driven by a tilt back to portrait, which a locked screen
    // would never deliver.
    if (isMobile && orientationLocked) releaseLandscape();
  });

  const isLandscape = () => screen.orientation ? screen.orientation.type.startsWith("landscape") : window.innerWidth > window.innerHeight;
  // Both guard on the call RETURNING a promise, not just on the method
  // existing. The old `(... || (() => {})).call(el).catch(...)` threw outright
  // on any browser without the Fullscreen API, because the no-op fallback
  // returns undefined and undefined has no .catch — taking the whole tilt
  // flow down with it. Older implementations return undefined too.
  const enterFullscreen = () => {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try { const p = req.call(el); if (p && p.catch) p.catch(() => {}); } catch (e) { /* refused */ }
  };
  const exitFullscreen = () => {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (!fn || !(document.fullscreenElement || document.webkitFullscreenElement)) return;
    try { const p = fn.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* refused */ }
  };

  // Release a landscape lock so the phone follows its physical position again.
  // Safe to call when nothing is locked.
  const unlockOrientation = () => {
    try { screen.orientation?.unlock?.(); } catch (e) { /* unsupported */ }
  };

  // True while we're holding the screen in landscape ourselves.
  let orientationLocked = false;

  // Set when the user chooses "Show anyway" from the rotate prompt: the board
  // is shown in portrait for this match instead of waiting on a tilt.
  let portraitOverride = false;

  // True only between "the user tapped Scoreboard / Score Match while in
  // portrait" and the board actually opening (or being dismissed). The prompt
  // is gated on THIS, not on the board being armed: app.js sets
  // scoreboardEnabled = true on every page load, so "armed" is always true and
  // gating on it popped the prompt on every tilt back to portrait — including
  // straight after tapping ✕, which releases the landscape lock and lets the
  // phone rotate back.
  let awaitingRotate = false;

  // ===== Rotate prompt (mobile, portrait) =====
  // On Android we rotate the phone ourselves. iOS Safari has no
  // screen.orientation.lock, so the board can only appear when the user tilts —
  // and if they have iOS Portrait Orientation Lock switched on, tilting rotates
  // nothing, fires no orientation event, and the board never appears. Before
  // this prompt existed, tapping Score Match on such a phone looked like it did
  // nothing at all, with no way through and nothing on screen to explain it.
  //
  // Injected rather than added to all 16 page templates: one copy to maintain.
  let rotateHint = null;
  function ensureRotateHint() {
    if (rotateHint) return rotateHint;
    rotateHint = document.createElement("div");
    rotateHint.id = "scoreboard-rotate-hint";
    rotateHint.className = "scoreboard-rotate-hint hidden";
    rotateHint.innerHTML =
      '<div class="scoreboard-rotate-card">' +
        '<div class="scoreboard-rotate-icon" aria-hidden="true">&#x21BB;</div>' +
        '<p class="scoreboard-rotate-title">Turn your phone sideways</p>' +
        '<p class="scoreboard-rotate-sub">Nothing happening? Your phone’s rotation lock is on — ' +
          'swipe into Control Centre and switch it off, or show the board as it is.</p>' +
        '<button type="button" class="btn" id="scoreboard-rotate-anyway">Show anyway</button>' +
      '</div>';
    document.body.appendChild(rotateHint);
    rotateHint.querySelector("#scoreboard-rotate-anyway").addEventListener("click", () => {
      portraitOverride = true;
      awaitingRotate = false;
      hideRotateHint();
      overlay.classList.remove("hidden");
      overlay.classList.add("scoreboard-portrait");
      // No tilt back to portrait to dismiss with, so offer the exit button.
      exitBtn?.classList.remove("hidden");
    });
    return rotateHint;
  }
  function showRotateHint() {
    ensureRotateHint().classList.remove("hidden");
  }
  function hideRotateHint() {
    if (rotateHint) rotateHint.classList.add("hidden");
  }

  // Rotate the phone to landscape on tap instead of making the judge tilt it.
  // The Screen Orientation API only allows a lock while fullscreen, so the two
  // are chained — and both need the user gesture that got us here, which is why
  // this runs straight off the button click with no await in front of it.
  //
  // Android Chromium supports this. iOS Safari has no screen.orientation.lock
  // at all, so the promise chain no-ops and the existing tilt-to-reveal flow is
  // still what shows the board there.
  const tryLockLandscape = () => {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const lock = screen.orientation && screen.orientation.lock;
    // Both are checked up front: optional-calling a missing lock() resolves
    // instead of throwing, which would leave us claiming a lock we never got —
    // and entering fullscreen for a rotation that can't happen would strand the
    // page fullscreen in portrait with the board still hidden.
    if (!req || !lock) return;
    Promise.resolve()
      .then(() => req.call(el))
      .then(() => lock.call(screen.orientation, "landscape"))
      .then(() => {
        // Locked: tilting back to portrait no longer works as the way out, so
        // surface the exit button on mobile as well.
        orientationLocked = true;
        exitBtn?.classList.remove("hidden");
      })
      .catch(() => exitFullscreen()); // refused — undo the fullscreen, tilt still works
  };

  // Hand orientation control back to the phone and drop out of fullscreen.
  const releaseLandscape = () => {
    orientationLocked = false;
    exitBtn?.classList.add("hidden");
    unlockOrientation();
    exitFullscreen();
  };

  // Clear any match-linked state so the scoreboard behaves as the default
  // standalone board again (empty names, 0-0, no save target). Called when
  // the user leaves / resets a live room so they don't end up with stale
  // match context stuck on the overlay.
  window.resetScoreboardToDefault = function () {
    scoreboardSaveCallback = null;
    setScoreboardLabel(labelA, "A");
    setScoreboardLabel(labelB, "B");
    scoreA = 0;
    scoreB = 0;
    scorePresses = 0;
    clearPressHistory();
    swapped = false;
    scoreboardScoreChange = null;
    scoreboardCancelCallback = null;
    updateDisplay();
    closeBtn?.classList.add("hidden");
    armPrestart();
    // The match is over, so neither the rotate prompt, the outstanding open
    // request, nor the portrait fallback should outlive it.
    portraitOverride = false;
    awaitingRotate = false;
    overlay?.classList.remove("scoreboard-portrait");
    hideRotateHint();
  };

  // Load names/scores + save callback onto the board, revealing it if already
  // in landscape (otherwise the orientation handler shows it on tilt).
  function setupScoreboard(nameA, nameB, onSave, initialA, initialB, onScoreChange, onCancel) {
    // Safety net: if called for a view-only participant, drop the match
    // context and fall back to the default standalone scoreboard (no save
    // callback, no pre-filled names/scores).
    if (swissEditCode && !swissCanEdit) {
      nameA = ""; nameB = ""; onSave = null; initialA = 0; initialB = 0; onScoreChange = null; onCancel = null;
    }
    // Fired when the board is dismissed without saving, so the caller can undo
    // whatever opening it set up (the tournament takes the match off LIVE).
    scoreboardCancelCallback = typeof onCancel === "function" ? onCancel : null;
    setScoreboardLabel(labelA, nameA || "A");
    setScoreboardLabel(labelB, nameB || "B");
    scoreA = typeof initialA === "number" ? initialA : 0;
    scoreB = typeof initialB === "number" ? initialB : 0;
    scorePresses = 0;
    // A freshly loaded match has no taps to take back — an undo must never
    // eat into the score it was opened with.
    clearPressHistory();
    swapped = false;
    // Set the live-score hook BEFORE the first updateDisplay so the opening
    // 0–0 is pushed immediately (the monitor shows the score the moment the
    // match goes live).
    scoreboardScoreChange = typeof onScoreChange === "function" ? onScoreChange : null;
    updateDisplay();
    scoreboardSaveCallback = typeof onSave === "function" ? onSave : null;
    closeBtn?.classList.toggle("hidden", !scoreboardSaveCallback);
    // Every match opens on the Ready gate, whichever surface reveals it.
    armPrestart();
    // Mobile is tilt-driven: reveal now only if already landscape, otherwise
    // the orientation handler shows it on the next tilt. Desktop has no tilt —
    // openScoreboard reveals the board as a modal popup itself (below).
    if (isMobile) {
      if (isLandscape()) {
        overlay.classList.remove("hidden");
        overlay.classList.remove("scoreboard-portrait");
        hideRotateHint();
        enterFullscreen();
      } else {
        // Portrait: stay hidden and wait for the tilt. The rotate prompt is
        // raised by openScoreboard instead — setupScoreboard also runs for
        // armScoreboard (Battle Royale arms the board silently the moment a
        // battle is accepted), and that must not throw a prompt at anyone.
        overlay.classList.add("hidden");
        overlay.classList.remove("scoreboard-portrait");
        portraitOverride = false;
      }
    }
  }

  // On desktop there's no tilt to reveal/hide the board, so we show it as a
  // modal popup (the overlay is position:fixed inset:0, so removing `hidden`
  // presents the same board a tilted phone shows) and hide it again on save /
  // Escape. Tracked so the close + Escape handlers know a desktop modal is up.
  let desktopModalOpen = false;
  function openScoreboardDesktopModal() {
    overlay.classList.remove("hidden");
    desktopModalOpen = true;
    // Desktop-only: mobile dismisses by tilting back to portrait, so the exit
    // button stays hidden there.
    exitBtn?.classList.remove("hidden");
  }
  function closeScoreboardDesktopModal() {
    overlay.classList.add("hidden");
    desktopModalOpen = false;
    exitBtn?.classList.add("hidden");
    pendingResetOnPortrait = false;
    if (typeof window.resetScoreboardToDefault === "function") {
      window.resetScoreboardToDefault();
    }
  }

  // Scores are entered only via the scoreboard overlay. On mobile it's revealed
  // by tilting to landscape; on desktop openScoreboard shows it as a modal
  // popup directly (no tilt / fullscreen needed).
  window.openScoreboard = function (nameA, nameB, onSave, initialA, initialB, onScoreChange, onCancel) {
    setupScoreboard(nameA, nameB, onSave, initialA, initialB, onScoreChange, onCancel);
    if (isMobile) {
      // Already landscape? setupScoreboard has revealed it. Otherwise rotate
      // for them rather than waiting on a tilt.
      if (!isLandscape()) {
        tryLockLandscape();
        // Android's lock resolves a moment later and the board opens on its
        // own; the prompt is cleared by the landscape branch of the orientation
        // handler when that happens. On iOS the lock isn't available at all, so
        // this prompt is the only thing the judge has to go on.
        awaitingRotate = true;
        showRotateHint();
      }
    } else {
      openScoreboardDesktopModal();
    }
  };

  // Desktop dismiss without saving. Mobile leaves the board by tilting back to
  // portrait, so this is desktop-only — there the modal would otherwise be
  // escapable only by a keypress with nothing on screen to say so.
  function dismissScoreboardDesktopModal() {
    if (!desktopModalOpen) return;
    // Only worth a confirm when there's something to lose: a score was entered
    // on a match that's waiting to be saved.
    if (scoreboardSaveCallback && (scoreA > 0 || scoreB > 0)
        && !confirm("Exit without saving? The score on screen won't be recorded.")) {
      return;
    }
    scoreboardSaveCallback = null;
    scoreboardScoreChange = null; // stop pushing a live score for an abandoned board
    clearPrestartTimers();
    fireScoreboardCancel();
    closeScoreboardDesktopModal();
  }

  // Run the dismiss hook exactly once — the caller uses it to undo what opening
  // the board set up, so a second call would act on an already-cleared match.
  function fireScoreboardCancel() {
    const cb = scoreboardCancelCallback;
    scoreboardCancelCallback = null;
    if (cb) cb();
  }

  // Same button on mobile, but there it undoes the landscape lock instead of
  // closing a modal — without it a locked screen has no in-page way out.
  function dismissScoreboardMobile() {
    if (scoreboardSaveCallback && (scoreA > 0 || scoreB > 0)
        && !confirm("Exit without saving? The score on screen won't be recorded.")) {
      return;
    }
    scoreboardSaveCallback = null;
    scoreboardScoreChange = null;
    clearPrestartTimers();
    fireScoreboardCancel();
    releaseLandscape();
    overlay.classList.add("hidden");
    pendingResetOnPortrait = false;
    if (typeof window.resetScoreboardToDefault === "function") {
      window.resetScoreboardToDefault();
    }
  }

  exitBtn?.addEventListener("click", () => {
    if (isMobile) dismissScoreboardMobile();
    else dismissScoreboardDesktopModal();
  });

  // Escape is the keyboard equivalent of the same button. No-op on mobile /
  // when no modal is open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !desktopModalOpen) return;
    dismissScoreboardDesktopModal();
  });

  // armScoreboard is the silent (auto) entry — used by Battle Royale to arm the
  // board the moment a battle is accepted, so the Judge just tilts to score.
  // No desktop alert (nothing to do on a device that can't tilt).
  window.armScoreboard = function (nameA, nameB, onSave, initialA, initialB, onScoreChange) {
    if (!isMobile) return;
    setupScoreboard(nameA, nameB, onSave, initialA, initialB, onScoreChange);
  };

  if (isMobile) {
    const handleOrientation = () => {
      const armed = scoreboardEnabled || !!scoreboardSaveCallback;
      if (!armed) {
        overlay.classList.add("hidden");
        overlay.classList.remove("scoreboard-portrait");
        portraitOverride = false;
        awaitingRotate = false;
        hideRotateHint();
        exitFullscreen();
        return;
      }
      if (isLandscape()) {
        // Rotating is what the prompt asked for, so it's done — and the real
        // landscape board replaces the portrait layout.
        awaitingRotate = false;
        hideRotateHint();
        portraitOverride = false;
        overlay.classList.remove("scoreboard-portrait");
        overlay.classList.remove("hidden");
        enterFullscreen();
      } else if (portraitOverride) {
        // They chose to score in portrait — leave the board up on a tilt back.
        hideRotateHint();
      } else {
        overlay.classList.add("hidden");
        // Only while an open request is outstanding. Tilting back to portrait
        // after finishing or exiting a match must not re-raise it.
        if (awaitingRotate) showRotateHint(); else hideRotateHint();
        releaseLandscape();
        // Tilting away ends the match. The gate goes back up so the next tilt
        // starts at Ready with a fresh countdown rather than dropping onto a
        // live board — and a countdown that was running when the phone turned
        // can't fire against a hidden board.
        //
        // The score goes back to 0-0 with it: turning away is treated as
        // abandoning the attempt, not pausing it, so the board that comes
        // back is a clean one. The match context (names, save target) is
        // kept — it's the same fixture, started again.
        armPrestart();
        clearScores();
        // Now-in-portrait: if the user just saved a match, clear the match
        // context so the next tilt shows the default board.
        if (pendingResetOnPortrait) {
          pendingResetOnPortrait = false;
          if (typeof window.resetScoreboardToDefault === "function") {
            window.resetScoreboardToDefault();
          }
        }
      }
    };
    overlay.addEventListener("touchstart", () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) enterFullscreen();
    }, { once: false, passive: true });
    if (screen.orientation) screen.orientation.addEventListener("change", handleOrientation);
    else window.addEventListener("orientationchange", handleOrientation);
  }
})();
