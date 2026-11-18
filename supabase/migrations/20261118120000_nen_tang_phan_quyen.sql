-- =====================================================================
-- Giai đoạn 2.1 – Nền tảng: nhà xe, người dùng, vai trò, chi nhánh, phòng vé
-- Nguyên tắc: xem CLAUDE.md mục 4 (đa nhà xe).
-- =====================================================================

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. BẢNG
-- ---------------------------------------------------------------------

-- Nhà xe (tenant)
create table public.tenants (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique check (code ~ '^[a-z0-9-]{2,40}$'),
  name                  text not null check (length(trim(name)) > 0),
  legal_name            text,
  tax_code              text,
  transport_license_no  text,
  status                text not null default 'active' check (status in ('pending', 'active', 'suspended')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Super Admin của nền tảng (không mặc nhiên đọc dữ liệu nhà xe)
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);

-- Người dùng thuộc đúng 1 nhà xe; id = auth.users.id
create table public.app_users (
  id          uuid primary key references auth.users (id) on delete cascade,
  tenant_id   uuid not null references public.tenants (id),
  phone       text not null check (phone ~ '^0[0-9]{9}$'),
  full_name   text not null check (length(trim(full_name)) > 0),
  status      text not null default 'active' check (status in ('active', 'locked')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, phone)
);
create index app_users_tenant_status_idx on public.app_users (tenant_id, status);

-- Chi nhánh
create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  code        text not null check (length(trim(code)) > 0),
  name        text not null check (length(trim(name)) > 0),
  address     text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

-- Phòng vé (thuộc 1 chi nhánh cùng nhà xe – khóa kép)
create table public.ticket_offices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  branch_id   uuid not null,
  code        text not null check (length(trim(code)) > 0),
  name        text not null check (length(trim(name)) > 0),
  address     text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
);
create index ticket_offices_tenant_branch_idx on public.ticket_offices (tenant_id, branch_id);

-- Danh mục quyền (toàn nền tảng, do migration khai báo)
create table public.permissions (
  code        text primary key,
  module      text not null,
  name        text not null
);

-- Vai trò của từng nhà xe
create table public.roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  code        text not null check (code ~ '^[a-z0-9_]{2,40}$'),
  name        text not null check (length(trim(name)) > 0),
  is_system   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create table public.role_permissions (
  tenant_id        uuid not null,
  role_id          uuid not null,
  permission_code  text not null references public.permissions (code),
  primary key (tenant_id, role_id, permission_code),
  foreign key (tenant_id, role_id) references public.roles (tenant_id, id) on delete cascade
);

-- Gán vai trò + phạm vi: toàn nhà xe / 1 chi nhánh / 1 phòng vé
create table public.user_roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  user_id     uuid not null,
  role_id     uuid not null,
  scope_type  text not null check (scope_type in ('tenant', 'branch', 'ticket_office')),
  scope_id    uuid,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  check ((scope_type = 'tenant') = (scope_id is null)),
  unique nulls not distinct (tenant_id, user_id, role_id, scope_type, scope_id),
  foreign key (tenant_id, user_id) references public.app_users (tenant_id, id) on delete cascade,
  foreign key (tenant_id, role_id) references public.roles (tenant_id, id)
);
create index user_roles_tenant_user_idx on public.user_roles (tenant_id, user_id);

