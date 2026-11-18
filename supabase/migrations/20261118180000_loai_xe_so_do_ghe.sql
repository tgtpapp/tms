-- =====================================================================
-- Giai đoạn 3.2a – Loại xe + sơ đồ ghế
-- Loại xe là "mẫu" dùng chung cho nhiều xe cùng kiểu. Số chỗ ghi theo
-- Giấy chứng nhận kiểm định (số người cho phép chở: ngồi / nằm / đứng).
-- Sơ đồ ghế chỉ gồm chỗ của hành khách (không vẽ ghế lái xe).
-- Lưu ý cho 3.4: chuyến phải CHỤP LẠI sơ đồ ghế lúc tạo chuyến, để sửa sơ đồ
-- sau này không làm hỏng vé đã bán.
-- =====================================================================

insert into public.permissions (code, module, name) values
  ('vehicle.manage', 'van_tai', 'Quản lý xe và loại xe');
select app.grant_permission_to_admins('vehicle.manage');

-- ---------------------------------------------------------------- Loại xe
create table public.vehicle_types (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default app.current_tenant_id() references public.tenants (id),
  code             text not null check (length(trim(code)) > 0),
  name             text not null check (length(trim(name)) > 0),
  brand            text,                        -- nhãn hiệu (vd: Thaco, Hyundai)
  model_code       text,                        -- số loại (vd: TB120SL)
  body_style       text not null default 'ghe_ngoi'
                   check (body_style in ('ghe_ngoi', 'giuong_nam', 'limousine', 'phong_nam', 'khac')),
  decks            int not null default 1 check (decks between 1 and 2),
  -- Số người cho phép chở theo Giấy chứng nhận kiểm định
  reg_seats        int not null default 0 check (reg_seats between 0 and 100),
  reg_berths       int not null default 0 check (reg_berths between 0 and 100),
  reg_standing     int not null default 0 check (reg_standing between 0 and 100),
  curb_weight_kg   int check (curb_weight_kg is null or curb_weight_kg > 0),    -- khối lượng bản thân
  gross_weight_kg  int check (gross_weight_kg is null or gross_weight_kg > 0),  -- khối lượng toàn bộ cho phép
  fuel             text check (fuel is null or fuel in ('dau', 'xang', 'dien', 'khi', 'hybrid')),
  amenities        text[] not null default '{}',                               -- tiện ích: wifi, WC…
  layout_rows      int not null default 0 check (layout_rows between 0 and 30),
  layout_cols      int not null default 0 check (layout_cols between 0 and 8),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (reg_seats + reg_berths + reg_standing > 0),
  check (gross_weight_kg is null or curb_weight_kg is null or gross_weight_kg >= curb_weight_kg),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

-- ---------------------------------------------------------------- Chỗ trong sơ đồ
-- Ô không có dòng = lối đi / để trống.
create table public.vehicle_type_seats (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null,
  vehicle_type_id  uuid not null,
  label            text not null check (length(trim(label)) between 1 and 10),
  deck             int not null check (deck between 1 and 2),
  row_no           int not null check (row_no >= 1),
  col_no           int not null check (col_no >= 1),
  kind             text not null check (kind in ('ghe', 'giuong')),
  is_priority      boolean not null default false,  -- chỗ ưu tiên (người khuyết tật, cao tuổi, phụ nữ mang thai)
  is_sellable      boolean not null default true,   -- false: chỗ phụ xe / không bán
  unique (tenant_id, id),
  unique (tenant_id, vehicle_type_id, label),
  unique (tenant_id, vehicle_type_id, deck, row_no, col_no),
  foreign key (tenant_id, vehicle_type_id) references public.vehicle_types (tenant_id, id) on delete cascade
);

create trigger vehicle_types_touch before update on public.vehicle_types
  for each row execute function app.touch_updated_at();
create trigger vehicle_types_audit after insert or update or delete on public.vehicle_types
  for each row execute function app.write_audit();
-- Sơ đồ ghế: ghi 1 dòng nhật ký mỗi lần lưu (trong set_seat_layout), không ghi từng ghế.

-- Không cho giảm số tầng / lưới khi sơ đồ đang có chỗ nằm ngoài,
-- không cho giảm số chỗ theo kiểm định xuống dưới số chỗ đang có trong sơ đồ
create function app.check_vehicle_type_layout()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.vehicle_type_seats s
             where s.tenant_id = new.tenant_id and s.vehicle_type_id = new.id
               and (s.deck > new.decks or s.row_no > new.layout_rows or s.col_no > new.layout_cols)) then
    raise exception 'Sơ đồ ghế đang có chỗ nằm ngoài số tầng / hàng / cột mới, hãy sửa sơ đồ trước'
      using errcode = '22023';
  end if;
  if (select count(*) from public.vehicle_type_seats s
      where s.tenant_id = new.tenant_id and s.vehicle_type_id = new.id and s.kind = 'ghe') > new.reg_seats
     or (select count(*) from public.vehicle_type_seats s
         where s.tenant_id = new.tenant_id and s.vehicle_type_id = new.id and s.kind = 'giuong') > new.reg_berths then
    raise exception 'Số chỗ theo kiểm định ít hơn số chỗ trong sơ đồ ghế, hãy sửa sơ đồ trước'
      using errcode = '22023';
  end if;
  return new;
