// docs/js/scoreboard.js - landscape-activated match scoreboard overlay
// ================= SCOREBOARD =================
let scoreboardEnabled = false;
let scoreboardSaveCallback = null;

(function () {
  let scoreA = 0;
  let scoreB = 0;
  // Round indicator. Each scoring button press counts; every 3 presses
  // (across both sides combined) advances the displayed round.
  let scorePresses = 0;
  const PRESSES_PER_ROUND = 3;
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

  function updateDisplay() {
    scoreAEl.textContent = scoreA;
    scoreBEl.textContent = scoreB;
    if (roundEl) roundEl.textContent = `${ordinal(currentRound())} Round`;
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
    addSwipe(leftSide, d => { if (d < 0) { scoreA = Math.max(0, scoreA + d); updateDisplay(); } });
    addSwipe(rightSide, d => { if (d < 0) { scoreB = Math.max(0, scoreB + d); updateDisplay(); } });
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

  const playBtn = document.getElementById("scoreboard-play");
  // Time between the START of consecutive countdown clips. Tight enough to
  // feel like the real "Three! Two! One! Let it Rip!" cadence even when the
  // wav files have trailing silence.
  const COUNTDOWN_STEP_MS = 850;
  let countdownPlaying = false;
  let countdownTimers = [];
  function clearCountdownTimers() {
    countdownTimers.forEach(t => clearTimeout(t));
    countdownTimers = [];
  }
  function playCountdown() {
    if (countdownPlaying) return;
    countdownPlaying = true;
    if (playBtn) playBtn.classList.add("is-playing");
    countdownClips.forEach((clip, i) => {
      const t = setTimeout(() => {
        clip.currentTime = 0;
        clip.play().catch(() => {});
        if (i === countdownClips.length - 1) {
          // Release the button shortly after the last clip starts so rapid
          // re-tapping is allowed once the sequence is fully kicked off.
          const release = setTimeout(() => {
            countdownPlaying = false;
            if (playBtn) playBtn.classList.remove("is-playing");
          }, COUNTDOWN_STEP_MS);
          countdownTimers.push(release);
        }
      }, i * COUNTDOWN_STEP_MS);
      countdownTimers.push(t);
    });
  }
  playBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    ensureCountdownAmplifier();
    if (audioCtx && audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    playCountdown();
  });

  overlay.querySelectorAll(".sb-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = btn.dataset.side;
      const delta = parseInt(btn.dataset.delta, 10);
      if (side === "a") { scoreA = Math.max(0, scoreA + delta); }
      else { scoreB = Math.max(0, scoreB + delta); }
      scorePresses += 1;
      updateDisplay();
      const sound = finishSounds[btn.textContent.trim()];
      if (sound) {
        sound.currentTime = 0;
        sound.play().catch(() => {});
      }
    });
  });

  resetBtn.addEventListener("click", () => {
    scoreA = 0;
    scoreB = 0;
    scorePresses = 0;
    updateDisplay();
  });

  // True when the visible left/right have been swapped from the original
  // m.a/m.b. We re-swap on save so the callback receives scores keyed to the
  // ORIGINAL player order (avoids mis-attributing scores after a visual flip).
  let swapped = false;
  const swapBtn = document.getElementById("scoreboard-swap");
  swapBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const tmpScore = scoreA;
    scoreA = scoreB;
    scoreB = tmpScore;
    if (labelA && labelB) {
      // Swap the FULL label (avatar + name), not just text — `.textContent`
      // dropped the avatar <img>, so the profile pic vanished on swap.
      // Swapping innerHTML moves the already-resolved photo across, no reload.
      const tmpLabel = labelA.innerHTML;
      labelA.innerHTML = labelB.innerHTML;
      labelB.innerHTML = tmpLabel;
    }
    swapped = !swapped;
    updateDisplay();
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
  const enterFullscreen = () => {
    const el = document.documentElement;
    (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el).catch(() => {});
  };
  const exitFullscreen = () => {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn && (document.fullscreenElement || document.webkitFullscreenElement)) fn.call(document).catch(() => {});
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
    swapped = false;
    scoreboardScoreChange = null;
    scoreboardCancelCallback = null;
    updateDisplay();
    closeBtn?.classList.add("hidden");
    // The board is no longer armed, so neither the rotate prompt nor the
    // portrait fallback should outlive it.
    portraitOverride = false;
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
    swapped = false;
    // Set the live-score hook BEFORE the first updateDisplay so the opening
    // 0–0 is pushed immediately (the monitor shows the score the moment the
    // match goes live).
    scoreboardScoreChange = typeof onScoreChange === "function" ? onScoreChange : null;
    updateDisplay();
    scoreboardSaveCallback = typeof onSave === "function" ? onSave : null;
    closeBtn?.classList.toggle("hidden", !scoreboardSaveCallback);
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
        // Portrait: tell the judge what to do rather than showing nothing. The
        // prompt also carries the escape hatch for a phone that can't rotate.
        overlay.classList.add("hidden");
        overlay.classList.remove("scoreboard-portrait");
        portraitOverride = false;
        showRotateHint();
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
      if (!isLandscape()) tryLockLandscape();
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
        hideRotateHint();
        exitFullscreen();
        return;
      }
      if (isLandscape()) {
        // Rotating resolves the prompt, and drops the portrait layout in favour
        // of the real landscape board.
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
        showRotateHint();
        releaseLandscape();
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
