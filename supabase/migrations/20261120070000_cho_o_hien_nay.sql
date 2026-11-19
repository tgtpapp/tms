-- =====================================================================
-- Chỗ ở hiện nay của lái xe / nhân viên (khác nơi thường trú trên CCCD), như trường diaChiHN của app cũ.
-- Dữ liệu đã nhập từ app cũ trước đây nằm trong Ghi chú ("Chỗ ở hiện nay: …") → chuyển sang trường riêng.
-- =====================================================================
alter table public.staff_private add column current_address text check (current_address is null or length(current_address) <= 300);

update public.staff_private
set current_address = left(trim(substring(note from '(?n)^Chỗ ở hiện nay: (.*)$')), 300),
    note = nullif(trim(both E'\n' from regexp_replace(note, '(?n)^Chỗ ở hiện nay: .*$\n?', '')), '')
where note ~ '(?n)^Chỗ ở hiện nay: ' and current_address is null;

create or replace function public.save_staff(p_id uuid, p jsonb)
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

  insert into public.staff_members (id, tenant_id, user_id, full_name, position, phone, branch_id, joined_on, left_on, is_active, job_title)
  values (p_id, v_tid, v_user, trim(p ->> 'full_name'), coalesce(p ->> 'position', 'lai_xe'), nullif(trim(p ->> 'phone'), ''),
          v_branch, (p ->> 'joined_on')::date, nullif(p ->> 'left_on', '')::date, coalesce((p ->> 'is_active')::boolean, true),
          nullif(trim(p ->> 'job_title'), ''))
  on conflict (id) do update set
    user_id = excluded.user_id, full_name = excluded.full_name, position = excluded.position, phone = excluded.phone,
    branch_id = excluded.branch_id, joined_on = excluded.joined_on, left_on = excluded.left_on, is_active = excluded.is_active,
    job_title = case when p ? 'job_title' then excluded.job_title else public.staff_members.job_title end;

  insert into public.staff_private (staff_id, tenant_id, birth_date, gender, address, current_address, contract_type, note)
  values (p_id, v_tid, nullif(p ->> 'birth_date', '')::date, nullif(p ->> 'gender', ''), nullif(trim(p ->> 'address'), ''),
          nullif(trim(p ->> 'current_address'), ''), nullif(p ->> 'contract_type', ''), nullif(trim(p ->> 'note'), ''))
  on conflict (staff_id) do update set
    birth_date = excluded.birth_date, gender = excluded.gender, address = excluded.address,
    current_address = case when p ? 'current_address' then excluded.current_address else public.staff_private.current_address end,
    contract_type = excluded.contract_type, note = excluded.note;
  return p_id;
end;
$$;
revoke execute on function public.save_staff(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_staff(uuid, jsonb) to authenticated;

revoke execute on function public.save_staff(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_staff(uuid, jsonb) to authenticated;
