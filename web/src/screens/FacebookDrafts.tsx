// Bài chờ duyệt Facebook của nhà xe (dành cho người quản trị nhà xe): danh sách bài nháp
// + Sửa + Duyệt đăng (đăng lên trang của nhà xe, kèm ảnh) + Bỏ. Mỗi nhà xe chỉ thấy bài của mình
// (database tự lọc theo nhà xe của người đăng nhập, không theo tham số máy khách).
// Soạn bài bằng AI và tự đăng theo giờ hẹn: CHƯA làm (giờ hẹn chỉ lưu trong bài, chưa nhận từ giao diện).
import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../components/Modal';
import { prepareFile } from '../lib/documents';
import { delFile, getBlob, putFile } from '../lib/fileStore';
import {
  DRAFT_STATUS, discardFacebookDraft, facebookDraftPublish, facebookDrafts, saveFacebookDraft,
  type FacebookDraft, type FacebookDraftStatus,
} from '../lib/facebook';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';

const t = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', hour12: false }) : '';
const cut = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n)}…` : s);
const FILTERS: [FacebookDraftStatus | 'all', string][] = [['all', 'Tất cả'], ['cho_duyet', 'Chờ duyệt'], ['da_duyet', 'Đã duyệt'], ['da_dang', 'Đã đăng'], ['da_bo', 'Đã bỏ']];

/** Ảnh chờ tải lên trong lần lưu này (chưa có tên tệp trong kho). */
interface Pending { url: string; blob: Blob; mime: string; ext: string }

export function FacebookDraftsScreen({ tenantId }: { tenantId: string }) {
  const toast = useToast();
  const [drafts, setDrafts] = useState<FacebookDraft[] | null>(null);
  const [filter, setFilter] = useState<FacebookDraftStatus | 'all'>('all');
  const [edit, setEdit] = useState<{ id: string; content: string; link: string; photos: string[]; removed: string[] } | null>(null);
  const [adding, setAdding] = useState<Pending[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDrafts(await facebookDrafts());
    } catch (e) {
      toast('error', errMsg(e));
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  // Ảnh đã lưu của bài đang sửa: tải nội dung lên máy rồi hiện
  useEffect(() => {
    if (!edit) return;
    let stop = false;
    const missing = edit.photos.filter((p) => !thumbs[p]);
    if (!missing.length) return;
    void Promise.all(missing.map(async (p) => {
      const b = await getBlob(p).catch(() => null);
      return b ? [p, URL.createObjectURL(b)] as const : null;
    })).then((rs) => {
      if (stop) { rs.forEach((r) => r && URL.revokeObjectURL(r[1])); return; }
      setThumbs((cur) => ({ ...cur, ...Object.fromEntries(rs.filter(Boolean) as [string, string][]) }));
    });
    return () => { stop = true; };
  }, [edit, thumbs]);

  function openEdit(d?: FacebookDraft) {
    setAdding([]);
    setEdit(d
      ? { id: d.id, content: d.content, link: d.link ?? '', photos: [...d.photos], removed: [] }
      : { id: crypto.randomUUID(), content: '', link: '', photos: [], removed: [] });
  }

  async function takePhotos(files: FileList | null) {
    if (!files?.length) return;
    const next: Pending[] = [];
    for (const f of Array.from(files).slice(0, 10 - (edit?.photos.length ?? 0) - adding.length)) {
      try {
        const p = await prepareFile(f);
        next.push({ url: URL.createObjectURL(p.blob), blob: p.blob, mime: p.mime, ext: p.ext });
      } catch (e) {
        toast('error', `${f.name}: ${errMsg(e)}`);
      }
    }
    setAdding((a) => [...a, ...next]);
  }

  async function saveDraft() {
    if (!edit) return;
    if (!edit.content.trim()) return toast('error', 'Nhập nội dung bài đăng');
    if (edit.photos.length + adding.length > 10) return toast('error', 'Tối đa 10 ảnh mỗi bài');
    const link = edit.link.trim();
    if (link && !/^https:\/\/[A-Za-z0-9]/.test(link)) return toast('error', 'Link kèm bài phải là địa chỉ https://…');
    setBusy(true);
    try {
      // Ảnh mới tải lên trước (vào thư mục ảnh của chính bài), rồi mới lưu bài (hàm tự kiểm ảnh đã có)
      const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const paths: string[] = [];
      for (let i = 0; i < adding.length; i++) {
        const path = `${tenantId}/facebook/${edit.id}/anh_${stamp}_${i + 1}.${adding[i].ext}`;
        await putFile(path, adding[i].blob, adding[i].mime);
        paths.push(path);
      }
      await saveFacebookDraft({ id: edit.id, content: edit.content.trim(), photos: [...edit.photos, ...paths], link: link || null });
      adding.forEach((a) => URL.revokeObjectURL(a.url));
      setAdding([]);
      // Ảnh đã bỏ khỏi bài: dọn khỏi kho tệp (lỗi thì để sau, không chặn việc lưu bài)
      for (const p of edit.removed) await delFile(p).catch(() => undefined);
      toast('ok', 'Đã lưu bài (chờ duyệt)');
      setEdit(null);
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function discard(d: FacebookDraft) {
    if (!window.confirm('Bỏ bài này? (Bài đã bỏ còn trong danh sách để xem lại)')) return;
    setBusy(true);
    try {
      await discardFacebookDraft(d.id);
      toast('ok', 'Đã bỏ bài');
      await load();
    } catch (e) {
      toast('error', errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function publish(d: FacebookDraft) {
    setBusy(true);
    try {
      const r = await facebookDraftPublish(d.id);
      toast('ok', r.duplicate ? 'Bài này đã đăng trước đó' : 'Đã đăng bài lên Facebook');
      await load();
    } catch (e) {
      toast('error', errMsg(e));
      await load();   // bài có thể đã được đánh duyệt (Facebook lỗi giữa chừng): tải lại cho đúng trạng thái
    } finally {
      setBusy(false);
    }
  }

  const rows = (drafts ?? []).filter((d) => filter === 'all' || d.status === filter);

  return (
    <>
      <section className="card">
        <div className="item-head">
          <h2>Bài chờ duyệt Facebook</h2>
          <div className="actions"><button className="btn primary" onClick={() => openEdit()}>+ Soạn bài</button></div>
        </div>
        <div className="inline-form">
          <div className="seg" role="tablist" aria-label="Lọc theo trạng thái">
            {FILTERS.map(([k, l]) =>
              <button key={k} type="button" role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''}
                      onClick={() => setFilter(k)}>{l}</button>)}
          </div>
        </div>
        {!drafts && <p className="muted">Đang tải…</p>}
        {drafts && rows.length === 0 && <p className="muted">{filter === 'all' ? 'Chưa có bài nào.' : `Không có bài ${DRAFT_STATUS[filter as FacebookDraftStatus].toLowerCase()}.`}</p>}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="plist">
              <thead><tr><th>Bài</th><th>Trạng thái</th><th /></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <b>{cut(d.content.replace(/\s+/g, ' '))}</b>
                      {d.link && <div className="small muted"><a href={d.link} target="_blank" rel="noopener noreferrer">{cut(d.link, 60)}</a></div>}
                      <div className="small muted">{t(d.created_at)}{d.photos.length > 0 ? ` · ${d.photos.length} ảnh` : ''}</div>
                    </td>
                    <td>
                      <span className="dt-tag">{DRAFT_STATUS[d.status]}</span>
                      {d.status === 'da_dang' && d.fb_post_url && <div className="small"><a href={d.fb_post_url} target="_blank" rel="noopener noreferrer">Mở bài Facebook</a></div>}
                      {d.status === 'da_duyet' && d.posted_at == null && <div className="small muted">chưa đăng được</div>}
                    </td>
                    <td className="hs-act">
                      <div className="actions">
                        {(d.status === 'cho_duyet' || d.status === 'da_duyet') && <button className="btn small primary" disabled={busy} onClick={() => void publish(d)}>{d.status === 'da_duyet' ? 'Đăng lại' : 'Duyệt đăng'}</button>}
                        {d.status === 'cho_duyet' && <button className="btn small" disabled={busy} onClick={() => openEdit(d)}>Sửa</button>}
                        {(d.status === 'cho_duyet' || d.status === 'da_duyet') && <button className="btn small link danger-text" disabled={busy} onClick={() => void discard(d)}>Bỏ</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {edit && (
        <Modal title="Soạn bài Facebook (chờ duyệt)" onClose={() => { setEdit(null); }}>
          <div className="form">
            <label>Nội dung bài đăng
              <textarea rows={6} maxLength={5000} value={edit.content}
                        placeholder="vd: Khai trương tuyến mới từ 01/12, đặt vé tại…"
                        onChange={(e) => setEdit({ ...edit, content: e.target.value })} />
            </label>
            <label>Link kèm bài (tùy chọn)
              <input type="url" value={edit.link} placeholder="https://…" onChange={(e) => setEdit({ ...edit, link: e.target.value })} />
            </label>
            <label>Ảnh bài (tối đa 10)
              <input type="file" accept="image/*" multiple onChange={(e) => { void takePhotos(e.target.files); e.target.value = ''; }} />
            </label>
            {(edit.photos.length > 0 || adding.length > 0) && (
              <div className="inline-form" style={{ flexWrap: 'wrap' }}>
                {edit.photos.map((p) => (
                  <span key={p} className="fb-thumb" style={{ backgroundImage: thumbs[p] ? `url(${thumbs[p]})` : undefined }}>
                    <button type="button" className="btn small link danger-text"
                            onClick={() => setEdit({ ...edit, photos: edit.photos.filter((x) => x !== p), removed: [...edit.removed, p] })}>×</button>
                  </span>
                ))}
                {adding.map((a, i) => (
                  <span key={a.url} className="fb-thumb" style={{ backgroundImage: `url(${a.url})` }}>
                    <button type="button" className="btn small link danger-text"
                            onClick={() => { URL.revokeObjectURL(a.url); setAdding((cur) => cur.filter((_, j) => j !== i)); }}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div className="actions">
              <button className="btn primary" disabled={busy} onClick={() => void saveDraft()}>{busy ? 'Đang lưu…' : 'Lưu bài chờ duyệt'}</button>
              <button className="btn link" onClick={() => setEdit(null)}>Thôi</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}