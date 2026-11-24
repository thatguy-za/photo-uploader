const SHELL = 'shell-v2';
const SHARED = 'shared';
const ASSETS = ['/', '/app.js', '/style.css', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== SHARED).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Android share sheet -> POST /share-target. Stash the files, then open the app to pick a folder.
async function handleShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('media').filter((f) => f instanceof File);
    await caches.delete(SHARED);
    const cache = await caches.open(SHARED);
    await Promise.all(files.map((f, i) => cache.put(
      `/shared/${i}`,
      new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) } })
    )));
    return Response.redirect(`/?shared=${files.length}`, 303);
  } catch {
    return Response.redirect('/', 303);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith(handleShare(req));
    return;
  }
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/files/') || url.pathname === '/healthz') return;
  // Network first, fall back to the cached shell so the app opens offline.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic' && !url.search) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('/')))
  );
});
