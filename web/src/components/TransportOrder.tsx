// Lệnh vận chuyển – in giấy A4 theo mẫu của nhà xe (không có tùy chọn in: bấm là in).
import { Fragment, useEffect, useRef, type ReactNode } from 'react';

export interface OrderPrintData {
  orderNo: string;
  issueDate: string;            // YYYY-MM-DD
  validFrom: string;
  validTo: string;
  company: string;
  signerTitle: string;
  signerName: string;
  signerImg: string | null;
  signerShowName: boolean;          // chữ ký đã có họ tên thì không in thêm
  dispatcherShowName: boolean;
  driver1Sign: string | null; driver1ShowName: boolean;
  driver2Sign: string | null; driver2ShowName: boolean;
  sealImg: string | null;
  driver1: { name: string; hang: string | null } | null;
  driver2: { name: string; hang: string | null } | null;
  assistant: string | null;
  plate: string;
  seats: number | null;
  routeName: string;
  distanceKm: number | null;
  registeredCode: string | null;
  itinerary: string | null;
  fromStop: string;
  toStop: string;
  legs: { time: string | null; date: string | null }[];   // 4 lượt: đi, về, đi, về (lượt trống thì để chỗ viết tay)
  dispatcherName: string | null;
  dispatcherImg: string | null;
  qr: string;                   // ảnh QR (data URL)
}

const d = (s: string) => s.split('-').reverse().join('/');
const Blank = ({ w = 90, children }: { w?: number; children?: ReactNode }) => (
  <span className="lenh-blank" style={{ minWidth: w }}>{children}</span>
);

/** Lệnh luôn vừa 1 tờ A4: đo bản sao ở đúng bề rộng in (A4 trừ lề 8 mm = 194 mm), cao hơn 281 mm thì thu nhỏ khi in */
function fitA4(el: HTMLElement | null) {
  if (!el) return;
  const c = el.cloneNode(true) as HTMLElement;
  c.style.cssText = 'position:absolute;left:-10000px;top:0;width:194mm;max-width:none;visibility:hidden';
  document.body.appendChild(c);
  const mm = c.offsetWidth / 194, h = c.offsetHeight / mm;
  c.remove();
  el.style.setProperty('--fit', String(h > 279 ? Math.max(0.6, 279 / h) : 1));
}

