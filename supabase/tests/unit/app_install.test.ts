// Kiểm thử hàm app-install: chỉ nhận địa chỉ app an toàn, tệp cài app đúng tên ngắn, biểu tượng theo hồ sơ.
import { assertEquals } from 'jsr:@std/assert@1';
import { manifestOf, safeOrigin } from '../../functions/_shared/app_install.ts';

Deno.test('safeOrigin: https, máy thử; chặn địa chỉ lạ', () => {
  assertEquals(safeOrigin('https://thinhphat.pages.dev/abc'), 'https://thinhphat.pages.dev');
  assertEquals(safeOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173');
  assertEquals(safeOrigin('http://evil.com'), null);
  assertEquals(safeOrigin('javascript:alert(1)'), null);
  assertEquals(safeOrigin(null), null);
});

Deno.test('manifestOf: tên ngắn bỏ "Nhà xe", biểu tượng theo hồ sơ + phiên bản ảnh', () => {
  const m = manifestOf('https://a.dev', 'Nhà Xe Thịnh Phát', 'https://x/functions/v1/app-install', 't1', 's1', '9');
  assertEquals(m.short_name, 'Thịnh Phát');
  assertEquals(m.start_url, 'https://a.dev/');
  assertEquals(m.icons[0]!.src, 'https://x/functions/v1/app-install?t=t1&s=s1&z=192&v=9');
  assertEquals(m.icons[2]!.purpose, 'maskable');
});
