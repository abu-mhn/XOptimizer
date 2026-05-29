// docs/sw.js — minimal service worker, registered from /.
//
// It exists only so the page can call `registration.showNotification(...)`
// for match-start alerts. Mobile Chromium (Android Chrome / Edge / Brave)
// rejects `new Notification(...)` from a regular page and only allows
// notifications dispatched through a service worker registration.
//
// No precaching, no fetch interception, no push subscriptions — this SW
// stays out of the way for everything except notifications. Updating
// only requires bumping the SW_VERSION constant.

const SW_VERSION = "1";

self.addEventListener("install", (e) => {
  // Take over immediately on first install + on every update.
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

// Tapping the system notification focuses an existing app tab or opens
// the tournament page if none is open.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      // Prefer a tab already on the tournament page; otherwise focus any.
      if (client.url && client.url.includes("/tournament/") && "focus" in client) {
        return client.focus();
      }
    }
    for (const client of all) {
      if ("focus" in client) return client.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow("/tournament/");
  })());
});
