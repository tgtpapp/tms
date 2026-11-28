// Đăng bài lên trang (fanpage) Facebook của nhà xe + danh sách bài đã đăng.
import { useCallback, useEffect, useState } from 'react';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';
import { facebookPublish, facebookStatus, type FacebookStatus } from '../lib/facebook';

const t = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false });

export function FacebookSettings() {
  const toast = useToast();
  const [st, setSt] = useState<FacebookStatus | null>(null);
  const [message, setMessage] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSt(await facebookStatus());
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  async function publish() {
    const msg = message.trim();
    if (!msg) return toast('error', 'Nhập nội dung bài đăng');
    const l = link.trim();
    if (l && !l.startsWith('https://')) return toast('error', 'Link kèm bài phải là địa chỉ https://…');
    setBusy(true);
    try {
      const r = await facebookPublish(msg, l || undefined, crypto.randomUUID());
      toast('ok', r.duplicate ? 'Bài này đã đăng trước đó' : 'Đã đăng bài lên Facebook');
      setMessage('');
      setLink('');
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card form">
      <h2>Facebook</h2>
      {!st && <p className="muted">Đang tải…</p>}
      {st && !st.configured && <p className="muted small">Nền tảng chưa cấu hình trang Facebook (FACEBOOK_PAGE_ID, FACEBOOK_PAGE_ACCESS_TOKEN trên Supabase).</p>}
      {st?.configured && (<>
        <p>Đăng bài lên trang <b>{st.page_name || 'Facebook của nhà xe'}</b>.</p>
        <label>Nội dung bài đăng
          <textarea rows={4} maxLength={5000} value={message} onChange={(e) => setMessage(e.target.value)}
                    placeholder="vd: Khai trương tuyến mới từ 01/12, đặt vé tại…" />
        </label>
        <label>Link kèm bài (tùy chọn)
          <input type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
        </label>
        <div className="actions">
          <button className="btn primary" disabled={busy} onClick={() => void publish()}>Đăng bài lên Facebook</button>
        </div>

        <h3>Bài đã đăng</h3>
        {st.posts.length === 0 && <p className="muted">Chưa có bài.</p>}
        <ul className="list">
          {st.posts.map((p) => (
            <li key={p.post_id ?? p.created_at} className="item small">
              {t(p.created_at)} · {p.message ? (p.message.length > 80 ? `${p.message.slice(0, 80)}…` : p.message) : 'Bài đăng'}
              {p.url && <> · <a href={p.url} target="_blank" rel="noopener noreferrer">Mở bài</a></>}
            </li>
          ))}
        </ul>
      </>)}
    </section>
  );
}