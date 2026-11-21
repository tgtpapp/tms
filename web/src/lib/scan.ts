// Scan tài liệu (như app cũ, kiểu CamScanner): xử lý ảnh trên máy.
// - Tự nhận khung giấy: vùng sáng lớn nhất (ngưỡng Otsu) → 4 góc cực trị → tinh chỉnh theo mép giấy thật (dò từng cạnh, khớp đường thẳng).
// - Nắn phẳng phối cảnh (homography), làm rõ chữ: chia cho nền (khử bóng) → giấy trắng, mực đậm, giữ màu mực xanh / dấu đỏ → làm nét.
// - Xuất PDF A4 (ảnh giữ tỷ lệ, có lề, trang ngang khi ảnh ngang), JPG / PNG / WEBP.
// - Quy tắc lưu Lệnh vận chuyển / Hợp đồng vận chuyển vào Lưu trữ hồ sơ như app cũ.

export type Pt = [number, number];
export type Quad = [Pt, Pt, Pt, Pt];
export type Filter = 'magic' | 'color' | 'gray' | 'bw';
export const FILTERS: [Filter, string][] = [['magic', 'Tăng nét (khuyên dùng)'], ['color', 'Màu gốc'], ['gray', 'Xám'], ['bw', 'Đen trắng']];
export const MAX = 2400;

export function cv(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
const ctx2 = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;
export function fit(img: CanvasImageSource & { width: number; height: number }, max: number): HTMLCanvasElement {
  const k = Math.min(1, max / Math.max(img.width, img.height)), c = cv(img.width * k, img.height * k);
  ctx2(c).drawImage(img, 0, 0, c.width, c.height);
  return c;
}
/** Đọc ảnh (xoay đúng theo EXIF), thu về tối đa MAX px */
export async function loadImage(file: Blob): Promise<HTMLCanvasElement> {
  let img: ImageBitmap | HTMLImageElement;
  try {
    img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    img = await new Promise<HTMLImageElement>((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('Không đọc được ảnh')); i.src = url; });
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return fit(img, MAX);
}
export const fullQuad = (c: { width: number; height: number }): Quad => [[0, 0], [c.width, 0], [c.width, c.height], [0, c.height]];

/** Khung hợp lệ: 4 điểm, lồi, đủ lớn */
export function quadOk(Q: (Pt | null)[] | null, w: number, h: number): Q is Quad {
  if (!Q || Q.length !== 4 || Q.some((p) => !p || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return false;
  let a = 0, sg = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = Q[i]!, [x2, y2] = Q[(i + 1) % 4]!, [x3, y3] = Q[(i + 2) % 4]!, cr = (x2 - x1) * (y3 - y2) - (y2 - y1) * (x3 - x2);
    if (!sg) sg = Math.sign(cr); else if (Math.sign(cr) !== sg) return false;
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2 > w * h * 0.12;
}

/** Tự nhận khung giấy trên máy */
export function detect(src: HTMLCanvasElement): Quad {
  const q = detectRough(src);
  return src.width > 500 ? refine(src, q) : q;
}
function detectRough(src: HTMLCanvasElement): Quad {
  const s = fit(src, 360), w = s.width, h = s.height, d = ctx2(s).getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = d[i * 4]! * 0.299 + d[i * 4 + 1]! * 0.587 + d[i * 4 + 2]! * 0.114;
  const b = new Float32Array(w * h), R = 2;   // làm mờ nhẹ
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let t = 0, n = 0;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < w && yy < h) { t += g[yy * w + xx]!; n++; } }
    b[y * w + x] = t / n;
  }
  const hist = new Array<number>(256).fill(0);
  b.forEach((v) => { hist[v | 0]!++; });
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]!; if (!wB) continue;
    const wF = w * h - wB; if (!wF) break;
    sB += i * hist[i]!;
    const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = i; }
  }
  const lab = new Int32Array(w * h).fill(-1), q = new Int32Array(w * h);
  let bestN = 0, bestL = -1, L = 0;
  for (let p0 = 0; p0 < w * h; p0++) {
    if (lab[p0]! >= 0 || b[p0]! <= th) continue;
    let qh = 0, qt = 0, n = 0;
    q[qt++] = p0; lab[p0] = L;
    while (qh < qt) {
      const p = q[qh++]!; n++;
      const x = p % w, y = (p / w) | 0;
      for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as Pt[]) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const pp = yy * w + xx;
        if (lab[pp]! < 0 && b[pp]! > th) { lab[pp] = L; q[qt++] = pp; }
      }
    }
    if (n > bestN) { bestN = n; bestL = L; }
    L++;
  }
  const k = src.width / w, at = (x: number, y: number): Pt => [x * k, y * k];
  if (bestL < 0 || bestN < w * h * 0.12 || bestN > w * h * 0.97) {
    const m = 0.03;
    return [at(w * m, h * m), at(w * (1 - m), h * m), at(w * (1 - m), h * (1 - m)), at(w * m, h * (1 - m))];
  }
  let tl = [0, 0, 1e9], tr = [0, 0, -1e9], br = [0, 0, -1e9], bl = [0, 0, 1e9];
  for (let p = 0; p < w * h; p++) {
    if (lab[p] !== bestL) continue;
    const x = p % w, y = (p / w) | 0, s1 = x + y, s2 = x - y;
    if (s1 < tl[2]!) tl = [x, y, s1];
    if (s1 > br[2]!) br = [x, y, s1];
    if (s2 > tr[2]!) tr = [x, y, s2];
    if (s2 < bl[2]!) bl = [x, y, s2];
  }
  const Q = [at(tl[0]!, tl[1]!), at(tr[0]!, tr[1]!), at(br[0]!, br[1]!), at(bl[0]!, bl[1]!)];
  const cx = Q.reduce((a, p) => a + p[0], 0) / 4, cy = Q.reduce((a, p) => a + p[1], 0) / 4;
  return Q.map(([x, y]) => [x + (cx - x) * 0.012, y + (cy - y) * 0.012]) as Quad;   // thu vào chút xíu để không dính mép bàn
}

