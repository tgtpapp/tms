-- =====================================================================
-- Giá vé riêng từng chiều như app cũ: bảng giá chiều đi và bảng giá chiều về tách riêng (cửa sổ Sửa tuyến chia 2 khung).
-- - fare_tables thêm cột direction ('di' / 've'); không trùng khoảng ngày trong cùng tuyến + cùng chiều.
-- - Bảng giá đang có (đang dùng chung 2 chiều) được chép thêm 1 bản cho chiều về, đảo điểm đi / điểm đến → giá bán không đổi.
-- - Tra giá: chặng đi theo thứ tự lộ trình → bảng chiều đi, ngược lại → bảng chiều về.
-- =====================================================================
alter table public.fare_tables add column direction text not null default 'di' check (direction in ('di', 've'));
alter table public.fare_tables drop constraint fare_tables_no_overlap;
alter table public.fare_tables add constraint fare_tables_no_overlap exclude using gist
  (tenant_id with =, route_id with =, direction with =, daterange(valid_from, valid_to, '[]') with &&);
drop index public.fare_tables_route_idx;
create index fare_tables_route_idx on public.fare_tables (tenant_id, route_id, direction, valid_from desc);

do $$
declare r record; v_id uuid;
begin
  for r in select * from public.fare_tables where direction = 'di' loop
    insert into public.fare_tables (tenant_id, route_id, direction, valid_from, valid_to, note, created_at, created_by, updated_at, updated_by)
    values (r.tenant_id, r.route_id, 've', r.valid_from, r.valid_to, r.note, r.created_at, r.created_by, r.updated_at, r.updated_by)
    returning id into v_id;
    insert into public.fare_table_items (tenant_id, table_id, seq, from_stop_id, to_stop_id, price)
    select tenant_id, v_id, seq, to_stop_id, from_stop_id, price from public.fare_table_items where tenant_id = r.tenant_id and table_id = r.id;
  end loop;
end;
$$;

drop function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb);
-- ---------------------------------------------------------------- Lưu bảng giá (theo chiều)
-- p_items: [{ "from": "BX Biên Hòa", "to": "Bà Rịa", "price": 150000 }, ...] (from / to trống = giá toàn tuyến)
-- p_order: danh sách điểm theo thứ tự đi (từ "Tạo chặng từ danh sách điểm"), để xếp điểm mới vào lộ trình tuyến
create function public.save_fare_table(p_id uuid, p_route_id uuid, p_valid_from date, p_valid_to date, p_note text,
                                       p_items jsonb, p_order jsonb default null, p_direction text default 'di')
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid := p_id;
  v_dir text := coalesce(p_direction, 'di');
  v_from uuid[] := '{}';
  v_to uuid[] := '{}';
  v_price int[] := '{}';
  v_keys text[] := '{}';
  v_ord uuid[] := '{}';
  v_list uuid[];
  v_old jsonb;
  v_add uuid[];
  r record;
  c record;
  v_fn text; v_tn text; v_p numeric; v_key text; v_lbl text; v_x uuid;
  i int; k int; p int; v_n int; v_m int; v_first int; v_last int;
