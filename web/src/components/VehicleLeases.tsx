// Hợp đồng thuê xe trong hồ sơ xe: lập (số tự cấp …/năm/HĐTX-…), sửa, xem / in, chấm dứt. Mỗi chủ xe 1 hợp đồng, có thể nhiều xe.
// CCCD, chữ ký chủ xe để trống được, bổ sung sau (sửa hợp đồng). Lưu xong tự lưu PDF vào hồ sơ từng xe + Lưu trữ hồ sơ.
import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { PaperView, type Me } from './ProfilePapers';
import { fmtDate, today } from './Documents';
import { LEASE_COLS, leasePages, loadLeaseCtx, saveLeasePdf, type Lease, type Person } from '../lib/vehicleLease';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface V { id: string; plate: string; ownership: string; is_active: boolean; owner_name: string | null }
type P = Required<Pick<Person, 'name' | 'birth_year' | 'cccd' | 'cccd_on' | 'cccd_by' | 'address' | 'phone'>>;
interface Form {
  id: string | null; req: string; signed_on: string; start_on: string; end_on: string; pay_day: string; late_days: string; tax_party: '' | 'A' | 'B';
  a: P; joint: boolean; s: P; bank: { holder: string; account: string; bank: string }; dir: { cccd_on: string; cccd_by: string; phone: string };
  items: Record<string, string>;   // vehicle_id → giá thuê
}
const emptyP = (name = ''): P => ({ name, birth_year: '', cccd: '', cccd_on: '', cccd_by: '', address: '', phone: '' });
const addYear = (d: string) => { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y! + 1, m! - 1, dd!)); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };
const digits = (s: string) => s.replace(/\D/g, '');

