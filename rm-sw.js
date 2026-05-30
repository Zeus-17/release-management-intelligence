// Release Management Intelligence Tool — Service Worker
// Activates immediately, clears all caches, reloads tabs, then unregisters.
// Ensures returning users always get the latest HTML from the network.

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.map(n => caches.delete(n))))
      .then(() => self.clients.claim())
      .then(() => self.clients.matchAll({ type:'window', includeUncontrolled:true }))
      .then(clients => { clients.forEach(c => c.navigate(c.url)); })
      .then(() => self.registration.unregister())
  );
});

self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
