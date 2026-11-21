// Kiểm thử đầu-cuối Giai đoạn 2.2 (chạy trong CI với Supabase local + Edge Function).
// Biến môi trường: API_URL, ANON_KEY, SERVICE_ROLE_KEY (từ `supabase status -o env`).
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { loginEmail } from '../../functions/_shared/login.ts';

const API_URL = Deno.env.get('API_URL') ?? 'http://127.0.0.1:54321';
const ANON_KEY = Deno.env.get('ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SERVICE_ROLE_KEY') ?? '';
const DOMAIN = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'login.tms.invalid';
const FN_URL = `${API_URL}/functions/v1/admin-users`;

let failures = 0;
function check(cond: boolean, name: string, detail?: unknown) {
  if (cond) console.log(`ok - ${name}`);
  else {
    failures++;
    console.log(`not ok - ${name}`, detail ?? '');
  }
}

function anonClient(): SupabaseClient {
  return createClient(API_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function signIn(email: string, password: string): Promise<{ client: SupabaseClient; token: string }> {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Đăng nhập thất bại ${email}: ${error?.message}`);
  return { client, token: data.session.access_token };
}

async function callFn(token: string, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  const res = await fetch(FN_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const admin = createClient(API_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// 1. Khởi tạo hệ thống: Super Admin tự đăng ký bằng email thật rồi khởi tạo
const anon = anonClient();
const { data: initBefore } = await anon.rpc('platform_initialized');
check(initBefore === false, 'Hệ thống mới: chưa có Super Admin');

const superEmail = 'superadmin.e2e@gmail.com';
const { error: suErr } = await admin.auth.admin.createUser({ email: superEmail, password: 'Super@123', email_confirm: true });
check(!suErr, 'Tạo tài khoản Super Admin', suErr);
const sup = await signIn(superEmail, 'Super@123');
const { error: bootErr } = await sup.client.rpc('bootstrap_platform_admin');
check(!bootErr, 'Super Admin khởi tạo hệ thống', bootErr);
const { data: initAfter } = await anon.rpc('platform_initialized');
check(initAfter === true, 'Hệ thống đã khởi tạo');

// 2. Tạo 2 nhà xe + Chủ nhà xe
const { data: tenantA } = await sup.client.rpc('create_tenant', { p_code: 'thinh-phat', p_name: 'Nhà xe Thịnh Phát' });
const { data: tenantB } = await sup.client.rpc('create_tenant', { p_code: 'nha-xe-b', p_name: 'Nhà xe B' });
check(typeof tenantA === 'string' && typeof tenantB === 'string', 'Super Admin tạo 2 nhà xe');

let r = await callFn(sup.token, { action: 'create_tenant_owner', tenant_id: tenantA, phone: '0901000001',
  full_name: 'Chủ Thịnh Phát', password: 'chu123' });
check(r.status === 200, 'Super Admin tạo Chủ nhà xe A', r);
r = await callFn(sup.token, { action: 'create_tenant_owner', tenant_id: tenantB, phone: '0901000001',
  full_name: 'Chủ nhà xe B', password: 'chub123' });
check(r.status === 200, 'Cùng số điện thoại vẫn tạo được ở nhà xe khác', r);
r = await callFn(sup.token, { action: 'create_tenant_owner', tenant_id: tenantA, phone: '0901000009',
  full_name: 'Chủ thứ hai', password: 'chu2abc9' });
check(r.status === 409, 'Nhà xe đã có Chủ: Super Admin không thêm được tài khoản', r);

// 3. Chủ A đăng nhập bằng số điện thoại + mật khẩu
const ownerA = await signIn(loginEmail('0901000001', 'thinh-phat', DOMAIN), 'chu123');
const { data: ctxA } = await ownerA.client.rpc('my_account_context').single();
check((ctxA as any)?.tenant_code === 'thinh-phat' && (ctxA as any)?.can_manage_users === true,
  'Chủ A đăng nhập, đúng nhà xe, có quyền quản lý người dùng', ctxA);

// 4. Chủ A tạo nhân viên bán vé
r = await callFn(ownerA.token, { action: 'create_user', phone: '0902000002', full_name: 'Nhân viên bán vé',
  password: 'nv1234', role_code: 'seller' });
check(r.status === 200 && !r.data?.role_error, 'Chủ A tạo nhân viên bán vé', r);
const staffId = r.data?.user_id as string;

r = await callFn(ownerA.token, { action: 'create_user', phone: '0902000002', full_name: 'Trùng', password: 'abc123' });
check(r.status === 409, 'Không tạo trùng số điện thoại trong nhà xe', r);

r = await callFn(ownerA.token, { action: 'create_user', phone: '12345', full_name: 'Sai', password: 'abc123' });
check(r.status === 400, 'Chặn số điện thoại sai định dạng', r);

r = await callFn(ownerA.token, { action: 'create_user', phone: '0902000009', full_name: 'Vượt quyền',
  password: 'abc123', role_code: 'owner' });
check(r.status === 200, 'Tạo được tài khoản kèm vai trò Chủ nhà xe (do Chủ nhà xe tạo)', r);

// 5. Nhân viên đăng nhập, chỉ thấy chính mình, không quản lý được người dùng
const staff = await signIn(loginEmail('0902000002', 'thinh-phat', DOMAIN), 'nv1234');
const { data: staffUsers } = await staff.client.from('app_users').select('id');
check(staffUsers?.length === 1 && staffUsers[0].id === staffId, 'Nhân viên chỉ thấy hồ sơ của mình', staffUsers);
r = await callFn(staff.token, { action: 'create_user', phone: '0903000003', full_name: 'X', password: 'abc123' });
check(r.status === 403, 'Nhân viên không tạo được tài khoản', r);
r = await callFn(staff.token, { action: 'create_tenant_owner', tenant_id: tenantA, phone: '0903000004',
  full_name: 'X', password: 'abc123' });
check(r.status === 403, 'Nhân viên không tạo được Chủ nhà xe', r);

// 6. Đặt lại mật khẩu
r = await callFn(ownerA.token, { action: 'reset_password', user_id: staffId, password: 'moi12345' });
check(r.status === 200, 'Chủ A đặt lại mật khẩu nhân viên', r);
const relog = await anonClient().auth.signInWithPassword({
  email: loginEmail('0902000002', 'thinh-phat', DOMAIN), password: 'moi12345' });
check(!relog.error, 'Nhân viên đăng nhập bằng mật khẩu mới', relog.error);

// 7. Cách ly nhà xe: Chủ B không đụng được nhân viên nhà xe A
const ownerB = await signIn(loginEmail('0901000001', 'nha-xe-b', DOMAIN), 'chub123');
r = await callFn(ownerB.token, { action: 'reset_password', user_id: staffId, password: 'hack1234' });
check(r.status === 404, 'Chủ B không đặt lại được mật khẩu nhân viên nhà xe A', r);
const { data: bUsers } = await ownerB.client.from('app_users').select('id');
check(bUsers?.length === 1, 'Chủ B chỉ thấy người dùng nhà xe B', bUsers);

// 8. Không có phiên đăng nhập
const noAuth = await fetch(FN_URL, { method: 'POST', headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'create_user' }) });
check(noAuth.status === 401, 'Không đăng nhập thì bị từ chối', noAuth.status);

console.log(failures === 0 ? '\nTẤT CẢ ĐẠT' : `\n${failures} kiểm thử KHÔNG ĐẠT`);
Deno.exit(failures === 0 ? 0 : 1);
