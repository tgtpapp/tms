-- Phiếu sửa chữa: thêm Đơn vị tính (ĐVT) cho từng hạng mục, như app cũ.
alter table public.repair_items add column unit text check (unit is null or length(unit) <= 30);

do $$
declare v text;
begin
  v := pg_get_functiondef('public.save_repair(uuid, jsonb, jsonb)'::regprocedure);
  v := replace(v, 'insert into public.repair_items (tenant_id, order_id, seq, content, qty, unit_price)',
                  'insert into public.repair_items (tenant_id, order_id, seq, content, unit, qty, unit_price)');
  v := replace(v, 'trim(e ->> ''content''), coalesce(', 'trim(e ->> ''content''), nullif(left(trim(coalesce(e ->> ''unit'', '''')), 30), ''''), coalesce(');
  if v not like '%content, unit, qty%' or v not like '%e ->> ''unit''%' then raise exception 'Không sửa được public.save_repair'; end if;
  execute v;
end;
$$;
