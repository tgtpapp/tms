-- =====================================================================
-- Chuyển dữ liệu cũ sang Google Drive (chỉ Chủ nhà xe) – BƯỚC 1: xem trước + sao lưu lên Drive (CHƯA xóa gì).
-- Dữ liệu được chuyển (đều cũ hơn 12 tháng, theo khoảng ngày chọn):
--   - Vé / giữ ghế (seat_inventory) của các chuyến có ngày chạy trong khoảng + lượt trung chuyển của các vé đó
--   - Thông báo (+ nhật ký gửi thông báo), tin Zalo, nhật ký thao tác tạo trong khoảng
-- GIỮ LẠI trong database: chuyến, đơn vé (bookings), phiếu gửi hàng, hợp đồng, sổ cái tiền – vì sổ cái tiền
-- (chỉ thêm, không xóa) tham chiếu tới đơn vé / phiếu gửi hàng / hợp đồng, và phiếu gửi hàng tham chiếu chuyến.
-- File: các trang dữ liệu có chữ ký của máy chủ gắn với đúng nhà xe + khoảng ngày (không sửa / ghép tay được).
-- =====================================================================

create table public.data_archives (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  from_on     date not null,
  to_on       date not null,
  drive_id    text not null,
  file_name   text not null,
  size_bytes  bigint,
  sha256      text not null,
  counts      jsonb not null default '{}',
  row_count   int not null default 0,
  status      text not null default 'da_sao_luu' check (status in ('da_sao_luu', 'da_chuyen', 'da_phuc_hoi')),
  created_by  uuid,
  created_at  timestamptz not null default now(),
  moved_at    timestamptz,
  restored_at timestamptz,
  check (to_on >= from_on),
  unique (tenant_id, id)
);
create index data_archives_tenant_idx on public.data_archives (tenant_id, created_at desc);
alter table public.data_archives enable row level security;
create policy data_archives_select on public.data_archives for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_tenant_owner());
revoke all on public.data_archives from public, anon, authenticated;
grant select on public.data_archives to authenticated;
grant select, insert, update on public.data_archives to service_role;

/** Bảng được chuyển, theo thứ tự khôi phục (bảng cha trước) */
create function app.archive_tables()
returns table (tbl text, ord int)
language sql immutable set search_path = ''
as $$ values ('notifications', 1), ('notification_delivery_logs', 2), ('zalo_messages', 3), ('audit_logs', 4), ('seat_inventory', 5), ('transfer_items', 6) $$;
revoke execute on function app.archive_tables() from public, anon, authenticated;

/** Điều kiện chọn dòng của 1 bảng trong khoảng ngày ($1 nhà xe, $2 từ ngày, $3 đến ngày; ngày theo giờ Việt Nam) */
create function app.archive_where(p_table text)
returns text
language sql immutable set search_path = ''
as $$
  select case p_table
    when 'seat_inventory' then 'tenant_id = $1 and trip_id in (select id from public.trips where tenant_id = $1 and service_date between $2 and $3)'
    when 'transfer_items' then 'tenant_id = $1 and ticket_id in (select s.id from public.seat_inventory s join public.trips t on t.tenant_id = s.tenant_id and t.id = s.trip_id
                                 where s.tenant_id = $1 and t.service_date between $2 and $3)'
    when 'notifications' then 'tenant_id = $1 and (created_at at time zone ''Asia/Ho_Chi_Minh'')::date between $2 and $3'
    when 'notification_delivery_logs' then 'tenant_id = $1 and notification_id in (select id from public.notifications where tenant_id = $1
                                 and (created_at at time zone ''Asia/Ho_Chi_Minh'')::date between $2 and $3)'
    when 'zalo_messages' then 'tenant_id = $1 and (created_at at time zone ''Asia/Ho_Chi_Minh'')::date between $2 and $3'
    when 'audit_logs' then 'tenant_id = $1 and (created_at at time zone ''Asia/Ho_Chi_Minh'')::date between $2 and $3'
  end
$$;
revoke execute on function app.archive_where(text) from public, anon, authenticated;

