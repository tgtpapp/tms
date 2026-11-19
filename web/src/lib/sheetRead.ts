// Đọc bảng tính: .xlsx, .xls đời cũ (Excel 97-2003 / BIFF8 – Skysoft và nhiều phần mềm VN xuất dạng này),
// .xls thực chất là HTML / XML Spreadsheet 2003, .csv. Chuyển từ bộ đọc của app cũ.
import readXlsxFile from 'read-excel-file';
import { textToRows } from './scheduleImport';

export type Cell = string | number | boolean | Date | null;

const END = 0xfffffffa;

function cfbStream(buf: ArrayBuffer, names: string[]): Uint8Array | null {
  const v = new DataView(buf), u = new Uint8Array(buf);
  const ss = 1 << v.getUint16(30, true), mss = 1 << v.getUint16(32, true), nFat = v.getUint32(44, true), dir0 = v.getUint32(48, true);
  const cut = v.getUint32(56, true), mf0 = v.getUint32(60, true), nDif = v.getUint32(72, true);
  let dif0 = v.getUint32(68, true);
  const off = (s: number) => (s + 1) * ss;
  const fatS: number[] = [];
  for (let i = 0; i < 109 && fatS.length < nFat; i++) fatS.push(v.getUint32(76 + i * 4, true));
  for (let k = 0; k < nDif && dif0 < END && fatS.length < nFat; k++) {
    const o = off(dif0);
    for (let i = 0; i < ss / 4 - 1 && fatS.length < nFat; i++) fatS.push(v.getUint32(o + i * 4, true));
    dif0 = v.getUint32(o + ss - 4, true);
  }
  const fat: number[] = [];
  for (const s of fatS) { const o = off(s); for (let i = 0; i < ss / 4; i++) fat.push(v.getUint32(o + i * 4, true)); }
  const chain = (s: number, f: number[]) => { const out: number[] = []; let g = 0; while (s < END && g++ < 1e6) { out.push(s); s = f[s]; } return out; };
  const big = (s: number, size: number) => {
    const r = new Uint8Array(size); let p = 0;
    for (const x of chain(s, fat)) { const n = Math.min(ss, size - p); if (n <= 0) break; r.set(u.subarray(off(x), off(x) + n), p); p += n; }
    return r;
  };
  const dirB = big(dir0, chain(dir0, fat).length * ss), dv = new DataView(dirB.buffer);
  const ents: { nm: string; t: number; s: number; size: number }[] = [];
  for (let o = 0; o + 128 <= dirB.length; o += 128) {
    const nl = dv.getUint16(o + 64, true); let nm = '';
    for (let i = 0; i < Math.max(0, nl / 2 - 1); i++) nm += String.fromCharCode(dv.getUint16(o + i * 2, true));
    ents.push({ nm, t: dirB[o + 66], s: dv.getUint32(o + 116, true), size: dv.getUint32(o + 120, true) });
  }
  const e = ents.find((x) => x.t === 2 && names.includes(x.nm));
  if (!e) return null;
  if (e.size >= cut) return big(e.s, e.size);
  const root = ents[0], ms = big(root.s, root.size), mfat: number[] = [];
  for (const s of chain(mf0, fat)) { const o = off(s); for (let i = 0; i < ss / 4; i++) mfat.push(v.getUint32(o + i * 4, true)); }
  const r = new Uint8Array(e.size); let p = 0;
  for (const x of chain(e.s, mfat)) { const n = Math.min(mss, e.size - p); if (n <= 0) break; r.set(ms.subarray(x * mss, x * mss + n), p); p += n; }
  return r;
}

