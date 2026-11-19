// Lõi "AI đọc giấy tờ": nhiều nhà cung cấp AI xếp hàng, đọc LẦN LƯỢT (phương án A).
// - Danh sách AI + khóa lấy từ cấu hình (secret AI_PROVIDERS), không viết cứng.
// - Mỗi AI có thể nhiều khóa, dùng luân phiên giữa các lần đọc.
// - AI quá thời gian / lỗi / hết lượt → chuyển AI kế tiếp.
// - Kết quả được kiểm tra (ngày, biển số, số khung); sai thì cho AI kế tiếp đọc lại,
//   hết AI thì trả kết quả tốt nhất kèm cảnh báo để người dùng tự kiểm tra.
// Không phụ thuộc Deno.env để kiểm thử được bằng fetch giả.

import { docTypeOf, PLATE_RE, plateKey, type DocTypeDef } from './doc_types.ts';

export interface Provider {
  type: 'gemini' | 'openai';   // openai = mọi dịch vụ dùng chuẩn OpenAI (Groq, OpenRouter, Mistral…)
  name?: string;
  model: string;
  base_url?: string;
  keys: string[];
  pdf?: boolean;               // đọc được PDF (mặc định: chỉ gemini)
}
export interface InputFile { mime: string; data: string }   // data: base64
export type FieldValue = string | number | null;
export interface Attempt { provider: string; ok: boolean; ms: number; error?: string }
export interface ReadResult { fields: Record<string, FieldValue>; provider: string; warnings: string[]; attempts: Attempt[] }

export class ReaderError extends Error {
  constructor(public status: number, message: string, public attempts: Attempt[] = []) {
    super(message);
  }
}

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';

export function parseProviders(raw: string | undefined | null): Provider[] {
  if (!raw || !raw.trim()) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new ReaderError(500, 'Cấu hình AI_PROVIDERS không phải JSON hợp lệ');
  }
  if (!Array.isArray(list)) throw new ReaderError(500, 'Cấu hình AI_PROVIDERS phải là danh sách');
  return list.map((p, i) => {
    const o = p as Partial<Provider>;
    if ((o.type !== 'gemini' && o.type !== 'openai') || !o.model || !Array.isArray(o.keys) || o.keys.length === 0
        || (o.type === 'openai' && !o.base_url)) {
      throw new ReaderError(500, `Cấu hình AI thứ ${i + 1} thiếu type / model / keys / base_url`);
    }
    return { ...o, name: o.name ?? `${o.type}:${o.model}` } as Provider;
  });
}

// Luân phiên khóa: mỗi lần dùng AI nào thì lấy khóa kế tiếp của AI đó.
const cursors = new Map<string, number>();
function nextKey(p: Provider): string {
  const id = p.name ?? p.model;
  const i = cursors.get(id) ?? 0;
  cursors.set(id, i + 1);
  return p.keys[i % p.keys.length];
}

const KIND_HINT = { text: 'chuỗi', date: 'ngày dạng YYYY-MM-DD', int: 'số nguyên', money: 'số nguyên (đồng)' } as const;

export function buildPrompt(def: DocTypeDef): string {
  const lines = def.fields.map((x) => `- "${x.key}": ${x.label} (${KIND_HINT[x.kind]})`).join('\n');
  return [
    `Đây là ảnh/tệp "${def.name}" của Việt Nam${def.sides ? ` (gồm ${def.sides.join(', ').toLowerCase()} theo thứ tự ảnh)` : ''}. Hãy đọc chính xác các thông tin in trên giấy.`,
    'Chỉ trả về MỘT đối tượng JSON với đúng các khóa sau:',
    lines,
    'Quy tắc: không đọc được hoặc giấy không có thì để null; không đoán, không bịa;',
    'giữ nguyên chữ in hoa / dấu tiếng Việt như trên giấy; biển số giữ dạng như 51B-123.45; ngày luôn đổi về YYYY-MM-DD.',
  ].join('\n');
}

function extractJson(text: string): Record<string, unknown> {
  const s = text.replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('AI không trả về JSON');
  const v = JSON.parse(s.slice(a, b + 1));
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('AI trả về sai dạng');
  return v as Record<string, unknown>;
}

