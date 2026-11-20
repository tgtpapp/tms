// Ảnh chia sẻ vào app từ Zalo / thư viện ảnh (Chia sẻ → app, như app cũ). Service worker nhận ảnh (POST /?share=1),
// cất tạm vào bộ nhớ đệm "tms-share" rồi mở app; app lấy ảnh ra (lấy xong thì xóa).
export const hasShare = () => /[?&]share=1\b/.test(window.location.search);

export async function takeSharedFiles(): Promise<File[]> {
  try { window.history.replaceState(null, '', window.location.pathname); } catch { /* bỏ qua */ }
  const out: File[] = [];
  try {
    const c = await caches.open('tms-share');
    for (const k of await c.keys()) {
      const r = await c.match(k);
      if (r) {
        const b = await r.blob(), n = decodeURIComponent(new URL(k.url).searchParams.get('n') ?? 'anh.jpg');
        out.push(new File([b], n, { type: b.type || 'image/jpeg' }));
      }
      await c.delete(k);
    }
  } catch { /* trình duyệt không có bộ nhớ đệm */ }
  return out;
}
