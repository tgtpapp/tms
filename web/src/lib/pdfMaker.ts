// Tạo PDF không cần thư viện (như app cũ): mỗi trang HTML → ảnh (SVG foreignObject) → JPEG → ghép vào PDF A4.
// HTML trang phải tự chứa kiểu (style inline), ảnh phải là data URL.

export interface PdfPage { w: number; h: number; d: Uint8Array; land: boolean }
const PAD = Math.round((12 / 25.4) * 96);   // lề 12 mm

/** Kích thước vùng nội dung (px) của 1 trang A4 dọc / ngang. */
export const pageBox = (land: boolean) => ({ w: (land ? 1123 : 794) - PAD * 2, h: (land ? 794 : 1123) - PAD * 2 });

/** Đo chiều cao nội dung khi đặt trong khung rộng w (px). */
function measure(html: string, w: number): number {
  const box = document.createElement('div');
  box.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;visibility:hidden;font-family:'Times New Roman',serif`;
  box.innerHTML = html;
  document.body.appendChild(box);
  const h = box.scrollHeight;
  box.remove();
  return h;
}

export async function pageImg(html: string, land: boolean, scale = 1.4): Promise<PdfPage> {
  const W = land ? 1123 : 794, H = land ? 794 : 1123, { w, h } = pageBox(land);
  const real = measure(html, w);
  const k = real > h ? h / real : 1;                // nội dung dài hơn trang: thu nhỏ cho vừa 1 trang
  const inner = `<div style="width:${w / k}px;transform:scale(${k});transform-origin:0 0;font-family:'Times New Roman',serif;color:#000">${html}</div>`;
  const wrap = document.createElement('div');
  wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrap.style.cssText = `width:${W}px;height:${H}px;box-sizing:border-box;padding:${PAD}px;background:#fff;overflow:hidden`;
  wrap.innerHTML = inner;
  const xml = new XMLSerializer().serializeToString(wrap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%">${xml}</foreignObject></svg>`;
  const img = new Image();
  await new Promise<void>((ok, no) => {
    img.onload = () => ok();
    img.onerror = () => no(new Error('Không dựng được trang PDF'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const c = document.createElement('canvas');
  c.width = Math.round(W * scale);
  c.height = Math.round(H * scale);
  const g = c.getContext('2d');
  if (!g) throw new Error('Trình duyệt không vẽ được trang PDF');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.78));
  if (!blob) throw new Error('Không tạo được ảnh trang PDF');
  return { w: c.width, h: c.height, d: new Uint8Array(await blob.arrayBuffer()), land };
}

export function makePdf(pages: PdfPage[]): Uint8Array {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], off: number[] = [];
  let len = 0;
  const put = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n: number, body: string) => { off[n] = len; put(`${n} 0 obj\n${body}\nendobj\n`); };
  const N = pages.length;
  put('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${N} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
  pages.forEach((p, i) => {
    const pw = p.land ? 841.89 : 595.28, ph = p.land ? 595.28 : 841.89, pg = 3 + i * 3, ct = pg + 1, im = pg + 2;
    const c = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
    obj(ct, `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    off[im] = len;
    put(`${im} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.d.length} >>\nstream\n`);
    put(p.d);
    put('\nendstream\nendobj\n');
  });
  const total = 3 + N * 3, xr = len;
  let t = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) t += `${String(off[i]).padStart(10, '0')} 00000 n \n`;
  put(`${t}trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.length; }
  return out;
}

export function bytesToBase64(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Tải ảnh (link có hạn) về thành data URL để vẽ được vào PDF; lỗi thì trả null. */
export async function toDataUrl(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const b = await r.blob();
    return await new Promise((ok) => { const f = new FileReader(); f.onload = () => ok(String(f.result)); f.onerror = () => ok(null); f.readAsDataURL(b); });
  } catch {
    return null;
  }
}

/** Chia các khối HTML thành các trang A4 (đo chiều cao thật), dùng cho văn bản dài như hợp đồng. Khối dài hơn 1 trang đứng riêng 1 trang. */
export function paginate(blocks: string[], land = false): string[] {
  const { w, h } = pageBox(land);
  const limit = h * 0.96;
  const pages: string[] = [];
  let cur: string[] = [], used = 0;
  for (const b of blocks) {
    const bh = measure(`<div style="display:flow-root">${b}</div>`, w);
    if (cur.length && used + bh > limit) { pages.push(cur.join('')); cur = []; used = 0; }
    cur.push(`<div style="display:flow-root">${b}</div>`);
    used += bh;
  }
  if (cur.length) pages.push(cur.join(''));
  return pages;
}
