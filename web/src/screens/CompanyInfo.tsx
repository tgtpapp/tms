// Thông tin công ty (Cấu hình): logo, thông tin doanh nghiệp, giấy phép kinh doanh vận tải,
// hồ sơ pháp lý & chữ ký (chỉ quản trị xem). Giấy tờ tải lên → AI đọc, điền sẵn để kiểm tra rồi lưu.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  companyFileUrl, loadStoredFiles, prepareFile, readByAI, removeFile, signatureUrl, uploadCompanyFile, uploadLogo, uploadSignature, type PreparedFile,
} from '../lib/documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

const EMPTY = {
  name: '', legal_name: '', tax_code: '', address: '', phone: '',
  transport_license_no: '', transport_license_date: '', transport_license_issuer: '', director_id_no: '',
};
type Info = typeof EMPTY;
type Slot = 'logo' | 'giay_phep' | 'cccd_truoc' | 'cccd_sau' | 'chu_ky' | 'con_dau';
const PATH: Record<Slot, (t: string) => string> = {
  logo: (t) => `${t}/cong_ty/logo.png`,
  giay_phep: (t) => `${t}/cong_ty/ho_so/giay_phep.jpg`,
  cccd_truoc: (t) => `${t}/cong_ty/ho_so/cccd_truoc.jpg`,
  cccd_sau: (t) => `${t}/cong_ty/ho_so/cccd_sau.jpg`,
  chu_ky: (t) => `${t}/chu_ky/giam_doc.png`,
  con_dau: (t) => `${t}/chu_ky/con_dau.png`,
};

