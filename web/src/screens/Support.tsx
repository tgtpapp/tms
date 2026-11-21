// Báo sự cố: người dùng nhắn sự cố (gửi kèm thông tin máy + lỗi gần nhất); người quản lý tài khoản của nhà xe xem và trả lời.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../components/Modal';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { clearAppCacheAndReload, clientChecks, guessScreen, supportContext } from '../lib/support';

interface Ticket {
  id: string; no: number; channel: 'app' | 'login'; status: 'mo' | 'dong'; created_by: string | null;
  reporter_name: string | null; reporter_phone: string | null; summary: string;
  context: {
    screen?: string; path?: string; ua?: string; online?: boolean; new_version?: boolean; session?: 'ok' | 'loi'; errors?: string[]; need?: string[];
    checks?: { tai_khoan?: string; user_id?: string; quyen?: { code: string; name: string; ok: boolean; chan: boolean }[] };
  };
  created_at: string; updated_at: string;
}
interface Msg { id: string; sender: 'nguoi_bao' | 'xu_ly' | 'bot'; user_id: string | null; body: string; created_at: string }

const COLS = 'id, no, channel, status, created_by, reporter_name, reporter_phone, summary, context, created_at, updated_at';
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false });

export function SupportScreen({ me, canHandle, lastKey, prefill, onPrefillUsed }: {
  me: string | null; canHandle: boolean; lastKey?: string; prefill?: string; onPrefillUsed?: () => void;
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
      // kiểm tra trên máy + đoán màn hình người dùng nói tới; quyền do máy chủ tự đối chiếu
      const g = guessScreen(text, lastKey);
      const cc = await clientChecks();
      const id = await rpc<string>('support_open', { p_text: text.trim(), p_context: { ...supportContext(g?.label), ...cc, need: g ? [g.perm] : [] } });
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

function Thread({ t: t0, me, canHandle, onClose }: { t: Ticket; me: string | null; canHandle: boolean; onClose: () => void }) {
  const [t, setT] = useState(t0);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const status = t.status;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    const [m, s] = await Promise.all([
      supabase.from('support_messages').select('id, sender, user_id, body, created_at').eq('ticket_id', t.id).order('created_at'),
      supabase.from('support_tickets').select(COLS).eq('id', t0.id).maybeSingle(),
    ]);
    if (m.error) setErr(m.error.message); else setMsgs((m.data ?? []) as Msg[]);
    if (s.data) setT(s.data as Ticket);
  }, [t0.id]);
  useEffect(() => { void load(); const iv = window.setInterval(() => void load(), 10_000); return () => window.clearInterval(iv); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [msgs.length]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  }
  const reply = () => act(async () => { await rpc('support_reply', { p_ticket: t.id, p_text: text.trim() }); setText(''); });
  const setSt = (s: 'mo' | 'dong') => act(() => rpc('support_set_status', { p_ticket: t.id, p_status: s }));
  const c = t.context ?? {};
  const fix = (action: 'cap_quyen' | 'mo_khoa', perm?: string) => act(() => rpc('support_fix', { p_ticket: t.id, p_action: action, p_perm: perm ?? null }));

  return (
    <Modal title={`Sự cố #${t.no}`} onClose={onClose}>
      {canHandle && t.created_by !== me && (
        <div className="support-info small">
          <div><b>Người gửi:</b> {t.reporter_name ?? 'Không rõ'}{t.reporter_phone && ` · ${t.reporter_phone}`}{t.channel === 'login' && ' · màn hình đăng nhập, chưa xác minh'}</div>
          {c.screen && <div><b>Màn hình:</b> {c.screen}</div>}
          {c.errors && c.errors.length > 0 && (
            <details><summary>Lỗi gần nhất trên máy ({c.errors.length})</summary><ul>{c.errors.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
          )}
          {c.ua && <details><summary>Thiết bị</summary><p className="muted">{c.ua}</p></details>}
        </div>
      )}
      <Checks t={t} mine={t.created_by === me} canHandle={canHandle} busy={busy} onFix={(a, p) => void fix(a, p)} />
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

/** Kết quả kiểm tra tự động + nút xử lý (máy người gửi: tải bản mới, đăng nhập lại, xóa bộ nhớ tạm; người quản lý: cấp quyền, mở khóa) */
function Checks({ t, mine, canHandle, busy, onFix }: {
  t: Ticket; mine: boolean; canHandle: boolean; busy: boolean; onFix: (a: 'cap_quyen' | 'mo_khoa', perm?: string) => void;
}) {
  const c = t.context ?? {}, k = c.checks ?? {};
  const lines: { ok: boolean; text: string; btn?: { label: string; run: () => void } }[] = [];
  const manage = canHandle && !mine;
  if (k.tai_khoan === 'locked') lines.push({ ok: false, text: 'Tài khoản đang bị khóa', btn: manage && k.user_id ? { label: 'Mở khóa', run: () => onFix('mo_khoa') } : undefined });
  else if (k.tai_khoan === 'khong_co') lines.push({ ok: false, text: 'Số điện thoại chưa có tài khoản trong nhà xe' });
  else if (k.tai_khoan === 'active') lines.push({ ok: true, text: 'Tài khoản đang hoạt động' });
  for (const q of k.quyen ?? []) {
    lines.push(q.ok ? { ok: true, text: `Có quyền ${q.name}` } : {
      ok: false, text: `Chưa có quyền ${q.name}${q.chan ? ' (bị chặn riêng)' : ''}`,
      btn: manage && t.created_by ? { label: 'Cấp quyền', run: () => onFix('cap_quyen', q.code) } : undefined,
    });
  }
  if (c.online === false) lines.push({ ok: false, text: 'Máy mất mạng khi gửi' });
  if (c.new_version === true) lines.push({ ok: false, text: 'Máy đang chạy bản app cũ', btn: mine ? { label: 'Tải bản mới', run: () => window.location.reload() } : undefined });
  if (c.session === 'loi') lines.push({ ok: false, text: 'Phiên đăng nhập bị lỗi', btn: mine ? { label: 'Đăng nhập lại', run: () => void supabase.auth.signOut() } : undefined });
  if (c.errors?.length) lines.push({ ok: false, text: `Có ${c.errors.length} lỗi gần đây trên máy`, btn: mine ? { label: 'Xóa bộ nhớ tạm, tải lại', run: () => void clearAppCacheAndReload() } : undefined });
  if (!lines.length) return null;
  return (
    <ul className="support-checks">
      {lines.map((l, i) => (
        <li key={i} className={l.ok ? 'ok' : 'bad'}>
          <span aria-hidden="true">{l.ok ? '✓' : '✗'}</span>
          <span>{l.text}</span>
          {l.btn && <button type="button" className="btn small primary" disabled={busy} onClick={l.btn.run}>{l.btn.label}</button>}
        </li>
      ))}
    </ul>
  );
}
