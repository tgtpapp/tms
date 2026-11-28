// Kiểm thử lõi Facebook bằng fetch giả (không gọi Facebook thật): phiên bản API, nội dung, link, đăng bài (kèm ảnh), tên trang, link bài.
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import {
  apiVersion, FacebookError, graphUrl, pageName, postUrl, publishPost, sanitizeLink, sanitizeMessage, uploadPhoto,
} from '../../functions/_shared/facebook.ts';

Deno.test('Phiên bản Graph API: chuẩn hóa về dạng v*, sai / trống → mặc định', () => {
  assertEquals(apiVersion(undefined), 'v22.0');
  assertEquals(apiVersion(''), 'v22.0');
  assertEquals(apiVersion('21.0'), 'v21.0');
  assertEquals(apiVersion('v21.0'), 'v21.0');
  assertEquals(apiVersion('không rõ'), 'v22.0');
});

Deno.test('Địa chỉ Graph: gắn đúng phiên bản, bỏ dấu gạch chéo đầu', () => {
  assertEquals(graphUrl('v22.0', '/123/feed'), 'https://graph.facebook.com/v22.0/123/feed');
});

Deno.test('Nội dung bài: cắt khoảng trắng, chặn rỗng và quá 5000 ký tự', () => {
  assertEquals(sanitizeMessage('  tuyến  mới   đã mở  '), 'tuyến mới đã mở');
  assertEquals(sanitizeMessage(null), null);
  assertEquals(sanitizeMessage('   \n  '), null);
  assertEquals(sanitizeMessage('a'.repeat(5001)), null);
  assertEquals(sanitizeMessage('a'.repeat(5000)), 'a'.repeat(5000));
});

Deno.test('Link kèm bài: chỉ nhận https, đủ dấu /', () => {
  assertEquals(sanitizeLink('https://example.com/x'), 'https://example.com/x');
  assertEquals(sanitizeLink('  https://example.com  '), 'https://example.com/');
  assertEquals(sanitizeLink('http://example.com'), null);
  assertEquals(sanitizeLink('không phải link'), null);
  assertEquals(sanitizeLink(undefined), null);
});

function fakeFetch(handler: (url: string, init: RequestInit) => unknown, status = 200) {
  const orig = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(new Response(JSON.stringify(handler(String(input), init ?? {})), { status }))) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

Deno.test('Đăng bài: đúng địa chỉ, mã trang trong thân, đọc mã bài', async () => {
  let url = '';
  let form = new URLSearchParams();
  const restore = fakeFetch((u, init) => {
    url = u;
    form = new URLSearchParams(String(init.body));
    return { id: '123_456' };
  });
  try {
    const id = await publishPost('v22.0', '123', 'tok', 'Tuyến mới đã mở', 'https://example.com');
    assertEquals(id, '123_456');
    assertEquals(url, 'https://graph.facebook.com/v22.0/123/feed');
    assertEquals(form.get('message'), 'Tuyến mới đã mở');
    assertEquals(form.get('access_token'), 'tok');
    assertEquals(form.get('link'), 'https://example.com');
  } finally { restore(); }
});

Deno.test('Đăng bài không kèm link: không gửi tham số link', async () => {
  let form = new URLSearchParams();
  const restore = fakeFetch((_u, init) => {
    form = new URLSearchParams(String(init.body));
    return { id: '123_789' };
  });
  try {
    await publishPost('v22.0', '123', 'tok', 'Chào', null);
    assertEquals(form.get('link'), null);
  } finally { restore(); }
});

Deno.test('Đăng ảnh (chưa công khai): đúng địa chỉ, mã trang trong thân, ảnh đúng loại, đọc mã ảnh', async () => {
  let url = '';
  let form = new FormData();
  const restore = fakeFetch((u, init) => {
    url = u;
    form = init.body as FormData;
    return { id: '999' };
  });
  try {
    const id = await uploadPhoto('v22.0', '123', 'tok', 'image/png', new Uint8Array([1, 2, 3]));
    assertEquals(id, '999');
    assertEquals(url, 'https://graph.facebook.com/v22.0/123/photos');
    assertEquals(form.get('access_token'), 'tok');
    assertEquals(form.get('published'), 'false');
    assertEquals((form.get('source') as File).type, 'image/png');
  } finally { restore(); }
});

Deno.test('Đăng ảnh loại không rõ → gửi như ảnh JPEG', async () => {
  let form = new FormData();
  const restore = fakeFetch((_u, init) => {
    form = init.body as FormData;
    return { id: '998' };
  });
  try {
    await uploadPhoto('v22.0', '123', 'tok', 'application/octet-stream', new Uint8Array([1]));
    assertEquals((form.get('source') as File).type, 'image/jpeg');
  } finally { restore(); }
});

Deno.test('Đăng bài nhiều ảnh: gộp các mã ảnh đã tải thành 1 bài, không kèm link', async () => {
  let form = new URLSearchParams();
  const restore = fakeFetch((_u, init) => {
    form = new URLSearchParams(String(init.body));
    return { id: '123_456' };
  });
  try {
    await publishPost('v22.0', '123', 'tok', 'Chào', null, ['111', '222']);
    assertEquals(form.get('attached_media[0]'), '{"media_fbid":"111"}');
    assertEquals(form.get('attached_media[1]'), '{"media_fbid":"222"}');
    assertEquals(form.get('attached_media[2]'), null);
    assertEquals(form.get('link'), null);
  } finally { restore(); }
});

Deno.test('Facebook từ chối: ném FacebookError với mã lỗi', async () => {
  const restore = fakeFetch(() => ({ error: { message: 'mã truy cập sai', code: 190 } }), 400);
  try {
    await assertRejects(() => publishPost('v22.0', '123', 'sai', 'Chào', null), FacebookError, 'mã truy cập sai');
  } finally { restore(); }
});

Deno.test('Tên trang: đọc đúng, lỗi → null', async () => {
  let url = '';
  const restore = fakeFetch((u) => {
    url = u;
    return { name: 'Nhà xe Thịnh Phát', id: '123' };
  });
  try {
    assertEquals(await pageName('v22.0', '123', 'tok'), 'Nhà xe Thịnh Phát');
    assert(url.startsWith('https://graph.facebook.com/v22.0/123?'));
    assertEquals(new URL(url).searchParams.get('fields'), 'name');
    assertEquals(new URL(url).searchParams.get('access_token'), 'tok');
  } finally { restore(); }
  const fail = fakeFetch(() => ({ error: { message: 'hết hạn', code: 190 } }), 401);
  try {
    assertEquals(await pageName('v22.0', '123', 'tok'), null);
  } finally { fail(); }
});

Deno.test('Link bài: tách mã bài từ dạng PAGEID_POSTID', () => {
  assertEquals(postUrl('123', '123_456'), 'https://www.facebook.com/123/posts/456');
  assertEquals(postUrl('123', '456'), 'https://www.facebook.com/123/posts/456');
});