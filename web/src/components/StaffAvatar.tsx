// Ảnh đại diện nhân viên / lái xe: hiện ảnh (hoặc chữ viết tắt), người quản lý nhân sự hoặc chính người đó đổi / bỏ ảnh.
import { useEffect, useState } from 'react';
import { Cropper } from './Cropper';
import { avatarUrls, removeAvatar, uploadAvatar } from '../lib/documents';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';

export const initials = (name: string) => name.trim().split(/\s+/).slice(-2).map((w) => w[0]?.toUpperCase() ?? '').join('');

/** Danh sách link ảnh đại diện của nhà xe; tự tải lại khi có người đổi ảnh. */
export function useAvatars(tenantId: string | null): Record<string, string> {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!tenantId) return;
    let live = true;
    const load = () => { void avatarUrls(tenantId).then((m) => { if (live) setMap(m); }); };
    load();
    window.addEventListener('tms-avatar', load);
    return () => { live = false; window.removeEventListener('tms-avatar', load); };
  }, [tenantId]);
  return map;
}

export function Avatar({ name, url, size = 44 }: { name: string; url?: string; size?: number }) {
  return url
    ? <img className="sc-ava" src={url} alt={`Ảnh ${name}`} style={{ width: size, height: size, flexBasis: size }} />
    : <span className="sc-ava" aria-hidden="true" style={{ width: size, height: size, flexBasis: size }}>{initials(name)}</span>;
}

export function StaffAvatar({ tenantId, staffId, name, canEdit }: { tenantId: string; staffId: string; name: string; canEdit: boolean }) {
  const toast = useToast();
  const map = useAvatars(tenantId);
  const url = map[staffId];
  const [crop, setCrop] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(f: File) {
    setBusy(true);
    try { await uploadAvatar(tenantId, staffId, f); toast('ok', 'Đã lưu ảnh đại diện'); }
    catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  async function drop() {
    try { await removeAvatar(tenantId, staffId); toast('ok', 'Đã bỏ ảnh đại diện'); }
    catch (e) { toast('error', errMsg(e)); }
  }
  return (
    <div className="ava-field">
      <Avatar name={name} url={url} size={88} />
      {canEdit && (
        <div className="ava-act">
          <label className="upload">
            <span>{busy ? 'Đang lưu…' : url ? 'Đổi ảnh đại diện' : 'Tải ảnh đại diện'}</span>
            <input type="file" accept="image/*" aria-label="Ảnh đại diện" onChange={(e) => { setCrop(e.target.files?.[0] ?? null); e.target.value = ''; }} />
          </label>
          {url && <button type="button" className="btn small" onClick={() => void drop()}>Bỏ ảnh</button>}
        </div>
      )}
      {crop && <Cropper file={crop} title="Cắt ảnh đại diện (lấy phần giữa hình vuông)" onCancel={() => setCrop(null)} onDone={(f) => { setCrop(null); void save(f); }} />}
    </div>
  );
}
