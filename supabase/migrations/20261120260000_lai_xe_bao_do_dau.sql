-- =====================================================================
-- Lái xe báo đổ dầu từ app (như app cũ): lái xe chụp trụ bơm / hóa đơn / biển số / đồng hồ km → AI đọc → gửi;
-- điều hành (quyền Thêm phiếu nhiên liệu) xem, sửa nếu cần rồi Duyệt = tạo phiếu Đổ ngoài, hoặc Bỏ.
-- Phiếu chờ duyệt không phải phiếu nhiên liệu: không vào sổ, không tính tồn / tiêu hao cho tới khi duyệt.
-- Lái xe chỉ thấy phiếu mình gửi; không ghi thẳng bảng, chỉ qua hàm.
-- =====================================================================
create table public.fuel_reports (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null default app.current_tenant_id() references public.tenants (id),
  staff_id       uuid not null,
  vehicle_id     uuid not null,
  plate          text not null,             -- biển số lúc gửi (lái xe không xem danh sách xe)
  entry_date     date not null,
  entry_time     time,
  odo_km         int check (odo_km is null or odo_km >= 0),
  liters         numeric(10, 3) not null check (liters > 0),
  unit_price     bigint not null check (unit_price > 0),
  amount         bigint check (amount is null or amount >= 0),
  supplier       text,
  invoice_no     text,
  note           text,
  files          text[] not null default '{}',
  status         text not null default 'cho' check (status in ('cho', 'duyet', 'bo')),
  fuel_entry_id  uuid,
  handled_by     uuid,
  handled_at     timestamptz,
  reject_reason  text,
  client_key     text not null,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, client_key),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id) on delete cascade,
  foreign key (tenant_id, vehicle_id) references public.vehicles (tenant_id, id) on delete cascade,
  foreign key (tenant_id, fuel_entry_id) references public.fuel_entries (tenant_id, id) on delete set null (fuel_entry_id)
);
create index fuel_reports_status_idx on public.fuel_reports (tenant_id, status, created_at);
create index fuel_reports_staff_idx on public.fuel_reports (tenant_id, staff_id, created_at);
create trigger fuel_reports_audit after insert or update or delete on public.fuel_reports for each row execute function app.write_audit();

alter table public.fuel_reports enable row level security;
revoke all on public.fuel_reports from public, anon, authenticated;
grant select on public.fuel_reports to authenticated;
grant select, insert, update, delete on public.fuel_reports to service_role;
create policy fuel_reports_select on public.fuel_reports for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('fuel.view') or app.is_my_staff(staff_id::text)));

-- Ảnh lái xe gửi: <nhà xe>/bao_dau/<mã hồ sơ lái xe>/… – chính lái xe tải lên / xem; người xem nhiên liệu xem được.
create policy bao_dau_select on storage.objects for select to authenticated
  using (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
         and (storage.foldername(name))[2] = 'bao_dau'
         and (app.is_my_staff((storage.foldername(name))[3]) or app.has_permission('fuel.view')));
create policy bao_dau_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'giay-to' and (storage.foldername(name))[1] = app.current_tenant_id()::text
              and (storage.foldername(name))[2] = 'bao_dau' and app.is_my_staff((storage.foldername(name))[3]));

-- Mã hồ sơ nhân viên của người đang đăng nhập (lái xe, phụ xe…); null = không có hồ sơ.
create function public.my_staff_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select id from public.staff_members where tenant_id = app.current_tenant_id() and user_id = auth.uid() limit 1
$$;
revoke execute on function public.my_staff_id() from public, anon, authenticated;
grant execute on function public.my_staff_id() to authenticated, service_role;

