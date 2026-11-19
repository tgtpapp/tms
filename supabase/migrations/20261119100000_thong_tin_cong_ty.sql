-- =====================================================================
-- Thông tin công ty (làm lại theo màn hình cũ của nhà xe)
-- - Logo: mọi người trong nhà xe xem (hiện trên app, tab trình duyệt, bản in).
-- - Giấy phép kinh doanh vận tải: số, ngày cấp, nơi cấp (in trên giấy tờ) + ảnh giấy phép.
-- - Hồ sơ pháp lý CHỈ QUẢN TRỊ (settings.manage) xem: số CCCD giám đốc, ảnh CCCD 2 mặt, ảnh giấy phép.
-- - Chữ ký giám đốc và con dấu là 2 ảnh riêng; bật / tắt in chữ ký, in con dấu trên văn bản.
-- =====================================================================

alter table public.tenants add column transport_license_date date;
alter table public.tenants add column transport_license_issuer text;

create table public.tenant_private (
  tenant_id       uuid primary key references public.tenants (id),
  director_id_no  text check (director_id_no is null or director_id_no ~ '^[0-9]{12}$'),
  updated_at      timestamptz not null default now()
);
create trigger tenant_private_touch before update on public.tenant_private for each row execute function app.touch_updated_at();
create trigger tenant_private_audit after insert or update or delete on public.tenant_private
  for each row execute function app.write_audit_redacted();
alter table public.tenant_private enable row level security;
revoke all on public.tenant_private from anon, authenticated;
grant select on public.tenant_private to authenticated;
grant select, insert, update, delete on public.tenant_private to service_role;
create policy tenant_private_select on public.tenant_private for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('settings.manage'));

