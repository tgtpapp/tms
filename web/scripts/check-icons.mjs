// Kiểm tra mọi biểu tượng fi-rr-* dùng trong mã nguồn đều có trong bộ Uicons đã cài (tránh biểu tượng trống).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync('node_modules/@flaticon/flaticon-uicons/css/regular/rounded.css', 'utf8');
const have = new Set([...css.matchAll(/\.fi-rr-([a-z0-9-]+):+before/g)].map((m) => m[1]));
const used = new Map();
const walk = (d) => readdirSync(d).forEach((f) => {
  const p = join(d, f);
  if (statSync(p).isDirectory()) return walk(p);
  if (!/\.(tsx?|css)$/.test(f)) return;
  const src = readFileSync(p, 'utf8');
  for (const m of src.matchAll(/fi-rr-([a-z0-9-]+)|icon: '([a-z0-9-]+)'/g)) used.set(m[1] ?? m[2], p);
});
walk('src');
const missing = [...used].filter(([n]) => !have.has(n));
if (missing.length) {
  console.error('Biểu tượng không có trong Uicons:', missing.map(([n, p]) => `${n} (${p})`).join(', '));
  process.exit(1);
}
console.log(`Biểu tượng: ${used.size} cái, đều có trong Uicons (${have.size}).`);
