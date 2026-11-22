-- Hợp đồng thuê xe: chữ ký bên cho thuê đã có họ tên → không in thêm họ tên bên dưới (như chữ ký giám đốc, nhân viên).
do $$
declare v text;
begin
  select pg_get_functiondef('public.set_signature_has_name(text, boolean)'::regprocedure) into v;
  v := replace(v, 'when p_who ~ ''^nv_'' then app.has_permission(''staff.edit'')',
                  'when p_who ~ ''^nv_'' then app.has_permission(''staff.edit'')
                                when p_who ~ ''^hdtx_[0-9a-f-]{36}_[ab]$'' then app.has_permission(''vehicle.edit'')');
  if v not like '%hdtx_%' then raise exception 'Không sửa được set_signature_has_name'; end if;
  execute v;
end;
$$;
