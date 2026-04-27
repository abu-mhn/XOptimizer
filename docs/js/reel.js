// docs/js/reel.js - Featured YouTube channels via uploads-playlist embed
//
// Each region below is a separate sub-tab in the Buzz Bey panel. Each entry
// in a region renders as an embedded YouTube player playing through the
// channel's uploads, newest first. New videos appear automatically — no
// API key, no fetching, no CORS proxy, no rate limits.
//
// Each entry can be:
//   - 'UCxxxxxxx…' — raw channel ID, auto-converted to its uploads
//                    playlist (UC → UU). Find via View Page Source on
//                    the channel page and search for "channelId".
//   - 'UUxxxxxxx…' — uploads-playlist ID (used as-is).
//   - 'PLxxxxxxx…' — any custom playlist ID (used as-is).
const CHANNELS_BY_REGION = {
  local: [
    'UCI8cFZdZyHiGjI7D019hcIA',
    'UC0gVQLsw6xXIl8SJEwuvVlQ',
    'UCCdmOS3wtcy5G2jHf-vmAYA'
  ],
  international: [
    // 'UCxxxxxxxxxxxxxxxxxxxxx',
    'UC97xWAwS2cbcGXOLUc1z4Rw',
    'UC7hWsUrPdsZ7JavI12CwqVA',
    'UCevPRqPKWyySEkw8Aaz-6Qw',
    'UCX47RII8vAVO7oVmySW9SEA',
    'UCexD22sQbSLAU0QI9eABe-w',
    'UCQ0rhUqGo4Rvk-zDKbDJgrA',
    'UCeIfcCGnJWAZ-lU40NLIilg',
    'UClGwVncNrp6EH-KA8D012iw'
  ],
  japan: [
    // 'UCxxxxxxxxxxxxxxxxxxxxx',
    'UCuA_cd46z363EvBDCY2D8jg',
    'UCLt1tG6laEj0rG4DqM_qRWg',
    'UCy4By42-B23CKu6vMk3f7NA',
    'UC89bJSkRSqhExrQ7OCzwtwA',
    'UCPs2qwHlIap68sgJtbF98HA'
  ],
};

(function () {
  function embedUrl(entry) {
    // UC… channel ID → UU… uploads playlist (every channel has one).
    // YouTube's playlist embed expects a playlist ID, not a channel ID,
    // so we convert. Other prefixes (UU, PL, …) are used as-is.
    //
    // Use youtube-nocookie.com (privacy-enhanced mode) — it disables
    // cookie tracking and most of the ad-tracking pixels that would
    // otherwise trigger hundreds of CORS-blocked / unload-violation
    // console errors when many iframes load on one page.
    const id = /^UC[A-Za-z0-9_-]{22}$/.test(entry) ? 'UU' + entry.slice(2) : entry;
    return `https://www.youtube-nocookie.com/embed/videoseries?list=${encodeURIComponent(id)}`;
  }

  // Build each iframe via DOM APIs (createElement + appendChild) instead of
  // an innerHTML rewrite. Browser extensions like YouTube enhancers cache
  // references to iframe child nodes; an innerHTML replacement nukes those
  // refs and triggers `removeChild` errors when the extension later tries
  // to detach them. createElement gives extensions cleaner attach points.
  function buildIframe(entry) {
    const wrapper = document.createElement('div');
    wrapper.className = 'reel-video';
    const iframe = document.createElement('iframe');
    iframe.src             = embedUrl(entry);
    iframe.title           = 'Featured uploads';
    iframe.frameBorder     = '0';
    iframe.allow           = 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.referrerPolicy  = 'strict-origin-when-cross-origin';
    iframe.allowFullscreen = true;
    iframe.loading         = 'lazy';
    wrapper.appendChild(iframe);
    return wrapper;
  }

  function buildEmpty(regionId) {
    const p = document.createElement('p');
    p.className = 'reel-empty';
    p.appendChild(document.createTextNode('No channels yet for this region. Add channel IDs to '));
    const code1 = document.createElement('code');
    code1.textContent = `CHANNELS_BY_REGION.${regionId}`;
    p.appendChild(code1);
    p.appendChild(document.createTextNode(' in '));
    const code2 = document.createElement('code');
    code2.textContent = 'js/reel.js';
    p.appendChild(code2);
    p.appendChild(document.createTextNode('.'));
    return p;
  }

  function renderRegion(regionId, entries) {
    const container = document.getElementById('reel-list-' + regionId);
    if (!container) return;
    // Clear without using innerHTML='' — also gentler on extensions.
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!entries || entries.length === 0) {
      container.appendChild(buildEmpty(regionId));
      return;
    }
    for (const entry of entries) {
      container.appendChild(buildIframe(entry));
    }
  }

  // Render each region's iframes once at module load. They live in
  // separate panels and visibility is toggled by the sub-tab handler below.
  for (const region of Object.keys(CHANNELS_BY_REGION)) {
    renderRegion(region, CHANNELS_BY_REGION[region]);
  }

  // Sub-tab switching: clicking a tab activates it and shows the matching
  // panel; the others get hidden.
  const subTabs = document.querySelectorAll('.reel-sub-tab');
  subTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const region = tab.dataset.reelRegion;
      subTabs.forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.reel-panel').forEach(panel => {
        panel.classList.toggle('hidden', panel.id !== 'reel-list-' + region);
      });
    });
  });
})();
