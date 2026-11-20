-- =====================================================================
-- Đóng BHXH & lương chuyển khoản theo tháng (như Cài đặt của app cũ): mỗi tháng, mỗi nhân viên:
-- có đóng BHXH không, lương chuyển khoản, mức lương đóng BHXH. Dùng cho bảng tháng (lưu PDF vào hồ sơ)
-- và làm số lương mặc định khi in hợp đồng lao động (lương chuyển khoản của tháng bắt đầu hợp đồng).
-- Quyền: salary.manage (xem, sửa). Chủ / Quản trị và Kế toán có sẵn. Ghi chỉ qua hàm.
-- =====================================================================
insert into public.permissions (code, module, name) values ('salary.manage', 'luong', 'Lương & BHXH theo tháng: xem, sửa');
select app.grant_permission_to_admins('salary.manage');
insert into public.role_permissions (tenant_id, role_id, permission_code)
select r.tenant_id, r.id, 'salary.manage' from public.roles r where r.code = 'accountant'
on conflict do nothing;

create table public.staff_pay_months (
  tenant_id      uuid not null references public.tenants (id),
  staff_id       uuid not null,
  month          date not null check (extract(day from month) = 1),     -- ngày 01 của tháng
  has_bhxh       boolean not null default false,
  transfer_pay   bigint not null default 0 check (transfer_pay between 0 and 10000000000),   -- lương chuyển khoản
  bhxh_pay       bigint not null default 0 check (bhxh_pay between 0 and 10000000000),       -- mức lương đóng BHXH
  updated_at     timestamptz not null default now(),
  updated_by     uuid default auth.uid(),
  primary key (tenant_id, month, staff_id),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id) on delete cascade
);
create index staff_pay_months_staff_idx on public.staff_pay_months (tenant_id, staff_id, month);
create trigger staff_pay_months_touch before update on public.staff_pay_months for each row execute function app.touch_updated_at();
create trigger staff_pay_months_audit after insert or update or delete on public.staff_pay_months for each row execute function app.write_audit();

alter table public.staff_pay_months enable row level security;
revoke all on public.staff_pay_months from public, anon, authenticated;
grant select on public.staff_pay_months to authenticated;
grant select, insert, update, delete on public.staff_pay_months to service_role;
create policy staff_pay_months_select on public.staff_pay_months for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('salary.manage'));

/** Lưu các dòng của 1 tháng: p_rows = [{ staff_id, has_bhxh, transfer_pay, bhxh_pay }, …]. */
create function public.save_pay_month(p_month date, p_rows jsonb)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_m date := date_trunc('month', p_month)::date;
  v_n int;
begin
  if v_tid is null or not app.has_permission('salary.manage') then
    raise exception 'Không có quyền sửa lương & BHXH' using errcode = '42501';
  end if;
  if p_month is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Dữ liệu không hợp lệ' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) r
             where not exists (select 1 from public.staff_members s where s.tenant_id = v_tid and s.id::text = r ->> 'staff_id')) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  insert into public.staff_pay_months (tenant_id, staff_id, month, has_bhxh, transfer_pay, bhxh_pay)
  select v_tid, (r ->> 'staff_id')::uuid, v_m, coalesce((r ->> 'has_bhxh')::boolean, false),
         greatest(0, coalesce((r ->> 'transfer_pay')::bigint, 0)), greatest(0, coalesce((r ->> 'bhxh_pay')::bigint, 0))
  from jsonb_array_elements(p_rows) r
  on conflict (tenant_id, month, staff_id) do update set
    has_bhxh = excluded.has_bhxh, transfer_pay = excluded.transfer_pay, bhxh_pay = excluded.bhxh_pay, updated_by = auth.uid();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.save_pay_month(date, jsonb) from public, anon, authenticated;
grant execute on function public.save_pay_month(date, jsonb) to authenticated;
