// Đầu trang in (vé, phiếu, báo cáo): logo trái, tên công ty + địa chỉ + liên hệ phải, đường kẻ ngang đen dưới
import { contacts, useBrand, type Brand } from '../lib/brand';

/** fallback: tên / logo đã có sẵn, dùng khi thông tin công ty chưa tải xong */
export function PrintHead({ k80, fallback }: { k80?: boolean; fallback?: { name: string; logo?: string | null } }) {
  const got = useBrand();
  const b: Brand = got ?? { name: fallback?.name ?? '', address: '', phone: '', hotline: '', email: '', website: '', logo: fallback?.logo ?? null };
  const c = contacts(b);
  return (
    <>
      <div className={k80 ? 'k8h' : 'a4h'}>
        {b.logo && <img src={b.logo} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
        <div>
          <b>{b.name.toUpperCase()}</b>
          {b.address && <div>Địa chỉ: {b.address}</div>}
          {c.length > 0 && <div>{c.join(' · ')}</div>}
        </div>
      </div>
      <div className={k80 ? 'k8h-line' : 'a4h-line'} />
    </>
  );
}
