-- =====================================================================
-- Lưu trữ hồ sơ (như app cũ): cây thư mục nhiều cấp theo năm, hồ sơ là tệp hoặc liên kết,
-- có ngày hết hạn, ghi chú, người / giờ tải lên, thay bản mới (bản cũ ẩn / hiện), tìm kiếm.
-- - Mỗi nhà xe một kho riêng. Tệp lưu trên Google Drive CỦA NHÀ XE qua Apps Script (giống app cũ):
--   địa chỉ Web app + mã kết nối nhập ở Cấu hình, lưu ở bảng tenant_drive (chỉ máy chủ đọc được, trình duyệt không đọc lại),
--   mọi lệnh tải lên / tải xuống / xóa tệp đi qua Edge Function "drive".
-- - Quyền: archive.view (xem, tải xuống), archive.manage (thêm, sửa, chuyển, xóa).
-- - Năm = thư mục gốc có tên 4 chữ số.
-- =====================================================================

insert into public.permissions (code, module, name) values
  ('archive.view',   'luu_tru', 'Lưu trữ hồ sơ: xem, tải xuống'),
  ('archive.manage', 'luu_tru', 'Lưu trữ hồ sơ: thêm, sửa, chuyển, xóa');
select app.grant_permission_to_admins('archive.view');
select app.grant_permission_to_admins('archive.manage');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'archive.view' from public.roles r where r.code in ('branch_manager', 'office_manager', 'dispatcher', 'accountant')
on conflict do nothing;

create or replace function app.seed_system_roles(p_tenant_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_owner uuid; v_admin uuid; v_branch uuid; v_disp uuid; v_office uuid; v_seller uuid; v_acc uuid;
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
  select id into v_disp   from public.roles where tenant_id = p_tenant_id and code = 'dispatcher';
  select id into v_office from public.roles where tenant_id = p_tenant_id and code = 'office_manager';
  select id into v_seller from public.roles where tenant_id = p_tenant_id and code = 'seller';
  select id into v_acc    from public.roles where tenant_id = p_tenant_id and code = 'accountant';

  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select p_tenant_id, r.id, p.code
  from (values (v_owner), (v_admin)) as r(id), public.permissions p;

  insert into public.role_permissions (tenant_id, role_id, permission_code) values
    (p_tenant_id, v_branch, 'office.manage'),
    (p_tenant_id, v_branch, 'user.read'),
    (p_tenant_id, v_disp,   'trip.manage'),
    (p_tenant_id, v_disp,   'ticket.sell'),
    (p_tenant_id, v_office, 'ticket.sell'),
    (p_tenant_id, v_seller, 'ticket.sell'),
    (p_tenant_id, v_disp,   'parcel.manage'),
    (p_tenant_id, v_office, 'parcel.manage'),
    (p_tenant_id, v_seller, 'parcel.manage'),
    (p_tenant_id, v_branch, 'archive.view'),
    (p_tenant_id, v_office, 'archive.view'),
    (p_tenant_id, v_disp,   'archive.view'),
    (p_tenant_id, v_acc,    'archive.view');
end;
$$;

-- ---------------------------------------------------------------- Thư mục
create table public.archive_folders (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  parent_id   uuid,
  name        text not null check (length(trim(name)) between 1 and 200),
  note        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_id) references public.archive_folders (tenant_id, id) on delete cascade,
  check (parent_id is null or parent_id <> id)
);
create unique index archive_folders_name_uq on public.archive_folders (tenant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(trim(name)));
create index archive_folders_parent_idx on public.archive_folders (tenant_id, parent_id);
create trigger archive_folders_touch before update on public.archive_folders for each row execute function app.touch_updated_at();
create trigger archive_folders_audit after insert or update or delete on public.archive_folders for each row execute function app.write_audit();

-- Không chuyển thư mục vào chính thư mục con của nó
create function app.archive_no_cycle()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare p uuid := new.parent_id; n int := 0;
begin
  while p is not null and n < 100 loop
    if p = new.id then raise exception 'Không chuyển thư mục vào thư mục con của chính nó' using errcode = '22023'; end if;
    select parent_id into p from public.archive_folders where tenant_id = new.tenant_id and id = p;
    n := n + 1;
  end loop;
  return new;
end;
$$;
create trigger archive_folders_cycle before insert or update of parent_id on public.archive_folders
  for each row execute function app.archive_no_cycle();
revoke execute on function app.archive_no_cycle() from public, anon, authenticated;

