import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Permissions } from '../lib/permissions';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

type StopKind = 'ben_xe' | 'van_phong' | 'diem_don_tra' | 'tram_dung';
interface Stop { id: string; code: string; name: string; kind: StopKind; province: string | null; address: string | null; is_active: boolean }
interface Route { id: string; code: string; name: string; registered_code: string | null; distance_km: number | null; is_active: boolean }
interface RouteStop { route_id: string; seq: number; stop_id: string; minutes_from_start: number; allow_pickup: boolean; allow_dropoff: boolean }
interface Fare { id: string; route_id: string; from_stop_id: string | null; to_stop_id: string | null; price: number | null; effective_from: string }

const KIND: Record<StopKind, string> = { ben_xe: 'Bến xe', van_phong: 'Văn phòng', diem_don_tra: 'Điểm đón trả', tram_dung: 'Trạm dừng nghỉ' };
const money = (n: number | null) => (n == null ? '—' : `${n.toLocaleString('vi-VN')} đ`);
// Ngày theo giờ Việt Nam (khớp app.local_today() của database)
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
const fmtDate = (d: string) => d.split('-').reverse().join('/');

interface Data { stops: Stop[]; routes: Route[]; routeStops: RouteStop[]; fares: Fare[] }

/** Giá đang áp dụng hôm nay cho 1 khóa (toàn tuyến hoặc cặp điểm). */
function currentFare(fares: Fare[], routeId: string, a: string | null, b: string | null): Fare | undefined {
  const t = today();
  return fares
    .filter((f) => f.route_id === routeId && f.from_stop_id === a && f.to_stop_id === b && f.effective_from <= t)
    .sort((x, y) => y.effective_from.localeCompare(x.effective_from))[0];
}

