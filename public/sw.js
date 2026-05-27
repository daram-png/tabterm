const VERSION = 'tabterm-v26-mobile-shell-phase2';
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

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => {
      if (!r || r.status !== 200 || r.type !== 'basic') return r;
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
      return r;
    }).catch(() => hit || Response.error()))
  );
});
