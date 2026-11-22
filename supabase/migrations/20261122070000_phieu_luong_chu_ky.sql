-- Phiếu lương / bảng chấm công của mình: nhân viên, lái xe in ra phải có chữ ký Giám đốc + dấu công ty (như mọi giấy tờ công ty).
-- Trước đây chỉ người có quyền điều hành / cấu hình / cấp lệnh đọc được ảnh chữ ký Giám đốc và con dấu,
-- nên phiếu lương của lái xe in ra để trống. Nay mọi người dùng trong nhà xe đọc được 2 ảnh này (chỉ đọc; vẫn chỉ trong nhà xe của mình).
-- Chữ ký riêng của người khác vẫn không xem được.
do $$
declare v text;
begin
  select pg_get_functiondef('app.can_read_signature(text)'::regprocedure) into v;
  v := regexp_replace(v, 'select app\.has_permission\(', 'select p_file in (''giam_doc.png'', ''con_dau.png'') or app.has_permission(');
  if v not like '%con_dau.png%' then raise exception 'Không sửa được can_read_signature'; end if;
  execute v;
end;
$$;
