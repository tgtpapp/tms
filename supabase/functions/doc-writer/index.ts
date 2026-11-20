// Edge Function: AI soạn / sửa văn bản theo yêu cầu người soạn (mod Văn bản).
// - Vào: { html, instruction }. Ra: { html } – văn bản đã sửa, GIỮ NGUYÊN các ô {…} để điền theo từng người.
// - Chỉ người có quyền Văn bản: Thêm hoặc Sửa gọi được. Dùng chung cấu hình AI_PROVIDERS với AI đọc giấy tờ.
// - Người soạn luôn xem lại trước khi lưu; AI không tự lưu, không tự cấp số.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { geminiModels, markDeadModel, nextKey, parseProviders, ReaderError, type Provider } from '../_shared/doc_reader.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const MAX_HTML = 200_000;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });

const PROMPT = (instruction: string, html: string) => [
  'Bạn là trợ lý soạn văn bản hành chính của một doanh nghiệp vận tải ở Việt Nam.',
  'Hãy sửa văn bản HTML dưới đây theo YÊU CẦU của người soạn. Quy tắc:',
  '- Viết tiếng Việt chuẩn văn phong hành chính, đúng chính tả.',
  '- GIỮ NGUYÊN mọi ô dạng {…} (ví dụ {Họ tên}, {Số văn bản}, {Ngày ký}, {Chữ ký giám đốc}); không tự điền thay chúng.',
  '- Giữ bố cục: tiêu đề, quốc hiệu, bảng đầu văn bản, căn lề, chữ đậm. Chỉ sửa phần cần sửa theo yêu cầu.',
  '- Không bịa căn cứ pháp lý; nếu yêu cầu cần căn cứ mà không chắc chắn, ghi "(cần xác minh)".',
  '- Chỉ trả về HTML của văn bản (các thẻ p, b, i, u, br, table, tr, td, span, style căn lề), không giải thích, không ```.',
  '', `YÊU CẦU: ${instruction}`, '', 'VĂN BẢN:', html,
].join('\n');

async function ask(p: Provider, prompt: string, timeoutMs: number): Promise<string> {
  const key = nextKey(p);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const model = p.type === 'gemini' && p.model === 'auto' ? 'gemini-flash-latest' : p.model;
  try {
    let res: Response;
    if (p.type === 'gemini') {
      res = await fetch(`${p.base_url ?? 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
      });
    } else if (p.type === 'claude') {
      res = await fetch(`${(p.base_url ?? 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages`, {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: 8000, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      });
    } else {
      res = await fetch(`${(p.base_url ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'user', content: prompt }] }),
      });
    }
    const body = await res.text();
    if (!res.ok) { if (res.status === 404 && p.type === 'gemini') markDeadModel(model); throw new Error(res.status === 429 ? 'hết lượt (429)' : `HTTP ${res.status}`); }
    const j = JSON.parse(body);
    const text: string = p.type === 'gemini'
      ? (j?.candidates?.[0]?.content?.parts ?? []).filter((x: { thought?: boolean }) => !x.thought).map((x: { text?: string }) => x.text ?? '').join('')
      : p.type === 'claude' ? (j?.content ?? []).map((x: { text?: string }) => x.text ?? '').join('') : (j?.choices?.[0]?.message?.content ?? '');
    const html = text.replace(/```(?:html)?/gi, '').trim();
    if (!/<(p|table|div|b)\b/i.test(html)) throw new Error('AI không trả về văn bản');
    return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '');
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`quá ${timeoutMs / 1000} giây`);
    throw e;
  } finally { clearTimeout(timer); }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ nhận POST' });
  try {
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ')) throw new ReaderError(401, 'Chưa đăng nhập');
    const b = await req.json().catch(() => null) as { html?: unknown; instruction?: unknown } | null;
    const html = typeof b?.html === 'string' ? b.html : '', instruction = typeof b?.instruction === 'string' ? b.instruction.trim() : '';
    if (!instruction) throw new ReaderError(400, 'Nhập yêu cầu cho AI');
    if (html.length > MAX_HTML) throw new ReaderError(413, 'Văn bản quá dài cho AI');
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: perms, error } = await user.rpc('my_permissions');
    if (error) throw new ReaderError(401, 'Phiên đăng nhập không hợp lệ');
    if (!((perms ?? []) as { permission_code: string }[]).some((p) => p.permission_code === 'doc.add' || p.permission_code === 'doc.edit')) {
      throw new ReaderError(403, 'Không có quyền soạn văn bản');
    }
    const providers = parseProviders(Deno.env.get('AI_PROVIDERS'));
    if (!providers.length) throw new ReaderError(503, 'Chưa cấu hình AI (AI_PROVIDERS)');
    const timeout = Math.max(30000, Number(Deno.env.get('AI_TIMEOUT_MS') ?? 0) || 0);
    const errs: string[] = [];
    const t0 = Date.now();
    for (const p0 of providers) {
      // Gemini: thử lần lượt các model còn dùng được, nhanh trước (model trong cấu hình có thể đã bị Google khóa)
      const list = p0.type === 'gemini' ? (await geminiModels(p0)).slice(0, 5).map((m) => ({ ...p0, model: m, name: `gemini:${m}` })) : [p0];
      for (const p of list) {
        if (Date.now() - t0 > 110_000) break;
        try { return json(200, { html: await ask(p, PROMPT(instruction, html || '<p></p>'), timeout), provider: p.name }); }
        catch (e) { errs.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
    throw new ReaderError(502, `AI không soạn được: ${errs.join(' · ')}`);
  } catch (e) {
    const status = e instanceof ReaderError ? e.status : 500;
    return json(status, { error: e instanceof Error ? e.message : String(e) });
  }
});
