// docs/js/scoreboard.js - landscape-activated match scoreboard overlay
// ================= SCOREBOARD =================
let scoreboardEnabled = false;
let scoreboardSaveCallback = null;

(function () {
  let scoreA = 0;
  let scoreB = 0;

  const overlay = document.getElementById("scoreboard-overlay");
  const scoreAEl = document.getElementById("score-a");
  const scoreBEl = document.getElementById("score-b");
  const labelA = overlay?.querySelector(".scoreboard-left .scoreboard-player-label");
  const labelB = overlay?.querySelector(".scoreboard-right .scoreboard-player-label");
  const resetBtn = document.getElementById("scoreboard-reset");
  const closeBtn = document.getElementById("scoreboard-close");
  const leftSide = document.getElementById("scoreboard-left");
  const rightSide = document.getElementById("scoreboard-right");

  if (!overlay) return;

  function updateDisplay() {
    scoreAEl.textContent = scoreA;
    scoreBEl.textContent = scoreB;
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
    new Audio("assets/voices/three.wav"),
    new Audio("assets/voices/two.wav"),
    new Audio("assets/voices/one.wav"),
    new Audio("assets/voices/go shoot.wav")
  ];

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
    playCountdown();
  });

  overlay.querySelectorAll(".sb-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const side = btn.dataset.side;
      const delta = parseInt(btn.dataset.delta, 10);
      if (side === "a") { scoreA = Math.max(0, scoreA + delta); }
      else { scoreB = Math.max(0, scoreB + delta); }
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
    if (cb) cb({ scoreA, scoreB });
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
