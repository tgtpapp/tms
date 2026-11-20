-- =====================================================================
-- Văn bản: thêm mẫu "Đơn xin nghỉ việc + Quyết định thôi việc" (như app cũ).
-- - Số quyết định dãy riêng QĐTV theo năm: 001/2026/QĐTV-<hậu tố>, không trùng, không dùng lại.
-- - Khi lưu có thể chuyển hồ sơ nhân viên sang "Nghỉ việc" (cần quyền staff.edit).
-- - Căn cứ Bộ luật Lao động 2019 trong mẫu theo app cũ: cần xác minh.
-- =====================================================================
alter table public.doc_counters drop constraint doc_counters_code_check;
alter table public.doc_counters add constraint doc_counters_code_check check (code in ('QD', 'CV', 'TB', 'HDLD', 'HDTX', 'QDTV'));
alter table public.official_docs drop constraint official_docs_code_check;
alter table public.official_docs add constraint official_docs_code_check check (code in ('QD', 'CV', 'TB', 'QDTV'));
alter table public.official_docs drop constraint official_docs_template_check;
alter table public.official_docs add constraint official_docs_template_check
  check (template in ('qd_bo_nhiem', 'qd_atgt', 'qd_giam_sat', 'cong_van', 'quyet_dinh', 'thong_bao', 'word_qd', 'word_cv', 'word_tb', 'qd_thoi_viec'));

do $$
declare f record; v text;
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = 'save_official_doc';
  v := pg_get_functiondef(f.oid);
  if position('when ''word_qd'' then ''QD''' in v) = 0 or position('case v_code when ''QD'' then ''QĐ'' else v_code end' in v) = 0 then
    raise exception 'Không tìm thấy chỗ ánh xạ loại văn bản';
  end if;
  v := replace(v, 'when ''word_qd'' then ''QD''', 'when ''word_qd'' then ''QD'' when ''qd_thoi_viec'' then ''QDTV''');
  v := replace(v, 'case v_code when ''QD'' then ''QĐ'' else v_code end', 'case v_code when ''QD'' then ''QĐ'' when ''QDTV'' then ''QĐTV'' else v_code end');
  execute v;
end;
$$;

/** Chuyển hồ sơ nhân viên sang "Nghỉ việc" từ ngày p_left_on (dùng khi lưu quyết định thôi việc). */
create function public.mark_staff_left(p_staff_id uuid, p_left_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id(); v_join date;
begin
  if v_tid is null or not app.has_permission('staff.edit') then
    raise exception 'Không có quyền sửa hồ sơ nhân viên' using errcode = '42501';
  end if;
  select joined_on into v_join from public.staff_members where tenant_id = v_tid and id = p_staff_id;
  if not found then raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002'; end if;
  if p_left_on is null or p_left_on < v_join then
    raise exception 'Ngày nghỉ việc phải từ ngày vào làm (%) trở đi', to_char(v_join, 'DD/MM/YYYY') using errcode = '22023';
  end if;
  update public.staff_members set left_on = p_left_on, is_active = false where tenant_id = v_tid and id = p_staff_id;
end;
$$;
revoke execute on function public.mark_staff_left(uuid, date) from public, anon, authenticated;
grant execute on function public.mark_staff_left(uuid, date) to authenticated, service_role;
