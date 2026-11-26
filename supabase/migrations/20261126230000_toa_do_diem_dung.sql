-- =====================================================================
-- Tọa độ điểm dừng cho trợ lý giọng nói (tự nhắc khi sắp tới điểm). CHỈ THÊM 4 cột mới vào bảng stops, không đổi / xóa cột cũ.
--   lat, lng  : vĩ độ, kinh độ
--   geo_src   : 'tra_cuu' = tạm lấy theo tên / địa chỉ trên bản đồ (có thể lệch); 'hoc' = học từ GPS điện thoại lái xe (đúng chỗ đón trả thật)
--   geo_n     : số lần đã học (để lấy trung bình); geo_at: lần cập nhật cuối
-- Cách học (tự tối ưu cho các lần sau):
--   * Lần đầu học được thì thay luôn tọa độ tra cứu (vị trí thật luôn tốt hơn).
--   * Các lần sau lấy trung bình động: điểm mới kéo dần về chỗ xe thực tế hay dừng (tối đa nhớ 20 lần, nên điểm dời chỗ vẫn tự theo kịp).
--   * Bỏ qua mẫu GPS kém (sai số > 100 m) và mẫu quá xa (> 1 km) khi đã chắc chắn (≥ 3 lần) – tránh bấm "đã đón" lúc chưa tới nơi.
-- =====================================================================
alter table public.stops add column lat numeric(9, 6) check (lat is null or lat between -90 and 90);
alter table public.stops add column lng numeric(9, 6) check (lng is null or lng between -180 and 180);
alter table public.stops add column geo_src text check (geo_src in ('tra_cuu', 'hoc'));
alter table public.stops add column geo_n int not null default 0;
alter table public.stops add column geo_at timestamptz;

/** Khoảng cách 2 điểm (mét) */
create function app.geo_m(a_lat numeric, a_lng numeric, b_lat numeric, b_lng numeric)
returns double precision language sql immutable set search_path = '' as $$
  select 6371000 * 2 * asin(sqrt(power(sin(radians((b_lat - a_lat)::float8) / 2), 2)
         + cos(radians(a_lat::float8)) * cos(radians(b_lat::float8)) * power(sin(radians((b_lng - a_lng)::float8) / 2), 2)))
$$;
revoke execute on function app.geo_m(numeric, numeric, numeric, numeric) from public;

/** Điểm dừng thuộc tuyến của chuyến mình chạy (hoặc người được sửa tuyến) */
create function app.can_geo_stop(p_trip_id uuid, p_stop_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select app.has_permission('route.edit')
      or exists (select 1 from public.trips t join public.route_stops rs on rs.tenant_id = t.tenant_id and rs.route_id = t.route_id
                 where t.tenant_id = app.current_tenant_id() and t.id = p_trip_id and rs.stop_id = p_stop_id and app.is_my_trip(t.id))
$$;
revoke execute on function app.can_geo_stop(uuid, uuid) from public, anon;
grant execute on function app.can_geo_stop(uuid, uuid) to authenticated;

/** Học vị trí điểm dừng từ GPS lúc lái xe báo đón / trả / giao ở điểm đó. Trả: 'hoc' | 'bo_qua' */
create function public.learn_stop_location(p_trip_id uuid, p_stop_id uuid, p_lat numeric, p_lng numeric, p_acc numeric)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  s public.stops;
  v_n int;
begin
  select * into s from public.stops where tenant_id = v_tid and id = p_stop_id for update;
  if v_tid is null or not found or not app.can_geo_stop(p_trip_id, p_stop_id) then
    raise exception 'Không tìm thấy điểm dừng' using errcode = 'P0002';
  end if;
  if p_lat is null or p_lng is null or p_lat not between 8 and 24 or p_lng not between 102 and 110 then return 'bo_qua'; end if;   -- ngoài Việt Nam
  if coalesce(p_acc, 9999) > 100 then return 'bo_qua'; end if;
  if s.geo_src = 'hoc' and s.lat is not null then
    if s.geo_n >= 3 and app.geo_m(s.lat, s.lng, p_lat, p_lng) > 1000 then return 'bo_qua'; end if;
    v_n := least(s.geo_n, 19);
    update public.stops set lat = round((lat * v_n + p_lat) / (v_n + 1), 6), lng = round((lng * v_n + p_lng) / (v_n + 1), 6),
           geo_n = s.geo_n + 1, geo_at = now() where id = s.id;
  else
    update public.stops set lat = round(p_lat, 6), lng = round(p_lng, 6), geo_src = 'hoc', geo_n = 1, geo_at = now() where id = s.id;
  end if;
  return 'hoc';
end;
$$;
revoke execute on function public.learn_stop_location(uuid, uuid, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.learn_stop_location(uuid, uuid, numeric, numeric, numeric) to authenticated;

/** Tọa độ tạm theo tra cứu tên / địa chỉ: chỉ điền điểm chưa có tọa độ (không bao giờ đè tọa độ đã học) */
create function public.set_stop_lookup_location(p_trip_id uuid, p_stop_id uuid, p_lat numeric, p_lng numeric)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.can_geo_stop(p_trip_id, p_stop_id) then raise exception 'Không tìm thấy điểm dừng' using errcode = 'P0002'; end if;
  if p_lat is null or p_lng is null or p_lat not between 8 and 24 or p_lng not between 102 and 110 then return false; end if;
  update public.stops set lat = round(p_lat, 6), lng = round(p_lng, 6), geo_src = 'tra_cuu', geo_n = 0, geo_at = now()
  where tenant_id = v_tid and id = p_stop_id and lat is null;
  return found;
end;
$$;
revoke execute on function public.set_stop_lookup_location(uuid, uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.set_stop_lookup_location(uuid, uuid, numeric, numeric) to authenticated;
