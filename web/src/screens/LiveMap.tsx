// Vị trí xe (mô phỏng màn Skysoft): cột danh sách xe bên trái (tự ẩn khi chọn xe / chạm bản đồ, nút ‹ › để thu / mở), bản đồ bên phải;
// bấm xe nào bản đồ bay tới xe đó. Vị trí mới nhất do app lái xe gửi về; tự tải lại 30 giây / lần.
// Bản đồ vẽ bằng ảnh nền (VITE_MAP_TILES, vd OpenStreetMap), không cài thêm thư viện. Kéo / chụm 2 ngón / lăn chuột để xem.
import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { errMsg, rpc, supabase } from '../lib/supabase';

interface Live { trip_id: string; depart_at: string; route_id: string; direction: 'di' | 've'; plate: string | null; driver: string | null; driver_phone: string | null;
  at: string | null; lat: number | null; lng: number | null; speed: number | null; heading: number | null; moved_at: string | null }
interface View { z: number; lat: number; lng: number }
const T = 256;
const toPx = (lat: number, lng: number, z: number) => {
  const n = T * 2 ** z, s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
};
const toLL = (x: number, y: number, z: number) => {
  const n = T * 2 ** z;
  return { lng: (x / n) * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI };
};
const hhmm = (t: string) => new Date(t).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (t: string) => { const m = Math.round((Date.now() - new Date(t).getTime()) / 60000); return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : `${Math.floor(m / 60)} giờ ${m % 60} phút trước`; };
/** Khung nhìn chứa hết các điểm (chưa có điểm nào: cả Việt Nam) */
function fitView(pts: { lat: number; lng: number }[], w: number, h: number): View {
  if (!pts.length) return { z: 5, lat: 16, lng: 106 };
  for (let z = 15; z >= 4; z--) {
    const p = pts.map((q) => toPx(q.lat, q.lng, z));
    const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
    if ((Math.max(...xs) - Math.min(...xs) < w - 100 && Math.max(...ys) - Math.min(...ys) < h - 160) || z === 4) {
      const c = toLL((Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2, z);
      return { z, lat: c.lat, lng: c.lng };
    }
  }
  return { z: 5, lat: 16, lng: 106 };
}

/** Trạng thái xe: chạy (≥ 3 km/h) · dừng · mất tín hiệu (quá 10 phút không gửi) · chưa có vị trí */
type St = 'chay' | 'dung' | 'mat' | 'chua';
const stOf = (l: Live): St => !l.at ? 'chua' : Date.now() - new Date(l.at).getTime() > 10 * 60000 ? 'mat' : Number(l.speed ?? 0) >= 3 ? 'chay' : 'dung';
const ST: Record<St, string> = { chay: 'Đang chạy', dung: 'Đang dừng', mat: 'Mất tín hiệu', chua: 'Chưa có vị trí' };
const dur = (from: string) => { const m = Math.max(0, Math.round((Date.now() - new Date(from).getTime()) / 60000)); return m < 60 ? `${m}p` : `${Math.floor(m / 60)}h${m % 60}p`; };

export function LiveMapScreen() {
  const [list, setList] = useState<Live[] | null>(null);
  const [routes, setRoutes] = useState<Record<string, { name: string; name_ve: string | null }>>({});
  const [stops, setStops] = useState<{ lat: number; lng: number }[]>([]);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [hide, setHide] = useState(false);   // cột danh sách đang thu lại
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<St | ''>('');
  async function load() {
    try {
      setList((await rpc<Live[]>('live_vehicles', {})).map((x) => ({ ...x, lat: x.lat == null ? null : Number(x.lat), lng: x.lng == null ? null : Number(x.lng) })));
      setErr('');
    } catch (e) { setErr(errMsg(e)); }
  }
  useEffect(() => {
    void supabase.from('routes').select('id, name, name_ve').then((r) => setRoutes(Object.fromEntries(((r.data ?? []) as { id: string; name: string; name_ve: string | null }[]).map((x) => [x.id, x]))));
    // chưa xe nào có vị trí: canh bản đồ theo các điểm dừng của nhà xe
    void supabase.from('stops').select('lat, lng').not('lat', 'is', null).then((r) => setStops(((r.data ?? []) as { lat: number; lng: number }[]).map((x) => ({ lat: Number(x.lat), lng: Number(x.lng) }))));
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => clearInterval(t);
  }, []);
  const routeOf = (l: Live) => { const r = routes[l.route_id]; return r ? (l.direction === 've' && r.name_ve ? r.name_ve : r.name) : ''; };
  const all = list ?? [];
  const pts = all.filter((l) => l.lat != null && l.lng != null);
  const cnt = (k: St) => all.filter((l) => stOf(l) === k).length;
  const key = q.replace(/[^0-9a-z]/gi, '').toLowerCase();
  const shown = all.filter((l) => (!only || stOf(l) === only) && (!key || (l.plate ?? '').replace(/[^0-9a-z]/gi, '').toLowerCase().includes(key)));
  const pick = (id: string) => { setSel(id); setHide(true); };
  // Bản đồ kín màn hình: cao từ dưới thanh menu tới đáy màn hình (đo theo máy, xoay máy / đổi cỡ thì đo lại)
  const page = useRef<HTMLElement>(null);
  const [h, setH] = useState(0);
  useEffect(() => {
    window.scrollTo({ top: 0 });
    const on = () => { const el = page.current; if (el) setH(Math.max(360, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY)))); };
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  return (
    <section ref={page} className={`lm-page sk${hide ? ' hide' : ''}`} style={h ? { height: h } : undefined}>
      <aside className="sk-side">
        <input type="search" className="sk-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm biển số xe…" aria-label="Tìm biển số xe" />
        {err && <p className="error-text small">{err}</p>}
        <div className="sk-list">
          {list === null && <p className="muted small">Đang tải…</p>}
          {list && !shown.length && <p className="muted small">Không có xe nào đang chạy</p>}
          {shown.map((l) => {
            const st = stOf(l);
            return (
              <button key={l.trip_id} type="button" className={`sk-item${sel === l.trip_id ? ' on' : ''}`} onClick={() => pick(l.trip_id)}>
                <span className="sk-left">
                  <i className={`sk-arr ${st}`} style={{ transform: `rotate(${(l.heading ?? 0) - 90}deg)` }}>➤</i>
                  <b className="sk-spd">{st === 'chua' || st === 'mat' ? 'NOK' : Math.round(Number(l.speed ?? 0))}</b>
                  <span className="sk-u">{st === 'chua' || st === 'mat' ? '' : 'km/h'}</span>
                  {st === 'dung' && <span className="sk-u">{dur(l.moved_at ?? l.at!)}</span>}
                  {st === 'mat' && <span className="sk-u">{dur(l.at!)}</span>}
                </span>
                <span className="sk-info">
                  <b className="sk-plate">{l.plate ?? 'chưa có xe'}</b>
                  <span>🕘 {hhmm(l.depart_at)} {routeOf(l)}</span>
                  <span>👤 {l.driver ?? ''}</span>
                  {l.driver_phone && <a href={`tel:${l.driver_phone}`} onClick={(e) => e.stopPropagation()}>📞 {l.driver_phone}</a>}
                  <span className="muted">⟳ {l.at ? `${hhmm(l.at)} · ${ago(l.at)}` : ST.chua}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="sk-count">
          {(['chay', 'dung', 'mat', 'chua'] as St[]).map((k) => (
            <button key={k} type="button" className={`${k}${only === k ? ' on' : ''}`} title={ST[k]} aria-label={ST[k]} onClick={() => setOnly(only === k ? '' : k)}>{cnt(k)}</button>
          ))}
          <button type="button" className={`tong${only === '' ? ' on' : ''}`} title="Tất cả" aria-label="Tất cả" onClick={() => setOnly('')}>{all.length}</button>
        </div>
      </aside>
      <button type="button" className="sk-tog" onClick={() => setHide(!hide)} aria-label={hide ? 'Mở danh sách xe' : 'Thu danh sách xe'}>{hide ? '›' : '‹'}</button>
      <div className="sk-map">
        {config.mapTiles
          ? <TileMap pts={pts} home={pts.length ? pts.map((l) => ({ lat: l.lat!, lng: l.lng! })) : stops} sel={sel} onSel={pick} onTouch={() => setHide(true)} />
          : <div className="lm-map lm-none muted">Chưa cài ảnh nền bản đồ (VITE_MAP_TILES)</div>}
      </div>
    </section>
  );
}

/** Bản đồ ảnh nền: kéo để di chuyển, chụm 2 ngón / lăn chuột / nút +− để phóng to thu nhỏ, bấm xe để bay tới */
function TileMap({ pts, home, sel, onSel, onTouch }: { pts: Live[]; home: { lat: number; lng: number }[]; sel: string | null; onSel: (id: string) => void; onTouch: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 500 });
  const [view, setView] = useState<View | null>(null);
  const touched = useRef(false);   // người dùng đã tự kéo / phóng: không tự canh lại nữa
  const anim = useRef(0);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const on = () => setSize({ w: el.clientWidth || 600, h: el.clientHeight || 500 });
    const ro = new ResizeObserver(on); ro.observe(el); on();
    return () => ro.disconnect();
  }, []);
  // tự canh cho thấy hết các xe (hoặc các điểm dừng) khi dữ liệu về, đến khi người dùng tự kéo / phóng
  useEffect(() => { if (!touched.current) setView(fitView(home, size.w, size.h)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [home.length, size.w, size.h]);
  const v = view ?? fitView(home, size.w, size.h);
  /** Bay mượt tới vị trí / mức phóng mới */
  function fly(to: View) {
    cancelAnimationFrame(anim.current);
    const from = v, t0 = performance.now(), dur = 450;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      setView({ z: k < 1 ? from.z : to.z, lat: from.lat + (to.lat - from.lat) * e, lng: from.lng + (to.lng - from.lng) * e });
      if (k < 1) anim.current = requestAnimationFrame(step);
    };
    anim.current = requestAnimationFrame(step);
  }
  useEffect(() => {
    const l = pts.find((x) => x.trip_id === sel); if (!l) return;
    touched.current = true;
    fly({ z: Math.max(v.z, 14), lat: l.lat!, lng: l.lng! });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  const c = toPx(v.lat, v.lng, v.z), left = c.x - size.w / 2, top = c.y - size.h / 2, N = 2 ** v.z;
  const zoomAt = (d: number, sx = size.w / 2, sy = size.h / 2) => {
    touched.current = true;
    const z = Math.min(18, Math.max(4, v.z + d)); if (z === v.z) return;
    const at = toLL(left + sx, top + sy, v.z), p = toPx(at.lat, at.lng, z);   // giữ nguyên điểm dưới ngón tay / con trỏ
    const nc = toLL(p.x - sx + size.w / 2, p.y - sy + size.h / 2, z);
    setView({ z, lat: nc.lat, lng: nc.lng });
  };
  // kéo / chụm 2 ngón
  const ptr = useRef(new Map<number, { x: number; y: number }>());
  const gest = useRef<{ x: number; y: number; cx: number; cy: number; d: number } | null>(null);
  const begin = () => {
    const P = [...ptr.current.values()];
    if (!P.length) { gest.current = null; return; }
    const mx = P.reduce((a, p) => a + p.x, 0) / P.length, my = P.reduce((a, p) => a + p.y, 0) / P.length;
    gest.current = { x: mx, y: my, cx: c.x, cy: c.y, d: P.length > 1 ? Math.hypot(P[0]!.x - P[1]!.x, P[0]!.y - P[1]!.y) : 0 };
  };
  const tiles: { x: number; y: number; k: string }[] = [];
  for (let tx = Math.floor(left / T); tx <= Math.floor((left + size.w) / T); tx++)
    for (let ty = Math.floor(top / T); ty <= Math.floor((top + size.h) / T); ty++)
      if (ty >= 0 && ty < N) tiles.push({ x: tx, y: ty, k: `${v.z}/${tx}/${ty}` });
  const src = (x: number, y: number) => config.mapTiles.replace('{z}', String(v.z)).replace('{x}', String(((x % N) + N) % N)).replace('{y}', String(y));
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div className="lm-map" ref={box}
         onWheel={(e) => { const r = e.currentTarget.getBoundingClientRect(); zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top); }}
         onPointerDown={(e) => {
           cancelAnimationFrame(anim.current); touched.current = true; onTouch();   // chạm bản đồ: tự thu danh sách
           (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
           ptr.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); begin();
         }}
         onPointerMove={(e) => {
           if (!ptr.current.has(e.pointerId)) return;
           ptr.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
           const g = gest.current; if (!g) return;
           const P = [...ptr.current.values()];
           const mx = P.reduce((a, p) => a + p.x, 0) / P.length, my = P.reduce((a, p) => a + p.y, 0) / P.length;
           if (P.length > 1 && g.d > 0) {   // chụm / mở 2 ngón: đổi 1 mức mỗi lần khoảng cách 2 ngón đổi rõ
             const d = Math.hypot(P[0]!.x - P[1]!.x, P[0]!.y - P[1]!.y);
             if (d > g.d * 1.6 || d < g.d / 1.6) {
               const r = e.currentTarget.getBoundingClientRect();
               zoomAt(d > g.d ? 1 : -1, mx - r.left, my - r.top);
               gest.current = null; requestAnimationFrame(begin);
               return;
             }
           }
           const nc = toLL(g.cx - (mx - g.x), g.cy - (my - g.y), v.z);
           setView({ z: v.z, lat: nc.lat, lng: nc.lng });
         }}
         onPointerUp={(e) => { ptr.current.delete(e.pointerId); begin(); }}
         onPointerCancel={(e) => { ptr.current.delete(e.pointerId); begin(); }}>
      {tiles.map((t) => <img key={t.k} src={src(t.x, t.y)} alt="" draggable={false} style={{ left: t.x * T - left, top: t.y * T - top }} />)}
      {pts.map((l) => {
        const p = toPx(l.lat!, l.lng!, v.z);
        return (
          <button key={l.trip_id} type="button" className={`lm-pin ${stOf(l)}${sel === l.trip_id ? ' on' : ''}`} style={{ left: p.x - left, top: p.y - top }}
                  onPointerDown={stop} onClick={() => onSel(l.trip_id)} aria-label={`Xe ${l.plate ?? ''}`}>
            <i className={`sk-arr ${stOf(l)}`} style={{ transform: `rotate(${(l.heading ?? 0) - 90}deg)` }}>➤</i>{l.plate ?? '?'}
          </button>
        );
      })}
      <div className="lm-zoom">
        <button type="button" aria-label="Phóng to" onPointerDown={stop} onClick={() => zoomAt(1)}>+</button>
        <button type="button" aria-label="Thu nhỏ" onPointerDown={stop} onClick={() => zoomAt(-1)}>−</button>
      </div>
      <button type="button" className="lm-fit" aria-label="Xem hết các xe" onPointerDown={stop} onClick={() => { touched.current = false; fly(fitView(home, size.w, size.h)); }}>⌖</button>
      <span className="lm-attr">© OpenStreetMap</span>
    </div>
  );
}
