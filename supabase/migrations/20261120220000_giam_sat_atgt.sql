-- =====================================================================
-- Giám sát an toàn giao thông (theo mẫu "Quyết định giao nhiệm vụ giám sát, quản lý ATGT và bộ hồ sơ theo dõi"):
-- - Văn bản: mẫu "QĐ giao nhiệm vụ giám sát ATGT" (kèm Phụ lục 7, 8, 9), số chung dãy QĐ.
-- - Sổ giám sát an toàn: mỗi cảnh báo / vi phạm / sự cố 1 dòng (Phụ lục 2, 3, 4, 6 in từ đây).
--   Tự ghi khi xếp xe vẫn lưu dù có cảnh báo (giờ lái, giấy tờ hết hạn, sai hạng…), trừ cảnh báo chỉ do hồ sơ chưa nhập.
--   Cảnh báo tự ghi của chuyến đã chạy xong quá 1 ngày tự đóng.
--   Đóng sự việc là vi phạm / sự cố: tự ghi Lý lịch hành nghề lái xe và lý lịch phương tiện (không nhập 2 lần).
-- - Quyền: safety.view / add / edit / delete. Căn cứ pháp lý của mẫu: cần xác minh.
-- =====================================================================
alter table public.official_docs drop constraint official_docs_template_check;
alter table public.official_docs add constraint official_docs_template_check
  check (template in ('qd_bo_nhiem', 'qd_atgt', 'qd_giam_sat', 'cong_van', 'quyet_dinh', 'thong_bao', 'word_qd', 'word_cv', 'word_tb'));
do $$
declare f record; v text;
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = 'save_official_doc';
  v := pg_get_functiondef(f.oid);
  if position('when ''word_qd'' then ''QD''' in v) = 0 then raise exception 'Không tìm thấy chỗ ánh xạ loại văn bản'; end if;
  v := replace(v, 'when ''word_qd'' then ''QD''', 'when ''word_qd'' then ''QD'' when ''qd_giam_sat'' then ''QD''');
  execute v;
end;
$$;

-- ---------------------------------------------------------------- Quyền
insert into public.permissions (code, module, name) values
  ('safety.view', 'safety', 'Giám sát ATGT: Xem'), ('safety.add', 'safety', 'Giám sát ATGT: Thêm'),
  ('safety.edit', 'safety', 'Giám sát ATGT: Sửa'), ('safety.delete', 'safety', 'Giám sát ATGT: Xóa')
on conflict (code) do nothing;
select app.grant_permission_to_admins(c) from unnest(array['safety.view', 'safety.add', 'safety.edit', 'safety.delete']) c;
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, c from public.roles r, unnest(array['safety.view', 'safety.add', 'safety.edit']) c where r.code = 'dispatcher'
on conflict do nothing;
do $$
declare v text;
begin
  select pg_get_functiondef('app.seed_system_roles(uuid)'::regprocedure) into v;
  v := replace(v, '(''dispatcher'', ''trip.*''),', '(''dispatcher'', ''trip.*''), (''dispatcher'', ''safety.view''), (''dispatcher'', ''safety.add''), (''dispatcher'', ''safety.edit''),');
  if v not like '%safety.view%' then raise exception 'Không sửa được seed_system_roles'; end if;
  execute v;
end;
$$;

-- ---------------------------------------------------------------- Sổ giám sát an toàn
create table public.safety_events (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default app.current_tenant_id() references public.tenants (id),
  occurred_at  timestamptz not null,
  place        text check (place is null or length(place) <= 300),
  vehicle_id   uuid,
  staff_id     uuid,                -- lái xe liên quan
  trip_id      uuid,
  kind         text not null check (kind in ('toc_do', 'thoi_gian_lai', 'sai_hanh_trinh', 'mat_ket_noi', 'dung_do', 'su_co', 'tinh_trang_xe', 'giay_to', 'phan_anh', 'khac')),
  level        smallint not null default 1 check (level between 1 and 3),   -- 1 nhắc nhở · 2 cần xác minh · 3 nghiêm trọng
  source       text check (source is null or length(source) <= 300),       -- nguồn dữ liệu
  content      text not null check (length(trim(content)) between 1 and 4000),
  notified     text check (notified is null or length(notified) <= 300),   -- người được thông báo
  action       text check (action is null or length(action) <= 2000),      -- thông báo / biện pháp
  due_on       date,                                                        -- hạn khắc phục
  verify       text check (verify is null or length(verify) <= 2000),      -- diễn biến xác minh / ý kiến các bên
  result       text check (result is null or length(result) <= 2000),      -- kết quả
  status       text not null default 'mo' check (status in ('mo', 'dong')),
  conclusion   text check (conclusion is null or conclusion in ('khac_phuc', 'vi_pham', 'khong_vi_pham')),
  closed_at    timestamptz,
  closed_by    uuid,
  auto         boolean not null default false,
  request_id   uuid,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, request_id),
  check ((status = 'dong') = (conclusion is not null)),
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id),
  foreign key (tenant_id, trip_id) references public.trips (tenant_id, id)
);
create index safety_events_time_idx on public.safety_events (tenant_id, occurred_at);
create index safety_events_open_idx on public.safety_events (tenant_id, status) where status = 'mo';
create unique index safety_events_auto_trip on public.safety_events (tenant_id, trip_id) where auto and status = 'mo';
create trigger safety_events_touch before update on public.safety_events for each row execute function app.touch_updated_at();
create trigger safety_events_audit after insert or update or delete on public.safety_events for each row execute function app.write_audit();

