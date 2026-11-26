import type { ReactNode } from 'react';
import { config } from '../config';
import { splashBrand } from '../lib/brand';

/** Màn chờ / thông báo giữa màn hình: tên nhà xe (đã đăng nhập trên máy này) kèm logo chìm phía sau; chưa có thì tên app */
export function Centered({ children }: { children: ReactNode }) {
  const b = splashBrand();
  return (
    <main className="centered">
      {b?.logo && <img className="centered-logo" src={b.logo} alt="" aria-hidden="true" />}
      <h1 className="brand">{b?.name || config.appName}</h1>
      {children}
    </main>
  );
}