/** Tinh chỉnh khung theo mép giấy thật: dò dọc từng cạnh chỗ đổi từ giấy sáng sang nền tối, khớp đường thẳng (bỏ điểm nhiễu), lấy giao điểm. */
export function refine(src: HTMLCanvasElement, Q: Quad): Quad {
  try {
    const s = fit(src, 900), w = s.width, h = s.height, k = src.width / w, d = ctx2(s).getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = d[i * 4]! * 0.299 + d[i * 4 + 1]! * 0.587 + d[i * 4 + 2]! * 0.114;
    const at = (x: number, y: number) => { x = Math.round(x); y = Math.round(y); return x < 0 || y < 0 || x >= w || y >= h ? NaN : g[y * w + x]!; };
    const P = Q.map(([x, y]) => [x / k, y / k] as Pt), cx = P.reduce((a, p) => a + p[0], 0) / 4, cy = P.reduce((a, p) => a + p[1], 0) / 4;
    const R = Math.round(Math.min(w, h) * 0.09), WIN = Math.max(4, Math.round(Math.min(w, h) * 0.012));
    type Line = { ax: number; ay: number; ux: number; uy: number };
    const lines: (Line | null)[] = [];
    for (let e = 0; e < 4; e++) {
      const A = P[e]!, B = P[(e + 1) % 4]!, dx = B[0] - A[0], dy = B[1] - A[1], Ln = Math.hypot(dx, dy) || 1;
      let nx = -dy / Ln, ny = dx / Ln;
      const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
      if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }   // pháp tuyến hướng ra ngoài
      const pts: Pt[] = [];
      for (let t = 0.06; t <= 0.94; t += 0.02) {
        const px = A[0] + dx * t, py = A[1] + dy * t;
        let best = 0, bd: number | null = null;
        for (let o = -R; o <= R; o++) {
          let si = 0, so = 0, ni = 0, no = 0;
          for (let j = 1; j <= WIN; j++) {
            const vi = at(px + nx * (o - j - 1), py + ny * (o - j - 1)), vo = at(px + nx * (o + j + 1), py + ny * (o + j + 1));
            if (!Number.isNaN(vi)) { si += vi; ni++; }
            if (!Number.isNaN(vo)) { so += vo; no++; }
          }
          if (ni < WIN * 0.8 || no < WIN * 0.8) continue;
          const sc = si / ni - so / no;
          if (sc > best) { best = sc; bd = o; }
        }
        if (bd !== null && best > 14) pts.push([px + nx * bd, py + ny * bd]);
      }
      if (pts.length < 10) { lines.push(null); continue; }
      let use = pts, ln: Line | null = null;
      for (let it = 0; it < 3; it++) {
        const n = use.length, ax = use.reduce((a, p) => a + p[0], 0) / n, ay = use.reduce((a, p) => a + p[1], 0) / n;
        let sxx = 0, sxy = 0, syy = 0;
        for (const [x, y] of use) { sxx += (x - ax) ** 2; sxy += (x - ax) * (y - ay); syy += (y - ay) ** 2; }
        const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
        ln = { ax, ay, ux, uy };
        const res = use.map(([x, y]) => Math.abs(-(x - ax) * uy + (y - ay) * ux)), med = res.slice().sort((a, b) => a - b)[res.length >> 1] ?? 0;
        const nu = use.filter((_, i) => res[i]! <= Math.max(1.5, med * 2.5));
        if (nu.length < 8 || nu.length === use.length) break;
        use = nu;
      }
      lines.push(use.length >= pts.length * 0.45 ? ln : null);
    }
    const lineOf = (e: number): Line => lines[e] ?? (() => { const A = P[e]!, B = P[(e + 1) % 4]!, Ln = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1; return { ax: A[0], ay: A[1], ux: (B[0] - A[0]) / Ln, uy: (B[1] - A[1]) / Ln }; })();
    const X = (a: Line, b: Line): Pt | null => {
      const den = a.ux * b.uy - a.uy * b.ux;
      if (Math.abs(den) < 1e-6) return null;
      const t = ((b.ax - a.ax) * b.uy - (b.ay - a.ay) * b.ux) / den;
      return [a.ax + a.ux * t, a.ay + a.uy * t];
    };
    const N = [0, 1, 2, 3].map((i) => X(lineOf((i + 3) % 4), lineOf(i)));   // góc i = giao cạnh (i-1) và cạnh i
    if (N.some((p) => !p)) return Q;
    const out = (N as Pt[]).map(([x, y]) => [Math.max(-w * 0.02, Math.min(w * 1.02, x)) * k, Math.max(-h * 0.02, Math.min(h * 1.02, y)) * k])
      .map(([x, y]) => [Math.max(0, Math.min(src.width, x!)), Math.max(0, Math.min(src.height, y!))] as Pt) as Quad;
    const moved = Math.max(...out.map((p, i) => Math.hypot(p[0] - Q[i]![0], p[1] - Q[i]![1])));
    return quadOk(out, src.width, src.height) && moved < Math.max(src.width, src.height) * 0.2 ? out : Q;
  } catch {
    return Q;
  }
}

