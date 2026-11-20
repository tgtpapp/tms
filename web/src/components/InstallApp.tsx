// Nút "Cài app vào máy" + hướng dẫn cài theo loại máy (như app cũ).
import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from './Modal';
import { canPrompt, isAndroid, isIOS, onPwa, promptInstall, standalone } from '../lib/pwa';
import { useToast } from '../lib/toast';

export function InstallApp({ name, className = 'btn link' }: { name: string; className?: string }) {
  const toast = useToast();
  const [, tick] = useState(0);
  const [guide, setGuide] = useState(false);
  useEffect(() => onPwa(() => tick((n) => n + 1)), []);
  if (standalone()) return null;
  const ios = isIOS(), and = isAndroid();
  async function go() {
    if (!canPrompt()) { setGuide(true); return; }
    if (await promptInstall()) toast('ok', `Đã cài app ${name}`);
  }
  const Row = ({ t, on, children }: { t: string; on: boolean; children: ReactNode }) => (
    <div className={`pwa-r${on ? ' on' : ''}`}><b>{t}</b><div>{children}</div></div>);
  return (
    <>
      <button type="button" className={className} onClick={() => void go()}>📲 Cài app vào máy</button>
      {guide && (
        <Modal title={`Cài app ${name}`} onClose={() => setGuide(false)}>
          <p className="small muted">Cài 1 lần: app có biểu tượng riêng (ảnh của bạn), mở cửa sổ riêng không có thanh địa chỉ, tự cập nhật, mở là vào thẳng phần của bạn.</p>
          <Row t="💻 Máy tính (Chrome / Edge)" on={!ios && !and}>Bấm biểu tượng <b>Cài đặt</b> ở cuối thanh địa chỉ → <b>Cài đặt</b>.</Row>
          <Row t="🤖 Android (Chrome)" on={and}>Menu <b>⋮</b> → <b>Cài đặt ứng dụng</b> (hoặc Thêm vào màn hình chính) → <b>Cài đặt</b>.</Row>
          <Row t="🍎 iPhone / iPad (Safari)" on={ios}>Nút <b>Chia sẻ</b> (ô vuông mũi tên lên) → <b>Thêm vào MH chính</b> → <b>Thêm</b>.</Row>
          <div className="actions"><button type="button" className="btn" onClick={() => setGuide(false)}>Đóng</button></div>
        </Modal>
      )}
    </>
  );
}
