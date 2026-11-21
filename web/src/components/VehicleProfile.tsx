// Lý lịch phương tiện kinh doanh vận tải (như app cũ): xem, nhập sự cố; in / lưu vào hồ sơ qua lib/profilePapers.
// Thông tin xe, kiểm định, tai nạn lái xe, số chuyến theo tháng lấy sẵn từ dữ liệu app. Mẫu sổ theo quy định hiện hành: cần xác minh.
import { useCallback, useEffect, useState } from 'react';
import { fmtDate } from './Documents';
import { errMsg, fetchAll, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { PaperActions, type Me } from './ProfilePapers';

interface V {
  id: string; plate: string; vehicle_type_id: string; chassis_no: string | null; engine_no: string | null; country_of_origin: string | null;
  manufacture_year: number | null; business_type: string; acquired_on: string | null; gsht_provider: string | null; gsht_device_no: string | null;
  camera_provider: string | null; camera_device_no: string | null;
}
interface Extra { gsht_account: string | null; odo_start: number | null; odo_date: string | null; retired_on: string | null }
interface Doc { doc_type: string; doc_no: string | null; issuer: string | null; issued_on: string | null; valid_from: string | null; expires_on: string | null; is_current: boolean; data: Record<string, unknown> }
interface Inc { id: string; occurred_on: string; place: string | null; summary: string; damage: string | null; resolution: string | null; from?: string }
interface VType { name: string; brand: string | null; model_code: string | null; reg_seats: number; reg_berths: number; reg_standing: number | null; gross_weight_kg: number | null }

const BUSINESS: Record<string, string> = { tuyen_co_dinh: 'Tuyến cố định', hop_dong: 'Xe hợp đồng', ca_hai: 'Tuyến cố định + Xe hợp đồng' };
const EMPTY_INC = { occurred_on: '', place: '', summary: '', damage: '', resolution: '' };

export function VehicleProfile({ v, canEdit, tenantId, me, canSave }: { v: V; canEdit: boolean; tenantId: string; me: Me; canSave: boolean }) {
  const toast = useToast();
  const [ex, setEx] = useState<Extra>({ gsht_account: null, odo_start: null, odo_date: null, retired_on: null });
  const [type, setType] = useState<VType | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [inc, setInc] = useState<Inc[]>([]);
  const [months, setMonths] = useState<{ m: string; days: number; trips: number; km: number | null; run: number }[]>([]);
  const [rep, setRep] = useState<{ repaired_on: string; odo_km: number | null; workshop: string | null; text: string; cost: number }[]>([]);
  const [f, setF] = useState(EMPTY_INC);

  const load = useCallback(async () => {
    const [e, t, d, i, a, tr] = await Promise.all([
      supabase.from('vehicles').select('gsht_account, odo_start, odo_date, retired_on').eq('id', v.id).maybeSingle(),
      supabase.from('vehicle_types').select('name, brand, model_code, reg_seats, reg_berths, reg_standing, gross_weight_kg').eq('id', v.vehicle_type_id).maybeSingle(),
      supabase.from('documents').select('doc_type, doc_no, issuer, issued_on, valid_from, expires_on, is_current, data').eq('vehicle_id', v.id),
      supabase.from('vehicle_incidents').select('id, occurred_on, place, summary, damage, resolution').eq('vehicle_id', v.id).order('occurred_on'),
      supabase.from('staff_records').select('id, occurred_on, title, data').eq('vehicle_id', v.id).eq('kind', 'tai_nan'),
      supabase.from('trips').select('service_date').eq('vehicle_id', v.id).eq('status', 'mo'),
    ]);
    if (e.data) setEx(e.data as Extra);
    setType((t.data ?? null) as VType | null);
    setDocs((d.data ?? []) as Doc[]);
    const acc = ((a.data ?? []) as { id: string; occurred_on: string; title: string; data: Record<string, unknown> }[]).map((x) => ({
      id: x.id, occurred_on: x.occurred_on, place: String(x.data?.dia_diem ?? '') || null, summary: x.title,
      damage: String(x.data?.thiet_hai ?? '') || null, resolution: String(x.data?.xu_ly ?? '') || null, from: 'Lý lịch hành nghề lái xe',
    }));
    setInc([...((i.data ?? []) as Inc[]), ...acc].sort((x, y) => x.occurred_on.localeCompare(y.occurred_on)));
    const M: Record<string, { days: Set<string>; trips: number }> = {};
    for (const r of (tr.data ?? []) as { service_date: string }[]) {
      const m = r.service_date.slice(0, 7);
      (M[m] ??= { days: new Set(), trips: 0 }).trips++;
      M[m].days.add(r.service_date);
    }
    const kms = await fetchAll<{ run_date: string; km: number }>(() => supabase.from('vehicle_km').select('run_date, km').eq('vehicle_id', v.id).order('run_date')).catch(() => []);
    const K: Record<string, { km: number; days: number }> = {};
    for (const r of kms) { const m = r.run_date.slice(0, 7); (K[m] ??= { km: 0, days: 0 }).km += Number(r.km); if (Number(r.km) > 0) K[m].days++; }
    const odoDate = (e.data as Extra | null)?.odo_date ?? null;
    let run = 0;
    setMonths([...new Set([...Object.keys(M), ...Object.keys(K)])].sort().map((m) => {
      run += kms.filter((r) => r.run_date.slice(0, 7) === m && (!odoDate || r.run_date >= odoDate)).reduce((a, r) => a + Number(r.km), 0);
      return { m, days: Math.max(M[m]?.days.size ?? 0, K[m]?.days ?? 0), trips: M[m]?.trips ?? 0, km: K[m]?.km ?? null, run };
    }));
    const ro = await supabase.from('repair_orders').select('id, repaired_on, odo_km, workshop').eq('vehicle_id', v.id).order('repaired_on');
    const ros = (ro.data ?? []) as { id: string; repaired_on: string; odo_km: number | null; workshop: string | null }[];
    const ri = ros.length ? await supabase.from('repair_items').select('order_id, content, qty, unit_price').in('order_id', ros.map((x) => x.id)).order('seq') : null;
    const its = (ri?.data ?? []) as { order_id: string; content: string; qty: number; unit_price: number }[];
    setRep(ros.map((o) => {
      const l = its.filter((x) => x.order_id === o.id);
      return { repaired_on: o.repaired_on, odo_km: o.odo_km, workshop: o.workshop, text: l.map((x) => `${x.content}${Number(x.qty) > 1 ? ` (x${x.qty})` : ''}`).join('; '),
        cost: l.reduce((a, x) => a + Number(x.qty) * Number(x.unit_price), 0) };
    }));
  }, [v.id, v.vehicle_type_id]);
  useEffect(() => { void load(); }, [load]);

  const doc = (code: string) => docs.find((d) => d.doc_type === code && d.is_current);
  const dk = doc('dang_ky'), kd = doc('kiem_dinh');
  const kdAll = docs.filter((d) => d.doc_type === 'kiem_dinh').sort((a, b) => String(a.expires_on ?? '').localeCompare(String(b.expires_on ?? '')));
  const seats = type ? `${type.reg_seats} chỗ ngồi${type.reg_berths ? ` · ${type.reg_berths} chỗ nằm` : ''}${type.reg_standing ? ` · ${type.reg_standing} chỗ đứng` : ''}` : '';
  const brand = [type?.brand, type?.model_code].filter(Boolean).join(' / ') || type?.name || '';
  const info: [string, string][] = [
    ['Biển kiểm soát', v.plate], ['Nhãn hiệu / số loại', brand], ['Số khung', v.chassis_no ?? ''], ['Số máy', v.engine_no ?? ''],
    ['Năm sản xuất', v.manufacture_year ? String(v.manufacture_year) : ''], ['Nước sản xuất', v.country_of_origin ?? ''], ['Số chỗ', seats],
    ['Tải trọng (kg)', type?.gross_weight_kg ? String(type.gross_weight_kg) : ''], ['Loại hình kinh doanh', BUSINESS[v.business_type] ?? ''],
    ['Giấy đăng ký xe', [dk?.doc_no, dk?.issued_on ? `cấp ${fmtDate(dk.issued_on)}` : '', dk?.issuer].filter(Boolean).join(' · ')],
    ['Số GCN kiểm định', kd?.doc_no ?? ''], ['Hạn đăng kiểm', kd?.expires_on ? fmtDate(kd.expires_on) : ''],
    ['Hạn BHDS', doc('bh_tnds')?.expires_on ? fmtDate(doc('bh_tnds')!.expires_on!) : ''], ['Hạn BHVC', doc('bh_vat_chat')?.expires_on ? fmtDate(doc('bh_vat_chat')!.expires_on!) : ''],
    ['GPS', [v.gsht_provider, v.gsht_device_no, ex.gsht_account].filter(Boolean).join(' · ')], ['Hạn phù hiệu', doc('phu_hieu')?.expires_on ? fmtDate(doc('phu_hieu')!.expires_on!) : ''],
  ];

  async function saveExtra() {
    const { error } = await supabase.from('vehicles').update({ gsht_account: ex.gsht_account || null, odo_start: ex.odo_start ?? null, odo_date: ex.odo_date || null, retired_on: ex.retired_on || null }).eq('id', v.id);
    if (error) return toast('error', errMsg(error));
    toast('ok', 'Đã lưu thông tin lý lịch xe');
  }
  async function addInc() {
    if (!f.occurred_on || !f.summary.trim()) return toast('error', 'Nhập ngày xảy ra và tóm tắt sự cố');
    const { error } = await supabase.from('vehicle_incidents').insert({ vehicle_id: v.id, occurred_on: f.occurred_on, place: f.place || null, summary: f.summary.trim(),
      damage: f.damage || null, resolution: f.resolution || null });
    if (error) return toast('error', errMsg(error));
    setF(EMPTY_INC);
    toast('ok', 'Đã ghi sự cố / tai nạn');
    await load();
  }
  async function delInc(id: string) {
    const { error } = await supabase.from('vehicle_incidents').delete().eq('id', id);
    if (error) return toast('error', errMsg(error));
    await load();
  }


  return (
    <div className="sub">
      <div className="item-head">
        <h3>Lý lịch phương tiện</h3>
      </div>
      <PaperActions kind="vehicle" id={v.id} label={v.plate} tenantId={tenantId} me={me} canSave={canSave} />
      <div className="vp-sum">{info.map(([l, x]) => <div key={l}><small>{l}</small><b>{x || <span className="muted">—</span>}</b></div>)}</div>
      {canEdit && (
        <div className="grid2 form">
          <label>GPS: tài khoản truy cập<input value={ex.gsht_account ?? ''} onChange={(e) => setEx({ ...ex, gsht_account: e.target.value })} /></label>
          <label>Số km (Odo) lúc bắt đầu theo dõi<input type="number" min={0} inputMode="numeric" value={ex.odo_start ?? ''} onChange={(e) => setEx({ ...ex, odo_start: e.target.value ? Number(e.target.value) : null })} /></label>
          <label>Ngày ghi Odo<input type="date" value={ex.odo_date ?? ''} onChange={(e) => setEx({ ...ex, odo_date: e.target.value })} /></label>
          <label>Ngày ngừng hoạt động / thanh lý<input type="date" value={ex.retired_on ?? ''} onChange={(e) => setEx({ ...ex, retired_on: e.target.value })} /></label>
          <div className="actions"><button type="button" className="btn small primary" onClick={() => void saveExtra()}>Lưu thông tin lý lịch</button></div>
        </div>
      )}
      <h4>Quá trình hoạt động (số chuyến theo tháng)</h4>
      {months.length ? (
        <table className="plist small"><thead><tr><th>Tháng</th><th>Số ngày hoạt động</th><th>Số chuyến</th></tr></thead>
          <tbody>{months.map((r) => <tr key={r.m}><td>{r.m.slice(5)}/{r.m.slice(0, 4)}</td><td>{r.days}</td><td>{r.trips}</td></tr>)}</tbody></table>
      ) : <p className="muted small">Chưa có chuyến nào xếp xe này.</p>}
      <h4>Kiểm định kỹ thuật (đăng kiểm)</h4>
      {kdAll.length ? (
        <table className="plist small"><thead><tr><th>Lần</th><th>Ngày kiểm định</th><th>Ngày hết hạn</th><th>Số GCN</th></tr></thead>
          <tbody>{kdAll.map((d, i) => <tr key={i}><td>Lần {i + 1}</td><td>{d.valid_from || d.issued_on ? fmtDate((d.valid_from || d.issued_on)!) : ''}</td><td>{d.expires_on ? fmtDate(d.expires_on) : ''}</td><td>{d.doc_no}</td></tr>)}</tbody></table>
      ) : <p className="muted small">Chưa có giấy kiểm định (thêm ở phần Giấy tờ của xe).</p>}
      <h4>Tai nạn giao thông &amp; sự cố kỹ thuật</h4>
      {inc.length > 0 && (
        <table className="plist small"><thead><tr><th>Ngày</th><th>Địa điểm</th><th>Tóm tắt</th><th>Thiệt hại</th><th>Xử lý</th><th /></tr></thead>
          <tbody>{inc.map((x) => (
            <tr key={x.id}><td>{fmtDate(x.occurred_on)}</td><td>{x.place}</td><td>{x.summary}{x.from && <div className="muted small">{x.from}</div>}</td><td>{x.damage}</td><td>{x.resolution}</td>
              <td>{canEdit && !x.from && <button type="button" className="btn small link danger-text" onClick={() => void delInc(x.id)}>Xóa</button>}</td></tr>
          ))}</tbody></table>
      )}
      {canEdit && (
        <div className="grid2 form">
          <label>Ngày xảy ra<input type="date" value={f.occurred_on} onChange={(e) => setF({ ...f, occurred_on: e.target.value })} /></label>
          <label>Địa điểm<input value={f.place} onChange={(e) => setF({ ...f, place: e.target.value })} /></label>
          <label>Tóm tắt sự cố / tai nạn<input value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></label>
          <label>Mức độ thiệt hại<input value={f.damage} onChange={(e) => setF({ ...f, damage: e.target.value })} /></label>
          <label>Kết quả xử lý / khắc phục<input value={f.resolution} onChange={(e) => setF({ ...f, resolution: e.target.value })} /></label>
          <div className="actions"><button type="button" className="btn small" onClick={() => void addInc()}>+ Thêm sự cố</button></div>
        </div>
      )}
      <p className="muted small">{rep.length} phiếu bảo dưỡng / sửa chữa · mẫu sổ: cần xác minh.</p>

    </div>
  );
}
