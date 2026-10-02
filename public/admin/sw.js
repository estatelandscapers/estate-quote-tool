// Estate Landscapers — service worker.
//
// Deliberately NETWORK-FIRST for everything. The usual "cache-first for speed" pattern is
// exactly how installed web apps end up running a week-old build after every deploy, and
// this tool has already been bitten by stale JavaScript once. Here the network is always
// asked first; the cache is only used when the network fails (no signal on a site).
//
// /api/ is never cached at all. A cached quote total or lead list is worse than an error.

const VERSION = 'estate-v14';
const SHELL = ['/admin/', '/admin/index.html', '/admin/app.js', '/admin/styles.css',
  '/admin/login.html', '/admin/manifest.json', '/admin/icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // fonts etc. — leave to the browser
  if (url.pathname.startsWith('/api/')) return;        // live data only, never cached

  e.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && (url.pathname.startsWith('/admin/') || url.pathname === '/admin')) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(async () => {
      const hit = await caches.match(req);
      if (hit) return hit;
      // Navigating with no signal: show the app shell so the person gets a proper
      // "you're offline" state instead of a browser error page.
      if (req.mode === 'navigate') return caches.match('/admin/');
      return Response.error();
    })
  );
});

// ---- push notifications ----
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Estate Landscapers', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Estate Landscapers', {
    body: d.body || '', icon: '/admin/icons/icon-192.png', badge: '/admin/icons/icon-192.png',
    tag: d.tag || 'estate', renotify: true, data: { url: d.url || '/admin/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const w = list.find(c => 'focus' in c);
    if (w) { w.navigate(url); return w.focus(); }
    return self.clients.openWindow(url);
  }));
});