drop function public.update_tenant_profile(text, text, text, text, text, text);
create function public.update_tenant_profile(p_name text, p_legal_name text, p_tax_code text,
                                             p_transport_license_no text, p_transport_license_date date,
                                             p_transport_license_issuer text, p_address text, p_phone text,
                                             p_director_id_no text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_cccd text := nullif(regexp_replace(coalesce(p_director_id_no, ''), '\s', '', 'g'), '');
begin
  if v_tid is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền cấu hình nhà xe' using errcode = '42501';
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'Tên nhà xe không được để trống' using errcode = '22023';
  end if;
  if v_cccd is not null and v_cccd !~ '^[0-9]{12}$' then
    raise exception 'Số CCCD giám đốc phải gồm 12 chữ số' using errcode = '22023';
  end if;
  update public.tenants set
    name                     = trim(p_name),
    legal_name               = nullif(trim(p_legal_name), ''),
    tax_code                 = nullif(trim(p_tax_code), ''),
    transport_license_no     = nullif(trim(p_transport_license_no), ''),
    transport_license_date   = p_transport_license_date,
    transport_license_issuer = nullif(trim(p_transport_license_issuer), ''),
    address                  = nullif(trim(p_address), ''),
    phone                    = nullif(trim(p_phone), '')
  where id = v_tid;
  insert into public.tenant_private (tenant_id, director_id_no) values (v_tid, v_cccd)
  on conflict (tenant_id) do update set director_id_no = excluded.director_id_no;
end;
$$;
revoke execute on function public.update_tenant_profile(text, text, text, text, date, text, text, text, text) from public, anon, authenticated;
grant execute on function public.update_tenant_profile(text, text, text, text, date, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------- Cấu hình bật / tắt in chữ ký, con dấu
create or replace function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v numeric;
  lim jsonb := '{
    "ban_ve.giu_ghe_quay_phut":     [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.giu_ghe_online_phut":   [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.nha_ghe_vexere_gio":    [0, 48,  "Giờ nhả ghế Vexere phải từ 0 đến 48"],
    "ban_ve.nha_dat_cho_truoc_phut":[0, 1440,"Nhả chỗ đặt trước giờ chạy phải từ 0 đến 1440 phút"],
    "giay_to.canh_bao_truoc_ngay":  [1, 180, "Số ngày cảnh báo giấy tờ phải từ 1 đến 180"],
    "chuyen.tao_truoc_ngay":        [1, 365, "Số ngày tạo chuyến trước phải từ 1 đến 365"],
    "lai_xe.gio_lien_tuc_toi_da":   [1, 12,  "Giờ lái liên tục tối đa phải từ 1 đến 12"],
    "lai_xe.gio_ngay_toi_da":       [1, 24,  "Giờ lái tối đa trong ngày phải từ 1 đến 24"],
    "lai_xe.gio_tuan_toi_da":       [1, 168, "Giờ lái tối đa trong tuần phải từ 1 đến 168"]
  }';
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if lim ? new.key then
    if jsonb_typeof(new.value) <> 'number' then
      raise exception 'Giá trị phải là số' using errcode = '22023';
    end if;
    v := (new.value #>> '{}')::numeric;
    if v <> trunc(v) then
      raise exception 'Giá trị phải là số nguyên' using errcode = '22023';
    end if;
    if v < (lim -> new.key ->> 0)::numeric or v > (lim -> new.key ->> 1)::numeric then
      raise exception '%', lim -> new.key ->> 2 using errcode = '22023';
    end if;
  elsif new.key in ('ban_ve.tu_nha_dat_cho', 'in.chu_ky_giam_doc', 'in.con_dau') then
    if jsonb_typeof(new.value) <> 'boolean' then
      raise exception 'Giá trị phải là bật / tắt' using errcode = '22023';
    end if;
  elsif new.key = 'lenh.hau_to' then
    if jsonb_typeof(new.value) <> 'string' or (new.value #>> '{}') !~ '^[A-Z0-9]{1,10}$' then
      raise exception 'Hậu tố số lệnh: 1–10 chữ in hoa hoặc số, không dấu (vd TGTP)' using errcode = '22023';
    end if;
  elsif new.key in ('cong_ty.giam_doc', 'cong_ty.chuc_danh_ky', 've.ghi_chu') then
    if jsonb_typeof(new.value) <> 'string' or length(new.value #>> '{}') > 500 then
      raise exception 'Giá trị phải là chữ, tối đa 500 ký tự' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- Storage
-- <tenant>/cong_ty/logo.png        : mọi người trong nhà xe xem; quản trị đổi / bỏ
-- <tenant>/cong_ty/ho_so/<tệp>     : ảnh giấy phép, CCCD giám đốc – chỉ quản trị
-- <tenant>/chu_ky/con_dau.png      : con dấu – như chữ ký giám đốc (quản trị tải, người điều hành xem để in)
create function app.can_read_company_file(p_path text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_path = 'logo.png' then app.current_tenant_id() is not null
              else app.has_permission('settings.manage') end
$$;
revoke execute on function app.can_read_company_file(text) from public, anon;
grant execute on function app.can_read_company_file(text) to authenticated, service_role;

create or replace function app.can_write_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_file in ('giam_doc.png', 'con_dau.png') then app.has_permission('settings.manage')
              else p_file = auth.uid()::text || '.png' end
$$;

create policy cong_ty_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'cong_ty'
         and app.can_read_company_file(substr(name, length((storage.foldername(name))[1]) + 10)));
create policy cong_ty_write on storage.objects for insert to authenticated
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'cong_ty' and app.has_permission('settings.manage'));
create policy cong_ty_update on storage.objects for update to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'cong_ty' and app.has_permission('settings.manage'))
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'cong_ty' and app.has_permission('settings.manage'));
-- "Bỏ ảnh": xóa logo / ảnh hồ sơ công ty / chữ ký / con dấu
create policy cong_ty_delete on storage.objects for delete to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'cong_ty' and app.has_permission('settings.manage'));
create policy chu_ky_delete on storage.objects for delete to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'chu_ky' and app.can_write_signature(storage.filename(name)));
