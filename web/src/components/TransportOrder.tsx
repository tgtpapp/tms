// Lệnh vận chuyển – in giấy A4 theo mẫu của nhà xe (không có tùy chọn in: bấm là in).
import { useEffect, useRef, type ReactNode } from 'react';

export interface OrderPrintData {
  orderNo: string;
  issueDate: string;            // YYYY-MM-DD
  validFrom: string;
  validTo: string;
  company: string;
  signerTitle: string;
  signerName: string;
  signerImg: string | null;
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
  departTime: string;           // HH:MM
  departDate: string;           // YYYY-MM-DD
  ret: { time: string; date: string } | null;   // chuyến lượt về của cùng xe (nếu có)
  dispatcherName: string | null;
  dispatcherImg: string | null;
  qr: string;                   // ảnh QR (data URL)
}

const d = (s: string) => s.split('-').reverse().join('/');
const Blank = ({ w = 90, children }: { w?: number; children?: ReactNode }) => (
  <span className="lenh-blank" style={{ minWidth: w }}>{children}</span>
);

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
      window.print();
    };
    Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; }))))
      .then(() => setTimeout(go, 100));
    const t = setTimeout(go, 4000);
    return () => clearTimeout(t);
  }, []);

  const leg = (title: string, from: string, to: string, time: string | null, date: string | null) => (
    <>
      <tr>
        <td rowSpan={2} className="c"><b>{title}</b></td>
        <td className="c">Bến xe đi:<br /><b>{from.toUpperCase()}</b></td>
        <td className="c"><b>Xuất bến:</b><br /><Blank w={40}>{time}</Blank> giờ ngày <Blank>{date ? d(date) : ''}</Blank></td>
        <td />
        <td />
      </tr>
      <tr>
        <td className="c">Bến xe đến:<br /><b>{to.toUpperCase()}</b></td>
        <td className="c"><b>đến bến:</b><br /><Blank w={40} /> giờ ngày <Blank /></td>
        <td />
        <td />
      </tr>
    </>
  );

  return (
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>Lệnh {data.orderNo}</b>
        <button className="btn small primary" onClick={() => window.print()}>In lại</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div className="lenh" ref={ref}>
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
                {data.itinerary && <div>Hành trình chạy xe: {data.itinerary}</div>}
              </td>
              <td className="c lenh-sign">
                <i><b>{data.signerTitle}</b><br />(Ký tên và đóng dấu)</i>
                <div className="sign-box">{data.signerImg && <img src={data.signerImg} alt="" />}</div>
                <b><i>{data.signerName}</i></b>
              </td>
            </tr>
            <tr className="c">
              <th>Lượt xe thực hiện</th><th>Bến xe đi, đến</th><th>Giờ xe chạy</th><th>Số khách</th><th>Bến xe<br /><i>(Ký tên và đóng dấu)</i></th>
            </tr>
            {leg('Lượt đi', data.fromStop, data.toStop, data.departTime, data.departDate)}
            {leg('Lượt về', data.toStop, data.fromStop, data.ret?.time ?? null, data.ret?.date ?? null)}
          </tbody>
        </table>
        <table className="lenh-table lenh-foot">
          <tbody>
            <tr className="c">
              <td><b>LÁI XE 1</b><br /><i>(Ký và ghi rõ họ tên)</i><div className="sign-box" /></td>
              <td><b>LÁI XE 2</b><br /><i>(Ký và ghi rõ họ tên)</i><div className="sign-box" /></td>
              <td>
                <b>CÁN BỘ ĐIỀU HÀNH</b>
                <div className="sign-box">{data.dispatcherImg && <img src={data.dispatcherImg} alt="" />}</div>
                <i>{data.dispatcherName}</i>
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
