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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    plugins: [react(), manifest(env.VITE_INSTALL_NAME || env.VITE_APP_NAME || 'TMS')],
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
