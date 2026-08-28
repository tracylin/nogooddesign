// Keeps the app openable with no signal. A market building is exactly where a
// force-close and reopen would otherwise give you a blank screen.
// Bump this whenever the shell changes in a way phones should not keep a stale
// copy of. Activating drops every older cache.
const SHELL = "ngd-shell-v4";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => cache.addAll(["/", "/index.html"]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  // Sync and export traffic must never be served from a cache. Stale counts
  // would be worse than no counts.
  if (url.origin !== self.location.origin) return;

  // Opening the app: prefer the network so a new version arrives, fall back to
  // the cached copy when there is no signal.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          event.waitUntil(caches.open(SHELL).then((c) => c.put("/index.html", copy)));
          return response;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit || Response.error()))
    );
    return;
  }

  // Everything else is a build asset with a content hashed name, so once it is
  // cached it can be served from there without ever going stale.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          event.waitUntil(caches.open(SHELL).then((c) => c.put(request, copy)));
        }
        return response;
      });
    })
  );
});
