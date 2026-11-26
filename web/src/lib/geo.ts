// Tọa độ điểm dừng cho trợ lý giọng nói: tra cứu tạm theo tên / địa chỉ, rồi tự học từ GPS điện thoại lái xe
// mỗi lần báo đón / trả / giao ở điểm đó (máy chủ lấy trung bình, bỏ mẫu sai – xem migration toa_do_diem_dung).
import { config } from '../config';
import { rpc } from './supabase';

export interface StopGeo { id: string; name: string; address: string | null; province: string | null; lat: number | null; lng: number | null }

/** Vị trí hiện tại (độ chính xác cao); không có quyền / không lấy được → null */
export function herePos(): Promise<GeolocationPosition | null> {
  return new Promise((res) => {
    if (!('geolocation' in navigator)) { res(null); return; }
    navigator.geolocation.getCurrentPosition((p) => res(p), () => res(null), { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
  });
}

/** Học vị trí điểm dừng lúc báo đón / trả / giao (chạy nền, lỗi thì bỏ qua) */
export function learnStop(tripId: string, stopId: string | null | undefined) {
  if (!stopId) return;
  void herePos().then((p) => (p ? rpc('learn_stop_location', { p_trip_id: tripId, p_stop_id: stopId, p_lat: p.coords.latitude, p_lng: p.coords.longitude,
    p_acc: Math.round(p.coords.accuracy) }) : null)).catch(() => undefined);
}

/** Khoảng cách (mét) */
export function distM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const x = Math.sin(r(bLat - aLat) / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(r(bLng - aLng) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(x));
}

const tried = new Set<string>();
/** Điểm chưa có tọa độ: tra tạm theo tên + địa chỉ (mỗi điểm 1 lần / phiên, cách nhau 1,2 giây theo quy định dịch vụ bản đồ miễn phí) */
export async function lookupMissing(tripId: string, stops: StopGeo[]): Promise<number> {
  if (!config.geocodeUrl) return 0;
  let n = 0;
  for (const s of stops) {
    if (s.lat != null || tried.has(s.id)) continue;
    tried.add(s.id);
    const q = [s.address, s.name, s.province, 'Việt Nam'].filter(Boolean).join(', ');
    try {
      const r = await fetch(`${config.geocodeUrl}/search?format=json&limit=1&countrycodes=vn&accept-language=vi&q=${encodeURIComponent(q)}`);
      const j = (await r.json()) as { lat: string; lon: string }[];
      if (j[0] && await rpc<boolean>('set_stop_lookup_location', { p_trip_id: tripId, p_stop_id: s.id, p_lat: Number(j[0].lat), p_lng: Number(j[0].lon) })) {
        s.lat = Number(j[0].lat); s.lng = Number(j[0].lon); n++;
      }
    } catch { /* bỏ qua điểm này */ }
    await new Promise((x) => setTimeout(x, 1200));
  }
  return n;
}
