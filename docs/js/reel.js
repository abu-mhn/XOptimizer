// docs/js/reel.js - Featured YouTube channels via uploads-playlist embed
//
// Each entry below renders as an embedded YouTube player playing through
// the channel's uploads, newest first. New videos appear automatically —
// no API key, no fetching, no CORS proxy, no rate limits.
//
// Each entry can be:
//   - 'UCxxxxxxx…' — raw channel ID, auto-converted to its uploads
//                    playlist (UC → UU). Find via View Page Source on
//                    the channel page and search for "channelId".
//   - 'UUxxxxxxx…' — uploads-playlist ID (used as-is).
//   - 'PLxxxxxxx…' — any custom playlist ID (used as-is).
const CHANNELS = [
  'UCI8cFZdZyHiGjI7D019hcIA',
  'UCCdmOS3wtcy5G2jHf-vmAYA',
  'UC0gVQLsw6xXIl8SJEwuvVlQ'
];

(function () {
  const container = document.getElementById('reel-list');
  if (!container) return;

  if (CHANNELS.length === 0) {
    container.innerHTML = '<p class="reel-empty">No channels configured. Add channel IDs to <code>CHANNELS</code> in <code>js/reel.js</code>.</p>';
    return;
  }

  function embedUrl(entry) {
    // UC… channel ID → UU… uploads playlist (every channel has one).
    // YouTube's playlist embed expects a playlist ID, not a channel ID,
    // so we convert. Other prefixes (UU, PL, …) are used as-is.
    const id = /^UC[A-Za-z0-9_-]{22}$/.test(entry) ? 'UU' + entry.slice(2) : entry;
    const url = `https://www.youtube.com/embed/videoseries?list=${encodeURIComponent(id)}`;
    console.log('[reel] entry:', entry, '→ url:', url);
    return url;
  }

  container.innerHTML = CHANNELS.map(entry => `
    <div class="reel-video">
      <iframe
        src="${embedUrl(entry)}"
        title="Featured uploads"
        frameborder="0"
        allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerpolicy="strict-origin-when-cross-origin"
        allowfullscreen
        loading="lazy"></iframe>
    </div>
  `).join('');
})();
