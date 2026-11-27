-- Xóa bản giấy tờ CŨ không có tệp (thường nhập từ app cũ, chỉ có chữ) khi đã có bản cùng loại, cùng ngày hết hạn và có tệp.
-- Chỉ thay thân hàm delete_duplicate_paper (thêm 1 điều kiện "trùng"); không đổi bảng, không đổi API.
do $$
declare v text;
begin
  v := pg_get_functiondef('public.delete_duplicate_paper(text, uuid)'::regprocedure);
  v := replace(v,
    E'                              and (v_no is null or app.paper_no(x.doc_no, null) is null or app.paper_no(x.doc_no, null) = v_no)))) then',
    E'                              and (v_no is null or app.paper_no(x.doc_no, null) is null or app.paper_no(x.doc_no, null) = v_no))\n'
 || E'                          or (coalesce(cardinality(d.files), 0) = 0 and coalesce(cardinality(x.files), 0) > 0\n'
 || E'                              and x.expires_on is not distinct from d.expires_on))) then');
  if v not like '%cardinality(d.files)%' then raise exception 'Không sửa được delete_duplicate_paper'; end if;
  execute v;
end;
$$;
