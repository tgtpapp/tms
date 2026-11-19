// In hợp đồng vận chuyển hành khách theo hợp đồng (A4) + danh sách hành khách. Mẫu theo app cũ của nhà xe.
// Pháp lý (cần xác minh): nội dung bắt buộc của hợp đồng vận tải theo Nghị định hiện hành về kinh doanh vận tải bằng xe ô tô.
import { useEffect, useRef, useState } from 'react';
import { signatureUrl } from '../lib/documents';
import { supabase } from '../lib/supabase';
import { moneyWords } from '../lib/vnWords';

export interface CharterDoc {
  id: string; contract_no: string; signed_on: string | null; customer_name: string; customer_phone: string | null; customer_tax_code: string | null;
  customer_address: string | null; customer_email: string | null; customer_rep: string | null; pickup_place: string; destination: string;
  itinerary: string | null; start_at: string; end_at: string; passengers: number; price: number; deposit: number; distance_km: number | null;
  payment_terms: string | null; toll_by: string | null; meals_by: string | null; attendant: string | null; round_trip: boolean;
  plate: string; seats: number | null; drivers: string[]; pax: { seq: number; full_name: string; phone: string | null; birth_year: number | null }[];
}
interface Company { name: string; legal_name: string | null; tax_code: string | null; address: string | null; phone: string | null; transport_license_no: string | null;
  director: string; title: string; sign: string | null; seal: string | null }

const TZ = 'Asia/Ho_Chi_Minh';
const vnDate = (iso: string) => new Date(iso).toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const vnTime = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dmy = (d: string) => d.split('-').reverse().join('/');
const money = (n: number) => n.toLocaleString('vi-VN');
const party = (x: string | null) => (x === 'A' ? 'Bên A chịu' : x === 'B' ? 'Bên B chịu' : 'Theo thỏa thuận');

