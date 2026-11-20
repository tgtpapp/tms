-- =====================================================================
-- Bảng chấm công (như app cũ):
-- - Lái xe: công tự lấy từ chuyến đã chạy (lái xe 1) × công/chuyến của tuyến (mặc định 1); tiền công = công × Tiền tài của xe.
-- - Văn phòng: tự điền X các ngày làm việc đã qua; tiền công = Lương cố định của tháng.
-- - Chi phí khác (lái xe) = % tiền công; Lương CK, Trừ BHXH lấy từ bảng BHXH & lương chuyển khoản theo tháng.
-- - Thực nhận không âm; thứ tự trừ BHXH → Chi phí khác → Lương CK; tùy chọn tạm dừng BHXH khi có từ 14 ngày làm việc không chạy.
-- Quyền: timesheet.view (mở, chỉ thấy của mình), timesheet.view_all (thấy mọi người), timesheet.edit (sửa công/chuyến, cài đặt).
-- Cột tiền chỉ hiện với quyền BHXH & lương (salary.view).
-- =====================================================================
insert into public.permissions (code, module, name) values
  ('timesheet.view', 'timesheet', 'Bảng chấm công: Xem'),
  ('timesheet.edit', 'timesheet', 'Bảng chấm công: Sửa'),
  ('timesheet.view_all', 'timesheet', 'Bảng chấm công: Xem tất cả')
on conflict (code) do nothing;
select app.grant_permission_to_admins('timesheet.view');
select app.grant_permission_to_admins('timesheet.edit');
select app.grant_permission_to_admins('timesheet.view_all');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, p.code from public.roles r
join (values ('accountant', 'timesheet.view'), ('accountant', 'timesheet.edit'), ('accountant', 'timesheet.view_all'),
             ('driver', 'timesheet.view'), ('staff', 'timesheet.view')) p(role, code) on p.role = r.code
on conflict do nothing;

do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, '(''accountant'', ''labor.*''))', '(''accountant'', ''labor.*''), (''accountant'', ''timesheet.*''), (''driver'', ''timesheet.view''), (''staff'', ''timesheet.view''))');
  if v not like '%timesheet.*%' then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

-- ---------------------------------------------------------------- Dữ liệu mới
alter table public.staff_members add column department text check (department is null or length(department) <= 80);   -- phòng ban
alter table public.vehicles add column driver_pay bigint not null default 0 check (driver_pay between 0 and 100000000); -- tiền tài (đồng / công)
alter table public.staff_pay_months add column fixed_pay bigint not null default 0 check (fixed_pay between 0 and 10000000000); -- lương cố định (văn phòng)

