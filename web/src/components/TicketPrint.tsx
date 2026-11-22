// Vé xe in máy in nhiệt khổ 80mm (mặc định) hoặc 58mm (máy in cầm tay). Mỗi ghế 1 vé.
import { printThermal } from '../lib/thermalPrint';
import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';

export interface TicketPrintData {
  code: string;
  tenant: string;
  routeName: string;
  departAt: string;
  plate: string | null;
  seller: string;
  footer: string | null;   // ghi chú quy định in cuối vé (Cấu hình → Bán vé)
  logo: string | null;
  tickets: {
    seat: string; from: string; to: string; price: number; name: string | null; phone: string | null;
    pickup: string | null; dropoff: string | null; paid: boolean; holdUntil: string | null;
    /** đã cọc (vé đặt chỗ trả trước một phần) */
    deposit?: number;
  }[];
}

const TZ = 'Asia/Ho_Chi_Minh';
const KEY = 'tms.khoVe';
const fmt = (iso: string, opt: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('vi-VN', { timeZone: TZ, ...opt });
const DOW = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const dow = (iso: string) => DOW[new Date(new Date(iso).toLocaleString('en-US', { timeZone: TZ })).getDay()];
const hm = (iso: string) => fmt(iso, { hour: '2-digit', minute: '2-digit', hour12: false });

/** 1 vé khổ K80 / K58, bố cục như phiếu gửi hàng: gọn, đủ nội dung, tiết kiệm giấy. Dùng cho bản in và xem trước khi bán. */
export function TicketSlip({ data, i, qr }: { data: TicketPrintData; i: number; qr: string | null }) {
  const t = data.tickets[i]!, n = data.tickets.length;
  const row = (k: string, v: string | null | undefined) => (v ? <div className="t8r"><span>{k}</span><b>{v}</b></div> : null);
  return (
    <div className="ve gh8 vx8">
      <div className="gh8-top">
        {data.logo && <img src={data.logo} alt="" />}
        <b className="gh8-co">{data.tenant.toUpperCase()}</b>
      </div>
      <div className="c ve-title">VÉ XE KHÁCH{n > 1 ? ` (${i + 1}/${n})` : ''}</div>
      <div className="c">Mã vé <b>{data.code}</b></div>
      <div className="ve-line" />
      <div className="gh8-big">
        <div><small>GIỜ CHẠY</small><b>{hm(data.departAt)}</b><em>{dow(data.departAt)} {fmt(data.departAt, { day: '2-digit', month: '2-digit', year: 'numeric' })}</em></div>
        <div className="gh8-sl"><small>GHẾ</small><b>{t.seat}</b></div>
      </div>
      <div className="c gh8-route">{data.routeName}</div>
      {row('Biển số xe', data.plate)}
      <div className="ve-line" />
      <div className="gh8-pt"><small>ĐI</small><b>{t.from}</b>{t.pickup && <em>Đón: {t.pickup}</em>}</div>
      <div className="gh8-pt"><small>ĐẾN</small><b>{t.to}</b>{t.dropoff && <em>Trả: {t.dropoff}</em>}</div>
      {(t.name || t.phone) && row('Khách', [t.name, t.phone].filter(Boolean).join(' · '))}
      <div className="ve-line" />
      <div className="vx8-pay">
        <div>
          <div className="t8r gh8-sum"><span>GIÁ VÉ</span><b>{t.price.toLocaleString('vi-VN')} đ</b></div>
          <div className={`gh8-pay${t.paid ? ' ok' : ''}`}>{t.paid ? 'ĐÃ THANH TOÁN' : (t.deposit ?? 0) > 0
            ? <>ĐÃ CỌC {(t.deposit ?? 0).toLocaleString('vi-VN')} đ<br />CÒN {(t.price - (t.deposit ?? 0)).toLocaleString('vi-VN')} đ</>
            : `CHƯA THANH TOÁN${t.holdUntil ? ` · giữ chỗ đến ${hm(t.holdUntil)}` : ''}`}</div>
        </div>
        {qr && <img src={qr} alt={`Mã vé ${data.code}`} className="vx8-qr" />}
      </div>
      {data.footer && <div className="small c">{data.footer}</div>}
      <div className="small">Người bán: {data.seller} · In {fmt(new Date().toISOString(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false })}</div>
    </div>
  );
}

function readWidth(): '80' | '58' {
  try {
    return localStorage.getItem(KEY) === '58' ? '58' : '80';
  } catch {
    return '80';
  }
}

export function TicketPrint({ data, onClose }: { data: TicketPrintData; onClose: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const [width, setWidth] = useState<'80' | '58'>(readWidth);
  const printed = useRef(false);

  useEffect(() => {
    void QRCode.toDataURL(data.code, { margin: 0, width: 200 }).then(setQr);
  }, [data.code]);

  // Có QR rồi thì mở hộp thoại in ngay
  useEffect(() => {
    if (!qr || printed.current) return;
    printed.current = true;
    // chờ logo + QR tải xong mới in (in khi ảnh chưa tải xong thì bản in mất logo)
    setTimeout(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>('.ve-list img')];
      const wait = imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; })));
      void Promise.race([Promise.all(wait), new Promise((r) => setTimeout(r, 4000))]).then(() => printThermal());
    }, 100);
  }, [qr]);

  function changeWidth(w: '80' | '58') {
    setWidth(w);
    try {
      localStorage.setItem(KEY, w);
    } catch {
      /* trình duyệt chặn lưu: chỉ áp dụng lần này */
    }
  }

  return (
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>Vé {data.code} · {data.tickets.length} ghế</b>
        <button className={width === '80' ? 'btn small primary' : 'btn small'} onClick={() => changeWidth('80')}>Khổ 80mm</button>
        <button className={width === '58' ? 'btn small primary' : 'btn small'} onClick={() => changeWidth('58')}>Khổ 58mm</button>
        <button className="btn small primary" onClick={() => printThermal()}>In lại</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className={`ve-list w${width}`}>
        {data.tickets.map((_, i) => <TicketSlip key={i} data={data} i={i} qr={qr} />)}
      </div>
    </div>
  );
}
