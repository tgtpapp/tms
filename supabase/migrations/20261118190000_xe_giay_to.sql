-- =====================================================================
-- Giai đoạn 3.2b – Xe + giấy tờ dùng chung
-- - Xe: theo mẫu Hồ sơ lý lịch phương tiện (Thông tư 36/2024) + hình thức sử dụng,
--   thiết bị giám sát hành trình, camera (NĐ 158/2024, Điều 13).
-- - Giấy tờ: mỗi loại giấy của một xe có đúng 1 bản HIỆN HÀNH; thêm bản mới thì
--   bản cũ tự chuyển thành "giấy cũ" (giữ lại, không xóa).
-- - Ảnh/PDF giấy tờ lưu ở Storage bucket riêng tư "giay-to",
--   đường dẫn: <tenant_id>/<loại chủ>/<id chủ>/<tên tệp>.
-- =====================================================================

-- ---------------------------------------------------------------- Xe
create table public.vehicles (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null default app.current_tenant_id() references public.tenants (id),
  plate              text not null,
  plate_key          text generated always as (upper(regexp_replace(plate, '[^0-9A-Za-z]', '', 'g'))) stored,
  vehicle_type_id    uuid not null,
  chassis_no         text,                     -- số khung
  engine_no          text,                     -- số máy
  owner_name         text,                     -- chủ sở hữu (theo đăng ký xe)
  color              text,
  country_of_origin  text,                     -- nước sản xuất
  manufacture_year   int check (manufacture_year is null or manufacture_year between 1970 and 2100),
  condition          text not null default 'nguyen_chiec' check (condition in ('nguyen_chiec', 'cai_tao')),
  ownership          text not null default 'so_huu' check (ownership in ('so_huu', 'thue', 'hop_tac', 'xa_vien')),
  acquired_on        date,                     -- ngày bắt đầu sở hữu / quản lý / sử dụng
  business_type      text not null default 'tuyen_co_dinh'
                     check (business_type in ('tuyen_co_dinh', 'hop_dong', 'ca_hai')),
  gsht_provider      text,                     -- đơn vị cung cấp thiết bị giám sát hành trình
  gsht_device_no     text,
  camera_provider    text,
  camera_device_no   text,
  note               text,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (plate_key ~ '^[0-9]{2}[A-Z]{1,2}[0-9]{4,6}$'),
  unique (tenant_id, id),
  unique (tenant_id, plate_key),
  foreign key (tenant_id, vehicle_type_id) references public.vehicle_types (tenant_id, id)
);
create unique index vehicles_chassis_uq on public.vehicles (tenant_id, upper(chassis_no)) where chassis_no is not null;

create trigger vehicles_touch before update on public.vehicles
  for each row execute function app.touch_updated_at();
create trigger vehicles_audit after insert or update or delete on public.vehicles
  for each row execute function app.write_audit();

alter table public.vehicles enable row level security;
revoke all on public.vehicles from anon, authenticated;
grant select, insert, update on public.vehicles to authenticated;
grant select, insert, update, delete on public.vehicles to service_role;

create policy vehicles_select on public.vehicles for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy vehicles_insert on public.vehicles for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy vehicles_update on public.vehicles for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));

-- ---------------------------------------------------------------- Danh mục loại giấy tờ (dùng chung toàn nền tảng)
create table public.document_types (
  code        text primary key,
  owner_kind  text not null check (owner_kind in ('xe')),
  name        text not null,
  has_expiry  boolean not null default true,
  required    boolean not null default false,   -- xe chạy dịch vụ bắt buộc phải có
  sort        int not null default 0
);
insert into public.document_types (code, owner_kind, name, has_expiry, required, sort) values
  ('dang_ky',       'xe', 'Giấy đăng ký xe (cà vẹt)',               false, true,  10),
  ('kiem_dinh',     'xe', 'Giấy chứng nhận kiểm định (đăng kiểm)',  true,  true,  20),
  ('bh_tnds',       'xe', 'Bảo hiểm trách nhiệm dân sự bắt buộc',   true,  true,  30),
  ('bh_vat_chat',   'xe', 'Bảo hiểm vật chất xe',                   true,  false, 40),
  ('bh_hanh_khach', 'xe', 'Bảo hiểm tai nạn hành khách',            true,  false, 50),
  ('phu_hieu',      'xe', 'Phù hiệu xe',                            true,  true,  60),
  ('hop_dong_thue', 'xe', 'Hợp đồng thuê xe / hợp tác kinh doanh',  true,  false, 70),
  ('cai_tao',       'xe', 'Giấy chứng nhận cải tạo',                false, false, 80);

