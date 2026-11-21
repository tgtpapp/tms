// Lưu khung ứng dụng để mở được khi mất mạng (bán vé ngoại tuyến).
// Trang: lấy mạng trước, mất mạng thì dùng bản đã lưu. Tệp /assets/* có mã băm: lưu một lần.
// Không lưu dữ liệu API (Supabase ở tên miền khác).
const CACHE = 'tms-khung-v2';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add('/')).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== 'tms-share').map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Ảnh chia sẻ từ Zalo / thư viện ảnh vào app (share_target): cất tạm rồi mở app, app tự lấy ra (lái xe báo đổ dầu / văn phòng tạo phiếu)
  if (req.method === 'POST' && url.origin === self.location.origin && url.searchParams.get('share') === '1') {
    e.respondWith((async () => {
      try {
        const fd = await req.formData(), fs = fd.getAll('images').filter((f) => f && typeof f !== 'string' && f.size), c = await caches.open('tms-share');
        for (const k of await c.keys()) await c.delete(k);
        let i = 0;
        for (const f of fs.slice(0, 8)) await c.put(`/__share/${i++}?n=${encodeURIComponent(f.name || 'anh.jpg')}`, new Response(f, { headers: { 'Content-Type': f.type || 'image/jpeg' } }));
      } catch { /* vẫn mở app, app báo không nhận được ảnh */ }
      return Response.redirect('/?share=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put('/', copy));
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
  }
});

// Thông báo đẩy (kể cả khi đóng app): hiện lên màn hình, bấm vào mở app
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Thông báo', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Thông báo', {
    body: d.body || '', tag: d.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' }, renotify: !!d.tag,
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    const w = ws.find((x) => new URL(x.url).origin === self.location.origin);
    if (w) { w.postMessage({ type: 'mo-thong-bao' }); return w.focus(); }
    return self.clients.openWindow(url + (url.includes('?') ? '&' : '?') + 'thong-bao=1');
  }));
});