-- Cấu hình nhà xe (tên hiển thị, logo, thời gian giữ ghế…)
create table public.tenant_settings (
  tenant_id   uuid not null references public.tenants (id),
  key         text not null check (key ~ '^[a-z0-9_.]{2,80}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (tenant_id, key)
);

-- Nhật ký thao tác: chỉ thêm, không sửa/xóa
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  tenant_id   uuid,
  actor_id    uuid,
  action      text not null,
  entity      text not null,
  entity_id   text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_tenant_time_idx on public.audit_logs (tenant_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2. HÀM PHÂN QUYỀN (đọc danh tính từ phiên đăng nhập, không từ tham số)
-- ---------------------------------------------------------------------

create function app.current_tenant_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select u.tenant_id
  from public.app_users u
  join public.tenants t on t.id = u.tenant_id
  where u.id = auth.uid() and u.status = 'active' and t.status = 'active'
$$;

create function app.is_platform_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- Có quyền p_perm trên phạm vi (toàn nhà xe, hoặc chi nhánh / phòng vé chỉ định)?
create function app.has_permission(p_perm text, p_branch_id uuid default null, p_office_id uuid default null)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with me as (select app.current_tenant_id() as tid),
  office_branch as (
    select o.branch_id from public.ticket_offices o, me
    where p_office_id is not null and o.id = p_office_id and o.tenant_id = me.tid
  )
  select exists (
    select 1
    from me
    join public.user_roles ur on ur.tenant_id = me.tid and ur.user_id = auth.uid()
    join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
    where rp.permission_code = p_perm
      and (
        ur.scope_type = 'tenant'
        or (ur.scope_type = 'branch' and ur.scope_id = p_branch_id)
        or (ur.scope_type = 'branch' and ur.scope_id in (select branch_id from office_branch))
        or (ur.scope_type = 'ticket_office' and ur.scope_id = p_office_id)
      )
  )
$$;

-- Tập quyền toàn nhà xe của người đang đăng nhập (dùng chống tự nâng quyền)
create function app.my_tenant_permissions()
returns setof text
language sql stable security definer set search_path = ''
as $$
  select distinct rp.permission_code
  from public.user_roles ur
  join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
  where ur.user_id = auth.uid()
    and ur.tenant_id = app.current_tenant_id()
    and ur.scope_type = 'tenant'
$$;

grant execute on function app.current_tenant_id(), app.is_platform_admin(),
  app.has_permission(text, uuid, uuid), app.my_tenant_permissions() to authenticated;

-- ---------------------------------------------------------------------
-- 3. TRIGGER: updated_at + nhật ký thao tác
-- ---------------------------------------------------------------------

create function app.touch_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function app.write_audit()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(coalesce(new, old));
  v_tenant uuid := coalesce(
    (v_row ->> 'tenant_id')::uuid,
    case when tg_table_name = 'tenants' then (v_row ->> 'id')::uuid end
  );
begin
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (
    v_tenant,
    auth.uid(),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'key', v_row ->> 'role_id'),
    case tg_op
      when 'INSERT' then jsonb_build_object('new', to_jsonb(new))
      when 'UPDATE' then jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
      else jsonb_build_object('old', to_jsonb(old))
    end
  );
  return coalesce(new, old);
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['tenants', 'app_users', 'branches', 'ticket_offices', 'roles'] loop
    execute format('create trigger %I before update on public.%I for each row execute function app.touch_updated_at()',
                   t || '_touch', t);
  end loop;
  foreach t in array array['tenants', 'app_users', 'branches', 'ticket_offices', 'roles',
                           'role_permissions', 'user_roles', 'tenant_settings', 'platform_admins'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.write_audit()',
                   t || '_audit', t);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY + QUYỀN TRUY CẬP
-- Ghi chú: bật ENABLE, không FORCE. Hàm SECURITY DEFINER (chủ sở hữu bảng)
-- cần đọc/ghi để kiểm tra quyền; FORCE sẽ chặn chính các hàm đó hoặc gây vòng
-- lặp policy. App không bao giờ kết nối bằng chủ sở hữu bảng: trình duyệt dùng
-- role authenticated nên luôn chịu RLS đầy đủ.
-- ---------------------------------------------------------------------

alter table public.tenants           enable row level security;
alter table public.platform_admins   enable row level security;
alter table public.app_users         enable row level security;
alter table public.branches          enable row level security;
alter table public.ticket_offices    enable row level security;
alter table public.permissions       enable row level security;
alter table public.roles             enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.user_roles        enable row level security;
alter table public.tenant_settings   enable row level security;
alter table public.audit_logs        enable row level security;

-- Không mở mặc định: thu hồi hết rồi cấp tường minh
revoke all on public.tenants, public.platform_admins, public.app_users, public.branches,
  public.ticket_offices, public.permissions, public.roles, public.role_permissions,
  public.user_roles, public.tenant_settings, public.audit_logs from anon, authenticated;

grant select on public.tenants, public.platform_admins, public.app_users, public.branches,
  public.ticket_offices, public.permissions, public.roles, public.role_permissions,
  public.user_roles, public.tenant_settings, public.audit_logs to authenticated;
grant insert, update on public.branches, public.ticket_offices, public.tenant_settings to authenticated;

-- Nhà xe: thấy nhà xe của mình; Super Admin thấy thông tin nhà xe (không phải dữ liệu nghiệp vụ)
create policy tenants_select on public.tenants for select to authenticated
  using (id = app.current_tenant_id() or app.is_platform_admin());

create policy platform_admins_select on public.platform_admins for select to authenticated
  using (user_id = auth.uid());

-- Người dùng: luôn thấy chính mình; thấy người khác khi có quyền user.read
create policy app_users_select on public.app_users for select to authenticated
  using (id = auth.uid()
         or (tenant_id = app.current_tenant_id() and app.has_permission('user.read')));

-- Chi nhánh
create policy branches_select on public.branches for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy branches_insert on public.branches for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('branch.manage'));
create policy branches_update on public.branches for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('branch.manage', id))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('branch.manage', id));

