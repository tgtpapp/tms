-- Chuyển lại phiếu sửa chữa từ app cũ: phiếu đã có (cùng số phiếu) thì điền thêm phần còn thiếu,
-- không đụng nội dung / số tiền: ảnh, PDF hóa đơn (khi phiếu chưa có tệp nào) và ĐVT (hạng mục cùng thứ tự, cùng nội dung, chưa có ĐVT).
create or replace function public.import_legacy_ops(p_repairs jsonb, p_fuel jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r jsonb;
  v_id uuid;
  n_rep int := 0; n_fuel int := 0; n_same int := 0; n_fill int := 0; n_up int;
  v_err jsonb := '[]';
begin
  if v_tid is null or not app.has_permission('repair.add') then
    raise exception 'Không có quyền quản lý xe' using errcode = '42501';
  end if;
  if jsonb_array_length(coalesce(p_repairs, '[]')) + jsonb_array_length(coalesce(p_fuel, '[]')) > 1000 then
    raise exception 'Mỗi lần tối đa 1000 phiếu' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p_repairs, '[]')) loop
    begin
      select id into v_id from public.repair_orders where tenant_id = v_tid and code = r ->> 'code';
      if found then
        n_same := n_same + 1;
        if app.has_permission('repair.edit') then
          n_up := 0;
          if jsonb_typeof(r -> 'files') = 'array' and jsonb_array_length(r -> 'files') > 0 then
            update public.repair_orders set files = array(select jsonb_array_elements_text(r -> 'files'))
            where tenant_id = v_tid and id = v_id and cardinality(files) = 0;
            if found then n_up := 1; end if;
          end if;
          update public.repair_items i set unit = left(trim(x.e ->> 'unit'), 30)
          from jsonb_array_elements(coalesce(r -> 'items', '[]')) with ordinality x(e, ord)
          where i.tenant_id = v_tid and i.order_id = v_id and i.seq = x.ord and i.unit is null
            and coalesce(trim(x.e ->> 'unit'), '') <> '' and i.content = trim(x.e ->> 'content');
          if found then n_up := 1; end if;
          n_fill := n_fill + n_up;
        end if;
        continue;
      end if;
      v_id := public.save_repair(null, r, coalesce(r -> 'items', '[]'));
      n_rep := n_rep + 1;
    exception when others then
      v_err := v_err || jsonb_build_object('code', r ->> 'code', 'error', sqlerrm);
    end;
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_fuel, '[]')) loop
    begin
      if exists (select 1 from public.fuel_entries where tenant_id = v_tid and code = r ->> 'code') then n_same := n_same + 1; continue; end if;
      v_id := public.save_fuel(null, r);
      n_fuel := n_fuel + 1;
    exception when others then
      v_err := v_err || jsonb_build_object('code', r ->> 'code', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('repairs', n_rep, 'fuel', n_fuel, 'same', n_same, 'filled', n_fill, 'errors', v_err);
end;
$$;