/** Kiểm tra người dùng + khoảng ngày (Chủ nhà xe, đến ngày cũ hơn 12 tháng) */
create function app.archive_check(p_from date, p_to date)
returns uuid
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được chuyển dữ liệu cũ' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'Chọn khoảng ngày hợp lệ' using errcode = '22023';
  end if;
  if p_to > (app.local_today() - interval '12 months')::date then
    raise exception 'Chỉ chuyển được dữ liệu cũ hơn 12 tháng (đến ngày %)', to_char((app.local_today() - interval '12 months')::date, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  return v_tid;
end;
$$;
revoke execute on function app.archive_check(date, date) from public, anon, authenticated;

/** Đếm số dòng sẽ chuyển */
create function app.archive_counts(p_tid uuid, p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare r record; n int; out jsonb := '{}';
begin
  for r in select * from app.archive_tables() order by ord loop
    execute format('select count(*)::int from public.%I where %s', r.tbl, app.archive_where(r.tbl)) into n using p_tid, p_from, p_to;
    out := out || jsonb_build_object(r.tbl, n);
  end loop;
  return out;
end;
$$;
revoke execute on function app.archive_counts(uuid, date, date) from public, anon, authenticated;

/** Xem trước: số dòng từng loại dữ liệu trong khoảng ngày */
create function public.archive_preview(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.archive_check(p_from, p_to);
begin
  return app.archive_counts(v_tid, p_from, p_to);
end;
$$;
revoke execute on function public.archive_preview(date, date) from public, anon, authenticated;
grant execute on function public.archive_preview(date, date) to authenticated, service_role;

/** 1 trang dữ liệu của khoảng ngày (tối đa p_limit dòng sau vị trí p_after), có chữ ký gắn nhà xe + bảng + khoảng ngày */
create function public.archive_page(p_table text, p_from date, p_to date, p_after text, p_limit int)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.archive_check(p_from, p_to); v_rows text; v_last text; v_n int; v_lim int := least(greatest(coalesce(p_limit, 1000), 1), 5000);
  v_key text := 'luu:' || p_table || ':' || p_from || ':' || p_to;
begin
  if not exists (select 1 from app.archive_tables() a where a.tbl = p_table) then
    raise exception 'Bảng không thuộc dữ liệu được chuyển: %', p_table using errcode = '22023';
  end if;
  execute format('with pg as (select ctid c from public.%I where %s and ctid > $4::tid order by ctid limit $5)
                  select (select max(c)::text from pg), (select count(*) from pg)::int', p_table, app.archive_where(p_table))
    into v_last, v_n using v_tid, p_from, p_to, coalesce(p_after, '(0,0)'), v_lim;
  if v_n = 0 then
    return jsonb_build_object('rows', '[]', 'sig', app.backup_sig(v_tid, v_key, '[]'), 'last', null, 'n', 0);
  end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]'')::text from (select * from public.%I where %s and ctid > $4::tid and ctid <= $5::tid) t',
                 p_table, app.archive_where(p_table))
    into v_rows using v_tid, p_from, p_to, coalesce(p_after, '(0,0)'), v_last;
  return jsonb_build_object('rows', v_rows, 'sig', app.backup_sig(v_tid, v_key, v_rows), 'last', v_last, 'n', v_n);
end;
$$;
revoke execute on function public.archive_page(text, date, date, text, int) from public, anon, authenticated;
grant execute on function public.archive_page(text, date, date, text, int) to authenticated, service_role;

/** Edge Function drive: ghi lại bản đã đẩy lên Drive (đã kiểm Chủ nhà xe + khoảng ngày bằng quyền của người dùng) */
create function public.svc_archive_saved(p_tenant uuid, p_user uuid, p_from date, p_to date, p_drive_id text, p_file_name text,
                                         p_size bigint, p_sha256 text, p_counts jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid; v_n int;
begin
  select coalesce(sum(value::int), 0) into v_n from jsonb_each_text(coalesce(p_counts, '{}'));
  insert into public.data_archives (tenant_id, from_on, to_on, drive_id, file_name, size_bytes, sha256, counts, row_count, created_by)
  values (p_tenant, p_from, p_to, p_drive_id, p_file_name, p_size, p_sha256, coalesce(p_counts, '{}'), v_n, p_user)
  returning id into v_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (p_tenant, p_user, 'sao_luu', 'data_archives', v_id::text, jsonb_build_object('from', p_from, 'to', p_to, 'rows', v_n));
  return v_id;
end;
$$;
revoke execute on function public.svc_archive_saved(uuid, uuid, date, date, text, text, bigint, text, jsonb) from public, anon, authenticated;
grant execute on function public.svc_archive_saved(uuid, uuid, date, date, text, text, bigint, text, jsonb) to service_role;
