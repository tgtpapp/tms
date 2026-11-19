// Tên tuyến / hành trình theo chiều chạy. Chiều về để trống thì tự đảo từ chiều đi.
export type Dir = 'di' | 've';

const SEP = /\s+([-–—])\s+/;

/** "Biên Hòa - Vũng Tàu" → "Vũng Tàu - Biên Hòa" (giữ dấu gạch người dùng đã gõ) */
export function reverseName(s: string): string {
  const sep = SEP.exec(s)?.[1];
  if (!sep) return s;
  return s.split(SEP).filter((x, i) => i % 2 === 0).reverse().join(` ${sep} `);
}

/** Tên tuyến theo chiều */
export function dirName(r: { name: string; name_ve?: string | null } | undefined, d: Dir): string {
  if (!r) return '';
  return d === 've' ? (r.name_ve?.trim() || reverseName(r.name)) : r.name;
}

/** Đảo hành trình: "A - QL1A - B và ngược lại" → "B - QL1A - A" */
export function reverseItinerary(s: string): string {
  const core = s.replace(/\s*(và|,)?\s*ngược lại\.?\s*$/i, '').trim();
  if (!core) return '';
  return core.split(/\s+[-–—]\s+/).reverse().join(' - ');
}
