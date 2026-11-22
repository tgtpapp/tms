// Trang lưu lệnh đã đóng dấu: lái xe mở Zalo (hoặc camera) quét mã QR in trên lệnh → chụp lệnh → máy kiểm tra
// đủ dấu bến xe (2 dấu mỗi lượt có giờ chạy) mới lưu vào hồ sơ của nhà xe. Không cần đăng nhập: mã riêng từng lệnh.
import { useEffect, useRef, useState } from 'react';
import { config } from '../config';
import { buildPdf, detect, loadImage, refine, render, toBlob, type Page } from '../lib/scan';

interface Info { order_no: string; valid_from: string; valid_to: string; plate: string | null; route: string | null;
  legs: { seq: number; time: string | null; date: string | null }[]; required: number; saved: boolean; expired: boolean }

const d = (s: string | null) => (s ? s.split('-').reverse().join('/') : '');
const b64 = (b: Blob) => new Promise<string>((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => no(new Error('Không đọc được ảnh')); r.readAsDataURL(b); });

async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let r: Response;
  try {
    r = await fetch(`${config.supabaseUrl}/functions/v1/lenh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: config.supabasePublishableKey }, body: JSON.stringify(body),
    });
  } catch { throw new Error('Không có mạng, kiểm tra kết nối rồi thử lại'); }
  const j = await r.json().catch(() => ({})) as Record<string, unknown>;
  if (!r.ok) throw new Error(String(j.error ?? 'Máy chủ đang lỗi, thử lại sau'));
  return j;
}

export function LenhUpload({ token }: { token: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [err, setErr] = useState('');
  const [page, setPage] = useState<Page | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { void call({ action: 'info', token }).then((j) => setInfo(j as unknown as Info)).catch((e) => setErr((e as Error).message)); }, [token]);

  async function pick(f: File | undefined) {
    if (!f) return;
    setMsg(null); setBusy(true);
    try {
      const src = await loadImage(f);
      const pg: Page = { src, q: refine(src, detect(src)), f: 'color' };   // giữ màu: dấu đỏ của bến xe
      setPage(pg);
      setPreview(render(pg, 900).toDataURL('image/jpeg', 0.8));
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  async function send() {
    if (!page) return;
    setBusy(true); setMsg(null);
    try {
      const [ai, pdf] = await Promise.all([toBlob(render(page, 1600), 'image/jpeg', 0.85), buildPdf([page], 2400)]);
      const j = await call({ action: 'upload', token, page: await b64(ai), data: await b64(pdf), mime: 'application/pdf' });
      setMsg({ ok: true, text: `Đã lưu lệnh vào hồ sơ (${String(j.stamps)}/${String(j.required)} dấu bến xe).` });
      setInfo((x) => (x ? { ...x, saved: true } : x));
      setPage(null); setPreview(null);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <main className="lenh-up">
      <h1>Lưu lệnh vận chuyển</h1>
      {err && <p className="error-text" role="alert">{err}</p>}
      {!info && !err && <p className="muted">Đang tải…</p>}
      {info && (
        <>
          <div className="card">
            <div><b>{info.order_no}</b></div>
            <div>{info.route}{info.plate ? ` · ${info.plate}` : ''}</div>
            <div className="small">Hiệu lực {d(info.valid_from)} – {d(info.valid_to)}</div>
            <div className="small">Cần đủ <b>{info.required}</b> dấu bến xe ({info.required / 2} lượt × bến đi + bến đến)</div>
            {info.saved && <div className="small state-con_han">Lệnh này đã được lưu vào hồ sơ</div>}
          </div>
          {info.expired ? <p className="error-text">Lệnh đã quá hạn lưu.</p> : (
            <>
              <input ref={input} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
              {preview && <img className="lenh-up-pv" src={preview} alt="Ảnh lệnh vừa chụp" />}
              {msg && <p className={msg.ok ? 'state-con_han' : 'error-text'} role="alert">{msg.text}</p>}
              <div className="actions">
                <button type="button" className={page ? 'btn' : 'btn primary'} disabled={busy} onClick={() => input.current?.click()}>{page ? 'Chụp lại' : '📷 Chụp lệnh'}</button>
                {page && <button type="button" className="btn primary" disabled={busy} onClick={() => void send()}>{busy ? 'Đang kiểm tra dấu…' : 'Kiểm tra dấu và lưu'}</button>}
              </div>
            </>
          )}
        </>
      )}
    </main>
  );
}
