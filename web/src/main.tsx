import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { LenhUpload } from './screens/LenhUpload';
import { initTheme } from './lib/theme';
import { initPwa } from './lib/pwa';
import { installErrorLog } from './lib/support';
import { newVersionAvailable } from './lib/version';
import './lib/push';   // gửi thông báo đẩy đang chờ sau mỗi thao tác bán vé, xếp chuyến…
import '@flaticon/flaticon-uicons/css/regular/rounded.css';   // bộ biểu tượng Uicons (Flaticon) – kiểu Regular Rounded
import './styles.css';
initPwa();
installErrorLog();   // nhớ các lỗi gần nhất trên máy để gửi kèm khi báo sự cố

initTheme();   // áp giao diện đã chọn trước khi vẽ (không nháy màu)

// Quét mã QR trên lệnh vận chuyển (Zalo / camera): trang lưu lệnh đã đóng dấu, không cần đăng nhập
const lenhToken = new URLSearchParams(window.location.search).get('l');
const root = document.getElementById('root');
if (!root) throw new Error('Không tìm thấy phần tử #root');

createRoot(root).render(
  <StrictMode>
    {lenhToken ? <LenhUpload token={lenhToken} /> : <App />}
  </StrictMode>,
);

// Báo có bản mới: so tệp chạy chính của trang đang mở với bản đang đăng (mỗi 2 phút và khi quay lại tab)
if (import.meta.env.PROD) {
  let shown = false;
  const check = async () => {
    if (shown || !(await newVersionAvailable())) return;
    shown = true;
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.innerHTML = 'Đã có bản cập nhật mới. <button type="button">Tải lại</button>';
    bar.querySelector('button')?.addEventListener('click', () => window.location.reload());
    document.body.appendChild(bar);
  };
  setInterval(() => void check(), 120000);
  // App cài trên điện thoại (nhất là iPhone) mở lại từ nền KHÔNG tải lại trang → vẫn chạy bản cũ dù đã có bản sửa.
  // Quay lại app sau ≥ 30 giây, có bản mới và không đang mở hộp nhập / gõ dở → tự tải lại bản mới.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    void (async () => {
      const busy = !!document.querySelector('.modal-back') || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
      if (hiddenAt && Date.now() - hiddenAt >= 30000 && !busy && await newVersionAvailable()) { window.location.reload(); return; }
      void check();
    })();
  });
}

// Khung ứng dụng dùng được khi mất mạng (chỉ bản đăng thật)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
