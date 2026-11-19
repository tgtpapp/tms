// Chẩn đoán AI đọc giấy tờ bằng khóa thật (chạy trên GitHub Actions, khóa lấy từ secret, KHÔNG in khóa).
// In: danh sách model Flash, thời gian + mã lỗi từng kiểu gọi.
import { parseProviders } from '../supabase/functions/_shared/doc_reader.ts';

const ps = parseProviders(Deno.env.get('AI_PROVIDERS'));
const g = ps.find((p) => p.type === 'gemini');
if (!g) { console.log('Không có AI gemini trong AI_PROVIDERS'); Deno.exit(0); }
const key = g.keys[0];
const BASE = 'https://generativelanguage.googleapis.com/v1beta';
console.log(`Số AI: ${ps.length}; gemini có ${g.keys.length} khóa; khóa dạng ${key.slice(0, 3)}…; model cấu hình: ${g.model}`);

const t0 = Date.now();
const lr = await fetch(`${BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
const lj = await lr.json().catch(() => ({}));
const names: string[] = (lj.models ?? []).map((m: { name: string }) => m.name.replace('models/', '')).filter((n: string) => /flash/.test(n));
console.log(`Danh sách model: HTTP ${lr.status} (${Date.now() - t0} ms): ${names.join(', ')}`);

// Ảnh PNG 1x1
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function call(model: string, label: string, gen: Record<string, unknown>, image: boolean) {
  const t = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const parts: unknown[] = [{ text: 'Trả về JSON {"ok": true, "mo_ta": "<mô tả ảnh 5 chữ>"}' }];
    if (image) parts.push({ inline_data: { mime_type: 'image/png', data: PNG } });
    const r = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: gen }),
    });
    const txt = await r.text();
    let out = '';
    try { const j = JSON.parse(txt); out = j.error?.message ?? (j.candidates?.[0]?.content?.parts ?? []).map((x: { text?: string }) => x.text ?? '').join('').slice(0, 80); } catch { out = txt.slice(0, 80); }
    console.log(`${model} · ${label}: HTTP ${r.status} · ${Date.now() - t} ms · ${out.replace(/\s+/g, ' ')}`);
  } catch (e) {
    console.log(`${model} · ${label}: LỖI sau ${Date.now() - t} ms · ${e instanceof Error ? e.message : e}`);
  } finally {
    clearTimeout(timer);
  }
}
const models = [...new Set(['gemini-flash-latest', 'gemini-flash-lite-latest', ...names.filter((n) => /^gemini-[\d.]+-flash(-lite)?$/.test(n)).slice(0, 4)])];
for (const m of models) {
  await call(m, 'chữ, budget0', { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }, false);
  await call(m, 'ảnh, budget0', { temperature: 0, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } }, true);
  await call(m, 'ảnh, mặc định', { temperature: 0, responseMimeType: 'application/json' }, true);
}

// Chạy đúng đường đọc giấy tờ của app (lõi doc_reader) với cấu hình thật, ảnh thử 1x1
import { readDocument } from '../supabase/functions/_shared/doc_reader.ts';
const t1 = Date.now();
try {
  const r = await readDocument({ docType: 'cccd', files: [{ mime: 'image/png', data: PNG }], providers: ps, timeoutMs: 25000 });
  console.log(`Đường đọc của app: dùng ${r.provider} sau ${Date.now() - t1} ms; các lần: ${r.attempts.map((a) => `${a.provider} ${a.ms}ms ${a.error ?? 'ok'}`).join(' | ')}`);
} catch (e) {
  const at = (e as { attempts?: { provider: string; ms: number; error?: string }[] }).attempts ?? [];
  console.log(`Đường đọc của app: LỖI sau ${Date.now() - t1} ms: ${(e as Error).message}; các lần: ${at.map((a) => `${a.provider} ${a.ms}ms ${a.error ?? 'ok'}`).join(' | ')}`);
}
