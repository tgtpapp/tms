// Niêm yết trên xe + hướng dẫn sử dụng thiết bị giám sát hành trình (in theo từng xe) và hồ sơ kê khai giá cước theo năm
// (tải bản scan lên Lưu trữ hồ sơ › Năm › Pháp lý công ty › Kê khai giá cước).
import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import { PaperView } from './ProfilePapers';
import { ensurePath } from '../lib/dispatchPapers';
import { dirName, reverseItinerary } from '../lib/routes';
import { drive, fileToBase64, openBase64 } from '../lib/drive';
import type { Permissions } from '../lib/permissions';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Route { id: string; name: string; name_ve: string | null; itinerary: string | null; itinerary_ve: string | null; is_active: boolean }
interface Veh { id: string; plate: string; gsht_provider: string | null; gsht_device_no: string | null }
interface Co { name: string; phone: string; hotline: string; address: string }
interface Fare { from: string | null; to: string | null; price: number }
interface Kk { id: string; name: string; file_name: string | null; mime: string | null; created_at: string }

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const todayIso = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
const money = (n: number) => n.toLocaleString('vi-VN');
const KK_PATH = (y: string) => [y, '01. Pháp lý công ty', 'Kê khai giá cước'];
const bare = (x: string) => x.trim().toLowerCase().replace(/^\d+\s*[.)\-]\s*/, '');

