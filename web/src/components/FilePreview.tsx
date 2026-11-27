// Xem trước tệp giấy tờ ngay trong form (ảnh, PDF scan), bấm vào để xem lớn; dùng chung cho mọi mục (nhân viên, xe, sửa chữa, nhiên liệu…).
import { useEffect, useState } from 'react';
import { signedUrl } from '../lib/documents';
import { FrameView, pdfJpegs } from './DocViewer';
import { pdfPageImages } from '../lib/pdfImages';

interface Item { url: string; thumb: string | null; pages: string[]; pdf: boolean; name: string }
const isPdf = (p: string) => /\.pdf$/i.test(p);

async function load(path: string): Promise<Item> {
  const url = await signedUrl(path);
  const name = path.split('/').pop() ?? path;
  if (!isPdf(path)) return { url, thumb: url, pages: [url], pdf: false, name };
  try {
    const u = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const pages = await pdfPageImages(u, pdfJpegs).catch(() => [] as string[]);
    return { url, thumb: pages[0] ?? null, pages, pdf: true, name };
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
    setLocal(urls.map((u, i) => ({ url: u, thumb: blobs[i].type.startsWith('image/') ? u : null, pages: blobs[i].type.startsWith('image/') ? [u] : [], pdf: !blobs[i].type.startsWith('image/'), name: `Tệp ${i + 1}` })));
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [blobKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Máy không hiện được ảnh trang (ảnh trong PDF lạ): bỏ ảnh, hiện chữ PDF và xem lớn bằng khung PDF thay vì ảnh vỡ
  const broken = (it: Item) => {
    if (!it.pdf) return;
    const fix = (l: Item[]) => l.map((x) => (x === it ? { ...x, thumb: null, pages: [] } : x));
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
            {it.pages.length > 1 && <em>{it.pages.length} trang</em>}
          </button>
        ))}
      </div>
      {big && (
        <div className="doc-big" role="dialog" aria-label="Xem lớn">
          <div className="doc-big-bar"><b>{big.name}</b>
            <a className="btn small" href={big.url} target="_blank" rel="noopener noreferrer" download>Tải về</a>
            <button type="button" className="btn small" onClick={() => setBig(null)}>Đóng</button></div>
          {big.pages.length ? <div className="doc-big-pages">{big.pages.map((p, i) => <img key={i} src={p} alt={`Trang ${i + 1}`} />)}</div>
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
