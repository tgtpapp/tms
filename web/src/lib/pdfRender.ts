// Vẽ trang PDF thành ảnh bằng pdf.js (Mozilla) — xem được mọi PDF (chữ lẫn scan) trên mọi máy, kể cả Android.
// Thư viện chỉ tải khi cần xem PDF (import động), không làm nặng lúc mở app.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
let lib: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = import('pdfjs-dist/legacy/build/pdf.mjs').then((m) => { m.GlobalWorkerOptions.workerSrc = workerUrl; return m; });
    lib.catch(() => { lib = null; });
  }
  return lib;
}

export interface PdfDoc { pages: number; render: (n: number, width: number) => Promise<string>; close: () => void }

/** Mở PDF từ dữ liệu; render(n, rộng px) trả ảnh JPEG (data URL) của trang n (bắt đầu từ 1). */
export async function openPdf(bytes: Uint8Array): Promise<PdfDoc> {
  const m = await pdfjs();
  const doc = await m.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  return {
    pages: doc.numPages,
    render: async (n, width) => {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(3, width / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport: vp } as Parameters<typeof page.render>[0]).promise;
      page.cleanup();
      const url = canvas.toDataURL('image/jpeg', 0.85);
      canvas.width = 0; canvas.height = 0;
      return url;
    },
    close: () => { void doc.destroy(); },
  };
}

/** Ảnh nhỏ trang đầu + số trang (dùng cho ô xem trước) */
export async function pdfThumb(bytes: Uint8Array, width = 360): Promise<{ thumb: string; pages: number }> {
  const d = await openPdf(bytes);
  try { return { thumb: await d.render(1, width), pages: d.pages }; } finally { d.close(); }
}

/** Ảnh tất cả các trang (tối đa max trang) để xem lớn */
export async function pdfAllPages(bytes: Uint8Array, width = 1200, max = 40): Promise<string[]> {
  const d = await openPdf(bytes);
  try {
    const out: string[] = [];
    for (let i = 1; i <= Math.min(d.pages, max); i++) out.push(await d.render(i, width));
    return out;
  } finally { d.close(); }
}