export function RoutesScreen({ perms }: { perms: Permissions }) {
  const toast = useToast();
  const [data, setData] = useState<Data>({ stops: [], routes: [], routeStops: [], fares: [] });
  const canRoute = perms.has('route.manage');
  const canFare = perms.has('fare.manage');

  const load = useCallback(async () => {
    const [s, r, rs, f] = await Promise.all([
      supabase.from('stops').select('id, code, name, kind, province, address, is_active').order('code'),
      supabase.from('routes').select('id, code, name, registered_code, distance_km, is_active').order('code'),
      supabase.from('route_stops').select('route_id, seq, stop_id, minutes_from_start, allow_pickup, allow_dropoff').order('seq'),
      supabase.from('route_fares').select('id, route_id, from_stop_id, to_stop_id, price, effective_from').order('effective_from', { ascending: false }),
    ]);
    const err = s.error ?? r.error ?? rs.error ?? f.error;
    if (err) return toast('error', err.message);
    setData({ stops: (s.data ?? []) as Stop[], routes: (r.data ?? []) as Route[], routeStops: (rs.data ?? []) as RouteStop[], fares: (f.data ?? []) as Fare[] });
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <RoutesSection data={data} canRoute={canRoute} canFare={canFare} reload={load} />
      <StopsSection stops={data.stops} canEdit={canRoute} reload={load} />
    </>
  );
}

/* ------------------------------------------------------------------ Điểm dừng */

const EMPTY_STOP = { code: '', name: '', kind: 'diem_don_tra' as StopKind, province: '', address: '' };

function StopsSection({ stops, canEdit, reload }: { stops: Stop[]; canEdit: boolean; reload: () => Promise<void> }) {
  const toast = useToast();
  const [f, setF] = useState(EMPTY_STOP);
  const [editId, setEditId] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const values = { code: f.code.trim(), name: f.name.trim(), kind: f.kind, province: f.province.trim() || null, address: f.address.trim() || null };
    const q = editId ? supabase.from('stops').update(values).eq('id', editId).select('id') : supabase.from('stops').insert(values).select('id');
    const { error } = await q;
    setBusy(false);
    if (error) return toast('error', error.code === '23505' ? 'Mã điểm dừng đã có' : error.message);
    toast('ok', editId ? 'Đã lưu điểm dừng' : `Đã thêm điểm dừng ${values.name}`);
    setF(EMPTY_STOP);
    setEditId(null);
    await reload();
  }

  async function toggle(s: Stop) {
    const { error } = await supabase.from('stops').update({ is_active: !s.is_active }).eq('id', s.id);
    if (error) return toast('error', error.message);
    toast('ok', s.is_active ? 'Đã ngừng dùng điểm dừng' : 'Đã dùng lại điểm dừng');
    await reload();
  }

  const inactive = stops.filter((s) => !s.is_active).length;

  return (
    <section className="card">
      <div className="item-head">
        <h2>Điểm dừng ({stops.filter((s) => s.is_active).length})</h2>
        {inactive > 0 && (
          <button className="btn small" onClick={() => setShowInactive(!showInactive)}>
            {showInactive ? 'Ẩn điểm ngừng dùng' : `Hiện điểm ngừng dùng (${inactive})`}
          </button>
        )}
      </div>
      {canEdit && (
        <form className="form" onSubmit={submit}>
          <div className="grid2">
            <label>Mã điểm<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></label>
            <label>Tên điểm<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
            <label>Loại điểm
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as StopKind })}>
                {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>Tỉnh / thành<input value={f.province} onChange={(e) => setF({ ...f, province: e.target.value })} /></label>
            <label>Địa chỉ<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
          </div>
          <div className="actions">
            <button className="btn primary" disabled={busy}>{editId ? 'Lưu điểm dừng' : 'Thêm điểm dừng'}</button>
            {editId && <button type="button" className="btn link" onClick={() => { setEditId(null); setF(EMPTY_STOP); }}>Hủy sửa</button>}
          </div>
        </form>
      )}
      <ul className="list">
        {stops.filter((s) => showInactive || s.is_active).map((s) => (
          <li key={s.id} className="item">
            <div className="item-head">
              <div>
                <b>{s.name}</b> <span className="muted small">· {s.code} · {KIND[s.kind]}</span>
                {!s.is_active && <span className="badge locked">Ngừng dùng</span>}
                <div className="muted small">{[s.address, s.province].filter(Boolean).join(', ')}</div>
              </div>
              {canEdit && (
                <div className="actions">
                  <button className="btn small" onClick={() => {
                    setEditId(s.id);
                    setF({ code: s.code, name: s.name, kind: s.kind, province: s.province ?? '', address: s.address ?? '' });
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                  }}>Sửa</button>
                  <button className="btn small" onClick={() => void toggle(s)}>{s.is_active ? 'Ngừng dùng' : 'Dùng lại'}</button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ Tuyến */

const EMPTY_ROUTE = { code: '', name: '', registered_code: '', distance_km: '' };

function RoutesSection(props: { data: Data; canRoute: boolean; canFare: boolean; reload: () => Promise<void> }) {
  const { data, canRoute, reload } = props;
  const toast = useToast();
  const [f, setF] = useState(EMPTY_ROUTE);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.from('routes').insert({
      code: f.code.trim(), name: f.name.trim(), registered_code: f.registered_code.trim() || null,
      distance_km: f.distance_km ? Number(f.distance_km) : null,
    });
    setBusy(false);
    if (error) return toast('error', error.code === '23505' ? 'Mã tuyến đã có' : error.message);
    toast('ok', `Đã thêm tuyến ${f.name.trim()}`);
    setF(EMPTY_ROUTE);
    await reload();
  }

  return (
    <>
      {canRoute && (
        <form className="card form" onSubmit={submit}>
          <h2>Thêm tuyến</h2>
          <div className="grid2">
            <label>Mã tuyến<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} required /></label>
            <label>Tên tuyến<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="vd: Hố Nai – Vũng Tàu" required /></label>
            <label>Mã số tuyến (đăng ký với Sở)<input value={f.registered_code} onChange={(e) => setF({ ...f, registered_code: e.target.value })} /></label>
            <label>Cự ly (km)<input type="number" min={1} step="0.1" inputMode="decimal" value={f.distance_km} onChange={(e) => setF({ ...f, distance_km: e.target.value })} /></label>
          </div>
          <button className="btn primary" disabled={busy}>Thêm tuyến</button>
        </form>
      )}
      <section className="card">
        <h2>Tuyến ({data.routes.length})</h2>
        {data.routes.length === 0 && <p className="muted">Chưa có tuyến.</p>}
        <ul className="list">
          {data.routes.map((r) => (
            <li key={r.id} className="item">
              <div className="item-head">
                <div>
                  <b>{r.name}</b> <span className="muted small">· {r.code}{r.registered_code ? ` · Mã số ${r.registered_code}` : ''}{r.distance_km ? ` · ${r.distance_km} km` : ''}</span>
                  <div className="muted small">
                    Giá toàn tuyến: {money(currentFare(data.fares, r.id, null, null)?.price ?? null)}
                  </div>
                </div>
                <button className="btn small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Đóng' : 'Chi tiết'}</button>
              </div>
              {open === r.id && <RouteDetail route={r} {...props} />}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

interface EditStop { stop_id: string; minutes_from_start: string; allow_pickup: boolean; allow_dropoff: boolean }

function RouteDetail(props: { route: Route; data: Data; canRoute: boolean; canFare: boolean; reload: () => Promise<void> }) {
  const { route, data, canRoute, canFare, reload } = props;
  const toast = useToast();
  const saved = useMemo(() => data.routeStops.filter((s) => s.route_id === route.id).sort((a, b) => a.seq - b.seq), [data.routeStops, route.id]);
  const stopName = (id: string | null) => data.stops.find((s) => s.id === id)?.name ?? '?';
  const [editing, setEditing] = useState(false);
  const [list, setList] = useState<EditStop[]>([]);
  const [busy, setBusy] = useState(false);

  function startEdit() {
    setList(saved.length > 0
      ? saved.map((s) => ({ stop_id: s.stop_id, minutes_from_start: String(s.minutes_from_start), allow_pickup: s.allow_pickup, allow_dropoff: s.allow_dropoff }))
      : [{ stop_id: '', minutes_from_start: '0', allow_pickup: true, allow_dropoff: false }, { stop_id: '', minutes_from_start: '', allow_pickup: false, allow_dropoff: true }]);
    setEditing(true);
  }

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    setList(next);
  }

  async function saveStops() {
    if (list.some((s) => !s.stop_id)) return toast('error', 'Chọn đủ điểm dừng cho mọi dòng');
    setBusy(true);
    try {
      await rpc('set_route_stops', {
        p_route_id: route.id,
        p_stops: list.map((s, i) => ({ stop_id: s.stop_id, minutes_from_start: i === 0 ? 0 : Number(s.minutes_from_start || 0),
                                       allow_pickup: s.allow_pickup, allow_dropoff: s.allow_dropoff })),
      });
      toast('ok', 'Đã lưu điểm dừng của tuyến');
      setEditing(false);
      await reload();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const activeStops = data.stops.filter((s) => s.is_active);

  return (
    <div className="sub">
      <div className="item-head">
        <h3>Điểm dừng (chiều đi)</h3>
        {canRoute && !editing && <button className="btn small" onClick={startEdit}>Sửa điểm dừng</button>}
      </div>
      {!editing && (saved.length === 0 ? <p className="muted small">Chưa khai báo điểm dừng.</p> : (
        <ol className="stops">
          {saved.map((s) => (
            <li key={s.seq}>
              <b>{stopName(s.stop_id)}</b> <span className="muted small">· +{s.minutes_from_start} phút
                {!s.allow_pickup && ' · không đón'}{!s.allow_dropoff && ' · không trả'}</span>
            </li>
          ))}
        </ol>
      ))}
      {editing && (
        <div className="form">
          {list.map((s, i) => (
            <div key={i} className="stop-row">
              <span className="muted">{i + 1}.</span>
              <select value={s.stop_id} aria-label={`Điểm dừng thứ ${i + 1}`}
                      onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, stop_id: e.target.value } : x)))}>
                <option value="">Chọn điểm</option>
                {activeStops.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
              </select>
              <input type="number" min={0} inputMode="numeric" aria-label={`Phút từ điểm đầu, điểm ${i + 1}`} disabled={i === 0}
                     value={i === 0 ? '0' : s.minutes_from_start} placeholder="phút"
                     onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, minutes_from_start: e.target.value } : x)))} />
              <label className="check"><input type="checkbox" checked={s.allow_pickup}
                     onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, allow_pickup: e.target.checked } : x)))} />Đón</label>
              <label className="check"><input type="checkbox" checked={s.allow_dropoff}
                     onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, allow_dropoff: e.target.checked } : x)))} />Trả</label>
              <button type="button" className="btn small" onClick={() => move(i, -1)} aria-label="Lên">↑</button>
              <button type="button" className="btn small" onClick={() => move(i, 1)} aria-label="Xuống">↓</button>
              <button type="button" className="btn small" onClick={() => setList(list.filter((_, k) => k !== i))} aria-label="Bỏ điểm">×</button>
            </div>
          ))}
          <div className="actions">
            <button type="button" className="btn small" onClick={() => setList([...list, { stop_id: '', minutes_from_start: '', allow_pickup: true, allow_dropoff: true }])}>+ Thêm điểm</button>
            <button type="button" className="btn small primary" disabled={busy} onClick={() => void saveStops()}>Lưu điểm dừng</button>
            <button type="button" className="btn small link" onClick={() => setEditing(false)}>Hủy</button>
          </div>
          <p className="muted small">Thời gian tính bằng phút kể từ điểm đầu. Chiều về tự đi ngược thứ tự.</p>
        </div>
      )}
      <FareSection route={route} data={data} canFare={canFare} saved={saved} stopName={stopName} reload={reload} />
    </div>
  );
}

