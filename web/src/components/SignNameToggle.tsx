// Ô "Chữ ký đã có họ tên": bật thì bản in không ghi thêm họ tên dưới chữ ký. Đổi là lưu ngay.
import { useEffect, useState } from 'react';
import { getHasName, setHasName } from '../lib/signatures';
import { errMsg } from '../lib/supabase';
import { useToast } from '../lib/toast';

export function SignNameToggle({ who }: { who: string }) {
  const toast = useToast();
  const [v, setV] = useState<boolean | null>(null);
  useEffect(() => { void getHasName(who).then(setV); }, [who]);
  if (v === null) return null;
  return (
    <label className="check">
      <input type="checkbox" checked={v} onChange={async (e) => {
        const n = e.target.checked;
        try { await setHasName(who, n); setV(n); toast('ok', n ? 'Bản in sẽ không ghi thêm họ tên dưới chữ ký' : 'Bản in sẽ ghi họ tên dưới chữ ký'); }
        catch (err) { toast('error', errMsg(err)); }
      }} />
      Chữ ký này đã có sẵn họ tên (bản in không ghi thêm họ tên bên dưới)
    </label>
  );
}
