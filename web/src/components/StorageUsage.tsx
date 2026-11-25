// Cấu hình → Dung lượng: sức khỏe từng nơi lưu so với giới hạn gói — database, kho file (Supabase), bản dự phòng (Neon), Google Drive của nhà xe.
// Đổi gói chỉ sửa VITE_DB_LIMIT_MB, VITE_FILE_LIMIT_MB, VITE_NEON_LIMIT_MB.
import { useEffect, useState } from 'react';
import { config } from '../config';
import { drive } from '../lib/drive';
import { errMsg, rpc } from '../lib/supabase';

interface Usage { db_bytes: number; files_bytes: number; tenant_files_bytes: number; tenant_files_count: number; drive_items: number; drive_bytes: number;
  drive_files?: number; drive_files_bytes?: number; neon?: { bytes?: number; ok?: boolean; configured?: boolean; at: string } | null }
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const mb = (b: number) => `${(b / 1048576).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;

type View = 'bar' | 'gauge';
const VIEW_KEY = 'tms.dung_luong.kieu_xem';
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === 'gauge' ? 'gauge' : 'bar'; } catch { return 'bar'; } };

/** Đồng hồ đo nửa vòng: vùng xanh < 70%, vàng 70–90%, đỏ ≥ 90%; kim chỉ phần trăm đã dùng. */
function Gauge({ label, used, limitMb, note }: { label: string; used: number; limitMb: number; note?: string }) {
  const pct = Math.min(100, (used / (limitMb * 1048576)) * 100);
  const cls = pct >= 90 ? 'bad' : pct >= 70 ? 'warn' : '';
  const pt = (p: number, r: number) => { const a = Math.PI * (1 - p / 100); return `${(100 + r * Math.cos(a)).toFixed(2)} ${(100 - r * Math.sin(a)).toFixed(2)}`; };
  const arc = (a: number, b: number, r: number) => `M ${pt(a, r)} A ${r} ${r} 0 0 1 ${pt(b, r)}`;
  const ang = 180 * (pct / 100) - 90;
  return (
    <div className="use-gauge">
      <svg viewBox="0 0 200 118" role="meter" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <path d={arc(0, 100, 78)} className="g-track" />
        <path d={arc(0, 70, 92)} className="g-zone ok" /><path d={arc(70, 90, 92)} className="g-zone warn" /><path d={arc(90, 100, 92)} className="g-zone bad" />
        {pct > 0 && <path d={arc(0, Math.max(pct, 0.5), 78)} className={`g-val ${cls}`} />}
        <g transform={`rotate(${ang} 100 100)`}><path d="M 97 100 L 100 34 L 103 100 Z" className="g-needle" /></g>
        <circle cx="100" cy="100" r="7" className="g-needle" />
        {[0, 25, 50, 75, 100].map((t) => <text key={t} x={pt(t, 62).split(' ')[0]} y={Number(pt(t, 62).split(' ')[1]) + 4} className="g-tick">{t}</text>)}
      </svg>
      <b className={`g-pct ${cls}`}>{pct.toFixed(0)}%</b>
      <b>{label}</b>
      <span className={cls === 'bad' ? 'danger-text small' : 'small'}>{mb(used)} / {limitMb.toLocaleString('vi-VN')} MB</span>
      {note && <p className="small muted">{note}</p>}
    </div>
  );
}

function Bar({ label, used, limitMb, note, view }: { label: string; used: number; limitMb: number; note?: string; view: View }) {
  if (view === 'gauge') return <Gauge label={label} used={used} limitMb={limitMb} note={note} />;
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
  const [gd, setGd] = useState<{ used: number; limit: number } | null>(null);
  const [view, setView] = useState<View>(readView);
  const pick = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* trình duyệt chặn lưu: chỉ đổi trong phiên */ } };
  useEffect(() => {
    rpc<Usage>('storage_usage').then(setU, (e) => setErr(errMsg(e)));
    drive<{ used: number; limit: number }>({ action: 'ping' }).then(setGd, () => setGd(null));   // chưa kết nối Drive: không hiện
  }, []);
  return (
    <section className="card form">
      <div className="item-head">
        <h2>Dung lượng</h2>
        <div className="seg" role="group" aria-label="Kiểu xem dung lượng">
          <button type="button" className={view === 'bar' ? 'on' : ''} aria-pressed={view === 'bar'} onClick={() => pick('bar')}>Thanh</button>
          <button type="button" className={view === 'gauge' ? 'on' : ''} aria-pressed={view === 'gauge'} onClick={() => pick('gauge')}>Đồng hồ</button>
        </div>
      </div>
      {err && <p className="error-text small">{err}</p>}
      {!u && !err && <p className="muted small">Đang tính…</p>}
      {u && (
        <div className={view === 'gauge' ? 'use-gauges' : 'use-bars'}>
          <Bar view={view} label="Dữ liệu (database)" used={Number(u.db_bytes)} limitMb={config.dbLimitMb}
            note="Dùng chung cho cả hệ thống. Vượt giới hạn thì không ghi thêm được dữ liệu (chỉ đọc), cần nâng gói hoặc dọn bớt." />
          <Bar view={view} label="File (ảnh giấy tờ, hóa đơn, chữ ký…)" used={Number(u.files_bytes)} limitMb={config.fileLimitMb}
            note={`Trong đó nhà xe này: ${mb(Number(u.tenant_files_bytes))} (${Number(u.tenant_files_count).toLocaleString('vi-VN')} tệp).`} />
          {u.neon?.configured === false
            ? <p className="small danger-text">Bản dự phòng (Neon): CHƯA BẬT — chưa có kết nối Neon nên chưa sao chép dự phòng toàn hệ thống.</p>
            : u.neon
            ? <Bar view={view} label="Bản dự phòng (Neon)" used={Number(u.neon.bytes ?? 0)} limitMb={config.neonLimitMb}
                note={`Sao chép toàn hệ thống mỗi đêm. Lần cuối ${when(u.neon.at)}: ${u.neon.ok ? 'khớp đủ dữ liệu' : 'LỆCH dữ liệu, cần kiểm tra'}.`} />
            : <p className="small muted">Bản dự phòng (Neon): chưa có số liệu, có sau lần sao chép đêm nay.</p>}
          {gd && gd.limit > 0 && (
            <Bar view={view} label="Google Drive của nhà xe" used={Number(gd.used)} limitMb={Math.round(Number(gd.limit) / 1048576)}
              note={`Lưu trữ hồ sơ: ${Number(u.drive_items).toLocaleString('vi-VN')} hồ sơ, khoảng ${mb(Number(u.drive_bytes))}. Ảnh giấy tờ: ${Number(u.drive_files ?? 0).toLocaleString('vi-VN')} tệp, ${mb(Number(u.drive_files_bytes ?? 0))}.`} />
          )}
          {(!gd || !(gd.limit > 0)) && <p className="small muted">Lưu trữ hồ sơ nằm trên Google Drive của nhà xe, không tính vào đây: {Number(u.drive_items).toLocaleString('vi-VN')} hồ sơ, khoảng {mb(Number(u.drive_bytes))}.</p>}
        </div>
      )}
    </section>
  );
}
