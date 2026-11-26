// Trang cũ (lưu tạm) trỏ tới tệp /assets/ đã bị thay ở bản mới → tệp không tải được → trắng trang.
// Gặp lỗi tải tệp chính: xóa bản lưu tạm + bộ nhớ đệm khung app rồi tải lại 1 lần (mỗi phiên).
(function () {
  addEventListener('error', function (e) {
    var t = e.target;
    if (!t || !(t.tagName === 'SCRIPT' || t.tagName === 'LINK')) return;
    var u = t.src || t.href || '';
    if (u.indexOf('/assets/') < 0) return;
    try { if (sessionStorage.getItem('tms.tai_lai_ban_moi')) return; sessionStorage.setItem('tms.tai_lai_ban_moi', '1'); } catch (_) { return; }
    var jobs = [];
    if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistrations().then(function (l) { return Promise.all(l.map(function (r) { return r.unregister(); })); }));
    if (window.caches) jobs.push(caches.keys().then(function (k) { return Promise.all(k.filter(function (n) { return n !== 'tms-share'; }).map(function (n) { return caches.delete(n); })); }));
    Promise.all(jobs).catch(function () {}).then(function () { location.reload(); });
  }, true);
})();