-- ---------------------------------------------------------------- Hồ sơ
create table public.archive_items (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  folder_id   uuid,                          -- null = gốc
  kind        text not null check (kind in ('file', 'link')),
  name        text not null check (length(trim(name)) between 1 and 300),
  drive_id    text,                          -- mã tệp trên Google Drive
  drive_url   text,
  file_name   text,
  mime        text,
  size_bytes  bigint,
  url         text,
  expires_on  date,
  note        text,
  is_old      boolean not null default false,   -- đã có bản mới thay thế
  replaced_by uuid,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, folder_id) references public.archive_folders (tenant_id, id) on delete cascade,
  check (kind <> 'file' or drive_id is not null),
  check (kind <> 'link' or url ~* '^https?://')
);
create index archive_items_folder_idx on public.archive_items (tenant_id, folder_id);
create index archive_items_expiry_idx on public.archive_items (tenant_id, expires_on) where expires_on is not null and not is_old;
create trigger archive_items_touch before update on public.archive_items for each row execute function app.touch_updated_at();
create trigger archive_items_audit after insert or update or delete on public.archive_items for each row execute function app.write_audit();

-- ---------------------------------------------------------------- Quyền
alter table public.archive_folders enable row level security;
alter table public.archive_items enable row level security;
revoke all on public.archive_folders, public.archive_items from public, anon, authenticated;
grant select, insert, update, delete on public.archive_folders, public.archive_items to authenticated;
grant select, insert, update, delete on public.archive_folders, public.archive_items to service_role;

create policy archive_folders_select on public.archive_folders for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('archive.view') or app.has_permission('archive.manage')));
create policy archive_folders_insert on public.archive_folders for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'));
create policy archive_folders_update on public.archive_folders for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'));
create policy archive_folders_delete on public.archive_folders for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'));

create policy archive_items_select on public.archive_items for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('archive.view') or app.has_permission('archive.manage')));
create policy archive_items_insert on public.archive_items for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'));
create policy archive_items_update on public.archive_items for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'));
create policy archive_items_delete on public.archive_items for delete to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('archive.manage'));

-- ---------------------------------------------------------------- Kết nối Google Drive (Apps Script) của nhà xe
create table public.tenant_drive (
  tenant_id   uuid primary key references public.tenants (id),
  url         text not null check (url ~ '^https://script\.google(usercontent)?\.com/.+/exec$'),
  key         text not null check (length(key) between 6 and 200),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
alter table public.tenant_drive enable row level security;
revoke all on public.tenant_drive from public, anon, authenticated;
grant select, insert, update, delete on public.tenant_drive to service_role;

create function public.drive_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); r record;
begin
  if v_tid is null or not (app.has_permission('settings.manage') or app.has_permission('archive.view') or app.has_permission('archive.manage')) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  select url, updated_at into r from public.tenant_drive where tenant_id = v_tid;
  return jsonb_build_object('configured', r.url is not null,
    'url', case when r.url is null then null else left(r.url, 40) || '…' || right(r.url, 12) end, 'updated_at', r.updated_at);
end;
$$;

-- Lưu địa chỉ Web app + mã kết nối (url rỗng = bỏ kết nối). Trình duyệt chỉ gửi lên, không đọc lại được mã.
create function public.save_drive_config(p_url text, p_key text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền cấu hình' using errcode = '42501';
  end if;
  if coalesce(trim(p_url), '') = '' then
    delete from public.tenant_drive where tenant_id = v_tid;
    return;
  end if;
  if trim(p_url) !~ '^https://script\.google(usercontent)?\.com/.+/exec$' then
    raise exception 'Địa chỉ phải là Web app Apps Script, dạng https://script.google.com/macros/s/…/exec' using errcode = '22023';
  end if;
  if coalesce(p_key, '') = '' and exists (select 1 from public.tenant_drive where tenant_id = v_tid) then
    update public.tenant_drive set url = trim(p_url), updated_by = auth.uid(), updated_at = now() where tenant_id = v_tid;   -- giữ mã cũ
    return;
  end if;
  if length(coalesce(p_key, '')) < 6 then
    raise exception 'Mã kết nối ít nhất 6 ký tự' using errcode = '22023';
  end if;
  insert into public.tenant_drive (tenant_id, url, key, updated_by) values (v_tid, trim(p_url), p_key, auth.uid())
  on conflict (tenant_id) do update set url = excluded.url, key = excluded.key, updated_by = excluded.updated_by, updated_at = now();
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tid, auth.uid(), 'update', 'tenant_drive', v_tid::text, jsonb_build_object('url', left(trim(p_url), 40) || '…'));
end;
$$;
revoke execute on function public.drive_status(), public.save_drive_config(text, text) from public, anon, authenticated;
grant execute on function public.drive_status(), public.save_drive_config(text, text) to authenticated;
