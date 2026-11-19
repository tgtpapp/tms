-- =====================================================================
-- Chữ ký của từng nhân viên / lái xe (kể cả người chưa có tài khoản đăng nhập), như app cũ (trường chuKy).
-- Tệp: giay-to/<nhà xe>/chu_ky/nv_<staff_id>.png. Người quản lý nhân sự tải / xóa; chính nhân viên đó xem được;
-- điều hành và quản trị đọc được để in lệnh, bảng phân công, nghiệm thu.
-- =====================================================================
create or replace function app.can_read_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.has_permission('trip.manage') or app.has_permission('settings.manage')
         or p_file = auth.uid()::text || '.png'
         or (p_file ~ '^nv_[0-9a-f-]{36}\.png$' and (app.has_permission('staff.manage') or app.is_my_staff(substr(p_file, 4, 36))))
$$;

create or replace function app.can_write_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_file in ('giam_doc.png', 'con_dau.png') then app.has_permission('settings.manage')
              when p_file ~ '^nv_[0-9a-f-]{36}\.png$' then app.has_permission('staff.manage')
                and exists (select 1 from public.staff_members where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 4, 36))
              else p_file = auth.uid()::text || '.png' end
$$;

alter table public.signature_settings drop constraint signature_settings_who_check;
alter table public.signature_settings add check (who = 'giam_doc' or who ~ '^(nv_)?[0-9a-f-]{36}$');

create or replace function public.set_signature_has_name(p_who text, p_has_name boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (case when p_who = 'giam_doc' then app.has_permission('settings.manage')
                                when p_who ~ '^nv_' then app.has_permission('staff.manage') or app.is_my_staff(substr(p_who, 4))
                                else p_who = auth.uid()::text end) then
    raise exception 'Không có quyền đổi cài đặt chữ ký này' using errcode = '42501';
  end if;
  insert into public.signature_settings (tenant_id, who, has_name) values (v_tid, p_who, coalesce(p_has_name, false))
  on conflict (tenant_id, who) do update set has_name = excluded.has_name;
end;
$$;
