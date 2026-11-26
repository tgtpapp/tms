-- =====================================================================
-- Trợ lý giọng nói (giai đoạn 3): lái xe / phụ xe của chuyến gửi báo cáo về điều hành – sự cố, trễ giờ, chi phí phát sinh,
-- lời nhắn. Gửi thành thông báo (chuông + đẩy về máy) cho người có quyền Điều hành: Sửa (cả nhà xe). Không đổi bảng.
-- =====================================================================
create function public.crew_report(p_trip_id uuid, p_kind text, p_text text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_name text;
  v_title text;
  v_n int := 0;
  m uuid;
begin
  if v_tid is null or p_trip_id is null or not app.is_my_trip(p_trip_id) then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if p_kind not in ('su_co', 'tre_gio', 'chi_phi', 'nhan') then raise exception 'Loại báo không hợp lệ' using errcode = '22023'; end if;
  if length(trim(coalesce(p_text, ''))) < 2 then raise exception 'Nội dung trống' using errcode = '22023'; end if;
  select coalesce(m2.full_name, a.full_name, 'Lái xe') into v_name
  from public.app_users a left join public.staff_members m2 on m2.tenant_id = v_tid and m2.user_id = a.id where a.id = auth.uid() limit 1;
  v_title := format('%s · %s', case p_kind when 'su_co' then 'Lái xe báo sự cố' when 'tre_gio' then 'Lái xe báo trễ giờ'
                                           when 'chi_phi' then 'Lái xe báo chi phí' else 'Lái xe nhắn điều hành' end,
                    coalesce(app.trip_label(v_tid, p_trip_id), 'chuyến'));
  for m in select distinct ur.user_id from public.user_roles ur
           join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
           join public.app_users a on a.id = ur.user_id and a.status = 'active'
           where ur.tenant_id = v_tid and ur.scope_type = 'tenant' and rp.permission_code in ('trip.edit', 'trip.manage')
             and ur.user_id <> auth.uid()
             and not exists (select 1 from public.user_permission_denies x where x.tenant_id = ur.tenant_id and x.user_id = ur.user_id
                             and x.permission_code = rp.permission_code)
  loop
    perform app.notify_user(v_tid, m, 'lai_xe_bao', v_title, format('%s: %s', v_name, left(trim(p_text), 260)), p_trip_id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function public.crew_report(uuid, text, text) from public, anon, authenticated;
grant execute on function public.crew_report(uuid, text, text) to authenticated;
