// Vé xe in máy in nhiệt khổ 80mm (mặc định) hoặc 58mm (máy in cầm tay). Mỗi ghế 1 vé.
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
  }[];
}

const TZ = 'Asia/Ho_Chi_Minh';
const KEY = 'tms.khoVe';
const fmt = (iso: string, opt: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('vi-VN', { timeZone: TZ, ...opt });

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
    setTimeout(() => window.print(), 100);
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
        <button className="btn small primary" onClick={() => window.print()}>In lại</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className={`ve-list w${width}`}>
        {data.tickets.map((t, i) => (
          <div key={i} className="ve">
            {data.logo && <div className="c"><img src={data.logo} alt="" className="ve-logo" /></div>}
            <div className="c"><b>{data.tenant.toUpperCase()}</b></div>
            <div className="c ve-title">VÉ XE KHÁCH</div>
            <div className="c">Mã vé: <b>{data.code}</b>{data.tickets.length > 1 ? ` (${i + 1}/${data.tickets.length})` : ''}</div>
            {qr && <div className="c"><img src={qr} alt={`Mã vé ${data.code}`} className="ve-qr" /></div>}
            <div className="ve-line" />
            <div>Tuyến: <b>{data.routeName}</b></div>
            <div>Đi: <b>{t.from}</b> → <b>{t.to}</b></div>
            <div>Giờ chạy: <b>{fmt(data.departAt, { hour: '2-digit', minute: '2-digit', hour12: false })}</b> ngày <b>{fmt(data.departAt, { day: '2-digit', month: '2-digit', year: 'numeric' })}</b></div>
            <div>Ghế: <b className="ve-seat">{t.seat}</b>{data.plate ? <> · Xe: <b>{data.plate}</b></> : null}</div>
            {(t.name || t.phone) && <div>Khách: {t.name ?? ''} {t.phone ?? ''}</div>}
            {t.pickup && <div>Đón: {t.pickup}</div>}
            {t.dropoff && <div>Trả: {t.dropoff}</div>}
            <div className="ve-line" />
            <div>Giá vé: <b>{t.price.toLocaleString('vi-VN')} đ</b></div>
            <div className="c"><b>{t.paid ? 'ĐÃ THANH TOÁN' : `CHƯA THANH TOÁN${t.holdUntil ? ` – giữ chỗ đến ${fmt(t.holdUntil, { hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}`}</b></div>
            <div className="small">Người bán: {data.seller} · In lúc {fmt(new Date().toISOString(), { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false })}</div>
            {data.footer && <div className="small c">{data.footer}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
