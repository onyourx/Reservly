// Minimal service worker: makes the app installable and serves the cached shell
// when the network is flaky. API calls always go to the network.
const SHELL = "reservly-shell-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(["/m/"])));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api") || url.pathname.startsWith("/sign")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && url.pathname.startsWith("/m")) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/m/")))
  );
});
