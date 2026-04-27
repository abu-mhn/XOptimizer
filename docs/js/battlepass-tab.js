// docs/js/battlepass-tab.js - Battle Pass tab UI (wires battlepass.js to the DOM)
import {
  BattlePass,
  BattlePassFactory,
  getBytes,
  splitIntoChunksUntilZeros,
} from './battlepass.js';

(function () {
  const connectBtn    = document.getElementById('bp-connect');
  if (!connectBtn) return;

  const disconnectBtn = document.getElementById('bp-disconnect');
  const clearBtn      = document.getElementById('bp-clear');
  const statusEl      = document.getElementById('bp-status');
  const resultsEl     = document.getElementById('bp-results');

  // Short header timeout so one hung BLE read can't stall the whole loop —
  // we just retry on the next iteration.
  const HEADER_TIMEOUT_MS = 1500;

  // Accumulated history across this browser session — each successful fetch
  // appends the new launch's speed. Persists to localStorage so a reload
  // doesn't lose the list, since we auto-clear the device buffer.
  const CACHE_KEY = 'bp:session-launches';
  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter(v => typeof v === 'number');
      }
    } catch (_) {}
    return [];
  }
  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(sessionLaunches)); } catch (_) {}
  }

  let device          = null;
  let pollRunning     = false;   // true while the read loop is active
  let pollStop        = false;   // signal the loop to exit
  let inFlight        = false;   // serializes loop reads vs. user-initiated ops (Clear)
  let lastRaw         = null;
  let lastLaunchCount = -1;
  let sessionLaunches = loadCache();   // accumulated history (visible list)

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.classList.remove('bp-error', 'bp-ok', 'bp-busy');
    if (kind === 'error') statusEl.classList.add('bp-error');
    else if (kind === 'ok') statusEl.classList.add('bp-ok');
    // Heuristic: if the message looks like an in-progress one, mark it busy
    // so the status pill gets the pulsing-blue animation.
    else if (/fetching|reading|connecting|scanning|clearing|detected|pausing/i.test(msg)) {
      statusEl.classList.add('bp-busy');
    }
  }

  function setConnectedUI(connected) {
    connectBtn.disabled    = connected;
    disconnectBtn.disabled = !connected;
    clearBtn.disabled      = !connected;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // Renders summary tiles + a numbered list of all launches in this session.
  // `launches` is the full session history; entries are numbers, with a
  // single trailing `null` allowed as the in-flight loading placeholder.
  function renderLaunchData(data) {
    const { header, launches } = data;
    const real  = launches.filter(v => typeof v === 'number');
    const count = real.length;
    const max = count ? Math.max(...real) : 0;
    const min = count ? Math.min(...real) : 0;
    const avg = count ? real.reduce((a, b) => a + b, 0) / count : 0;

    const summary = `
      <div class="bp-summary">
        <div><span class="bp-label">Lifetime peak speed</span><span class="bp-value">${escapeHtml(header.maxLaunchSpeed)}</span></div>
        <div><span class="bp-label">Lifetime launches</span><span class="bp-value">${escapeHtml(header.launchCount)}</span></div>
        <div><span class="bp-label">Recorded</span><span class="bp-value">${count}</span></div>
        <div><span class="bp-label">Min / Avg / Max</span><span class="bp-value">${min} / ${avg.toFixed(1)} / ${max}</span></div>
      </div>`;
    const list = launches.length
      ? `<div class="bp-launches">${launches.map((v, i) =>
          v === null
            ? `<div class="bp-launch"><span>#${i + 1}</span><span class="bp-loading">loading…</span></div>`
            : `<div class="bp-launch"><span>#${i + 1}</span><span>${v}</span></div>`).join('')}</div>`
      : '<div class="bp-help">Waiting for your first launch…</div>';

    resultsEl.innerHTML = summary + list;
  }

  // Parse whatever notifications are currently in BattlePass.readBuffer into
  // a (possibly partial) launches array. Mirrors the parsing in
  // battlepass.js's getLaunchData but runs against the in-progress buffer.
  function peekPartialLaunches() {
    const buf = BattlePass.readBuffer;
    if (!buf || buf.length === 0) return [];
    // Skip the first byte of each notif (page header) before concatenating.
    const joined = buf.map(s => s.substring(2)).join('');
    const chunks = splitIntoChunksUntilZeros(joined);
    return chunks.map(s => parseInt(getBytes(s, 0, 2), 16));
  }

  async function fetchAndRender(optimisticHeader) {
    if (!optimisticHeader) {
      setStatus('Fetching launch data…');
    }

    // Filter out parser garbage. A real launch can't exceed the device's
    // lifetime peak, so anything above that is provably bogus and safe to
    // drop (e.g. timestamp/index fields the chunked parser sometimes
    // surfaces alongside real speeds).
    const validSpeeds = (launches, maxSpeed) =>
      launches.filter(v => typeof v === 'number' && v > 0 && v <= maxSpeed);

    // Progressive watcher: as data notifications stream in, show the most
    // recent valid partial value as a placeholder at the end of the list.
    let watcher = null;
    let lastSeenLen = -1;
    if (optimisticHeader) {
      watcher = setInterval(() => {
        const partial = peekPartialLaunches();
        if (partial.length === lastSeenLen) return;
        lastSeenLen = partial.length;
        const valid = validSpeeds(partial, optimisticHeader.maxLaunchSpeed);
        const tail  = valid.length ? valid[valid.length - 1] : null;
        renderLaunchData({
          header: optimisticHeader,
          launches: [...sessionLaunches, tail],
        });
        setStatus('Fetching launch data…');
      }, 60);
    }

    try {
      const data = await BattlePass.getLaunchData();
      if (!data) return;
      lastLaunchCount = data.header.launchCount;

      const valid = validSpeeds(data.launches, data.header.maxLaunchSpeed);
      const value = valid.length ? valid[valid.length - 1] : undefined;

      if (value !== undefined) {
        sessionLaunches.push(value);
        saveCache();
      }
      lastRaw = data.raw;
      renderLaunchData({ header: data.header, launches: sessionLaunches });

      const n = sessionLaunches.length;
      setStatus(`${n} launch${n === 1 ? '' : 'es'} recorded.`, 'ok');

      if (data.launches.length > 0) {
        try { await BattlePass.clearData(); } catch (_) {}
      }
    } finally {
      if (watcher) clearInterval(watcher);
    }
  }

  // Continuous read loop. Back-to-back header reads (with a short per-read
  // timeout so a hang doesn't stall the loop) until launchCount changes,
  // then one full data fetch + render. Yields to the event loop between
  // iterations so the UI stays responsive.
  async function readLoop() {
    pollRunning = true;
    while (!pollStop && BattlePass.isConnected) {
      // Skip if a user-initiated op (Clear) is mid-flight; come back next tick.
      if (inFlight) {
        await new Promise(r => setTimeout(r, 50));
        continue;
      }
      inFlight = true;
      try {
        let header;
        try {
          header = await BattlePass.getHeader({ timeoutMs: HEADER_TIMEOUT_MS });
        } catch (_) {
          continue;   // transient — try next tick
        }
        if (header && header.launchCount !== lastLaunchCount) {
          // Sanity check on launchCount transitions:
          //  - Forward jump > SANITY_MAX_DELTA: almost certainly a corrupt/
          //    straggler response landing in our cleared buffer (common after
          //    a BLE timeout). Discard and retry next tick.
          //  - Backward jump: the device's launchCount went down, which means
          //    it was reset (e.g. via Clear Data). Re-baseline silently.
          if (lastLaunchCount >= 0) {
            const delta = header.launchCount - lastLaunchCount;
            const SANITY_MAX_DELTA = 50;
            if (delta < 0) {
              lastLaunchCount = header.launchCount;
              continue;
            }
            if (delta > SANITY_MAX_DELTA) {
              continue;
            }
          }

          // Optimistic render: append a single "loading…" placeholder to the
          // existing session list so the user sees a new row appear within
          // ~one BLE round-trip, even before the heavier data fetch returns.
          let didOptimistic = false;
          if (lastLaunchCount >= 0 && header.launchCount > lastLaunchCount) {
            renderLaunchData({
              header,
              launches: [...sessionLaunches, null],
            });
            setStatus(`new launch detected — fetching speed…`);
            didOptimistic = true;
          }

          try {
            // Only engage the progressive watcher when we showed an optimistic
            // UI — otherwise it would manufacture a phantom "loading…" row
            // (e.g. right after Clear Data, when there's no real baseline).
            await fetchAndRender(didOptimistic ? header : null);
          } catch (_) {
            // try again next iteration
          }
        }
      } finally {
        inFlight = false;
      }
      // Yield so DOM events and other timers get a chance to run between reads.
      await new Promise(r => setTimeout(r, 0));
    }
    pollRunning = false;
  }

  function startPolling() {
    if (pollRunning) return;
    pollStop = false;
    readLoop();
  }

  function stopPolling() {
    pollStop = true;
  }

  function watchDisconnect() {
    if (!device || !device.device) return;
    device.device.addEventListener('gattserverdisconnected', () => {
      device          = null;
      lastRaw         = null;
      lastLaunchCount = -1;
      stopPolling();
      setConnectedUI(false);
      setStatus('Battle Pass disconnected.', 'error');
    }, { once: true });
  }

  // iOS / iPadOS gets a tailored unsupported-browser message because the
  // limitation is Apple's WebKit (no Web Bluetooth in any iOS browser); we
  // point them at Bluefy specifically instead of generic "use Chrome".
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  connectBtn.addEventListener('click', async () => {
    if (!('bluetooth' in navigator)) {
      if (isIOS) {
        setStatus('iOS Safari and Chrome iOS don\'t support Web Bluetooth. Install the Bluefy browser from the App Store and open this page there.', 'error');
      } else {
        setStatus('Web Bluetooth is not supported in this browser. Use Chrome or Edge over HTTPS.', 'error');
      }
      return;
    }
    setStatus('Scanning for BEYBLADE_TOOL01…');
    try {
      device = await BattlePassFactory.scanForBattlePass();
      setStatus(`Connecting to ${device.name || 'Battle Pass'}…`);
      await BattlePassFactory.connectToBattlePass(device);
      watchDisconnect();
      setConnectedUI(true);

      // Seed read so the user immediately sees existing data and the
      // launchCount baseline is set before polling starts.
      inFlight = true;
      try {
        await fetchAndRender();
      } catch (err) {
        setStatus(`Error: ${err && err.message ? err.message : err}`, 'error');
      } finally {
        inFlight = false;
      }
      startPolling();
    } catch (err) {
      device = null;
      setConnectedUI(false);
      const msg = err && err.message ? err.message : String(err);
      if (/not allowed to access any service/i.test(msg)) {
        setStatus('No GATT service UUIDs declared. Add the device\'s primary service UUID to OPTIONAL_SERVICES in js/battlepass.js, then reload.', 'error');
      } else {
        setStatus(`Error: ${msg}`, 'error');
      }
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    stopPolling();
    try {
      await BattlePass.disconnect();
      setStatus('Disconnected.', 'ok');
    } catch (err) {
      setStatus(`Error: ${err && err.message ? err.message : err}`, 'error');
    } finally {
      device          = null;
      lastRaw         = null;
      lastLaunchCount = -1;
      setConnectedUI(false);
    }
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Erase all launch data on the Battle Pass?')) return;
    clearBtn.disabled = true;
    setStatus('Pausing auto-refresh…');

    // Pause the read loop and wait for it to actually exit, otherwise the
    // clear write would race the loop's in-flight header read and corrupt
    // the shared notification buffer.
    const shouldResume = pollRunning;
    stopPolling();
    while (pollRunning) {
      await new Promise(r => setTimeout(r, 20));
    }

    inFlight = true;
    setStatus('Clearing data…');
    try {
      await BattlePass.clearData();
      resultsEl.innerHTML = '';
      lastRaw         = null;
      lastLaunchCount = -1;
      sessionLaunches = [];
      saveCache();
      setStatus('Data cleared.', 'ok');
    } catch (err) {
      setStatus(`Error: ${err && err.message ? err.message : err}`, 'error');
    } finally {
      inFlight = false;
      if (BattlePass.isConnected) {
        clearBtn.disabled = false;
        if (shouldResume) startPolling();
      }
    }
  });

  // Pause polling while the tab is hidden — saves BLE traffic and the
  // device's battery, and avoids piling up notifications we won't render.
  document.addEventListener('visibilitychange', () => {
    if (!BattlePass.isConnected) return;
    if (document.hidden) stopPolling();
    else startPolling();
  });
})();
