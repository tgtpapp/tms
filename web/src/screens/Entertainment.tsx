// Giải trí YouTube: (1) tìm & xem ngay trong app; (2) danh sách phát trên xe cho khách (văn phòng chọn sẵn, phát toàn màn hình, lặp lại).
// Tìm kiếm qua Edge Function "youtube" (khóa API ở máy chủ). Danh sách phát lưu trong cấu hình nhà xe (giai_tri.ds).
import { useEffect, useRef, useState } from 'react';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Vid { id: string; title: string; channel?: string; thumb?: string }
const KEY = 'giai_tri.ds';
const thumbOf = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const embed = (id: string, q: Record<string, string>) => `https://www.youtube-nocookie.com/embed/${id}?${new URLSearchParams({ rel: '0', modestbranding: '1', playsinline: '1', ...q })}`;
/** Lấy mã video từ link YouTube (watch?v=, youtu.be/, shorts/, embed/) */
export function ytId(s: string): string | null {
  const t = s.trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  const m = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/.exec(t);
  return m ? m[1]! : null;
}

export function EntertainmentScreen({ canEdit }: { canEdit: boolean }) {
  const toast = useToast();
  const [mode, setMode] = useState<'xem' | 'xe'>('xem');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Vid[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [play, setPlay] = useState<Vid | null>(null);
  const [list, setList] = useState<Vid[]>([]);
  const [show, setShow] = useState(false);
  const stage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void supabase.from('tenant_settings').select('value').eq('key', KEY).maybeSingle()
      .then((r) => setList(Array.isArray(r.data?.value) ? (r.data!.value as Vid[]).filter((x) => x && /^[\w-]{11}$/.test(x.id)) : []));
  }, []);

  async function search(page?: string) {
    const id = ytId(q);
    if (id) { setPlay({ id, title: q.trim() }); return; }
    if (!q.trim()) return;
    setBusy(true); setNote('');
    try {
      const { data, error } = await supabase.functions.invoke('youtube', { body: { q, page: page ?? '' } });
      const d = data as { items?: Vid[]; next?: string | null; error?: string; no_key?: boolean } | null;
      if (error || !d?.items) {
        let m = d?.error ?? '';
        try { m = m || ((await (error as { context?: Response })?.context?.json()) as { error?: string })?.error || ''; } catch { /* bỏ qua */ }
        setNote(m || errMsg(error)); if (!page) setHits([]); return;
      }
      setHits((h) => (page ? [...(h ?? []), ...d.items!] : d.items!)); setNext(d.next ?? null);
    } catch (e) { setNote(errMsg(e)); } finally { setBusy(false); }
  }
  async function saveList(l: Vid[], msg: string) {
    const { error } = await supabase.from('tenant_settings').upsert([{ key: KEY, value: l.map(({ id, title }) => ({ id, title })) }], { onConflict: 'tenant_id,key' });
    if (error) { toast('error', error.message); return; }
    setList(l); toast('ok', msg);
  }
  const add = (v: Vid) => (list.some((x) => x.id === v.id) ? toast('ok', 'Video đã có trong danh sách') : void saveList([...list, { id: v.id, title: v.title }], 'Đã thêm vào danh sách phát trên xe'));
  const move = (i: number, d: number) => { const l = [...list]; const j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j]!, l[i]!]; void saveList(l, 'Đã đổi thứ tự'); };
  async function startShow() {
    if (!list.length) return;
    setShow(true);
    setTimeout(() => { void stage.current?.requestFullscreen?.().catch(() => undefined); }, 50);
  }

  return (
    <section className="card gt">
      <div className="gt-bar">
        <h2>Giải trí</h2>
        <div className="seg" role="group" aria-label="Chế độ">
          <button type="button" className={mode === 'xem' ? 'on' : ''} aria-pressed={mode === 'xem'} onClick={() => setMode('xem')}>Tìm & xem</button>
          <button type="button" className={mode === 'xe' ? 'on' : ''} aria-pressed={mode === 'xe'} onClick={() => setMode('xe')}>Phát trên xe ({list.length})</button>
        </div>
      </div>

      {mode === 'xem' && <>
        <form className="gt-search" onSubmit={(e) => { e.preventDefault(); void search(); }}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm video YouTube hoặc dán link video…" aria-label="Tìm video YouTube" />
          <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Đang tìm…' : 'Tìm'}</button>
        </form>
        {note && <p className="small state-sap_het">{note}</p>}
        {play && (
          <div className="gt-player">
            <iframe src={embed(play.id, { autoplay: '1' })} title={play.title} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen />
            <div className="gt-ph"><b>{play.title}</b>
              <span className="actions">{canEdit && <button type="button" className="btn small" onClick={() => add(play)}>+ Thêm vào phát trên xe</button>}
                <button type="button" className="btn small" onClick={() => setPlay(null)}>Đóng</button></span></div>
          </div>
        )}
        {hits && hits.length === 0 && !note && <p className="muted">Không có</p>}
        <div className="gt-grid">
          {(hits ?? []).map((v) => (
            <div key={v.id} className="gt-item">
              <button type="button" className="gt-th" onClick={() => { setPlay(v); window.scrollTo({ top: 0, behavior: 'smooth' }); }} aria-label={`Xem ${v.title}`}>
                <img src={v.thumb || thumbOf(v.id)} alt="" loading="lazy" /><span className="gt-pl">▶</span>
              </button>
              <b className="gt-t">{v.title}</b><span className="small muted">{v.channel}</span>
              {canEdit && <button type="button" className="btn small" onClick={() => add(v)}>+ Phát trên xe</button>}
            </div>
          ))}
        </div>
        {next && hits && hits.length > 0 && <div className="actions"><button type="button" className="btn small" disabled={busy} onClick={() => void search(next)}>Xem thêm</button></div>}
      </>}

      {mode === 'xe' && <>
        <div className="actions">
          <button type="button" className="btn primary" disabled={!list.length} onClick={() => void startShow()}>▶ Phát toàn màn hình (lặp lại)</button>
        </div>
        {!list.length && <p className="muted">Chưa có video. {canEdit ? 'Vào Tìm & xem, bấm "+ Phát trên xe" để thêm.' : ''}</p>}
        <ol className="gt-list">
          {list.map((v, i) => (
            <li key={v.id}>
              <img src={thumbOf(v.id)} alt="" loading="lazy" /><span className="gt-t">{v.title}</span>
              {canEdit && <span className="actions">
                <button type="button" className="btn small" aria-label="Lên" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn small" aria-label="Xuống" disabled={i === list.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="btn small link danger-text" onClick={() => void saveList(list.filter((x) => x.id !== v.id), 'Đã bỏ khỏi danh sách')}>Bỏ</button>
              </span>}
            </li>
          ))}
        </ol>
      </>}

      {show && list.length > 0 && (
        <div className="gt-show" ref={stage}>
          <iframe src={embed(list[0]!.id, { autoplay: '1', loop: '1', playlist: list.map((x) => x.id).join(','), controls: '1' })} title="Phát trên xe"
                  allow="autoplay; encrypted-media; fullscreen" allowFullScreen />
          <button type="button" className="gt-x" onClick={() => { setShow(false); if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); }}>✕ Thoát</button>
        </div>
      )}
    </section>
  );
}
