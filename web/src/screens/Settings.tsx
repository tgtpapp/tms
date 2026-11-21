import { PayMonths } from '../components/PayMonths';
import type { Me } from '../components/ProfilePapers';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { CompanyInfo } from './CompanyInfo';
import { LegacyImport } from './LegacyImport';
import { BackupPanel } from '../components/BackupPanel';
import { StorageUsage } from '../components/StorageUsage';
import { ZaloSettings } from '../components/ZaloSettings';
import { DriveSettings } from '../components/DriveSettings';
import { BANKS } from '../lib/vietqr';
import { supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

/** Cấu hình nghiệp vụ hiển thị trên màn hình. Giá trị mặc định nằm trong database. */
const SALE_SETTINGS = [
  { key: 'ban_ve.giu_ghe_quay_phut', label: 'Giữ ghế tại quầy (phút)', min: 1, max: 120 },
  { key: 'ban_ve.giu_ghe_online_phut', label: 'Giữ ghế đặt online / QR (phút)', min: 1, max: 120 },
  { key: 'ban_ve.nha_ghe_vexere_gio', label: 'Nhả ghế Vexere còn trống trước giờ chạy (giờ)', min: 0, max: 48 },
] as const;

type SaleKey = (typeof SALE_SETTINGS)[number]['key'];
const DOC_WARN = 'giay_to.canh_bao_truoc_ngay';
const DEFAULT_TYPE = 'chuyen.loai_xe_mac_dinh';
const AUTO_TRIPS = 'chuyen.tao_chuyen_trong';
/** Điều hành. Giới hạn giờ lái theo Luật TTATGT đường bộ 2024, đã sửa bởi Luật 118/2025 (cần xác minh) → để chỉnh được. */
const DISPATCH_SETTINGS = [
  { key: 'lai_xe.gio_lien_tuc_toi_da', label: 'Giờ lái liên tục tối đa', min: 1, max: 12 },
  { key: 'lai_xe.gio_ngay_toi_da', label: 'Giờ lái tối đa trong ngày', min: 1, max: 24 },
  { key: 'lai_xe.gio_tuan_toi_da', label: 'Giờ lái tối đa trong tuần', min: 1, max: 168 },
] as const;

/** Cấu hình nhà xe: thông tin doanh nghiệp + thông số bán vé. */
interface Tier { truoc_gio: number; phi_pt: number }

export function SettingsScreen({ tenantId, me, canSalary, canArchive }: { tenantId: string; me: Me; canSalary: boolean; canArchive: boolean }) {
  const toast = useToast();
  const [sale, setSale] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [vtypes, setVtypes] = useState<{ id: string; name: string; reg_seats: number; reg_berths: number }[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [s, vt] = await Promise.all([supabase.from('tenant_settings').select('key, value'),
      supabase.from('vehicle_types').select('id, name, reg_seats, reg_berths').eq('is_active', true).order('name')]);
    if (s.error) return toast('error', s.error.message);
    setVtypes((vt.data ?? []) as { id: string; name: string; reg_seats: number; reg_berths: number }[]);
    const values: Record<string, string> = {};
    for (const r of (s.data ?? []) as { key: string; value: unknown }[]) values[r.key] = typeof r.value === 'object' ? JSON.stringify(r.value) : String(r.value);
    setSale(values);
    setLoaded(true);
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

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

  async function saveOrder(e: FormEvent) {
    e.preventDefault();
    const suffix = (sale['lenh.hau_to'] ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{1,10}$/.test(suffix)) return toast('error', 'Hậu tố số lệnh: 1–10 chữ in hoa hoặc số, không dấu (vd TGTP)');
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([
      { key: 'lenh.hau_to', value: suffix },
      { key: 'cong_ty.giam_doc', value: (sale['cong_ty.giam_doc'] ?? '').trim() },
      { key: 'cong_ty.chuc_danh_ky', value: (sale['cong_ty.chuc_danh_ky'] ?? '').trim() || 'Giám đốc' },
    ], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu cấu hình lệnh vận chuyển');
    await load();
  }

  async function saveBooking(e: FormEvent) {
    e.preventDefault();
    const m = Number(sale['ban_ve.nha_dat_cho_truoc_phut']);
    if (!Number.isInteger(m) || m < 0 || m > 1440) return toast('error', 'Nhả chỗ đặt trước giờ chạy: số nguyên từ 0 đến 1440 phút');
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([
      { key: 'ban_ve.tu_nha_dat_cho', value: sale['ban_ve.tu_nha_dat_cho'] !== 'false' },
      { key: 'ban_ve.nha_dat_cho_truoc_phut', value: m },
      { key: 've.ghi_chu', value: (sale['ve.ghi_chu'] ?? '').trim() },
    ], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu cấu hình đặt chỗ và vé');
    await load();
  }

  const tiers: Tier[] = useMemo(() => {
    try { return JSON.parse(sale['huy_ve.moc'] ?? '[]') as Tier[]; } catch { return []; }
  }, [sale]);
  const setTiers = (t: Tier[]) => setSale({ ...sale, 'huy_ve.moc': JSON.stringify(t) });

  async function saveCancel(e: FormEvent) {
    e.preventDefault();
    const t = [...tiers].map((x) => ({ truoc_gio: Number(x.truoc_gio), phi_pt: Number(x.phi_pt) }))
      .sort((a, b) => b.truoc_gio - a.truoc_gio);
    if (t.some((x) => !Number.isInteger(x.truoc_gio) || x.truoc_gio < 0 || x.truoc_gio > 720 || !(x.phi_pt >= 0 && x.phi_pt <= 100))) {
      return toast('error', 'Mỗi mốc: số giờ 0–720 (số nguyên), phí 0–100%');
    }
    if (new Set(t.map((x) => x.truoc_gio)).size !== t.length) return toast('error', 'Các mốc giờ không được trùng');
    if (t.at(-1)?.truoc_gio !== 0) return toast('error', 'Phải có mốc 0 giờ (hủy sát giờ chạy)');
    const fee = Number(sale['doi_ve.phi_dong'] ?? 0);
    if (!Number.isInteger(fee) || fee < 0 || fee > 10000000) return toast('error', 'Phí đổi vé: số nguyên từ 0 đến 10.000.000');
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([
      { key: 'huy_ve.moc', value: t }, { key: 'doi_ve.phi_dong', value: fee },
    ], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu cấu hình hủy / đổi vé');
    await load();
  }

  async function saveBank(e: FormEvent) {
    e.preventDefault();
    const bin = (sale['tt.ngan_hang_bin'] ?? '').trim();
    const acc = (sale['tt.so_tai_khoan'] ?? '').replace(/\s/g, '');
    const name = (sale['tt.ten_tai_khoan'] ?? '').trim().toUpperCase();
    if (!/^[0-9]{6}$/.test(bin)) return toast('error', 'Chọn ngân hàng (hoặc nhập mã BIN 6 số)');
    if (!/^[0-9A-Za-z]{6,19}$/.test(acc)) return toast('error', 'Số tài khoản: 6–19 chữ số');
    if (name.length < 2) return toast('error', 'Nhập tên chủ tài khoản');
    setBusy(true);
    const { error } = await supabase.from('tenant_settings').upsert([
      { key: 'tt.ngan_hang_bin', value: bin }, { key: 'tt.so_tai_khoan', value: acc }, { key: 'tt.ten_tai_khoan', value: name },
    ], { onConflict: 'tenant_id,key' });
    setBusy(false);
    if (error) return toast('error', error.message);
    toast('ok', 'Đã lưu tài khoản nhận chuyển khoản');
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
    rows.push({ key: DEFAULT_TYPE, value: sale[DEFAULT_TYPE] ?? '' });
    // Tạo chuyến theo lịch: tự động cả năm (từ 01/12 tạo luôn năm sau) hoặc thủ công
    rows.push({ key: AUTO_TRIPS, value: sale[AUTO_TRIPS] === '0' ? 0 : 1 }, { key: 'chuyen.tao_ca_nam', value: 1 });
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


  return (
    <>
      <CompanyInfo tenantId={tenantId} />
      <ZaloSettings />
      <DriveSettings />
      {!loaded && <p className="muted">Đang tải cấu hình…</p>}
      {loaded && (<>
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
      <form className="card form" onSubmit={(e) => void saveBooking(e)}>
        <h2>Đặt chỗ trả sau và vé</h2>
        <label className="check">
          <input type="checkbox" checked={sale['ban_ve.tu_nha_dat_cho'] !== 'false'}
                 onChange={(e) => setSale({ ...sale, 'ban_ve.tu_nha_dat_cho': String(e.target.checked) })} />
          Tự nhả chỗ đặt chưa thanh toán (nhân viên vẫn chọn được "giữ đến giờ chạy" cho từng vé)
        </label>
        <label>Nhả chỗ đặt trước giờ chạy (phút)
          <input type="number" inputMode="numeric" min={0} max={1440} step={1} value={sale['ban_ve.nha_dat_cho_truoc_phut'] ?? ''}
                 onChange={(e) => setSale({ ...sale, 'ban_ve.nha_dat_cho_truoc_phut': e.target.value })} required />
        </label>
        <label>Ghi chú in cuối vé (quy định nhà xe)
          <textarea rows={2} maxLength={500} value={sale['ve.ghi_chu'] ?? ''} onChange={(e) => setSale({ ...sale, 've.ghi_chu': e.target.value })}
                    placeholder="vd: Có mặt trước giờ chạy 15 phút. Hotline: …" />
        </label>
        <button className="btn primary" disabled={busy}>Lưu cấu hình đặt chỗ và vé</button>
      </form>
      <form className="card form tiers" onSubmit={(e) => void saveCancel(e)}>
        <h2>Hủy / đổi vé</h2>
        {tiers.map((x, i) => (
          <div key={i} className="tier">
            <label>Hủy trước (giờ)
              <input type="number" inputMode="numeric" min={0} max={720} value={x.truoc_gio}
                     onChange={(e) => setTiers(tiers.map((y, j) => (j === i ? { ...y, truoc_gio: Number(e.target.value) } : y)))} />
            </label>
            <label>Phí (%)
              <input type="number" inputMode="numeric" min={0} max={100} value={x.phi_pt}
                     onChange={(e) => setTiers(tiers.map((y, j) => (j === i ? { ...y, phi_pt: Number(e.target.value) } : y)))} />
            </label>
            {tiers.length > 1 && <button type="button" className="btn small link" onClick={() => setTiers(tiers.filter((_, j) => j !== i))}>Xóa mốc</button>}
          </div>
        ))}
        <button type="button" className="btn small" onClick={() => setTiers([...tiers, { truoc_gio: 0, phi_pt: 100 }])}>Thêm mốc</button>
        <label>Phí đổi chuyến (đồng / vé đã thanh toán)
          <input type="number" inputMode="numeric" min={0} max={10000000} step={1000} value={sale['doi_ve.phi_dong'] ?? ''}
                 onChange={(e) => setSale({ ...sale, 'doi_ve.phi_dong': e.target.value })} required />
        </label>
        <button className="btn primary" disabled={busy}>Lưu cấu hình hủy / đổi vé</button>
      </form>
      <form className="card form" onSubmit={(e) => void saveBank(e)}>
        <h2>Tài khoản nhận chuyển khoản (QR)</h2>
        <label>Ngân hàng
          <select value={BANKS.some((b) => b.bin === sale['tt.ngan_hang_bin']) ? sale['tt.ngan_hang_bin'] : sale['tt.ngan_hang_bin'] ? 'khac' : ''}
                  onChange={(e) => setSale({ ...sale, 'tt.ngan_hang_bin': e.target.value === 'khac' ? '' : e.target.value })}>
            <option value="">Chọn ngân hàng</option>
            {BANKS.map((b) => <option key={b.bin} value={b.bin}>{b.name}</option>)}
            <option value="khac">Ngân hàng khác (nhập mã BIN)</option>
          </select>
        </label>
        {!BANKS.some((b) => b.bin === sale['tt.ngan_hang_bin']) && (
          <label>Mã BIN ngân hàng (6 số)
            <input inputMode="numeric" maxLength={6} value={sale['tt.ngan_hang_bin'] ?? ''} onChange={(e) => setSale({ ...sale, 'tt.ngan_hang_bin': e.target.value })} />
          </label>
        )}
        <label>Số tài khoản<input inputMode="numeric" value={sale['tt.so_tai_khoan'] ?? ''} onChange={(e) => setSale({ ...sale, 'tt.so_tai_khoan': e.target.value })} /></label>
        <label>Tên chủ tài khoản<input value={sale['tt.ten_tai_khoan'] ?? ''} onChange={(e) => setSale({ ...sale, 'tt.ten_tai_khoan': e.target.value.toUpperCase() })} /></label>
        <button className="btn primary" disabled={busy}>Lưu tài khoản nhận</button>
      </form>
      <form className="card form" onSubmit={(e) => void saveOrder(e)}>
        <h2>Lệnh vận chuyển</h2>
        <p className="muted small">Số lệnh: giờ chạy – ngày tháng năm / LVC – hậu tố, vd 0700-191126/LVC-TGTP. Tên công ty in trên lệnh lấy theo "Tên pháp lý" ở trên.</p>
        <label>Hậu tố số lệnh (viết tắt công ty)
          <input value={sale['lenh.hau_to'] ?? ''} maxLength={10} onChange={(e) => setSale({ ...sale, 'lenh.hau_to': e.target.value.toUpperCase() })} placeholder="vd: TGTP" required />
        </label>
        <label>Chức danh người ký lệnh
          <input value={sale['cong_ty.chuc_danh_ky'] ?? ''} onChange={(e) => setSale({ ...sale, 'cong_ty.chuc_danh_ky': e.target.value })} placeholder="Giám đốc" />
        </label>
        <label>Họ tên người ký lệnh
          <input value={sale['cong_ty.giam_doc'] ?? ''} onChange={(e) => setSale({ ...sale, 'cong_ty.giam_doc': e.target.value })} placeholder="vd: Hà Văn Thịnh" />
        </label>
        <button className="btn primary" disabled={busy}>Lưu cấu hình lệnh vận chuyển</button>
      </form>
      <form className="card form" onSubmit={(e) => void saveDispatch(e)}>
        <h2>Điều hành</h2>
        {DISPATCH_SETTINGS.map((d) => (
          <label key={d.key}>{d.label}
            <input type="number" inputMode="numeric" min={d.min} max={d.max} step={1}
                   value={sale[d.key] ?? ''} onChange={(e) => setSale({ ...sale, [d.key]: e.target.value })} required />
          </label>
        ))}
        <label>Tạo chuyến theo lịch chạy
          <select value={sale[AUTO_TRIPS] === '0' ? '0' : '1'} onChange={(e) => setSale({ ...sale, [AUTO_TRIPS]: e.target.value })}>
            <option value="1">Tự động: tạo sẵn đến hết năm, từ 01/12 tạo luôn cả năm sau</option>
            <option value="0">Thủ công: bấm "Tạo chuyến theo lịch" ở Điều hành khi cần</option>
          </select>
        </label>
        <label>Sơ đồ ghế mặc định khi chuyến chưa xếp xe
          <select value={sale[DEFAULT_TYPE] ?? ''} onChange={(e) => setSale({ ...sale, [DEFAULT_TYPE]: e.target.value })}>
            <option value="">Tự chọn loại xe 16 chỗ</option>
            {vtypes.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.reg_seats + t.reg_berths} chỗ)</option>)}
          </select>
        </label>
        <p className="muted small">Giới hạn giờ lái: cần xác minh theo Luật 118/2025.</p>
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
      </>)}
      {canSalary && <PayMonths tenantId={tenantId} me={me} canArchive={canArchive} />}
      <StorageUsage />
      <BackupPanel />
      <LegacyImport tenantId={tenantId} />
    </>
  );
}
