// docs/app.js - entry point (What's New update popup)
// --- Update popup ---
(function () {
  const popup = document.getElementById("update-popup");
  if (!popup) return;

  popup.classList.remove("hidden");
  const dismiss = () => {
    popup.classList.add("hidden");
    scoreboardEnabled = true;
  };
  popup.querySelector(".popup-ok").addEventListener("click", dismiss);
})();
