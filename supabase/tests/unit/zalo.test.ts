// Kiểm thử lõi Zalo bằng fetch giả (không gọi Zalo thật): PKCE, số điện thoại, link cấp quyền, gửi ZNS, làm mới mã.
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { authorizeUrl, pkceChallenge, refreshTokens, sendZns, znsPhone, ZaloError } from '../../functions/_shared/zalo.ts';

Deno.test('PKCE: SHA-256 + base64url không dấu =', async () => {
  assertEquals(await pkceChallenge('dBjftJeZ4CVP-mJ92K9eNodGLsgRK4uJn1OAHsP6k6E'), 'HQWxTkcKn2WhsPgUnHFSJD3BbksZtc0O-QuvgdW68sI');
});

Deno.test('Số điện thoại sang dạng 84', () => {
  assertEquals(znsPhone('0912 345 678'), '84912345678');
  assertEquals(znsPhone('84912345678'), '84912345678');
});

Deno.test('Link cấp quyền có đủ tham số', () => {
  const u = new URL(authorizeUrl('123', 'https://x.supabase.co/functions/v1/zalo', 'ch', 'st'));
  assertEquals(u.searchParams.get('app_id'), '123');
  assertEquals(u.searchParams.get('redirect_uri'), 'https://x.supabase.co/functions/v1/zalo');
  assertEquals(u.searchParams.get('code_challenge'), 'ch');
  assertEquals(u.searchParams.get('state'), 'st');
});

function fakeFetch(handler: (url: string, init: RequestInit) => unknown) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(handler(String(input), init ?? {})), { status: 200 }))) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

Deno.test('Gửi ZNS: đúng định dạng, đọc msg_id', async () => {
  let body: Record<string, unknown> = {};
  let token = '';
  const restore = fakeFetch((_u, init) => {
    body = JSON.parse(String(init.body));
    token = new Headers(init.headers).get('access_token') ?? '';
    return { error: 0, message: 'Success', data: { msg_id: 'm1' } };
  });
  try {
    const r = await sendZns('tok', '0912345678', 'tpl', { ma_ve: 'AB12' }, 'trk');
    assert(r.ok);
    assertEquals(r.msg_id, 'm1');
    assertEquals(token, 'tok');
    assertEquals(body, { phone: '84912345678', template_id: 'tpl', template_data: { ma_ve: 'AB12' }, tracking_id: 'trk' });
  } finally { restore(); }
});

Deno.test('Gửi ZNS lỗi: trả mã lỗi Zalo', async () => {
  const restore = fakeFetch(() => ({ error: -124, message: 'Access token invalid' }));
  try {
    const r = await sendZns('tok', '0912345678', 'tpl', {}, 'trk');
    assertEquals(r.ok, false);
    assertEquals(r.code, -124);
  } finally { restore(); }
});

Deno.test('Làm mới mã: thành công và lỗi', async () => {
  let restore = fakeFetch((_u, init) => {
    assertEquals(new Headers(init.headers).get('secret_key'), 'sec');
    assertEquals(new URLSearchParams(String(init.body)).get('grant_type'), 'refresh_token');
    return { access_token: 'a2', refresh_token: 'r2', expires_in: '90000' };
  });
  try {
    const t = await refreshTokens('app', 'sec', 'r1');
    assertEquals(t.access_token, 'a2');
    assert(t.expires_at.getTime() > Date.now() + 89000e3);
  } finally { restore(); }
  restore = fakeFetch(() => ({ error: -14014, error_name: 'Invalid refresh token' }));
  try {
    await assertRejects(() => refreshTokens('app', 'sec', 'r1'), ZaloError);
  } finally { restore(); }
});
