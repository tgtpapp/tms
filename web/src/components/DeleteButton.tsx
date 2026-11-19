// Nút xóa có xác nhận ngay tại chỗ (không dùng hộp thoại trình duyệt). Gọi RPC delete_record.
import { useState } from 'react';
import { errMsg, rpc } from '../lib/supabase';
import { useToast } from '../lib/toast';

export type DeleteKind = 'stop' | 'route' | 'vehicle_type' | 'vehicle' | 'staff' | 'branch' | 'office';

export function DeleteButton({ kind, id, name, onDone, note }: { kind: DeleteKind; id: string; name: string; onDone: () => void | Promise<void>; note?: string }) {
  const toast = useToast();
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!ask) return <button type="button" className="btn small link danger-text" onClick={() => setAsk(true)}>Xóa</button>;
  return (
    <span className="inline-form">
      <span className="small">Xóa {name}?{note ? ` ${note}` : ''}</span>
      <button type="button" className="btn small danger" disabled={busy} onClick={async () => {
        setBusy(true);
        try {
          await rpc('delete_record', { p_kind: kind, p_id: id });
          toast('ok', `Đã xóa ${name}`);
          setAsk(false);
          await onDone();
        } catch (e) {
          toast('error', errMsg(e));
        } finally {
          setBusy(false);
        }
      }}>Xóa hẳn</button>
      <button type="button" className="btn small link" onClick={() => setAsk(false)}>Thôi</button>
    </span>
  );
}
