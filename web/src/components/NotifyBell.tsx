// Thông báo của từng người: chuông (số chưa đọc) → danh sách có lọc, tìm; bấm 1 tin xem chi tiết (ghi giờ mở), nút "Đã nhận" khi tin yêu cầu xác nhận.
// Trạng thái tách riêng: đã đọc (thấy trong danh sách) · đã mở (xem chi tiết) · đã xác nhận.
import { useCallback, useEffect, useRef, useState } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { meter } from '../lib/egress';

export interface Note {
  id: string; kind: string; title: string; body: string; priority: 'thuong' | 'quan_trong' | 'khan_cap'; ack_required: boolean;
  created_at: string; read_at: string | null; opened_at: string | null; acked_at: string | null;
}
const COLS = 'id, kind, title, body, priority, ack_required, created_at, read_at, opened_at, acked_at';
const KIND: Record<string, string> = { khach: 'Khách', xep_chuyen: 'Chuyến', lai_xe_bao: 'Lái xe báo', su_co: 'Sự cố' };
const PRI: Record<string, string> = { quan_trong: 'Quan trọng', khan_cap: 'Khẩn cấp' };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false }) : '—');
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();

/** Danh sách thông báo 7 ngày gần nhất, dùng chung cho mọi chỗ hiện (chuông, băng nhắc) – chỉ 1 lần tải.
 *  Mỗi 30 giây chỉ hỏi tin mới; tải đủ danh sách khi quay lại app, khi có tín hiệu thông báo và mỗi 5 phút. */
type Sub = (l: Note[]) => void;
const store: { list: Note[]; subs: Set<Sub>; timer: number | null; lastFull: number; busy: boolean; again: boolean } = { list: [], subs: new Set(), timer: null, lastFull: 0, busy: false, again: false };
const emit = () => store.subs.forEach((f) => f(store.list));
async function fetchNotes(full: boolean) {
  if (store.busy) { if (full) store.again = true; return; }
  store.busy = true;
  try {
    const since = Date.now() - 7 * 86400e3;
    const newest = store.list[0]?.created_at;
    if (full || !newest || Date.now() - store.lastFull > 5 * 60_000) {
      const r = await supabase.from('notifications').select(COLS).gte('created_at', new Date(since).toISOString())
        .order('created_at', { ascending: false }).limit(100);
      meter('Thông báo: tải đủ', r.data);
      if (r.error) return;
      store.list = (r.data ?? []) as Note[];
      store.lastFull = Date.now();
    } else {
      // lùi 2 phút để không sót tin ghi cùng lúc; trùng thì gộp theo mã
      const from = new Date(new Date(newest).getTime() - 120_000).toISOString();
      const r = await supabase.from('notifications').select(COLS).gte('created_at', from).order('created_at', { ascending: false }).limit(100);
      meter('Thông báo: hỏi tin mới', r.data);
      if (r.error) return;
      const got = (r.data ?? []) as Note[];
      const known = new Set(store.list.map((x) => x.id));
      const fresh = got.filter((x) => !known.has(x.id));
      if (!fresh.length) return;
      store.list = [...fresh, ...store.list].sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(0, 100);
    }
    emit();
  } finally {
    store.busy = false;
    if (store.again) { store.again = false; void fetchNotes(true); }
  }
}
const onVis = () => { if (!document.hidden) void fetchNotes(true); };
function subscribe(f: Sub) {
  store.subs.add(f);
  if (store.subs.size === 1) {
    void fetchNotes(true);
    store.timer = window.setInterval(() => { if (!document.hidden) void fetchNotes(false); }, 30_000);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('tms-thong-bao', onVis);
  } else f(store.list);
  return () => {
    store.subs.delete(f);
    if (!store.subs.size) {
      if (store.timer) window.clearInterval(store.timer);
      store.timer = null;
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('tms-thong-bao', onVis);
      store.list = []; store.lastFull = 0;
    }
  };
}
export function useNotes() {
  const [list, setLocal] = useState<Note[]>(store.list);
  useEffect(() => subscribe(setLocal), []);
  const setList = useCallback((v: Note[] | ((l: Note[]) => Note[])) => {
    store.list = typeof v === 'function' ? v(store.list) : v;
    emit();
  }, []);
  const load = useCallback(() => fetchNotes(true), []);
  return { list, setList, load };
}
const reloadAll = () => window.dispatchEvent(new Event('tms-thong-bao'));

