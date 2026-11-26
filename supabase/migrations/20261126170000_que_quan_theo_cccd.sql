-- =====================================================================
-- Thông tin cá nhân theo CCCD: Quê quán + Nơi thường trú (thay "Chỗ ở hiện nay" trên hồ sơ và mọi giấy tờ, hợp đồng).
-- - Thêm cột staff_private.hometown (quê quán). Chỉ thêm cột: cột current_address (chỗ ở hiện nay) giữ nguyên dữ liệu, không hiện nữa.
-- - save_staff nhận thêm 'hometown' (không gửi thì giữ nguyên giá trị cũ).
-- - Đồng bộ với CCCD: lưu / sửa CCCD đang dùng của nhân viên thì Quê quán, Nơi thường trú lấy theo CCCD (CCCD có ghi mới lấy).
-- - Cập nhật lại dữ liệu cũ theo CCCD đang dùng (theo CCCD, ghi đè chỗ nhập tay); người chưa có CCCD giữ nguyên.
-- =====================================================================
alter table public.staff_private add column hometown text check (hometown is null or length(hometown) <= 300);

do $$
declare v text;
begin
  select pg_get_functiondef('public.save_staff(uuid, jsonb)'::regprocedure) into v;
  v := replace(v, '(staff_id, tenant_id, birth_date, gender, address, current_address, contract_type, note, bhxh_no, bank_account)',
                  '(staff_id, tenant_id, birth_date, gender, address, current_address, contract_type, note, bhxh_no, bank_account, hometown)');
  v := replace(v, 'nullif(trim(p ->> ''bhxh_no''), ''''), nullif(trim(p ->> ''bank_account''), ''''))',
                  'nullif(trim(p ->> ''bhxh_no''), ''''), nullif(trim(p ->> ''bank_account''), ''''), nullif(trim(p ->> ''hometown''), ''''))');
  v := replace(v, 'bank_account = case when p ? ''bank_account'' then excluded.bank_account else public.staff_private.bank_account end;',
                  'bank_account = case when p ? ''bank_account'' then excluded.bank_account else public.staff_private.bank_account end,
    hometown = case when p ? ''hometown'' then excluded.hometown else public.staff_private.hometown end;');
  if v not like '%bank_account, hometown)%' or v not like '%hometown = case when%' or v not like '%p ->> ''hometown''%' then
    raise exception 'Không sửa được save_staff';
  end if;
  execute v;
end;
$$;

/** CCCD đang dùng của nhân viên → Quê quán, Nơi thường trú trong hồ sơ */
create function app.sync_cccd_to_staff()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare v_addr text := nullif(trim(new.data ->> 'nv.noi_thuong_tru'), ''); v_home text := nullif(trim(new.data ->> 'que_quan'), '');
begin
  if new.doc_type <> 'cccd' or not new.is_current or new.staff_id is null or (v_addr is null and v_home is null) then return null; end if;
  insert into public.staff_private (staff_id, tenant_id, address, hometown)
  values (new.staff_id, new.tenant_id, left(v_addr, 300), left(v_home, 300))
  on conflict (staff_id) do update set
    address = coalesce(excluded.address, public.staff_private.address),
    hometown = coalesce(excluded.hometown, public.staff_private.hometown),
    updated_at = now()
  where public.staff_private.address is distinct from coalesce(excluded.address, public.staff_private.address)
     or public.staff_private.hometown is distinct from coalesce(excluded.hometown, public.staff_private.hometown);
  return null;
end;
$$;
revoke execute on function app.sync_cccd_to_staff() from public, anon, authenticated;
create trigger documents_cccd_sync after insert or update of data, is_current on public.documents
  for each row execute function app.sync_cccd_to_staff();

-- Cập nhật lại dữ liệu cũ theo CCCD đang dùng
insert into public.staff_private (staff_id, tenant_id, address, hometown)
select distinct on (d.staff_id) d.staff_id, d.tenant_id, left(nullif(trim(d.data ->> 'nv.noi_thuong_tru'), ''), 300), left(nullif(trim(d.data ->> 'que_quan'), ''), 300)
from public.documents d
where d.doc_type = 'cccd' and d.is_current and d.staff_id is not null
  and (nullif(trim(d.data ->> 'nv.noi_thuong_tru'), '') is not null or nullif(trim(d.data ->> 'que_quan'), '') is not null)
order by d.staff_id, d.updated_at desc
on conflict (staff_id) do update set
  address = coalesce(excluded.address, public.staff_private.address),
  hometown = coalesce(excluded.hometown, public.staff_private.hometown),
  updated_at = now();
