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
