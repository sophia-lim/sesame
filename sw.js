/* Sesame service worker.
 *
 * Two jobs:
 *   1. Cache the shell so the app opens instantly, and opens at all when the
 *      phone has no signal.
 *   2. Receive Web Push from the home PC and turn it into a notification.
 *      This is the part that makes Sesame a real app rather than a bookmark.
 */
'use strict';

// Bumped when the shell changes, so installed phones drop the old copy.
const CACHE = 'sesame-v2';
const SHELL = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One missing file must not fail the whole install, or the app becomes
      // uninstallable for a typo in this list.
      .then((c) => Promise.allSettled(SHELL.map((url) => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never cache broker traffic — status and history must always be live.
  if (url.origin !== self.location.origin) return;

  // Network-first for the shell so a redeploy is picked up promptly, with the
  // cache as the offline fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
  );
});

/* ------------------------------------------------------------------ push */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }

  const title = data.title || 'Garage';
  const options = {
    body: data.body || "Couldn't confirm the garage is closed — check it.",
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.state === 'registered' ? 'sesame-setup' : 'sesame-alert',
    renotify: true,
    // The whole point is to interrupt someone who is driving away.
    requireInteraction: data.state === 'unconfirmed',
    data: { url: data.url || './', state: data.state || '' },
  };
  if (data.image) options.image = data.image;

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
