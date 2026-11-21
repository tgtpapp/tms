// Chuông thông báo của từng người: số chưa đọc, bấm mở danh sách (mở là đánh dấu đã đọc); tự cập nhật mỗi 30 giây và khi quay lại app.
import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';

interface Note { id: string; kind: string; title: string; body: string; created_at: string; read_at: string | null }
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });

export function NotifyBell({ inline = false }: { inline?: boolean }) {
  const [list, setList] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const since = new Date(Date.now() - 2 * 86400e3).toISOString();
    const r = await supabase.from('notifications').select('id, kind, title, body, created_at, read_at').gte('created_at', since).order('created_at', { ascending: false }).limit(40);
    if (!r.error) setList((r.data ?? []) as Note[]);
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const vis = () => { if (!document.hidden) void load(); };
    const msg = (e: MessageEvent) => { if ((e.data as { type?: string })?.type === 'mo-thong-bao') { void load(); setOpen(true); } };
    document.addEventListener('visibilitychange', vis);
    navigator.serviceWorker?.addEventListener('message', msg);
    if (new URLSearchParams(location.search).get('thong-bao') === '1') setOpen(true);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', vis); navigator.serviceWorker?.removeEventListener('message', msg); };
  }, [load]);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, [open]);
  const unread = list.filter((x) => !x.read_at).length;
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && unread) {
      await rpc('mark_notifications_read', {}).catch(() => undefined);
      setTimeout(() => setList((l) => l.map((x) => (x.read_at ? x : { ...x, read_at: new Date().toISOString() }))), 4000);   // đã báo thì tự mờ đi
    }
  }
  return (
    <div className={inline ? 'nb nb-inline' : 'nb'} ref={box}>
      <button type="button" className={unread ? 'nb-btn has' : 'nb-btn'} aria-label={`Thông báo${unread ? `: ${unread} chưa đọc` : ''}`} aria-expanded={open} onClick={() => void toggle()}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="nb-n">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="nb-pop" role="dialog" aria-label="Danh sách thông báo">
          <div className="nb-head"><b>Thông báo</b><button type="button" className="btn small link" onClick={() => setOpen(false)}>Đóng</button></div>
          {list.length === 0 ? <p className="muted small nb-empty">Chưa có thông báo trong 2 ngày qua.</p> : (
            <ul className="nb-list">
              {list.map((n) => (
                <li key={n.id} className={n.read_at ? 'old' : 'new'}>
                  <b>{n.title}</b><span>{n.body}</span><small>{when(n.created_at)}</small>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