function FareSection(props: { route: Route; data: Data; canFare: boolean; saved: RouteStop[]; stopName: (id: string | null) => string; reload: () => Promise<void> }) {
  const { route, data, canFare, saved, stopName, reload } = props;
  const toast = useToast();
  const [full, setFull] = useState({ price: '', date: today() });
  const [pair, setPair] = useState({ from: '', to: '', price: '', date: today() });
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const fares = data.fares.filter((f) => f.route_id === route.id);
  const fullNow = currentFare(fares, route.id, null, null);
  const pairKeys = Array.from(new Set(fares.filter((f) => f.from_stop_id).map((f) => `${f.from_stop_id}|${f.to_stop_id}`)));
  const pairsNow = pairKeys
    .map((k) => { const [a, b] = k.split('|'); return currentFare(fares, route.id, a, b); })
    .filter((f): f is Fare => !!f && f.price != null);
  const upcoming = fares.filter((f) => f.effective_from > today());
  // Hiện cặp điểm theo thứ tự chiều đi của tuyến (database lưu cặp theo mã, không theo chiều)
  const seqOf = (id: string | null) => saved.find((s) => s.stop_id === id)?.seq ?? 0;
  const pairName = (f: Fare) => {
    const [a, b] = seqOf(f.from_stop_id) <= seqOf(f.to_stop_id) ? [f.from_stop_id, f.to_stop_id] : [f.to_stop_id, f.from_stop_id];
    return `${stopName(a)} ⇄ ${stopName(b)}`;
  };

  async function setFare(from: string | null, to: string | null, price: number | null, date: string, ok: string) {
    setBusy(true);
    try {
      await rpc('set_fare', { p_route_id: route.id, p_from_stop: from, p_to_stop: to, p_price: price, p_effective_from: date });
      toast('ok', ok);
      await reload();
      return true;
    } catch (e) {
      toast('error', errMsg(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h3>Giá vé</h3>
      <p className="small">Giá toàn tuyến hôm nay: <b>{money(fullNow?.price ?? null)}</b>
        {fullNow && <span className="muted"> (từ {fmtDate(fullNow.effective_from)})</span>}</p>
      {pairsNow.length > 0 && (
        <ul className="list">
          {pairsNow.map((f) => (
            <li key={f.id} className="price-row">
              <span>{pairName(f)}: <b>{money(f.price)}</b></span>
              {canFare && (
                <button className="btn small" disabled={busy}
                        onClick={() => void setFare(f.from_stop_id, f.to_stop_id, null, today(), 'Đã bỏ giá riêng, chặng này dùng giá toàn tuyến')}>Bỏ giá riêng</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {upcoming.length > 0 && (
        <p className="muted small">Sắp áp dụng: {upcoming.map((f) => `${f.from_stop_id ? pairName(f) : 'Toàn tuyến'} ${money(f.price)} từ ${fmtDate(f.effective_from)}`).join('; ')}</p>
      )}
      {canFare && (
        <>
          <form className="inline-form" onSubmit={(e) => {
            e.preventDefault();
            void setFare(null, null, Number(full.price), full.date, 'Đã lưu giá toàn tuyến').then((ok) => ok && setFull({ price: '', date: today() }));
          }}>
            <input type="number" min={1000} step={1000} inputMode="numeric" placeholder="Giá toàn tuyến (đ)" aria-label="Giá toàn tuyến"
                   value={full.price} onChange={(e) => setFull({ ...full, price: e.target.value })} required />
            <input type="date" aria-label="Áp dụng từ ngày (toàn tuyến)" value={full.date} min={today()} onChange={(e) => setFull({ ...full, date: e.target.value })} required />
            <button className="btn small primary" disabled={busy}>Lưu giá toàn tuyến</button>
          </form>
          {saved.length >= 2 && (
            <form className="inline-form" onSubmit={(e) => {
              e.preventDefault();
              void setFare(pair.from, pair.to, Number(pair.price), pair.date, 'Đã lưu giá chặng')
                .then((ok) => ok && setPair({ from: '', to: '', price: '', date: today() }));
            }}>
              <select aria-label="Chặng từ" value={pair.from} onChange={(e) => setPair({ ...pair, from: e.target.value })} required>
                <option value="">Từ điểm</option>
                {saved.map((s) => <option key={s.stop_id} value={s.stop_id}>{stopName(s.stop_id)}</option>)}
              </select>
              <select aria-label="Chặng đến" value={pair.to} onChange={(e) => setPair({ ...pair, to: e.target.value })} required>
                <option value="">Đến điểm</option>
                {saved.map((s) => <option key={s.stop_id} value={s.stop_id}>{stopName(s.stop_id)}</option>)}
              </select>
              <input type="number" min={1000} step={1000} inputMode="numeric" placeholder="Giá chặng (đ)" aria-label="Giá chặng"
                     value={pair.price} onChange={(e) => setPair({ ...pair, price: e.target.value })} required />
              <input type="date" aria-label="Áp dụng từ ngày (chặng)" value={pair.date} min={today()} onChange={(e) => setPair({ ...pair, date: e.target.value })} required />
              <button className="btn small primary" disabled={busy}>Lưu giá chặng</button>
            </form>
          )}
        </>
      )}
      {fares.length > 0 && (
        <button className="btn small link" onClick={() => setShowHistory(!showHistory)}>{showHistory ? 'Ẩn lịch sử giá' : 'Hiện lịch sử giá'}</button>
      )}
      {showHistory && (
        <ul className="list small">
          {fares.map((f) => (
            <li key={f.id} className="muted">
              {fmtDate(f.effective_from)} · {f.from_stop_id ? pairName(f) : 'Toàn tuyến'} · {f.price == null ? 'bỏ giá riêng' : money(f.price)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