alter table public.document_types enable row level security;
revoke all on public.document_types from anon, authenticated;
grant select on public.document_types to authenticated;
grant select, insert, update, delete on public.document_types to service_role;
create policy document_types_select on public.document_types for select to authenticated using (true);

-- ---------------------------------------------------------------- Giấy tờ
-- Mỗi giấy gắn với đúng 1 chủ. Hiện có: xe (vehicle_id). Bước sau thêm lái xe, hợp đồng…
create table public.documents (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  owner_kind    text not null check (owner_kind in ('xe')),
  vehicle_id    uuid,
  doc_type      text not null references public.document_types (code),
  doc_no        text,                  -- số giấy / số seri / số hợp đồng
  issuer        text,                  -- nơi cấp / công ty bảo hiểm
  issued_on     date,
  valid_from    date,
  expires_on    date,
  data          jsonb not null default '{}',   -- các thông tin khác đọc được trên giấy
  files         text[] not null default '{}',  -- đường dẫn tệp trong bucket giay-to
  note          text,
  is_current    boolean not null default true,
  request_id    uuid,                  -- chống lưu trùng khi bấm 2 lần
  created_at    timestamptz not null default now(),
  created_by    uuid,
  updated_at    timestamptz not null default now(),
  check (owner_kind <> 'xe' or vehicle_id is not null),
  check (expires_on is null or valid_from is null or expires_on >= valid_from),
  unique (tenant_id, id),
  unique (tenant_id, request_id),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id)
);
create unique index documents_one_current_vehicle on public.documents (tenant_id, vehicle_id, doc_type) where is_current;
create index documents_expiry_idx on public.documents (tenant_id, expires_on) where is_current;

create trigger documents_touch before update on public.documents
  for each row execute function app.touch_updated_at();
create trigger documents_audit after insert or update or delete on public.documents
  for each row execute function app.write_audit();

