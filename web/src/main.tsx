import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initTheme } from './lib/theme';
import '@flaticon/flaticon-uicons/css/regular/rounded.css';   // bộ biểu tượng Uicons (Flaticon) – kiểu Regular Rounded
import './styles.css';

initTheme();   // áp giao diện đã chọn trước khi vẽ (không nháy màu)

const root = document.getElementById('root');
if (!root) throw new Error('Không tìm thấy phần tử #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Khung ứng dụng dùng được khi mất mạng (chỉ bản đăng thật)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
