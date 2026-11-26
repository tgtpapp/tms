-- =====================================================================
-- Lưu lệnh đã đóng dấu (quét QR): đủ lượt đi + lượt về là được lưu (tối thiểu 2 dấu bến xe),
-- thay cho trước đây phải đủ 2 dấu mỗi lượt (4 dấu). Chỉ sửa số dấu tối thiểu trong hàm, không đổi bảng.
-- =====================================================================
do $$
declare v text;
begin
  v := pg_get_functiondef('public.svc_lenh_by_token(text)'::regprocedure);
  if v not like '%greatest(2 * n, 2)%' then raise exception 'Không sửa được svc_lenh_by_token'; end if;
  execute replace(v, 'greatest(2 * n, 2)', '2');
end;
$$;