async function callProvider(p: Provider, def: DocTypeDef, files: InputFile[], fetchFn: FetchFn,
                            timeoutMs: number): Promise<Record<string, unknown>> {
  const key = nextKey(p);
  const prompt = buildPrompt(def);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    if (p.type === 'gemini') {
      res = await fetchFn(`${p.base_url ?? GEMINI_URL}/models/${encodeURIComponent(p.model)}:generateContent`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, ...files.map((x) => ({ inline_data: { mime_type: x.mime, data: x.data } }))] }],
          generationConfig: {
            temperature: 0, responseMimeType: 'application/json',
            // Dòng Flash mặc định "suy nghĩ" trước khi trả lời (chậm 10–30 giây); đọc giấy tờ không cần → tắt / tối thiểu
            ...(/2\.5-flash/.test(p.model) ? { thinkingConfig: { thinkingBudget: 0 } }
              : /gemini-[3-9][\d.]*-flash/.test(p.model) ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
          },
        }),
      });
    } else {
      res = await fetchFn(`${p.base_url!.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: p.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'user',
            content: [{ type: 'text', text: prompt },
                      ...files.map((x) => ({ type: 'image_url', image_url: { url: `data:${x.mime};base64,${x.data}` } }))],
          }],
        }),
      });
    }
    const body = await res.text();
    if (!res.ok) {
      // Câu báo lỗi của nhà cung cấp (vd "API key not valid", "model not found") – không chứa khóa
      let why = '';
      try {
        const e = JSON.parse(body);
        why = String(e?.error?.message ?? e?.message ?? '').replace(/\s+/g, ' ').slice(0, 160);
      } catch { /* bỏ qua */ }
      throw new Error(res.status === 429 ? 'hết lượt (429)' : `HTTP ${res.status}${why ? `: ${why}` : ''}`);
    }
    const j = JSON.parse(body);
    const text: string = p.type === 'gemini'
      ? (j?.candidates?.[0]?.content?.parts ?? []).map((x: { text?: string }) => x.text ?? '').join('')
      : (j?.choices?.[0]?.message?.content ?? '');
    return extractJson(text);
  } catch (e) {
    if (ctrl.signal.aborted) throw new Error(`quá ${timeoutMs / 1000} giây`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function toDate(v: unknown): string | null | undefined {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let y: number, m: number, d: number;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1950 || y > 2100 || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Chuẩn hóa kết quả AI theo danh mục ô; trả về các điểm nghi ngờ để quyết định có cho AI khác đọc lại. */
export function normalize(def: DocTypeDef, raw: Record<string, unknown>): { fields: Record<string, FieldValue>; issues: string[] } {
  const fields: Record<string, FieldValue> = {};
  const issues: string[] = [];
  for (const x of def.fields) {
    const v = raw[x.key];
    if (v == null || v === '' || String(v).trim().toLowerCase() === 'null') { fields[x.key] = null; continue; }
    if (x.kind === 'date') {
      const d = toDate(v);
      if (d === undefined) issues.push(`${x.label}: ngày không hợp lệ`);
      fields[x.key] = d ?? null;
    } else if (x.kind === 'int' || x.kind === 'money') {
      const n = typeof v === 'number' ? Math.round(v) : Number(String(v).replace(/[^0-9]/g, ''));
      fields[x.key] = Number.isFinite(n) && String(v).match(/[0-9]/) ? n : null;
    } else {
      fields[x.key] = String(v).trim();
    }
  }
  const plate = fields['xe.bien_so'];
  if (typeof plate === 'string' && !PLATE_RE.test(plateKey(plate))) issues.push('Biển số đọc được không đúng dạng');
  const vin = fields['xe.so_khung'];
  if (typeof vin === 'string' && plateKey(vin).length !== 17) issues.push('Số khung đọc được không đủ 17 ký tự');
  const so = fields['so_giay'];
  if (def.code === 'cccd' && typeof so === 'string' && !/^[0-9]{12}$/.test(so.replace(/\s/g, ''))) {
    issues.push('Số CCCD đọc được không đủ 12 chữ số');
  }
  const from = (fields['hieu_luc_tu'] ?? fields['ngay_cap']) as string | null;
  const to = fields['het_han'] as string | null;
  if (from && to && to < from) issues.push('Ngày hết hạn trước ngày cấp / hiệu lực');
  if (def.fields.every((x) => fields[x.key] == null)) issues.push('Không đọc được thông tin nào');
  return { fields, issues };
}

export async function readDocument(opts: {
  docType: string; files: InputFile[]; providers: Provider[]; timeoutMs: number; fetchFn?: FetchFn;
}): Promise<ReadResult> {
  const def = docTypeOf(opts.docType);
  if (!def) throw new ReaderError(400, 'Loại giấy tờ không hợp lệ');
  if (opts.providers.length === 0) throw new ReaderError(503, 'Chưa cấu hình AI đọc giấy tờ, vui lòng nhập tay');
  const isPdf = opts.files.some((x) => x.mime === 'application/pdf');
  const candidates = opts.providers.filter((p) => !isPdf || (p.pdf ?? p.type === 'gemini'));
  if (candidates.length === 0) throw new ReaderError(422, 'Chưa có AI đọc được PDF, hãy chụp ảnh giấy tờ');

  const fetchFn = opts.fetchFn ?? ((u: string, i: RequestInit) => fetch(u, i));
  const attempts: Attempt[] = [];
  let best: { fields: Record<string, FieldValue>; issues: string[]; provider: string } | null = null;

  for (const p of candidates) {
    const t0 = Date.now();
    try {
      const raw = await callProvider(p, def, opts.files, fetchFn, opts.timeoutMs);
      const r = normalize(def, raw);
      const empty = r.issues.includes('Không đọc được thông tin nào');
      attempts.push({ provider: p.name!, ok: r.issues.length === 0, ms: Date.now() - t0, error: r.issues.join('; ') || undefined });
      if (r.issues.length === 0) return { fields: r.fields, provider: p.name!, warnings: [], attempts };
      if (!empty && (!best || r.issues.length < best.issues.length)) best = { ...r, provider: p.name! };
    } catch (e) {
      attempts.push({ provider: p.name!, ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (best) return { fields: best.fields, provider: best.provider, warnings: best.issues, attempts };
  throw new ReaderError(502, 'Các AI đều chưa đọc được giấy tờ, vui lòng nhập tay hoặc chụp lại rõ hơn', attempts);
}
