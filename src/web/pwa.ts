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
  if (d.type === "close") {
    e.waitUntil(self.registration.getNotifications({ tag: d.tag }).then(function (list) {
      list.forEach(function (n) { n.close(); });
    }));
    return;
  }
  e.waitUntil(self.registration.showNotification(d.title || "Access request", {
    body: d.body || "",
    tag: d.tag,
    icon: "/static/icon-192.png",
    data: { url: typeof d.url === "string" && d.url.charAt(0) === "/" ? d.url : "/access" },
    renotify: true,
    requireInteraction: true
  }));
});

self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var url = new URL((e.notification.data && e.notification.data.url) || "/access", self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].url.indexOf(self.location.origin) === 0 && "focus" in list[i]) {
        return list[i].focus().then(function (c) { return c && "navigate" in c ? c.navigate(url) : undefined; });
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;
