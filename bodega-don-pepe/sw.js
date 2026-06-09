// sw.js — Bodega Don Pepe PWA Service Worker
const CACHE = 'bodega-v7';
const ASSETS = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Elimina TODOS los caches anteriores
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Nunca cachear llamadas a la API ni recursos externos ni el panel admin
  if (e.request.method !== 'GET') return;
  if (url.includes('/api/')) return;
  if (url.includes('/.netlify/functions/')) return;
  if (url.includes('supabase.co')) return;
  if (url.includes('unpkg.com')) return;
  if (url.includes('openfoodfacts')) return;
  if (url.includes('/admin')) return;

  // Para assets estáticos: cache primero, refresca en background
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(res => {
        if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