end;
$$;
revoke execute on function app.check_vehicle_type_layout() from public, anon, authenticated;
create trigger vehicle_types_layout_check before update on public.vehicle_types
  for each row execute function app.check_vehicle_type_layout();

-- ---------------------------------------------------------------- RLS + quyền
alter table public.vehicle_types      enable row level security;
alter table public.vehicle_type_seats enable row level security;

revoke all on public.vehicle_types, public.vehicle_type_seats from anon, authenticated;
grant select on public.vehicle_types, public.vehicle_type_seats to authenticated;
grant insert, update on public.vehicle_types to authenticated;
grant select, insert, update, delete on public.vehicle_types, public.vehicle_type_seats to service_role;

-- Mọi người trong nhà xe xem được (bán vé cần sơ đồ); ghi khi có vehicle.manage.
-- Sơ đồ ghế chỉ ghi qua hàm set_seat_layout.
create policy vehicle_types_select on public.vehicle_types for select to authenticated
  using (tenant_id = app.current_tenant_id());
create policy vehicle_types_insert on public.vehicle_types for insert to authenticated
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy vehicle_types_update on public.vehicle_types for update to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'))
  with check (tenant_id = app.current_tenant_id() and app.has_permission('vehicle.manage'));
create policy vehicle_type_seats_select on public.vehicle_type_seats for select to authenticated
  using (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------- Lưu sơ đồ ghế
-- p_seats: [{ "label": "A01", "deck": 1, "row": 1, "col": 1, "kind": "ghe"|"giuong",
--             "priority": bool, "sellable": bool }, ...]
-- Chặn: vượt lưới, trùng ô, trùng số ghế, số ghế/giường vượt số người cho phép chở theo kiểm định.
create function public.set_seat_layout(p_type_id uuid, p_rows int, p_cols int, p_seats jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_type public.vehicle_types;
  v_ghe int; v_giuong int; v_old_ghe int; v_old_giuong int;
  r record;
begin
  if v_tid is null or not app.has_permission('vehicle.manage') then
    raise exception 'Không có quyền quản lý xe' using errcode = '42501';
  end if;
  select * into v_type from public.vehicle_types where id = p_type_id and tenant_id = v_tid for update;
  if not found then
    raise exception 'Không tìm thấy loại xe' using errcode = 'P0002';
  end if;
  if p_rows is null or p_cols is null or p_rows not between 1 and 30 or p_cols not between 1 and 8 then
    raise exception 'Số hàng phải từ 1–30, số cột từ 1–8' using errcode = '22023';
  end if;
  if jsonb_typeof(p_seats) <> 'array' then
    raise exception 'Sơ đồ ghế không hợp lệ' using errcode = '22023';
  end if;

  for r in select trim(e ->> 'label') as label, (e ->> 'deck')::int as deck, (e ->> 'row')::int as row_no,
                  (e ->> 'col')::int as col_no, e ->> 'kind' as kind, ord
           from jsonb_array_elements(p_seats) with ordinality as x(e, ord) loop
    if r.label is null or length(r.label) not between 1 and 10 then
      raise exception 'Chỗ thứ % chưa có số ghế (tối đa 10 ký tự)', r.ord using errcode = '22023';
    end if;
    if r.deck is null or r.deck < 1 or r.deck > v_type.decks
       or r.row_no is null or r.row_no < 1 or r.row_no > p_rows
       or r.col_no is null or r.col_no < 1 or r.col_no > p_cols then
      raise exception 'Chỗ % nằm ngoài sơ đồ', r.label using errcode = '22023';
    end if;
    if r.kind is null or r.kind not in ('ghe', 'giuong') then
      raise exception 'Chỗ % phải là ghế hoặc giường', r.label using errcode = '22023';
    end if;
  end loop;

  if (select count(distinct upper(trim(e ->> 'label'))) from jsonb_array_elements(p_seats) e) <> jsonb_array_length(p_seats) then
    raise exception 'Số ghế bị trùng' using errcode = '22023';
  end if;
  if (select count(distinct (e ->> 'deck', e ->> 'row', e ->> 'col')) from jsonb_array_elements(p_seats) e) <> jsonb_array_length(p_seats) then
    raise exception 'Hai chỗ trùng cùng một ô' using errcode = '22023';
  end if;

  -- Không chở quá số người cho phép theo kiểm định (cả chỗ bán và chỗ phụ xe)
  select count(*) filter (where e ->> 'kind' = 'ghe'), count(*) filter (where e ->> 'kind' = 'giuong')
    into v_ghe, v_giuong from jsonb_array_elements(p_seats) e;
  if v_ghe > v_type.reg_seats then
    raise exception 'Sơ đồ có % ghế ngồi, vượt % chỗ ngồi theo kiểm định', v_ghe, v_type.reg_seats using errcode = '22023';
  end if;
  if v_giuong > v_type.reg_berths then
    raise exception 'Sơ đồ có % giường, vượt % chỗ nằm theo kiểm định', v_giuong, v_type.reg_berths using errcode = '22023';
  end if;

  select count(*) filter (where kind = 'ghe'), count(*) filter (where kind = 'giuong')
    into v_old_ghe, v_old_giuong
    from public.vehicle_type_seats where tenant_id = v_tid and vehicle_type_id = p_type_id;
  delete from public.vehicle_type_seats where tenant_id = v_tid and vehicle_type_id = p_type_id;
  update public.vehicle_types set layout_rows = p_rows, layout_cols = p_cols where id = p_type_id and tenant_id = v_tid;
  insert into public.vehicle_type_seats (tenant_id, vehicle_type_id, label, deck, row_no, col_no, kind, is_priority, is_sellable)
  select v_tid, p_type_id, upper(trim(e ->> 'label')), (e ->> 'deck')::int, (e ->> 'row')::int, (e ->> 'col')::int,
         e ->> 'kind', coalesce((e ->> 'priority')::boolean, false), coalesce((e ->> 'sellable')::boolean, true)
  from jsonb_array_elements(p_seats) e;

  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tid, auth.uid(), 'update', 'vehicle_type_seats', p_type_id::text, jsonb_build_object(
    'old', jsonb_build_object('name', v_type.name, 'so_do', format('%s ghế, %s giường', v_old_ghe, v_old_giuong)),
    'new', jsonb_build_object('name', v_type.name, 'so_do', format('%s ghế, %s giường', v_ghe, v_giuong))));
end;
$$;

revoke execute on function public.set_seat_layout(uuid, int, int, jsonb) from public, anon, authenticated;
grant execute on function public.set_seat_layout(uuid, int, int, jsonb) to authenticated;
