// Phiếu gửi hàng khổ K80 (như app cũ): xem trước ngay khi nhập, in máy in nhiệt 80mm (hoặc 58mm).
import { printThermal } from '../lib/thermalPrint';
import { ThermalInfo } from './ThermalInfo';
import { useEffect, useRef, useState } from 'react';

export interface SlipData {
  code: string | null;                     // null: chưa lưu (xem trước)
  company: { name: string; address: string; phone: string; tax: string; logo: string | null };
  departAt: string | null; route: string; plate: string; driver: string; driverPhone: string;
  from: string; to: string; senderName: string; senderPhone: string; receiverName: string; receiverPhone: string;
  description: string; packages: number; weight: number | null; value: number | null;
  fee: number; payer: 'nguoi_gui' | 'nguoi_nhan'; cod: number; note: string; staff: string; at: string;
}

const TZ = 'Asia/Ho_Chi_Minh';
const KEY = 'tms.khoVe';
const DOW = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const fmt = (iso: string, opt: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('vi-VN', { timeZone: TZ, ...opt });
const m = (n: number) => n.toLocaleString('vi-VN');
const dow = (iso: string) => DOW[new Date(new Date(iso).toLocaleString('en-US', { timeZone: TZ })).getDay()];

export function ParcelSlip({ d, i = 0, n = 1 }: { d: SlipData; i?: number; n?: number }) {
  const row = (k: string, v: string) => (v ? <div className="t8r"><span>{k}</span><b>{v}</b></div> : null);
  const paid = d.payer === 'nguoi_gui';
  return (
    <div className="ve gh8">
      <div className="gh8-top">
        {d.company.logo && <img src={d.company.logo} alt="" />}
        <b className="gh8-co">{d.company.name.toUpperCase()}</b>
      </div>
      {d.company.address && <div className="gh8-s">Địa chỉ: {d.company.address}</div>}
      {(d.company.phone || d.company.tax) && <div className="gh8-s">{d.company.phone && <>Hotline: <b>{d.company.phone}</b></>}{d.company.phone && d.company.tax ? ' · ' : ''}{d.company.tax && `MST: ${d.company.tax}`}</div>}
      <div className="c ve-title">PHIẾU GỬI HÀNG{n > 1 ? ` (${i + 1}/${n})` : ''}</div>
      <div className="c">Số phiếu <b>{d.code ?? '(cấp khi lưu)'}</b></div>
      <div className="ve-line" />
      <div className="gh8-big">
        <div><small>GIỜ CHẠY</small><b>{d.departAt ? fmt(d.departAt, { hour: '2-digit', minute: '2-digit', hour12: false }) : '--:--'}</b>
          <em>{d.departAt ? `${dow(d.departAt)} ${fmt(d.departAt, { day: '2-digit', month: '2-digit', year: 'numeric' })}` : 'Chưa gắn chuyến'}</em></div>
        <div className="gh8-sl"><small>SL</small><b>{d.packages}</b><em>kiện</em></div>
      </div>
      {d.route && <div className="c gh8-route">{d.route}</div>}
      {row('Biển số xe', d.plate)}{row('Lái xe', d.driver)}{row('SĐT lái xe', d.driverPhone)}
      <div className="ve-line" />
      <div className="gh8-pt"><small>GỬI</small><b>{d.from || '…………………'}</b><em>{[d.senderName, d.senderPhone && `SĐT: ${d.senderPhone}`].filter(Boolean).join(' · ')}</em></div>
      <div className="gh8-pt"><small>NHẬN</small><b>{d.to || '…………………'}</b><em>{[d.receiverName, d.receiverPhone && `SĐT: ${d.receiverPhone}`].filter(Boolean).join(' · ')}</em></div>
      <div className="ve-line" />
      <div className="gh8-it"><b>{d.description || '……………'}</b>
        <div className="t8r"><span>{d.packages} kiện{d.weight ? ` · ${d.weight} kg` : ''}</span><span>{d.value ? `Khai giá ${m(d.value)} đ` : ''}</span></div></div>
      <div className="t8r gh8-sum"><span>CƯỚC</span><b>{m(d.fee)} đ</b></div>
      {d.cod > 0 && <div className="t8r gh8-sum"><span>THU HỘ (COD)</span><b>{m(d.cod)} đ</b></div>}
      <div className={`gh8-pay${paid && !d.cod ? ' ok' : ''}`}>
        {paid ? 'NGƯỜI GỬI ĐÃ TRẢ CƯỚC' : `THU NGƯỜI NHẬN ${m(d.fee + d.cod)} đ`}
        {paid && d.cod > 0 ? <><br />THU NGƯỜI NHẬN {m(d.cod)} đ (thu hộ)</> : null}
      </div>
      {d.note && <div className="small">Ghi chú: {d.note}</div>}
      <div className="ve-line" />
      <div className="gh8-sg"><div><small>NGƯỜI GỬI</small><div className="gh8-sp" /><b>{d.senderName}</b></div><div><small>NV NHẬN HÀNG</small><div className="gh8-sp" /><b>{d.staff}</b></div></div>
      <div className="ve-line" />
      <div className="c small">Quý khách kiểm tra hàng khi nhận.<br />Giữ phiếu để đối chiếu.</div>
      <div className="small">Lập phiếu: {d.staff} · {fmt(d.at, { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false })}</div>
    </div>
  );
}

function readWidth(): '80' | '58' {
  try { return localStorage.getItem(KEY) === '58' ? '58' : '80'; } catch { return '80'; }
}

/** In phiếu: mở ngay hộp thoại in; đổi khổ 80 / 58mm, in lại */
export function ParcelPrint({ slips, onClose }: { slips: SlipData[]; onClose: () => void }) {
  const [width, setWidth] = useState<'80' | '58'>(readWidth);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    setTimeout(() => printThermal(), 150);
  }, []);
  const change = (w: '80' | '58') => { setWidth(w); try { localStorage.setItem(KEY, w); } catch { /* chỉ áp dụng lần này */ } };
  return (
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>Phiếu gửi hàng{slips.length === 1 ? ` ${slips[0]!.code ?? ''}` : ` · ${slips.length} phiếu`}</b>
        <button className={width === '80' ? 'btn small primary' : 'btn small'} onClick={() => change('80')}>Khổ 80mm</button>
        <button className={width === '58' ? 'btn small primary' : 'btn small'} onClick={() => change('58')}>Khổ 58mm</button>
        <ThermalInfo />
        <button className="btn small primary" onClick={() => printThermal()}>In lại</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className={`ve-list w${width}`}>{slips.map((d, i) => <ParcelSlip key={i} d={d} i={i} n={slips.length} />)}</div>
    </div>
  );
}
