import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

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