begin
  if v_tid is null or not app.has_permission(case when p_id is null then 'fare.add' else 'fare.edit' end) then
    raise exception 'Không có quyền % bảng giá vé', case when p_id is null then 'thêm' else 'sửa' end using errcode = '42501';
  end if;
  if not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  if p_id is not null and not exists (select 1 from public.fare_tables where id = p_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy bảng giá' using errcode = 'P0002';
  end if;
  if v_dir not in ('di', 've') then
    raise exception 'Chiều không hợp lệ' using errcode = '22023';
  end if;
  if p_valid_from is null then
    raise exception 'Vui lòng nhập ngày bắt đầu áp dụng' using errcode = '22023';
  end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'Ngày kết thúc phải sau ngày bắt đầu' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Danh sách chặng không hợp lệ' using errcode = '22023';
  end if;
  select valid_from, valid_to into c from public.fare_tables
  where tenant_id = v_tid and route_id = p_route_id and direction = v_dir and id is distinct from p_id
    and daterange(valid_from, valid_to, '[]') && daterange(p_valid_from, p_valid_to, '[]')
  order by valid_from limit 1;
  if found then
    raise exception 'Khoảng ngày bị trùng với bảng giá từ % của cùng chiều', to_char(c.valid_from, 'DD/MM/YYYY')
      || case when c.valid_to is null then ' (không giới hạn)' else ' đến ' || to_char(c.valid_to, 'DD/MM/YYYY') end using errcode = '23P01';
  end if;

  -- Kiểm tra từng chặng (như app cũ), rồi mới tạo điểm
  for r in select e, ord from jsonb_array_elements(p_items) with ordinality x(e, ord) loop
    v_fn := regexp_replace(trim(coalesce(r.e ->> 'from', '')), '\s+', ' ', 'g');
    v_tn := regexp_replace(trim(coalesce(r.e ->> 'to', '')), '\s+', ' ', 'g');
    v_p := nullif(r.e ->> 'price', '')::numeric;
    continue when v_fn = '' and v_tn = '' and coalesce(v_p, 0) = 0;
    if (v_fn = '') <> (v_tn = '') then
      raise exception 'Mỗi chặng cần đủ điểm đi và điểm đến (hoặc để trống cả hai = giá toàn tuyến)' using errcode = '22023';
    end if;
    v_lbl := case when v_fn = '' then 'toàn tuyến' else v_fn || ' → ' || v_tn end;
    if v_fn <> '' and app.norm_name(v_fn) = app.norm_name(v_tn) then
      raise exception 'Chặng %: điểm đi và điểm đến phải khác nhau', v_lbl using errcode = '22023';
    end if;
    if v_p is null or v_p <= 0 or v_p <> trunc(v_p) then
      raise exception 'Chặng % chưa có giá', v_lbl using errcode = '22023';
    end if;
    v_key := case when v_fn = '' then '' else least(app.norm_name(v_fn), app.norm_name(v_tn)) || '|' || greatest(app.norm_name(v_fn), app.norm_name(v_tn)) end;
    if v_key = any(v_keys) then
      raise exception 'Chặng % bị nhập trùng', v_lbl using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
  end loop;
  if cardinality(v_keys) = 0 then
    raise exception 'Cần ít nhất một chặng có giá' using errcode = '22023';
  end if;

  for r in select e from jsonb_array_elements(p_items) e loop
    v_fn := trim(coalesce(r.e ->> 'from', ''));
    v_tn := trim(coalesce(r.e ->> 'to', ''));
    v_p := nullif(r.e ->> 'price', '')::numeric;
    continue when v_fn = '' and v_tn = '' and coalesce(v_p, 0) = 0;
    v_from := v_from || app.fare_stop(v_tid, p_route_id, v_fn);
    v_to := v_to || app.fare_stop(v_tid, p_route_id, v_tn);
    v_price := v_price || v_p::int;
  end loop;
  if jsonb_typeof(p_order) = 'array' then
    for r in select e from jsonb_array_elements_text(p_order) e loop
      continue when trim(r.e) = '';
      v_x := app.fare_stop(v_tid, p_route_id, r.e);
      if not v_x = any(v_ord) then v_ord := v_ord || v_x; end if;
    end loop;
  end if;

  -- Điểm chưa có trên lộ trình tuyến → thêm vào
  v_list := array(select stop_id from public.route_stops where tenant_id = v_tid and route_id = p_route_id order by seq);
  v_add := array(select distinct x from unnest(v_from || v_to) x where x is not null and not x = any(v_list));
  if cardinality(v_add) > 0 then
    -- danh sách điểm ghi ngược chiều tuyến thì đảo lại
    select min(array_position(v_list, x)) filter (where o = fo), min(array_position(v_list, x)) filter (where o = lo)
      into v_first, v_last
    from (select x, o, min(o) over () fo, max(o) over () lo
          from unnest(v_ord) with ordinality u(x, o) where x = any(v_list)) y;
    if v_first is not null and v_last is not null and v_first > v_last then
      v_ord := array(select x from unnest(v_ord) with ordinality u(x, o) order by o desc);
    end if;
    for i in 1 .. coalesce(cardinality(v_ord), 0) loop
      v_x := v_ord[i];
      continue when not v_x = any(v_add) or v_x = any(v_list);
      p := null;
      for k in reverse i - 1 .. 1 loop
        if v_ord[k] = any(v_list) then p := array_position(v_list, v_ord[k]); exit; end if;
      end loop;
      if p is not null then
        v_list := v_list[1:p] || v_x || v_list[p + 1:];
      else
        for k in i + 1 .. cardinality(v_ord) loop
          if v_ord[k] = any(v_list) then p := array_position(v_list, v_ord[k]); exit; end if;
        end loop;
        if p is not null then v_list := v_list[1:p - 1] || v_x || v_list[p:]; else v_list := v_list || v_x; end if;
      end if;
    end loop;
    -- gõ tay (không có trong danh sách điểm): xếp ngay trước điểm cuối của chiều đang nhập
    foreach v_x in array v_add loop
      continue when v_x = any(v_list);
      v_n := cardinality(v_list);
      if v_n < 2 then v_list := v_list || v_x;
      elsif v_dir = 've' then v_list := v_list[1:1] || v_x || v_list[2:];
      else v_list := v_list[1:v_n - 1] || v_x || v_list[v_n:]; end if;
    end loop;

    select jsonb_object_agg(stop_id::text, jsonb_build_object('m', minutes_from_start, 'p', allow_pickup, 'd', allow_dropoff)) into v_old
    from public.route_stops where tenant_id = v_tid and route_id = p_route_id;
    v_old := coalesce(v_old, '{}');
    delete from public.route_stops where tenant_id = v_tid and route_id = p_route_id;
    v_m := 0;
    for i in 1 .. cardinality(v_list) loop
      if v_old ? v_list[i]::text then
        v_m := greatest(v_m, (v_old -> v_list[i]::text ->> 'm')::int);
        insert into public.route_stops (tenant_id, route_id, seq, stop_id, minutes_from_start, allow_pickup, allow_dropoff)
        values (v_tid, p_route_id, i, v_list[i], case when i = 1 then 0 else v_m end,
                (v_old -> v_list[i]::text ->> 'p')::boolean or i = 1, (v_old -> v_list[i]::text ->> 'd')::boolean or i = cardinality(v_list));
      else
        insert into public.route_stops (tenant_id, route_id, seq, stop_id, minutes_from_start, allow_pickup, allow_dropoff)
        values (v_tid, p_route_id, i, v_list[i], case when i = 1 then 0 else v_m end, true, true);
      end if;
    end loop;
    perform app.reindex_route_seats(v_tid, p_route_id);
  end if;

  begin
    if v_id is null then
      insert into public.fare_tables (tenant_id, route_id, direction, valid_from, valid_to, note, created_by, updated_by)
      values (v_tid, p_route_id, v_dir, p_valid_from, p_valid_to, nullif(trim(coalesce(p_note, '')), ''), auth.uid(), auth.uid())
      returning id into v_id;
    else
      update public.fare_tables
      set route_id = p_route_id, direction = v_dir, valid_from = p_valid_from, valid_to = p_valid_to, note = nullif(trim(coalesce(p_note, '')), ''),
          updated_at = now(), updated_by = auth.uid()
      where tenant_id = v_tid and id = v_id;
      delete from public.fare_table_items where tenant_id = v_tid and table_id = v_id;
    end if;
  exception when exclusion_violation then
    raise exception 'Khoảng ngày bị trùng với bảng giá khác của cùng chiều' using errcode = '23P01';
  end;
  insert into public.fare_table_items (tenant_id, table_id, seq, from_stop_id, to_stop_id, price)
  select v_tid, v_id, o::int, v_from[o], v_to[o], v_price[o] from generate_subscripts(v_price, 1) o;
  return v_id;
end;
$$;


revoke execute on function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb, text) to authenticated;

