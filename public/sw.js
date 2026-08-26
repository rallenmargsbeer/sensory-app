// This service worker exists purely to satisfy "installability" checks
// on some browsers (notably Android Chrome, which requires an active
// service worker with a fetch handler before showing an install prompt).
// It deliberately does NOT cache anything — this app depends on live
// data from Supabase every time, so serving a cached/stale response
// would be actively wrong. Every request just passes straight through.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      // Let the browser handle the failure itself (its normal offline/error
      // page) instead of the service worker throwing an unhandled rejection.
      return Response.error();
    })
  );
});
