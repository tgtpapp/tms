-- =====================================================================
-- Giai đoạn 3.3b – Lý lịch hành nghề lái xe + kiểm tra hạng GPLX theo loại xe
-- Lý lịch (Phụ lục II, Thông tư 36/2024): theo dõi sức khỏe, vi phạm, tai nạn,
-- khen thưởng, kỷ luật, đào tạo / tập huấn. Chỉ staff.manage và chính người đó xem.
-- Hạng GPLX (Luật TTATGT đường bộ 2024, Điều 57):
--   D1: trên 8 đến 16 chỗ; D2: trên 16 đến 29 chỗ; D: trên 29 chỗ và xe giường nằm
--   (không kể chỗ người lái). Quy đổi GPLX cấp trước 01/01/2025: cần xác minh.
-- =====================================================================

-- ---------------------------------------------------------------- Lý lịch hành nghề
create table public.staff_records (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  staff_id     uuid not null,
  kind         text not null check (kind in ('suc_khoe', 'vi_pham', 'tai_nan', 'khen_thuong', 'ky_luat', 'dao_tao')),
  occurred_on  date not null,
  doc_no       text,                       -- số biên bản / quyết định / giấy chứng nhận
  title        text not null check (length(trim(title)) > 0),   -- nội dung chính
  vehicle_id   uuid,                       -- xe liên quan (vi phạm, tai nạn)
  data         jsonb not null default '{}',
  files        text[] not null default '{}',
  request_id   uuid,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, request_id),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id)
);
create index staff_records_staff_idx on public.staff_records (tenant_id, staff_id, occurred_on desc);

create trigger staff_records_touch before update on public.staff_records
  for each row execute function app.touch_updated_at();
create trigger staff_records_audit after insert or update or delete on public.staff_records
  for each row execute function app.write_audit_redacted();

alter table public.staff_records enable row level security;
revoke all on public.staff_records from anon, authenticated;
grant select on public.staff_records to authenticated;
grant select, insert, update, delete on public.staff_records to service_role;
create policy staff_records_select on public.staff_records for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('staff.manage') or app.is_my_staff(staff_id::text)));

