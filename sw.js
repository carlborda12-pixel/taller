// Repuestos Core OS · service worker: permite instalar la app y abrirla sin internet.
// Cambiá VERSION en cada publicación para que todos los equipos reciban la versión nueva.
const VERSION = 'rcos-2.1.0';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
  '/icons/maskable-192.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];
const EXT = VERSION + '-ext';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('rcos-') && k !== VERSION && k !== EXT).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
const timeout = (p, ms) => Promise.race([p, new Promise((_, ko) => setTimeout(() => ko(new Error('timeout')), ms))]);

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // los datos siempre van a la red

  // La pantalla del sistema: primero la red (para tener siempre la última versión); sin internet, la guardada.
  if (req.mode === 'navigate') {
    e.respondWith(timeout(fetch(req), 4000)
      .then(r => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then(c => c.put('/index.html', cp)); } return r; })
      .catch(() => caches.match('/index.html').then(r => r || caches.match('/'))));
    return;
  }
  // Íconos y archivos propios: de la caché, y se actualizan por detrás.
  if (url.origin === location.origin) {
    e.respondWith(caches.open(VERSION).then(c => c.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
    return;
  }
  // Tipografías y el lector de Excel: se guardan la primera vez que se usan.
  if (/(^|\.)fonts\.(googleapis|gstatic)\.com$|(^|\.)cdnjs\.cloudflare\.com$/.test(url.hostname)) {
    e.respondWith(caches.open(EXT).then(c => c.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok || r.type === 'opaque') c.put(req, r.clone());
      return r;
    }))));
  }
});
