-- =====================================================================
-- Giai đoạn 2.4 – Cấu hình nhà xe
-- - Thông tin doanh nghiệp: sửa qua hàm (bảng tenants không mở ghi trực tiếp)
-- - Cấu hình nghiệp vụ (tenant_settings): kiểm tra giá trị ở database,
--   mỗi nhà xe có sẵn giá trị mặc định đã chốt ở Giai đoạn 1
-- =====================================================================

alter table public.tenants
  add column address text,
  add column phone   text;

-- ---------------------------------------------------------------- Thông tin doanh nghiệp
create function public.update_tenant_profile(p_name text, p_legal_name text, p_tax_code text,
                                             p_transport_license_no text, p_address text, p_phone text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền cấu hình nhà xe' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Tên nhà xe không được để trống' using errcode = '22023';
  end if;
  update public.tenants set
    name                 = trim(p_name),
    legal_name           = nullif(trim(p_legal_name), ''),
    tax_code             = nullif(trim(p_tax_code), ''),
    transport_license_no = nullif(trim(p_transport_license_no), ''),
    address              = nullif(trim(p_address), ''),
    phone                = nullif(trim(p_phone), '')
  where id = v_tid;
end;
$$;

revoke execute on function public.update_tenant_profile(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_tenant_profile(text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- Cấu hình nghiệp vụ
-- Kiểm tra giá trị + ghi người sửa / thời điểm sửa
create function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare v numeric;
begin
  new.updated_at := now();
  new.updated_by := auth.uid();

  if new.key in ('ban_ve.giu_ghe_quay_phut', 'ban_ve.giu_ghe_online_phut', 'ban_ve.nha_ghe_vexere_gio') then
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
  end if;
  return new;
end;
$$;

create trigger tenant_settings_validate before insert or update on public.tenant_settings
  for each row execute function app.validate_tenant_setting();

revoke execute on function app.validate_tenant_setting() from public, anon, authenticated;

-- Giá trị mặc định đã chốt (Giai đoạn 1): quầy 5 phút, online 15 phút, nhả ghế Vexere trước 2 giờ
create function app.seed_default_settings(p_tenant_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  insert into public.tenant_settings (tenant_id, key, value) values
    (p_tenant_id, 'ban_ve.giu_ghe_quay_phut',   '5'::jsonb),
    (p_tenant_id, 'ban_ve.giu_ghe_online_phut', '15'::jsonb),
    (p_tenant_id, 'ban_ve.nha_ghe_vexere_gio',  '2'::jsonb)
  on conflict (tenant_id, key) do nothing
$$;

revoke execute on function app.seed_default_settings(uuid) from public, anon, authenticated;

-- Nhà xe tạo mới: có sẵn vai trò mẫu + cấu hình mặc định
create or replace function public.create_tenant(p_code text, p_name text, p_legal_name text default null,
                                                p_tax_code text default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'Không có quyền tạo nhà xe' using errcode = '42501';
  end if;
  insert into public.tenants (code, name, legal_name, tax_code)
  values (lower(trim(p_code)), trim(p_name), p_legal_name, p_tax_code)
  returning id into v_id;
  perform app.seed_system_roles(v_id);
  perform app.seed_default_settings(v_id);
  return v_id;
end;
$$;

-- Nhà xe đã có: bổ sung cấu hình mặc định
select app.seed_default_settings(id) from public.tenants;
