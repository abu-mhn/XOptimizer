// docs/js/reel.js - Featured reels (Instagram embeds)
// To feature a new reel, paste its permalink at the top of REEL_PERMALINKS.
// Newest first — they render in array order down the Reel tab.
const REEL_PERMALINKS = [
  "https://www.instagram.com/reel/DXhNBrxE8Ib/",
  "https://www.instagram.com/reel/DXiPSOiAWzo/"
];

(function () {
  const container = document.getElementById("reel-list");
  if (!container) return;

  container.innerHTML = REEL_PERMALINKS.map(url => `
    <blockquote
      class="instagram-media"
      data-instgrm-captioned
      data-instgrm-permalink="${url}"
      data-instgrm-version="14"
      style="background:#FFF; border:0; border-radius:3px; box-shadow:0 0 1px 0 rgba(0,0,0,0.5),0 1px 10px 0 rgba(0,0,0,0.15); margin: 1px auto; max-width:540px; min-width:326px; padding:0; width:99.375%;">
      <a href="${url}" target="_blank" rel="noopener" style="color:#3897f0; padding:16px; text-decoration:none; display:block; text-align:center;">View this post on Instagram</a>
    </blockquote>
  `).join("");

  // If embed.js already loaded, kick processing now. Otherwise it auto-scans
  // when it loads and picks up these blockquotes.
  if (window.instgrm && window.instgrm.Embeds && typeof window.instgrm.Embeds.process === "function") {
    window.instgrm.Embeds.process();
  }
})();
