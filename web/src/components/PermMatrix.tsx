// Bảng phân quyền như app cũ: mỗi dòng 1 màn hình, cột Xem / Thêm / Sửa / Xóa, cột "Tất cả dòng"; ô không có nghĩa để gạch (—).
// inherited: các ô có từ nhóm (đánh dấu; bỏ tích = chặn riêng người đó). allowed: ô người đang thao tác được cấp (không cấp vượt quyền mình; bỏ tích luôn được).
export const SCREENS: [string, string][] = [
  ['sell', 'Bán vé'], ['parcel', 'Gửi hàng'], ['charter', 'Hợp đồng vận chuyển'], ['trip', 'Điều hành'], ['route', 'Tuyến & giá vé'],
  ['repair', 'Sửa chữa'], ['fuel', 'Nhiên liệu'], ['report', 'Báo cáo'], ['km', 'Km xe'], ['vehicle', 'Xe'], ['staff', 'Lái xe & nhân viên'],
  ['labor', 'Hợp đồng lao động'], ['salary', 'BHXH & lương chuyển khoản'], ['branch', 'Chi nhánh'], ['office', 'Phòng vé'], ['doc', 'Văn bản'],
  ['archive', 'Lưu trữ hồ sơ'], ['user', 'Người dùng'], ['role', 'Vai trò (phân quyền)'], ['settings', 'Cấu hình'], ['audit', 'Nhật ký'],
];
export const ACTS: [string, string][] = [['view', 'Xem'], ['add', 'Thêm'], ['edit', 'Sửa'], ['delete', 'Xóa']];

export function PermMatrix({ catalog, value, onChange, allowed, inherited, readOnly }: {
  catalog: Set<string>; value: Set<string>; onChange: (v: Set<string>) => void; allowed: (code: string) => boolean;
  inherited?: Set<string>; readOnly?: boolean;
}) {
  const on = (c: string) => value.has(c);
  const can = (c: string) => !readOnly && catalog.has(c) && (allowed(c) || value.has(c) || !!inherited?.has(c));
  const set = (codes: string[], v: boolean) => {
    const next = new Set(value);
    for (const c of codes) if (can(c) && (!v || allowed(c) || inherited?.has(c))) { if (v) next.add(c); else next.delete(c); }
    onChange(next);
  };
  const rowCodes = (s: string) => ACTS.map(([a]) => `${s}.${a}`).filter((c) => catalog.has(c));
  const colCodes = (a: string) => SCREENS.map(([s]) => `${s}.${a}`).filter((c) => catalog.has(c));
  const all = (codes: string[]) => codes.length > 0 && codes.every(on);
  return (
    <div className="table-wrap">
      <table className="plist perm-matrix">
        <thead><tr>
          <th>Màn hình / chức năng</th>
          {ACTS.map(([a, l]) => (
            <th key={a} className="c">{l}<br />
              <input type="checkbox" aria-label={`Tất cả cột ${l}`} disabled={readOnly} checked={all(colCodes(a))} onChange={(e) => set(colCodes(a), e.target.checked)} /></th>
          ))}
          <th className="c">Tất cả dòng</th>
        </tr></thead>
        <tbody>
          {SCREENS.map(([s, label]) => (
            <tr key={s}>
              <td>{label}</td>
              {ACTS.map(([a, l]) => {
                const c = `${s}.${a}`;
                if (!catalog.has(c)) return <td key={a} className="c muted">—</td>;
                return (
                  <td key={a} className={`c${inherited?.has(c) ? (on(c) ? ' inh' : ' deny') : on(c) && inherited ? ' own' : ''}`}
                      title={inherited?.has(c) ? (on(c) ? 'Có từ nhóm' : 'Có từ nhóm nhưng đã bỏ riêng người này') : inherited && on(c) ? 'Quyền riêng' : !allowed(c) ? 'Bạn không có quyền này nên không cấp được' : ''}>
                    <input type="checkbox" aria-label={`${label}: ${l}`} checked={on(c)} disabled={!can(c)} onChange={(e) => set([c], e.target.checked)} />
                  </td>
                );
              })}
              <td className="c"><input type="checkbox" aria-label={`${label}: tất cả`} disabled={readOnly} checked={all(rowCodes(s))} onChange={(e) => set(rowCodes(s), e.target.checked)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Nút nhanh dưới bảng: Tích tất cả / Chỉ xem / Bỏ hết. */
export function quick(kind: 'all' | 'view' | 'none', catalog: Set<string>, allowed: (c: string) => boolean): Set<string> {
  if (kind === 'none') return new Set();
  return new Set([...catalog].filter((c) => allowed(c) && (kind === 'all' || c.endsWith('.view'))));
}
