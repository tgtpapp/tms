// Khung phát nhạc ở cuối màn hình (mở bằng trợ lý giọng nói: "mở nhạc…"); không mất khi chuyển màn hình.
import { useEffect, useState } from 'react';
import { attachFrame, embedSrc, musicState, next, onMusic, pause, prev, resume, stopMusic } from '../lib/music';

export function MusicDock() {
  const [s, setS] = useState(musicState());
  useEffect(() => onMusic(setS), []);
  const on = s.list.length > 0;
  // chừa chỗ cuối trang để khung nhạc không che nút của màn hình đang mở
  useEffect(() => { document.body.classList.toggle('has-music', on); return () => document.body.classList.remove('has-music'); }, [on]);
  if (!on) return null;
  return (
    <div className="music-dock" role="region" aria-label="Đang phát nhạc">
      <iframe key={s.ver} src={embedSrc(s.list)} title={s.label || 'Nhạc'} allow="autoplay; encrypted-media" onLoad={(e) => attachFrame(e.currentTarget)} />
      <div className="music-bar">
        <span className="music-t">{s.label}</span>
        <button type="button" className="btn small" aria-label="Bài trước" onClick={prev}>⏮</button>
        <button type="button" className="btn small" aria-label={s.playing ? 'Tạm dừng' : 'Phát'} onClick={s.playing ? pause : resume}>{s.playing ? '⏸' : '▶'}</button>
        <button type="button" className="btn small" aria-label="Bài tiếp" onClick={next}>⏭</button>
        <button type="button" className="btn small" aria-label="Tắt nhạc" onClick={() => { attachFrame(null); stopMusic(); }}>✕</button>
      </div>
    </div>
  );
}