function biffRows(wb: Uint8Array): Cell[][] {
  const v = new DataView(wb.buffer, wb.byteOffset, wb.byteLength), recs: { t: number; p: number; n: number }[] = [];
  for (let p = 0; p + 4 <= wb.length;) { const t = v.getUint16(p, true), n = v.getUint16(p + 2, true); recs.push({ t, p: p + 4, n }); p += 4 + n; }
  if (!recs.length || recs[0].t !== 0x0809) throw new Error('File .xls không đúng định dạng Excel');
  const b8 = v.getUint16(recs[0].p, true) === 0x0600;
  let cp = 1252;
  const dec8 = () => { try { return new TextDecoder(cp === 1200 ? 'utf-16le' : `windows-${cp}`); } catch { return new TextDecoder('windows-1252'); } };
  type St = { i: number; p: number };
  function rdStr(segs: Uint8Array[], st: St, lenBytes: number): string {
    const need = () => { while (st.p >= segs[st.i].length && st.i < segs.length - 1) { st.i++; st.p = 0; } return segs[st.i]; };
    const byte = () => need()[st.p++];
    const u16 = () => byte() | (byte() << 8), u32 = () => u16() + u16() * 65536;
    const cch = lenBytes === 1 ? byte() : u16(), fl = byte();
    let hi = fl & 1;
    const cr = fl & 8 ? u16() : 0, ce = fl & 4 ? u32() : 0;
    let s = '';
    for (let k = 0; k < cch;) {
      if (st.p >= segs[st.i].length) { if (st.i >= segs.length - 1) break; st.i++; st.p = 0; hi = segs[st.i][st.p++] & 1; }
      const g = segs[st.i];
      if (hi) { s += String.fromCharCode(g[st.p] | (g[st.p + 1] << 8)); st.p += 2; } else { s += String.fromCharCode(g[st.p]); st.p++; }
      k++;
    }
    let sk = cr * 4 + ce;
    while (sk > 0) { need(); const a = Math.min(sk, segs[st.i].length - st.p); if (a <= 0) break; st.p += a; sk -= a; }
    return s;
  }
  const sst: string[] = [], sheets: { at: number; hide: number; kind: number }[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.t === 0x0042) cp = v.getUint16(r.p, true);
    else if (r.t === 0x0085) sheets.push({ at: v.getUint32(r.p, true), hide: wb[r.p + 4] & 3, kind: wb[r.p + 5] });
    else if (r.t === 0x00fc) {
      const segs = [wb.subarray(r.p, r.p + r.n)];
      while (recs[i + 1] && recs[i + 1].t === 0x003c) { i++; segs.push(wb.subarray(recs[i].p, recs[i].p + recs[i].n)); }
      const n = v.getUint32(r.p + 4, true), st = { i: 0, p: 8 };
      for (let k = 0; k < n; k++) { if (st.i >= segs.length - 1 && st.p >= segs[st.i].length) break; sst.push(rdStr(segs, st, 2)); }
    }
  }
  const sh = sheets.find((s) => s.kind === 0 && s.hide === 0) ?? sheets.find((s) => s.kind === 0) ?? { at: 0 };
  const rk = (p: number) => {
    const x = v.getInt32(p, true); let n: number;
    if (x & 2) n = x >> 2;
    else { const b = new DataView(new ArrayBuffer(8)); b.setInt32(4, x & ~3, true); b.setInt32(0, 0, true); n = b.getFloat64(0, true); }
    return x & 1 ? n / 100 : n;
  };
  const rows: Cell[][] = [];
  const put = (r: number, c: number, val: Cell) => { (rows[r] ??= [])[c] = val; };
  let i0 = recs.findIndex((r) => r.p - 4 === sh.at);
  if (i0 < 0) i0 = recs.findIndex((r, k) => r.t === 0x0809 && k > 0);
  let fr: [number, number] | null = null;
  for (let i = i0 + 1; i < recs.length; i++) {
    const r = recs[i], p = r.p;
    if (r.t === 0x000a) break;
    if (r.t === 0x00fd) put(v.getUint16(p, true), v.getUint16(p + 2, true), sst[v.getUint32(p + 6, true)] ?? '');
    else if (r.t === 0x0203) put(v.getUint16(p, true), v.getUint16(p + 2, true), v.getFloat64(p + 6, true));
    else if (r.t === 0x027e) put(v.getUint16(p, true), v.getUint16(p + 2, true), rk(p + 6));
    else if (r.t === 0x00bd) { const row = v.getUint16(p, true), c0 = v.getUint16(p + 2, true), n = (r.n - 6) / 6; for (let k = 0; k < n; k++) put(row, c0 + k, rk(p + 4 + k * 6 + 2)); }
    else if (r.t === 0x0204 || r.t === 0x00d6) {
      const row = v.getUint16(p, true), c = v.getUint16(p + 2, true), n = v.getUint16(p + 6, true);
      put(row, c, b8 ? rdStr([wb.subarray(p + 6, p + r.n)], { i: 0, p: 0 }, 2) : dec8().decode(wb.subarray(p + 8, p + 8 + n)));
    }
    else if (r.t === 0x0205) { const row = v.getUint16(p, true), c = v.getUint16(p + 2, true); put(row, c, wb[p + 7] ? '' : !!wb[p + 6]); }
    else if (r.t === 0x0006) {
      const row = v.getUint16(p, true), c = v.getUint16(p + 2, true);
      if (v.getUint16(p + 12, true) !== 0xffff) put(row, c, v.getFloat64(p + 6, true));
      else { const k = wb[p + 6]; if (k === 0) fr = [row, c]; else if (k === 1) put(row, c, !!wb[p + 8]); else put(row, c, ''); }
    }
    else if (r.t === 0x0207 && fr) { put(fr[0], fr[1], rdStr([wb.subarray(p, p + r.n)], { i: 0, p: 0 }, 2)); fr = null; }
  }
  return Array.from(rows, (x) => Array.from(x ?? [], (y) => y ?? ''));
}