export function CharterPrint({ docs, tenantId, onClose }: { docs: CharterDoc[]; tenantId: string; onClose: () => void }) {
  const [co, setCo] = useState<Company | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void (async () => {
      const [tn, ss] = await Promise.all([
        supabase.from('tenants').select('name, legal_name, tax_code, address, phone, transport_license_no').maybeSingle(),
        supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 'in.chu_ky_giam_doc', 'in.con_dau']),
      ]);
      const raw = (k: string) => ((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
      const [sign, seal] = await Promise.all([
        raw('in.chu_ky_giam_doc') === false ? null : signatureUrl(tenantId, 'giam_doc'),
        raw('in.con_dau') === false ? null : signatureUrl(tenantId, 'con_dau'),
      ]);
      const t = (tn.data ?? { name: '' }) as Omit<Company, 'director' | 'title' | 'sign' | 'seal'>;
      setCo({ ...t, director: String(raw('cong_ty.giam_doc') ?? ''), title: String(raw('cong_ty.chuc_danh_ky') ?? '') || 'Giám đốc', sign, seal });
    })();
  }, [tenantId]);
  useEffect(() => {
    if (!co) return;
    const imgs = Array.from(ref.current?.querySelectorAll('img') ?? []);
    let done = false;
    const go = () => { if (!done) { done = true; window.print(); } };
    void Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : new Promise((r) => { i.onload = r; i.onerror = r; })))).then(() => setTimeout(go, 150));
    const t = setTimeout(go, 4000);
    return () => clearTimeout(t);
  }, [co]);

  return (
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>{docs.length === 1 ? `Hợp đồng ${docs[0].contract_no}` : `${docs.length} hợp đồng`}</b>
        <button className="btn small primary" onClick={() => window.print()}>In / lưu PDF</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div ref={ref} className="print-stack">
        {!co && <p className="no-print">Đang chuẩn bị bản in…</p>}
        {co && docs.map((c) => (
          <div key={c.id} className="lenh hdvc">
            <div className="lenh-head">
              <div className="c"><b>{(co.legal_name || co.name).toUpperCase()}</b><div>Số: {c.contract_no}</div></div>
              <div className="c"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><div><b><u>Độc lập - Tự do - Hạnh phúc</u></b></div></div>
            </div>
            <h1 className="c">HỢP ĐỒNG VẬN CHUYỂN HÀNH KHÁCH</h1>
            <p className="c"><i>(Vận tải hành khách theo hợp đồng)</i></p>
            <p><i>Căn cứ Bộ luật Dân sự; Luật Giao thông đường bộ / Luật Trật tự, an toàn giao thông đường bộ và các văn bản hướng dẫn về kinh doanh vận tải bằng xe ô tô hiện hành (cần xác minh văn bản áp dụng);
              căn cứ nhu cầu và khả năng của hai bên.</i></p>
            <p>Hôm nay, ngày {c.signed_on ? dmy(c.signed_on) : '....../....../........'}, chúng tôi gồm:</p>
            <p><b>BÊN A (Bên vận chuyển): {(co.legal_name || co.name).toUpperCase()}</b><br />
              Địa chỉ: {co.address ?? ''}<br />
              Điện thoại: {co.phone ?? ''}{co.tax_code ? ` · Mã số thuế: ${co.tax_code}` : ''}<br />
              {co.transport_license_no && <>Giấy phép kinh doanh vận tải số: {co.transport_license_no}<br /></>}
              Đại diện: {co.director} · Chức vụ: {co.title}</p>
            <p><b>BÊN B (Bên thuê vận tải): {c.customer_name.toUpperCase()}</b><br />
              Địa chỉ: {c.customer_address ?? ''}<br />
              Điện thoại: {c.customer_phone ?? ''}{c.customer_email ? ` · Email: ${c.customer_email}` : ''}{c.customer_tax_code ? ` · Mã số thuế / CCCD: ${c.customer_tax_code}` : ''}<br />
              {c.customer_rep && <>Đại diện: {c.customer_rep}<br /></>}</p>
            <p>Hai bên thỏa thuận ký hợp đồng vận chuyển hành khách với các điều khoản sau:</p>
            <p><b>Điều 1. Nội dung dịch vụ</b><br />
              - Xe sử dụng: biển số <b>{c.plate || '..........'}</b>{c.seats ? `, ${c.seats} chỗ` : ''}. Lái xe: {c.drivers.join(', ') || '..........'}{c.attendant ? `. Nhân viên phục vụ: ${c.attendant}` : ''}.<br />
              - Hành trình: <b>{c.pickup_place} đi {c.destination}{c.round_trip ? ' và ngược lại' : ''}</b>{c.itinerary ? ` (lộ trình: ${c.itinerary})` : ''}{c.distance_km ? `. Cự ly dự kiến ${money(c.distance_km)} km` : ''}.<br />
              - Đón khách: {vnTime(c.start_at)} ngày {vnDate(c.start_at)} tại {c.pickup_place}. Trả khách (dự kiến): {vnTime(c.end_at)} ngày {vnDate(c.end_at)}.<br />
              - Số hành khách: {c.passengers} người (danh sách kèm theo hợp đồng).</p>
            <p><b>Điều 2. Giá trị hợp đồng và thanh toán</b><br />
              - Tổng giá trị hợp đồng: <b>{money(c.price)} đồng</b> (Bằng chữ: <i>{moneyWords(c.price)}</i>).<br />
              {c.deposit > 0 && <>- Đặt cọc: {money(c.deposit)} đồng; phần còn lại thanh toán khi kết thúc chuyến đi.<br /></>}
              - Hình thức thanh toán: {c.payment_terms || 'Chuyển khoản qua ngân hàng hoặc tiền mặt'}.<br />
              - Chi phí cầu đường, bến bãi, phà: {party(c.toll_by)}. Chi phí ăn nghỉ của lái xe: {party(c.meals_by)}.</p>
            <p><b>Điều 3. Trách nhiệm của Bên A</b><br />
              - Bố trí xe đúng loại, đủ điều kiện kỹ thuật và giấy tờ theo quy định; lái xe có giấy phép lái xe phù hợp; đón trả khách đúng thời gian, địa điểm.<br />
              - Mua bảo hiểm trách nhiệm dân sự của chủ xe đối với hành khách; mang theo hợp đồng và danh sách hành khách trên xe.</p>
            <p><b>Điều 4. Trách nhiệm của Bên B</b><br />
              - Cung cấp danh sách hành khách trước giờ khởi hành; thanh toán đúng, đủ theo Điều 2.<br />
              - Hướng dẫn hành khách chấp hành quy định về an toàn giao thông; không mang hàng cấm, hàng dễ cháy nổ lên xe.</p>
            <p><b>Điều 5. Điều khoản chung</b><br />
              Hai bên cam kết thực hiện đúng hợp đồng; tranh chấp được giải quyết bằng thương lượng, không thương lượng được thì đưa ra Tòa án có thẩm quyền.
              Hợp đồng lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.</p>
            <table className="lenh-foot" style={{ width: '100%' }}><tbody><tr>
              <td><b>ĐẠI DIỆN BÊN B</b><div className="sign-box" /><b>{c.customer_rep || c.customer_name}</b></td>
              <td><b>ĐẠI DIỆN BÊN A</b><div className="sign-box sign-stack">{co.seal && <img src={co.seal} alt="" />}{co.sign && <img src={co.sign} alt="" />}</div><b>{co.director}</b></td>
            </tr></tbody></table>
            <div className="hdvc-pax">
              <h3 className="c">DANH SÁCH HÀNH KHÁCH</h3>
              <p className="c">Kèm theo hợp đồng số {c.contract_no} · Xe {c.plate} · {c.pickup_place} – {c.destination} · ngày {vnDate(c.start_at)}</p>
              <table className="lenh-table">
                <thead><tr><th>STT</th><th>Họ và tên</th><th>Năm sinh</th><th>Điện thoại</th><th>Ghi chú</th></tr></thead>
                <tbody>
                  {c.pax.map((p, i) => <tr key={i}><td className="c">{i + 1}</td><td>{p.full_name}</td><td className="c">{p.birth_year ?? ''}</td><td>{p.phone ?? ''}</td><td /></tr>)}
                  {Array.from({ length: Math.max(0, Math.min(c.passengers, 45) - c.pax.length) }, (_, i) => <tr key={`b${i}`}><td className="c">{c.pax.length + i + 1}</td><td /><td /><td /><td /></tr>)}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
