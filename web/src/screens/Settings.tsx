import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Profile {
  name: string;
  legal_name: string;
  tax_code: string;
  transport_license_no: string;
  address: string;
  phone: string;
}

const EMPTY_PROFILE: Profile = { name: '', legal_name: '', tax_code: '', transport_license_no: '', address: '', phone: '' };

/** Cấu hình nghiệp vụ hiển thị trên màn hình. Giá trị mặc định nằm trong database. */
const SALE_SETTINGS = [
  { key: 'ban_ve.giu_ghe_quay_phut', label: 'Giữ ghế tại quầy (phút)', min: 1, max: 120 },
  { key: 'ban_ve.giu_ghe_online_phut', label: 'Giữ ghế đặt online / QR (phút)', min: 1, max: 120 },
  { key: 'ban_ve.nha_ghe_vexere_gio', label: 'Nhả ghế Vexere còn trống trước giờ chạy (giờ)', min: 0, max: 48 },
] as const;

type SaleKey = (typeof SALE_SETTINGS)[number]['key'];
const DOC_WARN = 'giay_to.canh_bao_truoc_ngay';
/** Điều hành. Giới hạn giờ lái theo Luật TTATGT đường bộ 2024, đã sửa bởi Luật 118/2025 (cần xác minh) → để chỉnh được. */
const DISPATCH_SETTINGS = [
  { key: 'chuyen.tao_truoc_ngay', label: 'Tự tạo chuyến trước (ngày, tối đa 365)', min: 1, max: 365 },
  { key: 'lai_xe.gio_lien_tuc_toi_da', label: 'Giờ lái liên tục tối đa', min: 1, max: 12 },
  { key: 'lai_xe.gio_ngay_toi_da', label: 'Giờ lái tối đa trong ngày', min: 1, max: 24 },
  { key: 'lai_xe.gio_tuan_toi_da', label: 'Giờ lái tối đa trong tuần', min: 1, max: 168 },
] as const;

