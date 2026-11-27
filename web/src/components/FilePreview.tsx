// Xem trước tệp giấy tờ ngay trong form (ảnh, PDF scan), bấm vào để xem lớn; dùng chung cho mọi mục (nhân viên, xe, sửa chữa, nhiên liệu…).
import { useEffect, useState } from 'react';
import { signedUrl } from '../lib/documents';
import { FrameView, PdfPages, pdfJpegs } from './DocViewer';
import { pdfThumb } from '../lib/pdfRender';
import { pdfPageImages } from '../lib/pdfImages';

interface Item { url: string; thumb: string | null; pages: string[]; pdf: boolean; name: string; bytes?: Uint8Array; count?: number }

/** PDF: ảnh trang đầu bằng pdf.js (xem lớn vẽ từng trang khi mở); lỗi thì lấy ảnh scan trong tệp như trước */
async function pdfItem(url: string, name: string, u: Uint8Array): Promise<Item> {
  try {
    const t = await pdfThumb(u);
    return { url, thumb: t.thumb, pages: [], pdf: true, name, bytes: u, count: t.pages };
  } catch {
    const pages = await pdfPageImages(u, pdfJpegs).catch(() => [] as string[]);
    return { url, thumb: pages[0] ?? null, pages, pdf: true, name };
  }
}
const isPdf = (p: string) => /\.pdf$/i.test(p);

async function load(path: string): Promise<Item> {
  const url = await signedUrl(path);
  const name = path.split('/').pop() ?? path;
  if (!isPdf(path)) return { url, thumb: url, pages: [url], pdf: false, name };
  try {
    return await pdfItem(url, name, new Uint8Array(await (await fetch(url)).arrayBuffer()));
  } catch {
    return { url, thumb: null, pages: [], pdf: true, name };
  }
}

/** Lưới ảnh xem trước. src: đường dẫn trong kho (files) hoặc ảnh vừa chọn chưa lưu (blobs). */
export function FilePreviews({ files = [], blobs = [] }: { files?: string[]; blobs?: Blob[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [big, setBig] = useState<Item | null>(null);
  const key = files.join('|');
  useEffect(() => {
    let alive = true;
    void Promise.all(files.map((p) => load(p).catch(() => null))).then((r) => { if (alive) setItems(r.filter((x): x is Item => !!x)); });
    return () => { alive = false; };
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [local, setLocal] = useState<Item[]>([]);
  const blobKey = blobs.map((b) => `${b.size}:${b.type}`).join('|');
  useEffect(() => {
    const urls = blobs.map((b) => URL.createObjectURL(b));
    const base = urls.map((u, i): Item => ({ url: u, thumb: blobs[i].type.startsWith('image/') ? u : null, pages: blobs[i].type.startsWith('image/') ? [u] : [], pdf: !blobs[i].type.startsWith('image/'), name: `Tệp ${i + 1}` }));
    setLocal(base);
    let alive = true;
    // Tệp PDF vừa chọn (chưa lưu): vẽ trang đầu bằng pdf.js
    void Promise.all(base.map(async (it, i) => (blobs[i].type === 'application/pdf'
      ? pdfItem(it.url, it.name, new Uint8Array(await blobs[i].arrayBuffer())).catch(() => it) : it)))
      .then((r) => { if (alive) setLocal(r); });
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [blobKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Máy không hiện được ảnh trang (ảnh trong PDF lạ): bỏ ảnh, hiện chữ PDF và xem lớn bằng khung PDF thay vì ảnh vỡ
  const broken = (it: Item) => {
    if (!it.pdf) return;
    const fix = (l: Item[]) => l.map((x) => (x === it ? { ...x, thumb: null, pages: [], bytes: undefined, count: undefined } : x));
    setItems(fix); setLocal(fix);
  };
  const all = [...items, ...local];
  if (!all.length) return null;
  return (
    <>
      <div className="fp-grid">
        {all.map((it, i) => (
          <button key={i} type="button" className="fp-thumb" title="Xem lớn" onClick={() => setBig(it)}>
            {it.thumb ? <img src={it.thumb} alt={it.name} onError={() => broken(it)} /> : <span>{it.pdf ? 'PDF' : 'Tệp'}</span>}
            {(it.count ?? it.pages.length) > 1 && <em>{it.count ?? it.pages.length} trang</em>}
          </button>
        ))}
      </div>
      {big && (
        <div className="doc-big" role="dialog" aria-label="Xem lớn">
          <div className="doc-big-bar"><b>{big.name}</b>
            <a className="btn small" href={big.url} target="_blank" rel="noopener noreferrer" download>Tải về</a>
            <button type="button" className="btn small" onClick={() => setBig(null)}>Đóng</button></div>
          {big.bytes ? <PdfPages bytes={big.bytes} url={big.url} name={big.name} />
            : big.pages.length ? <div className="doc-big-pages">{big.pages.map((p, i) => <img key={i} src={p} alt={`Trang ${i + 1}`} />)}</div>
            : <FrameView url={big.url} name={big.name} />}
        </div>
      )}
    </>
  );
}

/** Nút "Xem n tệp": mở khung xem trước ngay trong trang (không mở nhiều tab). */
export function FilesViewButton({ files, label }: { files: string[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!files.length) return null;
  return (
    <>
      <button type="button" className="btn small link" onClick={() => setOpen(!open)}>{open ? 'Ẩn tệp' : label ?? `Xem ${files.length} tệp`}</button>
      {open && <div className="fp-pop"><FilePreviews files={files} /></div>}
    </>
  );
}
