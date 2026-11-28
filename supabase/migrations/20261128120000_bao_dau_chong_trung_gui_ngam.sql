-- =====================================================================
-- Báo đổ dầu:
-- 1) Chống gửi trùng: phiếu cùng ảnh (mã băm ảnh) hoặc cùng xe + cùng ngày + cùng số lít + cùng số tiền đã gửi
--    (chưa bị bỏ) thì báo "đã gửi rồi" (trong cả nhà xe, 60 ngày gần nhất). Kiểm tra trước khi AI đọc: fuel_photos_sent.
-- 2) Gửi ngay, ảnh tải ngầm: phiếu tạo trước (chưa có ảnh), ảnh lưu xong thì gắn vào phiếu (attach_fuel_photos);
--    phiếu đã duyệt thì gắn luôn vào phiếu nhiên liệu đã tạo.
-- =====================================================================
alter table public.fuel_reports add column photo_hashes text[] not null default '{}';
create index fuel_reports_hash_idx on public.fuel_reports using gin (photo_hashes);

/** Phiếu (chưa bị bỏ) đã gửi trùng ảnh hoặc trùng số liệu; null = chưa có. */
create function app.fuel_dup(p_tid uuid, p_hashes text[], p_veh uuid, p_date date, p_lit numeric, p_amount bigint)
returns text
language sql stable security definer set search_path = ''
as $$
  select 'Phiếu đổ dầu này đã gửi rồi (xe ' || r.plate || ', gửi lúc '
         || to_char(r.created_at at time zone 'Asia/Ho_Chi_Minh', 'HH24:MI DD/MM') || ', '
         || case r.status when 'cho' then 'đang chờ duyệt' else 'đã duyệt' end || ')'
  from public.fuel_reports r
  where r.tenant_id = p_tid and r.status <> 'bo' and r.created_at > now() - interval '60 days'
    and ((cardinality(p_hashes) > 0 and r.photo_hashes && p_hashes)
         or (p_veh is not null and r.vehicle_id = p_veh and r.entry_date = p_date and r.liters = p_lit
             and coalesce(r.amount, round(r.liters * r.unit_price)) = p_amount))
  order by r.created_at desc limit 1
$$;
revoke execute on function app.fuel_dup(uuid, text[], uuid, date, numeric, bigint) from public, anon, authenticated;

/** Kiểm tra trước khi đọc ảnh: ảnh đã gửi ở phiếu khác chưa. */
create function public.fuel_photos_sent(p_hashes text[])
returns text
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or public.my_staff_id() is null then return null; end if;
  return app.fuel_dup(v_tid, coalesce(p_hashes, '{}'), null, null, null, null);
end;
$$;
revoke execute on function public.fuel_photos_sent(text[]) from public, anon, authenticated;
grant execute on function public.fuel_photos_sent(text[]) to authenticated, service_role;

