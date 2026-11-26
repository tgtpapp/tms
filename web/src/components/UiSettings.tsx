// Giao diện của tôi (như app cũ): mỗi người tự chọn, lưu trên máy này; đổi là thấy ngay.
import { useEffect, useState } from 'react';
import { ACC, DEF, FONTS, PRESETS, useUi, type Mode, type UiCfg } from '../lib/theme';
import { canSpeak, saveVoiceCfg, speak, viVoices, voiceCfg, type VoiceCfg } from '../lib/voice';

/** Giọng đọc của Trợ lý giọng nói (app lái xe): chọn giọng, tốc độ, âm lượng, tự đọc tin mới */
function VoiceSettings() {
  const [v, setV] = useState<VoiceCfg>(voiceCfg);
  const [list, setList] = useState<SpeechSynthesisVoice[]>(() => (canSpeak() ? viVoices() : []));
  useEffect(() => {
    if (!canSpeak()) return;
    const on = () => setList(viVoices());
    window.speechSynthesis.addEventListener('voiceschanged', on);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', on);
  }, []);
  if (!canSpeak()) return null;
  const set = (o: Partial<VoiceCfg>) => { const n = { ...v, ...o }; setV(n); saveVoiceCfg(n); };
  return (
    <div className="ux-sec"><h4>Giọng đọc trợ lý (app lái xe)</h4>
      <div className="ux-2">
        <label>Giọng
          <select value={v.voice} onChange={(e) => set({ voice: e.target.value })} aria-label="Giọng đọc">
            <option value="">{list.length ? 'Mặc định của máy' : 'Máy chưa có giọng tiếng Việt'}</option>
            {list.map((x) => <option key={x.voiceURI} value={x.voiceURI}>{x.name}</option>)}
          </select></label>
        <label>Tốc độ đọc ({v.rate.toFixed(2).replace('.', ',')})
          <input type="range" min={0.6} max={1.4} step={0.05} value={v.rate} onChange={(e) => set({ rate: Number(e.target.value) })} aria-label="Tốc độ đọc" /></label>
        <label>Âm lượng ({Math.round(v.volume * 100)}%)
          <input type="range" min={0.3} max={1} step={0.05} value={v.volume} onChange={(e) => set({ volume: Number(e.target.value) })} aria-label="Âm lượng đọc" /></label>
      </div>
      <label className="ux-sw"><input type="checkbox" checked={v.news} onChange={(e) => set({ news: e.target.checked })} />Tự đọc tin mới trên chuyến đang chạy (khách mới, khách hủy, hàng mới)</label>
      <div className="actions">
        <button type="button" className="btn small" onClick={() => void speak('Điểm tới Ngã tư Vũng Tàu đón 2 khách, Hùng đuôi 512, Lan đuôi 801. Thu tiền vé 300 nghìn.')}>🔊 Đọc thử</button>
        <button type="button" className="btn small link" onClick={() => { setV({ ...v, voice: '', rate: 0.95, volume: 1 }); saveVoiceCfg({ ...v, voice: '', rate: 0.95, volume: 1 }); }}>Về mặc định</button>
      </div>
    </div>
  );
}

function Seg<T extends string | number>({ label, value, opts, onPick }: { label: string; value: T; opts: [T, string][]; onPick: (v: T) => void }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {opts.map(([v, t]) => <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>{t}</button>)}
    </div>
  );
}