export function NotifyBell({ inline = false, openKey = 0 }: { inline?: boolean; openKey?: number }) {
  const toast = useToast();
  const { list, setList } = useNotes();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<'' | 'can_xn' | string>('');
  const [q, setQ] = useState('');
  const [cur, setCur] = useState<Note | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const msg = (e: MessageEvent) => { if ((e.data as { type?: string })?.type === 'mo-thong-bao') { reloadAll(); setOpen(true); } };
    navigator.serviceWorker?.addEventListener('message', msg);
    if (new URLSearchParams(location.search).get('thong-bao') === '1') setOpen(true);
    return () => navigator.serviceWorker?.removeEventListener('message', msg);
  }, []);
  useEffect(() => { if (openKey) setOpen(true); }, [openKey]);
  useEffect(() => {
    if (!open) return;
    const out = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) { setOpen(false); setCur(null); } };
    document.addEventListener('pointerdown', out);
    return () => document.removeEventListener('pointerdown', out);
  }, [open]);
  const unread = list.filter((x) => !x.read_at).length;
  // mở danh sách = đã đọc (đã thấy); chưa phải đã mở / đã xác nhận
  useEffect(() => {
    if (!open || !unread) return;
    void rpc('mark_notifications_read', {}).then(() => setTimeout(() => setList((l) => l.map((x) => (x.read_at ? x : { ...x, read_at: new Date().toISOString() }))), 3000)).catch(() => undefined);
  }, [open, unread, setList]);
  async function show(n: Note) {
    setCur(n);
    if (!n.opened_at) {
      await rpc('open_notification', { p_id: n.id }).catch(() => undefined);
      const t = new Date().toISOString();
      setList((l) => l.map((x) => (x.id === n.id ? { ...x, opened_at: t, read_at: x.read_at ?? t } : x)));
    }
  }
  async function ack(n: Note) {
    try {
      await rpc('ack_notification', { p_id: n.id });
      const t = new Date().toISOString();
      setList((l) => l.map((x) => (x.id === n.id ? { ...x, acked_at: t, opened_at: x.opened_at ?? t, read_at: x.read_at ?? t } : x)));
      setCur((c) => (c ? { ...c, acked_at: t } : c));
      toast('ok', 'Đã xác nhận đã nhận');
      reloadAll();
    } catch (e) { toast('error', errMsg(e)); }
  }
  const needAck = list.filter((x) => x.ack_required && !x.acked_at).length;
  const shown = list.filter((x) => (!f || (f === 'can_xn' ? x.ack_required && !x.acked_at : x.kind === f)) && (!q.trim() || norm(`${x.title} ${x.body}`).includes(norm(q.trim()))));
  const kinds = [...new Set(list.map((x) => x.kind))];
  return (
    <div className={inline ? 'nb nb-inline' : 'nb'} ref={box}>
      <button type="button" className={unread ? 'nb-btn has' : 'nb-btn'} aria-label={`Thông báo${unread ? `: ${unread} chưa đọc` : ''}`} aria-expanded={open}
              onClick={() => { setOpen(!open); setCur(null); }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {unread > 0 && <span className="nb-n">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="nb-pop" role="dialog" aria-label="Thông báo">
          {cur ? (
            <div className="nb-detail">
              <div className="nb-head"><button type="button" className="btn small link" onClick={() => setCur(null)}>‹ Danh sách</button>
                <button type="button" className="btn small link" onClick={() => { setOpen(false); setCur(null); }}>Đóng</button></div>
              <div className={`nb-d-body pri-${cur.priority}`}>
                {cur.priority !== 'thuong' && <span className={cur.priority === 'khan_cap' ? 'badge locked' : 'badge warn-badge'}>{PRI[cur.priority]}</span>}
                <h3>{cur.title}</h3>
                <p>{cur.body}</p>
                <dl className="info small">
                  <dt>Gửi lúc</dt><dd>{when(cur.created_at)}</dd>
                  <dt>Đã mở</dt><dd>{when(cur.opened_at)}</dd>
                  {cur.ack_required && <><dt>Đã xác nhận</dt><dd>{when(cur.acked_at)}</dd></>}
                </dl>
                {cur.ack_required && !cur.acked_at && <button type="button" className="btn primary nb-ack" onClick={() => void ack(cur)}>✓ Đã nhận</button>}
              </div>
            </div>
          ) : (
            <>
              <div className="nb-head"><b>Thông báo</b><button type="button" className="btn small link" onClick={() => setOpen(false)}>Đóng</button></div>
              <div className="nb-tools">
                <div className="nb-chips" role="tablist" aria-label="Lọc thông báo">
                  {[['', 'Tất cả'], ...(needAck ? [['can_xn', `Cần xác nhận (${needAck})`]] : []), ...kinds.map((k) => [k, KIND[k] ?? k])].map(([k, l]) => (
                    <button key={k} type="button" role="tab" aria-selected={f === k} className={f === k ? 'on' : ''} onClick={() => setF(k!)}>{l}</button>
                  ))}
                </div>
                <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm số điện thoại, giờ chuyến…" aria-label="Tìm thông báo" />
              </div>
              {shown.length === 0 ? <p className="muted small nb-empty">{list.length ? 'Không có thông báo phù hợp.' : 'Chưa có thông báo trong 7 ngày qua.'}</p> : (
                <ul className="nb-list">
                  {shown.map((n) => (
                    <li key={n.id}>
                      <button type="button" className={[!n.read_at && 'new', n.read_at && !n.opened_at && 'seen', `pri-${n.priority}`].filter(Boolean).join(' ')} onClick={() => void show(n)}>
                        <b>{n.priority !== 'thuong' && <span className={n.priority === 'khan_cap' ? 'badge locked' : 'badge warn-badge'}>{PRI[n.priority]}</span>}{n.title}</b>
                        <span>{n.body}</span>
                        <small>{when(n.created_at)}{n.ack_required ? (n.acked_at ? ' · ✓ đã xác nhận' : ' · cần xác nhận') : ''}</small>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Băng nhắc trong Việc của tôi: tin khẩn cấp / cần xác nhận. Đang chạy chuyến thì chỉ nhắc nhẹ, không bắt thao tác. */
export function NotifyBanner({ running, onOpen }: { running: boolean; onOpen: () => void }) {
  const { list } = useNotes();
  const urgent = list.filter((x) => x.priority === 'khan_cap' && !x.acked_at && !x.opened_at);
  const need = list.filter((x) => x.ack_required && !x.acked_at).length;
  if (!urgent.length && !need) return null;
  if (running) return <p className="nb-banner calm">Bạn có {urgent.length + need} thông báo. Đang chạy chuyến: dừng xe an toàn rồi hãy xem.</p>;
  return (
    <div className={urgent.length ? 'nb-banner urgent' : 'nb-banner'}>
      {urgent.length ? <span><b>Khẩn cấp:</b> {urgent[0]!.title}{urgent.length > 1 ? ` (+${urgent.length - 1})` : ''}</span> : <span>Có <b>{need}</b> thông báo cần xác nhận đã nhận</span>}
      <button type="button" className="btn small" onClick={onOpen}>Xem</button>
    </div>
  );
}