-- ---------------------------------------------------------------- Tra giá theo chiều
create or replace function public.fare_for(p_route_id uuid, p_from_stop uuid, p_to_stop uuid, p_at date default null)
returns int
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_a uuid := least(p_from_stop, p_to_stop);
  v_b uuid := greatest(p_from_stop, p_to_stop);
  v_at date := coalesce(p_at, app.local_today());
  v_sa int; v_sb int;
  v_tab uuid;
  v_p int;
  v_s uuid; v_e uuid;
begin
  if v_tid is null or not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  select seq into v_sa from public.route_stops where tenant_id = v_tid and route_id = p_route_id and stop_id = p_from_stop;
  select seq into v_sb from public.route_stops where tenant_id = v_tid and route_id = p_route_id and stop_id = p_to_stop;
  if v_sa is null or v_sb is null or v_sa = v_sb then
    raise exception 'Chặng không thuộc tuyến' using errcode = 'P0002';
  end if;

  select id into v_tab from public.fare_tables
  where tenant_id = v_tid and route_id = p_route_id and direction = case when v_sa < v_sb then 'di' else 've' end
    and valid_from <= v_at and (valid_to is null or valid_to >= v_at)
  order by valid_from desc limit 1;
  if v_tab is null then
    raise exception 'Tuyến chưa có giá vé %', case when v_sa < v_sb then 'chiều đi' else 'chiều về' end using errcode = 'P0002';
  end if;

  select price into v_p from public.fare_table_items
  where tenant_id = v_tid and table_id = v_tab and least(from_stop_id, to_stop_id) = v_a and greatest(from_stop_id, to_stop_id) = v_b;
  if v_p is not null then return v_p; end if;
  select price into v_p from public.fare_table_items where tenant_id = v_tid and table_id = v_tab and from_stop_id is null;
  if v_p is not null then return v_p; end if;
  -- bảng không có dòng toàn tuyến: chặng 2 đầu tuyến, không nữa thì chặng giá cao nhất
  select stop_id into v_s from public.route_stops where tenant_id = v_tid and route_id = p_route_id order by seq limit 1;
  select stop_id into v_e from public.route_stops where tenant_id = v_tid and route_id = p_route_id order by seq desc limit 1;
  select price into v_p from public.fare_table_items
  where tenant_id = v_tid and table_id = v_tab and least(from_stop_id, to_stop_id) = least(v_s, v_e)
    and greatest(from_stop_id, to_stop_id) = greatest(v_s, v_e);
  if v_p is not null then return v_p; end if;
  select max(price) into v_p from public.fare_table_items where tenant_id = v_tid and table_id = v_tab;
  return v_p;
