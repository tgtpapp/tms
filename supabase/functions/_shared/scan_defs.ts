// Danh mục ô cho AI ở Scan tài liệu: dò 4 góc tờ giấy, đọc nội dung (nhận dạng chữ, nhận ra Lệnh vận chuyển / Hợp đồng).
import type { ReadDef } from './doc_reader.ts';

// Scan tài liệu (như app cũ): AI dò 4 góc tờ giấy trong ảnh chụp
const t = (key: string, label: string, kind: 'text' | 'date' | 'int' = 'text') => ({ key, label, kind });
export const SCAN_QUAD: ReadDef = {
  code: 'scan_khung', owner: 'cong_ty', name: 'ảnh chụp một tờ giấy / tài liệu đặt trên mặt bàn hoặc nền khác', hasExpiry: false, required: false,
  fields: (['tl', 'tr', 'br', 'bl'] as const).flatMap((k) => {
    const n = { tl: 'trên trái', tr: 'trên phải', br: 'dưới phải', bl: 'dưới trái' }[k];
    return [t(`${k}_x`, `Góc ${n}: x (0 = mép trái ảnh, 1000 = mép phải)`, 'int'), t(`${k}_y`, `Góc ${n}: y (0 = mép trên ảnh, 1000 = mép dưới)`, 'int')];
  }),
  hint: 'Đây không phải đọc chữ: hãy tìm 4 GÓC MÉP NGOÀI của tờ giấy (mép giấy thật, không lấy khung kẻ bên trong, không lấy mép bàn). Tọa độ theo thang 0-1000 của ảnh. Góc nằm ngoài ảnh thì lấy điểm trên mép ảnh gần nhất.',
};
// Scan tài liệu: AI đọc nội dung (nhận dạng chữ) + nhận ra Lệnh vận chuyển / Hợp đồng để tự đặt tên, xếp thư mục
export const SCAN_DOC: ReadDef = {
  code: 'scan_doc', owner: 'cong_ty', name: 'tài liệu scan (có thể có chữ viết tay)', hasExpiry: false, required: false,
  fields: [
    t('loai', 'Loại: Lệnh vận chuyển | Hợp đồng vận chuyển | Hóa đơn | Phiếu thu/chi | Giấy tờ xe | Giấy tờ cá nhân | Khác'),
    t('tieu_de', 'Tiêu đề tài liệu'), t('so_van_ban', 'Số văn bản / số hiệu'), t('ngay', 'Ngày của tài liệu', 'date'), t('tom_tat', 'Tóm tắt 1-2 câu'),
    t('noi_dung', 'TOÀN BỘ chữ đọc được trên tài liệu, giữ thứ tự và xuống dòng như trên giấy'),
    t('lenh_so', 'Lệnh vận chuyển: số lệnh, chép đúng như in (vd 26040714/LVC-CT)'), t('lenh_tu_ngay', 'Lệnh: hiệu lực từ ngày', 'date'), t('lenh_den_ngay', 'Lệnh: hiệu lực đến ngày', 'date'),
    t('lai_xe_1', 'Lệnh: họ tên lái xe 1'), t('lai_xe_2', 'Lệnh: họ tên lái xe 2'), t('bien_so', 'Biển số xe'), t('tuyen', 'Lệnh: dòng Tuyến'), t('ma_tuyen', 'Lệnh: mã số tuyến'),
    t('ben_di', 'Lệnh: bến xuất phát lượt đi'), t('ben_ve', 'Lệnh: bến xuất phát lượt về'), t('ngay_xuat', 'Lệnh: ngày xuất bến lượt đi', 'date'),
  ],
  hint: 'Các ô bắt đầu bằng "Lệnh" chỉ điền khi là Lệnh vận chuyển. Năm viết tắt (vd 26) là 2026.',
};
