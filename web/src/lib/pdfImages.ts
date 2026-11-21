// Lấy ảnh từng trang trong PDF để xem ngay trong app (không cần thư viện):
// - ảnh JPEG (PDF scan, CamScanner…), ảnh nén Flate (PDF do app tạo: 4-bit có bảng màu; RGB / xám 8-bit).
// - bỏ dải chữ quảng cáo của app quét (vd "Được quét bằng CamScanner": ảnh rất dẹt) để ảnh đầu là trang giấy thật.
const enc = new TextDecoder('latin1');

interface Img { w: number; h: number; url: string }

/** Ảnh dải quảng cáo / logo nhỏ: rộng gấp ≥ 4 lần cao, hoặc quá nhỏ */
const isBanner = (w: number, h: number) => (w > 0 && h > 0 && (w / h >= 4 || (w < 120 && h < 120)));

let crcT: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!crcT) { crcT = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
async function pipe(data: Uint8Array, s: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const r = new Blob([data as BlobPart]).stream().pipeThrough(s as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(r).arrayBuffer());
}
const b64 = (u: Uint8Array) => { let s = ''; for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode(...u.subarray(k, k + 0x8000)); return btoa(s); };

/** Dựng PNG từ dữ liệu điểm ảnh (chưa có byte lọc dòng) */
async function png(raw: Uint8Array, w: number, h: number, bits: number, ctype: number, pal: Uint8Array | null): Promise<string> {
  const ch = ctype === 2 ? 3 : 1, rowB = Math.ceil((w * ch * bits) / 8), rows = new Uint8Array((rowB + 1) * h);
  for (let y = 0; y < h; y++) rows.set(raw.subarray(y * rowB, (y + 1) * rowB), y * (rowB + 1) + 1);
  const ih = new Uint8Array(13), v = new DataView(ih.buffer);
  v.setUint32(0, w); v.setUint32(4, h); ih[8] = bits; ih[9] = ctype;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih)];
  if (pal) parts.push(chunk('PLTE', pal));
  parts.push(chunk('IDAT', await pipe(rows, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array(0)));
  return `data:image/png;base64,${b64(new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer()))}`;
}

/** Ảnh các trang trong PDF (tối đa 40), theo thứ tự trong file */
export async function pdfImages(u: Uint8Array): Promise<string[]> {
  const text = enc.decode(u), out: Img[] = [];
  const re = /\/Subtype\s*\/Image/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 40) {
    // từ điển của đối tượng ảnh: từ "obj" gần nhất phía trước tới "stream"
    const start = text.lastIndexOf('obj', m.index), sAt = text.indexOf('stream', m.index);
    if (start < 0 || sAt < 0) continue;
    const dict = text.slice(start, sAt);
    if (/\/(ImageMask|SMask)\b\s*true/.test(dict)) continue;
    const num = (k: string) => Number(new RegExp(`/${k}\\s+(\\d+)`).exec(dict)?.[1] ?? 0);
    const w = num('Width'), h = num('Height'), bits = num('BitsPerComponent') || 8;
    let p = sAt + 6;
    if (text[p] === '\r') p++;
    if (text[p] === '\n') p++;
    // /Length có thể là tham chiếu ("/Length 12 0 R"): khi đó lấy tới "endstream"
    const lm = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict), len = lm && !lm[2] ? Number(lm[1]) : 0, endAt = text.indexOf('endstream', p);
    const data = u.subarray(p, len > 0 && p + len <= u.length && (endAt < 0 || p + len <= endAt) ? p + len : endAt > 0 ? endAt : u.length);
    re.lastIndex = endAt > 0 ? endAt : sAt + 6;
    if (isBanner(w, h)) continue;
    try {
      if (/\/DCTDecode/.test(dict)) {
        let e = data.length;
        while (e > 2 && data[e - 1] !== 0xd9) e--;
        out.push({ w, h, url: `data:image/jpeg;base64,${b64(data.subarray(0, e))}` });
      } else if (/\/FlateDecode/.test(dict) && !/\/Predictor/.test(dict) && w && h) {
        const raw = await pipe(data, new DecompressionStream('deflate'));
        const idx = /\/Indexed\s*\/DeviceRGB\s*(\d+)\s*<([0-9a-fA-F\s]+)>/.exec(dict);
        if (idx) {
          const hex = idx[2]!.replace(/\s/g, ''), pal = new Uint8Array(hex.length / 2);
          for (let i = 0; i < pal.length; i++) pal[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
          out.push({ w, h, url: await png(raw, w, h, bits, 3, pal) });
        } else if (/\/DeviceRGB/.test(dict) && bits === 8) out.push({ w, h, url: await png(raw, w, h, 8, 2, null) });
        else if (/\/DeviceGray/.test(dict) && (bits === 8 || bits === 1)) out.push({ w, h, url: await png(raw, w, h, bits, 0, null) });
      }
    } catch { /* ảnh không đọc được: bỏ qua */ }
  }
  return out.map((x) => x.url);
}
