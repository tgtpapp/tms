-- Phiếu sửa chữa: thêm lái xe (chỉ thêm cột, không đổi/xóa cột cũ; phiếu cũ để trống)
alter table public.repair_orders add column driver_id uuid;
alter table public.repair_orders add constraint repair_orders_driver_fk
  foreign key (tenant_id, driver_id) references public.staff_members (tenant_id, id) on delete set null (driver_id);
create index repair_orders_driver_idx on public.repair_orders (tenant_id, driver_id);

-- save_repair lưu thêm p->>'driver_id' (lái xe phải thuộc cùng nhà xe)
do $$
declare v text;
begin
  v := pg_get_functiondef('public.save_repair(uuid, jsonb, jsonb)'::regprocedure);
  v := replace(v, 'insert into public.repair_orders (id, tenant_id, code, vehicle_id,', 'insert into public.repair_orders (id, tenant_id, code, driver_id, vehicle_id,');
  v := replace(v, 'values (v_id, v_tid, nullif(trim(p ->> ''code''), ''''),', 'values (v_id, v_tid, nullif(trim(p ->> ''code''), ''''), nullif(p ->> ''driver_id'', '''')::uuid,');
  v := replace(v, 'on conflict (id) do update set vehicle_id = excluded.vehicle_id,', 'on conflict (id) do update set driver_id = excluded.driver_id, vehicle_id = excluded.vehicle_id,');
  v := replace(v, '  delete from public.repair_items where tenant_id = v_tid and order_id = v_id;',
    '  if nullif(p ->> ''driver_id'', '''') is not null and not exists (select 1 from public.staff_members where tenant_id = v_tid and id = (p ->> ''driver_id'')::uuid) then
    raise exception ''Không tìm thấy lái xe'' using errcode = ''P0002'';
  end if;
  delete from public.repair_items where tenant_id = v_tid and order_id = v_id;');
  if v not like '%code, driver_id, vehicle_id%' or v not like '%::uuid, (p ->> ''vehicle_id'')%' or v not like '%set driver_id = excluded.driver_id%' or v not like '%Không tìm thấy lái xe%' then
    raise exception 'Không sửa được public.save_repair';
  end if;
  execute v;
end;
$$;