/* ---------- nắn phẳng phối cảnh ---------- */
function homo(W: number, H: number, Q: Quad): number[] {
  const S: Pt[] = [[0, 0], [W, 0], [W, H], [0, H]], A: number[][] = [], B: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = S[i]!, [x, y] = Q[i]!;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!]; [B[c], B[p]] = [B[p]!, B[c]!];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / A[c]![c]!;
      for (let k = c; k < 8; k++) A[r]![k]! -= f * A[c]![k]!;
      B[r]! -= f * B[c]!;
    }
  }
  return B.map((v, i) => v / A[i]![i]!);
}
export function warp(src: HTMLCanvasElement, Q: Quad, max: number): HTMLCanvasElement {
  const dd = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(dd(Q[0], Q[1]), dd(Q[3], Q[2])), H = Math.max(dd(Q[0], Q[3]), dd(Q[1], Q[2]));
  const k = Math.min(1, max / Math.max(W, H));
  W = Math.max(1, Math.round(W * k)); H = Math.max(1, Math.round(H * k));
  const [a, b, c, d, e, f, g, h] = homo(W, H, Q) as [number, number, number, number, number, number, number, number];
  const sw = src.width, sh = src.height, sd = ctx2(src).getImageData(0, 0, sw, sh).data, out = cv(W, H), oc = ctx2(out), od = oc.createImageData(W, H), o = od.data;
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const z = g * u + h * v + 1, x = (a * u + b * v + c) / z, y = (d * u + e * v + f) / z, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, oi = (v * W + u) * 4;
    if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { o[oi] = o[oi + 1] = o[oi + 2] = 255; o[oi + 3] = 255; continue; }
    const i1 = (y0 * sw + x0) * 4, i2 = i1 + 4, i3 = i1 + sw * 4, i4 = i3 + 4;
    for (let ch = 0; ch < 3; ch++) o[oi + ch] = (sd[i1 + ch]! * (1 - fx) + sd[i2 + ch]! * fx) * (1 - fy) + (sd[i3 + ch]! * (1 - fx) + sd[i4 + ch]! * fx) * fy;
    o[oi + 3] = 255;
  }
  oc.putImageData(od, 0, 0);
  return out;
}

