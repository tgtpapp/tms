// Chữ ký của nhân viên / lái xe (lưu theo hồ sơ nhân viên, không cần tài khoản đăng nhập). Dùng trên mọi bản in có phần ký của người đó.
import { useEffect, useState } from 'react';
import { Cropper } from './Cropper';
import { SignNameToggle } from './SignNameToggle';
import { removeFile, signatureUrl, uploadSignature } from '../lib/documents';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';

export function StaffSignature({ tenantId, staffId, canEdit }: { tenantId: string; staffId: string; canEdit: boolean }) {
  const toast = useToast();
  const who = `nv_${staffId}`;
  const [url, setUrl] = useState<string | null>(null);
  const [crop, setCrop] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void signatureUrl(tenantId, who).then(setUrl); }, [tenantId, who]);

  async function pick(file: File) {
    setBusy(true);
    try {
      await uploadSignature(tenantId, who, file);
      setUrl(await signatureUrl(tenantId, who));
      toast('ok', 'Đã lưu chữ ký');
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  async function drop() {
    try {
      await removeFile(`${tenantId}/chu_ky/${who}.png`);
      setUrl(await signatureUrl(tenantId, who));
      toast('ok', 'Đã bỏ chữ ký');
    } catch (e) { toast('error', errMsg(e)); }
  }
  return (
    <div className="sign-field">
      <h3>Chữ ký</h3>
      {url ? (
        <div className="img-x">
          <img src={url} alt="Chữ ký" className="sign-preview clear-bg" />
          {canEdit && <button type="button" className="img-x-btn" aria-label="Bỏ chữ ký này" title="Bỏ chữ ký này" onClick={() => void drop()}>×</button>}
        </div>
      ) : <p className="muted small">Chưa có chữ ký. Bản in sẽ để trống chỗ ký và ghi họ tên.</p>}
      {canEdit && (
        <label className="upload">
          <span>{busy ? 'Đang lưu…' : url ? 'Đổi ảnh chữ ký' : 'Tải ảnh chữ ký'}</span>
          <input type="file" accept="image/*" aria-label="Ảnh chữ ký" onChange={(e) => { setCrop(e.target.files?.[0] ?? null); e.target.value = ''; }} />
        </label>
      )}
      {url && canEdit && <SignNameToggle who={who} />}
      {crop && <Cropper file={crop} title="Cắt ảnh chữ ký" onCancel={() => setCrop(null)} onDone={(f) => { setCrop(null); void pick(f); }} />}
    </div>
  );
}
