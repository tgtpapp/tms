// Phiếu nhiên liệu in máy in nhiệt khổ 80mm (như app cũ): phiếu nhập dầu / xuất dầu / đổ dầu ngoài.
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { moneyWords } from '../lib/vnWords';

export interface FuelSlipData {
  company: string; address: string; kind: 'nhap' | 'bon' | 'ngoai'; code: string; date: string; time: string | null; tank: string; fuelType: string;
  plate: string; driver: string; supplier: string; invoice: string; deliverer?: string; odo: number | null; kmRun: number; per100: number; norm: number | null;
  liters: number; price: number; avgPrice: boolean; market: boolean; tankAfter: number; note: string; by: string;
}
const n0 = (n: number, d = 0) => n.toLocaleString('vi-VN', { maximumFractionDigits: d });
const TITLE = { nhap: 'PHIẾU NHẬP DẦU', bon: 'PHIẾU XUẤT DẦU', ngoai: 'PHIẾU ĐỔ DẦU NGOÀI' } as const;

export function FuelSlip({ list, onClose }: { list: FuelSlipData[]; onClose: () => void }) {
  const printed = useRef(false);
  useEffect(() => { if (printed.current) return; printed.current = true; setTimeout(() => window.print(), 150); }, []);
  const now = new Date(), pad = (x: number) => String(x).padStart(2, '0');
  return createPortal(
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>{list.length === 1 ? `Phiếu ${list[0]!.code}` : `${list.length} phiếu dầu`} · khổ 80mm</b>
        <button className="btn small primary" onClick={() => window.print()}>In lại</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className="ve-list w80">
        {list.map((r) => {
          const tt = Math.round(r.liters * r.price);
          const kv = (l: string, v: ReactNode) => (v === '' || v == null ? null : <div className="nl80-kv"><span>{l}</span><b>{v}</b></div>);
          return (
            <div key={r.code} className="ve nl80">
              <div className="c"><b>{r.company.toUpperCase()}</b></div>
              {r.address && <div className="c small">{r.address}</div>}
              <div className="ve-line" />
              <div className="c ve-title">{TITLE[r.kind]}</div>
              <div className="c">Số: <b>{r.code}</b></div>
              <div className="c small">{r.date.split('-').reverse().join('/')}{r.time ? ` · ${r.time}` : ''}</div>
              <div className="ve-line" />
              {r.kind === 'nhap' ? <>{kv('Nhà cung cấp', r.supplier)}{kv('Số hóa đơn', r.invoice)}{kv('Nhập vào', r.tank)}</> : <>
                {kv('Biển số xe', <span className="nl80-big">{r.plate}</span>)}{kv('Lái xe', r.driver)}{r.kind === 'ngoai' ? kv('Cây xăng', r.supplier) : kv('Xuất từ', r.tank)}
                {r.kind === 'ngoai' && kv('Số hóa đơn', r.invoice)}
                {kv('Km đồng hồ', r.odo ? `${n0(r.odo)} km` : '')}{kv('Km từ lần đổ trước', r.kmRun ? `${n0(r.kmRun)} km` : '')}
                {kv('Tiêu hao', r.per100 ? `${n0(r.per100, 1)} L/100km${r.norm ? ` (ĐM ${n0(r.norm, 1)})` : ''}` : '')}</>}
              {kv('Nhiên liệu', r.fuelType)}
              <div className="nl80-box"><span>SỐ LƯỢNG</span><b>{n0(r.liters, 2)} lít</b></div>
              {kv('Đơn giá', <>{n0(r.price)} đ/lít{r.avgPrice ? <><br /><i className="small">(giá bình quân bồn)</i></> : r.market ? <><br /><i className="small">(giá niêm yết Petrolimex)</i></> : null}</>)}
              <div className="nl80-kv nl80-tot"><span>THÀNH TIỀN</span><b>{n0(tt)} đ</b></div>
              {tt > 0 && <div className="small"><i>Bằng chữ: {moneyWords(tt)}</i></div>}
              {r.note && <div className="small">Ghi chú: {r.note}</div>}
              {r.kind !== 'ngoai' && <><div className="ve-line" />{kv('Tồn bồn sau phiếu', `${n0(r.tankAfter, 2)} lít`)}</>}
              <div className="ve-line" />
              <table className="nl80-sg"><tbody><tr>
                <td><b>{r.kind === 'nhap' ? 'Người giao' : r.kind === 'bon' ? 'Người cấp' : 'Người duyệt'}</b><br /><i>(Ký, họ tên)</i></td>
                <td><b>{r.kind === 'nhap' ? 'Thủ kho' : 'Lái xe nhận'}</b><br /><i>(Ký, họ tên)</i></td>
              </tr></tbody></table>
              <div className="c small">{r.by ? `Lập: ${r.by} · ` : ''}In: {pad(now.getDate())}/{pad(now.getMonth() + 1)} {pad(now.getHours())}:{pad(now.getMinutes())}</div>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
