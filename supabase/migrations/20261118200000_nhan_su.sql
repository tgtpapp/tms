-- =====================================================================
-- Giai đoạn 3.3a – Lái xe, phụ xe, nhân viên + giấy tờ cá nhân (CCCD, GPLX…)
-- Theo mẫu Lý lịch hành nghề lái xe (Phụ lục II, Thông tư 36/2024).
-- Dữ liệu cá nhân nhạy cảm (ngày sinh, địa chỉ, CCCD, sức khỏe):
--   chỉ người có quyền staff.manage và CHÍNH NGƯỜI ĐÓ xem được;
--   nhật ký thao tác không chép giá trị nhạy cảm (chỉ ghi là có thay đổi).
-- =====================================================================

insert into public.permissions (code, module, name) values
  ('staff.manage', 'van_tai', 'Quản lý lái xe, nhân viên và giấy tờ cá nhân');
select app.grant_permission_to_admins('staff.manage');

-- ---------------------------------------------------------------- Hồ sơ (phần mọi người trong nhà xe xem được)
create table public.staff_members (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default app.current_tenant_id() references public.tenants (id),
  user_id        uuid,                      -- tài khoản đăng nhập (nếu có)
  full_name      text not null check (length(trim(full_name)) > 0),
  position       text not null default 'lai_xe' check (position in ('lai_xe', 'phu_xe', 'nhan_vien')),
  phone          text check (phone is null or phone ~ '^0[0-9]{9}$'),
  branch_id      uuid,
  joined_on      date not null,             -- ngày vào công ty
  left_on        date,                      -- ngày nghỉ việc
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (left_on is null or left_on >= joined_on),
  unique (tenant_id, id),
  unique (tenant_id, user_id),
  foreign key (tenant_id, user_id) references public.app_users (tenant_id, id),
  foreign key (tenant_id, branch_id) references public.branches (tenant_id, id)
);

-- ---------------------------------------------------------------- Thông tin cá nhân (bảo mật)
create table public.staff_private (
  staff_id        uuid primary key,
  tenant_id       uuid not null,
  birth_date      date,
  gender          text check (gender is null or gender in ('nam', 'nu')),
  address         text,                     -- nơi thường trú
  contract_type   text check (contract_type is null or contract_type in
                    ('khong_xac_dinh', 'xac_dinh', 'thu_viec', 'thoi_vu', 'khoan_viec', 'khac')),
  note            text,
  updated_at      timestamptz not null default now(),
  unique (tenant_id, staff_id),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id) on delete cascade
);

-- Người đang đăng nhập có phải chính nhân viên này?
create function app.is_my_staff(p_staff_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.staff_members
                 where id::text = p_staff_id and tenant_id = app.current_tenant_id() and user_id = auth.uid())
$$;
revoke execute on function app.is_my_staff(text) from public, anon;
grant execute on function app.is_my_staff(text) to authenticated, service_role;

-- ---------------------------------------------------------------- Nhật ký không chép dữ liệu nhạy cảm
create function app.write_audit_redacted()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  v_keep text[] := array['id', 'tenant_id', 'staff_id', 'owner_kind', 'doc_type', 'is_current', 'files'];
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  r_new jsonb := '{}';
  r_old jsonb := '{}';
  k text;
begin
  -- Giấy tờ của xe không nhạy cảm: ghi đầy đủ như bình thường
  if tg_table_name = 'documents' and v_row ->> 'owner_kind' = 'xe' then
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
    values ((v_row ->> 'tenant_id')::uuid, auth.uid(), lower(tg_op), tg_table_name, v_row ->> 'id',
            case tg_op when 'INSERT' then jsonb_build_object('new', v_new)
                       when 'UPDATE' then jsonb_build_object('old', v_old, 'new', v_new)
                       else jsonb_build_object('old', v_old) end);
    return coalesce(new, old);
  end if;
  for k in select jsonb_object_keys(v_row) loop
    if k = any (v_keep) then
      if v_new is not null then r_new := r_new || jsonb_build_object(k, v_new -> k); end if;
      if v_old is not null then r_old := r_old || jsonb_build_object(k, v_old -> k); end if;
    else
      -- chỉ ghi "đã thay đổi", không ghi giá trị
      if v_new is not null then
        r_new := r_new || jsonb_build_object(k, case when v_old is not null and v_old -> k is not distinct from v_new -> k
                                                     then '•••' else '••• (mới)' end);
      end if;
      if v_old is not null then r_old := r_old || jsonb_build_object(k, '•••'); end if;
    end if;
  end loop;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values ((v_row ->> 'tenant_id')::uuid, auth.uid(), lower(tg_op), tg_table_name,
          coalesce(v_row ->> 'id', v_row ->> 'staff_id'),
          case tg_op when 'INSERT' then jsonb_build_object('new', r_new)
                     when 'UPDATE' then jsonb_build_object('old', r_old, 'new', r_new)
                     else jsonb_build_object('old', r_old) end);
  return coalesce(new, old);
