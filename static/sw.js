// minimal service worker — passthrough fetch, required for pwa installability
self.addEventListener("fetch", (e) => e.respondWith(fetch(e.request)));
