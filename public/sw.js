const VERSION = 'tabterm-v31-network-first-shell';

// Precache for offline first-load. App-shell entries (HTML/JS/CSS) are also
// served network-first at runtime (see NETWORK_FIRST), so the copies here are
// only a fallback when the network is unavailable.
const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/addon-fit.js',
  '/vendor/split.min.js',
  // Peer review Y13: explicitly precache the 5 apple-touch-startup-image PNGs.
  // The HTML <link> tags request them on first PWA launch from the home-screen
  // icon, and the device may be offline at that moment. ~60KB total, acceptable.
  '/splash/iphone-se-2g-1334x750.png',
  '/splash/iphone-11-1792x828.png',
  '/splash/iphone-x-2436x1125.png',
  '/splash/iphone-13-2532x1170.png',
  '/splash/iphone-13-pro-max-2778x1284.png',
];

// App-shell assets that change whenever we ship code. Served network-first so a
// plain reload always picks up the latest build — no SW-reinstall / VERSION-bump
// dance required. Everything else (vendor libs, splash PNGs) stays cache-first.
const NETWORK_FIRST = new Set(['/', '/index.html', '/app.js', '/styles.css']);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: prefer fresh network response, fall back to cache (then the
// shell document) when offline. Always resolves to a Response.
function networkFirst(request) {
  return fetch(request)
    .then((r) => {
      if (r && r.status === 200 && r.type === 'basic') {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
      }
      return r;
    })
    .catch(() =>
      caches
        .match(request)
        .then((hit) => hit || caches.match('/index.html'))
        .then((res) => res || Response.error())
    );
}

// Cache-first: serve cached copy if present, otherwise fetch and cache it.
function cacheFirst(request) {
  return caches.match(request).then((hit) =>
    hit ||
    fetch(request)
      .then((r) => {
        if (!r || r.status !== 200 || r.type !== 'basic') return r;
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(request, copy)).catch(() => {});
        return r;
      })
      .catch(() => hit || Response.error())
  );
}

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  // Navigations (address-bar / PWA launch) and listed shell assets → network-first.
  const isShell = e.request.mode === 'navigate' || NETWORK_FIRST.has(url.pathname);
  e.respondWith(isShell ? networkFirst(e.request) : cacheFirst(e.request));
});
