// In bộ hồ sơ vận tải hành khách theo hợp đồng (A4), mỗi hợp đồng 3 trang:
//   1. Hợp đồng vận chuyển hành khách   2. Phụ lục 01 – Danh sách hành khách   3. Lệnh vận chuyển (xe hợp đồng)
// Theo mẫu nhà xe gửi; chỗ app chưa lưu dữ liệu để dòng chấm ghi tay. Số lệnh: <số hợp đồng>/<năm>/LVC-<hậu tố>.
import { useEffect, useRef, useState } from 'react';
import { signatureUrl } from '../lib/documents';
import { loadSigns, showName, type Sign } from '../lib/signatures';
import { supabase } from '../lib/supabase';
import { moneyWords } from '../lib/vnWords';

export interface CharterDoc {
  id: string; contract_no: string; signed_on: string | null; customer_name: string; customer_phone: string | null; customer_tax_code: string | null;
  customer_address: string | null; customer_email: string | null; customer_rep: string | null; pickup_place: string; destination: string;
  itinerary: string | null; start_at: string; end_at: string; passengers: number; price: number; deposit: number; distance_km: number | null;
  payment_terms: string | null; toll_by: string | null; meals_by: string | null; attendant: string | null; round_trip: boolean;
  plate: string; seats: number | null; drivers: string[]; pax: { seq: number; full_name: string; phone: string | null; birth_year: number | null }[];
  vehicle_id?: string | null; driver1_id?: string | null; driver2_id?: string | null;
}
interface Company { name: string; legal_name: string | null; tax_code: string | null; address: string | null; phone: string | null; transport_license_no: string | null;
  transport_license_date: string | null; transport_license_issuer: string | null;
  email: string; director: string; title: string; sign: string | null; seal: string | null; signName: boolean }
/** Giấy tờ phục vụ Lệnh vận chuyển: phù hiệu xe, GPLX lái xe, chữ ký lái xe */
interface Extra { badge: Map<string, { no: string | null; exp: string | null }>; gplx: Map<string, { no: string | null; hang: string | null }>; signs: Map<string, Sign> }

const TZ = 'Asia/Ho_Chi_Minh';
const vnDate = (iso: string) => new Date(iso).toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const vnTime = (iso: string) => new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const hm = (iso: string) => { const [h, m] = vnTime(iso).split(':'); return `${h} giờ ${m} phút`; };
const dmy = (d: string) => d.split('-').reverse().join('/');
const money = (n: number) => n.toLocaleString('vi-VN');
const party = (x: string | null) => (x === 'A' ? 'Bên A chịu' : x === 'B' ? 'Bên B chịu' : 'theo thỏa thuận');
const dots = (n = 20) => '.'.repeat(n);
/** Ô ghi tay rộng hết phần còn lại của dòng (có dữ liệu thì in đậm) */
const W = ({ v }: { v?: string | number | null }) => (v != null && String(v).trim() ? <b>{v}</b> : <i className="hd-blank" />);
const V = ({ v, n = 20 }: { v?: string | number | null; n?: number }) => (v != null && String(v).trim() ? <b>{v}</b> : <>{dots(n)}</>);
/** Số lệnh vận chuyển theo số hợp đồng: 0001/HĐVC-TGTP → 0001/<năm>/LVC-TGTP */
const orderNo = (c: CharterDoc) => {
  const n = /^(\d+)/.exec(c.contract_no)?.[1] ?? dots(6);
  const suf = /HĐVC(-.+)$/.exec(c.contract_no)?.[1] ?? '';
  return `${n}/${new Date(c.start_at).toLocaleDateString('sv-SE', { timeZone: TZ }).slice(0, 4)}/LVC${suf}`;
};

