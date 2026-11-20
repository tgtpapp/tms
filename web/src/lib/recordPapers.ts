// Giấy khám sức khỏe / giấy tập huấn có thể nằm ở 2 chỗ: mục Giấy tờ (documents) hoặc Lý lịch hành nghề
// (staff_records: "Theo dõi sức khỏe" / "Đào tạo, tập huấn", dữ liệu chuyển từ app cũ nằm ở đây).
// Gộp 2 nguồn như máy chủ (app.staff_paper): có ở 1 trong 2 là có, ngày hết hạn lấy xa nhất.
export const RECORD_OF: Record<string, string> = { kham_suc_khoe: 'suc_khoe', tap_huan: 'dao_tao' };
interface Rec { staff_id: string; kind: string; data: Record<string, unknown> | null }

/** Ngày hết hạn xa nhất trong lý lịch của 1 người theo loại giấy; undefined = không có dòng lý lịch nào. */
export function recordExpiry(recs: Rec[], staffId: string, docType: string): string | null | undefined {
  const kind = RECORD_OF[docType];
  if (!kind) return undefined;
  const mine = recs.filter((r) => r.staff_id === staffId && r.kind === kind);
  if (!mine.length) return undefined;
  const ds = mine.map((r) => String(r.data?.het_han ?? '')).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return ds.length ? ds[ds.length - 1] : null;
}

/** Gộp: trả danh sách giấy có thêm / sửa ngày hết hạn theo lý lịch. make tạo giấy "ảo" khi chỉ có trong lý lịch. */
export function mergeRecordPapers<T extends { staff_id: string | null; doc_type: string; expires_on: string | null }>(
  docs: T[], recs: Rec[], make: (staffId: string, docType: string, exp: string | null) => T,
): T[] {
  const out = [...docs];
  const staffIds = [...new Set(recs.map((r) => r.staff_id))];
  for (const sid of staffIds) for (const type of Object.keys(RECORD_OF)) {
    const exp = recordExpiry(recs, sid, type);
    if (exp === undefined) continue;
    const i = out.findIndex((d) => d.staff_id === sid && d.doc_type === type);
    if (i < 0) out.push(make(sid, type, exp));
    else if (out[i].expires_on && exp && exp > out[i].expires_on!) out[i] = { ...out[i], expires_on: exp };
  }
  return out;
}