do $$
declare v text;
begin
  select pg_get_functiondef('public.save_staff(uuid, jsonb)'::regprocedure) into v;
  v := replace(v, 'is_active, job_title)', 'is_active, job_title, department)');
  v := replace(v, 'nullif(trim(p ->> ''job_title''), ''''))', 'nullif(trim(p ->> ''job_title''), ''''), nullif(trim(p ->> ''department''), ''''))');
  v := replace(v, 'job_title = case when p ? ''job_title'' then excluded.job_title else public.staff_members.job_title end;',
    'job_title = case when p ? ''job_title'' then excluded.job_title else public.staff_members.job_title end,
    department = case when p ? ''department'' then excluded.department else public.staff_members.department end;');
  if v not like '%department = case%' or v not like '%job_title, department)%' then raise exception 'Không sửa được save_staff'; end if;
  execute v;

  select pg_get_functiondef('public.save_pay_month(date, jsonb)'::regprocedure) into v;
  v := replace(v, 'month, has_bhxh, transfer_pay, bhxh_pay)', 'month, has_bhxh, transfer_pay, bhxh_pay, fixed_pay)');
  v := replace(v, 'greatest(0, coalesce((r ->> ''bhxh_pay'')::bigint, 0))',
                  'greatest(0, coalesce((r ->> ''bhxh_pay'')::bigint, 0)), greatest(0, coalesce((r ->> ''fixed_pay'')::bigint, 0))');
  v := replace(v, 'bhxh_pay = excluded.bhxh_pay,', 'bhxh_pay = excluded.bhxh_pay, fixed_pay = excluded.fixed_pay,');
  if v not like '%fixed_pay = excluded.fixed_pay%' then raise exception 'Không sửa được save_pay_month'; end if;
  execute v;
end;
$$;

/** Nhập từ app cũ: điền phòng ban khi đang trống. */
create function public.set_staff_department(p_id uuid, p_department text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('staff.edit') then
    raise exception 'Không có quyền sửa nhân viên' using errcode = '42501';
  end if;
  update public.staff_members set department = left(nullif(trim(p_department), ''), 80)
  where tenant_id = v_tid and id = p_id and department is null;
end;
$$;
revoke execute on function public.set_staff_department(uuid, text) from public, anon, authenticated;
grant execute on function public.set_staff_department(uuid, text) to authenticated;

/** Cài đặt chấm công: cong_tuyen {"<tuyến>|<chiều>" hoặc "<tuyến>": công/chuyến}, cp_khac_lx (%), bh14 (bool), cong_chuan (ngày). */
create function public.save_timesheet_settings(p jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); k text; v jsonb;
begin
  if v_tid is null or not app.has_permission('timesheet.edit') then
    raise exception 'Không có quyền sửa bảng chấm công' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object' then raise exception 'Dữ liệu không hợp lệ' using errcode = '22023'; end if;
  for k, v in select * from jsonb_each(p) loop
    if k = 'cong_tuyen' then
      if jsonb_typeof(v) <> 'object' or exists (select 1 from jsonb_each(v) x where jsonb_typeof(x.value) <> 'number' or x.value::numeric < 0 or x.value::numeric > 10) then
        raise exception 'Công / chuyến không hợp lệ (0 – 10)' using errcode = '22023';
      end if;
    elsif k = 'cp_khac_lx' then
      if jsonb_typeof(v) <> 'number' or v::numeric < 0 or v::numeric > 100 then raise exception 'Tỷ lệ chi phí khác 0 – 100%%' using errcode = '22023'; end if;
    elsif k = 'cong_chuan' then
      if jsonb_typeof(v) <> 'number' or v::numeric < 1 or v::numeric > 31 then raise exception 'Công chuẩn 1 – 31 ngày' using errcode = '22023'; end if;
    elsif k = 'bh14' then
      if jsonb_typeof(v) <> 'boolean' then raise exception 'Dữ liệu không hợp lệ' using errcode = '22023'; end if;
    else
      raise exception 'Cài đặt không hợp lệ: %', k using errcode = '22023';
    end if;
    insert into public.tenant_settings (tenant_id, key, value, updated_by) values (v_tid, 'cham_cong.' || k, v, auth.uid())
    on conflict (tenant_id, key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid();
  end loop;
end;
$$;
revoke execute on function public.save_timesheet_settings(jsonb) from public, anon, authenticated;
grant execute on function public.save_timesheet_settings(jsonb) to authenticated;

/** Tháng đầu tiên mỗi lái xe có chuyến (lái xe 1): trước tháng này không trừ tiền. */
create function public.driver_first_months()
returns table (staff_id uuid, first_month date)
language sql stable security definer set search_path = ''
as $$
  select c.staff_id, date_trunc('month', min(t.service_date))::date
  from public.trip_crew c join public.trips t on t.tenant_id = c.tenant_id and t.id = c.trip_id
  where c.tenant_id = app.current_tenant_id() and app.has_permission('timesheet.view')
    and c.role = 'lai_xe_1' and c.active and t.status = 'mo'
  group by c.staff_id
$$;
revoke execute on function public.driver_first_months() from public, anon, authenticated;
grant execute on function public.driver_first_months() to authenticated;
