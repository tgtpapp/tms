-- =====================================================================
-- Lái xe scan lệnh vận chuyển lưu vào hệ thống (không cần quyền Lưu trữ hồ sơ):
-- - Máy chủ (Edge Function "drive", lệnh put_lenh) cho AI đọc trang đầu; chỉ lưu khi đúng là Lệnh vận chuyển.
-- - Tên + thư mục do máy chủ đặt theo quy tắc app cũ: <số lệnh>/LVC-<hậu tố>, Năm / 08. Điều hành xe / Lệnh vận chuyển / Tuyến / Tháng MM-YYYY.
--   Cùng tên trong cùng thư mục: bản mới thay bản cũ (bản cũ ẩn).
-- - Ghi nhận bản scan theo chuyến (cả các lượt cùng lệnh) để app lái xe hiện "Đã scan lệnh"; báo cho người quản lý.
-- =====================================================================
create table public.order_scans (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id),
  trip_id          uuid,
  order_no         text not null check (length(order_no) between 1 and 120),
  archive_item_id  uuid,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id) on delete cascade,
  foreign key (tenant_id, archive_item_id) references public.archive_items (tenant_id, id) on delete set null (archive_item_id)
);
create index order_scans_trip_idx on public.order_scans (tenant_id, trip_id);
alter table public.order_scans enable row level security;
revoke all on public.order_scans from public, anon, authenticated;
grant select on public.order_scans to authenticated;
grant select, insert, update, delete on public.order_scans to service_role;
create policy order_scans_select on public.order_scans for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (created_by = auth.uid() or (trip_id is not null and app.is_my_trip(trip_id)) or app.has_permission('archive.view') or app.can_issue_order()));

/** Người gửi có phải nhân viên của nhà xe (và là tổ lái của chuyến, nếu chọn chuyến) */
create function public.svc_order_scan_check(p_tenant uuid, p_user uuid, p_trip uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff_members m where m.tenant_id = p_tenant and m.user_id = p_user and m.is_active)
     and (p_trip is null or exists (select 1 from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
                                     where c.tenant_id = p_tenant and c.trip_id = p_trip and c.active and m.user_id = p_user))
$$;

/** Lưu hồ sơ lệnh đã scan (tệp đã ở Drive): tạo thư mục theo đường dẫn, thay bản cũ cùng tên, ghi nhận theo chuyến, báo quản lý */
create function public.svc_save_order_scan(p_tenant uuid, p_user uuid, p_path text[], p_name text, p_file_name text, p_mime text,
                                           p_drive_id text, p_drive_url text, p_size bigint, p_trip uuid, p_order_no text, p_route text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_parent uuid; v_f uuid; n text; v_item uuid; v_who text; x record;
  bare text;
begin
  -- thư mục: so tên không phân biệt hoa thường, bỏ số thứ tự đầu ("08. Điều hành xe" = "Điều hành xe") như Lưu trữ hồ sơ
  foreach n in array p_path loop
    select f.id into v_f from public.archive_folders f
    where f.tenant_id = p_tenant and f.parent_id is not distinct from v_parent
      and (lower(trim(f.name)) = lower(trim(n))
           or (trim(n) !~ '^\d{4}$' and regexp_replace(lower(trim(f.name)), '^\d+\s*[.)\-]\s*', '') = regexp_replace(lower(trim(n)), '^\d+\s*[.)\-]\s*', '')))
    order by f.created_at limit 1;
    if v_f is null then
      insert into public.archive_folders (tenant_id, parent_id, name, created_by) values (p_tenant, v_parent, n, p_user) returning id into v_f;
    end if;
    v_parent := v_f; v_f := null;
  end loop;
  insert into public.archive_items (tenant_id, folder_id, kind, name, drive_id, drive_url, file_name, mime, size_bytes, note, created_by)
  values (p_tenant, v_parent, 'file', left(p_name, 300), p_drive_id, p_drive_url, left(p_file_name, 200), p_mime, p_size,
          'Lái xe scan lệnh vận chuyển', p_user)
  returning id into v_item;
  update public.archive_items set is_old = true, replaced_by = v_item
  where tenant_id = p_tenant and folder_id is not distinct from v_parent and id <> v_item and not is_old and lower(name) = lower(left(p_name, 300));
  -- ghi nhận theo chuyến: chuyến được chọn + các lượt cùng lệnh
  if p_trip is not null then
    insert into public.order_scans (tenant_id, trip_id, order_no, archive_item_id, created_by)
    select p_tenant, t, p_order_no, v_item, p_user from (
      select p_trip as t
      union select l2.trip_id from public.transport_order_legs l join public.transport_order_legs l2 on l2.tenant_id = l.tenant_id and l2.order_id = l.order_id
      where l.tenant_id = p_tenant and l.trip_id = p_trip and l2.trip_id is not null) s;
  else
    insert into public.order_scans (tenant_id, trip_id, order_no, archive_item_id, created_by) values (p_tenant, null, p_order_no, v_item, p_user);
  end if;
  -- báo người quản lý (có quyền Lưu trữ hồ sơ: thêm hoặc Điều hành: sửa)
  v_who := coalesce((select full_name from public.staff_members where tenant_id = p_tenant and user_id = p_user limit 1),
                    (select full_name from public.app_users where tenant_id = p_tenant and id = p_user), 'Lái xe');
  for x in
    select distinct ur.user_id from public.user_roles ur join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
    join public.app_users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.status = 'active'
    where ur.tenant_id = p_tenant and rp.permission_code in ('archive.add', 'trip.edit') and ur.user_id <> p_user
  loop
    perform app.notify_user(p_tenant, x.user_id, 'lai_xe_bao', 'Đã lưu lệnh vận chuyển ' || p_order_no,
      v_who || ' đã lưu lệnh vận chuyển ' || p_order_no || coalesce(' · ' || p_route, '') || ' · ' || p_path[array_length(p_path, 1)] || '.', p_trip);
  end loop;
  return v_item;
end;
$$;
revoke execute on function public.svc_order_scan_check(uuid, uuid, uuid), public.svc_save_order_scan(uuid, uuid, text[], text, text, text, text, text, bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.svc_order_scan_check(uuid, uuid, uuid), public.svc_save_order_scan(uuid, uuid, text[], text, text, text, text, text, bigint, uuid, text, text)
  to service_role;
