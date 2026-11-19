// Đọc file sao lưu (.json) của app cũ "Nhà Xe Thịnh Phát" và chuyển sang dữ liệu TMS.
// File được đọc trên máy người dùng. CHỈ lấy danh sách nhân viên (employees) và xe (vehicles);
// mọi phần khác (cấu hình, khóa AI, kết nối Firebase…) bị bỏ qua, không lưu, không gửi đi.
import type { PreparedFile } from './documents';

export type Raw = Record<string, unknown>;

export interface LegacyBackup { employees: Raw[]; vehicles: Raw[]; trips: Raw[]; repairs: Raw[]; fuel: Raw[]; km: Raw[]; fuelSet: Raw | null }

export function parseBackup(text: string): LegacyBackup {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('File không phải bản sao lưu .json của app cũ');
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('File không phải bản sao lưu của app cũ');
  const o = j as Raw;
  const arr = (k: string) => (Array.isArray(o[k]) ? (o[k] as unknown[]).filter((x): x is Raw => !!x && typeof x === 'object') : []);
  const employees = arr('employees');
  const vehicles = arr('vehicles');
  if (employees.length === 0 && vehicles.length === 0) throw new Error('Không thấy danh sách nhân viên hoặc xe trong file');
  const st = o.settings && typeof o.settings === 'object' ? (o.settings as Raw).nl : null;
  return { employees, vehicles, trips: arr('lichchay'), repairs: arr('suachua'), fuel: arr('nhienlieu'), km: arr('kmxe'), fuelSet: st && typeof st === 'object' && !Array.isArray(st) ? (st as Raw) : null };
}

export const str = (r: Raw, k: string): string => {
  const v = r[k];
  return v == null ? '' : typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
};

/** Ngày: nhận YYYY-MM-DD hoặc DD/MM/YYYY, trả YYYY-MM-DD hoặc null. */
export function day(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export const phone10 = (s: string): string | null => {
  const d = s.replace(/\D/g, '');
  return /^0\d{9}$/.test(d) ? d : null;
};

export const plateKey = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, '');
export const PLATE_OK = /^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$/;
export const normName = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** UUID cố định theo nhà xe + mã cũ: nhập lại bao nhiêu lần cũng không tạo trùng. */
export async function stableId(tenantId: string, kind: string, oldId: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`tms-nhap-app-cu:${tenantId}:${kind}:${oldId}`)));
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Ảnh / PDF nằm sẵn trong file sao lưu (data URL). Ảnh trên Google Drive ("nxdrv:", http…) không có trong file. */
export function fromDataUrl(v: string): PreparedFile | null {
  const m = /^data:(image\/(?:jpeg|jpg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/=\s]+)$/.exec(v);
  if (!m) return null;
  const base64 = m[2].replace(/\s/g, '');
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const mime = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  return { blob: new Blob([bytes], { type: mime }), mime, base64, ext };
}
export const isExternal = (v: string) => /^(nxdrv:|https?:)/.test(v);

/* ------------------------------------------------------------------ Nhân viên */

export interface LegacyDoc {
  type: string; doc_no: string | null; issuer: string | null; issued_on: string | null; expires_on: string | null;
  data: Record<string, string | number | null>; files: PreparedFile[]; external: number;
}

export interface StaffRow {
  oldId: string; ma: string; name: string; phone: string | null; cccd: string | null; position: 'lai_xe' | 'phu_xe' | 'nhan_vien';
  staff: Record<string, unknown>; docs: LegacyDoc[];
}

const CONTRACT: Record<string, string> = {
  'Xác định thời hạn': 'xac_dinh', 'Thời vụ': 'thoi_vu', 'Không xác định thời hạn': 'khong_xac_dinh',
};

