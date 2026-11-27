import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** Tệp cài app (PWA): tên app lấy từ cấu hình VITE_APP_NAME; nhận ảnh chia sẻ từ Zalo / thư viện ảnh (share_target). */
function manifest(name: string): Plugin {
  const short = name.replace(/^\s*nhà\s*xe\s+/i, '').trim() || name;
  const body = JSON.stringify({
    name, short_name: short, id: '/', start_url: '/', scope: '/', display: 'standalone', lang: 'vi',
    background_color: '#13508a', theme_color: '#13508a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    share_target: { action: '/?share=1', method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', files: [{ name: 'images', accept: ['image/*'] }] } },
  }, null, 2);
  return {
    name: 'tms-manifest',
    configureServer(s) { s.middlewares.use('/manifest.webmanifest', (_q, r) => { r.setHeader('Content-Type', 'application/manifest+json'); r.end(body); }); },
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: body }); },
  };
}

/** Chính sách bảo mật nội dung (CSP) + header bảo mật: chỉ chạy mã của chính app, chỉ kết nối tới máy chủ Supabase của cấu hình,
 *  không cho trang khác nhúng app (chống lừa bấm), không đoán kiểu tệp. Địa chỉ máy chủ lấy từ VITE_SUPABASE_URL (không viết cứng). */
function security(supabaseUrl: string): Plugin {
  let sb = '';
  try { const u = new URL(supabaseUrl); sb = `${u.origin} ${u.origin.replace(/^http/, 'ws')}`; } catch { /* thiếu cấu hình: chỉ 'self' */ }
  // fonts.googleapis.com / fonts.gstatic.com: font chữ tự chọn trong Giao diện của tôi (Google Fonts)
  const csp = [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", `img-src 'self' data: blob: ${sb}`,
    "font-src 'self' data: https://fonts.gstatic.com", `connect-src 'self' data: blob: ${sb}`, `frame-src 'self' blob: ${sb}`, "worker-src 'self'", `manifest-src 'self' ${sb}`,
    `media-src 'self' blob: ${sb}`, "object-src 'none'", "base-uri 'self'", "form-action 'self'",
  ].join('; ');
  const headers = `/*
  Content-Security-Policy: ${csp}; frame-ancestors 'none'; upgrade-insecure-requests
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(self), microphone=(self), geolocation=(self), payment=(), usb=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Cross-Origin-Opener-Policy: same-origin
/sw.js
  Cache-Control: no-cache
/
  Cache-Control: no-cache
/index.html
  Cache-Control: no-cache
/tai-lai.js
  Cache-Control: no-cache
`;
  return {
    name: 'tms-security', apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
    generateBundle() { this.emitFile({ type: 'asset', fileName: '_headers', source: headers }); },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), manifest(env.VITE_INSTALL_NAME || env.VITE_APP_NAME || 'TMS'), security(env.VITE_SUPABASE_URL ?? '')],
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
