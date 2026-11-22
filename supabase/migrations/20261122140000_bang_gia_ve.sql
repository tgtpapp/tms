-- =====================================================================
-- Bảng giá vé như app cũ: màn hình riêng, mỗi bảng giá = 1 tuyến + khoảng ngày áp dụng (từ ngày / đến ngày, để trống = không
-- giới hạn) + ghi chú (vd giá dịp Tết) + danh sách chặng "Điểm đi → Điểm đến → Giá" (để trống cả 2 điểm = giá toàn tuyến).
-- - Cùng tuyến không được 2 bảng giá trùng khoảng ngày.
-- - Tra giá: chặng có trong bảng (2 chiều như nhau) → giá chặng; không có → giá toàn tuyến; bảng không có dòng toàn tuyến
--   → chặng 2 đầu tuyến, không nữa thì chặng giá cao nhất (như app cũ).
-- - Gõ điểm chưa có: tự tạo điểm và thêm vào lộ trình tuyến (bán vé chặng cần thứ tự điểm). Có "danh sách điểm theo thứ tự đi"
--   thì xếp theo danh sách đó, gõ tay thì xếp ngay trước điểm cuối tuyến (sửa lại được ở mục Tuyến). Vé đã bán của các chuyến
--   chưa xuất bến được đánh lại thứ tự điểm theo lộ trình mới, không đổi chặng / ghế / tiền.
-- - Ô quyền riêng "Bảng giá vé" (Xem / Thêm / Sửa / Xóa). Ai đang sửa được tuyến có đủ 4 ô; ai xem tuyến hoặc bán vé có ô Xem.
-- - Giá cũ (giá toàn tuyến + giá chặng theo ngày áp dụng) chuyển sang bảng giá, giữ nguyên giá từng ngày; bảng cũ giữ lại, không xóa.
-- =====================================================================

-- ---------------------------------------------------------------- Ô quyền
insert into public.permissions (code, module, name) values
  ('fare.view', 'fare', 'Bảng giá vé: Xem'), ('fare.add', 'fare', 'Bảng giá vé: Thêm'),
  ('fare.edit', 'fare', 'Bảng giá vé: Sửa'), ('fare.delete', 'fare', 'Bảng giá vé: Xóa')
on conflict (code) do nothing;
update public.permissions set name = replace(name, 'Tuyến & giá vé', 'Tuyến') where module = 'route';
select app.grant_permission_to_admins(c) from unnest(array['fare.view', 'fare.add', 'fare.edit', 'fare.delete']) c;
insert into public.role_permissions (tenant_id, role_id, permission_code)
select distinct rp.tenant_id, rp.role_id, c from public.role_permissions rp, unnest(array['fare.view', 'fare.add', 'fare.edit', 'fare.delete']) c
where rp.permission_code = 'route.edit'
on conflict do nothing;
insert into public.role_permissions (tenant_id, role_id, permission_code)
select distinct rp.tenant_id, rp.role_id, 'fare.view' from public.role_permissions rp
where rp.permission_code in ('route.view', 'sell.view')
on conflict do nothing;
do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, 'array[''route.view'', ''vehicle.view''', 'array[''route.view'', ''fare.view'', ''vehicle.view''');
  if (length(v) - length(replace(v, 'fare.view', ''))) / 9 < 2 then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

-- ---------------------------------------------------------------- Bảng
create table public.fare_tables (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  route_id    uuid not null,
  valid_from  date not null,
  valid_to    date,                                   -- null = không giới hạn
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (tenant_id, id),
  check (valid_to is null or valid_to >= valid_from),
  foreign key (tenant_id, route_id) references public.routes (tenant_id, id) on delete cascade,
  constraint fare_tables_no_overlap exclude using gist
    (tenant_id with =, route_id with =, daterange(valid_from, valid_to, '[]') with &&)
);
create index fare_tables_route_idx on public.fare_tables (tenant_id, route_id, valid_from desc);

-- Chặng giữ đúng chiều đã nhập (Điểm đi → Điểm đến) để hiện như app cũ; tra giá thì 2 chiều như nhau
create table public.fare_table_items (
  tenant_id     uuid not null,
  table_id      uuid not null,
  seq           int not null check (seq >= 1),
  from_stop_id  uuid,
  to_stop_id    uuid,
  price         int not null check (price > 0),
  primary key (tenant_id, table_id, seq),
  check ((from_stop_id is null) = (to_stop_id is null)),
  check (from_stop_id <> to_stop_id),
  foreign key (tenant_id, table_id) references public.fare_tables (tenant_id, id) on delete cascade,
  foreign key (tenant_id, from_stop_id) references public.stops (tenant_id, id),
  foreign key (tenant_id, to_stop_id) references public.stops (tenant_id, id)
);
create unique index fare_table_items_pair_uq on public.fare_table_items
  (tenant_id, table_id, least(from_stop_id, to_stop_id), greatest(from_stop_id, to_stop_id)) nulls not distinct;

