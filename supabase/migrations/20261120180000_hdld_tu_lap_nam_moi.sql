-- =====================================================================
-- Hợp đồng lao động – sang năm mới tự lập hợp đồng năm mới cho mọi nhân viên đang làm (như app cũ, 1 lần/năm).
-- - Chạy 00:10 ngày 01/01 (giờ VN) bằng pg_cron; ai đã có HĐ năm đó thì bỏ qua (chạy lại không tạo trùng).
-- - Nội dung lấy từ hợp đồng gần nhất của người đó: loại HĐ, vị trí, phòng ban, mô tả công việc, phụ cấp.
--   Chưa có HĐ nào thì theo hồ sơ: loại HĐ trong hồ sơ (mặc định xác định thời hạn), chức vụ.
-- - Thời hạn: 01/01 (hoặc ngày vào làm nếu vào trong năm) → 31/12; không xác định thời hạn thì không có ngày kết thúc.
-- - Lương: lương chuyển khoản tháng bắt đầu nếu đã nhập, không thì giữ lương của HĐ gần nhất.
-- - Số cấp tiếp dãy của năm: người có HĐ năm trước theo thứ tự số cũ, rồi người mới theo tên.
-- - PDF vào Lưu trữ hồ sơ: trình duyệt của người có quyền lưu hồ sơ tự tạo (cần vẽ trang nên không làm ở máy chủ).
-- =====================================================================
create function app.renew_labor_contracts(p_tid uuid, p_year int)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  r record;
  v_n int := 0;
  v_seq int;
  v_suffix text;
  v_start date;
  v_kind text;
  v_pay bigint;
begin
  select upper(value #>> '{}') into v_suffix from public.tenant_settings where tenant_id = p_tid and key = 'lenh.hau_to';
  for r in
    select s.id, s.full_name, s.joined_on, s.job_title, s.position, p.contract_type, k.year as k_year, k.seq as k_seq, k.kind as k_kind,
           k.salary as k_salary, k.position as k_position, k.department as k_department, k.job_desc as k_job_desc, k.allowances as k_allow
    from public.staff_members s
    left join public.staff_private p on p.tenant_id = s.tenant_id and p.staff_id = s.id
    left join lateral (select * from public.labor_contracts c where c.tenant_id = s.tenant_id and c.staff_id = s.id and c.status = 'hieu_luc' and c.year < p_year
                       order by c.year desc, c.seq desc limit 1) k on true
    where s.tenant_id = p_tid and s.is_active and (s.left_on is null or s.left_on >= make_date(p_year, 1, 1))
      and s.joined_on <= make_date(p_year, 12, 31)
      and not exists (select 1 from public.labor_contracts c where c.tenant_id = s.tenant_id and c.staff_id = s.id and c.year = p_year and c.status = 'hieu_luc')
    order by (k.year = p_year - 1) desc nulls last, k.seq nulls last, s.full_name, s.id
  loop
    v_start := greatest(make_date(p_year, 1, 1), r.joined_on);
    v_kind := coalesce(r.k_kind, case when r.contract_type in ('khong_xac_dinh', 'thoi_vu') then r.contract_type else 'xac_dinh' end);
    select transfer_pay into v_pay from public.staff_pay_months where tenant_id = p_tid and staff_id = r.id and month = date_trunc('month', v_start)::date;
    v_seq := app.next_doc_no(p_tid, 'HDLD', p_year);
    if exists (select 1 from public.labor_contracts where tenant_id = p_tid and year = p_year and seq >= v_seq) then
      select max(seq) + 1 into v_seq from public.labor_contracts where tenant_id = p_tid and year = p_year;
      update public.doc_counters set last_no = v_seq where tenant_id = p_tid and code = 'HDLD' and year = p_year;
    end if;
    insert into public.labor_contracts (tenant_id, staff_id, year, seq, number, kind, start_on, end_on, salary, position, department, job_desc, allowances, created_by)
    values (p_tid, r.id, p_year, v_seq,
            lpad(v_seq::text, 3, '0') || '/' || p_year || '/HĐLĐ' || coalesce('-' || nullif(trim(v_suffix), ''), ''),
            v_kind, v_start, case when v_kind = 'khong_xac_dinh' then null else make_date(p_year, 12, 31) end,
            coalesce(nullif(v_pay, 0), r.k_salary, 0),
            coalesce(r.k_position, nullif(trim(r.job_title), ''), case r.position when 'lai_xe' then 'Lái xe' when 'phu_xe' then 'Phụ xe' else 'Nhân viên' end),
            r.k_department, r.k_job_desc, coalesce(r.k_allow, '{}'), null);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
revoke execute on function app.renew_labor_contracts(uuid, int) from public, anon, authenticated;

/** Việc định kỳ: lập hợp đồng năm mới cho mọi nhà xe. Trả số hợp đồng đã lập. */
create function app.svc_renew_labor_contracts(p_year int default null)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_year int := coalesce(p_year, extract(year from now() at time zone 'Asia/Ho_Chi_Minh')::int);
  t record;
  v_total int := 0;
begin
  for t in select id from public.tenants loop
    begin
      v_total := v_total + app.renew_labor_contracts(t.id, v_year);
    exception when others then
      raise warning 'Lập HĐLĐ năm % cho nhà xe % lỗi: %', v_year, t.id, sqlerrm;
    end;
  end loop;
  return v_total;
end;
$$;
revoke execute on function app.svc_renew_labor_contracts(int) from public, anon, authenticated;
grant execute on function app.svc_renew_labor_contracts(int) to service_role;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('hdld-nam-moi', '10 17 31 12 *', 'select app.svc_renew_labor_contracts(extract(year from now() at time zone ''Asia/Ho_Chi_Minh'')::int)');  -- 00:10 ngày 01/01 giờ VN
  else
    raise notice 'Máy chủ không có pg_cron: hợp đồng năm mới lập bằng nút "Lập HĐ cho … người chưa có"';
  end if;
exception when others then
  raise notice 'Không bật được pg_cron (%): hợp đồng năm mới lập bằng nút "Lập HĐ cho … người chưa có"', sqlerrm;
end;
$$;