/* ---------- làm rõ chữ ---------- */
function background(c: HTMLCanvasElement) {   // ảnh nền mờ nhỏ (1/8) bằng tích phân
  const s = fit(c, Math.max(48, Math.max(c.width, c.height) / 8)), w = s.width, h = s.height, d = ctx2(s).getImageData(0, 0, w, h).data;
  const R = Math.max(2, Math.round(Math.max(w, h) / 14)), out = new Float32Array(w * h * 3);
  for (let ch = 0; ch < 3; ch++) {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += d[(y * w + x) * 4 + ch]!; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1]! + row; } }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - R), y1 = Math.max(0, y - R), x2 = Math.min(w, x + R + 1), y2 = Math.min(h, y + R + 1);
      out[(y * w + x) * 3 + ch] = (I[y2 * (w + 1) + x2]! - I[y1 * (w + 1) + x2]! - I[y2 * (w + 1) + x1]! + I[y1 * (w + 1) + x1]!) / ((x2 - x1) * (y2 - y1));
    }
  }
  return { w, h, v: out };
}
function sharpen(p: Uint8ClampedArray, W: number, H: number, a: number) {   // unsharp 3x3, bỏ qua giấy trắng
  const src = new Uint8ClampedArray(p);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = (y * W + x) * 4;
    if (src[i]! > 250 && src[i + 1]! > 250 && src[i + 2]! > 250) continue;
    for (let ch = 0; ch < 3; ch++) { const c0 = src[i + ch]!, m = (src[i - 4 + ch]! + src[i + 4 + ch]! + src[i - W * 4 + ch]! + src[i + W * 4 + ch]!) / 4; p[i + ch] = c0 + (c0 - m) * a * 2; }
  }
}
export function applyFilter(c: HTMLCanvasElement, mode: Filter): HTMLCanvasElement {
  if (mode === 'color') return c;
  const W = c.width, H = c.height, ctx = ctx2(c), id = ctx.getImageData(0, 0, W, H), p = id.data, B = background(c), sx = B.w / W, sy = B.h / H;
  const LO = 55, HI = 228, lv = (v: number) => { let t = (v - LO) / (HI - LO); t = t <= 0 ? 0 : t >= 1 ? 1 : t; return 255 * Math.pow(t, 1.5); };
  for (let y = 0; y < H; y++) {
    const by = Math.min(B.h - 1, (y * sy) | 0);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, bi = (by * B.w + Math.min(B.w - 1, (x * sx) | 0)) * 3, r = p[i]!, g = p[i + 1]!, bb = p[i + 2]!;
      const nr = Math.min(255, r / (B.v[bi] || 1) * 250), ng = Math.min(255, g / (B.v[bi + 1] || 1) * 250), nb = Math.min(255, bb / (B.v[bi + 2] || 1) * 250), l = nr * 0.299 + ng * 0.587 + nb * 0.114;
      if (mode === 'gray') { p[i] = p[i + 1] = p[i + 2] = lv(l); continue; }
      if (mode === 'bw') { p[i] = p[i + 1] = p[i + 2] = l < 175 ? 0 : 255; continue; }
      const L2 = lv(l), k = l > 1 ? L2 / l : 0, sat = 1.45;   // giữ sắc mực, tăng bão hòa
      let R = l + (nr - l) * sat, G = l + (ng - l) * sat, Bl = l + (nb - l) * sat;
      R *= k; G *= k; Bl *= k;
      if (L2 > 246) R = G = Bl = 255;
      p[i] = R; p[i + 1] = G; p[i + 2] = Bl;
    }
  }
  if (mode !== 'bw') sharpen(p, W, H, mode === 'gray' ? 0.8 : 1.0);
  ctx.putImageData(id, 0, 0);
  return c;
}