function doc(type: string, r: Raw, files: string[], fields: Partial<LegacyDoc>): LegacyDoc | null {
  const vals = files.map((k) => str(r, k)).filter(Boolean);
  const d: LegacyDoc = {
    type, doc_no: null, issuer: null, issued_on: null, expires_on: null, data: {}, ...fields,
    files: vals.map(fromDataUrl).filter((x): x is PreparedFile => x !== null), external: vals.filter(isExternal).length,
  };
  const hasInfo = d.doc_no || d.issued_on || d.expires_on || d.files.length || d.external;
  return hasInfo ? d : null;
}

export function mapEmployee(r: Raw, today: string): StaffRow | null {
  const name = str(r, 'ten');
  if (!name) return null;
  const ma = str(r, 'ma');
  const job = `${str(r, 'phongBan')} ${str(r, 'chucVu')}`.toLowerCase();
  const position = /phụ xe|phu xe/.test(job) ? 'phu_xe' : str(r, 'bangHang') || /lái|tài xế|tai xe/.test(job) ? 'lai_xe' : 'nhan_vien';
  const phone = phone10(str(r, 'sdt'));
  const cccd = str(r, 'cccd').replace(/\D/g, '') || null;
  const gt = str(r, 'gioiTinh');
  const notes = [`Nhập từ app cũ${ma ? ` · mã ${ma}` : ''}`];
  if (str(r, 'chucVu')) notes.push(`Chức vụ: ${str(r, 'chucVu')}`);
  if (str(r, 'sdt') && !phone) notes.push(`SĐT cũ: ${str(r, 'sdt')}`);
  if (str(r, 'diaChiHN')) notes.push(`Chỗ ở hiện nay: ${str(r, 'diaChiHN')}`);
  const staff = {
    full_name: name, position, phone, joined_on: day(str(r, 'ngayVao')) ?? today, is_active: str(r, 'trangThai') !== 'Nghỉ việc',
    birth_date: day(str(r, 'ngaySinh')), gender: gt === 'Nam' ? 'nam' : gt === 'Nữ' ? 'nu' : null, address: str(r, 'diaChiTT') || null,
    contract_type: CONTRACT[str(r, 'loaiHD')] ?? (str(r, 'trangThai') === 'Thử việc' ? 'thu_viec' : null), note: notes.join('\n'),
  };
  const docs = [
    doc('cccd', r, ['cccdTruoc', 'cccdSau'], {
      doc_no: cccd, issuer: str(r, 'cccdNoiCap') || null, issued_on: day(str(r, 'cccdNgayCap')), expires_on: day(str(r, 'cccdHetHan')),
      data: { 'nv.ho_ten': name, 'nv.ngay_sinh': day(str(r, 'ngaySinh')), 'nv.gioi_tinh': gt || null, quoc_tich: str(r, 'cccdQuocTich') || null,
              que_quan: str(r, 'cccdQueQuan') || null, 'nv.noi_thuong_tru': str(r, 'diaChiTT') || null, dac_diem_nhan_dang: str(r, 'cccdDacDiem') || null },
    }),
    doc('gplx', r, ['bangTruoc', 'bangSau'], {
      doc_no: str(r, 'bangSo') || null, issuer: str(r, 'bangNoiCap') || null, issued_on: day(str(r, 'bangNgayCap')),
      expires_on: day(str(r, 'bangHetHan')), data: { hang: str(r, 'bangHang') || null, 'nv.ho_ten': name },
    }),
  ].filter((x): x is LegacyDoc => x !== null);
  return { oldId: str(r, 'id') || ma || name, ma, name, phone, cccd, position, staff, docs };
}

/* ------------------------------------------------------------------ Xe */

