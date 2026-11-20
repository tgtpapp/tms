// Đọc giá bán lẻ Petrolimex vùng 1 (như app cũ: bảng giá trên webgia.com), in ra JSON {gia, source}.
// Node 20+, không cần thư viện. Không đọc được thì thoát lỗi để giữ nguyên giá cũ trong database.
const SOURCES = ['https://webgia.com/gia-xang-dau/petrolimex/', 'https://webgia.com/gia-xang-dau/'];
function parse(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<\/(td|th)>/gi, ' | ').replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const items = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(.*?(?:Xăng|Dầu)[^|]*?)\s*\|\s*(\d{2}\.\d{3})\s*\|\s*(\d{2}\.\d{3})/i);
    if (m) items.push({ name: m[1].trim(), vung1: Number(m[2].replace('.', '')) });
  }
  return items;
}
const key = (n) => (/0[,.]001/.test(n) ? 'DO 0,001S-V' : /0[,.]05/.test(n) ? 'DO 0,05S-II' : /E5/i.test(n) ? 'E5 RON92-II'
  : /E10/i.test(n) && /(mức\s*3|-III)/i.test(n) ? 'E10 RON95-III' : '');
let items = [], used = '';
for (const url of SOURCES) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; fuel-price-bot)' } });
    if (!res.ok) continue;
    items = parse(await res.text());
    if (items.length >= 3) { used = url; break; }
  } catch (e) { console.error('Lỗi', url, e.message); }
}
const gia = {};
for (const it of items) { const k = key(it.name); if (k && !gia[k]) gia[k] = it.vung1; }
if (Object.keys(gia).length < 2) { console.error('Không đọc được bảng giá, giữ nguyên giá cũ'); process.exit(1); }
process.stdout.write(JSON.stringify({ gia, source: `Petrolimex (${new URL(used).hostname})` }));