-- Phòng vé
create policy ticket_offices_select on public.ticket_offices for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy ticket_offices_insert on public.ticket_offices for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('office.manage', branch_id));
create policy ticket_offices_update on public.ticket_offices for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('office.manage', branch_id, id))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('office.manage', branch_id, id));

-- Danh mục quyền: ai đăng nhập cũng đọc được
create policy permissions_select on public.permissions for select to authenticated using (true);

-- Vai trò: đọc trong nhà xe; ghi chỉ qua RPC
create policy roles_select on public.roles for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy role_permissions_select on public.role_permissions for select to authenticated
  using (tenant_id = app.current_tenant_id());

-- Gán vai trò: thấy của mình, hoặc của người khác khi có user.read
create policy user_roles_select on public.user_roles for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (user_id = auth.uid() or app.has_permission('user.read')));

-- Cấu hình nhà xe
create policy tenant_settings_select on public.tenant_settings for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy tenant_settings_insert on public.tenant_settings for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('settings.manage'));
create policy tenant_settings_update on public.tenant_settings for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('settings.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('settings.manage'));

-- Nhật ký: chỉ người có quyền audit.read trong nhà xe
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('audit.read'));

-- tenant_id tự điền theo người đang đăng nhập (client không cần gửi)
alter table public.branches        alter column tenant_id set default app.current_tenant_id();
alter table public.ticket_offices  alter column tenant_id set default app.current_tenant_id();
alter table public.tenant_settings alter column tenant_id set default app.current_tenant_id();

-- ---------------------------------------------------------------------
-- 5. DANH MỤC QUYỀN (dữ liệu danh mục hệ thống, không phải dữ liệu mẫu)
-- ---------------------------------------------------------------------

insert into public.permissions (code, module, name) values
  ('settings.manage', 'nen_tang', 'Cấu hình nhà xe'),
  ('branch.manage',   'nen_tang', 'Quản lý chi nhánh'),
  ('office.manage',   'nen_tang', 'Quản lý phòng vé'),
  ('user.read',       'nen_tang', 'Xem người dùng'),
  ('user.manage',     'nen_tang', 'Quản lý người dùng'),
  ('role.manage',     'nen_tang', 'Quản lý vai trò'),
  ('audit.read',      'nen_tang', 'Xem nhật ký thao tác');

-- ---------------------------------------------------------------------
-- 6. HÀM NGHIỆP VỤ (RPC)
-- ---------------------------------------------------------------------

-- 6.1 Khởi tạo Super Admin – chỉ chạy được 1 lần cho cả nền tảng
create function public.bootstrap_platform_admin()
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Chưa đăng nhập' using errcode = '28000';
  end if;
  lock table public.platform_admins in exclusive mode;
  if exists (select 1 from public.platform_admins) then
    raise exception 'Hệ thống đã được khởi tạo' using errcode = '42501';
  end if;
  insert into public.platform_admins (user_id) values (auth.uid());
end;
$$;

