// Vị trí xe: các chuyến đang chạy (đã xuất bến, chưa đến bến) với vị trí mới nhất do app lái xe gửi về. Tự tải lại 30 giây / lần.
// Bản đồ vẽ bằng ảnh nền (VITE_MAP_TILES, vd OpenStreetMap), không cài thêm thư viện.
import { useEffect, useMemo, useRef, useState } from 'react';
import { config } from '../config';
import { errMsg, rpc, supabase } from '../lib/supabase';

interface Live { trip_id: string; depart_at: string; route_id: string; direction: 'di' | 've'; plate: string | null; driver: string | null;
  at: string | null; lat: number | null; lng: number | null; speed: number | null; heading: number | null }
const T = 256;
const px = (lat: number, lng: number, z: number) => {
  const n = T * 2 ** z, s = Math.sin((lat * Math.PI) / 180);
  return { x: ((lng + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
};
const hhmm = (t: string) => new Date(t).toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', hour12: false });
const ago = (t: string) => { const m = Math.round((Date.now() - new Date(t).getTime()) / 60000); return m < 1 ? 'vừa xong' : m < 60 ? `${m} phút trước` : `${Math.floor(m / 60)} giờ ${m % 60} phút trước`; };

export function LiveMapScreen() {
  const [list, setList] = useState<Live[] | null>(null);
  const [routes, setRoutes] = useState<Record<string, { name: string; name_ve: string | null }>>({});
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  async function load() {
    try { setList((await rpc<Live[]>('live_vehicles', {})).map((x) => ({ ...x, lat: x.lat == null ? null : Number(x.lat), lng: x.lng == null ? null : Number(x.lng) }))); setErr(''); }
    catch (e) { setErr(errMsg(e)); }
  }
  useEffect(() => {
    void supabase.from('routes').select('id, name, name_ve').then((r) => setRoutes(Object.fromEntries(((r.data ?? []) as { id: string; name: string; name_ve: string | null }[]).map((x) => [x.id, x]))));
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => clearInterval(t);
  }, []);
  const routeOf = (l: Live) => { const r = routes[l.route_id]; return r ? (l.direction === 've' && r.name_ve ? r.name_ve : r.name) : ''; };
  const pts = (list ?? []).filter((l) => l.lat != null && l.lng != null);

  return (
    <section className="card">
      <h2>Vị trí xe</h2>
      {err && <p className="error-text">{err}</p>}
      {list && !list.length && <p className="muted">Không có xe nào đang chạy</p>}
      {config.mapTiles && pts.length > 0 && <TileMap pts={pts} sel={sel} onSel={setSel} label={(l) => l.plate ?? '?'} />}
      {list && list.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Xe</th><th>Chuyến</th><th>Lái xe</th><th>Cập nhật</th><th>Tốc độ</th></tr></thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.trip_id} className={sel === l.trip_id ? 'lm-on' : ''} onClick={() => setSel(l.trip_id)} style={{ cursor: 'pointer' }}>
                  <td><b>{l.plate ?? 'chưa có xe'}</b></td><td>{hhmm(l.depart_at)} {routeOf(l)}</td><td>{l.driver ?? ''}</td>
                  <td>{l.at ? `${hhmm(l.at)} (${ago(l.at)})` : 'chưa có vị trí'}</td><td>{l.speed != null ? `${Math.round(Number(l.speed))} km/h` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {config.mapTiles && pts.length > 0 && <p className="small muted">Bản đồ © OpenStreetMap</p>}
    </section>
  );
}

/** Bản đồ ảnh nền: tự canh cho thấy hết các xe; kéo để di chuyển, nút +/− để phóng to / thu nhỏ */
function TileMap({ pts, sel, onSel, label }: { pts: Live[]; sel: string | null; onSel: (id: string) => void; label: (l: Live) => string }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const H = 380;
  const [view, setView] = useState<{ z: number; cx: number; cy: number } | null>(null);   // null: tự canh theo các xe
  useEffect(() => {
    const el = box.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600)); ro.observe(el); setW(el.clientWidth || 600);
    return () => ro.disconnect();
  }, []);
  const fit = useMemo(() => {
    for (let z = 15; z >= 5; z--) {
      const p = pts.map((l) => px(l.lat!, l.lng!, z));
      const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
      const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys);
      if ((dx < w - 80 && dy < H - 80) || z === 5) return { z, cx: (Math.max(...xs) + Math.min(...xs)) / 2, cy: (Math.max(...ys) + Math.min(...ys)) / 2 };
    }
    return { z: 10, cx: 0, cy: 0 };
  }, [pts, w]);
  const v = view ?? fit;
  // xe được chọn: đưa vào giữa
  useEffect(() => {
    const l = pts.find((x) => x.trip_id === sel); if (!l) return;
    const z = (view ?? fit).z, p = px(l.lat!, l.lng!, z);
    setView({ z, cx: p.x, cy: p.y });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel]);
  const left = v.cx - w / 2, top = v.cy - H / 2, n = 2 ** v.z;
  const tiles: { x: number; y: number; k: string }[] = [];
  for (let tx = Math.floor(left / T); tx <= Math.floor((left + w) / T); tx++)
    for (let ty = Math.floor(top / T); ty <= Math.floor((top + H) / T); ty++)
      if (ty >= 0 && ty < n) tiles.push({ x: tx, y: ty, k: `${v.z}/${tx}/${ty}` });
  const src = (x: number, y: number) => config.mapTiles.replace('{z}', String(v.z)).replace('{x}', String(((x % n) + n) % n)).replace('{y}', String(y));
  const zoom = (d: number) => { const z = Math.min(18, Math.max(4, v.z + d)), k = 2 ** (z - v.z); setView({ z, cx: v.cx * k, cy: v.cy * k }); };
  const drag = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);
  return (
    <div className="lm-map" ref={box} style={{ height: H }}
         onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, cx: v.cx, cy: v.cy }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }}
         onPointerMove={(e) => { const d = drag.current; if (d) setView({ z: v.z, cx: d.cx - (e.clientX - d.x), cy: d.cy - (e.clientY - d.y) }); }}
         onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {tiles.map((t) => <img key={t.k} src={src(t.x, t.y)} alt="" draggable={false} style={{ left: t.x * T - left, top: t.y * T - top }} />)}
      {pts.map((l) => {
        const p = px(l.lat!, l.lng!, v.z);
        return (
          <button key={l.trip_id} type="button" className={`lm-pin${sel === l.trip_id ? ' on' : ''}`} style={{ left: p.x - left, top: p.y - top }}
                  onPointerDown={(e) => e.stopPropagation()} onClick={() => onSel(l.trip_id)} aria-label={`Xe ${label(l)}`}>
            {l.heading != null && <i style={{ transform: `rotate(${l.heading}deg)` }}>▲</i>}{label(l)}
          </button>
        );
      })}
      <div className="lm-zoom">
        <button type="button" className="btn small" aria-label="Phóng to" onPointerDown={(e) => e.stopPropagation()} onClick={() => zoom(1)}>+</button>
        <button type="button" className="btn small" aria-label="Thu nhỏ" onPointerDown={(e) => e.stopPropagation()} onClick={() => zoom(-1)}>−</button>
        <button type="button" className="btn small" aria-label="Xem hết các xe" onPointerDown={(e) => e.stopPropagation()} onClick={() => setView(null)}>⤢</button>
      </div>
    </div>
  );
}
