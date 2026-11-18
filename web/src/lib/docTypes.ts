// Danh mục giấy tờ + các ô AI cần đọc.
// TỆP NÀY CÓ 2 BẢN GIỐNG HỆT NHAU: supabase/functions/_shared/doc_types.ts và web/src/lib/docTypes.ts
// (CI kiểm tra). Mã loại giấy phải khớp bảng public.document_types.
//
// Quy ước khóa:
//   so_giay, noi_cap, ngay_cap, hieu_luc_tu, het_han  → cột chính của giấy tờ
//   xe.*                                              → thông tin xe (điền sẵn hồ sơ xe, đối chiếu biển số)
//   còn lại                                           → lưu thêm trong data của giấy tờ

export type FieldKind = 'text' | 'date' | 'int' | 'money';
export interface DocField { key: string; label: string; kind: FieldKind }
export interface DocTypeDef { code: string; owner: 'xe'; name: string; hasExpiry: boolean; required: boolean; fields: DocField[] }

const f = (key: string, label: string, kind: FieldKind = 'text'): DocField => ({ key, label, kind });

const XE_CO_BAN = [f('xe.bien_so', 'Biển số'), f('xe.so_khung', 'Số khung'), f('xe.so_may', 'Số máy')];
const HIEU_LUC = [f('hieu_luc_tu', 'Hiệu lực từ ngày', 'date'), f('het_han', 'Hết hạn ngày', 'date')];
const BAO_HIEM = [
  f('so_giay', 'Số hợp đồng / giấy chứng nhận'), f('noi_cap', 'Công ty bảo hiểm'), f('xe.bien_so', 'Biển số'),
  f('ngay_cap', 'Ngày cấp', 'date'), ...HIEU_LUC,
];

export const DOC_TYPES: DocTypeDef[] = [
  {
    code: 'dang_ky', owner: 'xe', name: 'Giấy đăng ký xe (cà vẹt)', hasExpiry: false, required: true,
    fields: [
      f('so_giay', 'Số đăng ký'), ...XE_CO_BAN, f('xe.chu_xe', 'Tên chủ xe'), f('dia_chi_chu_xe', 'Địa chỉ chủ xe'),
      f('xe.nhan_hieu', 'Nhãn hiệu'), f('xe.so_loai', 'Số loại'), f('xe.mau_son', 'Màu sơn'),
      f('xe.so_cho', 'Số chỗ', 'int'), f('xe.nam_san_xuat', 'Năm sản xuất', 'int'), f('noi_cap', 'Nơi cấp'),
      f('ngay_cap', 'Ngày đăng ký', 'date'), f('het_han', 'Có giá trị đến (nếu có)', 'date'),
    ],
  },
  {
    code: 'kiem_dinh', owner: 'xe', name: 'Giấy chứng nhận kiểm định (đăng kiểm)', hasExpiry: true, required: true,
    fields: [
      f('so_giay', 'Số seri giấy chứng nhận'), f('so_tem', 'Số tem kiểm định'), ...XE_CO_BAN,
      f('xe.nhan_hieu', 'Nhãn hiệu'), f('xe.so_loai', 'Số loại'), f('xe.nam_san_xuat', 'Năm sản xuất', 'int'),
      f('xe.nuoc_san_xuat', 'Nước sản xuất'), f('xe.cho_ngoi', 'Số chỗ ngồi', 'int'), f('xe.cho_nam', 'Số chỗ nằm', 'int'),
      f('xe.cho_dung', 'Số chỗ đứng', 'int'), f('xe.khoi_luong_ban_than', 'Khối lượng bản thân (kg)', 'int'),
      f('xe.khoi_luong_toan_bo', 'Khối lượng toàn bộ cho phép (kg)', 'int'), f('nien_han', 'Niên hạn sử dụng (năm)', 'int'),
      f('noi_cap', 'Đơn vị kiểm định'), f('ngay_cap', 'Ngày kiểm định', 'date'), f('het_han', 'Có hiệu lực đến', 'date'),
    ],
  },
  { code: 'bh_tnds', owner: 'xe', name: 'Bảo hiểm trách nhiệm dân sự bắt buộc', hasExpiry: true, required: true,
    fields: [...BAO_HIEM, f('phi_bao_hiem', 'Phí bảo hiểm (đồng)', 'money')] },
  { code: 'bh_vat_chat', owner: 'xe', name: 'Bảo hiểm vật chất xe', hasExpiry: true, required: false,
    fields: [...BAO_HIEM, f('so_tien_bao_hiem', 'Số tiền bảo hiểm (đồng)', 'money'),
             f('muc_khau_tru', 'Mức khấu trừ (đồng/vụ)', 'money'), f('phi_bao_hiem', 'Phí bảo hiểm (đồng)', 'money')] },
  { code: 'bh_hanh_khach', owner: 'xe', name: 'Bảo hiểm tai nạn hành khách', hasExpiry: true, required: false,
    fields: [...BAO_HIEM, f('so_tien_bao_hiem', 'Số tiền bảo hiểm (đồng/người)', 'money'),
             f('so_nguoi', 'Số người được bảo hiểm', 'int'), f('phi_bao_hiem', 'Phí bảo hiểm (đồng)', 'money')] },
  { code: 'phu_hieu', owner: 'xe', name: 'Phù hiệu xe', hasExpiry: true, required: true,
    fields: [f('so_giay', 'Số phù hiệu'), f('loai_phu_hieu', 'Loại phù hiệu (tuyến cố định, hợp đồng…)'),
             f('xe.bien_so', 'Biển số'), f('noi_cap', 'Cơ quan cấp'), f('ngay_cap', 'Ngày cấp', 'date'), f('het_han', 'Có giá trị đến', 'date')] },
  { code: 'hop_dong_thue', owner: 'xe', name: 'Hợp đồng thuê xe / hợp tác kinh doanh', hasExpiry: true, required: false,
    fields: [f('so_giay', 'Số hợp đồng'), f('noi_cap', 'Bên cho thuê / bên hợp tác'), f('xe.bien_so', 'Biển số'),
             f('ngay_cap', 'Ngày ký', 'date'), ...HIEU_LUC, f('gia_thue', 'Giá thuê (đồng/tháng)', 'money')] },
  { code: 'cai_tao', owner: 'xe', name: 'Giấy chứng nhận cải tạo', hasExpiry: false, required: false,
    fields: [f('so_giay', 'Số giấy chứng nhận'), ...XE_CO_BAN, f('noi_dung_cai_tao', 'Nội dung cải tạo'),
             f('noi_cap', 'Cơ quan cấp'), f('ngay_cap', 'Ngày cấp', 'date')] },
];

export const docTypeOf = (code: string): DocTypeDef | undefined => DOC_TYPES.find((d) => d.code === code);

/** Khóa biển số dùng để so sánh: bỏ dấu chấm, gạch, khoảng trắng, viết hoa. */
export const plateKey = (s: string): string => s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
export const PLATE_RE = /^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$/;
