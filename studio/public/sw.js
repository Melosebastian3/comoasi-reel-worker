const CACHE_NAME = 'como-asi-mobile-v4';
const APP_SHELL = ['./manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
const BLOCKED_MARKERS = ['app expired', 'currently unavailable'];

async function isSafeResponse(response) {
  if (!response || !response.ok) return false;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) return true;
  try {
    const body = (await response.clone().text()).toLowerCase();
    return !BLOCKED_MARKERS.some(marker => body.includes(marker));
  } catch {
    return false;
  }
}

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request, { cache: 'no-store' });
        if (await isSafeResponse(response)) return response;
        return response;
      } catch (error) {
        throw error;
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(async response => {
      if (await isSafeResponse(response)) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});
