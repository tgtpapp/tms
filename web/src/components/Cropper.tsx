// Cắt ảnh trước khi lưu chữ ký / con dấu: kéo ngón tay (hoặc chuột) quanh chữ ký để bỏ phần thừa
// (vd ảnh chụp màn hình có viền đen, thanh trạng thái điện thoại).
import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface Box { x: number; y: number; w: number; h: number }   // tỉ lệ 0..1 theo ảnh

export function Cropper({ file, title, onDone, onCancel }: {
  file: File; title: string; onDone: (f: File) => void; onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [box, setBox] = useState<Box | null>(null);
  const [bad, setBad] = useState(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  const pos = (e: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  function down(e: PointerEvent) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    start.current = pos(e);
    setBox(null);
  }
  function move(e: PointerEvent) {
    if (!start.current) return;
    const p = pos(e), s = start.current;
    setBox({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  }
  const up = () => { start.current = null; };

  async function crop() {
    if (!box) return;
    const bmp = await createImageBitmap(file);
    const sx = Math.round(box.x * bmp.width), sy = Math.round(box.y * bmp.height);
    const sw = Math.max(1, Math.round(box.w * bmp.width)), sh = Math.max(1, Math.round(box.h * bmp.height));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d')?.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    bmp.close();
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (blob) onDone(new File([blob], 'cat.png', { type: 'image/png' }));
  }

  const ok = box && box.w > 0.02 && box.h > 0.02;
  return (
    <div className="crop-overlay" role="dialog" aria-label={title}>
      <div className="crop-card">
        <b>{title}</b>
        <p className="muted small">Kéo ngón tay (hoặc chuột) quanh phần cần giữ, bỏ phần thừa như viền đen, thanh điện thoại. Nền giấy trắng sẽ tự được xóa.</p>
        <div ref={area} className="crop-area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          {url && <img src={url} alt="" draggable={false} onError={() => setBad(true)} />}
          {box && <div className="crop-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} />}
        </div>
        {bad && <p className="error-text small">Trình duyệt không hiển thị được ảnh này (vd ảnh HEIC của iPhone). Chụp lại hoặc chọn ảnh JPG / PNG.</p>}
        <div className="actions">
          <button type="button" className="btn primary" disabled={!ok} onClick={() => void crop()}>Dùng vùng đã chọn</button>
          <button type="button" className="btn" onClick={() => onDone(file)}>Dùng cả ảnh</button>
          <button type="button" className="btn link" onClick={onCancel}>Hủy</button>
        </div>
      </div>
    </div>
  );
}
