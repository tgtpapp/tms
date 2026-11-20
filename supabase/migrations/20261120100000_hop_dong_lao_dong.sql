-- =====================================================================
-- Hợp đồng lao động (như app cũ): mỗi người mỗi năm 1 hợp đồng (mặc định 01/01 hoặc ngày vào làm → 31/12).
-- - Số HĐ tự cấp: 001/<năm>/HĐLĐ-<ký hiệu nhà xe>, tự tăng theo năm bắt đầu hợp đồng, không trùng, không dùng lại
--   (hợp đồng không xóa được, chỉ hủy; số đã hủy giữ trong sổ). Dùng chung bộ đếm doc_counters (mã HDLD).
-- - Lương ghi trên HĐ: mặc định lấy Lương chuyển khoản của tháng bắt đầu (bảng BHXH & lương theo tháng), sửa được trên từng HĐ.
-- - Quyền: salary.manage (lập, sửa, hủy, xem). Người lao động xem được hợp đồng của chính mình.
-- - Nội dung điều khoản: chép nguyên văn app cũ; căn cứ pháp lý cần xác minh.
-- =====================================================================
create table public.labor_contracts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant_id() references public.tenants (id),
  staff_id      uuid not null,
  year          int not null,
  seq           int not null check (seq > 0),
  number        text not null,
  kind          text not null default 'xac_dinh' check (kind in ('xac_dinh', 'thoi_vu', 'khong_xac_dinh')),
  start_on      date not null,
  end_on        date,
  salary        bigint not null default 0 check (salary between 0 and 10000000000),
  position      text check (position is null or length(position) <= 120),     -- vị trí
  department    text check (department is null or length(department) <= 120), -- phòng ban
  job_desc      text check (job_desc is null or length(job_desc) <= 4000),     -- công việc cần thực hiện (Phụ lục I)
  allowances    jsonb not null default '{}' check (jsonb_typeof(allowances) = 'object'),  -- an_trua, xang, dien_thoai, khac (đồng/tháng)
  status        text not null default 'hieu_luc' check (status in ('hieu_luc', 'da_huy')),
  cancel_reason text,
  request_id    uuid,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, year, seq),
  unique (tenant_id, request_id),
  check (year = extract(year from start_on)::int),
  check (end_on is null or end_on >= start_on),
  check ((kind = 'khong_xac_dinh') = (end_on is null)),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id) on delete cascade
);
-- mỗi người mỗi năm chỉ 1 hợp đồng đang hiệu lực
create unique index labor_contracts_one_per_year on public.labor_contracts (tenant_id, staff_id, year) where status = 'hieu_luc';
create index labor_contracts_list_idx on public.labor_contracts (tenant_id, year, seq);
create trigger labor_contracts_touch before update on public.labor_contracts for each row execute function app.touch_updated_at();
create trigger labor_contracts_audit after insert or update or delete on public.labor_contracts for each row execute function app.write_audit();

alter table public.labor_contracts enable row level security;
revoke all on public.labor_contracts from public, anon, authenticated;
grant select on public.labor_contracts to authenticated;
grant select, insert, update, delete on public.labor_contracts to service_role;
create policy labor_contracts_select on public.labor_contracts for select to authenticated
  using (tenant_id = app.current_tenant_id() and (app.has_permission('salary.manage') or app.is_my_staff(staff_id::text)));

