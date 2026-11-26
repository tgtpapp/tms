-- =====================================================================
-- Chuyển dữ liệu cũ sang Google Drive – BƯỚC 3: phục hồi từ file trên Drive.
-- - Chỉ Chủ nhà xe, chỉ bản "đã chuyển khỏi database"; từng trang kiểm chữ ký (đúng nhà xe + bảng + khoảng ngày).
-- - Chỉ THÊM các dòng còn thiếu (giữ nguyên mã cũ), không ghi đè, không xóa.
-- - Khi phục hồi: không chặn vì chuyến đã xuất bến, không gửi lại Zalo / thông báo cho khách và lái xe,
--   không ghi nhật ký từng dòng (cờ app.chuyen_du_lieu chỉ đặt được trong hàm của máy chủ, hết khi xong giao dịch).
-- =====================================================================

-- Các trigger khi thêm vé: bỏ qua khi đang phục hồi dữ liệu cũ
do $$
declare v text; f text;
begin
  foreach f in array array['app.seat_lock_guard()', 'app.zalo_on_ticket()', 'app.notify_seats_insert()'] loop
    v := pg_get_functiondef(f::regprocedure);
    v := regexp_replace(v, E'\nbegin\n', E'\nbegin\n  if current_setting(''app.chuyen_du_lieu'', true) = ''on'' then return '
         || case when f = 'app.seat_lock_guard()' then 'coalesce(new, old)' else 'null' end || E'; end if;\n');
    if v not like '%app.chuyen_du_lieu%' then raise exception 'Không sửa được %', f; end if;
    execute v;
  end loop;
end;
$$;

/** Phục hồi 1 trang của bản đã chuyển. Trả {added, skipped, failed} */
create function public.archive_restore_page(p_id uuid, p_table text, p_rows text, p_sig text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id(); a public.data_archives; v_rows jsonb; v_cols text; v_ov text; v_n int; v_total int; v_add int := 0; v_fail int := 0; e jsonb;
begin
  if v_tid is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được phục hồi dữ liệu' using errcode = '42501';
  end if;
  select * into a from public.data_archives where tenant_id = v_tid and id = p_id;
  if not found then raise exception 'Không tìm thấy bản đã chuyển' using errcode = 'P0002'; end if;
  if a.status <> 'da_chuyen' then raise exception 'Bản này chưa chuyển khỏi database hoặc đã phục hồi' using errcode = '22023'; end if;
  if not exists (select 1 from app.archive_tables() t where t.tbl = p_table) then
    raise exception 'Bảng không thuộc dữ liệu được chuyển: %', p_table using errcode = '22023';
  end if;
  if p_sig is null or p_sig <> app.backup_sig(v_tid, 'luu:' || p_table || ':' || a.from_on || ':' || a.to_on, p_rows) then
    raise exception 'File không đúng của nhà xe / khoảng ngày này hoặc đã bị sửa' using errcode = '22023';
  end if;
  v_rows := p_rows::jsonb;
  v_total := jsonb_array_length(v_rows);
  if v_total = 0 then return jsonb_build_object('added', 0, 'skipped', 0, 'failed', 0); end if;
  select string_agg(quote_ident(x.attname), ', ' order by x.attnum), bool_or(x.attidentity = 'a')::text into v_cols, v_ov
  from pg_attribute x where x.attrelid = ('public.' || quote_ident(p_table))::regclass and x.attnum > 0 and not x.attisdropped and x.attgenerated = '';
  v_ov := case when v_ov = 'true' then 'overriding system value' else '' end;
  v_rows := (select jsonb_agg(x || jsonb_build_object('tenant_id', v_tid)) from jsonb_array_elements(v_rows) x);
  perform set_config('app.chuyen_du_lieu', 'on', true);
  begin
    execute format('insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict do nothing',
                   p_table, v_cols, v_ov, v_cols, p_table) using v_rows;
    get diagnostics v_add = row_count;
  exception when others then
    v_add := 0;   -- có dòng lỗi: thêm từng dòng, bỏ qua dòng lỗi
    for e in select * from jsonb_array_elements(v_rows) loop
      begin
        execute format('insert into public.%I (%s) %s select %s from jsonb_populate_record(null::public.%I, $1) on conflict do nothing',
                       p_table, v_cols, v_ov, v_cols, p_table) using e;
        get diagnostics v_n = row_count;
        v_add := v_add + v_n;
      exception when others then
        v_fail := v_fail + 1;
      end;
    end loop;
  end;
  perform set_config('app.chuyen_du_lieu', 'off', true);
  return jsonb_build_object('added', v_add, 'skipped', v_total - v_add - v_fail, 'failed', v_fail);
end;
$$;
revoke execute on function public.archive_restore_page(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.archive_restore_page(uuid, text, text, text) to authenticated, service_role;

/** Đánh dấu đã phục hồi xong */
create function public.archive_restored(p_id uuid, p_added int, p_failed int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được phục hồi dữ liệu' using errcode = '42501';
  end if;
  update public.data_archives set status = 'da_phuc_hoi', restored_at = now() where tenant_id = v_tid and id = p_id and status = 'da_chuyen';
  if not found then raise exception 'Không tìm thấy bản đã chuyển' using errcode = 'P0002'; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tid, auth.uid(), 'phuc_hoi', 'data_archives', p_id::text, jsonb_build_object('added', p_added, 'failed', p_failed));
end;
$$;
revoke execute on function public.archive_restored(uuid, int, int) from public, anon, authenticated;
grant execute on function public.archive_restored(uuid, int, int) to authenticated, service_role;
