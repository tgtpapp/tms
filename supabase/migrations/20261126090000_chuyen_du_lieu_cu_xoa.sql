-- =====================================================================
-- Chuyển dữ liệu cũ sang Google Drive – BƯỚC 2: xóa khỏi database sau khi file trên Drive đã khớp.
-- - Chỉ Chủ nhà xe, chỉ bản "đã sao lưu", trình duyệt phải tải lại file từ Drive và gửi đúng mã SHA-256 đã lưu.
-- - Số dòng hiện tại phải đúng bằng lúc sao lưu (có thay đổi sau khi sao lưu thì không xóa, phải sao lưu lại).
-- - Xóa trọn trong 1 giao dịch: lệch số dòng là hủy toàn bộ, không xóa gì.
-- - Khi đang chuyển: không ghi nhật ký từng dòng bị xóa (dữ liệu đã nằm trong file trên Drive), chỉ ghi 1 dòng nhật ký tổng.
-- =====================================================================

-- Nhật ký thao tác: bỏ qua khi đang chuyển / phục hồi dữ liệu cũ (cờ chỉ đặt được trong hàm của máy chủ, hết khi xong giao dịch)
do $$
declare v text;
begin
  v := pg_get_functiondef('app.write_audit()'::regprocedure);
  v := replace(v, E'begin\n  insert into public.audit_logs', E'begin\n  if current_setting(''app.chuyen_du_lieu'', true) = ''on'' then return null; end if;\n  insert into public.audit_logs');
  if v not like '%app.chuyen_du_lieu%' then raise exception 'Không sửa được app.write_audit'; end if;
  execute v;
end;
$$;

create function public.archive_move(p_id uuid, p_sha256 text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id(); a public.data_archives; v_now jsonb; r record; n int; v_done jsonb := '{}';
begin
  if v_tid is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được chuyển dữ liệu cũ' using errcode = '42501';
  end if;
  select * into a from public.data_archives where tenant_id = v_tid and id = p_id for update;
  if not found then raise exception 'Không tìm thấy bản đã sao lưu' using errcode = 'P0002'; end if;
  if a.status <> 'da_sao_luu' then raise exception 'Bản này đã được chuyển hoặc đã phục hồi' using errcode = '22023'; end if;
  if p_sha256 is null or p_sha256 <> a.sha256 then
    raise exception 'File trên Google Drive không khớp với bản đã sao lưu, chưa xóa gì' using errcode = '22023';
  end if;
  perform app.archive_check(a.from_on, a.to_on);
  v_now := app.archive_counts(v_tid, a.from_on, a.to_on);
  if exists (select 1 from jsonb_each_text(v_now) c where c.value::int <> coalesce((a.counts ->> c.key)::int, 0)) then
    raise exception 'Dữ liệu trong khoảng ngày đã thay đổi sau khi sao lưu. Hãy sao lưu lại rồi mới chuyển' using errcode = '22023';
  end if;
  perform set_config('app.chuyen_du_lieu', 'on', true);
  -- bảng con trước (nhật ký gửi thông báo xóa trước thông báo)
  for r in select * from app.archive_tables() order by ord desc loop
    execute format('delete from public.%I where %s', r.tbl, app.archive_where(r.tbl)) using v_tid, a.from_on, a.to_on;
    get diagnostics n = row_count;
    v_done := v_done || jsonb_build_object(r.tbl, n);
  end loop;
  if exists (select 1 from jsonb_each_text(v_done) c where c.value::int <> coalesce((a.counts ->> c.key)::int, 0)) then
    raise exception 'Số dòng xóa không khớp với bản sao lưu, đã hủy, không xóa gì' using errcode = '22023';
  end if;
  perform set_config('app.chuyen_du_lieu', 'off', true);
  update public.data_archives set status = 'da_chuyen', moved_at = now() where tenant_id = v_tid and id = p_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tid, auth.uid(), 'chuyen_du_lieu', 'data_archives', p_id::text, jsonb_build_object('from', a.from_on, 'to', a.to_on, 'rows', a.row_count));
  return a.counts;
end;
$$;
revoke execute on function public.archive_move(uuid, text) from public, anon, authenticated;
grant execute on function public.archive_move(uuid, text) to authenticated, service_role;
