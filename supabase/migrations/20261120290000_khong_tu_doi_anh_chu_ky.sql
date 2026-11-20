-- =====================================================================
-- Nhân viên không tự đổi ảnh đại diện và chữ ký của mình: chỉ người có quyền Sửa hồ sơ Lái xe & nhân viên
-- (quản lý nhân sự) tải / đổi / bỏ. Chữ ký giám đốc, con dấu vẫn theo quyền Sửa cấu hình.
-- =====================================================================
create or replace function app.can_write_avatar(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select p_file ~ '^[0-9a-f-]{36}\.jpg$'
     and exists (select 1 from public.staff_members
                 where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 1, 36))
     and app.has_permission('staff.edit')
$$;

create or replace function app.can_write_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_file in ('giam_doc.png', 'con_dau.png') then app.has_permission('settings.edit')
              when p_file ~ '^nv_[0-9a-f-]{36}\.png$' then app.has_permission('staff.edit')
                and exists (select 1 from public.staff_members where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 4, 36))
              else p_file = auth.uid()::text || '.png' and app.has_permission('staff.edit') end
$$;

create or replace function public.set_signature_has_name(p_who text, p_has_name boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (case when p_who = 'giam_doc' then app.has_permission('settings.edit')
                                when p_who ~ '^nv_' then app.has_permission('staff.edit')
                                else p_who = auth.uid()::text and app.has_permission('staff.edit') end) then
    raise exception 'Không có quyền đổi cài đặt chữ ký này' using errcode = '42501';
  end if;
  insert into public.signature_settings (tenant_id, who, has_name) values (v_tid, p_who, coalesce(p_has_name, false))
  on conflict (tenant_id, who) do update set has_name = excluded.has_name;
end;
$$;
