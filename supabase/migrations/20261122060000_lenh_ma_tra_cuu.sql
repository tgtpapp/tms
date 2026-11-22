-- =====================================================================
-- Mã QR trên lệnh = đường dẫn lưu lệnh đã đóng dấu: lái xe mở Zalo quét mã → chụp lệnh → máy kiểm tra đủ dấu bến xe
-- (2 dấu mỗi lượt có giờ chạy: bến đi + bến đến) mới lưu vào hồ sơ; chưa đủ dấu thì nhắc kiểm tra lại, không lưu.
-- Không cần đăng nhập: mã bí mật riêng từng lệnh (không đoán được), chỉ lưu được vào đúng lệnh đó, trong 30 ngày sau hạn lệnh,
-- tối đa 15 lần thử mỗi ngày. Chỉ Edge Function "lenh" (service_role) gọi các hàm svc_*.
-- =====================================================================
alter table public.transport_orders add column scan_token text not null default replace(gen_random_uuid()::text, '-', '') unique;
alter table public.transport_orders add column scan_tries int not null default 0, add column scan_try_day date;

-- dữ liệu in lệnh: thêm mã để in QR
do $$
declare v text;
begin
  v := pg_get_functiondef('public.transport_order_print(uuid)'::regprocedure);
  v := replace(v, '''info'', o.info,', '''info'', o.info, ''scan_token'', o.scan_token,');
  if v not like '%scan_token%' then raise exception 'Không sửa được transport_order_print'; end if;
  execute v;
end;
$$;

/** Thông tin lệnh theo mã (không có thông tin cá nhân) + số dấu bến xe cần có */
create function public.svc_lenh_by_token(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare o public.transport_orders; t public.trips; v_legs jsonb; n int;
begin
  if p_token !~ '^[0-9a-f]{32}$' then return null; end if;
  select * into o from public.transport_orders where scan_token = p_token;
  if not found then return null; end if;
  select * into t from public.trips where tenant_id = o.tenant_id and id = o.trip_id;
  select coalesce(jsonb_agg(jsonb_build_object('seq', l.seq, 'time', l.depart_time, 'date', l.depart_date) order by l.seq), '[]'), count(*)
    into v_legs, n from public.transport_order_legs l where l.tenant_id = o.tenant_id and l.order_id = o.id and l.depart_time is not null;
  return jsonb_build_object(
    'order_id', o.id, 'tenant_id', o.tenant_id, 'trip_id', o.trip_id, 'order_no', o.order_no, 'valid_from', o.valid_from, 'valid_to', o.valid_to,
    'expired', o.valid_to + 30 < (now() at time zone app.tenant_tz(o.tenant_id))::date,
    'plate', coalesce(o.info ->> 'plate', (select plate from public.vehicles where tenant_id = o.tenant_id and id = t.vehicle_id)),
    'route', (select name from public.routes where tenant_id = o.tenant_id and id = t.route_id),
    'legs', v_legs, 'required', greatest(2 * n, 2),
    'driver_user', (select m.user_id from public.trip_crew c join public.staff_members m on m.tenant_id = c.tenant_id and m.id = c.staff_id
                    where c.tenant_id = o.tenant_id and c.trip_id = o.trip_id and c.role = 'lai_xe_1' and c.active limit 1),
    'saved', exists (select 1 from public.order_scans s where s.tenant_id = o.tenant_id and s.order_no = o.order_no));
end;
$$;

/** Đếm lần thử lưu (chống gửi dồn, mỗi lần thử tốn 1 lần AI đọc): tối đa 15 lần / ngày / lệnh */
create function public.svc_lenh_try(p_token text)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_day date := (now() at time zone 'Asia/Ho_Chi_Minh')::date; n int;
begin
  update public.transport_orders set scan_tries = case when scan_try_day = v_day then scan_tries + 1 else 1 end, scan_try_day = v_day
  where scan_token = p_token returning scan_tries into n;
  return n is not null and n <= 15;
end;
$$;
revoke execute on function public.svc_lenh_by_token(text), public.svc_lenh_try(text) from public, anon, authenticated;
grant execute on function public.svc_lenh_by_token(text), public.svc_lenh_try(text) to service_role;

-- lưu lệnh không gắn người đăng nhập: vẫn báo quản lý (so sánh an toàn với người gửi trống)
do $$
declare v text;
begin
  v := pg_get_functiondef('public.svc_save_order_scan(uuid, uuid, text[], text, text, text, text, text, bigint, uuid, text, text)'::regprocedure);
  v := replace(v, 'ur.user_id <> p_user', 'ur.user_id is distinct from p_user');
  if v not like '%ur.user_id is distinct from p_user%' then raise exception 'Không sửa được svc_save_order_scan'; end if;
  execute v;
end;
$$;