export function CompanyInfo({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const [f, setF] = useState<Info>(EMPTY);
  const [flags, setFlags] = useState({ sign: true, seal: true });
  const [urls, setUrls] = useState<Partial<Record<Slot, string | null>>>({});
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const cccd = useRef<{ truoc?: PreparedFile; sau?: PreparedFile }>({});

  const loadUrls = useCallback(async () => {
    if (!tenantId) return;
    const [logo, gp, ct, cs, ck, cd] = await Promise.all([
      companyFileUrl(tenantId, 'logo.png'), companyFileUrl(tenantId, 'ho_so/giay_phep.jpg'), companyFileUrl(tenantId, 'ho_so/cccd_truoc.jpg'),
      companyFileUrl(tenantId, 'ho_so/cccd_sau.jpg'), signatureUrl(tenantId, 'giam_doc'), signatureUrl(tenantId, 'con_dau'),
    ]);
    setUrls({ logo, giay_phep: gp, cccd_truoc: ct, cccd_sau: cs, chu_ky: ck, con_dau: cd });
  }, [tenantId]);

  const load = useCallback(async () => {
    const [t, p, s] = await Promise.all([
      supabase.from('tenants').select('name, legal_name, tax_code, address, phone, transport_license_no, transport_license_date, transport_license_issuer').maybeSingle(),
      supabase.from('tenant_private').select('director_id_no').maybeSingle(),
      supabase.from('tenant_settings').select('key, value').in('key', ['in.chu_ky_giam_doc', 'in.con_dau']),
    ]);
    if (t.error) return toast('error', t.error.message);
    const r = (t.data ?? {}) as Partial<Record<keyof Info, string | null>>;
    const v = (k: keyof Info) => r[k] ?? '';
    setF({
      name: v('name'), legal_name: v('legal_name'), tax_code: v('tax_code'), address: v('address'), phone: v('phone'),
      transport_license_no: v('transport_license_no'), transport_license_date: v('transport_license_date'),
      transport_license_issuer: v('transport_license_issuer'),
      director_id_no: ((p.data ?? {}) as { director_id_no?: string | null }).director_id_no ?? '',
    });
    const flag = (k: string) => ((s.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
    setFlags({ sign: flag('in.chu_ky_giam_doc') !== false, seal: flag('in.con_dau') !== false });
    setLoaded(true);
  }, [toast]);

  useEffect(() => {
    void load();
    void loadUrls();
  }, [load, loadUrls]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await rpc('update_tenant_profile', {
        p_name: f.name, p_legal_name: f.legal_name, p_tax_code: f.tax_code, p_transport_license_no: f.transport_license_no,
        p_transport_license_date: f.transport_license_date || null, p_transport_license_issuer: f.transport_license_issuer,
        p_address: f.address, p_phone: f.phone, p_director_id_no: f.director_id_no,
      });
      const { error } = await supabase.from('tenant_settings').upsert([
        { key: 'in.chu_ky_giam_doc', value: flags.sign }, { key: 'in.con_dau', value: flags.seal },
      ], { onConflict: 'tenant_id,key' });
      if (error) throw new Error(error.message);
      toast('ok', 'Đã lưu thông tin công ty');
      await load();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  /** AI đọc giấy phép / CCCD giám đốc, điền sẵn các ô (chưa lưu – kiểm tra rồi bấm Lưu). again: đọc lại thì lấy số AI mới đọc. */
  async function readDoc(kind: 'giay_phep' | 'cccd', files: PreparedFile[], again: boolean) {
    setReading(again ? 'AI đang đọc lại…' : 'AI đang đọc…');
    try {
      if (kind === 'giay_phep') {
        const r = await readByAI('gpkd_van_tai', files);
        const g = (k: string) => (r.fields[k] == null ? '' : String(r.fields[k]));
        const pick = (ai: string, cur: string, keep: boolean) => (keep && !again ? cur || ai : ai || cur);
        setF((cur) => ({
          ...cur, transport_license_no: g('so_giay') || cur.transport_license_no, transport_license_date: g('ngay_cap') || cur.transport_license_date,
          transport_license_issuer: g('noi_cap') || cur.transport_license_issuer, legal_name: pick(g('ten_don_vi'), cur.legal_name, true),
          address: pick(g('dia_chi'), cur.address, true),
        }));
      } else {
        const r = await readByAI('cccd', files);
        const so = r.fields.so_giay == null ? '' : String(r.fields.so_giay).replace(/\s/g, '');
        if (so) setF((cur) => ({ ...cur, director_id_no: so }));
      }
      toast('ok', 'AI đã đọc và điền sẵn, kiểm tra rồi bấm "Lưu thông tin công ty"');
    } finally {
      setReading(null);
    }
  }

  /** Giấy tờ: lưu ảnh rồi cho AI đọc */
  async function pickDoc(slot: 'giay_phep' | 'cccd_truoc' | 'cccd_sau', file: File) {
    try {
      const prepared = await prepareFile(file);
      await uploadCompanyFile(tenantId, PATH[slot](tenantId).split('/cong_ty/')[1], prepared.blob, prepared.mime);
      await loadUrls();
      if (slot === 'giay_phep') await readDoc('giay_phep', [prepared], false);
      else {
        cccd.current[slot === 'cccd_truoc' ? 'truoc' : 'sau'] = prepared;
        await readDoc('cccd', [cccd.current.truoc, cccd.current.sau].filter(Boolean) as PreparedFile[], false);
      }
    } catch (err) {
      toast('error', errMsg(err));
      await loadUrls();
    }
  }

  /** Đọc lại ảnh đã lưu */
  async function reread(kind: 'giay_phep' | 'cccd') {
    try {
      const slots: ('giay_phep' | 'cccd_truoc' | 'cccd_sau')[] = kind === 'giay_phep' ? ['giay_phep'] : ['cccd_truoc', 'cccd_sau'];
      const paths = slots.filter((x) => urls[x]).map((x) => PATH[x](tenantId));
      if (paths.length === 0) return toast('error', 'Chưa có ảnh để đọc');
      await readDoc(kind, await loadStoredFiles(paths), true);
    } catch (err) {
      setReading(null);
      toast('error', errMsg(err));
    }
  }

  async function pickImage(slot: Slot, file: File | undefined) {
    if (!file) return;
    if (slot === 'giay_phep' || slot === 'cccd_truoc' || slot === 'cccd_sau') return pickDoc(slot, file);
    try {
      if (slot === 'logo') await uploadLogo(tenantId, file);
      else await uploadSignature(tenantId, slot === 'chu_ky' ? 'giam_doc' : 'con_dau', file);
      toast('ok', 'Đã lưu ảnh');
      await loadUrls();
    } catch (err) {
      toast('error', errMsg(err));
    }
  }

  async function drop(slot: Slot) {
    try {
      await removeFile(PATH[slot](tenantId));
      toast('ok', 'Đã bỏ ảnh');
      await loadUrls();
    } catch (err) {
      toast('error', errMsg(err));
    }
  }

  const set = (k: keyof Info) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const slot = (s: Slot, label: string, hint?: string) => (
    <ImageSlot key={s} label={label} hint={hint} url={urls[s] ?? null} onPick={(file) => void pickImage(s, file)} onRemove={() => void drop(s)}
               reading={!!reading}
               onReread={s === 'giay_phep' ? () => void reread('giay_phep') : s === 'cccd_truoc' || s === 'cccd_sau' ? () => void reread('cccd') : undefined} />
  );

  return (
    <form className="card form" onSubmit={save}>
      <h2>Thông tin công ty</h2>
      {/* Chưa tải xong thì khóa ô nhập, tránh dữ liệu cũ ghi đè lên chữ vừa gõ */}
      <fieldset className="plain" disabled={!loaded}>
      {slot('logo', 'Logo công ty (hiện trên app, tab trình duyệt và vé)')}
      <div className="grid2">
        <label>Tên nhà xe (tên hiển thị)<input value={f.name} onChange={set('name')} required /></label>
        <label>Tên pháp lý (theo đăng ký kinh doanh)<input value={f.legal_name} onChange={set('legal_name')} /></label>
        <label>Mã số thuế<input value={f.tax_code} onChange={set('tax_code')} inputMode="numeric" /></label>
        <label>Số điện thoại<input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        <label>Địa chỉ<input value={f.address} onChange={set('address')} /></label>
      </div>

      <h3 className="section-title">Hồ sơ pháp lý & chữ ký (chỉ quản trị xem)</h3>
      {reading && <p className="upload">{reading}</p>}
      <div className="grid2">
        <label>Số CCCD giám đốc<input value={f.director_id_no} onChange={set('director_id_no')} inputMode="numeric" maxLength={12} /></label>
        <label>Số GPKD vận tải<input value={f.transport_license_no} onChange={set('transport_license_no')} /></label>
        <label>Ngày cấp GPKD vận tải<input type="date" value={f.transport_license_date} onChange={set('transport_license_date')} /></label>
        <label>Nơi cấp GPKD vận tải<input value={f.transport_license_issuer} onChange={set('transport_license_issuer')} /></label>
      </div>
      {slot('giay_phep', 'Giấy phép kinh doanh vận tải', 'Tải ảnh chụp hoặc quét giấy phép – AI tự đọc số, ngày cấp, nơi cấp')}
      {slot('cccd_truoc', 'CCCD giám đốc (mặt trước)', 'AI tự đọc số CCCD')}
      {slot('cccd_sau', 'CCCD giám đốc (mặt sau)')}
      <label className="check">
        <input type="checkbox" checked={flags.sign} onChange={(e) => setFlags({ ...flags, sign: e.target.checked })} />
        In chữ ký giám đốc vào toàn bộ văn bản
      </label>
      <label className="check">
        <input type="checkbox" checked={flags.seal} onChange={(e) => setFlags({ ...flags, seal: e.target.checked })} />
        In con dấu công ty vào toàn bộ văn bản (dấu nằm trên chữ ký)
      </label>
      {slot('chu_ky', 'Chữ ký giám đốc', 'Chụp trên giấy trắng, app tự tách nền')}
      {slot('con_dau', 'Con dấu công ty', 'Chụp hoặc quét con dấu, app tự tách nền trắng')}
      <button className="btn primary" disabled={busy}>Lưu thông tin công ty</button>
      </fieldset>
    </form>
  );
}

function ImageSlot(props: { label: string; hint?: string; url: string | null; onPick: (f: File | undefined) => void; onRemove: () => void;
                           onReread?: () => void; reading?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="img-slot">
      <span className="img-slot-label">{props.label}</span>
      <div className="img-slot-row">
        <div className="img-slot-box">{props.url ? <img src={props.url} alt={props.label} /> : <span className="muted small">Chưa có</span>}</div>
        <button type="button" className="btn small" onClick={() => ref.current?.click()}>Chọn ảnh</button>
        {props.onReread && (
          <button type="button" className="btn small" aria-label={`Đọc lại ${props.label}`} disabled={!props.url || props.reading}
                  title={props.url ? 'AI đọc lại ảnh đã lưu' : 'Chưa có ảnh: bấm "Chọn ảnh" trước'} onClick={props.onReread}>Đọc lại</button>
        )}
        {props.url && <button type="button" className="btn small" onClick={props.onRemove}>Bỏ ảnh</button>}
        <input ref={ref} type="file" accept="image/*" hidden aria-label={`Ảnh ${props.label}`}
               onChange={(e) => { props.onPick(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {props.hint && <span className="muted small">{props.hint}</span>}
    </div>
  );
}
