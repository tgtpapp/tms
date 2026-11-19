-- Sơ đồ xe: thêm ô Tài xế và Cửa lên xuống (không bán, không tính vào số chỗ theo kiểm định).
alter table public.vehicle_type_seats drop constraint vehicle_type_seats_kind_check;
alter table public.vehicle_type_seats add constraint vehicle_type_seats_kind_check check (kind in ('ghe', 'giuong', 'tai_xe', 'cua'));
alter table public.vehicle_type_seats add constraint vehicle_type_seats_extra_nosell check (kind in ('ghe', 'giuong') or (not is_sellable and not is_priority));

create or replace function public.set_seat_layout(p_type_id uuid, p_rows int, p_cols int, p_seats jsonb)
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
    if r.kind is null or r.kind not in ('ghe', 'giuong', 'tai_xe', 'cua') then
      raise exception 'Ô % phải là ghế, giường, tài xế hoặc cửa', r.label using errcode = '22023';
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
         e ->> 'kind', (e ->> 'kind') in ('ghe', 'giuong') and coalesce((e ->> 'priority')::boolean, false),
         (e ->> 'kind') in ('ghe', 'giuong') and coalesce((e ->> 'sellable')::boolean, true)
  from jsonb_array_elements(p_seats) e;

  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tid, auth.uid(), 'update', 'vehicle_type_seats', p_type_id::text, jsonb_build_object(
    'old', jsonb_build_object('name', v_type.name, 'so_do', format('%s ghế, %s giường', v_old_ghe, v_old_giuong)),
    'new', jsonb_build_object('name', v_type.name, 'so_do', format('%s ghế, %s giường', v_ghe, v_giuong))));
end;
$$;