/** Cấu hình nhà xe: thông tin doanh nghiệp + thông số bán vé. */
export function SettingsScreen() {
  const toast = useToast();
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [sale, setSale] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [t, s] = await Promise.all([
      supabase.from('tenants').select('name, legal_name, tax_code, transport_license_no, address, phone').maybeSingle(),
      supabase.from('tenant_settings').select('key, value'),
    ]);
    if (t.error || s.error) return toast('error', (t.error ?? s.error)!.message);
    const row = (t.data ?? {}) as Partial<Record<keyof Profile, string | null>>;
    setProfile({
      name: row.name ?? '', legal_name: row.legal_name ?? '', tax_code: row.tax_code ?? '',
      transport_license_no: row.transport_license_no ?? '', address: row.address ?? '', phone: row.phone ?? '',
    });
    const values: Record<string, string> = {};
    for (const r of (s.data ?? []) as { key: string; value: unknown }[]) values[r.key] = String(r.value);
    setSale(values);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await rpc('update_tenant_profile', {
        p_name: profile.name, p_legal_name: profile.legal_name, p_tax_code: profile.tax_code,
        p_transport_license_no: profile.transport_license_no, p_address: profile.address, p_phone: profile.phone,
      });
      toast('ok', 'Đã lưu thông tin doanh nghiệp');
      await load();
    } catch (err) {
      toast('error', errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveSale(e: FormEvent) {
    e.preventDefault();
    for (const s of SALE_SETTINGS) {
      const v = Number(sale[s.key]);
      if (!Number.isInteger(v) || v < s.min || v > s.max) {
        return toast('error', `${s.label}: nhập số nguyên từ ${s.min} đến ${s.max}`);
      }
    }
    setBusy(true);
    const rows = SALE_SETTINGS.map((s) => ({ key: s.key as SaleKey, value: Number(sale[s.key]) }));
    const { error } = await supabase.from('tenant_settings').upsert(rows, { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu cấu hình bán vé');
    await load();
  }

  async function saveDispatch(e: FormEvent) {
    e.preventDefault();
    const rows = [];
    for (const d of DISPATCH_SETTINGS) {
      const v = Number(sale[d.key]);
      if (!Number.isInteger(v) || v < d.min || v > d.max) return toast('error', `${d.label}: số nguyên từ ${d.min} đến ${d.max}`);
      rows.push({ key: d.key, value: v });
    }
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert(rows, { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu cấu hình điều hành');
    await load();
  }

  async function saveDoc(e: FormEvent) {
    e.preventDefault();
    const v = Number(sale[DOC_WARN]);
    if (!Number.isInteger(v) || v < 1 || v > 180) return toast('error', 'Số ngày cảnh báo phải là số nguyên từ 1 đến 180');
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([{ key: DOC_WARN, value: v }], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu cấu hình giấy tờ');
    await load();
  }

  const setP = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) => setProfile({ ...profile, [k]: e.target.value });

  return (
    <>
      <form className="card form" onSubmit={saveProfile}>
        <h2>Thông tin doanh nghiệp</h2>
        <div className="grid2">
          <label>Tên nhà xe<input value={profile.name} onChange={setP('name')} required /></label>
          <label>Tên pháp lý (theo đăng ký kinh doanh)<input value={profile.legal_name} onChange={setP('legal_name')} /></label>
          <label>Mã số thuế<input value={profile.tax_code} onChange={setP('tax_code')} inputMode="numeric" /></label>
          <label>Số giấy phép kinh doanh vận tải<input value={profile.transport_license_no} onChange={setP('transport_license_no')} /></label>
          <label>Địa chỉ<input value={profile.address} onChange={setP('address')} /></label>
          <label>Điện thoại<input value={profile.phone} onChange={setP('phone')} inputMode="tel" /></label>
        </div>
        <button className="btn primary" disabled={busy}>Lưu thông tin</button>
      </form>
      <form className="card form" onSubmit={saveSale}>
        <h2>Bán vé</h2>
        <div className="grid2">
          {SALE_SETTINGS.map((s) => (
            <label key={s.key}>{s.label}
              <input type="number" inputMode="numeric" min={s.min} max={s.max} step={1}
                     value={sale[s.key] ?? ''} onChange={(e) => setSale({ ...sale, [s.key]: e.target.value })} required />
            </label>
          ))}
        </div>
        <button className="btn primary" disabled={busy}>Lưu cấu hình bán vé</button>
      </form>
      <form className="card form" onSubmit={(e) => void saveDispatch(e)}>
        <h2>Điều hành</h2>
        {DISPATCH_SETTINGS.map((d) => (
          <label key={d.key}>{d.label}
            <input type="number" inputMode="numeric" min={d.min} max={d.max} step={1}
                   value={sale[d.key] ?? ''} onChange={(e) => setSale({ ...sale, [d.key]: e.target.value })} required />
          </label>
        ))}
        <p className="muted small">Giới hạn giờ lái: Luật TTATGT đường bộ 2024 (Điều 64), đã được sửa bởi Luật số 118/2025 từ 01/7/2026 – cần xác minh con số đang áp dụng.</p>
        <button className="btn primary" disabled={busy}>Lưu cấu hình điều hành</button>
      </form>
      <form className="card form" onSubmit={(e) => void saveDoc(e)}>
        <h2>Giấy tờ</h2>
        <label>Cảnh báo giấy tờ sắp hết hạn trước (ngày)
          <input type="number" inputMode="numeric" min={1} max={180} step={1} value={sale[DOC_WARN] ?? ''}
                 onChange={(e) => setSale({ ...sale, [DOC_WARN]: e.target.value })} required />
        </label>
        <button className="btn primary" disabled={busy}>Lưu cấu hình giấy tờ</button>
      </form>
    </>
  );
}
