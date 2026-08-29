// Keeps the app openable with no signal. A market building is exactly where a
// force-close and reopen would otherwise give you a blank screen.
// Bump this whenever the shell changes in a way phones should not keep a stale
// copy of. Activating drops every older cache.
const SHELL = "ngd-shell-v11";

// Product photos are kept apart from the shell. Their names never change, they
// are 2.4MB all together, and a shell bump should not make a phone fetch them
// again on market wifi.
const PHOTOS = "ngd-photos-v1";

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
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== PHOTOS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(() => stashPhotos())
  );
});

// Pulled down quietly once the app is up, a few at a time, so the enlarged
// photos are there at a stall with no signal. Anything that fails is simply
// left out: the row thumbnail is still readable, and the next visit tries again.
async function stashPhotos() {
  try {
    const cache = await caches.open(PHOTOS);
    const res = await fetch(new URL("img/manifest.json", self.registration.scope));
    if (!res.ok) return;
    const files = await res.json();
    for (let i = 0; i < files.length; i += 6) {
      await Promise.all(files.slice(i, i + 6).map(async (name) => {
        const url = new URL("img/" + name, self.registration.scope).toString();
        if (await cache.match(url)) return;
        try {
          const hit = await fetch(url);
          if (hit.ok) await cache.put(url, hit);
        } catch { /* no signal, try again next time */ }
      }));
    }
  } catch { /* no signal, try again next time */ }
}

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

  // A product photo, which is the same picture forever under that name.
  if (url.pathname.includes("/img/")) {
    event.respondWith(
      caches.open(PHOTOS).then((cache) => cache.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok && response.type === "basic") cache.put(request, response.clone());
        return response;
      })))
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
