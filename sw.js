const SHELL_CACHE = 'jw-shell-v288';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => n !== SHELL_CACHE)
          .map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

// 웹푸시: 지시 배정·개찰결과 알림 표시, 클릭 시 앱 포커스/열기
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || '종운 업무', {
    body: d.body || '',
    tag: d.tag || undefined,
    data: { url: d.url || './' },
    icon: './icon-192.png',
    badge: './icon-192.png'
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return clients.openWindow(url);
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 데이터 API는 항상 네트워크로만 (GitHub Contents API)
  if (url.hostname === 'api.github.com') {
    e.respondWith(fetch(e.request));
    return;
  }

  // HTML(내비게이션)은 네트워크 우선 → 배포 즉시 반영. 오프라인이면 캐시 폴백.
  const isHtml = e.request.mode === 'navigate' ||
    url.pathname === '/' || url.pathname.endsWith('/index.html');
  if (isHtml) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html').then((c) => c || caches.match('./')))
    );
    return;
  }

  // 그 외 셸 자산은 cache-first
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
