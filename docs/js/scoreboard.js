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

  const overlay = document.getElementById("scoreboard-overlay");
  const scoreAEl = document.getElementById("score-a");
  const scoreBEl = document.getElementById("score-b");
  const labelA = overlay?.querySelector(".scoreboard-left .scoreboard-player-label");
  const labelB = overlay?.querySelector(".scoreboard-right .scoreboard-player-label");
  const resetBtn = document.getElementById("scoreboard-reset");
  const closeBtn = document.getElementById("scoreboard-close");
  const leftSide = document.getElementById("scoreboard-left");
  const rightSide = document.getElementById("scoreboard-right");
  const roundEl = document.getElementById("scoreboard-round");

  if (!overlay) return;

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
  }

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

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
      const tmpLabel = labelA.textContent;
      labelA.textContent = labelB.textContent;
      labelB.textContent = tmpLabel;
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
    closeBtn.classList.add("hidden");
    if (cb) {
      // Re-key to original m.a/m.b order if the user swapped sides.
      const out = swapped
        ? { scoreA: scoreB, scoreB: scoreA }
        : { scoreA, scoreB };
      cb(out);
    }
    pendingResetOnPortrait = true;
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

  // Clear any match-linked state so the scoreboard behaves as the default
  // standalone board again (empty names, 0-0, no save target). Called when
  // the user leaves / resets a live room so they don't end up with stale
  // match context stuck on the overlay.
  window.resetScoreboardToDefault = function () {
    scoreboardSaveCallback = null;
    if (labelA) labelA.textContent = "A";
    if (labelB) labelB.textContent = "B";
    scoreA = 0;
    scoreB = 0;
    scorePresses = 0;
    swapped = false;
    updateDisplay();
    closeBtn?.classList.add("hidden");
  };

  // Scores are entered only via the scoreboard overlay, and the overlay is
  // only revealed by tilting the phone to landscape. No alternative input.
  window.openScoreboard = function (nameA, nameB, onSave, initialA, initialB) {
    if (!isMobile) {
      alert("Scoring uses the tilt-activated scoreboard — open this page on your phone and rotate to landscape.");
      return;
    }

    // Safety net: if called for a view-only participant, drop the match
    // context and fall back to the default standalone scoreboard (no save
    // callback, no pre-filled names/scores). The tilt-to-open behavior for
    // the standalone board is unchanged.
    if (swissEditCode && !swissCanEdit) {
      nameA = "";
      nameB = "";
      onSave = null;
      initialA = 0;
      initialB = 0;
    }

    if (labelA) labelA.textContent = nameA || "A";
    if (labelB) labelB.textContent = nameB || "B";
    scoreA = typeof initialA === "number" ? initialA : 0;
    scoreB = typeof initialB === "number" ? initialB : 0;
    scorePresses = 0;
    swapped = false;
    updateDisplay();
    scoreboardSaveCallback = typeof onSave === "function" ? onSave : null;
    closeBtn?.classList.toggle("hidden", !scoreboardSaveCallback);
    // Only reveal if already tilted; otherwise wait for the orientation handler.
    if (isLandscape()) { overlay.classList.remove("hidden"); enterFullscreen(); }
    else { overlay.classList.add("hidden"); }
  };

  if (isMobile) {
    const handleOrientation = () => {
      const armed = scoreboardEnabled || !!scoreboardSaveCallback;
      if (!armed) { overlay.classList.add("hidden"); exitFullscreen(); return; }
      if (isLandscape()) { overlay.classList.remove("hidden"); enterFullscreen(); }
      else {
        overlay.classList.add("hidden");
        exitFullscreen();
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
