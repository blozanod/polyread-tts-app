/**
 * Cross-origin isolation for a host that cannot send headers.
 *
 * ONNX Runtime only runs on more than one CPU thread where the page is
 * cross-origin isolated, and a page only is when it was served with two
 * headers: `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`. The dev server and the desktop
 * build send them. A static host — GitHub Pages, most personal sites — does
 * not let you, and there synthesis on the CPU ran on one thread at about 0.4x
 * realtime: slower than the voice speaks, so playback stopped every few
 * sentences to wait. On four threads the same machine does better than 1.3x.
 *
 * A service worker sits between the page and the network, so it can add the
 * headers itself. It adds them to this app's own responses and to nothing
 * else, caches nothing, and changes nothing about what is fetched. The page
 * registers it only when it is not already isolated (`src/ui/isolation.ts`).
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Chrome throws on this combination if it is re-issued from a worker.
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request).then((response) => {
      // Opaque responses cannot be rewritten, and need not be.
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }),
  );
});
