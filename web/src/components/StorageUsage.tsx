// Cấu hình → Dung lượng: database và file đã dùng so với giới hạn gói (đổi gói chỉ sửa VITE_DB_LIMIT_MB, VITE_FILE_LIMIT_MB).
import { useEffect, useState } from 'react';
import { config } from '../config';
import { errMsg, rpc } from '../lib/supabase';

interface Usage { db_bytes: number; files_bytes: number; tenant_files_bytes: number; tenant_files_count: number; drive_items: number; drive_bytes: number }
const mb = (b: number) => `${(b / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;

function Bar({ label, used, limitMb, note }: { label: string; used: number; limitMb: number; note?: string }) {
  const pct = Math.min(100, (used / (limitMb * 1048576)) * 100);
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  return (
    <div className="use-row">
      <div className="item-head"><b>{label}</b><span className={cls === 'bad' ? 'danger-text' : ''}>{mb(used)} / {limitMb.toLocaleString('vi-VN')} MB · {pct.toFixed(0)}%</span></div>
      <div className={`use-bar ${cls}`} role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${pct}%` }} /></div>
      {note && <p className="small muted">{note}</p>}
    </div>
  );
}

export function StorageUsage() {
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { rpc<Usage>('storage_usage').then(setU, (e) => setErr(errMsg(e))); }, []);
  return (
    <section className="card form">
      <h2>Dung lượng</h2>
      {err && <p className="error-text small">{err}</p>}
      {!u && !err && <p className="muted small">Đang tính…</p>}
      {u && (
        <>
          <Bar label="Dữ liệu (database)" used={Number(u.db_bytes)} limitMb={config.dbLimitMb}
            note="Dùng chung cho cả hệ thống. Vượt giới hạn thì không ghi thêm được dữ liệu (chỉ đọc), cần nâng gói hoặc dọn bớt." />
          <Bar label="File (ảnh giấy tờ, hóa đơn, chữ ký…)" used={Number(u.files_bytes)} limitMb={config.fileLimitMb}
            note={`Trong đó nhà xe này: ${mb(Number(u.tenant_files_bytes))} (${Number(u.tenant_files_count).toLocaleString('vi-VN')} tệp).`} />
          <p className="small muted">Lưu trữ hồ sơ nằm trên Google Drive của nhà xe, không tính vào đây: {Number(u.drive_items).toLocaleString('vi-VN')} hồ sơ, khoảng {mb(Number(u.drive_bytes))}.</p>
        </>
      )}
    </section>
  );
}
