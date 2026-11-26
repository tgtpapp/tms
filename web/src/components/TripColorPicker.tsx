// Chọn màu thẻ giờ chạy ngay trên màn hình Bán vé / Gửi hàng / Điều hành (cùng cài đặt với Giao diện của tôi)
import { saveTripColorCfg, useTripColorCfg, type TripColorCfg } from '../lib/tripColor';

export function TripColorPicker() {
  const c = useTripColorCfg();
  return (
    <div className="tcp">
      <select aria-label="Màu thẻ giờ chạy" value={c.mode} onChange={(e) => saveTripColorCfg({ ...c, mode: e.target.value as TripColorCfg['mode'] })}>
        <option value="mac_dinh">Một màu</option>
        <option value="tuyen">Mỗi tuyến 1 màu</option>
        <option value="gio">Mỗi giờ 1 màu</option>
      </select>
      {c.mode !== 'mac_dinh' && (
        <button type="button" className="btn small" onClick={() => saveTripColorCfg({ ...c, seed: (c.seed + 1 + Math.floor(Math.random() * 10)) % 12 })}>🎨 Đổi màu</button>
      )}
    </div>
  );
}
