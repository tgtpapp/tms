// Phần thuần của hàm app-install (kiểm thử được không cần máy chủ)
/** Chỉ nhận địa chỉ app https (hoặc máy thử 127.0.0.1 / localhost) */
export function safeOrigin(v: string | null): string | null {
  try {
    const u = new URL(v ?? '');
    if (u.protocol === 'https:' || ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:')) return u.origin;
  } catch { /* sai dạng */ }
  return null;
}

export function manifestOf(origin: string, name: string, self: string, t: string, s: string, v: string) {
  const short = name.replace(/^\s*nhà\s*xe\s+/i, '').trim().slice(0, 24) || name;
  const icon = (z: number, mask = false) => `${self}?t=${t}&s=${s}&z=${z}${mask ? '&mask=1' : ''}${v ? `&v=${encodeURIComponent(v)}` : ''}&k=2`;   // k: đổi khi đổi cách vẽ biểu tượng để máy lấy lại
  return {
    name, short_name: short, id: `${origin}/`, start_url: `${origin}/`, scope: `${origin}/`, display: 'standalone', lang: 'vi',
    background_color: '#13508a', theme_color: '#13508a',
    icons: [{ src: icon(192), sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: icon(512), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: icon(512, true), sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
    share_target: { action: `${origin}/?share=1`, method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', files: [{ name: 'images', accept: ['image/*'] }] } },
  };
}