export interface Page { src: HTMLCanvasElement; q: Quad; f: Filter; pending?: boolean; touched?: boolean; ai?: boolean; thumb?: string | null }
/** Trang kết quả: nắn phẳng + làm rõ, cạnh dài tối đa max px */
export const render = (pg: Page, max: number) => applyFilter(warp(pg.src, pg.q, max), pg.f);
export function thumbOf(pg: Page): string {
  if (!pg.thumb) {
    const k = Math.min(1, 500 / Math.max(pg.src.width, pg.src.height));
    pg.thumb = render({ src: fit(pg.src, 500), q: pg.q.map(([x, y]) => [x * k, y * k]) as Quad, f: pg.f }, 220).toDataURL('image/jpeg', 0.8);
  }
  return pg.thumb;
}
/** Xoay 90°: phải (cw) hoặc trái; khung xoay theo */
export function rotate(pg: Page, cw = true): void {
  const s = pg.src, c = cv(s.height, s.width), x = ctx2(c);
  if (cw) { x.translate(c.width, 0); x.rotate(Math.PI / 2); } else { x.translate(0, c.height); x.rotate(-Math.PI / 2); }
  x.drawImage(s, 0, 0);
  const q = pg.q.map(([a, b]) => (cw ? [s.height - b, a] : [b, s.width - a]) as Pt);
  pg.src = c;
  pg.q = (cw ? [q[3], q[0], q[1], q[2]] : [q[1], q[2], q[3], q[0]]) as Quad;
  pg.thumb = null;
}

export const toBlob = (c: HTMLCanvasElement, type: string, q?: number) => new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('Không tạo được ảnh'))), type, q));

