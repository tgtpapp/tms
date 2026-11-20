-- =====================================================================
-- Văn bản tự soạn (mở từ file Word hoặc soạn mới, AI sửa theo yêu cầu, điền thông tin người được chọn vào các ô {…}).
-- Mẫu: word_qd / word_cv / word_tb – cấp số chung dãy QĐ / CV / TB như các văn bản khác (001 trở đi, không trùng).
-- Nội dung lưu ở content.html.
-- =====================================================================
alter table public.official_docs drop constraint official_docs_template_check;
alter table public.official_docs add constraint official_docs_template_check
  check (template in ('qd_bo_nhiem', 'qd_atgt', 'cong_van', 'quyet_dinh', 'thong_bao', 'word_qd', 'word_cv', 'word_tb'));
alter table public.official_docs add constraint official_docs_content_size check (pg_column_size(content) < 1000000);

do $$
declare f record; v text;
begin
  select pr.oid into f from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace where n.nspname = 'public' and pr.proname = 'save_official_doc';
  v := pg_get_functiondef(f.oid);
  if position('when ''quyet_dinh'' then ''QD'' end' in v) = 0 then raise exception 'Không tìm thấy chỗ ánh xạ loại văn bản'; end if;
  v := replace(v, 'when ''quyet_dinh'' then ''QD'' end',
               'when ''quyet_dinh'' then ''QD'' when ''word_qd'' then ''QD'' when ''word_cv'' then ''CV'' when ''word_tb'' then ''TB'' end');
  execute v;
end;
$$;
