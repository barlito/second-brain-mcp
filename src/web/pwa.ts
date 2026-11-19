// PWA surface of the admin: web app manifest and the push service worker (both served behind the
// same auth as every page). The worker has no fetch handler and caches nothing.
export const THEME_COLOR = "#161a22";
const BACKGROUND_COLOR = "#f6f7f9";

export const MANIFEST = {
  name: "second-brain admin",
  short_name: "second-brain",
  start_url: "/access",
  scope: "/",
  display: "standalone",
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  icons: [
    { src: "/static/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
    { src: "/static/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

export const SW_JS = String.raw`self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = {}; }
  e.waitUntil(self.registration.showNotification(d.title || "Access request", {
    body: d.body || "",
    tag: d.tag || "access",
    icon: "/static/icon-192.png",
    data: { url: typeof d.url === "string" && d.url.charAt(0) === "/" ? d.url : "/access" },
    renotify: true
  }));
});

// Reuse an open Access page only: another admin page (vault editor) may hold unsaved edits.
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/access", self.location.origin).href;
  function open() { return self.clients.openWindow(url); }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    var page = list.filter(function (c) { return new URL(c.url).pathname === "/access"; })[0];
    if (!page) return open();
    return page.focus().then(function (c) { return c.navigate(url); }).catch(open);
  }));
});
`;
