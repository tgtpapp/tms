-- =====================================================================
-- Giai đoạn 3.4b – Lệnh vận chuyển (in giấy theo mẫu của nhà xe)
-- - Số lệnh: <giờ chạy HHMM>-<DDMMYY>/LVC-<hậu tố công ty> (vd 0700-191126/LVC-TGTP).
--   Hậu tố đặt trong Cấu hình (lenh.hau_to). Trùng giờ + ngày ở tuyến khác → thêm ".2", ".3"…
-- - Lệnh được CẤP 1 lần cho mỗi chuyến (giữ số), in lại bao nhiêu lần cũng cùng số.
-- - Chữ ký: Giám đốc (kèm dấu) đặt trong Cấu hình; mỗi người tự tải chữ ký của mình.
--   Ảnh chữ ký ở Storage "giay-to/<tenant>/chu_ky/…", chỉ người điều hành và chính chủ xem được.
-- =====================================================================

alter table public.routes add column itinerary text;   -- hành trình chạy xe (in trên lệnh)

-- ---------------------------------------------------------------- Cấu hình chữ
create or replace function app.validate_tenant_setting()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  v numeric;
  lim jsonb := '{
    "ban_ve.giu_ghe_quay_phut":    [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.giu_ghe_online_phut":  [1, 120, "Thời gian giữ ghế phải từ 1 đến 120 phút"],
    "ban_ve.nha_ghe_vexere_gio":   [0, 48,  "Giờ nhả ghế Vexere phải từ 0 đến 48"],
    "giay_to.canh_bao_truoc_ngay": [1, 180, "Số ngày cảnh báo giấy tờ phải từ 1 đến 180"],
    "chuyen.tao_truoc_ngay":       [1, 365, "Số ngày tạo chuyến trước phải từ 1 đến 365"],
    "lai_xe.gio_lien_tuc_toi_da":  [1, 12,  "Giờ lái liên tục tối đa phải từ 1 đến 12"],
    "lai_xe.gio_ngay_toi_da":      [1, 24,  "Giờ lái tối đa trong ngày phải từ 1 đến 24"],
    "lai_xe.gio_tuan_toi_da":      [1, 168, "Giờ lái tối đa trong tuần phải từ 1 đến 168"]
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
  elsif new.key = 'lenh.hau_to' then
    if jsonb_typeof(new.value) <> 'string' or (new.value #>> '{}') !~ '^[A-Z0-9]{1,10}$' then
      raise exception 'Hậu tố số lệnh: 1–10 chữ in hoa hoặc số, không dấu (vd TGTP)' using errcode = '22023';
    end if;
  elsif new.key in ('cong_ty.giam_doc', 'cong_ty.chuc_danh_ky') then
    if jsonb_typeof(new.value) <> 'string' or length(new.value #>> '{}') > 100 then
      raise exception 'Giá trị phải là chữ, tối đa 100 ký tự' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------- Lệnh vận chuyển
create table public.transport_orders (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  trip_id      uuid not null,
  order_no     text not null,
  valid_from   date not null,
  valid_to     date not null,
  issued_by    uuid,
  issued_at    timestamptz not null default now(),
  print_count  int not null default 0,
  unique (tenant_id, id),
  unique (tenant_id, trip_id),
  unique (tenant_id, order_no),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id)
);
create trigger transport_orders_audit after insert or update or delete on public.transport_orders
  for each row execute function app.write_audit();

alter table public.transport_orders enable row level security;
revoke all on public.transport_orders from anon, authenticated;
grant select on public.transport_orders to authenticated;
grant select, insert, update, delete on public.transport_orders to service_role;
create policy transport_orders_select on public.transport_orders for select to authenticated
  using (tenant_id = app.current_tenant_id());

-- Cấp lệnh (hoặc trả lại lệnh đã cấp) cho chuyến hợp lệ (đủ giờ + xe + lái xe 1). Mỗi lần gọi = 1 lần in.
create function public.issue_transport_order(p_trip_id uuid)
returns public.transport_orders
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_suffix text;
  v_base text;
  v_no text;
  v_n int := 1;
  v_order public.transport_orders;
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  update public.transport_orders set print_count = print_count + 1
  where tenant_id = v_tid and trip_id = p_trip_id
  returning * into v_order;
  if found then
    return v_order;
  end if;

  if v_trip.status <> 'mo' then
    raise exception 'Chuyến đã hủy, không cấp lệnh' using errcode = '22023';
  end if;
  if v_trip.vehicle_id is null or not exists (select 1 from public.trip_crew where tenant_id = v_tid and trip_id = p_trip_id
                                                and role = 'lai_xe_1' and active) then
    raise exception 'Chuyến chưa đủ xe và lái xe, chưa cấp lệnh được' using errcode = '22023';
  end if;
  v_suffix := (select value #>> '{}' from public.tenant_settings where tenant_id = v_tid and key = 'lenh.hau_to');
  if v_suffix is null then
    raise exception 'Chưa cấu hình hậu tố số lệnh (Cấu hình → Lệnh vận chuyển)' using errcode = '22023';
  end if;
  v_base := to_char(v_trip.depart_at at time zone app.tenant_tz(v_tid), 'HH24MI') || '-' || to_char(v_trip.service_date, 'DDMMYY');
  v_no := v_base || '/LVC-' || v_suffix;
  while exists (select 1 from public.transport_orders where tenant_id = v_tid and order_no = v_no) loop
    v_n := v_n + 1;
    v_no := v_base || '.' || v_n || '/LVC-' || v_suffix;
  end loop;
  insert into public.transport_orders (tenant_id, trip_id, order_no, valid_from, valid_to, issued_by, print_count)
  values (v_tid, p_trip_id, v_no, v_trip.service_date, v_trip.service_date + 1, auth.uid(), 1)
  returning * into v_order;
  return v_order;
end;
$$;
revoke execute on function public.issue_transport_order(uuid) from public, anon, authenticated;
grant execute on function public.issue_transport_order(uuid) to authenticated;

-- ---------------------------------------------------------------- Chữ ký (Storage)
-- <tenant>/chu_ky/giam_doc.png       : chữ ký + dấu Giám đốc (người có settings.manage tải)
-- <tenant>/chu_ky/<user_id>.png      : chữ ký của từng người (chính người đó tải)
create function app.can_read_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.has_permission('trip.manage') or app.has_permission('settings.manage')
         or p_file = auth.uid()::text || '.png'
$$;
create function app.can_write_signature(p_file text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select case when p_file = 'giam_doc.png' then app.has_permission('settings.manage')
              else p_file = auth.uid()::text || '.png' end
$$;
revoke execute on function app.can_read_signature(text), app.can_write_signature(text) from public, anon;
grant execute on function app.can_read_signature(text), app.can_write_signature(text) to authenticated, service_role;

create policy chu_ky_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'chu_ky' and app.can_read_signature(storage.filename(name)));
create policy chu_ky_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'chu_ky' and app.can_write_signature(storage.filename(name)));
create policy chu_ky_update on storage.objects for update to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'chu_ky' and app.can_write_signature(storage.filename(name)))
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'chu_ky' and app.can_write_signature(storage.filename(name)));