/** PDF A4: mỗi trang 1 ảnh JPEG giữ tỷ lệ, lề 18pt, trang ngang khi ảnh ngang */
export async function buildPdf(pages: Page[], max: number): Promise<Blob> {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], off: number[] = [];
  let len = 0;
  const put = (x: string | Uint8Array) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); len += b.length; };
  const obj = (n: number, body: string) => { off[n] = len; put(`${n} 0 obj\n${body}\nendobj\n`); };
  const imgs: { w: number; h: number; d: Uint8Array }[] = [];
  for (const pg of pages) {
    const c = render(pg, max);
    imgs.push({ w: c.width, h: c.height, d: new Uint8Array(await (await toBlob(c, 'image/jpeg', 0.85)).arrayBuffer()) });
  }
  const N = imgs.length;
  put('%PDF-1.4\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${N} /Kids [${imgs.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] >>`);
  imgs.forEach((p, i) => {
    const land = p.w > p.h, PW = land ? 841.89 : 595.28, PH = land ? 595.28 : 841.89, M = 18;
    const k = Math.min((PW - 2 * M) / p.w, (PH - 2 * M) / p.h), w = +(p.w * k).toFixed(2), h = +(p.h * k).toFixed(2), x = +((PW - w) / 2).toFixed(2), y = +((PH - h) / 2).toFixed(2);
    const pg = 3 + i * 3, ct = pg + 1, im = pg + 2, c = `q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q`;
    obj(pg, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PW} ${PH}] /Resources << /XObject << /Im0 ${im} 0 R >> >> /Contents ${ct} 0 R >>`);
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
  return new Blob([out], { type: 'application/pdf' });
}

export type Fmt = 'pdf' | 'jpg' | 'png' | 'webp';
export const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, '-').trim();
export async function buildFiles(pages: Page[], name: string, fmt: Fmt, max: number): Promise<{ blob: Blob; name: string; mime: string }[]> {
  const base = safeName(name) || 'Scan';
  if (fmt === 'pdf') return [{ blob: await buildPdf(pages, max), name: `${base}.pdf`, mime: 'application/pdf' }];
  const type = ({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const)[fmt], out = [];
  for (let i = 0; i < pages.length; i++) out.push({ blob: await toBlob(render(pages[i]!, max), type, 0.88), name: `${base}${pages.length > 1 ? ` - trang ${i + 1}` : ''}.${fmt}`, mime: type });
  return out;
}

/* ---------- quy tắc lưu hồ sơ (như app cũ) ---------- */
export interface DocRead {
  loai: string | null; tieu_de: string | null; so_van_ban: string | null; ngay: string | null; tom_tat: string | null; noi_dung: string | null;
  lenh_so: string | null; lenh_tu_ngay: string | null; lenh_den_ngay: string | null; lai_xe_1: string | null; lai_xe_2: string | null; bien_so: string | null;
  tuyen: string | null; ma_tuyen: string | null; ben_di: string | null; ben_ve: string | null; ngay_xuat: string | null;
}
export interface RouteRow { name: string; registered_code: string | null }
const isLenh = (v: DocRead) => /lệnh/i.test(v.loai ?? '');
const isHd = (v: DocRead) => /hợp đồng/i.test(v.loai ?? '');
export const ruleApplies = (v: DocRead) => isLenh(v) || isHd(v);
/** phần số của số lệnh (vd "Số: 26040714/LVC-CT" → "26040714"); không có dãy số thì giữ chữ đọc được */
export function soLenh(so: string): string {
  const t = so.trim(), m = t.match(/\d{4,}/);
  return m ? m[0] : safeName(t.replace(/^s[ốo]\s*[:.]?\s*/i, ''));
}
/** Tên tài liệu: Lệnh → <số>/LVC-<hậu tố lệnh của nhà xe> (vd 26070706/LVC-TGTP); khác → loại, số, biển số, ngày */
export function docName(v: DocRead, suffix: string): string {
  if (isLenh(v) && v.lenh_so) return `${soLenh(v.lenh_so)}${suffix ? `/LVC-${suffix}` : ''}`;
  const d = (v.lenh_tu_ngay ?? v.ngay ?? '').split('-').reverse().join('-');
  return safeName([v.loai || 'Tài liệu', v.lenh_so ?? v.so_van_ban, v.bien_so, d].filter(Boolean).join(' '));
}
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toUpperCase().replace(/\b(BX|B\.X|BEN XE)\.?\s*/g, '').replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const ends = (name: string) => name.split(/\s*(?:⇄|<>|->|→|–|-)\s*/).map((x) => x.trim()).filter(Boolean);
const clean = (t: string) => t.replace(/\b(BX|B\.X|Bến xe)\.?\s*/gi, '').replace(/\s*(?:⇄|<>|->|→|–|-)\s*/g, ' - ').replace(/\s+/g, ' ').trim();
/** Thư mục tuyến: ưu tiên mã tuyến, rồi 2 bến khớp tuyến trong app; dòng "Tuyến" (thường là tên tỉnh) dùng sau cùng */
export function routeFolder(v: DocRead, routes: RouteRow[]): string {
  const out = (r: RouteRow) => ends(r.name).map((x) => x.toUpperCase()).join(' - ');
  const dig = (x: string | null) => (x ?? '').replace(/\D/g, '');
  if (dig(v.ma_tuyen).length >= 4) { const m = routes.filter((r) => dig(r.registered_code) === dig(v.ma_tuyen)); if (m.length === 1) return out(m[0]!); }
  const B0 = [v.ben_di, v.ben_ve].filter((x): x is string => !!x), B = B0.map(norm);
  if (B.length) {
    const C = routes.map((r) => ({ r, e: ends(r.name).map(norm) }));
    const has = (c: { e: string[] }, b: string) => c.e.some((x) => x && b.includes(x));
    const m = C.filter((c) => c.e.length >= 2 && B.every((b) => has(c, b)) && c.e.every((x) => B.some((b) => b.includes(x))));
    if (m.length === 1) return out(m[0]!.r);
    const m2 = C.filter((c) => B.every((b) => has(c, b)));
    if (m2.length === 1) return out(m2[0]!.r);
    if (B0.length >= 2) return clean(B0.join(' - ')).toUpperCase();
  }
  const t = clean(v.tuyen ?? '');
  if (!t) return 'Chưa rõ tuyến';
  const m = routes.find((r) => norm(r.name) === norm(t) || norm(ends(r.name).reverse().join(' - ')) === norm(t));
  return m ? out(m) : t.toUpperCase();
}
/** Lệnh → Năm / 08. Điều hành xe / Lệnh vận chuyển / Tuyến / Tháng MM-YYYY; Hợp đồng → Năm / 08. Điều hành xe / Hợp đồng vận chuyển / Tháng MM-YYYY */
export function docPath(v: DocRead, routes: RouteRow[], today: string): string[] | null {
  const d = [v.lenh_tu_ngay, v.ngay_xuat, v.ngay].find((x) => /^\d{4}-\d{2}-\d{2}$/.test(x ?? '')) ?? today, y = d.slice(0, 4), mm = d.slice(5, 7);
  if (isLenh(v)) return [y, '08. Điều hành xe', 'Lệnh vận chuyển', routeFolder(v, routes), `Tháng ${mm}-${y}`];
  return isHd(v) ? [y, '08. Điều hành xe', 'Hợp đồng vận chuyển', `Tháng ${mm}-${y}`] : null;
}

/* ---------- bộ nhớ đệm trên máy (IndexedDB): tải lại trang không mất các trang đang scan ---------- */
let dbp: Promise<IDBDatabase | null> | null = null;
const idb = () => (dbp ??= new Promise((ok) => {
  try { const r = indexedDB.open('tms-scan', 1); r.onupgradeneeded = () => r.result.createObjectStore('p'); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); } catch { ok(null); }
}));
const blobCache = new WeakMap<HTMLCanvasElement, Blob>();
export async function persist(pages: Page[]): Promise<void> {
  const db = await idb(); if (!db) return;
  const rows = await Promise.all(pages.map(async (p) => {
    let b = blobCache.get(p.src);
    if (!b) { b = await toBlob(p.src, 'image/jpeg', 0.92); blobCache.set(p.src, b); }
    return { q: p.q, f: p.f, img: b };
  }));
  try { db.transaction('p', 'readwrite').objectStore('p').put(rows, 'pages'); } catch { /* bộ nhớ đầy: bỏ qua */ }
}
export async function restore(): Promise<Page[]> {
  const db = await idb(); if (!db) return [];
  const rows = await new Promise<{ q: Quad; f: Filter; img: Blob }[]>((ok) => {
    try { const r = db.transaction('p').objectStore('p').get('pages'); r.onsuccess = () => ok((r.result as { q: Quad; f: Filter; img: Blob }[]) ?? []); r.onerror = () => ok([]); } catch { ok([]); }
  });
  const out: Page[] = [];
  for (const r of rows) { try { const src = await loadImage(r.img); blobCache.set(src, r.img); out.push({ src, q: r.q, f: r.f }); } catch { /* bỏ trang hỏng */ } }
  return out;
}