export function UiSettings() {
  const [c, save] = useUi();
  const set = (o: Partial<UiCfg>) => save({ ...c, ...o });
  const play = (call: boolean) => void import('../lib/hoatCanh').then((h) => (call
    ? h.playScene({ mode: 'call', kq: h.pick(['ok', 'ok', 'nr', 'hl', 'tb']), cap: 'Xem thử · tài xế gọi khách' })
    : h.playScene({ cap: 'Xem thử · khách đã lên xe' })));
  return (
    <section className="card form">
      <div className="item-head"><h2>Giao diện của tôi</h2>
        <button type="button" className="btn small" onClick={() => save({ ...DEF, menu: c.menu })}>Khôi phục mặc định</button></div>
      <div className="ux-sec"><h4>Chế độ hiển thị</h4>
        <Seg<Mode> label="Chế độ hiển thị" value={c.mode} opts={[['light', '☀ Sáng'], ['dark', '☾ Tối'], ['auto', '🖥 Tự động']]} onPick={(mode) => set({ mode })} />
        <p className="small muted">Tự động: theo cài đặt sáng / tối của điện thoại, máy tính.</p></div>
      <div className="ux-sec"><h4>Mẫu giao diện</h4>
        <div className="ux-pres" role="radiogroup" aria-label="Mẫu giao diện">
          {PRESETS.map((p) => {
            const a = ACC.find((x) => x.id === p.v.acc)?.c ?? '#635bff';
            return (
              <button key={p.id} type="button" role="radio" aria-checked={c.preset === p.id} className={c.preset === p.id ? 'ux-pre on' : 'ux-pre'}
                      onClick={() => set({ preset: p.id, ...p.v, mode: p.v.mode ?? (c.mode === 'dark' ? 'light' : c.mode) })}>
                <span className={p.v.mode === 'dark' ? 'ux-pv dk' : 'ux-pv'}><i style={{ background: a }} /><b /><b /><em style={{ background: a }} /></span>
                <b>{p.name}</b><small>{p.d}</small>
              </button>
            );
          })}
        </div></div>
      <div className="ux-sec"><h4>Màu nhấn</h4>
        <div className="ux-acc">
          {ACC.map((a) => <button key={a.id} type="button" title={a.name} aria-label={`Màu ${a.name}`} className={c.acc === a.id ? 'on' : ''} style={{ ['--sw' as string]: a.c }} onClick={() => set({ acc: a.id })} />)}
          <label className={c.acc === 'custom' ? 'ux-cust on' : 'ux-cust'} title="Tự chọn màu">
            <input type="color" aria-label="Tự chọn màu" value={c.custom || '#635bff'} onChange={(e) => set({ acc: 'custom', custom: e.target.value })} /><span>Tự chọn</span>
          </label>
        </div></div>
      <div className="ux-2 ux-sec">
        <div><h4>Font chữ</h4>
          <select aria-label="Font chữ" value={c.font} onChange={(e) => set({ font: e.target.value })}>
            {FONTS.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select></div>
        <div><h4>Cỡ chữ</h4><Seg<number> label="Cỡ chữ" value={c.size} opts={[[90, 'Nhỏ'], [100, 'Vừa'], [110, 'Lớn'], [120, 'Rất lớn']]} onPick={(size) => set({ size })} /></div>
      </div>
      <div className="ux-2 ux-sec">
        <div><h4>Mật độ</h4><Seg<UiCfg['den']> label="Mật độ" value={c.den} opts={[['compact', 'Gọn'], ['std', 'Chuẩn'], ['roomy', 'Thoáng']]} onPick={(den) => set({ den })} /></div>
        <div><h4>Bo góc</h4><Seg<UiCfg['rad']> label="Bo góc" value={c.rad} opts={[['sm', 'Vuông'], ['md', 'Vừa'], ['lg', 'Tròn']]} onPick={(rad) => set({ rad })} /></div>
      </div>
      <div className="ux-2 ux-sec">
        <div><h4>Menu bên trái (máy tính)</h4><Seg<UiCfg['menu']> label="Menu bên trái" value={c.menu} opts={[['pin', 'Luôn mở'], ['auto', 'Tự thu gọn']]} onPick={(menu) => set({ menu })} /></div>
        <div><h4>Dùng ngoài trời</h4>
          <label className="ux-sw"><input type="checkbox" checked={c.out} onChange={(e) => set({ out: e.target.checked })} />Tương phản cao, chữ to hơn khi xem dưới nắng</label></div>
      </div>
      <div className="ux-sec"><h4>Hoạt cảnh đón khách (Bán vé)</h4>
        <label className="ux-sw"><input type="checkbox" checked={c.anim} onChange={(e) => set({ anim: e.target.checked })} />
          Chuyến đang xem trên Bán vé: khách được báo đã lên xe → hoạt cảnh 10 giây (mở cửa, xếp hành lý, khách lên xe, xe chạy); lái xe ghi kết quả gọi khách → cảnh xe đang tới điểm đón kèm lời gọi. Mỗi lần một tình huống ngẫu nhiên</label>
        <div className="actions"><button type="button" className="btn small" onClick={() => play(false)}>✨ Xem thử: khách lên xe</button>
          <button type="button" className="btn small" onClick={() => play(true)}>📞 Xem thử: gọi khách</button></div>
      </div>
      <VoiceSettings />
      <p className="small muted">Lưu riêng trên máy này, không ảnh hưởng người khác; bản in luôn nền trắng.</p>
    </section>
  );
}
