// Kiểm thử lõi AI đọc giấy tờ bằng fetch giả (không gọi AI thật): thứ tự lần lượt,
// chuyển AI khi quá giờ / lỗi / kết quả sai, luân phiên khóa, chuẩn hóa ngày & số.
import { assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { normalize, parseProviders, readDocument, ReaderError, type Provider } from '../../functions/_shared/doc_reader.ts';
import { docTypeOf } from '../../functions/_shared/doc_types.ts';

const IMG = [{ mime: 'image/jpeg', data: 'AAAA' }];
const GOOD = { so_giay: 'KD-123', 'xe.bien_so': '51B-123.45', 'xe.so_khung': 'RLHABC12345678901', ngay_cap: '01/06/2026', het_han: '2026-12-01' };
const BAD_PLATE = { ...GOOD, 'xe.bien_so': 'ABC' };

const gemini = (name: string, keys = ['k1']): Provider => ({ type: 'gemini', name, model: 'm', keys });
const groq = (name: string): Provider => ({ type: 'openai', name, model: 'm', base_url: 'https://x.test/v1', keys: ['g1'] });

function geminiReply(obj: unknown) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status: 200 });
}
function openaiReply(obj: unknown) {
  return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(obj) + '\n```' } }] }), { status: 200 });
}

Deno.test('AI đầu đọc đúng thì dùng luôn, chuẩn hóa ngày dd/mm/yyyy', async () => {
  const calls: string[] = [];
  const r = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [gemini('A'), groq('B')], timeoutMs: 1000,
    fetchFn: (u) => { calls.push(u); return Promise.resolve(geminiReply(GOOD)); } });
  assertEquals(r.provider, 'A');
  assertEquals(r.fields.ngay_cap, '2026-06-01');
  assertEquals(r.warnings, []);
  assertEquals(calls.length, 1);
});

Deno.test('AI đầu hết lượt (429) → chuyển AI sau', async () => {
  const r = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [gemini('A'), groq('B')], timeoutMs: 1000,
    fetchFn: (u) => Promise.resolve(u.includes('x.test') ? openaiReply(GOOD) : new Response('{}', { status: 429 })) });
  assertEquals(r.provider, 'B');
  assertEquals(r.attempts[0].error, 'hết lượt (429)');
});

Deno.test('AI đầu quá thời gian → chuyển AI sau', async () => {
  const r = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [gemini('A'), groq('B')], timeoutMs: 50,
    fetchFn: (u, init) => u.includes('x.test') ? Promise.resolve(openaiReply(GOOD))
      : new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted')))) });
  assertEquals(r.provider, 'B');
  assertEquals(r.attempts[0].error, 'quá 0.05 giây');
});

Deno.test('Biển số sai dạng → AI sau đọc lại; tất cả sai thì trả kết quả kèm cảnh báo', async () => {
  const r1 = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [gemini('A'), groq('B')], timeoutMs: 1000,
    fetchFn: (u) => Promise.resolve(u.includes('x.test') ? openaiReply(GOOD) : geminiReply(BAD_PLATE)) });
  assertEquals(r1.provider, 'B');
  const r2 = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [gemini('A')], timeoutMs: 1000,
    fetchFn: () => Promise.resolve(geminiReply(BAD_PLATE)) });
  assertEquals(r2.warnings, ['Biển số đọc được không đúng dạng']);
});

Deno.test('Luân phiên khóa giữa các lần đọc', async () => {
  const keys: string[] = [];
  const p = gemini('XOAY', ['k1', 'k2']);
  for (let i = 0; i < 3; i++) {
    await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [p], timeoutMs: 1000,
      fetchFn: (_u, init) => { keys.push((init.headers as Record<string, string>)['x-goog-api-key']); return Promise.resolve(geminiReply(GOOD)); } });
  }
  assertEquals(keys, ['k1', 'k2', 'k1']);
});

Deno.test('PDF chỉ gửi cho AI đọc được PDF; chưa cấu hình AI báo 503', async () => {
  const urls: string[] = [];
  await readDocument({ docType: 'kiem_dinh', files: [{ mime: 'application/pdf', data: 'AA' }], providers: [groq('B'), gemini('A')],
    timeoutMs: 1000, fetchFn: (u) => { urls.push(u); return Promise.resolve(geminiReply(GOOD)); } });
  assertEquals(urls.every((u) => !u.includes('x.test')), true);
  const e = await assertRejects(() => readDocument({ docType: 'kiem_dinh', files: IMG, providers: [], timeoutMs: 1000 }), ReaderError);
  assertEquals(e.status, 503);
});

Deno.test('Chuẩn hóa: số tiền có dấu chấm, ngày sai bị bỏ, cấu hình sai báo lỗi', () => {
  const r = normalize(docTypeOf('bh_vat_chat')!, { so_tien_bao_hiem: '1.200.000.000 đ', het_han: '31/02/2026' });
  assertEquals(r.fields.so_tien_bao_hiem, 1200000000);
  assertEquals(r.fields.het_han, null);
  assertEquals(r.issues.includes('Hết hạn ngày: ngày không hợp lệ'), true);
  assertEquals(parseProviders(''), []);
  let threw = false;
  try { parseProviders('[{"type":"openai","keys":["k"]}]'); } catch { threw = true; }
  assertEquals(threw, true);
  assertEquals(parseProviders('[{"type":"gemini","keys":["k"]}]')[0].model, 'auto');
});

Deno.test('Gemini bị khai tử (404) → tự hỏi danh sách model, dùng model Flash mới nhất', async () => {
  const urls: string[] = [];
  const r = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [{ type: 'gemini', model: 'gemini-2.5-flash', keys: ['k'], base_url: 'https://g.test' }],
    timeoutMs: 1000, fetchFn: (u) => {
      urls.push(u);
      if (u.includes('/models?')) {
        return Promise.resolve(new Response(JSON.stringify({ models: [
          { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.8-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-3.6-flash-lite', supportedGenerationMethods: ['generateContent'] },
        ] }), { status: 200 }));
      }
      if (u.includes('gemini-2.5-flash')) return Promise.resolve(new Response(JSON.stringify({ error: { message: 'no longer available' } }), { status: 404 }));
      return Promise.resolve(geminiReply(GOOD));
    } });
  assertEquals(r.provider, 'gemini:gemini-3.8-flash');
  assertEquals(r.attempts[0].error, 'HTTP 404: no longer available');
  assertEquals(urls.some((u) => u.includes('image')), false);
});

Deno.test('Claude đọc được, gửi ảnh dạng base64', async () => {
  let body = '';
  const r = await readDocument({ docType: 'kiem_dinh', files: IMG, providers: [{ type: 'claude', model: 'claude-x', keys: ['c'] }], timeoutMs: 1000,
    fetchFn: (u, i) => {
      body = String(i.body);
      assertEquals(u, 'https://api.anthropic.com/v1/messages');
      return Promise.resolve(new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(GOOD) }] }), { status: 200 }));
    } });
  assertEquals(r.provider, 'claude:claude-x');
  assertEquals(body.includes('"type":"image"'), true);
});
