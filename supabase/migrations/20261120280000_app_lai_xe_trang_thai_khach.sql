-- =====================================================================
-- App lái xe như app cũ (Đón khách / Sơ đồ ghế / Trả & hàng) + trạng thái gọi khách báo ngược về Bán vé:
-- - crew_call: đã gọi / nghe máy (sẽ ra đón) / thuê bao, không nghe / khách báo hủy (lái xe không tự hủy vé:
--   quầy thấy "khách báo hủy" trên sơ đồ ghế rồi hủy theo quy trình bán vé).
-- - no_show: khách vắng; dropped: đã trả khách.
-- - Thu tiền trên xe: tiền mặt hoặc chuyển khoản.
-- Chỉ người được xếp vào chuyến (hoặc người có quyền Sửa điều hành) ghi được, qua hàm.
-- =====================================================================
alter table public.seat_inventory
  add column crew_call text check (crew_call is null or crew_call in ('da_goi', 'nghe_may', 'thue_bao', 'bao_huy')),
  add column crew_call_at timestamptz,
  add column no_show boolean not null default false,
  add column dropped boolean not null default false,
  add column crew_by uuid;

-- Chuyến đã xuất bến vẫn ghi được trạng thái lái xe (không tính là sửa vé)
do $$
declare v text;
begin
  select pg_get_functiondef('app.seat_lock_guard()'::regprocedure) into v;
  v := replace(v, '''printed_at'', ''print_count'')', '''printed_at'', ''print_count'', ''crew_call'', ''crew_call_at'', ''no_show'', ''dropped'', ''crew_by'')');
  if position('''no_show''' in v) = 0 then raise exception 'Không vá được app.seat_lock_guard'; end if;
  execute v;
end;
$$;

-- Lái xe đánh dấu khách. p_action: goi | nghe_may | thue_bao | bao_huy | bo_goi | len | bo_len | vang | bo_vang | tra | bo_tra
create function public.crew_mark(p_ticket_id uuid, p_action text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.seat_inventory;
begin
  select * into v_s from public.seat_inventory where id = p_ticket_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not (app.is_my_trip(v_s.trip_id) or app.has_permission('trip.edit')) then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
  if v_s.status not in ('dat', 'da_tt') then raise exception 'Vé không còn hiệu lực' using errcode = '22023'; end if;
  case p_action
    when 'goi' then
      update public.seat_inventory set crew_call = coalesce(crew_call, 'da_goi'), crew_call_at = now(), crew_by = auth.uid() where id = p_ticket_id;
    when 'nghe_may', 'thue_bao', 'bao_huy' then
      update public.seat_inventory set crew_call = p_action, crew_call_at = now(), crew_by = auth.uid() where id = p_ticket_id;
    when 'bo_goi' then
      update public.seat_inventory set crew_call = null, crew_call_at = null, crew_by = auth.uid() where id = p_ticket_id;
    when 'len' then
      update public.seat_inventory set boarded = true, no_show = false, crew_by = auth.uid() where id = p_ticket_id;
    when 'bo_len' then
      update public.seat_inventory set boarded = false, dropped = false, crew_by = auth.uid() where id = p_ticket_id;
    when 'vang' then
      update public.seat_inventory set no_show = true, boarded = false, dropped = false, crew_by = auth.uid() where id = p_ticket_id;
    when 'bo_vang' then
      update public.seat_inventory set no_show = false, crew_by = auth.uid() where id = p_ticket_id;
    when 'tra' then
      update public.seat_inventory set dropped = true, boarded = true, no_show = false, crew_by = auth.uid() where id = p_ticket_id;
    when 'bo_tra' then
      update public.seat_inventory set dropped = false, crew_by = auth.uid() where id = p_ticket_id;
    else raise exception 'Thao tác không hợp lệ' using errcode = '22023';
  end case;
end;
$$;
revoke execute on function public.crew_mark(uuid, text) from public, anon, authenticated;
grant execute on function public.crew_mark(uuid, text) to authenticated;

-- Thu tiền trên xe: tiền mặt (quỹ tiền mặt người thu) hoặc chuyển khoản (tài khoản ngân hàng nhà xe)
create function public.crew_collect(p_ticket_id uuid, p_method text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_s public.seat_inventory;
  v_code text;
  v_m text := case when p_method = 'chuyen_khoan' then 'chuyen_khoan' else 'tien_mat' end;
begin
  select * into v_s from public.seat_inventory where id = p_ticket_id and tenant_id = v_tid for update;
  if v_tid is null or not found or not app.is_my_trip(v_s.trip_id) then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
  if v_s.status = 'da_tt' then return 0; end if;   -- đã thu (bấm 2 lần)
  if v_s.status <> 'dat' then raise exception 'Vé không còn hiệu lực' using errcode = '22023'; end if;
  update public.seat_inventory set status = 'da_tt', paid_at = now(), paid_by = auth.uid(), hold_until = null, pay_method = v_m,
         boarded = true, no_show = false
  where id = p_ticket_id;
  select code into v_code from public.bookings where tenant_id = v_tid and id = v_s.booking_id;
  perform app.post_sale(v_tid, v_s.booking_id, v_s.price,
    'Thu trên xe vé ' || coalesce(v_code, '') || ' ghế ' || v_s.seat_label || case when v_m = 'chuyen_khoan' then ' (chuyển khoản)' else '' end, v_m);
  return v_s.price;
end;
$$;
revoke execute on function public.crew_collect(uuid, text) from public, anon, authenticated;
grant execute on function public.crew_collect(uuid, text) to authenticated;

-- Sơ đồ ghế của chuyến cho lái xe (lái xe không có quyền xem danh mục loại xe): loại xe của chuyến, không có thì theo xe được xếp
create function public.my_trip_layout(p_trip_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_type uuid;
  v jsonb;
begin
  if v_tid is null or not (app.is_my_trip(p_trip_id) or app.has_permission('trip.view')) then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  select coalesce(t.vehicle_type_id, vh.vehicle_type_id) into v_type
  from public.trips t left join public.vehicles vh on vh.tenant_id = t.tenant_id and vh.id = t.vehicle_id
  where t.tenant_id = v_tid and t.id = p_trip_id;
  if not found then raise exception 'Không tìm thấy chuyến' using errcode = 'P0002'; end if;
  if v_type is null then return null; end if;
  select jsonb_build_object('name', vt.name, 'decks', vt.decks, 'rows', vt.layout_rows, 'cols', vt.layout_cols,
           'seats', coalesce((select jsonb_agg(jsonb_build_object('label', s.label, 'deck', s.deck, 'row', s.row_no, 'col', s.col_no, 'kind', s.kind,
                                                                  'sellable', s.is_sellable) order by s.deck, s.row_no, s.col_no)
                              from public.vehicle_type_seats s where s.tenant_id = v_tid and s.vehicle_type_id = vt.id), '[]'::jsonb))
    into v
  from public.vehicle_types vt where vt.tenant_id = v_tid and vt.id = v_type;
  return v;
end;
$$;
revoke execute on function public.my_trip_layout(uuid) from public, anon, authenticated;
grant execute on function public.my_trip_layout(uuid) to authenticated;