alter table public.fare_tables enable row level security;
alter table public.fare_table_items enable row level security;
revoke all on public.fare_tables, public.fare_table_items from public, anon, authenticated;
grant select on public.fare_tables, public.fare_table_items to authenticated;
grant select, insert, update, delete on public.fare_tables, public.fare_table_items to service_role;
create policy fare_tables_select on public.fare_tables for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy fare_table_items_select on public.fare_table_items for select to authenticated
  using (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------- Chuyển giá cũ sang bảng giá
-- Mỗi ngày áp dụng của tuyến = 1 bảng giá đến hết ngày trước lần đổi giá sau; giá trong bảng = giá đang áp dụng ngày đó.
do $$
declare r record; d record; v_id uuid; n int;
begin
  for r in select distinct tenant_id, route_id from public.route_fares loop
    for d in select e, lead(e) over (order by e) as nxt
             from (select distinct effective_from as e from public.route_fares where tenant_id = r.tenant_id and route_id = r.route_id) x loop
      insert into public.fare_tables (tenant_id, route_id, valid_from, valid_to)
      values (r.tenant_id, r.route_id, d.e, d.nxt - 1) returning id into v_id;
      insert into public.fare_table_items (tenant_id, table_id, seq, from_stop_id, to_stop_id, price)
      select r.tenant_id, v_id, row_number() over (order by (f.from_stop_id is not null), least(sa.seq, sb.seq), greatest(sa.seq, sb.seq)),
             case when coalesce(sa.seq, 0) <= coalesce(sb.seq, 0) then f.from_stop_id else f.to_stop_id end,
             case when coalesce(sa.seq, 0) <= coalesce(sb.seq, 0) then f.to_stop_id else f.from_stop_id end,
             f.price
      from (select distinct on (from_stop_id, to_stop_id) from_stop_id, to_stop_id, price
            from public.route_fares
            where tenant_id = r.tenant_id and route_id = r.route_id and effective_from <= d.e
            order by from_stop_id, to_stop_id, effective_from desc) f
      left join public.route_stops sa on sa.tenant_id = r.tenant_id and sa.route_id = r.route_id and sa.stop_id = f.from_stop_id
      left join public.route_stops sb on sb.tenant_id = r.tenant_id and sb.route_id = r.route_id and sb.stop_id = f.to_stop_id
      where f.price is not null;
      get diagnostics n = row_count;
      if n = 0 then delete from public.fare_tables where tenant_id = r.tenant_id and id = v_id; end if;
    end loop;
  end loop;
end;
$$;

create trigger fare_tables_audit after insert or update or delete on public.fare_tables
  for each row execute function app.write_audit();

-- ---------------------------------------------------------------- Hàm phụ
create function app.norm_name(p text)
returns text
language sql immutable set search_path = ''
as $$ select lower(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')) $$;

-- Điểm theo tên (không phân biệt hoa thường, khoảng trắng): ưu tiên điểm đã có trên tuyến; chưa có thì tạo mới
create function app.fare_stop(p_tenant uuid, p_route uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_name text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
  v_id uuid;
  v_active boolean;
  v_code text;
  k int := 1;
begin
  if v_name = '' then return null; end if;
  select s.id, s.is_active into v_id, v_active
  from public.stops s
  left join public.route_stops rs on rs.tenant_id = s.tenant_id and rs.route_id = p_route and rs.stop_id = s.id
  where s.tenant_id = p_tenant and app.norm_name(s.name) = app.norm_name(v_name)
  order by (rs.stop_id is not null) desc, s.is_active desc, s.created_at
  limit 1;
  if v_id is not null then
    if not v_active then update public.stops set is_active = true where tenant_id = p_tenant and id = v_id; end if;
    return v_id;
  end if;
  loop
    v_code := 'BG' || k;
    exit when not exists (select 1 from public.stops where tenant_id = p_tenant and code = v_code);
    k := k + 1;
  end loop;
  insert into public.stops (tenant_id, code, name, kind)
  values (p_tenant, v_code, v_name, case when v_name ~* '^(bx|bến xe)\s' then 'ben_xe' else 'diem_don_tra' end)
  returning id into v_id;
  return v_id;
end;
$$;

-- Lộ trình tuyến đổi (thêm điểm): đánh lại thứ tự điểm của vé các chuyến chưa xuất bến theo lộ trình mới.
-- Đi 2 bước (đẩy ra xa rồi đặt lại) để không vướng ràng buộc chống bán trùng trong lúc cập nhật.
create function app.reindex_route_seats(p_tenant uuid, p_route uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.seat_inventory s set from_idx = s.from_idx + 100000, to_idx = s.to_idx + 100000
  from public.trips t
  where t.tenant_id = s.tenant_id and t.id = s.trip_id and t.tenant_id = p_tenant and t.route_id = p_route
    and not app.trip_locked(t.tenant_id, t.id) and s.status in ('giu', 'dat', 'da_tt')
    and app.stop_idx(p_tenant, p_route, t.direction, s.from_stop_id) is not null
    and app.stop_idx(p_tenant, p_route, t.direction, s.to_stop_id) is not null
    and (s.from_idx, s.to_idx) is distinct from (app.stop_idx(p_tenant, p_route, t.direction, s.from_stop_id),
                                                 app.stop_idx(p_tenant, p_route, t.direction, s.to_stop_id));
  update public.seat_inventory s
  set from_idx = app.stop_idx(p_tenant, p_route, t.direction, s.from_stop_id),
      to_idx = app.stop_idx(p_tenant, p_route, t.direction, s.to_stop_id)
  from public.trips t
  where t.tenant_id = s.tenant_id and t.id = s.trip_id and t.tenant_id = p_tenant and t.route_id = p_route
    and not app.trip_locked(t.tenant_id, t.id)
    and app.stop_idx(p_tenant, p_route, t.direction, s.from_stop_id) is not null
    and app.stop_idx(p_tenant, p_route, t.direction, s.to_stop_id) is not null
    and (s.from_idx, s.to_idx) is distinct from (app.stop_idx(p_tenant, p_route, t.direction, s.from_stop_id),
                                                 app.stop_idx(p_tenant, p_route, t.direction, s.to_stop_id));
end;
$$;

-- ---------------------------------------------------------------- Lưu bảng giá
-- p_items: [{ "from": "BX Biên Hòa", "to": "Bà Rịa", "price": 150000 }, ...] (from / to trống = giá toàn tuyến)
-- p_order: danh sách điểm theo thứ tự đi (từ "Tạo chặng từ danh sách điểm"), để xếp điểm mới vào lộ trình tuyến
create function public.save_fare_table(p_id uuid, p_route_id uuid, p_valid_from date, p_valid_to date, p_note text,
                                       p_items jsonb, p_order jsonb default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid := p_id;
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
  where tenant_id = v_tid and route_id = p_route_id and id is distinct from p_id
    and daterange(valid_from, valid_to, '[]') && daterange(p_valid_from, p_valid_to, '[]')
  order by valid_from limit 1;
  if found then
    raise exception 'Khoảng ngày bị trùng với bảng giá từ % của cùng tuyến', to_char(c.valid_from, 'DD/MM/YYYY')
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
    -- gõ tay (không có trong danh sách điểm): xếp ngay trước điểm cuối tuyến
    foreach v_x in array v_add loop
      continue when v_x = any(v_list);
      v_n := cardinality(v_list);
      if v_n >= 2 then v_list := v_list[1:v_n - 1] || v_x || v_list[v_n:]; else v_list := v_list || v_x; end if;
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
      insert into public.fare_tables (tenant_id, route_id, valid_from, valid_to, note, created_by, updated_by)
      values (v_tid, p_route_id, p_valid_from, p_valid_to, nullif(trim(coalesce(p_note, '')), ''), auth.uid(), auth.uid())
      returning id into v_id;
    else
      update public.fare_tables
      set route_id = p_route_id, valid_from = p_valid_from, valid_to = p_valid_to, note = nullif(trim(coalesce(p_note, '')), ''),
          updated_at = now(), updated_by = auth.uid()
      where tenant_id = v_tid and id = v_id;
      delete from public.fare_table_items where tenant_id = v_tid and table_id = v_id;
    end if;
  exception when exclusion_violation then
    raise exception 'Khoảng ngày bị trùng với bảng giá khác của cùng tuyến' using errcode = '23P01';
  end;
  insert into public.fare_table_items (tenant_id, table_id, seq, from_stop_id, to_stop_id, price)
  select v_tid, v_id, o::int, v_from[o], v_to[o], v_price[o] from generate_subscripts(v_price, 1) o;
  return v_id;
end;
$$;

create function public.delete_fare_table(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('fare.delete') then
    raise exception 'Không có quyền xóa bảng giá vé' using errcode = '42501';
  end if;
  delete from public.fare_tables where tenant_id = v_tid and id = p_id;
  if not found then raise exception 'Không tìm thấy bảng giá' using errcode = 'P0002'; end if;
end;
$$;

-- ---------------------------------------------------------------- Tra giá theo bảng giá
create or replace function public.fare_for(p_route_id uuid, p_from_stop uuid, p_to_stop uuid, p_at date default null)
returns int
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_a uuid := least(p_from_stop, p_to_stop);
  v_b uuid := greatest(p_from_stop, p_to_stop);
  v_at date := coalesce(p_at, app.local_today());
  v_tab uuid;
  v_p int;
  v_s uuid; v_e uuid;
begin
  if v_tid is null or not exists (select 1 from public.routes where id = p_route_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy tuyến' using errcode = 'P0002';
  end if;
  if p_from_stop is null or p_from_stop = p_to_stop
     or (select count(*) from public.route_stops
         where tenant_id = v_tid and route_id = p_route_id and stop_id in (p_from_stop, p_to_stop)) <> 2 then
    raise exception 'Chặng không thuộc tuyến' using errcode = 'P0002';
  end if;

  select id into v_tab from public.fare_tables
  where tenant_id = v_tid and route_id = p_route_id and valid_from <= v_at and (valid_to is null or valid_to >= v_at)
  order by valid_from desc limit 1;
  if v_tab is null then
    raise exception 'Tuyến chưa có giá vé' using errcode = 'P0002';
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

-- Giá từng chặng của chuyến (Bán vé). listed = chặng có trong bảng giá hoặc toàn tuyến (hiện trong ô chọn chặng)
drop function public.trip_fares(uuid);
create function public.trip_fares(p_trip_id uuid)
returns table (from_stop_id uuid, to_stop_id uuid, price int, listed boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_trip public.trips;
  v_tab uuid; v_s uuid; v_e uuid;
  a record; b record;
begin
  if v_tid is null or not app.has_permission('sell.view') then
    raise exception 'Không có quyền bán vé' using errcode = '42501';
  end if;
  select * into v_trip from public.trips where id = p_trip_id and tenant_id = v_tid;
  if not found then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  select id into v_tab from public.fare_tables
  where tenant_id = v_tid and route_id = v_trip.route_id and valid_from <= v_trip.service_date
    and (valid_to is null or valid_to >= v_trip.service_date)
  order by valid_from desc limit 1;
  select stop_id into v_s from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id order by seq limit 1;
  select stop_id into v_e from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id order by seq desc limit 1;
  for a in select stop_id from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id loop
    for b in select stop_id from public.route_stops where tenant_id = v_tid and route_id = v_trip.route_id and stop_id <> a.stop_id loop
      from_stop_id := a.stop_id;
      to_stop_id := b.stop_id;
      begin
        price := public.fare_for(v_trip.route_id, a.stop_id, b.stop_id, v_trip.service_date);
      exception when others then
        price := null;
      end;
      listed := least(a.stop_id, b.stop_id) = least(v_s, v_e) and greatest(a.stop_id, b.stop_id) = greatest(v_s, v_e)
        or exists (select 1 from public.fare_table_items i where i.tenant_id = v_tid and i.table_id = v_tab
                   and least(i.from_stop_id, i.to_stop_id) = least(a.stop_id, b.stop_id)
                   and greatest(i.from_stop_id, i.to_stop_id) = greatest(a.stop_id, b.stop_id));
      if price is not null then
        return next;
      end if;
    end loop;
  end loop;
end;
$$;
revoke execute on function public.trip_fares(uuid) from public, anon, authenticated;
grant execute on function public.trip_fares(uuid) to authenticated;

-- Giá cũ đã chuyển sang bảng giá: bỏ hàm đặt giá kiểu cũ (bảng route_fares giữ nguyên để tra lịch sử)
drop function public.set_fare(uuid, uuid, uuid, int, date);

revoke execute on function app.norm_name(text), app.fare_stop(uuid, uuid, text), app.reindex_route_seats(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb), public.delete_fare_table(uuid)
  from public, anon, authenticated;
grant execute on function public.save_fare_table(uuid, uuid, date, date, text, jsonb, jsonb), public.delete_fare_table(uuid)
  to authenticated;
