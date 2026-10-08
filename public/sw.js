// 캐시 이름을 올리면 activate 단계에서 옛 캐시가 지워진다.
// 세 앱을 합치면서 / 가 카드뉴스 화면에서 탭 셸로 바뀌었으므로,
// 이미 설치해 둔 사람에게 옛 화면이 남지 않도록 v2 로 올렸다.
const CACHE = 'studio-v2';
const OFFLINE = ['/'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(OFFLINE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // API 요청은 캐시하지 않는다.
  if (e.request.url.includes('/api/')) return;
  // 네트워크를 먼저 쓰고, 끊겼을 때만 캐시로 떨어진다.
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
