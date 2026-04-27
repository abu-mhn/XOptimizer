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

  let device          = null;
  let pollRunning     = false;   // true while the read loop is active
  let pollStop        = false;   // signal the loop to exit
  let inFlight        = false;   // serializes loop reads vs. user-initiated ops (Clear)
  let lastRaw         = null;
  let lastLaunchCount = -1;
  let lastLaunches    = [];      // last fully-fetched launches array, for optimistic re-renders

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

  // `launches` may contain `null` entries — these render as a "loading…"
  // placeholder while the slow full-data fetch is in flight. Min/Avg/Max
  // ignore placeholder entries so the stats reflect known values only.
  function renderLaunchData(data) {
    const { header, launches } = data;
    const count = launches.length;
    const real  = launches.filter(v => v !== null);
    const max = real.length ? Math.max(...real) : 0;
    const min = real.length ? Math.min(...real) : 0;
    const avg = real.length ? real.reduce((a, b) => a + b, 0) / real.length : 0;

    const summary = `
      <div class="bp-summary">
        <div><span class="bp-label">Lifetime peak speed</span><span class="bp-value">${escapeHtml(header.maxLaunchSpeed)}</span></div>
        <div><span class="bp-label">Lifetime launches</span><span class="bp-value">${escapeHtml(header.launchCount)}</span></div>
        <div><span class="bp-label">In buffer</span><span class="bp-value">${count}</span></div>
        <div><span class="bp-label">Min / Avg / Max (buffer)</span><span class="bp-value">${min} / ${avg.toFixed(1)} / ${max}</span></div>
      </div>`;
    const list = count
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
    // If no optimistic UI was set up (e.g. seed read on connect), still show
    // an explicit "fetching" status so the user knows BLE work is in progress
    // and doesn't think the UI is stuck.
    if (!optimisticHeader) {
      setStatus('Fetching launch data…');
    }

    // If the caller already showed an optimistic UI based on `optimisticHeader`,
    // start a buffer watcher that progressively fills in the placeholder rows
    // as notifications land — instead of waiting for the full fetch to return.
    let watcher = null;
    let lastSeenLen = -1;
    if (optimisticHeader) {
      const cached   = lastLaunches.slice();
      const expected = cached.length + (optimisticHeader.launchCount - lastLaunchCount);
      watcher = setInterval(() => {
        const partial = peekPartialLaunches();
        if (partial.length === lastSeenLen) return;
        lastSeenLen = partial.length;
        // Build the display: at each slot, prefer the freshly-received value,
        // fall back to the cached value from the previous full read, then null.
        // Without this, while partial is still empty, the existing rows would
        // all flicker to "loading…" — which is what the user just hit.
        const display = [];
        for (let i = 0; i < expected; i++) {
          if (i < partial.length)      display.push(partial[i]);
          else if (i < cached.length)  display.push(cached[i]);
          else                         display.push(null);
        }
        renderLaunchData({ header: optimisticHeader, launches: display });
        // Live progress in the status bar so the user can see notifications
        // arriving even before any value flips from "loading…" to a number.
        if (partial.length < expected) {
          setStatus(`Fetching launch data… ${partial.length}/${expected}`);
        }
      }, 60);
    }

    try {
      const data = await BattlePass.getLaunchData();
      if (!data) return;
      lastLaunchCount = data.header.launchCount;
      lastLaunches    = data.launches.slice();
      if (data.raw !== lastRaw) {
        lastRaw = data.raw;
        renderLaunchData(data);
      }
      const count = data.launches.length;
      setStatus(`${count} launch${count === 1 ? '' : 'es'} recorded.`, 'ok');
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

          // Optimistic render: append `delta` placeholder rows to the last
          // known launches list and update the lifetime tiles immediately,
          // so the user sees feedback within ~one BLE round-trip instead of
          // waiting for the slow full-data fetch (~150ms per notification).
          // Only do this when we already have a baseline (lastLaunchCount >= 0)
          // and the count moved forward — otherwise let the real fetch render.
          let didOptimistic = false;
          if (lastLaunchCount >= 0 && header.launchCount > lastLaunchCount) {
            const delta = header.launchCount - lastLaunchCount;
            renderLaunchData({
              header,
              launches: [...lastLaunches, ...Array(delta).fill(null)],
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
      lastLaunches    = [];
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
      lastLaunches    = [];
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
      lastLaunches    = [];
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