end;
$$;
revoke execute on function app.write_audit_redacted() from public, anon, authenticated;

create trigger staff_members_touch before update on public.staff_members
  for each row execute function app.touch_updated_at();
create trigger staff_members_audit after insert or update or delete on public.staff_members
  for each row execute function app.write_audit();
create trigger staff_private_touch before update on public.staff_private
  for each row execute function app.touch_updated_at();
create trigger staff_private_audit after insert or update or delete on public.staff_private
  for each row execute function app.write_audit_redacted();

-- Giấy tờ: nhật ký giấy tờ cá nhân không chép số giấy / nội dung
drop trigger documents_audit on public.documents;
create trigger documents_audit after insert or update or delete on public.documents
  for each row execute function app.write_audit_redacted();

alter table public.staff_members enable row level security;
alter table public.staff_private enable row level security;
revoke all on public.staff_members, public.staff_private from anon, authenticated;
grant select on public.staff_members, public.staff_private to authenticated;
grant select, insert, update, delete on public.staff_members, public.staff_private to service_role;

create policy staff_members_select on public.staff_members for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy staff_private_select on public.staff_private for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('staff.manage') or app.is_my_staff(staff_id::text)));

-- Lưu hồ sơ (cả phần chung + phần bảo mật) trong 1 lần. p_id do trình duyệt tạo → bấm 2 lần không tạo trùng.
create function public.save_staff(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_branch uuid := nullif(p ->> 'branch_id', '')::uuid;
begin
  if v_tid is null or not app.has_permission('staff.manage') then
    raise exception 'Không có quyền quản lý nhân viên' using errcode = '42501';
  end if;
  if p_id is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Dữ liệu không hợp lệ' using errcode = '22023';
  end if;
  if exists (select 1 from public.staff_members where id = p_id and tenant_id <> v_tid) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  if nullif(trim(p ->> 'joined_on'), '') is null then
    raise exception 'Nhập ngày vào công ty' using errcode = '22023';
  end if;
  if v_user is not null and not exists (select 1 from public.app_users where id = v_user and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tài khoản đăng nhập' using errcode = 'P0002';
  end if;
  if v_branch is not null and not exists (select 1 from public.branches where id = v_branch and tenant_id = v_tid) then
    raise exception 'Không tìm thấy chi nhánh' using errcode = 'P0002';
  end if;

  insert into public.staff_members (id, tenant_id, user_id, full_name, position, phone, branch_id, joined_on, left_on, is_active)
  values (p_id, v_tid, v_user, trim(p ->> 'full_name'), coalesce(p ->> 'position', 'lai_xe'), nullif(trim(p ->> 'phone'), ''),
          v_branch, (p ->> 'joined_on')::date, nullif(p ->> 'left_on', '')::date, coalesce((p ->> 'is_active')::boolean, true))
  on conflict (id) do update set
    user_id = excluded.user_id, full_name = excluded.full_name, position = excluded.position, phone = excluded.phone,
    branch_id = excluded.branch_id, joined_on = excluded.joined_on, left_on = excluded.left_on, is_active = excluded.is_active;

  insert into public.staff_private (staff_id, tenant_id, birth_date, gender, address, contract_type, note)
  values (p_id, v_tid, nullif(p ->> 'birth_date', '')::date, nullif(p ->> 'gender', ''), nullif(trim(p ->> 'address'), ''),
          nullif(p ->> 'contract_type', ''), nullif(trim(p ->> 'note'), ''))
  on conflict (staff_id) do update set
    birth_date = excluded.birth_date, gender = excluded.gender, address = excluded.address,
    contract_type = excluded.contract_type, note = excluded.note;
  return p_id;
end;
$$;
revoke execute on function public.save_staff(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_staff(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- Giấy tờ cá nhân
insert into public.document_types (code, owner_kind, name, has_expiry, required, sort) values
  ('cccd',          'nhan_su', 'Căn cước / Căn cước công dân',           true, false, 110),
  ('gplx',          'nhan_su', 'Giấy phép lái xe',                       true, false, 120),
  ('kham_suc_khoe', 'nhan_su', 'Giấy khám sức khỏe lái xe',              true, false, 130),
  ('tap_huan',      'nhan_su', 'Giấy chứng nhận tập huấn nghiệp vụ',     true, false, 140),
  ('hop_dong_ld',   'nhan_su', 'Hợp đồng lao động',                      true, false, 150);
-- (bắt buộc hay không tùy chức danh: lái xe cần GPLX, khám sức khỏe, tập huấn – xử lý ở giao diện)

alter table public.document_types drop constraint document_types_owner_kind_check;
alter table public.document_types add check (owner_kind in ('xe', 'nhan_su'));

alter table public.documents add column staff_id uuid;
alter table public.documents add foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id);
alter table public.documents drop constraint documents_owner_kind_check;
alter table public.documents add check (owner_kind in ('xe', 'nhan_su'));
alter table public.documents add check (owner_kind <> 'nhan_su' or (staff_id is not null and vehicle_id is null));
alter table public.documents add check (owner_kind <> 'xe' or staff_id is null);
create unique index documents_one_current_staff on public.documents (tenant_id, staff_id, doc_type) where is_current and staff_id is not null;

create or replace function app.can_read_documents(p_owner_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_owner_kind
    when 'xe' then app.current_tenant_id() is not null
    when 'nhan_su' then app.has_permission('staff.manage')
    else false
  end
$$;
create or replace function app.can_manage_documents(p_owner_kind text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case p_owner_kind
    when 'xe' then app.has_permission('vehicle.manage')
    when 'nhan_su' then app.has_permission('staff.manage')
    else false
  end
$$;

-- Chính nhân viên xem được giấy tờ của mình
drop policy documents_select on public.documents;
create policy documents_select on public.documents for select to authenticated
  using (tenant_id = app.current_tenant_id()
         and (app.can_read_documents(owner_kind)
              or (owner_kind = 'nhan_su' and app.is_my_staff(staff_id::text))));

drop policy giay_to_select on storage.objects;
create policy giay_to_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to'
         and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (app.can_read_documents((storage.foldername(name))[2])
              or ((storage.foldername(name))[2] = 'nhan_su' and app.is_my_staff((storage.foldername(name))[3]))));

-- Thêm giấy tờ cho nhân viên (bản cũ chuyển thành giấy cũ)
create function public.add_staff_document(
  p_staff_id uuid, p_doc_type text, p_doc_no text, p_issuer text, p_issued_on date,
  p_valid_from date, p_expires_on date, p_data jsonb, p_files text[], p_note text, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
begin
  if v_tid is null or not app.can_manage_documents('nhan_su') then
    raise exception 'Không có quyền quản lý giấy tờ nhân viên' using errcode = '42501';
  end if;
  if p_request_id is not null then
    select id into v_id from public.documents where tenant_id = v_tid and request_id = p_request_id;
    if found then return v_id; end if;
  end if;
  if not exists (select 1 from public.staff_members where id = p_staff_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.document_types where code = p_doc_type and owner_kind = 'nhan_su') then
    raise exception 'Loại giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  if coalesce(array_length(p_files, 1), 0) = 0 then
    raise exception 'Hãy tải lên ảnh hoặc tệp PDF của giấy tờ' using errcode = '22023';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'Thông tin giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  if p_doc_type = 'cccd' and nullif(trim(p_doc_no), '') is not null and trim(p_doc_no) !~ '^[0-9]{12}$' then
    raise exception 'Số CCCD phải gồm 12 chữ số' using errcode = '22023';
  end if;
  perform app.check_document_files(v_tid, 'nhan_su', p_staff_id, p_files);

  update public.documents set is_current = false
  where tenant_id = v_tid and staff_id = p_staff_id and doc_type = p_doc_type and is_current;

  insert into public.documents (tenant_id, owner_kind, staff_id, doc_type, doc_no, issuer, issued_on, valid_from,
                                expires_on, data, files, note, request_id, created_by)
  values (v_tid, 'nhan_su', p_staff_id, p_doc_type, nullif(trim(p_doc_no), ''), nullif(trim(p_issuer), ''), p_issued_on,
          p_valid_from, p_expires_on, coalesce(p_data, '{}'), p_files, nullif(trim(p_note), ''), p_request_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.add_staff_document(uuid, text, text, text, date, date, date, jsonb, text[], text, uuid)
  from public, anon, authenticated;
grant execute on function public.add_staff_document(uuid, text, text, text, date, date, date, jsonb, text[], text, uuid)
  to authenticated;

-- Sửa giấy tờ: thêm kiểm tra số CCCD
create or replace function public.update_document(p_id uuid, p_doc_no text, p_issuer text, p_issued_on date,
                                                  p_valid_from date, p_expires_on date, p_data jsonb, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_id and tenant_id = v_tid;
  if not found or not (app.can_read_documents(v_doc.owner_kind)
                       or (v_doc.owner_kind = 'nhan_su' and app.is_my_staff(v_doc.staff_id::text))) then
    raise exception 'Không tìm thấy giấy tờ' using errcode = 'P0002';
  end if;
  if not app.can_manage_documents(v_doc.owner_kind) then
    raise exception 'Không có quyền sửa giấy tờ' using errcode = '42501';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'Thông tin giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  if v_doc.doc_type = 'cccd' and nullif(trim(p_doc_no), '') is not null and trim(p_doc_no) !~ '^[0-9]{12}$' then
    raise exception 'Số CCCD phải gồm 12 chữ số' using errcode = '22023';
  end if;
  update public.documents
  set doc_no = nullif(trim(p_doc_no), ''), issuer = nullif(trim(p_issuer), ''), issued_on = p_issued_on,
      valid_from = p_valid_from, expires_on = p_expires_on, data = coalesce(p_data, '{}'), note = nullif(trim(p_note), '')
  where id = p_id and tenant_id = v_tid;
end;
$$;
