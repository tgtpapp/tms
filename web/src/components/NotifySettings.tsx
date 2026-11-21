// Tài khoản của tôi › Thông báo: bật / tắt thông báo đẩy trên máy này, chọn loại thông báo muốn nhận.
import { useEffect, useState } from 'react';
import { disablePush, enablePush, pushStatus } from '../lib/push';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

const KINDS: [string, string][] = [
  ['khach', 'Khách đặt thêm, hủy vé, chuyển vé ở chuyến hôm nay của tôi'],
  ['xep_chuyen', 'Được xếp / bỏ khỏi chuyến hôm nay, ngày mai'],
  ['lai_xe_bao', 'Lái xe báo khách thuê bao / khách báo hủy (vé tôi bán)'],
  ['su_co', 'Sự cố người dùng báo / trả lời sự cố tôi báo'],
];
const ST = { bat: 'Đang nhận thông báo trên máy này', tat: 'Máy này chưa nhận thông báo', bi_chan: 'Máy này đang chặn thông báo của app',
  khong_ho_tro: 'Trình duyệt này không nhận được thông báo đẩy' } as const;

export function NotifySettings() {
  const toast = useToast();
  const [st, setSt] = useState<keyof typeof ST | null>(null);
  const [off, setOff] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pushStatus().then(setSt);
    void supabase.from('notify_prefs').select('off_kinds').maybeSingle().then(({ data }) => setOff(((data as { off_kinds?: string[] } | null)?.off_kinds) ?? []));
  }, []);
  async function toggle() {
    setBusy(true);
    try {
      if (st === 'bat') { await disablePush(); toast('ok', 'Đã tắt thông báo trên máy này'); }
      else { await enablePush(); toast('ok', 'Đã bật thông báo trên máy này'); }
      setSt(await pushStatus());
    } catch (e) { toast('error', errMsg(e)); } finally { setBusy(false); }
  }
  async function setKind(k: string, on: boolean) {
    const next = on ? off.filter((x) => x !== k) : [...new Set([...off, k])];
    setOff(next);
    try { await rpc('set_notify_prefs', { p_off: next }); } catch (e) { toast('error', errMsg(e)); }
  }
  return (
    <section className="card form">
      <h2>Thông báo</h2>
      <div className="item-head">
        <span className={st === 'bat' ? 'badge' : 'badge warn-badge'}>{st ? ST[st] : 'Đang kiểm tra…'}</span>
        {st && st !== 'khong_ho_tro' && (
          <button type="button" className={st === 'bat' ? 'btn small' : 'btn primary'} disabled={busy} onClick={() => void toggle()}>
            {st === 'bat' ? 'Tắt trên máy này' : 'Bật thông báo trên máy này'}
          </button>
        )}
      </div>
      {st === 'bi_chan' && <p className="small state-sap_het">Vào cài đặt trình duyệt / điện thoại, cho phép thông báo của app rồi bấm lại.</p>}
      {st === 'khong_ho_tro' && <p className="small state-sap_het">iPhone: cài app vào màn hình chính (iOS 16.4 trở lên) rồi mở từ biểu tượng app.</p>}
      <fieldset className="nb-kinds">
        <legend className="small muted">Nhận thông báo về</legend>
        {KINDS.map(([k, l]) => (
          <label key={k} className="check"><input type="checkbox" checked={!off.includes(k)} onChange={(e) => void setKind(k, e.target.checked)} /> {l}</label>
        ))}
      </fieldset>
    </section>
  );
}