end;
$$;

-- ---------------------------------------------------------------- Giá từng chặng của chuyến (Bán vé), theo chiều
create or replace function public.trip_fares(p_trip_id uuid)
returns table (from_stop_id uuid, to_stop_id uuid, price int, listed boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_di uuid; v_ve uuid; v_s uuid; v_e uuid;
  a record; b record;
begin
  if v_tid is null or not app.has_permission('sell.view') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  select id into v_di from public.fare_tables
  where tenant_id = v_tid and route_id = v_trip.route_id and direction = 'di' and valid_from <= v_trip.service_date
    and (valid_to is null or valid_to >= v_trip.service_date)
  order by valid_from desc limit 1;
  select id into v_ve from public.fare_tables
  where tenant_id = v_tid and route_id = v_trip.route_id and direction = 've' and valid_from <= v_trip.service_date
    and (valid_to is null or valid_to >= v_trip.service_date)
  order by valid_from desc limit 1;
  select stop_id into v_s from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id order by seq limit 1;
  select stop_id into v_e from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id order by seq desc limit 1;
  for a in select stop_id, seq from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id loop
    for b in select stop_id, seq from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id and stop_id <> a.stop_id loop
      from_stop_id := a.stop_id;
      to_stop_id := b.stop_id;
      begin
        price := public.fare_for(v_trip.route_id, a.stop_id, b.stop_id, v_trip.service_date);
      exception when others then
        price := null;
      end;
      listed := least(a.stop_id, b.stop_id) = least(v_s, v_e) and greatest(a.stop_id, b.stop_id) = greatest(v_s, v_e)
        or exists (select 1 from public.fare_table_items i
                   where i.tenant_id = v_tid and i.table_id = case when a.seq < b.seq then v_di else v_ve end
                     and least(i.from_stop_id, i.to_stop_id) = least(a.stop_id, b.stop_id)
                     and greatest(i.from_stop_id, i.to_stop_id) = greatest(a.stop_id, b.stop_id));
      if price is not null then
        return next;
      end if;
    end loop;
  end loop;
end;
$$;
