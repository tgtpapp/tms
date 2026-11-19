// Cắt ảnh trước khi lưu chữ ký / con dấu: kéo ngón tay (hoặc chuột) quanh chữ ký để bỏ phần thừa
// (vd ảnh chụp màn hình có viền đen, thanh trạng thái điện thoại).
// Ảnh được giải mã bằng createImageBitmap rồi vẽ lại thành ảnh JPEG nhỏ (≤ 1600px) để hiển thị:
// không phụ thuộc đường dẫn tạm của tệp (blob:), báo lỗi rõ nếu không mở được.
import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface Box { x: number; y: number; w: number; h: number }   // tỉ lệ 0..1 theo ảnh
const MAX = 1600;

export function Cropper({ file, title, onDone, onCancel }: {
  file: File; title: string; onDone: (f: File) => void; onCancel: () => void;
}) {
  const [src, setSrc] = useState('');
  const [err, setErr] = useState('');
  const [box, setBox] = useState<Box | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setSrc('');
    setErr('');
    setBox(null);
    (async () => {
      try {
        if (!file.size) throw new Error('empty');
        const bmp = await createImageBitmap(file);
        const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * k));
        c.height = Math.max(1, Math.round(bmp.height * k));
        const g = c.getContext('2d');
        if (!g) throw new Error('no-ctx');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        if (!alive) return;
        canvas.current = c;
        setSrc(c.toDataURL('image/jpeg', 0.9));
      } catch {
        if (alive) setErr('Không mở được ảnh này (ảnh hỏng, đang tải từ cloud, hoặc định dạng HEIC). Chọn ảnh JPG / PNG khác, hoặc chụp lại.');
      }
    })();
    return () => { alive = false; };
  }, [file]);

  const pos = (e: PointerEvent) => {
    const r = area.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  function down(e: PointerEvent) {
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    start.current = pos(e);
    setBox(null);
  }
  function move(e: PointerEvent) {
    if (!start.current) return;
    const p = pos(e), s = start.current;
    setBox({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  }
  const up = () => { start.current = null; };

  async function finish(whole: boolean) {
    const c = canvas.current;
    if (!c) return;
    const b = whole || !box ? { x: 0, y: 0, w: 1, h: 1 } : box;
    const sx = Math.round(b.x * c.width), sy = Math.round(b.y * c.height);
    const sw = Math.max(1, Math.round(b.w * c.width)), sh = Math.max(1, Math.round(b.h * c.height));
    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    out.getContext('2d')?.drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
    if (blob) onDone(new File([blob], 'chu-ky.png', { type: 'image/png' }));
  }

  const ok = !!src && !!box && box.w > 0.02 && box.h > 0.02;
  return (
    <div className="crop-overlay" role="dialog" aria-label={title}>
      <div className="crop-card">
        <b>{title}</b>
        <p className="muted small">Kéo ngón tay (hoặc chuột) quanh phần cần giữ, bỏ phần thừa như viền đen, thanh điện thoại. Nền giấy trắng sẽ tự được xóa.</p>
        {!src && !err && <p className="muted">Đang mở ảnh…</p>}
        {err && <p className="error-text small">{err}</p>}
        {src && (
          <div ref={area} className="crop-area" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <img src={src} alt="Ảnh cần cắt" draggable={false} />
            {box && <div className="crop-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` }} />}
          </div>
        )}
        <div className="actions">
          <button type="button" className="btn primary" disabled={!ok} onClick={() => void finish(false)}>Dùng vùng đã chọn</button>
          <button type="button" className="btn" disabled={!src} onClick={() => void finish(true)}>Dùng cả ảnh</button>
          <button type="button" className="btn link" onClick={onCancel}>Hủy</button>
        </div>
      </div>
    </div>
  );
}