export function CharterPrint({ docs, tenantId, onClose }: { docs: CharterDoc[]; tenantId: string; onClose: () => void }) {
  const [co, setCo] = useState<Company | null>(null);
  const [ex, setEx] = useState<Extra | null>(null);
  // Chèn chữ ký + con dấu vào bản in: mặc định để trống (ký, đóng dấu tay); tích chọn mới chèn
  const [stamp, setStamp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void (async () => {
      const vids = [...new Set(docs.map((c) => c.vehicle_id).filter((x): x is string => !!x))];
      const sids = [...new Set(docs.flatMap((c) => [c.driver1_id, c.driver2_id]).filter((x): x is string => !!x))];
      const [tn, ss, ph, gp, um] = await Promise.all([
        supabase.from('tenants').select('name, legal_name, tax_code, address, phone, transport_license_no, transport_license_date, transport_license_issuer').maybeSingle(),
        supabase.from('tenant_settings').select('key, value').in('key', ['cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 'in.chu_ky_giam_doc', 'in.con_dau', 'cong_ty.email']),
        vids.length ? supabase.from('documents').select('vehicle_id, doc_no, expires_on').in('vehicle_id', vids).eq('doc_type', 'phu_hieu').eq('is_current', true) : Promise.resolve({ data: [] }),
        sids.length ? supabase.from('documents').select('staff_id, doc_no, data').in('staff_id', sids).eq('doc_type', 'gplx').eq('is_current', true) : Promise.resolve({ data: [] }),
        sids.length ? supabase.from('staff_members').select('id, user_id').in('id', sids) : Promise.resolve({ data: [] }),
      ]);
      const raw = (k: string) => ((ss.data ?? []) as { key: string; value: unknown }[]).find((x) => x.key === k)?.value;
      const users = new Map(((um.data ?? []) as { id: string; user_id: string | null }[]).map((x) => [x.id, x.user_id]));
      const [sg, seal, ds] = await Promise.all([
        loadSigns(tenantId, ['giam_doc']),
        raw('in.con_dau') === false ? null : signatureUrl(tenantId, 'con_dau'),
        loadSigns(tenantId, sids.flatMap((id) => [`nv_${id}`, users.get(id) ?? null])),
      ]);
      const gd = raw('in.chu_ky_giam_doc') === false ? null : sg.get('giam_doc') ?? null;
      const t = (tn.data ?? { name: '' }) as Pick<Company, 'name' | 'legal_name' | 'tax_code' | 'address' | 'phone' | 'transport_license_no' | 'transport_license_date' | 'transport_license_issuer'>;
      // chữ ký lái xe: trong hồ sơ nhân viên trước, chưa có thì chữ ký tài khoản (quy tắc chung)
      const signs = new Map<string, Sign>();
      for (const id of sids) { const x = ds.get(`nv_${id}`)?.img ? ds.get(`nv_${id}`) : ds.get(users.get(id) ?? ''); if (x?.img) signs.set(id, x); }
      setEx({
        badge: new Map(((ph.data ?? []) as { vehicle_id: string; doc_no: string | null; expires_on: string | null }[]).map((x) => [x.vehicle_id, { no: x.doc_no, exp: x.expires_on }])),
        gplx: new Map(((gp.data ?? []) as { staff_id: string; doc_no: string | null; data: Record<string, unknown> | null }[]).map((x) => [x.staff_id, { no: x.doc_no, hang: x.data?.hang ? String(x.data.hang) : null }])),
        signs,
      });
      setCo({ ...t, email: String(raw('cong_ty.email') ?? ''), director: String(raw('cong_ty.giam_doc') ?? ''), title: String(raw('cong_ty.chuc_danh_ky') ?? '') || 'Giám đốc',
        sign: gd?.img ?? null, seal, signName: showName(gd) });
    })();
  }, [tenantId, docs]);

  const signA = (c: Company) => <div className="sign-box sign-stack">{stamp && c.seal && <img src={c.seal} alt="" />}{stamp && c.sign && <img src={c.sign} alt="" />}</div>;
  const nameA = (c: Company) => (!stamp || c.signName ? <b>{c.director}</b> : null);
  const quocHieu = <div className="c"><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b><div><b><u>Độc lập - Tự do - Hạnh phúc</u></b></div></div>;

  return (
    <div className="lenh-overlay">
      <div className="lenh-bar no-print">
        <b>{docs.length === 1 ? `Hợp đồng ${docs[0].contract_no}` : `${docs.length} hợp đồng`}</b>
        <label className="check"><input type="checkbox" checked={stamp} onChange={(e) => setStamp(e.target.checked)} /> Chèn chữ ký, con dấu</label>
        <button className="btn small primary" disabled={!co || !ex} onClick={() => window.print()}>In / lưu PDF</button>
        <button className="btn small" onClick={onClose}>Đóng</button>
      </div>
      <div ref={ref} className="print-stack">
        {(!co || !ex) && <p className="no-print">Đang chuẩn bị bản in…</p>}
        {co && ex && docs.map((c) => {
          const coName = (co.legal_name || co.name).toUpperCase();
          const d1 = c.driver1_id ?? null, d2 = c.driver2_id ?? null;
          const bd = c.vehicle_id ? ex.badge.get(c.vehicle_id) : undefined;
          const g = (id: string | null) => (id ? ex.gplx.get(id) : undefined);
          const rest = Math.max(0, c.price - c.deposit);
          // Danh sách: sẵn tối thiểu 15 dòng (hoặc đủ số khách), chiều cao dòng co giãn cho bảng vừa 1 trang
          const rows = Math.max(15, c.pax.length);
          const blank = rows - c.pax.length;
          const rh = `${Math.max(5, Math.min(11, 150 / rows)).toFixed(1)}mm`;
          return [
            /* ---------------- Trang 1: Hợp đồng ---------------- */
            <div key={`${c.id}-hd`} className="lenh hdvc hdvc1">
              <div className="lenh-head">
                <div className="c"><b>{coName}</b><div>Số: {c.contract_no}</div></div>
                {quocHieu}
              </div>
              <h1 className="c">HỢP ĐỒNG VẬN CHUYỂN HÀNH KHÁCH</h1>
              <p className="c"><i>(Vận tải hành khách theo hợp đồng)</i></p>
              <p><i>Căn cứ Bộ luật Dân sự số 91/2015/QH13 ngày 24/11/2015; Luật Đường bộ số 35/2024/QH15 ngày 27/6/2024; Luật Trật tự, an toàn giao thông đường bộ số 36/2024/QH15 ngày 27/6/2024;
                Nghị định số 10/2020/NĐ-CP ngày 17/01/2020 của Chính phủ quy định về kinh doanh và điều kiện kinh doanh vận tải bằng xe ô tô; Nghị định số 47/2022/NĐ-CP ngày 25/7/2022;
                Nghị định số 41/2024/NĐ-CP ngày 16/4/2024; Nghị định số 158/2024/NĐ-CP ngày 18/12/2024 và các văn bản hướng dẫn thi hành hiện hành; nhu cầu và khả năng thực tế của hai bên.</i></p>
              <p>Hôm nay, ngày {c.signed_on ? dmy(c.signed_on) : '....../....../........'}, chúng tôi gồm:</p>
              <p><b>BÊN VẬN CHUYỂN (Bên A): {coName}</b><br />
                Mã số thuế / Số ĐKKD: <V v={co.tax_code} /> · Địa chỉ trụ sở: <V v={co.address} n={40} /><br />
                Người đại diện theo pháp luật: <V v={co.director} /> · Chức vụ: <V v={co.title} /><br />
                Điện thoại: <V v={co.phone} /> · Email: <V v={co.email} /> · Tài khoản ngân hàng: {dots(22)} tại Ngân hàng {dots(16)}<br />
                Giấy phép kinh doanh vận tải bằng xe ô tô số: <V v={co.transport_license_no} /> do <V v={co.transport_license_issuer} n={18} /> cấp ngày <V v={co.transport_license_date ? dmy(co.transport_license_date) : null} n={12} /> (loại hình: kinh doanh vận tải hành khách theo hợp đồng).</p>
              {/* Bên B: mỗi thông tin 1 dòng, chỗ trống kẻ chấm rộng để ghi tay */}
              <div className="hd-fill"><b>BÊN THUÊ VẬN CHUYỂN (Bên B): {c.customer_name.toUpperCase()}</b>
                <span>Mã số thuế / Số CCCD: <W v={c.customer_tax_code} /></span><span>Điện thoại: <W v={c.customer_phone} /></span>
                <span className="w2">Địa chỉ: <W v={c.customer_address} /></span>
                <span>Người đại diện / Trưởng đoàn: <W v={c.customer_rep} /></span><span>Chức vụ: <W /></span>
                <span>Email: <W v={c.customer_email} /></span><span>Tài khoản ngân hàng (nếu có): <W /></span></div>
              <p>Hai bên thống nhất ký kết hợp đồng vận chuyển hành khách với các điều khoản sau:</p>
              <p><b>Điều 1. Nội dung, lịch trình và phương tiện</b><br />
                1. Bên A vận chuyển hành khách cho Bên B theo hình thức vận tải hành khách theo hợp đồng: ☐ theo chuyến ☐ đưa đón cán bộ công nhân viên, học sinh ☐ phục vụ du lịch, sự kiện.<br />
                2. Hành trình: điểm đi <b>{c.pickup_place}</b> – điểm đến <b>{c.destination}</b>{c.round_trip ? ' và ngược lại' : ''}; lộ trình, điểm dừng đón trả: <V v={c.itinerary} n={30} />{c.distance_km ? `; cự ly dự kiến ${money(c.distance_km)} km` : ''}.
                Thời gian: từ {vnTime(c.start_at)} ngày {vnDate(c.start_at)} đến {vnTime(c.end_at)} ngày {vnDate(c.end_at)}. Số hành khách: <b>{c.passengers}</b> người (Danh sách hành khách kèm theo).<br />
                3. Xe: biển kiểm soát <V v={c.plate} />{c.seats ? `, ${c.seats} chỗ` : ''}; lái xe: <V v={c.drivers.join(', ')} />{c.attendant ? `; nhân viên phục vụ: ${c.attendant}` : ''}.
                Thay đổi xe do sự cố hoặc điều động, Bên A báo trước cho Bên B và bố trí xe tương đương đủ điều kiện. Xe có kiểm định còn hiệu lực, phù hiệu <b>"XE HỢP ĐỒNG"</b>,
                thiết bị giám sát hành trình, camera theo quy định và bảo hiểm trách nhiệm dân sự bắt buộc còn hiệu lực.</p>
              <p><b>Điều 2. Giá cước và thanh toán</b><br />
                1. Giá trị hợp đồng: <b>{money(c.price)} đồng</b> (Bằng chữ: <i>{moneyWords(c.price)}</i>); thuế GTGT: {dots(14)}. Chi phí cầu đường, bến bãi: {party(c.toll_by)}; ăn nghỉ lái xe: {party(c.meals_by)}.<br />
                2. Phát sinh ngoài lộ trình / quá thời gian chờ: phụ thu {dots(12)} đồng/giờ hoặc {dots(12)} đồng/km.<br />
                3. {c.deposit > 0 ? <>Đặt cọc <b>{money(c.deposit)} đồng</b> ngay sau khi ký; còn lại <b>{money(rest)} đồng</b></> : <>Thanh toán</>} trong {dots(6)} ngày làm việc kể từ khi kết thúc hành trình,
                kèm biên bản xác nhận và hóa đơn hợp lệ. Hình thức: {c.payment_terms || 'chuyển khoản vào tài khoản Bên A hoặc tiền mặt'}.</p>
              <p><b>Điều 3. Quyền và nghĩa vụ của Bên A</b><br />
                - Yêu cầu Bên B cung cấp danh sách hành khách trước giờ khởi hành; nhận thanh toán đúng hạn; từ chối vận chuyển người không có tên trong danh sách, người mang vũ khí, chất cháy nổ, hàng cấm hoặc gây rối trật tự.<br />
                - Bố trí xe đúng loại, đến điểm đón đúng giờ; lái xe có giấy phép lái xe phù hợp, tuân thủ thời gian lái xe liên tục và thời gian làm việc trong ngày; thực hiện đúng hành trình, đón trả đúng địa điểm;
                <b> không bán vé, không thu tiền trực tiếp của từng hành khách</b>; lưu trữ hợp đồng, danh sách hành khách, lệnh vận chuyển và cung cấp thông tin cho cơ quan chức năng theo quy định;
                bồi thường thiệt hại về tính mạng, sức khỏe, hành lý của hành khách do lỗi của Bên A theo pháp luật dân sự và bảo hiểm.</p>
              <p><b>Điều 4. Quyền và nghĩa vụ của Bên B</b><br />
                - Yêu cầu Bên A vận chuyển đúng loại xe, thời gian, lộ trình, bảo đảm an toàn; yêu cầu đổi xe hoặc lái xe nếu xe không bảo đảm an toàn kỹ thuật hoặc lái xe vi phạm quy định về nồng độ cồn, chất kích thích.<br />
                - Cung cấp danh sách hành khách chính xác trước khi xe xuất bến và báo ngay khi thay đổi; tập trung hành khách đúng giờ, đúng địa điểm; cử trưởng đoàn phối hợp kiểm soát hành khách;
                nhắc hành khách không mang hàng cấm, chất dễ cháy nổ; bồi thường nếu hành khách cố ý làm hư hỏng trang thiết bị trên xe; thanh toán đầy đủ theo Điều 2.</p>
              <p><b>Điều 5. Hủy chuyến, phạt vi phạm, bất khả kháng</b><br />
                - Bên B hủy trước giờ khởi hành từ {dots(4)} giờ trở lên: hoàn {dots(4)}% tiền cọc; từ {dots(4)} đến {dots(4)} giờ: phạt {dots(4)}% giá trị hợp đồng; dưới {dots(4)} giờ hoặc xe đã đến điểm đón: thanh toán {dots(4)}% giá trị hợp đồng.
                Bên A tự ý hủy hoặc không bố trí xe đúng cam kết: hoàn toàn bộ tiền cọc và chịu phạt {dots(4)}% giá trị hợp đồng.<br />
                - Thiên tai, dịch bệnh, tai nạn gây tắc đường kéo dài, lệnh cấm đường của cơ quan có thẩm quyền: hai bên điều chỉnh lịch trình hoặc quyết toán theo quãng đường thực tế, không bên nào bị phạt.</p>
              <p><b>Điều 6. Giải quyết tranh chấp, sửa đổi hợp đồng</b><br />
                Tranh chấp giải quyết bằng thương lượng, hòa giải; không thỏa thuận được thì đưa ra Tòa án nhân dân có thẩm quyền. Thay đổi lộ trình, thời gian, số xe phải lập thành văn bản hoặc xác nhận qua email / tin nhắn của đại diện hai bên.</p>
              <p><b>Điều 7. Hiệu lực hợp đồng</b><br />
                Hợp đồng có hiệu lực từ khi ký đến khi hoàn thành chuyến đi và thanh lý. Danh sách hành khách và Lệnh vận chuyển là bộ phận không tách rời của hợp đồng. Hợp đồng lập thành 02 bản có giá trị như nhau, mỗi bên giữ 01 bản.</p>
              <table className="lenh-foot" style={{ width: '100%' }}><tbody><tr>
                <td><b>ĐẠI DIỆN BÊN A</b><div><i>(Ký, ghi rõ họ tên, đóng dấu)</i></div>{signA(co)}{nameA(co)}</td>
                <td><b>ĐẠI DIỆN BÊN B</b><div><i>(Ký, ghi rõ họ tên, đóng dấu nếu có)</i></div><div className="sign-box" /><b>{c.customer_rep || c.customer_name}</b></td>
              </tr></tbody></table>
            </div>,

            /* ---------------- Trang 2: Danh sách hành khách ---------------- */
            <div key={`${c.id}-ds`} className="lenh hdvc">
              <h2 className="c">PHỤ LỤC 01: DANH SÁCH HÀNH KHÁCH</h2>
              <p className="c"><i>(Kèm theo Hợp đồng vận chuyển hành khách số {c.contract_no} ngày {c.signed_on ? dmy(c.signed_on) : dots(10)})</i></p>
              <p>Đơn vị vận tải (Bên A): <b>{coName}</b><br />
                Đơn vị thuê xe (Bên B): <b>{c.customer_name}</b><br />
                Biển kiểm soát xe: <V v={c.plate} /> · Họ tên lái xe: <V v={c.drivers.join(', ')} /><br />
                Hành trình: từ <b>{c.pickup_place}</b> đến <b>{c.destination}</b><br />
                Thời gian khởi hành: {hm(c.start_at)}, ngày {vnDate(c.start_at)}</p>
              <table className="lenh-table hdvc-ds" style={{ ['--rh' as string]: rh }}>
                <thead><tr><th>STT</th><th>Họ và tên hành khách</th><th>Năm sinh</th><th>Số CCCD / Hộ chiếu (nếu có)</th><th>Điểm đón</th><th>Điểm trả</th><th>Ghi chú</th></tr></thead>
                <tbody>
                  {c.pax.map((p, i) => <tr key={i}><td className="c">{i + 1}</td><td>{p.full_name}</td><td className="c">{p.birth_year ?? ''}</td><td /><td /><td /><td /></tr>)}
                  {Array.from({ length: blank }, (_, i) => <tr key={`b${i}`}><td className="c">{c.pax.length + i + 1}</td><td /><td /><td /><td /><td /><td /></tr>)}
                </tbody>
              </table>
              <p>Tổng cộng: <b>{c.pax.length || c.passengers}</b> hành khách.</p>
              <table className="lenh-foot" style={{ width: '100%' }}><tbody><tr>
                <td><b>ĐẠI DIỆN BÊN A</b><div><i>(Ký, ghi rõ họ tên, đóng dấu)</i></div>{signA(co)}{nameA(co)}</td>
                <td><b>ĐẠI DIỆN BÊN B / TRƯỞNG ĐOÀN</b><div><i>(Ký, ghi rõ họ tên)</i></div><div className="sign-box" /><b>{c.customer_rep || ''}</b></td>
              </tr></tbody></table>
            </div>,

            /* ---------------- Trang 3: Lệnh vận chuyển ---------------- */
            <div key={`${c.id}-lvc`} className="lenh hdvc">
              {quocHieu}
              <p style={{ marginTop: 10 }}><b>TÊN ĐƠN VỊ VẬN TẢI: {coName}</b><br />
                Địa chỉ: <V v={co.address} n={40} /> · Số điện thoại: <V v={co.phone} /><br />
                Giấy phép KDVT số: <V v={co.transport_license_no} /> do <V v={co.transport_license_issuer} n={18} /> cấp ngày <V v={co.transport_license_date ? dmy(co.transport_license_date) : null} n={12} /></p>
              <h1 className="c">LỆNH VẬN CHUYỂN</h1>
              <p className="c">Số: <b>{orderNo(c)}</b><br /><i>(Kèm theo Hợp đồng vận chuyển hành khách số {c.contract_no} ngày {c.signed_on ? dmy(c.signed_on) : dots(10)})</i></p>
              <p><b>I. THÔNG TIN PHƯƠNG TIỆN VÀ NGƯỜI LÁI XE</b><br />
                - Biển kiểm soát xe: <V v={c.plate} /> · Số chỗ ngồi: <V v={c.seats} n={6} /> chỗ<br />
                - Số phù hiệu "XE HỢP ĐỒNG": <V v={bd?.no} /> · Có giá trị đến ngày: <V v={bd?.exp ? dmy(bd.exp) : null} n={12} /><br />
                - Họ và tên lái xe 1: <V v={c.drivers[0]} /> · Số GPLX: <V v={g(d1)?.no} /> · Hạng: <V v={g(d1)?.hang} n={6} /><br />
                - Họ và tên lái xe 2 (nếu có): <V v={d2 ? c.drivers[1] : null} /> · Số GPLX: <V v={g(d2)?.no} /> · Hạng: <V v={g(d2)?.hang} n={6} /><br />
                - Nhân viên phục vụ trên xe (nếu có): <V v={c.attendant} /></p>
              <p><b>II. THÔNG TIN CHUYẾN ĐI / HÀNH TRÌNH VẬN CHUYỂN</b><br />
                - Đơn vị / cá nhân thuê vận chuyển (Bên B): <b>{c.customer_name}</b><br />
                - Điểm xuất phát (điểm đón khách): <b>{c.pickup_place}</b><br />
                - Điểm đến (điểm trả khách): <b>{c.destination}</b><br />
                - Lộ trình tuyến đường chính: <V v={c.itinerary} n={40} /><br />
                - Giờ, ngày xuất bến / khởi hành: {hm(c.start_at)}, ngày {vnDate(c.start_at)}<br />
                - Giờ, ngày kết thúc hành trình (dự kiến): {hm(c.end_at)}, ngày {vnDate(c.end_at)}<br />
                - Tổng số hành khách theo danh sách đính kèm: <b>{c.pax.length || c.passengers}</b> hành khách.</p>
              <p><b>III. KIỂM TRA ĐIỀU KIỆN AN TOÀN TRƯỚC KHI XE KHỞI HÀNH</b><br />
                <i>(Bộ phận quản lý an toàn giao thông / người điều hành vận tải kiểm tra và xác nhận)</i><br />
                1. Tình trạng an toàn kỹ thuật phương tiện (phanh, lái, lốp, đèn, còi, bình chữa cháy, búa thoát hiểm): ☐ Đạt ☐ Không đạt<br />
                2. Giấy tờ xe, bảo hiểm TNDS bắt buộc, giấy phép lái xe của lái xe: ☐ Đầy đủ, còn hiệu lực ☐ Không đạt<br />
                3. Thiết bị giám sát hành trình và camera trên xe: ☐ Hoạt động bình thường ☐ Không đạt<br />
                4. Tình trạng sức khỏe, nồng độ cồn của lái xe: ☐ Đủ điều kiện lái xe ☐ Không đạt</p>
              <p><b>IV. XÁC NHẬN THỰC HIỆN CHUYẾN ĐI</b></p>
              <table className="lenh-foot" style={{ width: '100%' }}><tbody><tr>
                <td><b>NGƯỜI CẤP LỆNH / ĐIỀU HÀNH VẬN TẢI</b><div><i>(Ký, ghi rõ họ tên, đóng dấu)</i></div><div><i>Ngày ..... tháng ..... năm .........</i></div>{signA(co)}{nameA(co)}</td>
                <td><b>XÁC NHẬN CỦA LÁI XE</b><div><i>(Ký, ghi rõ họ tên)</i></div><div><i>Nhận lệnh lúc .....h..... ngày ...../...../.........</i></div>
                  <div className="sign-box">{stamp && d1 && ex.signs.get(d1)?.img && <img src={ex.signs.get(d1)!.img!} alt="" />}</div>{(!stamp || !d1 || showName(ex.signs.get(d1) ?? null)) && <b>{c.drivers[0] ?? ''}</b>}</td>
                <td><b>XÁC NHẬN CỦA ĐẠI DIỆN BÊN THUÊ XE / TRƯỞNG ĐOÀN</b><div><i>(Ký xác nhận khi kết thúc hành trình)</i></div><div><i>Kết thúc lúc .....h..... ngày ...../...../.........</i></div><div><i>Số khách thực tế: ........ người</i></div><div className="sign-box" /><b>{c.customer_rep || ''}</b></td>
              </tr></tbody></table>
              <p><b>V. GHI CHÚ PHÁT SINH TRÊN HÀNH TRÌNH (nếu có)</b><br />
                - Thay đổi lái xe / phương tiện dọc đường (lý do, thời gian, biển số xe thay thế): {dots(60)}<br />
                - Sự cố giao thông / kiểm tra của lực lượng chức năng / phát sinh khác: {dots(66)}</p>
            </div>,
          ];
        })}
      </div>
    </div>
  );
}