-- Thêm / sửa 1 dòng lý lịch. p_plate: biển số xe liên quan (tự tìm xe trong nhà xe).
create function public.save_staff_record(
  p_id uuid, p_staff_id uuid, p_kind text, p_occurred_on date, p_doc_no text, p_title text, p_plate text,
  p_data jsonb, p_files text[], p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
  v_vehicle uuid;
begin
  if v_tid is null or not app.has_permission('staff.manage') then
    raise exception 'Không có quyền quản lý lý lịch lái xe' using errcode = '42501';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'Thông tin không hợp lệ' using errcode = '22023';
  end if;
  if p_occurred_on is null then
    raise exception 'Nhập ngày' using errcode = '22023';
  end if;
  if p_occurred_on > app.local_today() then
    raise exception 'Ngày không được sau hôm nay' using errcode = '22023';
  end if;
  if nullif(trim(p_plate), '') is not null then
    select id into v_vehicle from public.vehicles
    where tenant_id = v_tid and plate_key = upper(regexp_replace(p_plate, '[^0-9A-Za-z]', '', 'g'));
  end if;

  if p_id is not null then
    -- Sửa: không đổi người, loại, tệp
    update public.staff_records
    set occurred_on = p_occurred_on, doc_no = nullif(trim(p_doc_no), ''), title = trim(p_title), vehicle_id = v_vehicle,
        data = coalesce(p_data, '{}') || jsonb_build_object('bien_so', nullif(trim(p_plate), ''))
    where id = p_id and tenant_id = v_tid
    returning id into v_id;
    if v_id is null then
      raise exception 'Không tìm thấy lý lịch' using errcode = 'P0002';
    end if;
    return v_id;
  end if;

  if p_request_id is not null then
    select id into v_id from public.staff_records where tenant_id = v_tid and request_id = p_request_id;
    if found then return v_id; end if;
  end if;
  if not exists (select 1 from public.staff_members where id = p_staff_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  perform app.check_document_files(v_tid, 'nhan_su', p_staff_id, p_files);

  insert into public.staff_records (tenant_id, staff_id, kind, occurred_on, doc_no, title, vehicle_id, data, files, request_id, created_by)
  values (v_tid, p_staff_id, p_kind, p_occurred_on, nullif(trim(p_doc_no), ''), trim(p_title), v_vehicle,
          coalesce(p_data, '{}') || jsonb_build_object('bien_so', nullif(trim(p_plate), '')),
          coalesce(p_files, '{}'), p_request_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.save_staff_record(uuid, uuid, text, date, text, text, text, jsonb, text[], uuid)
  from public, anon, authenticated;
grant execute on function public.save_staff_record(uuid, uuid, text, date, text, text, text, jsonb, text[], uuid)
  to authenticated;

-- ---------------------------------------------------------------- Hạng GPLX
-- Hạng tối thiểu để lái loại xe. Số chỗ theo kiểm định THƯỜNG đã gồm chỗ người lái → trừ 1 (cần xác minh).
create function app.required_license(p_seats int, p_berths int, p_standing int)
returns text
language sql immutable set search_path = ''
as $$
  select case
    when coalesce(p_berths, 0) > 0 then 'D'
    when coalesce(p_seats, 0) + coalesce(p_standing, 0) - 1 > 29 then 'D'
    when coalesce(p_seats, 0) + coalesce(p_standing, 0) - 1 > 16 then 'D2'
    when coalesce(p_seats, 0) + coalesce(p_standing, 0) - 1 > 8 then 'D1'
    else 'B'
  end
$$;

-- Hạng GPLX theo luật mới. GPLX cấp trước 01/01/2025 quy đổi (cần xác minh):
--   B2→B, C→C, D→D2, E→D, FB2→BE, FC→CE, FD→D2E, FE→DE.
create function app.normalize_license(p_class text, p_issued_on date)
returns text
language sql immutable set search_path = ''
as $$
  with c as (select upper(regexp_replace(coalesce(p_class, ''), '[^0-9A-Za-z]', '', 'g')) as v)
  select case
    when (p_issued_on is null or p_issued_on < date '2025-01-01') and c.v in ('B2', 'C', 'D', 'E', 'FB2', 'FC', 'FD', 'FE') then
      case c.v when 'B2' then 'B' when 'C' then 'C' when 'D' then 'D2' when 'E' then 'D'
               when 'FB2' then 'BE' when 'FC' then 'CE' when 'FD' then 'D2E' when 'FE' then 'DE' end
    else nullif(c.v, '')
  end
  from c
$$;

-- Hạng p_have có lái được xe yêu cầu hạng p_need không
create function app.license_covers(p_have text, p_need text)
returns boolean
language sql immutable set search_path = ''
as $$
  select p_need = any (case p_have
    when 'B'   then array['B']
    when 'C1'  then array['B', 'C1']
    when 'C'   then array['B', 'C1', 'C']
    when 'D1'  then array['B', 'C1', 'C', 'D1']
    when 'D2'  then array['B', 'C1', 'C', 'D1', 'D2']
    when 'D'   then array['B', 'C1', 'C', 'D1', 'D2', 'D']
    when 'BE'  then array['B', 'BE']
    when 'C1E' then array['B', 'C1', 'BE', 'C1E']
    when 'CE'  then array['B', 'C1', 'C', 'BE', 'C1E', 'CE']
    when 'D1E' then array['B', 'C1', 'C', 'D1', 'BE', 'C1E', 'CE', 'D1E']
    when 'D2E' then array['B', 'C1', 'C', 'D1', 'D2', 'BE', 'C1E', 'CE', 'D1E', 'D2E']
    when 'DE'  then array['B', 'C1', 'C', 'D1', 'D2', 'D', 'BE', 'C1E', 'CE', 'D1E', 'D2E', 'DE']
    else array[]::text[] end)
$$;
revoke execute on function app.required_license(int, int, int), app.normalize_license(text, date), app.license_covers(text, text)
  from public, anon;
grant execute on function app.required_license(int, int, int), app.normalize_license(text, date), app.license_covers(text, text)
  to authenticated, service_role;

-- Bảng đối chiếu: lái xe nào lái được loại xe nào (dùng cho xếp chuyến ở bước 3.4).
-- Chỉ trả hạng + hạn GPLX, không trả số GPLX hay thông tin cá nhân.
create function public.license_matrix()
returns table (staff_id uuid, license_class text, license_expires date, vehicle_type_id uuid, need text, ok boolean, reason text)
language sql stable security definer set search_path = ''
as $$
  with lx as (
    select s.id, d.expires_on,
           app.normalize_license(d.data ->> 'hang', d.issued_on) as hang
    from public.staff_members s
    left join public.documents d
      on d.tenant_id = s.tenant_id and d.staff_id = s.id and d.doc_type = 'gplx' and d.is_current
    where s.tenant_id = app.current_tenant_id() and s.is_active and s.position = 'lai_xe'
  )
  select lx.id, lx.hang, lx.expires_on, t.id,
         app.required_license(t.reg_seats, t.reg_berths, t.reg_standing),
         lx.hang is not null and app.license_covers(lx.hang, app.required_license(t.reg_seats, t.reg_berths, t.reg_standing))
           and (lx.expires_on is null or lx.expires_on >= app.local_today()),
         case
           when lx.hang is null then 'Chưa có GPLX hoặc chưa nhập hạng'
           when lx.expires_on is not null and lx.expires_on < app.local_today() then 'GPLX đã hết hạn'
           when not app.license_covers(lx.hang, app.required_license(t.reg_seats, t.reg_berths, t.reg_standing))
             then 'Cần hạng ' || app.required_license(t.reg_seats, t.reg_berths, t.reg_standing) || ', đang có hạng ' || lx.hang
           else null
         end
  from lx
  cross join public.vehicle_types t
  where t.tenant_id = app.current_tenant_id() and t.is_active
$$;
revoke execute on function public.license_matrix() from public, anon, authenticated;
grant execute on function public.license_matrix() to authenticated;
