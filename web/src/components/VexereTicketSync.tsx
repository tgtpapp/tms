// Đồng bộ vé Vexere → TMS: gói vé dán vào ô Nhập lịch Vexere, khớp chuyến theo tuyến + giờ, gọi sync_vexere_tickets từng chuyến.
import { useEffect, useMemo, useState } from 'react';
import { fmtDate } from './Documents';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { dirName, type Dir } from '../lib/routes';
import { routeKey } from '../lib/scheduleImport';
import { toSyncTicket, type VxPayload } from '../lib/vexereTickets';

interface Route { id: string; name: string; name_ve: string | null; is_active: boolean }
interface Trip { id: string; route_id: string; direction: Dir; depart_at: string }
interface Res { moi: number; cap_nhat: number; huy: number; giu_nguyen: number; loi: { ghe: string; loi: string }[] }

const TZ = 'Asia/Ho_Chi_Minh';
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

export function VexereTicketSync({ data, routes, onDone }: { data: VxPayload; routes: Route[]; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [res, setRes] = useState<Record<number, Res | string>>({});

  useEffect(() => {
    setRes({});
    void supabase.from('trips').select('id, route_id, direction, depart_at').eq('service_date', data.ngay).eq('status', 'mo')
      .then((r) => setTrips((r.data ?? []) as Trip[]));
  }, [data]);

  const rows = useMemo(() => {
    const opts = routes.filter((r) => r.is_active).flatMap((r) => (['di', 've'] as Dir[]).map((d) => ({ r, d, k: routeKey(dirName(r, d)) })));
    return data.chuyen.map((c) => {
      const o = opts.find((x) => x.k === routeKey(c.tuyen));
      const trip = o && trips ? trips.find((t) => t.route_id === o.r.id && t.direction === o.d && hhmm(t.depart_at) === c.gio) ?? null : null;
      const live = c.ve.filter((v) => v.st === 1 || v.st === 2).length;
      return { c, trip, live, why: !o ? 'Không có tuyến này trong TMS' : trips && !trip ? 'Không có chuyến giờ này trong TMS' : '' };
    });
  }, [data, routes, trips]);

  async function sync() {
    let ok = 0, moi = 0, upd = 0, huy = 0, bad = 0;
    for (const [i, r] of rows.entries()) {
      if (!r.trip) continue;
      setBusy(`Đang đồng bộ ${r.c.gio} ${r.c.tuyen}…`);
      try {
        const x = await rpc<Res>('sync_vexere_tickets', { p_trip_id: r.trip.id, p_tickets: r.c.ve.map(toSyncTicket) });
        setRes((s) => ({ ...s, [i]: x }));
        ok++; moi += x.moi; upd += x.cap_nhat; huy += x.huy; bad += x.loi.length;
      } catch (e) {
        setRes((s) => ({ ...s, [i]: errMsg(e) }));
        bad++;
      }
    }
    setBusy(null);
    toast(bad ? 'error' : 'ok', `Đã đồng bộ vé ${ok} chuyến: mới ${moi}, cập nhật ${upd}, hủy ${huy}${bad ? `, ${bad} lỗi` : ''}`);
    await onDone();
  }

  const nTrip = rows.filter((r) => r.trip).length;
  return (
    <>
      <div>
        <b>Vé Vexere</b> · ngày {fmtDate(data.ngay)} · <b>{rows.length}</b> chuyến · <b>{rows.reduce((a, r) => a + r.live, 0)}</b> vé
      </div>
      <div className="table-wrap import-tbl">
        <table className="plist">
          <thead><tr><th>Tuyến</th><th>Giờ</th><th>Vé</th><th>Kết quả</th></tr></thead>
          <tbody>
            {rows.map((r, i) => {
              const x = res[i];
              return (
                <tr key={i}>
                  <td>{r.c.tuyen}</td>
                  <td>{r.c.gio}</td>
                  <td>{r.live}</td>
                  <td>
                    {r.why ? <span className="imp-st bad">{r.why}</span>
                      : typeof x === 'string' ? <span className="imp-st bad">{x}</span>
                      : x ? (
                        <span className={`imp-st ${x.loi.length ? 'warn' : 'ok'}`}>
                          Mới {x.moi} · Cập nhật {x.cap_nhat} · Hủy {x.huy} · Giữ nguyên {x.giu_nguyen}
                          {x.loi.map((l, k) => <div key={k}>Ghế {l.ghe}: {l.loi}</div>)}
                        </span>
                      ) : <span className="imp-st muted">Chờ đồng bộ</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {busy && <p className="small state-sap_het">{busy}</p>}
      <div className="actions">
        <button type="button" className="btn primary" disabled={!!busy || !trips || !nTrip} onClick={() => void sync()}>✔ Đồng bộ vé ({nTrip} chuyến)</button>
      </div>
    </>
  );
}
