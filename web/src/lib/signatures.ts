// Chữ ký trên bản in: ảnh chữ ký + cờ "chữ ký đã có họ tên" (có thì không in thêm họ tên bên dưới).
import { signatureUrl } from './documents';
import { toDataUrl } from './pdfMaker';
import { rpc, supabase } from './supabase';

export interface Sign { img: string | null; hasName: boolean }
export const NO_SIGN: Sign = { img: null, hasName: false };

/** who: 'giam_doc', 'con_dau' hoặc user_id. asData = true khi vẽ vào PDF (cần data URL). */
export async function loadSigns(tenantId: string, whos: (string | null | undefined)[], asData = false): Promise<Map<string, Sign>> {
  const ids = [...new Set(whos.filter((x): x is string => !!x))];
  const out = new Map<string, Sign>();
  if (!ids.length || !tenantId) return out;
  const st = await supabase.from('signature_settings').select('who, has_name').in('who', ids);
  const flags = new Map(((st.data ?? []) as { who: string; has_name: boolean }[]).map((x) => [x.who, x.has_name]));
  await Promise.all(ids.map(async (w) => {
    const url = await signatureUrl(tenantId, w).catch(() => null);
    out.set(w, { img: asData ? await toDataUrl(url) : url, hasName: !!flags.get(w) });
  }));
  return out;
}

/** In họ tên dưới chữ ký? Không in khi đã có ảnh chữ ký và chữ ký đã có họ tên. */
export const showName = (s: Sign | null | undefined) => !(s?.img && s.hasName);

export async function getHasName(who: string): Promise<boolean> {
  const { data } = await supabase.from('signature_settings').select('has_name').eq('who', who).maybeSingle();
  return !!(data as { has_name: boolean } | null)?.has_name;
}
export const setHasName = (who: string, v: boolean) => rpc('set_signature_has_name', { p_who: who, p_has_name: v });
