// Báo sự cố: người dùng nhắn sự cố (gửi kèm thông tin máy + lỗi gần nhất); người quản lý tài khoản của nhà xe xem và trả lời.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { supportContext } from '../lib/support';

interface Ticket {
  id: string; no: number; channel: 'app' | 'login'; status: 'mo' | 'dong'; created_by: string | null;
  reporter_name: string | null; reporter_phone: string | null; summary: string;
  context: { screen?: string; path?: string; ua?: string; online?: boolean; errors?: string[] };
  created_at: string; updated_at: string;
}
interface Msg { id: string; sender: 'nguoi_bao' | 'xu_ly' | 'bot'; user_id: string | null; body: string; created_at: string }

const COLS = 'id, no, channel, status, created_by, reporter_name, reporter_phone, summary, context, created_at, updated_at';
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });

export function SupportScreen({ me, canHandle, screen, prefill, onPrefillUsed }: {
  me: string | null; canHandle: boolean; screen?: string; prefill?: string; onPrefillUsed?: () => void;
}) {
  const [list, setList] = useState<Ticket[]>([]);
  const [err, setErr] = useState('');
  const [text, setText] = useState(prefill ?? '');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Ticket | null>(null);
  const [only, setOnly] = useState<'mo' | 'all'>('mo');

  const load = useCallback(async () => {
    const r = await supabase.from('support_tickets').select(COLS).order('updated_at', { ascending: false }).limit(200);
    if (r.error) setErr(r.error.message);
    else { setErr(''); setList((r.data ?? []) as Ticket[]); }
  }, []);
  useEffect(() => { void load(); const iv = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(iv); }, [load]);
  useEffect(() => { if (prefill) { setText(prefill); onPrefillUsed?.(); } }, [prefill, onPrefillUsed]);

  async function send() {
    setBusy(true); setErr('');
    try {
      const id = await rpc<string>('support_open', { p_text: text.trim(), p_context: supportContext(screen) });
      setText('');
      await load();
      const r = await supabase.from('support_tickets').select(COLS).eq('id', id).maybeSingle();
      if (r.data) setOpen(r.data as Ticket);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }

  const shown = list.filter((t) => only === 'all' || t.status === 'mo');
  const mine = (t: Ticket) => t.created_by === me;

  return (
    <section className="support">
      <div className="card form">
        <h2>Báo sự cố</h2>
        <label>
          Gặp sự cố gì?
          <textarea rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
                    placeholder="vd: Không vào được màn hình đặt vé" />
        </label>
        {err && <p className="error-text">{err}</p>}
        <button type="button" className="btn primary" disabled={busy || text.trim().length < 3} onClick={() => void send()}>
          {busy ? 'Đang gửi…' : 'Gửi'}
        </button>
      </div>

      <div className="card">
        <div className="support-head">
          <h3>{canHandle ? 'Sự cố của nhà xe' : 'Sự cố tôi đã báo'}</h3>
          <div className="seg" role="tablist">
            <button type="button" role="tab" aria-selected={only === 'mo'} className={only === 'mo' ? 'on' : ''} onClick={() => setOnly('mo')}>Đang mở</button>
            <button type="button" role="tab" aria-selected={only === 'all'} className={only === 'all' ? 'on' : ''} onClick={() => setOnly('all')}>Tất cả</button>
          </div>
        </div>
        {shown.length === 0 ? <p className="muted">Chưa có sự cố.</p> : (
          <ul className="list">
            {shown.map((t) => (
              <li key={t.id}>
                <button type="button" className={`support-item ${t.status}`} onClick={() => setOpen(t)}>
                  <b>#{t.no}</b>
                  <span className="support-sum">{t.summary}</span>
                  <small className="muted">
                    {!mine(t) && (t.reporter_name ?? t.reporter_phone ?? 'Không rõ người gửi')}
                    {!mine(t) && t.channel === 'login' && ' · màn hình đăng nhập'}
                    {!mine(t) && ' · '}{when(t.updated_at)} · {t.status === 'mo' ? 'Đang mở' : 'Đã đóng'}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {open && <Thread t={open} me={me} canHandle={canHandle} onClose={() => { setOpen(null); void load(); }} />}
    </section>
  );
}

function Thread({ t, me, canHandle, onClose }: { t: Ticket; me: string | null; canHandle: boolean; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [status, setStatus] = useState(t.status);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const [m, s] = await Promise.all([
      supabase.from('support_messages').select('id, sender, user_id, body, created_at').eq('ticket_id', t.id).order('created_at'),
      supabase.from('support_tickets').select('status').eq('id', t.id).maybeSingle(),
    ]);
    if (m.error) setErr(m.error.message); else setMsgs((m.data ?? []) as Msg[]);
    if (s.data) setStatus((s.data as { status: 'mo' | 'dong' }).status);
  }, [t.id]);
  useEffect(() => { void load(); const iv = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(iv); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  const reply = () => act(async () => { await rpc('support_reply', { p_ticket: t.id, p_text: text.trim() }); setText(''); });
  const setSt = (s: 'mo' | 'dong') => act(() => rpc('support_set_status', { p_ticket: t.id, p_status: s }));
  const c = t.context ?? {};

  return (
    <Modal title={`Sự cố #${t.no}`} onClose={onClose}>
      {canHandle && t.created_by !== me && (
        <div className="support-info small">
          <div><b>Người gửi:</b> {t.reporter_name ?? 'Không rõ'}{t.reporter_phone && ` · ${t.reporter_phone}`}{t.channel === 'login' && ' · màn hình đăng nhập, chưa xác minh'}</div>
          {c.screen && <div><b>Màn hình:</b> {c.screen}</div>}
          {c.online === false && <div><b>Mạng:</b> máy đang mất mạng khi gửi</div>}
          {c.errors && c.errors.length > 0 && (
            <details><summary>Lỗi gần nhất trên máy ({c.errors.length})</summary><ul>{c.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
          )}
          {c.ua && <details><summary>Thiết bị</summary><p className="muted">{c.ua}</p></details>}
        </div>
      )}
      <div className="support-thread">
        {msgs.map((m) => (
          <div key={m.id} className={`bubble ${m.sender === 'bot' ? 'bot' : m.user_id === me ? 'me' : 'them'}`}>
            <p>{m.body}</p>
            <small>{when(m.created_at)}</small>
          </div>
        ))}
        <div ref={end} />
      </div>
      {err && <p className="error-text">{err}</p>}
      <div className="support-reply">
        <textarea rows={2} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder="Nhắn thêm…" />
        <button type="button" className="btn primary" disabled={busy || !text.trim()} onClick={() => void reply()}>Gửi</button>
      </div>
      <div className="row-actions">
        {status === 'mo'
          ? <button type="button" className="btn" disabled={busy} onClick={() => void setSt('dong')}>Đã xong, đóng sự cố</button>
          : <button type="button" className="btn" disabled={busy} onClick={() => void setSt('mo')}>Mở lại</button>}
      </div>
    </Modal>
  );
}
