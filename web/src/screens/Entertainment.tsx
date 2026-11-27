// Giải trí YouTube: (1) tìm & xem ngay trong app; (2) danh sách phát trên xe cho khách (văn phòng chọn sẵn, phát toàn màn hình, lặp lại).
// Tìm kiếm qua Edge Function "youtube" (khóa API ở máy chủ). Danh sách phát lưu trong cấu hình nhà xe (giai_tri.ds).
import { useEffect, useRef, useState } from 'react';
import { errMsg, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

interface Vid { id: string; title: string; channel?: string; thumb?: string }
const KEY = 'giai_tri.ds';
/** Chủ đề nhạc gợi ý: bấm là tìm ngay */
const TOPICS: { nhom: string; ds: string[] }[] = [
  { nhom: 'Việt Nam', ds: ['Nhạc trẻ hay nhất', 'Bolero trữ tình', 'Nhạc Trịnh Công Sơn', 'Nhạc vàng xưa', 'Nhạc quê hương', 'Nhạc cách mạng', 'Nhạc không lời Việt Nam', 'Nhạc Tết', 'Nhạc thiếu nhi', 'Lofi Việt chill'] },
  { nhom: 'Anh Quốc', ds: ['UK top hits', 'The Beatles', 'Adele', 'Ed Sheeran', 'Coldplay', 'Queen', 'Elton John', 'Dua Lipa', 'British rock classics', 'UK chill acoustic'] },
];
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

  // Đang phát thì giữ màn hình luôn sáng (máy hỗ trợ Wake Lock); quay lại app thì xin lại, dừng phát thì trả.
  const playing = !!play || show;
  useEffect(() => {
    if (!playing) return;
    type Lock = { release: () => Promise<void> };
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<Lock> } }).wakeLock;
    if (!wl) return;
    let lock: Lock | null = null;
    let off = false;
    const grab = () => {
      if (off || document.visibilityState !== 'visible') return;
      void wl.request('screen').then((l) => { if (off) void l.release().catch(() => undefined); else lock = l; }).catch(() => undefined);
    };
    grab();
    document.addEventListener('visibilitychange', grab);
    return () => { off = true; document.removeEventListener('visibilitychange', grab); void lock?.release().catch(() => undefined); };
  }, [playing]);

  useEffect(() => {
    void supabase.from('tenant_settings').select('value').eq('key', KEY).maybeSingle()
      .then((r) => setList(Array.isArray(r.data?.value) ? (r.data!.value as Vid[]).filter((x) => x && /^[\w-]{11}$/.test(x.id)) : []));
  }, []);

  // Lưu tạm kết quả tìm kiếm 12 tiếng trên máy: tìm lại cùng từ khóa không tốn lượt API YouTube.
  const CACHE = 'tms.yt.tim';
  const TTL = 12 * 3600 * 1000;
  const ckey = (qq: string, page?: string) => `${qq.trim().toLowerCase()}|${page ?? ''}`;
  function readCache(k: string): { items: Vid[]; next: string | null } | null {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE) ?? '{}') as Record<string, { t: number; items: Vid[]; next: string | null }>;
      const e = all[k];
      return e && Date.now() - e.t < TTL ? e : null;
    } catch { return null; }
  }
  function writeCache(k: string, items: Vid[], next: string | null) {
    try {
      const all = JSON.parse(localStorage.getItem(CACHE) ?? '{}') as Record<string, { t: number; items: Vid[]; next: string | null }>;
      const now = Date.now();
      for (const [x, e] of Object.entries(all)) if (now - e.t >= TTL) delete all[x];
      all[k] = { t: now, items, next };
      const keys = Object.keys(all).sort((a, b) => all[b]!.t - all[a]!.t);
      for (const x of keys.slice(60)) delete all[x];
      localStorage.setItem(CACHE, JSON.stringify(all));
    } catch { /* máy không cho lưu thì thôi */ }
  }

  async function search(page?: string, term?: string) {
    const qq = term ?? q;
    const id = ytId(qq);
    if (id) { setPlay({ id, title: qq.trim() }); return; }
    if (!qq.trim()) return;
    setNote('');
    const k = ckey(qq, page);
    const c = readCache(k);
    if (c) { setHits((h) => (page ? [...(h ?? []), ...c.items] : c.items)); setNext(c.next); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('youtube', { body: { q: qq, page: page ?? '' } });
      const d = data as { items?: Vid[]; next?: string | null; error?: string; no_key?: boolean } | null;
      if (error || !d?.items) {
        let m = d?.error ?? '';
        try { m = m || ((await (error as { context?: Response })?.context?.json()) as { error?: string })?.error || ''; } catch { /* bỏ qua */ }
        setNote(m || errMsg(error)); if (!page) setHits([]); return;
      }
      writeCache(k, d.items, d.next ?? null);
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
        {!hits && !play && (
          <div className="gt-topics">
            {TOPICS.map((g) => (
              <div key={g.nhom}><b>{g.nhom}</b>
                <div className="gt-chips">{g.ds.map((t) => <button key={t} type="button" className="gt-chip" onClick={() => { setQ(t); void search(undefined, t); }}>{t}</button>)}</div>
              </div>
            ))}
          </div>
        )}
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