-- Quyền đọc / ghi giấy tờ theo loại chủ
create function app.can_read_documents(p_owner_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_owner_kind
    when 'xe' then app.current_tenant_id() is not null   -- điều hành, bán vé cần biết xe còn hạn giấy tờ
    else false
  end
$$;
create function app.can_manage_documents(p_owner_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_owner_kind
    when 'xe' then app.has_permission('vehicle.manage')
    else false
  end
$$;
revoke execute on function app.can_read_documents(text), app.can_manage_documents(text) from public, anon;
grant execute on function app.can_read_documents(text), app.can_manage_documents(text) to authenticated, service_role;

alter table public.documents enable row level security;
revoke all on public.documents from anon, authenticated;
grant select on public.documents to authenticated;
grant select, insert, update, delete on public.documents to service_role;
create policy documents_select on public.documents for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.can_read_documents(owner_kind));

-- Kiểm tra đường dẫn tệp thuộc đúng thư mục của chủ giấy tờ trong nhà xe mình
create function app.check_document_files(p_tid uuid, p_owner_kind text, p_owner_id uuid, p_files text[])
returns void
language plpgsql stable set search_path = ''
as $$
declare f text;
begin
  foreach f in array coalesce(p_files, '{}') loop
    if f not like p_tid::text || '/' || p_owner_kind || '/' || p_owner_id::text || '/%' or f like '%..%' then
      raise exception 'Tệp giấy tờ không thuộc xe này' using errcode = '22023';
    end if;
  end loop;
end;
$$;
revoke execute on function app.check_document_files(uuid, text, uuid, text[]) from public, anon, authenticated;

-- Thêm giấy tờ mới cho xe. Bản hiện hành cũ (nếu có) chuyển thành giấy cũ.
create function public.add_vehicle_document(
  p_vehicle_id uuid, p_doc_type text, p_doc_no text, p_issuer text, p_issued_on date,
  p_valid_from date, p_expires_on date, p_data jsonb, p_files text[], p_note text, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
begin
  if v_tid is null or not app.can_manage_documents('xe') then
    raise exception 'Không có quyền quản lý giấy tờ xe' using errcode = '42501';
  end if;
  if p_request_id is not null then
    select id into v_id from public.documents where tenant_id = v_tid and request_id = p_request_id;
    if found then return v_id; end if;   -- bấm lưu 2 lần: trả lại bản đã lưu
  end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.document_types where code = p_doc_type and owner_kind = 'xe') then
    raise exception 'Loại giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  if coalesce(array_length(p_files, 1), 0) = 0 then
    raise exception 'Hãy tải lên ảnh hoặc tệp PDF của giấy tờ' using errcode = '22023';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'Thông tin giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  perform app.check_document_files(v_tid, 'xe', p_vehicle_id, p_files);

  update public.documents set is_current = false
  where tenant_id = v_tid and vehicle_id = p_vehicle_id and doc_type = p_doc_type and is_current;

  insert into public.documents (tenant_id, owner_kind, vehicle_id, doc_type, doc_no, issuer, issued_on, valid_from,
                                expires_on, data, files, note, request_id, created_by)
  values (v_tid, 'xe', p_vehicle_id, p_doc_type, nullif(trim(p_doc_no), ''), nullif(trim(p_issuer), ''), p_issued_on,
          p_valid_from, p_expires_on, coalesce(p_data, '{}'), p_files, nullif(trim(p_note), ''), p_request_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

-- Sửa thông tin đã nhập của 1 giấy tờ (không đổi tệp, không đổi loại, không đổi bản hiện hành).
create function public.update_document(p_id uuid, p_doc_no text, p_issuer text, p_issued_on date,
                                       p_valid_from date, p_expires_on date, p_data jsonb, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_id and tenant_id = v_tid;
  if not found or not app.can_read_documents(v_doc.owner_kind) then
    raise exception 'Không tìm thấy giấy tờ' using errcode = 'P0002';
  end if;
  if not app.can_manage_documents(v_doc.owner_kind) then
    raise exception 'Không có quyền sửa giấy tờ' using errcode = '42501';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'Thông tin giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  update public.documents
  set doc_no = nullif(trim(p_doc_no), ''), issuer = nullif(trim(p_issuer), ''), issued_on = p_issued_on,
      valid_from = p_valid_from, expires_on = p_expires_on, data = coalesce(p_data, '{}'), note = nullif(trim(p_note), '')
  where id = p_id and tenant_id = v_tid;
end;
$$;

revoke execute on function
  public.add_vehicle_document(uuid, text, text, text, date, date, date, jsonb, text[], text, uuid),
  public.update_document(uuid, text, text, date, date, date, jsonb, text)
  from public, anon, authenticated;
grant execute on function
  public.add_vehicle_document(uuid, text, text, text, date, date, date, jsonb, text[], text, uuid),
  public.update_document(uuid, text, text, date, date, date, jsonb, text)
  to authenticated;

-- ---------------------------------------------------------------- Storage: bucket riêng tư cho giấy tờ
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('giay-to', 'giay-to', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do nothing;

-- Thư mục cấp 1 = nhà xe, cấp 2 = loại chủ (xe…). Không cho sửa / xóa tệp (giữ bản cũ).
create policy giay_to_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to'
         and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and app.can_read_documents((storage.foldername(name))[2]));
create policy giay_to_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'giay-to'
              and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and app.can_manage_documents((storage.foldername(name))[2]));

-- ---------------------------------------------------------------- Cấu hình: cảnh báo giấy tờ sắp hết hạn
create or replace function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare v numeric;
begin
  new.updated_at := now();
  new.updated_by := auth.uid();

  if new.key in ('ban_ve.giu_ghe_quay_phut', 'ban_ve.giu_ghe_online_phut', 'ban_ve.nha_ghe_vexere_gio',
                 'giay_to.canh_bao_truoc_ngay') then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception 'Giá trị phải là số' using errcode = '22023';
    end if;
    v := (new.value #>> '{}')::numeric;
    if v <> trunc(v) then
      raise exception 'Giá trị phải là số nguyên' using errcode = '22023';
    end if;
    if new.key like 'ban_ve.giu_ghe_%' and (v < 1 or v > 120) then
      raise exception 'Thời gian giữ ghế phải từ 1 đến 120 phút' using errcode = '22023';
    end if;
    if new.key = 'ban_ve.nha_ghe_vexere_gio' and (v < 0 or v > 48) then
      raise exception 'Giờ nhả ghế Vexere phải từ 0 đến 48' using errcode = '22023';
    end if;
    if new.key = 'giay_to.canh_bao_truoc_ngay' and (v < 1 or v > 180) then
      raise exception 'Số ngày cảnh báo giấy tờ phải từ 1 đến 180' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

create or replace function app.seed_default_settings(p_tenant_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.tenant_settings (tenant_id, key, value) values
    (p_tenant_id, 'ban_ve.giu_ghe_quay_phut',    '5'::jsonb),
    (p_tenant_id, 'ban_ve.giu_ghe_online_phut',  '15'::jsonb),
    (p_tenant_id, 'ban_ve.nha_ghe_vexere_gio',   '2'::jsonb),
    (p_tenant_id, 'giay_to.canh_bao_truoc_ngay', '30'::jsonb)
  on conflict (tenant_id, key) do nothing
$$;
revoke execute on function app.seed_default_settings(uuid) from public, anon, authenticated;

select app.seed_default_settings(id) from public.tenants;
