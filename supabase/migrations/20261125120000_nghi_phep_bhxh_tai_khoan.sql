-- =====================================================================
-- Lái xe & nhân viên:
-- 1) Thêm 2 cột vào hồ sơ riêng (staff_private – chỉ quản lý nhân sự và chính người đó đọc được):
--    bhxh_no (số sổ BHXH), bank_account (tài khoản ngân hàng nhận lương). Chỉ thêm cột, không đổi / xóa cột cũ.
-- 2) Nghỉ phép: bảng staff_leaves (đơn nghỉ). Người lao động tự xin nghỉ cho mình (không cần ô quyền nào, ở hồ sơ của mình);
--    quản lý (leave.add) ghi đơn cho người khác;
--    duyệt / từ chối cần leave.edit; xem đơn của mọi người cần leave.view_all (của mình luôn xem được).
--    Không xóa đơn: hủy = chuyển trạng thái "da_huy" (giữ lịch sử).
--    Số ngày phép năm (mặc định 12, cứ đủ 5 năm làm việc thêm 1 ngày – BLLĐ 2019 Điều 113, 114; cần xác minh theo từng trường hợp)
--    tính ở giao diện, số ngày chuẩn đọc từ tenant_settings 'nghi_phep.ngay_phep_nam'.
-- =====================================================================

-- ---------------------------------------------------------------- 1. Số sổ BHXH, tài khoản ngân hàng
alter table public.staff_private add column bhxh_no text check (bhxh_no is null or length(bhxh_no) <= 20);
alter table public.staff_private add column bank_account text check (bank_account is null or length(bank_account) <= 120);

do $$
declare v text;
begin
  select pg_get_functiondef('public.save_staff(uuid, jsonb)'::regprocedure) into v;
  v := replace(v, '(staff_id, tenant_id, birth_date, gender, address, current_address, contract_type, note)',
                  '(staff_id, tenant_id, birth_date, gender, address, current_address, contract_type, note, bhxh_no, bank_account)');
  v := replace(v, 'nullif(p ->> ''contract_type'', ''''), nullif(trim(p ->> ''note''), ''''))',
                  'nullif(p ->> ''contract_type'', ''''), nullif(trim(p ->> ''note''), ''''),
          nullif(trim(p ->> ''bhxh_no''), ''''), nullif(trim(p ->> ''bank_account''), ''''))');
  v := replace(v, 'contract_type = excluded.contract_type, note = excluded.note;',
                  'contract_type = excluded.contract_type, note = excluded.note,
    bhxh_no = case when p ? ''bhxh_no'' then excluded.bhxh_no else public.staff_private.bhxh_no end,
    bank_account = case when p ? ''bank_account'' then excluded.bank_account else public.staff_private.bank_account end;');
  if v not like '%note, bhxh_no, bank_account)%' or v not like '%bank_account = case when%' or v not like '%p ->> ''bank_account''%' then
    raise exception 'Không sửa được save_staff';
  end if;
  execute v;
end;
$$;

-- ---------------------------------------------------------------- 2. Nghỉ phép
insert into public.permissions (code, module, name) values
  ('leave.view', 'leave', 'Nghỉ phép: Xem'),
  ('leave.add', 'leave', 'Nghỉ phép: Thêm (ghi đơn cho người khác)'),
  ('leave.edit', 'leave', 'Nghỉ phép: Sửa (duyệt / từ chối)'),
  ('leave.view_all', 'leave', 'Nghỉ phép: Xem tất cả')
on conflict (code) do nothing;
select app.grant_permission_to_admins('leave.view');
select app.grant_permission_to_admins('leave.add');
select app.grant_permission_to_admins('leave.edit');
select app.grant_permission_to_admins('leave.view_all');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, p.code from public.roles r
join (values ('accountant', 'leave.view'), ('accountant', 'leave.add'), ('accountant', 'leave.edit'), ('accountant', 'leave.view_all')) p(role, code) on p.role = r.code
on conflict do nothing;
do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, '(''accountant'', ''timesheet.*''),', '(''accountant'', ''timesheet.*''), (''accountant'', ''leave.*''),');
  if v not like '%(''accountant'', ''leave.*'')%' then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

create table public.staff_leaves (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  staff_id    uuid not null,
  kind        text not null check (kind in ('phep_nam', 'om', 'viec_rieng', 'khong_luong', 'thai_san', 'nghi_bu')),
  from_on     date not null,
  to_on       date not null,
  days        numeric(5, 1) not null check (days > 0 and days <= 366),
  reason      text check (reason is null or length(reason) <= 300),
  status      text not null default 'cho_duyet' check (status in ('cho_duyet', 'da_duyet', 'tu_choi', 'da_huy')),
  decided_by  uuid,
  decided_at  timestamptz,
  decide_note text check (decide_note is null or length(decide_note) <= 300),
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  check (to_on >= from_on),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id) on delete cascade
);
create index staff_leaves_staff_idx on public.staff_leaves (tenant_id, staff_id, from_on desc);
create index staff_leaves_status_idx on public.staff_leaves (tenant_id, status, from_on desc);
alter table public.staff_leaves enable row level security;
revoke all on public.staff_leaves from public, anon, authenticated;
grant select on public.staff_leaves to authenticated;
grant select, insert, update, delete on public.staff_leaves to service_role;
create policy staff_leaves_select on public.staff_leaves for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('leave.view_all') or app.is_my_staff(staff_id::text)));
create trigger staff_leaves_touch before update on public.staff_leaves for each row execute function app.touch_updated_at();
create trigger staff_leaves_audit after insert or update or delete on public.staff_leaves for each row execute function app.write_audit();

