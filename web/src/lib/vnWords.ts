// Đọc số tiền thành chữ tiếng Việt: 5.250.000 → "Năm triệu hai trăm năm mươi nghìn đồng".
const D = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function three(n: number, full: boolean): string {
  const h = Math.floor(n / 100), t = Math.floor((n % 100) / 10), u = n % 10;
  const out: string[] = [];
  if (full || h) out.push(`${D[h]} trăm`);
  if (t > 1) out.push(`${D[t]} mươi`);
  else if (t === 1) out.push('mười');
  else if ((full || h) && u) out.push('lẻ');
  if (u) out.push(u === 1 && t > 1 ? 'mốt' : u === 5 && t >= 1 ? 'lăm' : u === 4 && t > 1 ? 'tư' : D[u]);
  return out.join(' ');
}

export function numberToWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'không';
  const units = ['', 'nghìn', 'triệu', 'tỷ', 'nghìn tỷ', 'triệu tỷ'];
  const groups: number[] = [];
  while (n > 0) { groups.push(n % 1000); n = Math.floor(n / 1000); }
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!groups[i]) continue;
    parts.push(three(groups[i], i < groups.length - 1), units[i]);
  }
  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export const moneyWords = (n: number) => { const w = numberToWords(n); return `${w[0].toUpperCase()}${w.slice(1)} đồng`; };