-- Lái xe gửi phiếu báo đổ dầu. p: {key, plate, entry_date, entry_time, odo_km, liters, unit_price, amount, supplier, invoice_no, note, files[]}
-- Gửi lại cùng key (mạng chập chờn) không sinh phiếu trùng.
create function public.report_fuel(p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_staff uuid := public.my_staff_id();
  v_key text := nullif(trim(p ->> 'key'), '');
  v_plate text := upper(regexp_replace(coalesce(p ->> 'plate', ''), '[^A-Za-z0-9]', '', 'g'));
  v_veh uuid;
  v_plate_txt text;
  v_lit numeric := nullif(p ->> 'liters', '')::numeric;
  v_price bigint := nullif(p ->> 'unit_price', '')::numeric::bigint;
  v_amount bigint := nullif(p ->> 'amount', '')::numeric::bigint;
  v_files text[] := coalesce(array(select jsonb_array_elements_text(p -> 'files')), '{}');
  v_id uuid;
begin
  if v_tid is null or v_staff is null then
    raise exception 'Chỉ lái xe / nhân viên có hồ sơ mới báo đổ dầu được' using errcode = '42501';
  end if;
  if v_key is null or length(v_key) > 100 then raise exception 'Thiếu mã gửi' using errcode = '22023'; end if;
  select id into v_id from public.fuel_reports where tenant_id = v_tid and client_key = v_key;
  if v_id is not null then return v_id; end if;
  if v_plate = '' then raise exception 'Chọn biển số xe' using errcode = '22023'; end if;
  select id, plate into v_veh, v_plate_txt from public.vehicles
   where tenant_id = v_tid and upper(regexp_replace(plate, '[^A-Za-z0-9]', '', 'g')) = v_plate limit 1;
  if v_veh is null then raise exception 'Không tìm thấy xe biển số %', p ->> 'plate' using errcode = 'P0002'; end if;
  if coalesce(v_lit, 0) <= 0 or v_lit > 2000 then raise exception 'Nhập số lít' using errcode = '22023'; end if;
  if coalesce(v_price, 0) <= 0 and coalesce(v_amount, 0) > 0 then v_price := round(v_amount / v_lit); end if;
  if coalesce(v_price, 0) <= 0 then raise exception 'Nhập đơn giá hoặc thành tiền' using errcode = '22023'; end if;
  if array_length(v_files, 1) > 6 then raise exception 'Tối đa 6 ảnh' using errcode = '22023'; end if;
  if exists (select 1 from unnest(v_files) f where f not like v_tid::text || '/bao_dau/' || v_staff::text || '/%') then
    raise exception 'Ảnh không hợp lệ' using errcode = '22023';
  end if;
  insert into public.fuel_reports (tenant_id, staff_id, vehicle_id, plate, entry_date, entry_time, odo_km, liters, unit_price, amount,
                                   supplier, invoice_no, note, files, client_key)
  values (v_tid, v_staff, v_veh, v_plate_txt, coalesce(nullif(p ->> 'entry_date', '')::date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
          nullif(p ->> 'entry_time', '')::time, nullif(p ->> 'odo_km', '')::numeric::int, v_lit, v_price, v_amount,
          nullif(trim(p ->> 'supplier'), ''), nullif(trim(p ->> 'invoice_no'), ''), nullif(trim(p ->> 'note'), ''), v_files, v_key)
  on conflict (tenant_id, client_key) do nothing
  returning id into v_id;
  if v_id is null then select id into v_id from public.fuel_reports where tenant_id = v_tid and client_key = v_key; end if;
  return v_id;
end;
$$;
revoke execute on function public.report_fuel(jsonb) from public, anon, authenticated;
grant execute on function public.report_fuel(jsonb) to authenticated;

-- Duyệt: tạo phiếu Đổ ngoài (số liệu điều hành đã kiểm tra trong p, ảnh lấy theo phiếu lái xe gửi). Trả id phiếu nhiên liệu.
create function public.approve_fuel_report(p_id uuid, p jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r public.fuel_reports;
  v_who text;
  v_entry uuid;
begin
  if v_tid is null or not app.has_permission('fuel.add') then
    raise exception 'Không có quyền thêm phiếu nhiên liệu' using errcode = '42501';
  end if;
  select * into r from public.fuel_reports where tenant_id = v_tid and id = p_id for update;
  if not found then raise exception 'Không tìm thấy phiếu' using errcode = 'P0002'; end if;
  if r.status <> 'cho' then raise exception 'Phiếu này đã được xử lý' using errcode = '22023'; end if;
  select full_name into v_who from public.staff_members where tenant_id = v_tid and id = r.staff_id;
  -- Ảnh: của lái xe gửi + ảnh điều hành gắn thêm khi duyệt
  v_entry := public.save_fuel(null, p || jsonb_build_object('kind', 'ngoai',
    'files', to_jsonb(array(select distinct f from unnest(r.files || coalesce(array(select jsonb_array_elements_text(p -> 'files')), '{}')) f)),
    'note', concat_ws(' · ', nullif(trim(p ->> 'note'), ''), 'Lái xe ' || coalesce(v_who, '') || ' gửi qua app')));
  update public.fuel_reports set status = 'duyet', fuel_entry_id = v_entry, handled_by = auth.uid(), handled_at = now()
   where tenant_id = v_tid and id = p_id;
  return v_entry;
end;
$$;
revoke execute on function public.approve_fuel_report(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.approve_fuel_report(uuid, jsonb) to authenticated;

-- Bỏ phiếu (không tạo phiếu nhiên liệu), lái xe thấy lý do.
create function public.reject_fuel_report(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('fuel.add') then
    raise exception 'Không có quyền thêm phiếu nhiên liệu' using errcode = '42501';
  end if;
  update public.fuel_reports set status = 'bo', handled_by = auth.uid(), handled_at = now(), reject_reason = nullif(trim(p_reason), '')
   where tenant_id = v_tid and id = p_id and status = 'cho';
  if not found then
    if exists (select 1 from public.fuel_reports where tenant_id = v_tid and id = p_id) then
      raise exception 'Phiếu này đã được xử lý' using errcode = '22023';
    end if;
    raise exception 'Không tìm thấy phiếu' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.reject_fuel_report(uuid, text) from public, anon, authenticated;
grant execute on function public.reject_fuel_report(uuid, text) to authenticated;
