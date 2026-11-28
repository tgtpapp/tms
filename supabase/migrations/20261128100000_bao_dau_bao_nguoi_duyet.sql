-- =====================================================================
-- Lái xe gửi phiếu đổ dầu → báo ngay (chuông + thông báo đẩy) cho mọi người có quyền duyệt phiếu nhiên liệu
-- (quyền "Thêm" nhiên liệu: điều hành, kế toán… theo nhóm quyền của nhà xe), trừ người gửi.
-- Loại thông báo mới 'dau' (tắt / bật được trong Tài khoản của tôi › Thông báo).
-- Sửa kèm: set_notify_prefs trước đây chỉ lưu 3 loại đầu, nay lưu cả 'su_co', 'dau'.
-- =====================================================================
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('khach', 'xep_chuyen', 'lai_xe_bao', 'su_co', 'thiet_bi', 'dau'));

create function app.fuel_handlers(p_tenant uuid)
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select distinct ur.user_id from public.user_roles ur
  join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
  join public.app_users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.status = 'active'
  where ur.tenant_id = p_tenant and rp.permission_code = 'fuel.add'
    and not exists (select 1 from public.user_permission_denies d where d.tenant_id = ur.tenant_id and d.user_id = ur.user_id and d.permission_code = 'fuel.add')
$$;
revoke execute on function app.fuel_handlers(uuid) from public, anon, authenticated;

create function app.fuel_report_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_who text; h uuid;
begin
  select full_name into v_who from public.staff_members where tenant_id = new.tenant_id and id = new.staff_id;
  for h in select app.fuel_handlers(new.tenant_id) loop
    perform app.notify_user(new.tenant_id, h, 'dau', 'Phiếu đổ dầu chờ duyệt · ' || new.plate,
      coalesce(v_who, 'Lái xe') || ' · ' || replace(trim(trailing '.' from trim(trailing '0' from to_char(new.liters, 'FM999999990.000'))), '.', ',') || ' lít · '
      || replace(to_char(coalesce(new.amount, round(new.liters * new.unit_price)), 'FM999G999G999G990'), ',', '.') || ' đ', null);
  end loop;
  return null;
end;
$$;
revoke execute on function app.fuel_report_notify() from public, anon, authenticated;
create trigger fuel_reports_notify after insert on public.fuel_reports for each row execute function app.fuel_report_notify();

create or replace function public.set_notify_prefs(p_off text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  insert into public.notify_prefs (tenant_id, user_id, off_kinds, updated_at)
  values (v_tid, auth.uid(), array(select x from unnest(coalesce(p_off, '{}')) x where x in ('khach', 'xep_chuyen', 'lai_xe_bao', 'su_co', 'dau')), now())
  on conflict (tenant_id, user_id) do update set off_kinds = excluded.off_kinds, updated_at = now();
end;
$$;
revoke execute on function public.set_notify_prefs(text[]) from public, anon, authenticated;
grant execute on function public.set_notify_prefs(text[]) to authenticated, service_role;