/** Lập (cấp số) hoặc sửa hợp đồng lao động. Trả { id, number }. */
create function public.save_labor_contract(
  p_id uuid, p_staff_id uuid, p_kind text, p_start_on date, p_end_on date, p_salary bigint,
  p_position text, p_department text, p_job_desc text, p_allowances jsonb, p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_year int := extract(year from p_start_on)::int;
  v_end date := case when p_kind = 'khong_xac_dinh' then null else p_end_on end;
  v_seq int;
  v_suffix text;
  v_row public.labor_contracts;
begin
  if v_tid is null or not app.has_permission('salary.manage') then
    raise exception 'Không có quyền lập hợp đồng lao động' using errcode = '42501';
  end if;
  if p_start_on is null or p_kind is null or p_kind not in ('xac_dinh', 'thoi_vu', 'khong_xac_dinh') then
    raise exception 'Chọn loại hợp đồng và ngày bắt đầu' using errcode = '22023';
  end if;
  if p_kind <> 'khong_xac_dinh' and (p_end_on is null or p_end_on < p_start_on) then
    raise exception 'Ngày kết thúc hợp đồng phải sau ngày bắt đầu' using errcode = '22023';
  end if;
  if not exists (select 1 from public.staff_members where tenant_id = v_tid and id = p_staff_id) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;

  if p_id is null then
    if p_request_id is not null then
      select * into v_row from public.labor_contracts where tenant_id = v_tid and request_id = p_request_id;
      if found then return jsonb_build_object('id', v_row.id, 'number', v_row.number); end if;
    end if;
    if exists (select 1 from public.labor_contracts where tenant_id = v_tid and staff_id = p_staff_id and year = v_year and status = 'hieu_luc') then
      raise exception 'Người này đã có hợp đồng năm %; sửa hợp đồng đó hoặc hủy rồi lập lại', v_year using errcode = '23505';
    end if;
    v_seq := app.next_doc_no(v_tid, 'HDLD', v_year);
    if exists (select 1 from public.labor_contracts where tenant_id = v_tid and year = v_year and seq >= v_seq) then
      select max(seq) + 1 into v_seq from public.labor_contracts where tenant_id = v_tid and year = v_year;
      update public.doc_counters set last_no = v_seq where tenant_id = v_tid and code = 'HDLD' and year = v_year;
    end if;
    select upper(value #>> '{}') into v_suffix from public.tenant_settings where tenant_id = v_tid and key = 'lenh.hau_to';
    insert into public.labor_contracts (tenant_id, staff_id, year, seq, number, kind, start_on, end_on, salary, position, department, job_desc, allowances, request_id)
    values (v_tid, p_staff_id, v_year, v_seq,
            lpad(v_seq::text, 3, '0') || '/' || v_year || '/HĐLĐ' || coalesce('-' || nullif(trim(v_suffix), ''), ''),
            p_kind, p_start_on, v_end, greatest(0, coalesce(p_salary, 0)), nullif(trim(p_position), ''), nullif(trim(p_department), ''),
            nullif(trim(p_job_desc), ''), coalesce(p_allowances, '{}'), p_request_id)
    returning * into v_row;
    return jsonb_build_object('id', v_row.id, 'number', v_row.number);
  end if;

  select * into v_row from public.labor_contracts where tenant_id = v_tid and id = p_id for update;
  if not found then
    raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002';
  end if;
  if v_row.status = 'da_huy' then
    raise exception 'Hợp đồng đã hủy, không sửa được' using errcode = '22023';
  end if;
  if v_row.staff_id <> p_staff_id then
    raise exception 'Không đổi được người lao động của hợp đồng đã cấp số' using errcode = '22023';
  end if;
  if v_row.year <> v_year then
    raise exception 'Số % đã cấp theo năm %; đổi sang năm khác thì hủy hợp đồng này và lập hợp đồng mới', v_row.number, v_row.year using errcode = '22023';
  end if;
  update public.labor_contracts set kind = p_kind, start_on = p_start_on, end_on = v_end, salary = greatest(0, coalesce(p_salary, 0)),
    position = nullif(trim(p_position), ''), department = nullif(trim(p_department), ''), job_desc = nullif(trim(p_job_desc), ''),
    allowances = coalesce(p_allowances, '{}')
  where tenant_id = v_tid and id = p_id;
  return jsonb_build_object('id', v_row.id, 'number', v_row.number);
end;
$$;
revoke execute on function public.save_labor_contract(uuid, uuid, text, date, date, bigint, text, text, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_labor_contract(uuid, uuid, text, date, date, bigint, text, text, text, jsonb, uuid) to authenticated;

/** Hủy hợp đồng: giữ số trong sổ (không cấp lại). */
create function public.cancel_labor_contract(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('salary.manage') then
    raise exception 'Không có quyền hủy hợp đồng lao động' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Nhập lý do hủy' using errcode = '22023';
  end if;
  update public.labor_contracts set status = 'da_huy', cancel_reason = trim(p_reason)
  where tenant_id = v_tid and id = p_id and status = 'hieu_luc';
  if not found then
    raise exception 'Không tìm thấy hợp đồng' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.cancel_labor_contract(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_labor_contract(uuid, text) to authenticated;