/** Ghi / sửa đơn nghỉ (còn chờ duyệt). p_id do trình duyệt tạo → bấm 2 lần không tạo trùng.
    Tự xin cho mình: luôn được. Ghi cho người khác: leave.add. Sửa đơn: người tạo hoặc leave.edit, chỉ khi còn chờ duyệt. */
create function public.save_leave(p_id uuid, p_staff_id uuid, p_kind text, p_from date, p_to date, p_days numeric, p_reason text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_old public.staff_leaves;
begin
  if v_tid is null then raise exception 'Không có quyền' using errcode = '42501'; end if;
  if p_id is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'Ngày nghỉ không hợp lệ' using errcode = '22023';
  end if;
  if p_days is null or p_days <= 0 or p_days > 366 then raise exception 'Số ngày nghỉ không hợp lệ' using errcode = '22023'; end if;
  if not exists (select 1 from public.staff_members where id = p_staff_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  if not (app.is_my_staff(p_staff_id::text) or app.has_permission('leave.add')) then
    raise exception 'Không có quyền ghi đơn nghỉ cho người khác' using errcode = '42501';
  end if;
  select * into v_old from public.staff_leaves where id = p_id;
  if found then
    if v_old.tenant_id <> v_tid then raise exception 'Không tìm thấy đơn nghỉ' using errcode = 'P0002'; end if;
    if v_old.status <> 'cho_duyet' then raise exception 'Đơn đã duyệt / từ chối / hủy, không sửa được' using errcode = '22023'; end if;
    if not (v_old.created_by = auth.uid() or app.has_permission('leave.edit')) then
      raise exception 'Không có quyền sửa đơn này' using errcode = '42501';
    end if;
    update public.staff_leaves set staff_id = p_staff_id, kind = p_kind, from_on = p_from, to_on = p_to, days = p_days,
           reason = nullif(trim(p_reason), '') where id = p_id;
  else
    insert into public.staff_leaves (id, tenant_id, staff_id, kind, from_on, to_on, days, reason)
    values (p_id, v_tid, p_staff_id, p_kind, p_from, p_to, p_days, nullif(trim(p_reason), ''));
  end if;
  return p_id;
end;
$$;
revoke execute on function public.save_leave(uuid, uuid, text, date, date, numeric, text) from public, anon, authenticated;
grant execute on function public.save_leave(uuid, uuid, text, date, date, numeric, text) to authenticated;

/** Duyệt / từ chối đơn đang chờ (leave.edit). Không tự duyệt đơn của chính mình. */
create function public.decide_leave(p_id uuid, p_status text, p_note text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v public.staff_leaves;
begin
  select * into v from public.staff_leaves where id = p_id and tenant_id = v_tid;
  if not found or not (app.has_permission('leave.view_all') or app.is_my_staff(v.staff_id::text)) then
    raise exception 'Không tìm thấy đơn nghỉ' using errcode = 'P0002';
  end if;
  if not app.has_permission('leave.edit') then raise exception 'Không có quyền duyệt đơn nghỉ' using errcode = '42501'; end if;
  if p_status not in ('da_duyet', 'tu_choi') then raise exception 'Trạng thái không hợp lệ' using errcode = '22023'; end if;
  if v.status <> 'cho_duyet' then raise exception 'Đơn này đã được xử lý' using errcode = '22023'; end if;
  if app.is_my_staff(v.staff_id::text) and not app.has_permission('settings.edit') then
    raise exception 'Không tự duyệt đơn nghỉ của chính mình' using errcode = '42501';
  end if;
  update public.staff_leaves set status = p_status, decided_by = auth.uid(), decided_at = now(), decide_note = nullif(trim(p_note), '')
  where id = p_id;
end;
$$;
revoke execute on function public.decide_leave(uuid, text, text) from public, anon, authenticated;
grant execute on function public.decide_leave(uuid, text, text) to authenticated;

/** Hủy đơn (giữ lịch sử): người tạo hủy khi còn chờ duyệt; leave.edit hủy được cả đơn đã duyệt (vd đi làm lại sớm). */
create function public.cancel_leave(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v public.staff_leaves;
begin
  select * into v from public.staff_leaves where id = p_id and tenant_id = v_tid;
  if not found or not (app.has_permission('leave.view_all') or app.is_my_staff(v.staff_id::text)) then
    raise exception 'Không tìm thấy đơn nghỉ' using errcode = 'P0002';
  end if;
  if v.status = 'da_huy' then return; end if;
  if not (app.has_permission('leave.edit') or (v.created_by = auth.uid() and v.status = 'cho_duyet')) then
    raise exception 'Không có quyền hủy đơn này' using errcode = '42501';
  end if;
  update public.staff_leaves set status = 'da_huy', decided_by = auth.uid(), decided_at = now() where id = p_id;
end;
$$;
revoke execute on function public.cancel_leave(uuid) from public, anon, authenticated;
grant execute on function public.cancel_leave(uuid) to authenticated;