-- Vai trò hệ thống mẫu của mỗi nhà xe (quyền nghiệp vụ bổ sung ở các module sau)
create function app.seed_system_roles(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid; v_admin uuid; v_branch uuid;
begin
  insert into public.roles (tenant_id, code, name, is_system) values
    (p_tenant_id, 'owner',          'Chủ nhà xe',         true),
    (p_tenant_id, 'admin',          'Quản trị',            true),
    (p_tenant_id, 'branch_manager', 'Quản lý chi nhánh',   true),
    (p_tenant_id, 'office_manager', 'Quản lý phòng vé',    true),
    (p_tenant_id, 'seller',         'Bán vé',              true),
    (p_tenant_id, 'dispatcher',     'Điều hành',           true),
    (p_tenant_id, 'accountant',     'Kế toán',             true),
    (p_tenant_id, 'driver',         'Lái xe',              true),
    (p_tenant_id, 'staff',          'Nhân viên',           true);

  select id into v_owner  from public.roles where tenant_id = p_tenant_id and code = 'owner';
  select id into v_admin  from public.roles where tenant_id = p_tenant_id and code = 'admin';
  select id into v_branch from public.roles where tenant_id = p_tenant_id and code = 'branch_manager';

  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, p.code
  from (values (v_owner), (v_admin)) as r(id), public.permissions p;

  insert into public.role_permissions (tenant_id, role_id, permission_code) values
    (p_tenant_id, v_branch, 'office.manage'),
    (p_tenant_id, v_branch, 'user.read');
end;
$$;

-- 6.2 Tạo nhà xe – chỉ Super Admin
create function public.create_tenant(p_code text, p_name text, p_legal_name text default null,
                                     p_tax_code text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'Không có quyền tạo nhà xe' using errcode = '42501';
  end if;
  insert into public.tenants (code, name, legal_name, tax_code)
  values (lower(trim(p_code)), trim(p_name), p_legal_name, p_tax_code)
  returning id into v_id;
  perform app.seed_system_roles(v_id);
  return v_id;
end;
$$;

-- 6.3 Đăng ký người dùng vào nhà xe – chỉ Edge Function (service_role) gọi,
--     sau khi đã tạo tài khoản đăng nhập. Không mở cho trình duyệt.
create function public.svc_register_app_user(p_user_id uuid, p_tenant_id uuid, p_phone text,
                                             p_full_name text, p_role_code text default null)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_role uuid;
begin
  insert into public.app_users (id, tenant_id, phone, full_name)
  values (p_user_id, p_tenant_id, p_phone, trim(p_full_name));

  if p_role_code is not null then
    select id into v_role from public.roles where tenant_id = p_tenant_id and code = p_role_code;
    if v_role is null then
      raise exception 'Không tìm thấy vai trò %', p_role_code using errcode = 'P0002';
    end if;
    insert into public.user_roles (tenant_id, user_id, role_id, scope_type)
    values (p_tenant_id, p_user_id, v_role, 'tenant');
  end if;
end;
$$;

-- Kiểm tra: người gọi có user.manage toàn nhà xe, và mục tiêu thuộc cùng nhà xe
create function app.require_user_manager(p_target_user uuid)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('user.manage') then
    raise exception 'Không có quyền quản lý người dùng' using errcode = '42501';
  end if;
  if not exists (select 1 from public.app_users where id = p_target_user and tenant_id = v_tid) then
    raise exception 'Không tìm thấy người dùng' using errcode = 'P0002';
  end if;
  return v_tid;
end;
$$;

-- Còn ít nhất 1 Chủ nhà xe đang hoạt động (ngoài trừ người/gán bị loại)?
create function app.other_active_owner_exists(p_tenant_id uuid, p_exclude_user uuid, p_exclude_user_role uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles ur
    join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.code = 'owner'
    join public.app_users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.status = 'active'
    where ur.tenant_id = p_tenant_id and ur.scope_type = 'tenant'
      and ur.user_id is distinct from p_exclude_user
      and ur.id is distinct from p_exclude_user_role
  )
$$;

-- 6.4 Gán vai trò (chống tự nâng quyền)
create function public.assign_role(p_user_id uuid, p_role_id uuid, p_scope_type text default 'tenant',
                                   p_scope_id uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.require_user_manager(p_user_id);
  v_id uuid;
begin
  if p_user_id = auth.uid() then
    raise exception 'Không được tự gán vai trò cho chính mình' using errcode = '42501';
  end if;
  if not exists (select 1 from public.roles where id = p_role_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy vai trò' using errcode = 'P0002';
  end if;
  -- Chỉ được cấp những quyền mình đang có
  if exists (
    select 1 from public.role_permissions rp
    where rp.tenant_id = v_tid and rp.role_id = p_role_id
      and rp.permission_code not in (select app.my_tenant_permissions())
  ) then
    raise exception 'Không được cấp quyền vượt quá quyền của mình' using errcode = '42501';
  end if;
  -- Phạm vi phải thuộc cùng nhà xe
  if p_scope_type = 'branch' and not exists (
       select 1 from public.branches where id = p_scope_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy chi nhánh' using errcode = 'P0002';
  elsif p_scope_type = 'ticket_office' and not exists (
       select 1 from public.ticket_offices where id = p_scope_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy phòng vé' using errcode = 'P0002';
  elsif p_scope_type not in ('tenant', 'branch', 'ticket_office') then
    raise exception 'Phạm vi không hợp lệ' using errcode = '22023';
  end if;

  insert into public.user_roles (tenant_id, user_id, role_id, scope_type, scope_id, created_by)
  values (v_tid, p_user_id, p_role_id, p_scope_type,
          case when p_scope_type = 'tenant' then null else p_scope_id end, auth.uid())
  on conflict do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- 6.5 Thu hồi vai trò (không được bỏ Chủ nhà xe cuối cùng)
create function public.revoke_role(p_user_role_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_ur public.user_roles;
  v_tid uuid;
begin
  select * into v_ur from public.user_roles where id = p_user_role_id and tenant_id = app.current_tenant_id();
  if v_ur.id is null then
    raise exception 'Không tìm thấy' using errcode = 'P0002';
  end if;
  v_tid := app.require_user_manager(v_ur.user_id);
  if v_ur.user_id = auth.uid() then
    raise exception 'Không được tự thu hồi vai trò của mình' using errcode = '42501';
  end if;
  if exists (select 1 from public.roles where id = v_ur.role_id and code = 'owner')
     and v_ur.scope_type = 'tenant'
     and not app.other_active_owner_exists(v_tid, null, v_ur.id) then
    raise exception 'Nhà xe phải còn ít nhất 1 Chủ nhà xe' using errcode = '42501';
  end if;
  delete from public.user_roles where id = v_ur.id;
end;
$$;

-- 6.6 Khóa / mở tài khoản
create function public.set_user_status(p_user_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.require_user_manager(p_user_id);
begin
  if p_status not in ('active', 'locked') then
    raise exception 'Trạng thái không hợp lệ' using errcode = '22023';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'Không được tự khóa tài khoản của mình' using errcode = '42501';
  end if;
  if p_status = 'locked' and not app.other_active_owner_exists(v_tid, p_user_id, null) then
    raise exception 'Nhà xe phải còn ít nhất 1 Chủ nhà xe' using errcode = '42501';
  end if;
  update public.app_users set status = p_status where id = p_user_id and tenant_id = v_tid;
end;
$$;

-- 6.7 Tạo vai trò mới / đặt quyền cho vai trò
create function public.create_role(p_code text, p_name text, p_permissions text[])
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
begin
  if v_tid is null or not app.has_permission('role.manage') then
    raise exception 'Không có quyền quản lý vai trò' using errcode = '42501';
  end if;
  if exists (select unnest(p_permissions) except select app.my_tenant_permissions()) then
    raise exception 'Không được cấp quyền vượt quá quyền của mình' using errcode = '42501';
  end if;
  insert into public.roles (tenant_id, code, name) values (v_tid, lower(trim(p_code)), trim(p_name))
  returning id into v_id;
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select v_tid, v_id, unnest(p_permissions);
  return v_id;
end;
$$;

create function public.set_role_permissions(p_role_id uuid, p_permissions text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('role.manage') then
    raise exception 'Không có quyền quản lý vai trò' using errcode = '42501';
  end if;
  if not exists (select 1 from public.roles where id = p_role_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy vai trò' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.roles where id = p_role_id and code = 'owner') then
    raise exception 'Không được sửa quyền của Chủ nhà xe' using errcode = '42501';
  end if;
  if exists (select unnest(p_permissions) except select app.my_tenant_permissions()) then
    raise exception 'Không được cấp quyền vượt quá quyền của mình' using errcode = '42501';
  end if;
  delete from public.role_permissions where tenant_id = v_tid and role_id = p_role_id;
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select v_tid, p_role_id, unnest(p_permissions);
end;
$$;

-- Quyền gọi hàm: chỉ người đã đăng nhập; hàm svc_ chỉ service_role
revoke execute on function public.bootstrap_platform_admin(), public.create_tenant(text, text, text, text),
  public.svc_register_app_user(uuid, uuid, text, text, text), public.assign_role(uuid, uuid, text, uuid),
  public.revoke_role(uuid), public.set_user_status(uuid, text), public.create_role(text, text, text[]),
  public.set_role_permissions(uuid, text[]) from public, anon;

grant execute on function public.bootstrap_platform_admin(), public.create_tenant(text, text, text, text),
  public.assign_role(uuid, uuid, text, uuid), public.revoke_role(uuid), public.set_user_status(uuid, text),
  public.create_role(text, text, text[]), public.set_role_permissions(uuid, text[]) to authenticated;

grant execute on function public.svc_register_app_user(uuid, uuid, text, text, text) to service_role;

revoke execute on function app.seed_system_roles(uuid), app.require_user_manager(uuid),
  app.other_active_owner_exists(uuid, uuid, uuid), app.touch_updated_at(), app.write_audit()
  from public, anon, authenticated;
