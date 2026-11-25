// Thanh in máy in nhiệt: chiều dài giấy dự kiến + cấu hình in (tự động / thủ công, lề, cỡ chữ) lưu trên máy này
import { useEffect, useLayoutEffect, useState } from 'react';
import { applyThermalCfg, lastList, readThermalCfg, saveThermalCfg, slipLengths, type ThermalCfg } from '../lib/thermalPrint';

const cm = (mm: number) => (mm / 10).toLocaleString('vi-VN', { maximumFractionDigits: 1 });

export function ThermalInfo() {
  const [c, setC] = useState<ThermalCfg>(readThermalCfg);
  const [lens, setLens] = useState<number[]>([]);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => { const l = lastList(); if (l) applyThermalCfg(l, c); }, [c]);
  useEffect(() => {
    const l = lastList();
    if (!l) return;
    const measure = () => setLens(slipLengths(l, c));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(l);
    l.querySelectorAll(':scope > .ve').forEach((e) => ro.observe(e));
    const mo = new MutationObserver(measure);
    mo.observe(l, { attributes: true, attributeFilter: ['class'] });
    return () => { ro.disconnect(); mo.disconnect(); };
  }, [c]);
  const set = (x: Partial<ThermalCfg>) => { const n = { ...c, ...x }; setC(n); saveThermalCfg(n); };
  const total = lens.reduce((a, b) => a + b, 0);
  return (
    <>
      {lens.length > 0 && <span className="tp-len">Dài dự kiến: <b>{lens.length > 1 ? `${lens.length} phiếu · ${cm(total)} cm` : `${cm(total)} cm`}</b></span>}
      <button type="button" className={open ? 'btn small primary' : 'btn small'} aria-expanded={open} onClick={() => setOpen(!open)}>⚙ Cấu hình in</button>
      {open && (
        <div className="tp-cfg">
          <label>Chiều dài giấy
            <select value={c.mode} onChange={(e) => set({ mode: e.target.value as ThermalCfg['mode'] })}>
              <option value="auto">Tự động theo nội dung</option>
              <option value="manual">Cố định</option>
            </select>
          </label>
          {c.mode === 'manual' && (
            <label>Chiều dài (mm)
              <input type="number" inputMode="numeric" min={30} max={2000} value={c.len || ''} onChange={(e) => set({ len: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
          )}
          <label>Lề
            <select value={c.margin} onChange={(e) => set({ margin: e.target.value as ThermalCfg['margin'] })}>
              <option value="hep">Hẹp</option><option value="vua">Vừa</option><option value="rong">Rộng</option>
            </select>
          </label>
          <label>Cỡ chữ
            <select value={c.font} onChange={(e) => set({ font: e.target.value as ThermalCfg['font'] })}>
              <option value="nho">Nhỏ</option><option value="vua">Vừa</option><option value="lon">Lớn</option>
            </select>
          </label>
          {c.mode === 'manual' && c.len > 0 && lens.some((x) => x > c.len) && <p className="small" style={{ color: 'var(--warn-text)' }}>Nội dung dài hơn {c.len} mm: phiếu đó tự in dài thêm để không mất nội dung.</p>}
        </div>
      )}
    </>
  );
}
