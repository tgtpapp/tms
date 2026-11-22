-- Bảng chấm công: tiền tài theo số chỗ của xe (vd xe 16 chỗ 150.000, 29 chỗ 180.000 đ/công), thêm / bớt được nhiều loại.
-- Lưu ở cài đặt cham_cong.tien_tai = {"16": 150000, "29": 180000}. Xe có số chỗ chưa khai thì vẫn lấy Tiền tài trong hồ sơ xe.
do $$
declare v text;
begin
  select pg_get_functiondef('public.save_timesheet_settings(jsonb)'::regprocedure) into v;
  v := replace(v, '    elsif k = ''bh14'' then',
'    elsif k = ''tien_tai'' then
      if jsonb_typeof(v) <> ''object'' or exists (select 1 from jsonb_each(v) x where x.key !~ ''^[0-9]{1,3}$'' or jsonb_typeof(x.value) <> ''number''
                                                   or x.value::numeric < 0 or x.value::numeric > 100000000) then
        raise exception ''Tiền tài theo số chỗ không hợp lệ'' using errcode = ''22023'';
      end if;
    elsif k = ''bh14'' then');
  if v not like '%tien_tai%' then raise exception 'Không sửa được save_timesheet_settings'; end if;
  execute v;
end;
$$;