async function loadCo(): Promise<Co> {
  const [t, s] = await Promise.all([
    supabase.from('tenants').select('name, legal_name, phone, address').maybeSingle(),
    supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.hotline', 'cong_ty.dien_thoai']),
  ]);
  const d = (t.data ?? {}) as { name?: string; legal_name?: string | null; phone?: string | null; address?: string | null };
  const set = (k: string) => String(((s.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value ?? '');
  return { name: d.legal_name || d.name || '', phone: set('cong_ty.dien_thoai') || d.phone || '', hotline: set('cong_ty.hotline') || d.phone || '', address: d.address ?? '' };
}
/** Bảng giá đang áp dụng của tuyến theo chiều (bảng có ngày bắt đầu gần nhất còn hiệu lực). */
async function loadFares(routeId: string): Promise<Record<'di' | 've', Fare[]>> {
  const d = todayIso();
  const [t, st] = await Promise.all([
    supabase.from('fare_tables').select('id, direction, valid_from, valid_to').eq('route_id', routeId).lte('valid_from', d).order('valid_from', { ascending: false }),
    supabase.from('stops').select('id, name'),
  ]);
  const name = (id: string | null) => (id ? ((st.data ?? []) as { id: string; name: string }[]).find((x) => x.id === id)?.name ?? '' : null);
  const out: Record<'di' | 've', Fare[]> = { di: [], ve: [] };
  for (const dir of ['di', 've'] as const) {
    const cur = ((t.data ?? []) as { id: string; direction: string; valid_to: string | null }[]).find((x) => x.direction === dir && (!x.valid_to || x.valid_to >= d));
    if (!cur) continue;
    const it = await supabase.from('fare_table_items').select('seq, from_stop_id, to_stop_id, price').eq('table_id', cur.id).order('seq');
    out[dir] = ((it.data ?? []) as { from_stop_id: string | null; to_stop_id: string | null; price: number }[])
      .map((x) => ({ from: name(x.from_stop_id), to: name(x.to_stop_id), price: Number(x.price) }));
  }
  return out;
}

function fareTable(title: string, list: Fare[]): string {
  if (!list.length) return '';
  const b = 'border:1px solid #000;padding:4px 8px;font-size:15px';
  return `<div style="flex:1;min-width:0"><div style="font-weight:bold;font-size:16px;margin:4px 0">${esc(title)}</div>
    <table style="width:100%;border-collapse:collapse">${list.map((f) => `<tr><td style="${b}">${f.from ? `${esc(f.from)} → ${esc(f.to)}` : 'Toàn tuyến'}</td>
    <td style="${b};text-align:right;white-space:nowrap"><b>${money(f.price)} đ</b></td></tr>`).join('')}</table></div>`;
}
/** Tờ niêm yết dán trên xe (khổ ngang): đơn vị, điện thoại, đường dây nóng, biển số, tuyến, hành trình, giá cước, khẩu hiệu. */
function noticePage(co: Co, r: Route, v: Veh, fares: Record<'di' | 've', Fare[]>): string {
  const goName = dirName(r, 'di'), backName = dirName(r, 've');
  const itVe = r.itinerary_ve || (r.itinerary ? reverseItinerary(r.itinerary) : '');
  return `<div style="font-size:15px;line-height:1.45;border:3px double #000;padding:14px 18px">
    <div style="text-align:center;font-size:22px;font-weight:bold">${esc(co.name.toUpperCase())}</div>
    <div style="text-align:center;font-size:15px">Điện thoại: <b>${esc(co.phone || '……………')}</b> &nbsp;·&nbsp; Đường dây nóng: <b>${esc(co.hotline || '……………')}</b></div>
    <div style="display:flex;justify-content:space-between;margin:10px 0 4px;font-size:18px"><div>TUYẾN: <b>${esc(goName.toUpperCase())}</b></div><div>BIỂN SỐ XE: <b>${esc(v.plate)}</b></div></div>
    ${r.itinerary ? `<div><b>Hành trình chiều đi:</b> ${esc(r.itinerary)}</div>` : ''}${itVe ? `<div><b>Hành trình chiều về:</b> ${esc(itVe)}</div>` : ''}
    <div style="text-align:center;font-size:18px;font-weight:bold;margin:10px 0 4px">GIÁ CƯỚC</div>
    <div style="display:flex;gap:16px">${fareTable(`Chiều đi: ${goName}`, fares.di)}${fareTable(`Chiều về: ${backName}`, fares.ve)}</div>
    ${!fares.di.length && !fares.ve.length ? '<div style="text-align:center">(Chưa có bảng giá đang áp dụng)</div>' : ''}
    <div style="text-align:center;font-size:22px;font-weight:bold;margin-top:14px;color:#b91c1c">TÍNH MẠNG CON NGƯỜI LÀ TRÊN HẾT</div></div>`;
}
/** Hướng dẫn sử dụng thiết bị giám sát hành trình (dán trên xe). */
function gshtPage(co: Co, v: Veh): string {
  const steps = [
    'Trước khi xe chạy: kiểm tra đèn nguồn, đèn tín hiệu định vị (GPS) và kết nối (GSM) của thiết bị sáng bình thường.',
    'Bắt đầu ca lái: lái xe đăng nhập bằng cách chạm (quẹt) thẻ giấy phép lái xe vào đầu đọc thẻ của thiết bị, chờ thiết bị báo đăng nhập thành công.',
    'Đổi lái xe: lái xe đang lái chạm thẻ để đăng xuất; lái xe tiếp theo chạm thẻ của mình để đăng nhập.',
    'Kết thúc ca lái: chạm thẻ để đăng xuất.',
    'Không tự ý tháo, che chắn, ngắt nguồn thiết bị, anten; không can thiệp làm sai lệch dữ liệu của thiết bị.',
    'Khi thiết bị báo lỗi, mất tín hiệu hoặc không đăng nhập được: báo ngay cho bộ phận điều hành theo số điện thoại bên dưới.',
  ];
  return `<div style="font-size:16px;line-height:1.55;border:3px double #000;padding:16px 20px">
    <div style="text-align:center;font-size:20px;font-weight:bold">${esc(co.name.toUpperCase())}</div>
    <div style="text-align:center;font-size:22px;font-weight:bold;margin:10px 0 2px">HƯỚNG DẪN SỬ DỤNG<br>THIẾT BỊ GIÁM SÁT HÀNH TRÌNH</div>
    <div style="text-align:center;margin-bottom:10px">Xe: <b>${esc(v.plate)}</b>${v.gsht_provider ? ` &nbsp;·&nbsp; Nhà cung cấp: <b>${esc(v.gsht_provider)}</b>` : ''}${v.gsht_device_no ? ` &nbsp;·&nbsp; Số thiết bị: <b>${esc(v.gsht_device_no)}</b>` : ''}</div>
    <ol style="margin:0;padding-left:26px">${steps.map((s) => `<li style="margin:6px 0">${s}</li>`).join('')}</ol>
    <div style="margin-top:14px;text-align:center;font-size:17px">Điều hành: <b>${esc(co.phone || '……………')}</b> &nbsp;·&nbsp; Đường dây nóng: <b>${esc(co.hotline || '……………')}</b></div></div>`;
}

export function PriceNotice({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [vehs, setVehs] = useState<Veh[]>([]);
  const [dlg, setDlg] = useState<'' | 'ny' | 'gsht' | 'kk'>('');
  const [route, setRoute] = useState('');
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [view, setView] = useState<{ title: string; pages: string[]; land: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void Promise.all([
      supabase.from('routes').select('id, name, name_ve, itinerary, itinerary_ve, is_active').eq('is_active', true).order('code'),
      supabase.from('vehicles').select('id, plate, gsht_provider, gsht_device_no').eq('is_active', true).is('retired_on', null).order('plate'),
    ]).then(([r, v]) => { setRoutes((r.data ?? []) as Route[]); setVehs((v.data ?? []) as Veh[]); });
  }, []);
  const open = (k: 'ny' | 'gsht') => { setPick(new Set(vehs.map((v) => v.id))); setRoute((x) => x || routes[0]?.id || ''); setDlg(k); };
  async function make() {
    const list = vehs.filter((v) => pick.has(v.id));
    if (!list.length) return toast('error', 'Chọn ít nhất 1 xe');
    setBusy(true);
    try {
      const co = await loadCo();
      if (dlg === 'ny') {
        const r = routes.find((x) => x.id === route);
        if (!r) return toast('error', 'Chọn tuyến');
        const fares = await loadFares(r.id);
        setView({ title: `Niêm yết trên xe · ${r.name}`, pages: list.map((v) => noticePage(co, r, v, fares)), land: true });
      } else setView({ title: 'Hướng dẫn sử dụng thiết bị giám sát hành trình', pages: list.map((v) => gshtPage(co, v)), land: false });
      setDlg('');
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  const toggle = (id: string) => setPick((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <section className="card">
      <div className="item-head">
        <h2>Niêm yết &amp; kê khai giá</h2>
        <div className="actions">
          <button className="btn small" onClick={() => open('ny')}>In niêm yết trên xe</button>
          <button className="btn small" onClick={() => open('gsht')}>In hướng dẫn GSHT</button>
          {perms.has('archive.view') || perms.has('archive.manage') ? <button className="btn small" onClick={() => setDlg('kk')}>Hồ sơ kê khai giá</button> : null}
        </div>
      </div>
      {(dlg === 'ny' || dlg === 'gsht') && (
        <Modal title={dlg === 'ny' ? 'In niêm yết trên xe' : 'In hướng dẫn sử dụng thiết bị giám sát hành trình'} onClose={() => setDlg('')}>
          {dlg === 'ny' && <label>Tuyến<select value={route} onChange={(e) => setRoute(e.target.value)}>{routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
          <div className="item-head"><b>Xe ({pick.size}/{vehs.length})</b>
            <button className="btn small link" onClick={() => setPick(pick.size === vehs.length ? new Set() : new Set(vehs.map((v) => v.id)))}>{pick.size === vehs.length ? 'Bỏ chọn hết' : 'Chọn hết'}</button></div>
          <div className="check-grid">{vehs.map((v) => <label key={v.id} className="check"><input type="checkbox" checked={pick.has(v.id)} onChange={() => toggle(v.id)} /> {v.plate}</label>)}</div>
          <div className="actions"><button className="btn primary" disabled={busy} onClick={() => void make()}>{busy ? 'Đang dựng…' : 'Xem & in'}</button></div>
        </Modal>
      )}
      {dlg === 'kk' && <PriceFiling canEdit={perms.has('archive.add') || perms.has('archive.manage')} onClose={() => setDlg('')} />}
      {view && <PaperView title={view.title} pages={view.pages.map((html) => ({ html, land: view.land }))} onClose={() => setView(null)} />}
    </section>
  );
}

/** Hồ sơ kê khai giá cước theo năm: xem / tải lên bản scan (Lưu trữ hồ sơ › Năm › Pháp lý công ty › Kê khai giá cước). */
function PriceFiling({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const toast = useToast();
  const [year, setYear] = useState(todayIso().slice(0, 4));
  const [items, setItems] = useState<Kk[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    setItems(null);
    // tìm thư mục theo tên (không tạo mới khi chỉ xem)
    const f = ((await supabase.from('archive_folders').select('id, parent_id, name')).data ?? []) as { id: string; parent_id: string | null; name: string }[];
    let parent: string | null = null;
    for (const n of KK_PATH(year)) {
      const hit = f.find((x) => x.parent_id === parent && (x.name.trim() === n || (!/^\d{4}$/.test(n) && bare(x.name) === bare(n))));
      if (!hit) { setItems([]); return; }
      parent = hit.id;
    }
    const r = await supabase.from('archive_items').select('id, name, file_name, mime, created_at').eq('folder_id', parent!).eq('is_old', false).order('created_at', { ascending: false });
    setItems((r.data ?? []) as Kk[]);
  }, [year]);
  useEffect(() => { void load(); }, [load]);
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    try {
      const folder = await ensurePath(KK_PATH(year));
      for (const f of Array.from(files)) {
        if (f.size > 10 * 1024 * 1024) { toast('error', `${f.name}: lớn hơn 10 MB`); continue; }
        setBusy(`Đang tải lên ${f.name}…`);
        await drive({ action: 'put', folder_id: folder, name: f.name.replace(/\.[^.]+$/, ''), file_name: f.name, mime: f.type || 'application/octet-stream',
          data: await fileToBase64(f), expires_on: null, note: `Kê khai giá cước năm ${year}`, replace_id: null });
      }
      toast('ok', `Đã lưu hồ sơ kê khai giá năm ${year}`);
      await load();
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(null); }
  }
  async function openItem(it: Kk) {
    setBusy(`Đang tải ${it.name}…`);
    try {
      const r = await drive<{ name: string; mime: string; data: string }>({ action: 'get', id: it.id });
      openBase64(r.name || it.file_name || it.name, r.mime || it.mime || '', r.data, false);
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(null); }
  }
  const years = Array.from({ length: 8 }, (_, i) => String(Number(todayIso().slice(0, 4)) - i));
  return (
    <Modal title="Hồ sơ kê khai giá cước" onClose={onClose}>
      <label>Năm<select value={year} onChange={(e) => setYear(e.target.value)}>{years.map((y) => <option key={y}>{y}</option>)}</select></label>
      {items === null ? <p className="muted">Đang tải…</p> : items.length === 0 ? <p className="muted">Năm {year} chưa có hồ sơ kê khai giá.</p> : (
        <ul className="list">{items.map((it) => (
          <li key={it.id} className="item"><div className="item-head"><span>{it.name}</span>
            <button className="btn small" disabled={!!busy} onClick={() => void openItem(it)}>Xem</button></div></li>
        ))}</ul>
      )}
      {canEdit && <label className="btn primary">Tải bản scan lên<input type="file" accept="application/pdf,image/*" multiple hidden onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} /></label>}
      {busy && <p className="muted small">{busy}</p>}
    </Modal>
  );
}
