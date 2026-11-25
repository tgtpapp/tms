// Bán vé / Gửi hàng: chọn tuyến bằng ô thả xuống hoặc bằng thẻ tuyến (như app cũ). Không có "Tất cả tuyến" để tránh đặt nhầm tuyến.
import { useState } from 'react';

export type RouteView = 'o' | 'the';
const KEY = 'tms.ban_ve.kieu_tuyen';
const read = (): RouteView => { try { return localStorage.getItem(KEY) === 'the' ? 'the' : 'o'; } catch { return 'o'; } };

/** Kiểu chọn tuyến dùng chung cho Bán vé và Gửi hàng, nhớ trên máy */
export function useRouteView(): [RouteView, (v: RouteView) => void] {
  const [v, setV] = useState<RouteView>(read);
  return [v, (x) => { setV(x); try { localStorage.setItem(KEY, x); } catch { /* trình duyệt chặn lưu: chỉ đổi trong phiên */ } }];
}

export function RouteViewToggle({ view, onChange }: { view: RouteView; onChange: (v: RouteView) => void }) {
  return (
    <div className="seg vx-rv" role="group" aria-label="Kiểu chọn tuyến">
      <button type="button" className={view === 'o' ? 'on' : ''} aria-pressed={view === 'o'} onClick={() => onChange('o')}>Ô chọn</button>
      <button type="button" className={view === 'the' ? 'on' : ''} aria-pressed={view === 'the'} onClick={() => onChange('the')}>Thẻ tuyến</button>
    </div>
  );
}

const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

export function RouteCards(props: {
  opts: { key: string; label: string }[]; trips: { route_id: string; direction: string; id: string }[];
  counts: Record<string, number>; unit: string; value: string; onPick: (key: string) => void;
}) {
  return (
    <div className="vx-rcards">
      {props.opts.map((o) => {
        const T = props.trips.filter((t) => `${t.route_id}|${t.direction}` === o.key);
        const n = T.reduce((a, t) => a + (props.counts[t.id] ?? 0), 0);
        return (
          <button key={o.key} type="button" className={`vx-rc${o.key === props.value ? ' on' : ''}`} style={{ ['--rc' as string]: `hsl(${hue(o.label)} 70% 42%)` }}
                  aria-pressed={o.key === props.value} onClick={() => props.onPick(o.key)}>
            <b>{o.label.toUpperCase()}</b><span>{T.length} chuyến · {n} {props.unit}</span>
          </button>
        );
      })}
    </div>
  );
}
