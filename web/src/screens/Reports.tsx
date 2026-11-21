// Báo cáo vận tải và bán vé (như app cũ): chọn kỳ, xem bảng tổng hợp, tải CSV mở bằng Excel.
import { useCallback, useEffect, useState } from 'react';
import { fmtDate, today } from '../components/Documents';
import { errMsg, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';

type Row = Record<string, string | number | null>;
interface Transport { routes: Row[]; vehicles: Row[]; drivers: Row[]; charters: { count: number; value: number } }
interface Sales { total: Row; days: Row[]; routes: Row[]; channels: Row[]; sellers: Row[]; cash: Row[] }
type Col = [key: string, label: string, kind?: 'money' | 'num' | 'date' | 'text'];

const n = (v: unknown) => Number(v ?? 0);
const fmt = (v: unknown, k?: Col[2]) => {
  if (k === 'date') return fmtDate(String(v));
  if (k === 'text') return String(v ?? '');
  return n(v).toLocaleString('vi-VN', { maximumFractionDigits: 1 });
};
const CHANNEL: Record<string, string> = { quay: 'Quầy', online: 'Online', vexere: 'Vexere', giay: 'Vé giấy' };
const monthRange = (d: Date) => {
  const y = d.getFullYear(), m = d.getMonth();
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))] as const;
};

function csv(name: string, cols: Col[], rows: Row[]) {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const body = [cols.map((c) => c[1]), ...rows.map((r) => cols.map((c) => (c[2] === 'date' ? fmtDate(String(r[c[0]])) : String(r[c[0]] ?? ''))))]
    .map((l) => l.map(esc).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿', body], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Table({ title, cols, rows, file, foot = true }: { title: string; cols: Col[]; rows: Row[]; file: string; foot?: boolean }) {
  return (
    <section className="card">
      <div className="item-head">
        <h3 className="section-title">{title}</h3>
        {rows.length > 0 && <button className="btn small" onClick={() => csv(file, cols, rows)}>Tải Excel (CSV)</button>}
      </div>
      {rows.length === 0 ? <p className="muted small">Không có số liệu trong kỳ.</p> : (
        <div className="table-wrap">
          <table className="plist">
            <thead><tr>{cols.map((c) => <th key={c[0]}>{c[1]}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}>{cols.map((c, k) => <td key={c[0]}>{k === 0 ? <b>{fmt(r[c[0]], c[2])}</b> : fmt(r[c[0]], c[2])}</td>)}</tr>)}</tbody>
            {foot && rows.length > 1 && <tfoot><tr>{cols.map((c, k) => <th key={c[0]}>{k === 0 ? 'Cộng' : c[2] === 'money' || c[2] === 'num' ? fmt(rows.reduce((a, r) => a + n(r[c[0]]), 0)) : ''}</th>)}</tr></tfoot>}
          </table>
        </div>
      )}
    </section>
  );
}