export function TransportOrderPrint({ data, onClose }: { data: OrderPrintData; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [y, m, dd] = data.issueDate.split('-');

  // Chờ ảnh (chữ ký, QR) tải xong rồi mở hộp thoại in của trình duyệt
  useEffect(() => {
    const imgs = Array.from(ref.current?.querySelectorAll('img') ?? []);
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      fitA4(ref.current);
      window.print();
    };
    const before = () => fitA4(ref.current);
    window.addEventListener('beforeprint', before);
    Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; }))))
      .then(() => setTimeout(go, 100));
    const t = setTimeout(go, 4000);
    return () => { clearTimeout(t); window.removeEventListener('beforeprint', before); };
  }, []);

  const leg = (key: number, title: string, from: string, to: string, time: string | null, date: string | null) => (
    <Fragment key={key}>
      <tr className="lenh-leg">
        <td rowSpan={2} className="c"><b>{title}</b></td>
        <td className="c">Bến xe đi:<br /><b>{from.toUpperCase()}</b></td>
        <td className="c"><b>Xuất bến:</b><br /><Blank w={40}>{time}</Blank> giờ ngày <Blank>{date ? d(date) : ''}</Blank></td>
        <td />
        <td />
      </tr>
      <tr className="lenh-leg">
        <td className="c">Bến xe đến:<br /><b>{to.toUpperCase()}</b></td>
        <td className="c"><b>đến bến:</b><br /><Blank w={40} /> giờ ngày <Blank /></td>
        <td />
        <td />
      </tr>
    </Fragment>
  );

  return (
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>Lệnh {data.orderNo}</b>
        <button className="btn small primary" onClick={() => window.print()}>In lại</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className="lenh lenh4" ref={ref}>
        <div className="lenh-head">
          <div className="c">
            <b>{data.company.toUpperCase()}</b><br />
            <span>Số: {data.orderNo}</span>
          </div>
          <div className="c">
            <b>CỘNG HOÀ XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><br />
            <span>Độc Lập - Tự Do - Hạnh Phúc</span><br />---oOo---
          </div>
        </div>
        <p className="r">Ngày <Blank w={30}>{dd}</Blank> Tháng <Blank w={30}>{m}</Blank> Năm <Blank w={40}>{y}</Blank></p>
        <div className="lenh-title">
          <div className="c">
            <h1>LỆNH VẬN CHUYỂN</h1>
            <b>Dùng cho xe ô tô vận chuyển hành khách tuyến cố định</b><br />
            Có giá trị từ ngày <Blank w={110}>{d(data.validFrom)}</Blank> đến ngày <Blank w={110}>{d(data.validTo)}</Blank>
          </div>
          <div className="lenh-qr c"><img src={data.qr} alt="Mã tra cứu lệnh" /><br /><small>Mã tra cứu</small></div>
        </div>

        <table className="lenh-table">
          <tbody>
            <tr>
              <td colSpan={4} className="lenh-info">
                <div>Cấp cho Lái xe 1: <Blank w={220}>{data.driver1?.name}</Blank> hạng GPLX: <Blank w={50}>{data.driver1?.hang ?? ''}</Blank></div>
                <div className="indent">Lái xe 2: <Blank w={220}>{data.driver2?.name}</Blank> hạng GPLX: <Blank w={50}>{data.driver2?.hang ?? ''}</Blank></div>
                <div>Nhân viên phục vụ trên xe: <Blank w={300}>{data.assistant}</Blank></div>
                <div>Biển số đăng ký: <Blank w={160}>{data.plate}</Blank> Số ghế: <Blank w={50}>{data.seats ?? ''}</Blank> Loại xe: khách</div>
                <div><b>Tuyến: {data.routeName}{data.distanceKm ? ` - Cự ly: ${data.distanceKm}km` : ''}</b>{data.registeredCode ? `   Mã số tuyến: ${data.registeredCode}` : ''}</div>
                {data.itinerary && <div>Hành trình chạy xe: {data.itinerary} và Ngược Lại</div>}
              </td>
              <td className="c lenh-sign">
                <i><b>{data.signerTitle}</b><br />(Ký tên và đóng dấu)</i>
                <div className="sign-stack">
                  {data.signerImg && <img src={data.signerImg} alt="" />}
                  {data.sealImg && <img src={data.sealImg} alt="" className="seal" />}
                </div>
                {data.signerShowName && <b><i>{data.signerName}</i></b>}
              </td>
            </tr>
            <tr className="c">
              <th>Lượt xe thực hiện</th><th>Bến xe đi, đến</th><th>Giờ xe chạy</th><th>Số khách</th><th>Bến xe<br /><i>(Ký tên và đóng dấu)</i></th>
            </tr>
            {[0, 1, 2, 3].map((i) => {
              const l = data.legs[i], di = i % 2 === 0;
              return leg(i, di ? 'Lượt đi' : 'Lượt về', di ? data.fromStop : data.toStop, di ? data.toStop : data.fromStop, l?.time ?? null, l?.date ?? null);
            })}
          </tbody>
        </table>
        <table className="lenh-table lenh-foot">
          <tbody>
            <tr className="c">
              <td><b>LÁI XE 1</b><br /><i>(Ký và ghi rõ họ tên)</i><div className="sign-box">{data.driver1Sign && <img src={data.driver1Sign} alt="" />}</div>
                {data.driver1 && data.driver1ShowName && <i>{data.driver1.name}</i>}</td>
              <td><b>LÁI XE 2</b><br /><i>(Ký và ghi rõ họ tên)</i><div className="sign-box">{data.driver2Sign && <img src={data.driver2Sign} alt="" />}</div>
                {data.driver2 && data.driver2ShowName && <i>{data.driver2.name}</i>}</td>
              <td>
                <b>CÁN BỘ ĐIỀU HÀNH</b>
                <div className="sign-box">{data.dispatcherImg && <img src={data.dispatcherImg} alt="" />}</div>
                {data.dispatcherShowName && <i>{data.dispatcherName}</i>}
              </td>
            </tr>
          </tbody>
        </table>
        <p className="small"><b>Lưu ý:</b> Không lái xe quá thời gian quy định, luôn chấp hành luật giao thông, đúng tốc độ cho phép.<br />
          Nộp trả lệnh vận chuyển có đủ xác nhận của bến đi và bến đến.</p>
      </div>
    </div>
  );
}