export function VehicleLeases({ v, vehicles, tenantId, me, canEdit, onSaved }: { v: V; vehicles: V[]; tenantId: string; me: Me; canEdit: boolean; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const [list, setList] = useState<Lease[]>([]);
  const [f, setF] = useState<Form | null>(null);
  const [busy, setBusy] = useState('');
  const [view, setView] = useState<{ title: string; pages: string[] } | null>(null);

  const load = useCallback(async () => {
    const ids = ((await supabase.from('vehicle_lease_items').select('lease_id').eq('vehicle_id', v.id)).data ?? []) as { lease_id: string }[];
    if (!ids.length) { setList([]); return; }
    const r = await supabase.from('vehicle_leases').select(LEASE_COLS).in('id', ids.map((x) => x.lease_id)).order('signed_on', { ascending: false });
    setList(((r.data ?? []) as unknown as Lease[]).map((k) => ({ ...k, items: k.items.map((i) => ({ ...i, price: Number(i.price) })) })));
  }, [v.id]);
  useEffect(() => { if (canEdit) void load(); }, [load, canEdit]);
  if (!canEdit) return null;

  async function openNew() {
    const last = ((await supabase.from('vehicle_leases').select('director').order('created_at', { ascending: false }).limit(1)).data ?? [])[0] as { director?: Form['dir'] } | undefined;
    const s = today();
    setF({ id: null, req: crypto.randomUUID(), signed_on: s, start_on: s, end_on: addYear(s), pay_day: '5', late_days: '15', tax_party: '', a: emptyP(v.owner_name ?? ''), joint: false, s: emptyP(),
      bank: { holder: '', account: '', bank: '' }, dir: { cccd_on: last?.director?.cccd_on ?? '', cccd_by: last?.director?.cccd_by ?? '', phone: last?.director?.phone ?? '' }, items: { [v.id]: '' } });
  }
  function openEdit(k: Lease) {
    const p = (x?: Person | null): P => ({ ...emptyP(), ...Object.fromEntries(Object.entries(x ?? {}).map(([a, b]) => [a, String(b ?? '')])) }) as P;
    setF({ id: k.id, req: crypto.randomUUID(), signed_on: k.signed_on, start_on: k.start_on, end_on: k.end_on, pay_day: k.pay_day?.toString() ?? '', late_days: k.late_days?.toString() ?? '',
      tax_party: k.tax_party ?? '', a: p(k.lessor), joint: !!k.lessor.spouse?.name, s: p(k.lessor.spouse), bank: { holder: k.bank.holder ?? '', account: k.bank.account ?? '', bank: k.bank.bank ?? '' },
      dir: { cccd_on: k.director.cccd_on ?? '', cccd_by: k.director.cccd_by ?? '', phone: k.director.phone ?? '' },
      items: Object.fromEntries(k.items.map((i) => [i.vehicle_id, i.price ? String(i.price) : ''])) });
  }
  async function show(k: Lease) {
    setBusy('Đang dựng hợp đồng…');
    try { const x = await loadLeaseCtx(tenantId, me, k.items.map((i) => i.vehicle_id)); setView({ title: `Hợp đồng thuê xe ${k.number}`, pages: leasePages(k, x) }); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function save() {
    if (!f) return;
    if (!f.a.name.trim()) return toast('error', 'Nhập họ tên bên cho thuê');
    if (!Object.keys(f.items).length) return toast('error', 'Chọn ít nhất 1 xe');
    setBusy('Đang lưu hợp đồng…');
    try {
      const clean = (x: P) => Object.fromEntries(Object.entries(x).map(([k, val]) => [k, val.trim()]).filter(([, val]) => val));
      const p = { signed_on: f.signed_on, start_on: f.start_on, end_on: f.end_on, pay_day: f.pay_day, late_days: f.late_days, tax_party: f.tax_party,
        lessor: { ...clean(f.a), ...(f.joint && f.s.name.trim() ? { spouse: clean(f.s) } : {}) }, bank: f.bank, director: f.dir,
        items: Object.entries(f.items).map(([vehicle_id, price]) => ({ vehicle_id, price: Number(digits(price)) || 0 })) };
      const r = await rpc<{ id: string; number: string }>('save_vehicle_lease', { p_id: f.id, p, p_request_id: f.id ? null : f.req });
      setBusy('Đang lưu PDF vào hồ sơ xe…');
      const k = ((await supabase.from('vehicle_leases').select(LEASE_COLS).eq('id', r.id).single()).data as unknown as Lease);
      k.items = k.items.map((i) => ({ ...i, price: Number(i.price) }));
      const warn = await saveLeasePdf(tenantId, k, await loadLeaseCtx(tenantId, me, k.items.map((i) => i.vehicle_id)));
      toast(warn ? 'error' : 'ok', `Đã lưu hợp đồng ${r.number} và PDF vào hồ sơ xe${warn ? `; ${warn}` : ''}`);
      setF(null);
      await load(); await onSaved();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(''); }
  }
  async function stop(k: Lease) {
    if (!window.confirm(`Chấm dứt hợp đồng ${k.number}?`)) return;
    try { await rpc('set_vehicle_lease_status', { p_id: k.id, p_status: 'cham_dut' }); toast('ok', 'Đã chấm dứt hợp đồng'); await load(); }
    catch (e) { toast('error', errMsg(e)); }
  }

  const person = (x: P, set: (x: P) => void, who: string) => (
    <div className="grid2">
      <label>Họ tên {who}<input value={x.name} onChange={(e) => set({ ...x, name: e.target.value })} /></label>
      <label>Năm sinh<input inputMode="numeric" value={x.birth_year} onChange={(e) => set({ ...x, birth_year: digits(e.target.value).slice(0, 4) })} /></label>
      <label>Số CCCD (bổ sung sau được)<input inputMode="numeric" maxLength={12} value={x.cccd} onChange={(e) => set({ ...x, cccd: digits(e.target.value) })} /></label>
      <label>Ngày cấp<input type="date" value={x.cccd_on} onChange={(e) => set({ ...x, cccd_on: e.target.value })} /></label>
      <label>Nơi cấp<input value={x.cccd_by} onChange={(e) => set({ ...x, cccd_by: e.target.value })} /></label>
      <label>Địa chỉ thường trú<input value={x.address} onChange={(e) => set({ ...x, address: e.target.value })} /></label>
      <label>Số điện thoại<input inputMode="tel" value={x.phone} onChange={(e) => set({ ...x, phone: e.target.value })} /></label>
    </div>
  );
  const pick = vehicles.filter((x) => (x.is_active && x.ownership !== 'so_huu') || x.id === v.id || (f && x.id in f.items));

  return (
    <div className="sub">
      <div className="item-head"><h3>Hợp đồng thuê xe ({list.length})</h3>
        <button type="button" className="btn small primary" disabled={!!busy} onClick={() => void openNew()}>+ Lập hợp đồng thuê xe</button></div>
      {busy && <p className="small muted">{busy}</p>}
      {list.length === 0 && <p className="small muted">Xe thuê của cá nhân: lập hợp đồng để làm phù hiệu và hạch toán chi phí (căn cứ pháp lý trong mẫu: cần xác minh).</p>}
      <ul className="list small">
        {list.map((k) => (
          <li key={k.id} className="item"><div className="item-head">
            <div><b>{k.number}</b> · {k.lessor.name}{k.status === 'cham_dut' && <span className="badge locked">Đã chấm dứt</span>}
              <div className="muted">{fmtDate(k.start_on)} → {fmtDate(k.end_on)} · {k.items.length} xe{!k.lessor.cccd ? ' · chưa có CCCD chủ xe' : ''}</div></div>
            <div className="actions">
              <button type="button" className="btn small" aria-label={`Xem hợp đồng ${k.number}`} onClick={() => void show(k)}>Xem / in</button>
              {k.status === 'hieu_luc' && <button type="button" className="btn small" onClick={() => openEdit(k)}>Sửa</button>}
              {k.status === 'hieu_luc' && <button type="button" className="btn small link danger-text" onClick={() => void stop(k)}>Chấm dứt</button>}
            </div></div></li>
        ))}
      </ul>
      {f && (
        <Modal wide title={f.id ? 'Sửa hợp đồng thuê xe' : 'Lập hợp đồng thuê xe'} onClose={() => { if (!busy) setF(null); }}>
          <div className="form">
            <h3>Bên cho thuê (Bên A)</h3>
            {person(f.a, (a) => setF({ ...f, a }), 'chủ xe')}
            <label className="check"><input type="checkbox" checked={f.joint} onChange={(e) => setF({ ...f, joint: e.target.checked })} /> Xe là tài sản chung vợ chồng (cả hai cùng ký)</label>
            {f.joint && person(f.s, (s) => setF({ ...f, s }), 'vợ / chồng')}
            <h3>Xe cho thuê và giá thuê</h3>
            {pick.map((x) => (
              <div key={x.id} className="inline-form">
                <label className="check"><input type="checkbox" checked={x.id in f.items} aria-label={`Chọn xe ${x.plate}`}
                  onChange={(e) => { const it = { ...f.items }; if (e.target.checked) it[x.id] = ''; else delete it[x.id]; setF({ ...f, items: it }); }} /> <b>{x.plate}</b></label>
                {x.id in f.items && <label>Giá thuê (đ/tháng)<input inputMode="numeric" aria-label={`Giá thuê xe ${x.plate}`} value={f.items[x.id] ? Number(digits(f.items[x.id]!)).toLocaleString('vi-VN') : ''}
                  onChange={(e) => setF({ ...f, items: { ...f.items, [x.id]: digits(e.target.value) } })} /></label>}
              </div>
            ))}
            <h3>Thời hạn, thanh toán</h3>
            <div className="grid2">
              <label>Ngày ký<input type="date" value={f.signed_on} onChange={(e) => setF({ ...f, signed_on: e.target.value })} /></label>
              <label>Thuê từ ngày<input type="date" value={f.start_on} onChange={(e) => setF({ ...f, start_on: e.target.value, end_on: e.target.value ? addYear(e.target.value) : f.end_on })} /></label>
              <label>Đến hết ngày<input type="date" value={f.end_on} onChange={(e) => setF({ ...f, end_on: e.target.value })} /></label>
              <label>Trả tiền vào ngày (hằng tháng)<input inputMode="numeric" value={f.pay_day} onChange={(e) => setF({ ...f, pay_day: digits(e.target.value).slice(0, 2) })} /></label>
              <label>Chậm trả quá (ngày) thì Bên A được chấm dứt<input inputMode="numeric" value={f.late_days} onChange={(e) => setF({ ...f, late_days: digits(e.target.value).slice(0, 3) })} /></label>
              <label>Thuế cho thuê tài sản<select value={f.tax_party} onChange={(e) => setF({ ...f, tax_party: e.target.value as Form['tax_party'] })}>
                <option value="">Để trống (ghi tay)</option><option value="A">Bên A tự kê khai, nộp</option><option value="B">Bên B khấu trừ, nộp thay</option></select></label>
              <label>Chủ tài khoản<input value={f.bank.holder} onChange={(e) => setF({ ...f, bank: { ...f.bank, holder: e.target.value } })} /></label>
              <label>Số tài khoản<input inputMode="numeric" value={f.bank.account} onChange={(e) => setF({ ...f, bank: { ...f.bank, account: e.target.value } })} /></label>
              <label>Ngân hàng<input value={f.bank.bank} onChange={(e) => setF({ ...f, bank: { ...f.bank, bank: e.target.value } })} /></label>
            </div>
            <h3>Bên thuê (Bên B)</h3>
            <p className="small muted">Tên, mã số doanh nghiệp, địa chỉ, giám đốc, số CCCD giám đốc lấy từ Cấu hình › Thông tin công ty.</p>
            <div className="grid2">
              <label>Ngày cấp CCCD giám đốc<input type="date" value={f.dir.cccd_on} onChange={(e) => setF({ ...f, dir: { ...f.dir, cccd_on: e.target.value } })} /></label>
              <label>Nơi cấp<input value={f.dir.cccd_by} onChange={(e) => setF({ ...f, dir: { ...f.dir, cccd_by: e.target.value } })} placeholder="Cục CSQLHC về TTXH" /></label>
              <label>Số điện thoại Bên B<input inputMode="tel" value={f.dir.phone} onChange={(e) => setF({ ...f, dir: { ...f.dir, phone: e.target.value } })} /></label>
            </div>
            <div className="actions">
              <button type="button" className="btn primary" disabled={!!busy} onClick={() => void save()}>{busy || (f.id ? 'Lưu hợp đồng' : 'Lập & cấp số')}</button>
              <button type="button" className="btn link" disabled={!!busy} onClick={() => setF(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
      {view && <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: false }))} onClose={() => setView(null)} />}
    </div>
  );
}
