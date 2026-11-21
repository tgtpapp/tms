import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './lib/theme';
import { initPwa } from './lib/pwa';
import { installErrorLog } from './lib/support';
import './lib/push';   // gửi thông báo đẩy đang chờ sau mỗi thao tác bán vé, xếp chuyến…
import '@flaticon/flaticon-uicons/css/regular/rounded.css';   // bộ biểu tượng Uicons (Flaticon) – kiểu Regular Rounded
import './styles.css';
initPwa();
installErrorLog();   // nhớ các lỗi gần nhất trên máy để gửi kèm khi báo sự cố

initTheme();   // áp giao diện đã chọn trước khi vẽ (không nháy màu)

const root = document.getElementById('root');
if (!root) throw new Error('Không tìm thấy phần tử #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Báo có bản mới: so tệp chạy chính của trang đang mở với bản đang đăng (mỗi 2 phút và khi quay lại tab)
if (import.meta.env.PROD) {
  const mine = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src');
  let shown = false;
  const check = async () => {
    if (shown || !mine || !navigator.onLine) return;
    try {
      const html = await (await fetch('/', { cache: 'no-store' })).text();
      const live = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+)"/.exec(html)?.[1];
      if (!live || live === mine) return;
      shown = true;
      const bar = document.createElement('div');
      bar.className = 'update-bar';
      bar.innerHTML = 'Đã có bản cập nhật mới. <button type="button">Tải lại</button>';
      bar.querySelector('button')?.addEventListener('click', () => window.location.reload());
      document.body.appendChild(bar);
    } catch { /* mất mạng: thử lần sau */ }
  };
  setInterval(() => void check(), 120000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check(); });
}

// Khung ứng dụng dùng được khi mất mạng (chỉ bản đăng thật)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
