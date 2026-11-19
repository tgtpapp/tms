// Edge Function: quản lý tài khoản đăng nhập bằng số điện thoại + mật khẩu (không SMS).
// - create_tenant_owner: Super Admin tạo Chủ nhà xe
// - create_user:         người có quyền user.manage tạo nhân viên trong nhà xe của mình
// - reset_password:      người có quyền user.manage đặt lại mật khẩu nhân viên nhà xe mình
// Quyền luôn kiểm tra bằng phiên đăng nhập của người gọi; khóa service_role chỉ dùng ở đây.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import { loginEmail } from '../_shared/login.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const LOGIN_DOMAIN = Deno.env.get('LOGIN_EMAIL_DOMAIN') ?? 'login.tms.invalid';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PHONE_RE = /^0[0-9]{9}$/;
const MIN_PASSWORD = 6;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface AccountContext {
  user_id: string | null;
  tenant_id: string | null;
  tenant_code: string | null;
  can_manage_users: boolean;
  is_platform_admin: boolean;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new HttpError(400, `Thiếu ${key}`);
  return v.trim();
}

function validatePhone(phone: string): string {
  if (!PHONE_RE.test(phone)) throw new HttpError(400, 'Số điện thoại phải gồm 10 số, bắt đầu bằng 0');
  return phone;
}

function validatePassword(pw: string): string {
  if (pw.length < MIN_PASSWORD) throw new HttpError(400, `Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
  return pw;
}

async function callerContext(userClient: SupabaseClient): Promise<AccountContext> {
  const { data, error } = await userClient.rpc('my_account_context').single();
  if (error || !data) throw new HttpError(401, 'Phiên đăng nhập không hợp lệ');
  const ctx = data as AccountContext;
  if (!ctx.user_id) throw new HttpError(401, 'Phiên đăng nhập không hợp lệ');
  return ctx;
}

// Tạo tài khoản đăng nhập + đăng ký vào nhà xe; lỗi giữa chừng thì xóa tài khoản vừa tạo.
async function createMember(admin: SupabaseClient, tenantId: string, tenantCode: string, phone: string,
                            fullName: string, password: string, roleCode: string | null): Promise<string> {
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail(phone, tenantCode, LOGIN_DOMAIN),
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName, phone, tenant_code: tenantCode },
  });
  if (createErr || !created.user) {
    const msg = createErr?.message ?? '';
    if (/already|exists|registered/i.test(msg)) throw new HttpError(409, 'Số điện thoại đã có tài khoản trong nhà xe');
    throw new HttpError(400, `Không tạo được tài khoản: ${msg}`);
  }
  const userId = created.user.id;

  const { error: regErr } = await admin.rpc('svc_register_app_user', {
    p_user_id: userId,
    p_tenant_id: tenantId,
    p_phone: phone,
    p_full_name: fullName,
    p_role_code: roleCode,
  });
  if (regErr) {
    await admin.auth.admin.deleteUser(userId);
    if (regErr.code === '23505') throw new HttpError(409, 'Số điện thoại đã có trong nhà xe');
    throw new HttpError(400, `Không đăng ký được người dùng: ${regErr.message}`);
  }
  return userId;
}

async function handle(req: Request): Promise<Response> {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) throw new HttpError(500, 'Thiếu cấu hình máy chủ');

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) throw new HttpError(401, 'Chưa đăng nhập');

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = body.action;
  const ctx = await callerContext(userClient);

  switch (action) {
    case 'create_tenant_owner': {
      if (!ctx.is_platform_admin) throw new HttpError(403, 'Chỉ Super Admin được tạo Chủ nhà xe');
      const tenantId = requireString(body, 'tenant_id');
      const { data: tenant, error: tErr } = await admin.from('tenants').select('id, code').eq('id', tenantId).maybeSingle();
      if (tErr) throw new HttpError(500, `Lỗi đọc dữ liệu nhà xe: ${tErr.message}`);
      if (!tenant) throw new HttpError(404, 'Không tìm thấy nhà xe');
      const userId = await createMember(admin, tenant.id, tenant.code,
        validatePhone(requireString(body, 'phone')), requireString(body, 'full_name'),
        validatePassword(requireString(body, 'password')), 'owner');
      return json(200, { user_id: userId });
    }

    case 'create_user': {
      if (!ctx.tenant_id || !ctx.tenant_code || !ctx.can_manage_users) {
        throw new HttpError(403, 'Không có quyền quản lý người dùng');
      }
      const userId = await createMember(admin, ctx.tenant_id, ctx.tenant_code,
        validatePhone(requireString(body, 'phone')), requireString(body, 'full_name'),
        validatePassword(requireString(body, 'password')), null);

      // Gán vai trò bằng phiên của người gọi: hàm assign_role tự chặn vượt quyền.
      const roleCode = typeof body.role_code === 'string' ? body.role_code : null;
      if (roleCode) {
        const { data: role } = await userClient.from('roles').select('id').eq('code', roleCode).maybeSingle();
        if (!role) return json(200, { user_id: userId, role_error: 'Không tìm thấy vai trò' });
        const { error } = await userClient.rpc('assign_role', { p_user_id: userId, p_role_id: role.id });
        if (error) return json(200, { user_id: userId, role_error: error.message });
      }
      return json(200, { user_id: userId });
    }

    case 'reset_password': {
      if (!ctx.tenant_id || !ctx.can_manage_users) throw new HttpError(403, 'Không có quyền quản lý người dùng');
      const userId = requireString(body, 'user_id');
      const { data: target, error: uErr } = await admin.from('app_users').select('id, tenant_id').eq('id', userId).maybeSingle();
      if (uErr) throw new HttpError(500, `Lỗi đọc dữ liệu người dùng: ${uErr.message}`);
      if (!target || target.tenant_id !== ctx.tenant_id) throw new HttpError(404, 'Không tìm thấy người dùng');
      const { error } = await admin.auth.admin.updateUserById(userId, {
        password: validatePassword(requireString(body, 'password')),
      });
      if (error) throw new HttpError(400, `Không đặt lại được mật khẩu: ${error.message}`);
      return json(200, { ok: true });
    }

    default:
      throw new HttpError(400, 'Hành động không hợp lệ');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Chỉ hỗ trợ POST' });
  try {
    return await handle(req);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Lỗi máy chủ' });
  }
});