create or replace function public.report_fuel(p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_staff uuid := public.my_staff_id();
  v_key text := nullif(trim(p ->> 'key'), '');
  v_plate text := upper(regexp_replace(coalesce(p ->> 'plate', ''), '[^A-Za-z0-9]', '', 'g'));
  v_veh uuid;
  v_plate_txt text;
  v_lit numeric := nullif(p ->> 'liters', '')::numeric;
  v_price bigint := nullif(p ->> 'unit_price', '')::numeric::bigint;
  v_amount bigint := nullif(p ->> 'amount', '')::numeric::bigint;
  v_files text[] := coalesce(array(select jsonb_array_elements_text(p -> 'files')), '{}');
  v_hash text[] := coalesce(array(select left(x, 100) from jsonb_array_elements_text(p -> 'hashes') x limit 6), '{}');
  v_date date := coalesce(nullif(p ->> 'entry_date', '')::date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_dup text;
  v_id uuid;
begin
  if v_tid is null or v_staff is null then
    raise exception 'Chỉ lái xe / nhân viên có hồ sơ mới báo đổ dầu được' using errcode = '42501';
  end if;
  if v_key is null or length(v_key) > 100 then raise exception 'Thiếu mã gửi' using errcode = '22023'; end if;
  select id into v_id from public.fuel_reports where tenant_id = v_tid and client_key = v_key;
  if v_id is not null then return v_id; end if;
  if v_plate = '' then raise exception 'Chọn biển số xe' using errcode = '22023'; end if;
  select id, plate into v_veh, v_plate_txt from public.vehicles
   where tenant_id = v_tid and upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g')) = v_plate limit 1;
  if v_veh is null then raise exception 'Không tìm thấy xe biển số %', p ->> 'plate' using errcode = 'P0002'; end if;
  if not (app.is_my_vehicle(v_veh) or app.has_permission('fuel.add')) then
    raise exception 'Xe % không có trong chuyến được xếp cho bạn: lái xe chạy xe nào báo đổ dầu xe đó', v_plate_txt using errcode = '42501';
  end if;
  if coalesce(v_lit, 0) <= 0 or v_lit > 2000 then raise exception 'Nhập số lít' using errcode = '22023'; end if;
  if coalesce(v_price, 0) <= 0 and coalesce(v_amount, 0) > 0 then v_price := round(v_amount / v_lit); end if;
  if coalesce(v_price, 0) <= 0 then raise exception 'Nhập đơn giá hoặc thành tiền' using errcode = '22023'; end if;
  if array_length(v_files, 1) > 6 then raise exception 'Tối đa 6 ảnh' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_files) f where f not like v_tid::text || '/bao_dau/' || v_staff::text || '/%') then
    raise exception 'Ảnh không hợp lệ' using errcode = '22023';
  end if;
  -- chống trùng: khóa theo xe để 2 lần bấm cùng lúc không lọt
  perform pg_advisory_xact_lock(hashtextextended('bao_dau:' || v_veh::text, 0));
  v_dup := app.fuel_dup(v_tid, v_hash, v_veh, v_date, v_lit, coalesce(v_amount, round(v_lit * v_price))::bigint);
  if v_dup is not null then raise exception '%', v_dup using errcode = '23505'; end if;
  insert into public.fuel_reports (tenant_id, staff_id, vehicle_id, plate, entry_date, entry_time, odo_km, liters, unit_price, amount,
                                   supplier, invoice_no, note, files, client_key, photo_hashes)
  values (v_tid, v_staff, v_veh, v_plate_txt, v_date,
          nullif(p ->> 'entry_time', '')::time, nullif(p ->> 'odo_km', '')::numeric::int, v_lit, v_price, v_amount,
          nullif(trim(p ->> 'supplier'), ''), nullif(trim(p ->> 'invoice_no'), ''), nullif(trim(p ->> 'note'), ''), v_files, v_key, v_hash)
  on conflict (tenant_id, client_key) do nothing
  returning id into v_id;
  if v_id is null then select id into v_id from public.fuel_reports where tenant_id = v_tid and client_key = v_key; end if;
  return v_id;
end;
$$;
revoke execute on function public.report_fuel(jsonb) from public, anon, authenticated;
grant execute on function public.report_fuel(jsonb) to authenticated, service_role;

/** Ảnh tải ngầm xong → gắn vào phiếu của chính mình (phiếu đã duyệt thì gắn cả vào phiếu nhiên liệu). */
create function public.attach_fuel_photos(p_key text, p_files jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_staff uuid := public.my_staff_id();
  v_files text[] := coalesce(array(select jsonb_array_elements_text(p_files)), '{}');
  r public.fuel_reports;
begin
  if v_tid is null or v_staff is null then raise exception 'Không tìm thấy phiếu' using errcode = 'P0002'; end if;
  select * into r from public.fuel_reports where tenant_id = v_tid and client_key = p_key and staff_id = v_staff for update;
  if not found then raise exception 'Không tìm thấy phiếu' using errcode = 'P0002'; end if;
  if cardinality(v_files) = 0 then return; end if;
  if cardinality(v_files) > 6 or exists (select 1 from unnest(v_files) f where f not like v_tid::text || '/bao_dau/' || v_staff::text || '/%' or f like '%..%') then
    raise exception 'Ảnh không hợp lệ' using errcode = '22023';
  end if;
  update public.fuel_reports set files = array(select distinct x from unnest(files || v_files) x) where id = r.id;
  if r.fuel_entry_id is not null then
    update public.fuel_entries set files = array(select distinct x from unnest(files || v_files) x) where tenant_id = v_tid and id = r.fuel_entry_id;
  end if;
end;
$$;
revoke execute on function public.attach_fuel_photos(text, jsonb) from public, anon, authenticated;
grant execute on function public.attach_fuel_photos(text, jsonb) to authenticated, service_role;
