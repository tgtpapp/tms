-- 1) Luật 118/2025/QH15 (khoản 15 Điều 7, sửa khoản 1 Điều 64 Luật TTATGT đường bộ), hiệu lực 01/7/2026:
--    bỏ giới hạn "không quá 10 giờ/ngày, 48 giờ/tuần"; giữ "lái xe liên tục không quá 04 giờ" (trừ bất khả kháng / trở ngại khách quan);
--    giờ làm việc trong ngày, tuần theo Bộ luật Lao động.
--    → Xếp xe không còn cảnh báo giờ lái trong ngày / tuần (giữ cảnh báo lái liên tục).
--    → Sổ giám sát: bỏ các cảnh báo giờ ngày / tuần đang mở; cảnh báo chỉ gồm loại này thì đóng "Không vi phạm".
-- 2) Bỏ ghi chú "Nhập từ Vexere / Excel…" khi nhập lịch (không ghi vào chuyến, sổ giám sát).
do $$
declare v text;
begin
  select pg_get_functiondef('public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)'::regprocedure) into v;
  v := replace(v, 'if v_other + v_min / v_drivers > v_day * 60 then', 'if false then');
  v := replace(v, 'if v_other + v_min / v_drivers > v_week * 60 then', 'if false then');
  v := replace(v, 'assign_note = case when cardinality(v_warn) > 0 then trim(p_reason) end',
                  'assign_note = case when cardinality(v_warn) > 0 and trim(p_reason) not like ''Nhập từ %'' then trim(p_reason) end');
  if v like '%v_day * 60%' or v like '%v_week * 60%' or v not like '%not like ''Nhập từ %''%' then
    raise exception 'Không sửa được assign_trip';
  end if;
  execute v;

  select pg_get_functiondef('app.log_assign_warnings(uuid, uuid, uuid, uuid, text[], text)'::regprocedure) into v;
  v := replace(v, 'nullif(trim(p_reason), ''''), true, auth.uid())',
                  'case when trim(p_reason) like ''Nhập từ %'' then null else nullif(trim(p_reason), '''') end, true, auth.uid())');
  if v not like '%like ''Nhập từ %''%' then raise exception 'Không sửa được log_assign_warnings'; end if;
  execute v;
end;
$$;


-- Ghi chú nhập lịch đã ghi trước đây
update public.trips set assign_note = null where assign_note like 'Nhập từ %';
update public.trips set note = null where note like 'Nhập từ %';
update public.safety_events set action = null where auto and action like 'Nhập từ %';

-- Sổ giám sát: gỡ cảnh báo giờ ngày / tuần khỏi các mục tự ghi đang mở
do $$
declare e record; v_rest text;
begin
  for e in select id, tenant_id, content from public.safety_events
           where auto and status = 'mo' and content ~ 'lái khoảng [0-9.,]+ giờ trong (ngày|tuần)' loop
    select string_agg(x, '; ') into v_rest
    from unnest(string_to_array(regexp_replace(e.content, '^Xếp xe dù có cảnh báo: ', ''), '; ')) x
    where x !~ 'lái khoảng [0-9.,]+ giờ trong (ngày|tuần)';
    if v_rest is null then
      perform app.close_safety_event_core(e.tenant_id, e.id, 'khong_vi_pham',
        'Luật 118/2025/QH15 bỏ giới hạn giờ lái trong ngày, trong tuần từ 01/7/2026', null);
    else
      update public.safety_events set content = 'Xếp xe dù có cảnh báo: ' || v_rest,
        kind = case when v_rest ~* '(giờ lái|lái liên tục)' then 'thoi_gian_lai' else 'giay_to' end
      where id = e.id;
    end if;
  end loop;
end;
$$;
