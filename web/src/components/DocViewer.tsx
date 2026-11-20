// Xem hồ sơ như app cũ: cửa sổ có tiêu đề, ảnh xem trước của tài liệu, nút "Xem lớn", "Tải về", "Đóng".
// PDF scan / PDF do app tạo: lấy ảnh từng trang (JPEG) ngay trong file để xem trước, không cần thư viện.
import { useEffect, useMemo, useState } from 'react';
import { pdfImages } from '../lib/pdfImages';
import { Modal } from './Modal';
import { openBase64 } from '../lib/drive';

function b64Bytes(b64: string): Uint8Array {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** Ảnh JPEG nằm trong PDF (mỗi trang scan là 1 ảnh). Trả về data URL, tối đa 30 trang. */
export function pdfJpegs(u: Uint8Array): string[] {
  const out: string[] = [], END = [0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];   // "endstream"
  const at = (i: number, p: number[]) => p.every((b, k) => u[i + k] === b);
  for (let i = 0; i < u.length - 3 && out.length < 30; i++) {
    if (u[i] !== 0xff || u[i + 1] !== 0xd8 || u[i + 2] !== 0xff) continue;
    if (!(u[i - 1] === 0x0a || u[i - 1] === 0x0d)) continue;                 // ảnh bắt đầu ngay sau "stream\n"
    let j = i + 3;
    while (j < u.length - END.length && !at(j, END)) j++;
    let e = j;
    while (e > i && u[e - 1] !== 0xd9) e--;                                    // cắt tới FF D9 (kết thúc JPEG)
    if (e - i < 200) continue;
    let s = '';
    const part = u.subarray(i, e);
    for (let k = 0; k < part.length; k += 0x8000) s += String.fromCharCode(...part.subarray(k, k + 0x8000));
    out.push(`data:image/jpeg;base64,${btoa(s)}`);
    i = j;
  }
  return out;
}

/** Tệp không lấy được ảnh trang (PDF chữ, tệp khác): xem trong khung ngay trong app; máy không hiển thị được thì bấm Tải về */
export function FrameView({ url, name }: { url: string; name: string }) {
  return (
    <div className="doc-frame">
      <iframe src={url} title={name} />
      <p className="small muted">Nếu khung trên trống (một số điện thoại không xem PDF trực tiếp), bấm "Tải về" để mở.</p>
    </div>
  );
}

export function DocViewer({ title, name, mime, b64, onClose }: { title: string; name: string; mime: string; b64: string; onClose: () => void }) {
  const [big, setBig] = useState(false);
  const isImg = mime.startsWith('image/'), isPdf = mime === 'application/pdf' || /\.pdf$/i.test(name);
  const [pages, setPages] = useState<string[]>(() => (isImg ? [`data:${mime};base64,${b64}`] : []));
  useEffect(() => {
    if (!isPdf) return;
    const u = b64Bytes(b64);
    void pdfImages(u).catch(() => [] as string[]).then((p) => setPages(p.length ? p : pdfJpegs(u)));
  }, [b64, isPdf]);
  const blobUrl = useMemo(() => URL.createObjectURL(new Blob([b64Bytes(b64) as BlobPart], { type: mime || 'application/octet-stream' })), [b64, mime]);
  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);
  const openBig = () => setBig(true);

  if (big) {
    return (
      <div className="doc-big" role="dialog" aria-label={title}>
        <div className="doc-big-bar"><b>{title}</b><button className="btn small" onClick={() => openBase64(name, mime, b64, true)}>Tải về</button>
          <button className="btn small" onClick={() => setBig(false)}>Đóng</button></div>
        {pages.length ? <div className="doc-big-pages">{pages.map((p, i) => <img key={i} src={p} alt={`Trang ${i + 1}`} />)}</div> : <FrameView url={blobUrl} name={name} />}
      </div>
    );
  }
  return (
    <Modal title={title} onClose={onClose}>
      <div className="doc-view">
        {pages.length ? (
          <button type="button" className="doc-thumb" onClick={openBig} aria-label="Xem lớn">
            <img src={pages[0]} alt={title} />
            {pages.length > 1 && <span className="doc-pages">{pages.length} trang</span>}
          </button>
        ) : <div className="doc-thumb empty"><span>{isPdf ? 'PDF' : (name.split('.').pop() ?? '').toUpperCase() || 'Tệp'}</span><small>{name}</small></div>}
        <div className="actions">
          <button className="btn" onClick={openBig}><i className="fi fi-rr-eye" aria-hidden="true" /> Xem lớn</button>
          <button className="btn" onClick={() => openBase64(name, mime, b64, true)}><i className="fi fi-rr-download" aria-hidden="true" /> Tải về</button>
        </div>
        <button className="btn doc-close" onClick={onClose}>Đóng</button>
      </div>
    </Modal>
  );
}
