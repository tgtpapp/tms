// Bán vé khi mất mạng: lưu bản sao dữ liệu bán vé trên máy và hàng đợi vé "chờ gửi".
// Có mạng lại thì tự gửi lên (sync_offline_sale) – mỗi đơn có khóa chống gửi lặp.
import { useEffect, useState } from 'react';
import { errMsg, rpc } from './supabase';

const PREFIX = 'tms:';
const QUEUE = `${PREFIX}hang_doi_ve`;   // không xóa khi đăng xuất: vé đã thu tiền phải được gửi

export function cacheSet(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    /* bộ nhớ máy đầy / chặn lưu: bỏ qua */
  }
}

export function cacheGet<T>(key: string): { at: number; value: T } | null {
  try {
    const s = localStorage.getItem(PREFIX + key);
    return s ? (JSON.parse(s) as { at: number; value: T }) : null;
  } catch {
    return null;
  }
}

/** Xóa bản sao dữ liệu (khi đăng xuất), giữ hàng đợi vé chờ gửi. */
export function clearCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX) && k !== QUEUE) localStorage.removeItem(k);
  } catch {
    /* bỏ qua */
  }
}

export interface OfflineSale {
  key: string;                 // khóa chống gửi lặp
  tenant_id: string;
  user_id: string;
  local_code: string;          // mã tạm in trên vé khi chưa có mạng
  paper_no: string | null;     // số vé giấy (nhập vé giấy)
  trip_id: string;
  trip_label: string;
  seats: string[];
  from_stop: string;
  to_stop: string;
  price: number;               // giá mỗi ghế
  phone: string | null;
  name: string | null;
  method: 'tien_mat' | 'chuyen_khoan';
  sold_at: string;
  error?: string;              // lỗi nghiệp vụ khi gửi (cần sửa / xóa)
}

export interface SyncResult { sent: number; conflicts: string[]; errors: number }

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

export function queueAll(): OfflineSale[] {
  try {
    return JSON.parse(localStorage.getItem(QUEUE) ?? '[]') as OfflineSale[];
  } catch {
    return [];
  }
}

function save(list: OfflineSale[]) {
  localStorage.setItem(QUEUE, JSON.stringify(list));   // lỗi lưu phải báo cho người bán, không nuốt
  notify();
}

export function enqueue(sale: OfflineSale) {
  save([...queueAll(), sale]);
}

export function removeQueued(key: string) {
  save(queueAll().filter((x) => x.key !== key));
}

/** Lỗi do mất mạng (không phải lỗi nghiệp vụ từ database). */
export function isNetworkError(e: unknown): boolean {
  const m = errMsg(e);
  return !navigator.onLine || /Failed to fetch|NetworkError|Load failed|fetch failed|Network request failed/i.test(m);
}

let syncing = false;

/** Gửi các vé chờ của tài khoản này. Lỗi mạng: dừng, thử lại sau. Lỗi nghiệp vụ: ghi lại để người bán xử lý. */
export async function syncQueue(tenantId: string, userId: string): Promise<SyncResult> {
  const res: SyncResult = { sent: 0, conflicts: [], errors: 0 };
  if (syncing || !navigator.onLine) return res;
  syncing = true;
  try {
    for (const s of queueAll().filter((x) => x.tenant_id === tenantId && x.user_id === userId && !x.error)) {
      try {
        const r = await rpc<{ code: string; conflicts: string[] }>('sync_offline_sale', {
          p_key: s.key, p_paper_no: s.paper_no, p_trip_id: s.trip_id, p_seats: s.seats, p_from_stop: s.from_stop, p_to_stop: s.to_stop,
          p_price: s.price, p_phone: s.phone, p_name: s.name, p_method: s.method, p_sold_at: s.sold_at,
        });
        removeQueued(s.key);
        res.sent += 1;
        for (const c of r.conflicts) res.conflicts.push(`${s.trip_label} ghế ${c} (vé ${r.code})`);
      } catch (e) {
        if (isNetworkError(e)) break;
        save(queueAll().map((x) => (x.key === s.key ? { ...x, error: errMsg(e) } : x)));
        res.errors += 1;
      }
    }
  } finally {
    syncing = false;
  }
  return res;
}

/** Thử gửi lại một vé đã báo lỗi (sau khi người bán kiểm tra). */
export function retryQueued(key: string) {
  save(queueAll().map((x) => (x.key === key ? { ...x, error: undefined } : x)));
}

export function useOnline(): boolean {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

export function useQueue(): OfflineSale[] {
  const [list, setList] = useState(queueAll);
  useEffect(() => {
    const f = () => setList(queueAll());
    listeners.add(f);
    window.addEventListener('storage', f);
    return () => {
      listeners.delete(f);
      window.removeEventListener('storage', f);
    };
  }, []);
  return list;
}

/** Mã tạm in trên vé bán khi mất mạng. */
export function localCode(): string {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return `M${Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => a[b % a.length]).join('')}`;
}
