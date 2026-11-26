// Điều hành: lọc theo tuyến đường / nhóm tuyến đường (như Vexere), dạng bảng (hàng = tuyến theo chiều, cột = giờ),
// và danh sách xe chưa điều / đã điều trong ngày.
import { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { dirName, type Dir } from '../lib/routes';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

export interface BRoute { id: string; code: string; name: string; name_ve: string | null; is_active: boolean }
export interface BTrip { id: string; route_id: string; direction: Dir; depart_at: string; status: string; vehicle_id: string | null; vehicle_type_id: string | null }
export interface BCrew { trip_id: string; role: string; staff_id: string; active: boolean }
export interface BVeh { id: string; plate: string; is_active: boolean }
export interface BStaff { id: string; full_name: string }
export interface Group { id: string; name: string; routes: string[] }

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const GKEY = 'dieu_hanh.nhom_tuyen';
const store = { get: (k: string, d: string) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* bỏ qua */ } } };
/** Mã ngắn theo chiều: BH-VT / VT-BH */
const short = (r: BRoute | undefined, d: Dir) => {
  const n = dirName(r, d);
  const parts = n.split(/\s+[-–—⇄]\s+/);
  const ini = (s: string) => s.replace(/^(BX|Bến xe)\s+/i, '').split(/\s+/).map((w) => w[0]?.toUpperCase() ?? '').join('');
  return parts.length >= 2 ? `${ini(parts[0])}-${ini(parts[parts.length - 1])}` : n;
};

/** Thứ tự tuyến: từng cặp tuyến, chiều đi rồi chiều về (Biên Hòa - Vũng Tàu, Vũng Tàu - Biên Hòa, Hố Nai - Vũng Tàu, Vũng Tàu - Hố Nai…) */
const byPair = (pa: string, da: string, pb: string, db: string) => pa.localeCompare(pb, 'vi') || (da === 'di' ? 0 : 1) - (db === 'di' ? 0 : 1);

export interface Filter { mode: 'tuyen' | 'nhom'; keys: string[]; group: string }
export function useBoardFilter() {
  const [f, setF] = useState<Filter>(() => {
    try { return JSON.parse(store.get('dh.loc', '')) as Filter; } catch { return { mode: 'tuyen', keys: [], group: '' }; }
  });
  useEffect(() => store.set('dh.loc', JSON.stringify(f)), [f]);
  const [view, setView] = useState<'ds' | 'bang'>(() => (store.get('dh.dang', 'ds') === 'bang' ? 'bang' : 'ds'));
  useEffect(() => store.set('dh.dang', view), [view]);
  return { f, setF, view, setView };
}