/** .xls dạng HTML (bảng) hoặc XML Spreadsheet 2003. */
export function htmlRows(t: string): Cell[][] {
  const xml = /<Workbook[^>]*urn:schemas-microsoft-com:office:spreadsheet/i.test(t);
  const doc = new DOMParser().parseFromString(t, xml ? 'application/xml' : 'text/html');
  const ws = doc.getElementsByTagNameNS('*', 'Worksheet')[0];
  const NS = 'urn:schemas-microsoft-com:office:spreadsheet';
  if (ws) {
    return [...ws.getElementsByTagNameNS('*', 'Row')].map((r) => {
      const row: Cell[] = []; let c = 0;
      for (const x of [...r.getElementsByTagNameNS('*', 'Cell')]) {
        const ix = x.getAttribute('ss:Index') || x.getAttributeNS(NS, 'Index');
        if (ix) c = Number(ix) - 1;
        const d = x.getElementsByTagNameNS('*', 'Data')[0], ty = d && (d.getAttribute('ss:Type') || d.getAttributeNS(NS, 'Type'));
        row[c++] = d ? (ty === 'Number' ? Number(d.textContent) : d.textContent ?? '') : '';
      }
      return Array.from(row, (y) => y ?? '');
    });
  }
  const tb = [...doc.querySelectorAll('table')].sort((a, b) => b.rows.length - a.rows.length)[0];
  if (!tb) throw new Error('Không tìm thấy bảng dữ liệu trong file');
  const out: Cell[][] = [];
  [...tb.rows].forEach((tr, ri) => {
    const row = (out[ri] ??= []); let c = 0;
    for (const td of [...tr.cells]) {
      while (row[c] !== undefined) c++;
      const val = (td.textContent ?? '').replace(/\s+/g, ' ').trim(), cs = td.colSpan || 1, rs = td.rowSpan || 1;
      for (let a = 0; a < rs; a++) { const rr = (out[ri + a] ??= []); for (let b = 0; b < cs; b++) rr[c + b] = a === 0 && b === 0 ? val : ''; }
      c += cs;
    }
  });
  return out.map((r) => Array.from(r, (y) => y ?? ''));
}

/** Đọc file bảng tính bất kỳ thành mảng dòng (sheet đầu tiên đang hiện). */
export async function readSheet(file: File): Promise<Cell[][]> {
  const ab = await file.arrayBuffer(), h = new Uint8Array(ab.slice(0, 8));
  if (h[0] === 0xd0 && h[1] === 0xcf && h[2] === 0x11 && h[3] === 0xe0) {
    const wb = cfbStream(ab, ['Workbook', 'Book']);
    if (!wb) throw new Error('File .xls không có dữ liệu bảng tính (có thể đang đặt mật khẩu)');
    return biffRows(wb);
  }
  if (h[0] === 0x50 && h[1] === 0x4b) return (await readXlsxFile(file)) as unknown as Cell[][];
  const t = new TextDecoder('utf-8').decode(ab).replace(/^﻿/, '');
  if (/^\s*</.test(t) && /<(table|Workbook)/i.test(t)) return htmlRows(t);
  return textToRows(t);
}
