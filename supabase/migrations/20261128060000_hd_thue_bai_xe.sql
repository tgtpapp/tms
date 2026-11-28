-- =====================================================================
-- Văn bản: thêm mẫu "Hợp đồng thuê bãi đậu xe" (nhà xe là bên thuê hoặc bên cho thuê).
-- - Số hợp đồng dãy riêng HĐBX theo năm: 001/2026/HĐBX-<hậu tố>, không trùng, không dùng lại.
-- =====================================================================
alter table public.doc_counters drop constraint doc_counters_code_check;
alter table public.doc_counters add constraint doc_counters_code_check check (code in ('QD', 'CV', 'TB', 'HDLD', 'HDTX', 'QDTV', 'HDBX'));
alter table public.official_docs drop constraint official_docs_code_check;
alter table public.official_docs add constraint official_docs_code_check check (code in ('QD', 'CV', 'TB', 'QDTV', 'HDBX'));
alter table public.official_docs drop constraint official_docs_template_check;
alter table public.official_docs add constraint official_docs_template_check
  check (template in ('qd_bo_nhiem', 'qd_atgt', 'qd_giam_sat', 'cong_van', 'quyet_dinh', 'thong_bao', 'word_qd', 'word_cv', 'word_tb', 'qd_thoi_viec', 'hd_bai_xe'));

do $$
declare f record; v text;
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = 'save_official_doc';
  v := pg_get_functiondef(f.oid);
  if position('when ''qd_thoi_viec'' then ''QDTV''' in v) = 0 or position('when ''QDTV'' then ''QĐTV''' in v) = 0 then
    raise exception 'Không tìm thấy chỗ ánh xạ loại văn bản';
  end if;
  v := replace(v, 'when ''qd_thoi_viec'' then ''QDTV''', 'when ''qd_thoi_viec'' then ''QDTV'' when ''hd_bai_xe'' then ''HDBX''');
  v := replace(v, 'when ''QDTV'' then ''QĐTV''', 'when ''QDTV'' then ''QĐTV'' when ''HDBX'' then ''HĐBX''');
  execute v;
end;
$$;
revoke execute on function public.save_official_doc(uuid, text, date, text, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_official_doc(uuid, text, date, text, uuid, jsonb, uuid) to authenticated, service_role;