/** Sơ đồ ghế app cũ: { cols, rows: [[ "" = lối đi, "D" = tài xế, "DOOR" = cửa, còn lại = số ghế ]] } */
export interface Layout { rows: number; cols: number; seats: { label: string; deck: number; row: number; col: number; kind: 'ghe' }[] }
export function parseLayout(v: unknown): Layout | null {
  let o = v;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
  const rowsRaw = (o as { rows?: unknown })?.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0 || rowsRaw.length > 30) return null;
  const cols = Math.max(...rowsRaw.map((r) => (Array.isArray(r) ? r.length : 0)));
  if (cols < 1 || cols > 8) return null;
  const seats: Layout['seats'] = [];
  rowsRaw.forEach((r, i) => (Array.isArray(r) ? r : []).forEach((c, j) => {
    const t = String(c ?? '').trim().toUpperCase();
    if (!t || /^(D|DOOR|CỬA|CUA|TÀI XẾ|TAI XE)$/.test(t) || t.length > 10) return;
    seats.push({ label: t, deck: 1, row: i + 1, col: j + 1, kind: 'ghe' });
  }));
  if (seats.length === 0 || new Set(seats.map((x) => x.label)).size !== seats.length) return null;
  return { rows: rowsRaw.length, cols, seats };
}

export interface VehicleRow {
  oldId: string; plate: string; key: string; seats: number | null; group: string; label: string; brand: string; layout: Layout | null;
  vehicle: Record<string, unknown>; docs: LegacyDoc[];
}

const BUSINESS: Record<string, string> = {
  'Tuyến cố định': 'tuyen_co_dinh', 'Xe hợp đồng': 'hop_dong', 'Xe du lịch': 'hop_dong', 'Tuyến cố định + Xe hợp đồng': 'ca_hai',
};

export function mapVehicle(r: Raw): VehicleRow | null {
  const plate = str(r, 'bks').toUpperCase();
  if (!plate) return null;
  const seats = Number(str(r, 'soCho')) || null;
  const loai = str(r, 'loai');
  const year = Number(str(r, 'namSX'));
  const notes = ['Nhập từ app cũ', loai && `Loại xe cũ: ${loai}`, str(r, 'ghiChu')].filter(Boolean);
  const vehicle = {
    plate, chassis_no: str(r, 'khung').toUpperCase() || null, engine_no: str(r, 'may').toUpperCase() || null,
    country_of_origin: str(r, 'nuocSX') || null, manufacture_year: year >= 1970 && year <= 2100 ? year : null,
    business_type: BUSINESS[str(r, 'loaiHinh')] ?? 'tuyen_co_dinh', gsht_provider: str(r, 'gpsNcc') || null,
    acquired_on: day(str(r, 'ngayHD')), is_active: !str(r, 'ngung'), note: notes.join('\n'),
  };
  const base = { 'xe.bien_so': plate };
  const docs = [
    doc('dang_ky', r, ['cavet'], {
      doc_no: str(r, 'dkSo') || null, issuer: str(r, 'dkNoi') || null, issued_on: day(str(r, 'dkNgay')),
      data: { ...base, 'xe.so_khung': vehicle.chassis_no, 'xe.so_may': vehicle.engine_no, 'xe.so_cho': seats, 'xe.nam_san_xuat': vehicle.manufacture_year },
    }),
    doc('kiem_dinh', r, ['dangKiem'], { doc_no: str(r, 'kdSo') || null, expires_on: day(str(r, 'hhDangKiem')), data: { ...base } }),
    doc('bh_tnds', r, ['bhds'], { expires_on: day(str(r, 'hhBHDS')), data: { ...base } }),
    doc('bh_vat_chat', r, ['bhvc'], { expires_on: day(str(r, 'hhBHVC')), data: { ...base } }),
    doc('phu_hieu', r, ['phuHieuF', 'phuHieu'], { expires_on: day(str(r, 'hhPhuHieu')), data: { ...base } }),
  ].filter((x): x is LegacyDoc => x !== null);
  const group = `${seats ?? '?'}|${loai.toLowerCase()}`;
  return { oldId: str(r, 'id') || plate, plate, key: plateKey(plate), seats, group, label: `${loai || 'Xe'} ${seats ?? '?'} chỗ`, brand: loai,
           layout: parseLayout(r.soDo), vehicle, docs };
}
