-- =====================================================================
-- Hợp đồng thuê xe: Bên B tự lấy đủ thông tin doanh nghiệp (thêm ngày cấp / nơi cấp CCCD giám đốc vào thông tin công ty);
-- chữ ký chủ xe và vợ / chồng tải lên theo từng hợp đồng: chu_ky/hdtx_<hợp đồng>_a.png, _b.png (người có quyền Sửa xe).
-- =====================================================================
alter table public.tenant_private add column director_id_date date, add column director_id_place text check (director_id_place is null or length(director_id_place) <= 200);

create function public.set_director_id_info(p_date date, p_place text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('settings.edit') then
    raise exception 'Không có quyền sửa thông tin công ty' using errcode = '42501';
  end if;
  insert into public.tenant_private (tenant_id, director_id_date, director_id_place) values (v_tid, p_date, nullif(trim(p_place), ''))
  on conflict (tenant_id) do update set director_id_date = excluded.director_id_date, director_id_place = excluded.director_id_place;
end;
$$;
revoke execute on function public.set_director_id_info(date, text) from public, anon, authenticated;
grant execute on function public.set_director_id_info(date, text) to authenticated;

-- Thông tin Bên B cho hợp đồng thuê xe (người lập hợp đồng có quyền Sửa xe, có thể không có quyền xem cấu hình)
create function public.lease_company_info()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select case when app.has_permission('vehicle.edit') then
    (select jsonb_build_object('cccd', p.director_id_no, 'cccd_on', p.director_id_date, 'cccd_by', p.director_id_place, 'phone', t.phone)
     from public.tenants t left join public.tenant_private p on p.tenant_id = t.id where t.id = app.current_tenant_id())
  end
$$;
revoke execute on function public.lease_company_info() from public, anon, authenticated;
grant execute on function public.lease_company_info() to authenticated;

-- Chữ ký chủ xe trong hợp đồng thuê xe
create or replace function app.can_write_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_file in ('giam_doc.png', 'con_dau.png') then app.has_permission('settings.edit')
              when p_file ~ '^nv_[0-9a-f-]{36}\.png$' then app.has_permission('staff.edit')
                and exists (select 1 from public.staff_members where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 4, 36))
              when p_file ~ '^hdtx_[0-9a-f-]{36}_[ab]\.png$' then app.has_permission('vehicle.edit')
                and exists (select 1 from public.vehicle_leases where tenant_id = app.current_tenant_id() and id::text = substr(p_file, 6, 36))
              else p_file = auth.uid()::text || '.png' and app.has_permission('staff.edit') end
$$;
create policy chu_ky_hdtx_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'chu_ky' and storage.filename(name) ~ '^hdtx_' and app.has_permission('vehicle.edit'));
