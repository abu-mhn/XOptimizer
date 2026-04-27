// docs/js/battlepass-tab.js - Battle Pass tab UI (wires battlepass.js to the DOM)
import { BattlePass, BattlePassFactory } from './battlepass.js';

(function () {
  const connectBtn    = document.getElementById('bp-connect');
  if (!connectBtn) return;

  const disconnectBtn = document.getElementById('bp-disconnect');
  const readBtn       = document.getElementById('bp-read');
  const clearBtn      = document.getElementById('bp-clear');
  const statusEl      = document.getElementById('bp-status');
  const resultsEl     = document.getElementById('bp-results');
  const uuidsEl       = document.getElementById('bp-uuids');

  // Nordic UART service — the protocol in battlepass.js (single-byte writes,
  // notify-back stream) is consistent with NUS, so it's a sensible default
  // guess. Override via the UUID textarea if your device exposes something else.
  const DEFAULT_UUIDS = ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'];
  const STORAGE_KEY   = 'bp-service-uuids';

  function loadUuids() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    return DEFAULT_UUIDS.slice();
  }

  function saveUuids(list) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); } catch (_) {}
  }

  function parseUuids(text) {
    return (text || '')
      .split(/[\s,]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }

  uuidsEl.value = loadUuids().join('\n');
  uuidsEl.addEventListener('input', () => saveUuids(parseUuids(uuidsEl.value)));

  let device = null;

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.classList.remove('bp-error', 'bp-ok');
    if (kind === 'error') statusEl.classList.add('bp-error');
    else if (kind === 'ok') statusEl.classList.add('bp-ok');
  }

  function setConnectedUI(connected) {
    connectBtn.disabled    = connected;
    disconnectBtn.disabled = !connected;
    readBtn.disabled       = !connected;
    clearBtn.disabled      = !connected;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  // Treat the device disconnecting (battery, range) as a state reset.
  function watchDisconnect() {
    if (!device || !device.device) return;
    device.device.addEventListener('gattserverdisconnected', () => {
      device = null;
      setConnectedUI(false);
      setStatus('Battle Pass disconnected.', 'error');
    }, { once: true });
  }

  connectBtn.addEventListener('click', async () => {
    if (!('bluetooth' in navigator)) {
      setStatus('Web Bluetooth is not supported in this browser. Use Chrome or Edge over HTTPS.', 'error');
      return;
    }
    const uuids = parseUuids(uuidsEl.value);
    if (uuids.length === 0) {
      setStatus('Add at least one service UUID under "Service UUIDs" before connecting.', 'error');
      return;
    }
    setStatus('Scanning for BEYBLADE_TOOL01…');
    try {
      device = await BattlePassFactory.scanForBattlePass({ optionalServices: uuids });
      setStatus(`Found ${device.name || 'device'} (${device.battlepassID}). Connecting…`);
      await BattlePassFactory.connectToBattlePass(device);
      watchDisconnect();
      setStatus(`Connected to ${device.name || 'Battle Pass'} (${device.battlepassID}).`, 'ok');
      setConnectedUI(true);
    } catch (err) {
      device = null;
      setConnectedUI(false);
      const msg = err && err.message ? err.message : String(err);
      if (/not allowed to access any service/i.test(msg)) {
        setStatus('Connected, but the declared service UUIDs don\'t match this device. Use a BLE scanner (e.g. nRF Connect) to find the device\'s service UUID and paste it under "Service UUIDs".', 'error');
      } else {
        setStatus(`Error: ${msg}`, 'error');
      }
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    try {
      await BattlePass.disconnect();
      setStatus('Disconnected.', 'ok');
    } catch (err) {
      setStatus(`Error: ${err && err.message ? err.message : err}`, 'error');
    } finally {
      device = null;
      setConnectedUI(false);
    }
  });

  readBtn.addEventListener('click', async () => {
    setStatus('Reading launch data…');
    resultsEl.innerHTML = '';
    readBtn.disabled = true;
    try {
      const data = await BattlePass.getLaunchData();
      if (!data) {
        setStatus('No data returned.', 'error');
        return;
      }
      const { header, launches } = data;
      const count = launches.length;
      const max = count ? Math.max(...launches) : 0;
      const min = count ? Math.min(...launches) : 0;
      const avg = count ? launches.reduce((a, b) => a + b, 0) / count : 0;

      const summary = `
        <div class="bp-summary">
          <div><span class="bp-label">Max launch speed</span><span class="bp-value">${escapeHtml(header.maxLaunchSpeed)}</span></div>
          <div><span class="bp-label">Launch count</span><span class="bp-value">${escapeHtml(header.launchCount)}</span></div>
          <div><span class="bp-label">Recorded</span><span class="bp-value">${count}</span></div>
          <div><span class="bp-label">Min / Avg / Max</span><span class="bp-value">${min} / ${avg.toFixed(1)} / ${max}</span></div>
        </div>`;
      const list = count
        ? `<div class="bp-launches">${launches.map((v, i) =>
            `<div class="bp-launch"><span>#${i + 1}</span><span>${v}</span></div>`).join('')}</div>`
        : '<div class="bp-status">No launches recorded yet.</div>';

      resultsEl.innerHTML = summary + list;
      setStatus(`Read ${count} launch${count === 1 ? '' : 'es'}.`, 'ok');
    } catch (err) {
      setStatus(`Error: ${err && err.message ? err.message : err}`, 'error');
    } finally {
      if (BattlePass.isConnected) readBtn.disabled = false;
    }
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('Erase all launch data on the Battle Pass?')) return;
    setStatus('Clearing data…');
    clearBtn.disabled = true;
    try {
      await BattlePass.clearData();
      resultsEl.innerHTML = '';
      setStatus('Data cleared.', 'ok');
    } catch (err) {
      setStatus(`Error: ${err && err.message ? err.message : err}`, 'error');
    } finally {
      if (BattlePass.isConnected) clearBtn.disabled = false;
    }
  });
})();