/** Thanh lọc: Tuyến đường (chọn nhiều tuyến theo chiều) / Nhóm tuyến đường (thẻ nhóm) */
export function RouteFilterBar(props: { routes: BRoute[]; trips: BTrip[]; crew: BCrew[]; f: Filter; setF: (f: Filter) => void; canEditGroups: boolean;
  view: 'ds' | 'bang'; setView: (v: 'ds' | 'bang') => void; onGroups: (g: Group[]) => void }) {
  const { routes, trips, crew, f, setF } = props;
  const toast = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [edit, setEdit] = useState<Group | null>(null);
  useEffect(() => {
    void supabase.from('tenant_settings').select('value').eq('key', GKEY).maybeSingle().then(({ data }) => {
      if (Array.isArray(data?.value)) { setGroups(data.value as Group[]); props.onGroups(data.value as Group[]); }
    });
  }, []);
  const opts = useMemo(() => {
    const keys = [...new Set(trips.map((t) => `${t.route_id}|${t.direction}`))];
    return keys.map((k) => { const [id, d] = k.split('|'); const r = routes.find((x) => x.id === id); return { k, label: dirName(r, d as Dir), short: short(r, d as Dir), pair: r?.name ?? '', d }; })
      .sort((a, b) => byPair(a.pair, a.d, b.pair, b.d));
  }, [trips, routes]);
  // Chưa tạo nhóm nào: mỗi tuyến (cả 2 chiều) là 1 nhóm
  const shownGroups: Group[] = groups.length ? groups
    : [...new Set(trips.map((t) => t.route_id))].map((id) => ({ id: `auto:${id}`, name: (routes.find((r) => r.id === id)?.name ?? '').replace(/\s+[-–—]\s+/, ' ⇄ '), routes: [id] }));
  const stat = (g: Group) => {
    const l = trips.filter((t) => t.status === 'mo' && g.routes.includes(t.route_id));
    const ok = l.filter((t) => t.vehicle_id && crew.some((c) => c.trip_id === t.id && c.role === 'lai_xe_1' && c.active)).length;
    return { n: l.length, ok };
  };
  async function saveGroups(list: Group[]) {
    const { error } = await supabase.from('tenant_settings').upsert([{ key: GKEY, value: list }], { onConflict: 'tenant_id,key' });
    if (error) return toast('error', /row-level|42501|permission/i.test(error.message) ? 'Chỉ quản trị (quyền Cấu hình) mới tạo / sửa nhóm tuyến' : errMsg(error));
    setGroups(list);
    props.onGroups(list);
    setEdit(null);
    toast('ok', 'Đã lưu nhóm tuyến đường');
  }
  return (
    <div className="dh-filter">
      <div className="dh-row">
        <label className="check"><input type="radio" checked={f.mode === 'tuyen'} onChange={() => setF({ ...f, mode: 'tuyen' })} /> Tuyến đường</label>
        <label className="check"><input type="radio" checked={f.mode === 'nhom'} onChange={() => setF({ ...f, mode: 'nhom' })} /> Nhóm tuyến đường</label>
        <span className="dh-sp" />
        <div className="chips" role="group" aria-label="Kiểu xem">
          <button type="button" className={props.view === 'ds' ? 'btn small primary' : 'btn small'} onClick={() => props.setView('ds')}>Dạng thẻ</button>
          <button type="button" className={props.view === 'bang' ? 'btn small primary' : 'btn small'} onClick={() => props.setView('bang')}>Dạng bảng</button>
        </div>
      </div>
      {f.mode === 'tuyen' ? (
        <div className="chips">
          <button type="button" className={f.keys.length === 0 ? 'chip on' : 'chip'} onClick={() => setF({ ...f, keys: [] })}>Tất cả</button>
          {opts.map((o) => {
            const on = f.keys.includes(o.k);
            return (
              <button key={o.k} type="button" className={on ? 'chip on' : 'chip'} title={o.label}
                      onClick={() => setF({ ...f, keys: on ? f.keys.filter((x) => x !== o.k) : [...f.keys, o.k] })}>{o.label}</button>
            );
          })}
        </div>
      ) : (
        <div className="route-cards dh-groups">
          {shownGroups.map((g) => {
            const s = stat(g);
            const on = f.group === g.id;
            return (
              <div key={g.id} className={on ? 'route-card on' : 'route-card'}>
                <button type="button" className="dh-gbtn" onClick={() => setF({ ...f, group: on ? '' : g.id })}>
                  <b>{g.name}</b>
                  <small>{s.n} chuyến · {s.ok} đủ xe + lái{s.n - s.ok ? ` · ${s.n - s.ok} chưa xếp` : ''}</small>
                </button>
                {props.canEditGroups && !g.id.startsWith('auto:') && <button type="button" className="btn small link" onClick={() => setEdit(g)}>Sửa</button>}
              </div>
            );
          })}
          {props.canEditGroups && <button type="button" className="btn small" onClick={() => setEdit({ id: crypto.randomUUID(), name: '', routes: [] })}>+ Nhóm tuyến</button>}
        </div>
      )}
      {edit && (
        <Modal title={groups.some((g) => g.id === edit.id) ? 'Sửa nhóm tuyến đường' : 'Nhóm tuyến đường mới'} onClose={() => setEdit(null)}>
          <form className="form" onSubmit={(e) => {
            e.preventDefault();
            if (!edit.name.trim() || !edit.routes.length) return toast('error', 'Nhập tên nhóm và chọn ít nhất 1 tuyến');
            const g = { ...edit, name: edit.name.trim() };
            void saveGroups(groups.some((x) => x.id === g.id) ? groups.map((x) => (x.id === g.id ? g : x)) : [...groups, g]);
          }}>
            <label>Tên nhóm<input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="vd: Biên Hòa – Hố Nai – Vũng Tàu" autoFocus /></label>
            <fieldset className="checklist">
              <legend className="small muted">Các tuyến trong nhóm (cả 2 chiều)</legend>
              {routes.filter((r) => r.is_active).map((r) => (
                <label key={r.id} className="check">
                  <input type="checkbox" checked={edit.routes.includes(r.id)}
                         onChange={(e) => setEdit({ ...edit, routes: e.target.checked ? [...edit.routes, r.id] : edit.routes.filter((x) => x !== r.id) })} /> {r.name}
                </label>
              ))}
            </fieldset>
            <div className="actions">
              <button className="btn primary">Lưu nhóm</button>
              {groups.some((g) => g.id === edit.id) && <button type="button" className="btn link danger-text" onClick={() => void saveGroups(groups.filter((g) => g.id !== edit.id))}>Xóa nhóm</button>}
              <button type="button" className="btn link" onClick={() => setEdit(null)}>Thôi</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

/** Lọc chuyến theo thanh lọc */
export function applyFilter<T extends BTrip>(trips: T[], f: Filter, groupRoutes: (id: string) => string[] | null): T[] {
  if (f.mode === 'tuyen') return f.keys.length ? trips.filter((t) => f.keys.includes(`${t.route_id}|${t.direction}`)) : trips;
  if (!f.group) return trips;
  if (f.group.startsWith('auto:')) return trips.filter((t) => t.route_id === f.group.slice(5));
  const rs = groupRoutes(f.group);
  return rs ? trips.filter((t) => rs.includes(t.route_id)) : trips;
}

/** Dạng bảng: hàng = tuyến theo chiều, cột = giờ; ô = biển số | lái xe | vé đã bán / số ghế */
export function GridView(props: { routes: BRoute[]; trips: BTrip[]; crew: BCrew[]; vehicles: BVeh[]; staff: BStaff[]; onOpen: (t: BTrip) => void; canEdit: boolean }) {
  const { routes, trips, crew, vehicles, staff, onOpen } = props;
  const [sold, setSold] = useState<Record<string, number>>({});
  const [cap, setCap] = useState<Record<string, number>>({});
  const ids = trips.map((t) => t.id).join(',');
  // tải lại số ghế khi loại xe của chuyến đổi (đổi xe khác sơ đồ, vd 16 chỗ → 29 chỗ), không chỉ khi danh sách chuyến đổi
  const typeKey = [...new Set(trips.map((t) => t.vehicle_type_id).filter(Boolean))].sort().join(',');
  useEffect(() => {
    const list = ids ? ids.split(',') : [];
    if (!list.length) return;
    void supabase.from('seat_inventory').select('trip_id').in('trip_id', list).in('status', ['dat', 'da_tt', 'cho_xep']).then(({ data }) => {
      const m: Record<string, number> = {};
      for (const r of (data ?? []) as { trip_id: string }[]) m[r.trip_id] = (m[r.trip_id] ?? 0) + 1;
      setSold(m);
    });
    const types = typeKey ? typeKey.split(',') : [];
    if (types.length) {
      void supabase.from('vehicle_type_seats').select('vehicle_type_id').in('vehicle_type_id', types).eq('is_sellable', true).then(({ data }) => {
        const m: Record<string, number> = {};
        for (const r of (data ?? []) as { vehicle_type_id: string }[]) m[r.vehicle_type_id] = (m[r.vehicle_type_id] ?? 0) + 1;
        setCap(m);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, typeKey]);
  const rowsKeys = [...new Set(trips.map((t) => `${t.route_id}|${t.direction}`))]
    .map((k) => { const [id, d] = k.split('|'); const r = routes.find((x) => x.id === id); return { k, r, d: d as Dir }; })
    .sort((a, b) => byPair(a.r?.name ?? '', a.d, b.r?.name ?? '', b.d));
  const hours = [...new Set(trips.map((t) => hhmm(t.depart_at).slice(0, 2)))].sort();
  if (!trips.length) return <p className="muted">Không có chuyến.</p>;
  return (
    <div className="table-wrap dh-grid-wrap">
      <table className="dh-grid">
        <thead><tr><th />{hours.map((h) => <th key={h}>{h}:00</th>)}</tr></thead>
        <tbody>
          {rowsKeys.map(({ k, r, d }) => (
            <tr key={k}>
              <th title={dirName(r, d)}>{short(r, d)}<small>{dirName(r, d)}</small></th>
              {hours.map((h) => {
                const cell = trips.filter((t) => `${t.route_id}|${t.direction}` === k && hhmm(t.depart_at).slice(0, 2) === h)
                  .sort((a, b) => a.depart_at.localeCompare(b.depart_at));
                return (
                  <td key={h}>
                    {cell.map((t) => {
                      const v = vehicles.find((x) => x.id === t.vehicle_id);
                      const d1 = crew.find((c) => c.trip_id === t.id && c.role === 'lai_xe_1' && c.active);
                      const who = d1 ? staff.find((s) => s.id === d1.staff_id)?.full_name.split(' ').pop() ?? '' : '';
                      const ok = t.status === 'mo' && !!v && !!d1;
                      const c = t.vehicle_type_id ? cap[t.vehicle_type_id] : undefined;
                      return (
                        <button key={t.id} type="button" className={['dh-cell', t.status === 'huy' ? 'huy' : ok ? 'ok' : 'thieu'].join(' ')}
                                aria-label={`Chuyến ${hhmm(t.depart_at)} ${dirName(r, d)}`} disabled={!props.canEdit || t.status !== 'mo'} onClick={() => onOpen(t)}>
                          <span className="dh-t">{hhmm(t.depart_at)}</span>
                          <span>{v ? v.plate.slice(-5) : '—'} | {who || '—'} | <b>{sold[t.id] ?? 0}</b>/{c ?? '?'}</span>
                        </button>
                      );
                    })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Xe chưa điều / xe đã điều trong ngày (số trong ngoặc = số chuyến) */
export function VehicleUsage({ trips, vehicles }: { trips: BTrip[]; vehicles: BVeh[] }) {
  const used: Record<string, number> = {};
  for (const t of trips) if (t.status === 'mo' && t.vehicle_id) used[t.vehicle_id] = (used[t.vehicle_id] ?? 0) + 1;
  const act = vehicles.filter((v) => v.is_active).sort((a, b) => a.plate.localeCompare(b.plate));
  const free = act.filter((v) => !used[v.id]), busy = act.filter((v) => used[v.id]);
  return (
    <div className="dh-usage small">
      <div><b>Xe chưa điều ({free.length}):</b> {free.length ? free.map((v) => <span key={v.id} className="dh-veh free">{v.plate}</span>) : <span className="muted">không có</span>}</div>
      <div><b>Xe đã điều ({busy.length}):</b> {busy.length ? busy.map((v) => <span key={v.id} className="dh-veh busy">{v.plate} ({used[v.id]})</span>) : <span className="muted">chưa có</span>}</div>
    </div>
  );
}