export function ReportsScreen() {
  const toast = useToast();
  const [tab, setTab] = useState<'van_tai' | 'ban_ve'>('ban_ve');
  const [[from, to], setRange] = useState<readonly [string, string]>(monthRange(new Date()));
  const [tr, setTr] = useState<Transport | null>(null);
  const [sa, setSa] = useState<Sales | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!from || !to) return;
    setBusy(true);
    try {
      if (tab === 'van_tai') setTr(await rpc<Transport>('report_transport', { p_from: from, p_to: to }));
      else setSa(await rpc<Sales>('report_sales', { p_from: from, p_to: to }));
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }, [tab, from, to, toast]);
  useEffect(() => { void load(); }, [load]);

  const now = new Date();
  const presets: [string, readonly [string, string]][] = [
    ['Hôm nay', [today(), today()]],
    ['Tháng này', monthRange(now)],
    ['Tháng trước', monthRange(new Date(now.getFullYear(), now.getMonth() - 1, 1))],
  ];
  const tag = `${from}_${to}`;
  const t = sa?.total;
  const fill = t && n(t.seats) ? Math.round((n(t.tickets) / n(t.seats)) * 100) : null;

  return (
    <>
      <section className="card">
        <div className="item-head">
          <h2>Báo cáo</h2>
          <div className="seg" role="tablist" aria-label="Loại báo cáo">
            {([['ban_ve', 'Bán vé'], ['van_tai', 'Vận tải']] as const).map(([k, l]) =>
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </div>
        </div>
        <div className="inline-form">
          <label>Từ ngày<input type="date" value={from} onChange={(e) => setRange([e.target.value, to])} /></label>
          <label>Đến ngày<input type="date" value={to} onChange={(e) => setRange([from, e.target.value])} /></label>
          {presets.map(([l, r]) => <button key={l} type="button" className={`btn small${r[0] === from && r[1] === to ? ' primary' : ''}`} onClick={() => setRange(r)}>{l}</button>)}
        </div>
        {busy && <p className="small muted">Đang tính…</p>}
      </section>

      {tab === 'ban_ve' && sa && t && (
        <>
          <section className="card">
            <div className="stat-row">
              <div><span className="muted small">Vé (đã TT / tổng)</span><b>{fmt(t.paid)} / {fmt(t.tickets)}</b></div>
              <div><span className="muted small">Doanh thu vé đã thu</span><b>{fmt(t.revenue)} đ</b></div>
              <div><span className="muted small">Đặt chưa trả</span><b>{fmt(t.unpaid)} đ</b></div>
              <div><span className="muted small">Chuyến · lấp đầy</span><b>{fmt(t.trips)} · {fill == null ? '—' : `${fill}%`}</b></div>
            </div>
          </section>
          <Table title="Theo ngày" file={`ban-ve-theo-ngay_${tag}`} rows={sa.days} cols={[['day', 'Ngày', 'date'], ['trips', 'Chuyến', 'num'], ['seats', 'Chỗ', 'num'], ['tickets', 'Vé', 'num'], ['revenue', 'Đã thu (đ)', 'money'], ['unpaid', 'Chưa trả (đ)', 'money']]} />
          <Table title="Theo tuyến" file={`ban-ve-theo-tuyen_${tag}`} rows={sa.routes} cols={[['name', 'Tuyến', 'text'], ['trips', 'Chuyến có vé', 'num'], ['tickets', 'Vé', 'num'], ['revenue', 'Đã thu (đ)', 'money'], ['unpaid', 'Chưa trả (đ)', 'money']]} />
          <Table title="Theo kênh bán" file={`ban-ve-theo-kenh_${tag}`} rows={sa.channels.map((r) => ({ ...r, name: CHANNEL[String(r.name)] ?? r.name }))} cols={[['name', 'Kênh', 'text'], ['tickets', 'Vé', 'num'], ['revenue', 'Đã thu (đ)', 'money']]} />
          <Table title="Theo người bán" file={`ban-ve-theo-nguoi-ban_${tag}`} rows={sa.sellers} cols={[['name', 'Người bán / thu', 'text'], ['tickets', 'Vé', 'num'], ['revenue', 'Đã thu (đ)', 'money']]} />
          <Table title="Tiền thực thu theo sổ cái (theo ngày ghi sổ)" file={`thuc-thu_${tag}`} rows={sa.cash}
            cols={[['name', 'Người thu', 'text'], ['tickets', 'Tiền vé (đ)', 'money'], ['parcels', 'Tiền hàng (đ)', 'money'], ['charters', 'Hợp đồng (đ)', 'money'], ['amount', 'Cộng (đ)', 'money']]} />
        </>
      )}

      {tab === 'van_tai' && tr && (
        <>
          <section className="card">
            <div className="stat-row">
              <div><span className="muted small">Chuyến đã chạy / lên lịch</span><b>{fmt(tr.routes.reduce((a, r) => a + n(r.trips), 0))}</b></div>
              <div><span className="muted small">Chuyến hủy</span><b>{fmt(tr.routes.reduce((a, r) => a + n(r.cancelled), 0))}</b></div>
              <div><span className="muted small">Hợp đồng</span><b>{fmt(tr.charters.count)} · {fmt(tr.charters.value)} đ</b></div>
              <div><span className="muted small">Km GPS</span><b>{fmt(tr.vehicles.reduce((a, r) => a + n(r.km_gps), 0))}</b></div>
            </div>
          </section>
          <Table title="Theo tuyến" file={`van-tai-theo-tuyen_${tag}`} rows={tr.routes} cols={[['name', 'Tuyến', 'text'], ['trips', 'Chuyến', 'num'], ['cancelled', 'Hủy', 'num'], ['no_vehicle', 'Chưa xếp xe', 'num'], ['km', 'Km theo cự ly tuyến', 'num']]} />
          <Table title="Theo xe" file={`van-tai-theo-xe_${tag}`} rows={tr.vehicles} cols={[['plate', 'Xe', 'text'], ['trips', 'Chuyến', 'num'], ['days', 'Ngày chạy', 'num'], ['charters', 'Hợp đồng', 'num'], ['km_gps', 'Km GPS', 'num'], ['fuel_l', 'Dầu (lít)', 'num'], ['repair_cost', 'Sửa chữa (đ)', 'money']]} />
          <Table title="Theo lái xe / phụ xe" file={`van-tai-theo-lai-xe_${tag}`} rows={tr.drivers} cols={[['name', 'Họ tên', 'text'], ['main', 'Lái chính', 'num'], ['second', 'Lái phụ', 'num'], ['assistant', 'Phụ xe', 'num'], ['days', 'Ngày làm', 'num']]} />
        </>
      )}
    </>
  );
}
