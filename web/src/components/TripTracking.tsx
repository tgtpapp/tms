// Gửi vị trí xe cho văn phòng trong lúc chạy chuyến (đã xuất bến, chưa đến bến), khoảng 1 phút / lần.
// Lái xe phải đồng ý trước; tắt được bất cứ lúc nào. App web chỉ gửi được khi app đang mở trên màn hình.
import { useEffect, useRef, useState } from 'react';
import { errMsg, rpc, supabase } from '../lib/supabase';
import { useToast } from '../lib/toast';

const EVERY = 60_000;

export function TripTracking({ tripId, running }: { tripId: string; running: boolean }) {
  const toast = useToast();
  const [ok, setOk] = useState<boolean | null>(null);   // null: đang xem đã đồng ý chưa
  const [geoErr, setGeoErr] = useState('');
  const last = useRef<GeolocationPosition | null>(null);

  async function loadConsent() {
    const uid = (await supabase.auth.getSession()).data.session?.user.id;
    if (!uid) { setOk(false); return; }
    const r = await supabase.from('tracking_consents').select('user_id').eq('user_id', uid).maybeSingle();
    setOk(!r.error && !!r.data);
  }
  useEffect(() => { void loadConsent().catch(() => setOk(false)); }, []);

  useEffect(() => {
    if (!running || !ok || !('geolocation' in navigator)) return;
    let sentAt = 0;
    const send = () => {
      const p = last.current;
      if (!p || Date.now() - p.timestamp > 2 * EVERY) return;
      sentAt = Date.now();
      void rpc('track_point', { p_trip_id: tripId, p_lat: p.coords.latitude, p_lng: p.coords.longitude, p_acc: Math.round(p.coords.accuracy),
        p_speed: p.coords.speed == null ? null : Math.round(p.coords.speed * 3.6 * 10) / 10, p_heading: p.coords.heading == null ? null : Math.round(p.coords.heading) })
        .catch(() => undefined);
    };
    const id = navigator.geolocation.watchPosition((p) => {
      last.current = p; setGeoErr('');
      if (Date.now() - sentAt >= EVERY) send();   // vị trí đầu tiên gửi ngay, sau đó 1 phút / lần
    }, (e) => setGeoErr(e.code === e.PERMISSION_DENIED ? 'Máy chưa cho app dùng định vị. Vào cài đặt trình duyệt cho phép vị trí.' : ''),
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 60_000 });
    const t = setInterval(() => { if (Date.now() - sentAt >= EVERY) send(); }, 15_000);
    return () => { navigator.geolocation.clearWatch(id); clearInterval(t); };
  }, [running, ok, tripId]);

  if (!running || ok === null) return null;
  if (!ok) {
    return (
      <div className="card small">
        <p style={{ marginTop: 0 }}>Cho phép gửi vị trí xe cho văn phòng khi đang chạy chuyến (chỉ từ lúc xuất bến đến lúc đến bến, giữ 30 ngày rồi tự xóa).</p>
        <button type="button" className="btn primary" onClick={() => void rpc('tracking_agree', {}).then(() => setOk(true)).catch((e) => toast('error', errMsg(e)))}>Đồng ý gửi vị trí</button>
      </div>
    );
  }
  return (
    <p className="small muted">
      📍 Đang gửi vị trí xe cho văn phòng{' '}
      <button type="button" className="btn small link" onClick={() => void rpc('tracking_withdraw', {}).then(() => setOk(false)).catch((e) => toast('error', errMsg(e)))}>Tắt</button>
      {geoErr && <span className="error-text"> {geoErr}</span>}
    </p>
  );
}
