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
    // Desktop: no portrait tilt will follow, so hide + reset the modal now.
    if (!isMobile && desktopModalOpen) closeScoreboardDesktopModal();
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
    setScoreboardLabel(labelA, "A");
    setScoreboardLabel(labelB, "B");
    scoreA = 0;
    scoreB = 0;
    scorePresses = 0;
    swapped = false;
    updateDisplay();
    closeBtn?.classList.add("hidden");
  };

  // Load names/scores + save callback onto the board, revealing it if already
  // in landscape (otherwise the orientation handler shows it on tilt).
  function setupScoreboard(nameA, nameB, onSave, initialA, initialB) {
    // Safety net: if called for a view-only participant, drop the match
    // context and fall back to the default standalone scoreboard (no save
    // callback, no pre-filled names/scores).
    if (swissEditCode && !swissCanEdit) {
      nameA = ""; nameB = ""; onSave = null; initialA = 0; initialB = 0;
    }
    setScoreboardLabel(labelA, nameA || "A");
    setScoreboardLabel(labelB, nameB || "B");
    scoreA = typeof initialA === "number" ? initialA : 0;
    scoreB = typeof initialB === "number" ? initialB : 0;
    scorePresses = 0;
    swapped = false;
    updateDisplay();
    scoreboardSaveCallback = typeof onSave === "function" ? onSave : null;
    closeBtn?.classList.toggle("hidden", !scoreboardSaveCallback);
    // Mobile is tilt-driven: reveal now only if already landscape, otherwise
    // the orientation handler shows it on the next tilt. Desktop has no tilt —
    // openScoreboard reveals the board as a modal popup itself (below).
    if (isMobile) {
      if (isLandscape()) { overlay.classList.remove("hidden"); enterFullscreen(); }
      else { overlay.classList.add("hidden"); }
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
  }
  function closeScoreboardDesktopModal() {
    overlay.classList.add("hidden");
    desktopModalOpen = false;
    pendingResetOnPortrait = false;
    if (typeof window.resetScoreboardToDefault === "function") {
      window.resetScoreboardToDefault();
    }
  }

  // Scores are entered only via the scoreboard overlay. On mobile it's revealed
  // by tilting to landscape; on desktop openScoreboard shows it as a modal
  // popup directly (no tilt / fullscreen needed).
  window.openScoreboard = function (nameA, nameB, onSave, initialA, initialB) {
    setupScoreboard(nameA, nameB, onSave, initialA, initialB);
    if (!isMobile) openScoreboardDesktopModal();
  };

  // Desktop dismiss without saving — Escape closes the modal and clears the
  // (unsaved) match context. No-op on mobile / when no modal is open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !desktopModalOpen) return;
    scoreboardSaveCallback = null;
    closeScoreboardDesktopModal();
  });

  // armScoreboard is the silent (auto) entry — used by Battle Royale to arm the
  // board the moment a battle is accepted, so the Judge just tilts to score.
  // No desktop alert (nothing to do on a device that can't tilt).
  window.armScoreboard = function (nameA, nameB, onSave, initialA, initialB) {
    if (!isMobile) return;
    setupScoreboard(nameA, nameB, onSave, initialA, initialB);
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