alter table public.safety_events enable row level security;
revoke all on public.safety_events from public, anon, authenticated;
grant select on public.safety_events to authenticated;
grant select, insert, update, delete on public.safety_events to service_role;
create policy safety_events_select on public.safety_events for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('safety.view'));

/** Thêm / sửa 1 sự việc. p: occurred_at, place, vehicle_id, staff_id, trip_id, kind, level, source, content, notified, action, due_on, verify, result. */
create function public.save_safety_event(p_id uuid, p jsonb, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
  v_row public.safety_events;
  v_veh uuid := nullif(p ->> 'vehicle_id', '')::uuid;
  v_staff uuid := nullif(p ->> 'staff_id', '')::uuid;
  v_trip uuid := nullif(p ->> 'trip_id', '')::uuid;
begin
  if v_tid is null or not app.has_permission(case when p_id is null then 'safety.add' else 'safety.edit' end) then
    raise exception 'Không có quyền ghi sổ giám sát an toàn' using errcode = '42501';
  end if;
  if jsonb_typeof(p) <> 'object' or nullif(trim(p ->> 'content'), '') is null or nullif(p ->> 'occurred_at', '') is null then
    raise exception 'Nhập thời gian và nội dung sự việc' using errcode = '22023';
  end if;
  if v_veh is not null and not exists (select 1 from public.vehicles where tenant_id = v_tid and id = v_veh) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if v_staff is not null and not exists (select 1 from public.staff_members where tenant_id = v_tid and id = v_staff) then
    raise exception 'Không tìm thấy lái xe' using errcode = 'P0002';
  end if;
  if v_trip is not null and not exists (select 1 from public.trips where tenant_id = v_tid and id = v_trip) then
    raise exception 'Không tìm thấy chuyến' using errcode = 'P0002';
  end if;
  if p_id is null then
    if p_request_id is not null then
      select id into v_id from public.safety_events where tenant_id = v_tid and request_id = p_request_id;
      if found then return v_id; end if;
    end if;
    insert into public.safety_events (tenant_id, occurred_at, place, vehicle_id, staff_id, trip_id, kind, level, source, content, notified, action, due_on, verify, result, request_id)
    values (v_tid, (p ->> 'occurred_at')::timestamptz, nullif(trim(p ->> 'place'), ''), v_veh, v_staff, v_trip, coalesce(nullif(p ->> 'kind', ''), 'khac'),
            coalesce(nullif(p ->> 'level', '')::smallint, 1), nullif(trim(p ->> 'source'), ''), trim(p ->> 'content'), nullif(trim(p ->> 'notified'), ''),
            nullif(trim(p ->> 'action'), ''), nullif(p ->> 'due_on', '')::date, nullif(trim(p ->> 'verify'), ''), nullif(trim(p ->> 'result'), ''), p_request_id)
    returning id into v_id;
    return v_id;
  end if;
  select * into v_row from public.safety_events where tenant_id = v_tid and id = p_id for update;
  if not found then raise exception 'Không tìm thấy sự việc' using errcode = 'P0002'; end if;
  if v_row.status = 'dong' then raise exception 'Sự việc đã đóng, không sửa được' using errcode = '22023'; end if;
  update public.safety_events set occurred_at = (p ->> 'occurred_at')::timestamptz, place = nullif(trim(p ->> 'place'), ''), vehicle_id = v_veh, staff_id = v_staff,
    trip_id = v_trip, kind = coalesce(nullif(p ->> 'kind', ''), kind), level = coalesce(nullif(p ->> 'level', '')::smallint, level), source = nullif(trim(p ->> 'source'), ''),
    content = trim(p ->> 'content'), notified = nullif(trim(p ->> 'notified'), ''), action = nullif(trim(p ->> 'action'), ''), due_on = nullif(p ->> 'due_on', '')::date,
    verify = nullif(trim(p ->> 'verify'), ''), result = nullif(trim(p ->> 'result'), ''), auto = false
  where tenant_id = v_tid and id = p_id;
  return p_id;
end;
$$;
revoke execute on function public.save_safety_event(uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_safety_event(uuid, jsonb, uuid) to authenticated;

/** Đóng sự việc (nội bộ): ghi kết luận; vi phạm / sự cố tự ghi lý lịch lái xe và lý lịch phương tiện. */
create function app.close_safety_event_core(p_tid uuid, p_id uuid, p_conclusion text, p_result text, p_by uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare e public.safety_events; v_title text;
begin
  select * into e from public.safety_events where tenant_id = p_tid and id = p_id for update;
  if not found then raise exception 'Không tìm thấy sự việc' using errcode = 'P0002'; end if;
  if e.status = 'dong' then return; end if;
  update public.safety_events set status = 'dong', conclusion = p_conclusion, result = coalesce(nullif(trim(p_result), ''), result), closed_at = now(), closed_by = p_by
  where tenant_id = p_tid and id = p_id;
  v_title := left(trim(e.content), 300);
  if e.staff_id is not null and p_conclusion = 'vi_pham' then
    insert into public.staff_records (tenant_id, staff_id, kind, occurred_on, title, vehicle_id, data, request_id, created_by)
    values (p_tid, e.staff_id, case when e.kind = 'su_co' then 'tai_nan' else 'vi_pham' end, (e.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date, v_title, e.vehicle_id,
            jsonb_build_object('hinh_thuc', e.action, 'ghi_chu', coalesce(nullif(trim(p_result), ''), e.result), 'nguon', 'Sổ giám sát an toàn'), e.id, p_by)
    on conflict (tenant_id, request_id) do nothing;
  end if;
  if e.vehicle_id is not null and e.kind in ('su_co', 'tinh_trang_xe') and p_conclusion <> 'khong_vi_pham' then
    insert into public.vehicle_incidents (tenant_id, vehicle_id, occurred_on, place, summary, resolution, created_by)
    values (p_tid, e.vehicle_id, (e.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date, e.place, v_title, coalesce(nullif(trim(p_result), ''), e.result, e.action), p_by);
  end if;
end;
$$;
revoke execute on function app.close_safety_event_core(uuid, uuid, text, text, uuid) from public, anon, authenticated;

create function public.close_safety_event(p_id uuid, p_conclusion text, p_result text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('safety.edit') then
    raise exception 'Không có quyền đóng sự việc' using errcode = '42501';
  end if;
  if p_conclusion is null or p_conclusion not in ('khac_phuc', 'vi_pham', 'khong_vi_pham') then
    raise exception 'Chọn kết luận' using errcode = '22023';
  end if;
  perform app.close_safety_event_core(v_tid, p_id, p_conclusion, p_result, auth.uid());
end;
$$;
revoke execute on function public.close_safety_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.close_safety_event(uuid, text, text) to authenticated;

/** Xóa sự việc ghi nhầm (chỉ khi chưa đóng). */
create function public.delete_safety_event(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('safety.delete') then
    raise exception 'Không có quyền xóa' using errcode = '42501';
  end if;
  delete from public.safety_events where tenant_id = v_tid and id = p_id and status = 'mo';
  if not found then raise exception 'Không tìm thấy sự việc (hoặc đã đóng)' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.delete_safety_event(uuid) from public, anon, authenticated;
grant execute on function public.delete_safety_event(uuid) to authenticated;

/** Số chuyến / xe / lái xe đã chạy trong kỳ (báo cáo tuần, tháng, năm). */
create function public.safety_period_stats(p_from date, p_to date)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object('trips', count(*), 'vehicles', count(distinct t.vehicle_id),
    'drivers', count(distinct c.staff_id))
  from public.trips t
  left join public.trip_crew c on c.tenant_id = t.tenant_id and c.trip_id = t.id and c.role = 'lai_xe_1' and c.active
  where t.tenant_id = app.current_tenant_id() and app.has_permission('safety.view')
    and t.status = 'mo' and t.service_date between p_from and p_to and (t.vehicle_id is not null or c.staff_id is not null)
$$;
revoke execute on function public.safety_period_stats(date, date) from public, anon, authenticated;
grant execute on function public.safety_period_stats(date, date) to authenticated;

-- ---------------------------------------------------------------- Tự ghi khi xếp xe vẫn lưu dù có cảnh báo
create function app.log_assign_warnings(p_tid uuid, p_trip uuid, p_vehicle uuid, p_driver uuid, p_warn text[], p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  w text[];
  v_at timestamptz;
begin
  -- Bỏ cảnh báo chỉ do hồ sơ chưa nhập (không phải sự việc an toàn)
  select coalesce(array_agg(x), '{}') into w from unnest(p_warn) x
  where x not like '%chưa có % trong hồ sơ%' and x not like '%chưa nhập hạng%' and x not like '%chưa nhập ngày%';
  if cardinality(w) = 0 then
    perform app.close_safety_event_core(p_tid, e.id, 'khac_phuc', 'Xếp lại chuyến, hết cảnh báo', auth.uid())
    from public.safety_events e where e.tenant_id = p_tid and e.trip_id = p_trip and e.auto and e.status = 'mo';
    return;
  end if;
  select depart_at into v_at from public.trips where tenant_id = p_tid and id = p_trip;
  insert into public.safety_events (tenant_id, occurred_at, vehicle_id, staff_id, trip_id, kind, level, source, content, action, auto, created_by)
  values (p_tid, v_at, p_vehicle, p_driver, p_trip,
          case when exists (select 1 from unnest(w) x where x ~* '(giờ lái|lái khoảng|lái liên tục)') then 'thoi_gian_lai' else 'giay_to' end,
          case when exists (select 1 from unnest(w) x where x ~* '(hết hạn|cần hạng|tuổi|ngừng dùng|niên hạn|nghỉ việc|không phải lái xe|chỉ đăng ký)') then 2 else 1 end,
          'Tự động khi xếp xe', left('Xếp xe dù có cảnh báo: ' || array_to_string(w, '; '), 4000), nullif(trim(p_reason), ''), true, auth.uid())
  on conflict (tenant_id, trip_id) where auto and status = 'mo' do update set
    occurred_at = excluded.occurred_at, vehicle_id = excluded.vehicle_id, staff_id = excluded.staff_id, kind = excluded.kind, level = excluded.level,
    content = excluded.content, action = excluded.action;
end;
$$;
revoke execute on function app.log_assign_warnings(uuid, uuid, uuid, uuid, text[], text) from public, anon, authenticated;

do $$
declare v text;
begin
  select pg_get_functiondef('public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)'::regprocedure) into v;
  v := replace(v, '  return jsonb_build_object(''saved'', true, ''warnings'', to_jsonb(v_warn));',
    '  perform app.log_assign_warnings(v_tid, v_trip.id, p_vehicle_id, p_driver1, v_warn, p_reason);
  return jsonb_build_object(''saved'', true, ''warnings'', to_jsonb(v_warn));');
  if v not like '%app.log_assign_warnings%' then raise exception 'Không sửa được assign_trip'; end if;
  execute v;
end;
$$;

-- Cảnh báo tự ghi của chuyến đã chạy xong quá 1 ngày: tự đóng (đã ghi vào sổ, không để tồn đọng)
create function app.svc_close_old_auto_safety()
returns int
language plpgsql security definer set search_path = ''
as $$
declare r record; n int := 0;
begin
  for r in select e.tenant_id, e.id from public.safety_events e join public.trips t on t.tenant_id = e.tenant_id and t.id = e.trip_id
           where e.auto and e.status = 'mo' and t.arrive_at < now() - interval '1 day' loop
    perform app.close_safety_event_core(r.tenant_id, r.id, 'khac_phuc', 'Chuyến đã chạy xong, cảnh báo xếp xe tự đóng', null);
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function app.svc_close_old_auto_safety() from public, anon, authenticated;
grant execute on function app.svc_close_old_auto_safety() to service_role;
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('dong-canh-bao-xep-xe', '30 17 * * *', 'select app.svc_close_old_auto_safety()');   -- 00:30 giờ VN
  end if;
exception when others then
  raise notice 'Không bật được pg_cron (%)', sqlerrm;
end;
$$;
