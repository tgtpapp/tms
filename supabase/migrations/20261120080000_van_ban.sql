-- =====================================================================
-- Văn bản (công văn, quyết định, thông báo) – như các mẫu quyết định của app cũ, thêm sổ văn bản có số.
-- - Mẫu: Quyết định bổ nhiệm người điều hành vận tải, Quyết định thành lập Ban An toàn giao thông (theo app cũ),
--   Công văn, Quyết định khác, Thông báo (soạn tự do).
-- - Số văn bản: mỗi loại (QĐ / CV / TB) một dãy riêng theo năm của ngày ký, bắt đầu 001, tự tăng,
--   KHÔNG BAO GIỜ trùng và không dùng lại (văn bản không xóa được, chỉ hủy; số đã hủy vẫn giữ).
--   Dạng: 001/2026/QĐ-<ký hiệu nhà xe> (ký hiệu = Cấu hình › Ký hiệu trên số lệnh / hợp đồng; trống thì bỏ phần "-…").
--   Số chốt lúc cấp, sau này đổi ký hiệu không làm đổi số đã cấp.
-- - Quyền: doc.manage (soạn, cấp số, sửa, hủy). Chủ / Quản trị có sẵn.
-- - Căn cứ pháp lý ghi trong các mẫu: theo app cũ, cần xác minh.
-- =====================================================================
insert into public.permissions (code, module, name) values ('doc.manage', 'van_ban', 'Văn bản: soạn, cấp số, sửa, hủy công văn / quyết định / thông báo');
select app.grant_permission_to_admins('doc.manage');

-- Bộ đếm số theo nhà xe × loại × năm (chỉ hàm cấp số ghi)
create table public.doc_counters (
  tenant_id  uuid not null references public.tenants (id),
  code       text not null check (code in ('QD', 'CV', 'TB', 'HDLD')),
  year       int not null check (year between 2000 and 2100),
  last_no    int not null check (last_no >= 0),
  primary key (tenant_id, code, year)
);
alter table public.doc_counters enable row level security;
revoke all on public.doc_counters from public, anon, authenticated;
grant select on public.doc_counters to authenticated;
grant select, insert, update, delete on public.doc_counters to service_role;
create policy doc_counters_select on public.doc_counters for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('doc.manage'));

/** Cấp số tiếp theo (dùng chung cho văn bản và hợp đồng lao động). Khóa hàng bộ đếm trong giao dịch → không trùng khi 2 người cùng cấp. */
create function app.next_doc_no(p_tid uuid, p_code text, p_year int)
returns int
language sql volatile security definer set search_path = ''
as $$
  insert into public.doc_counters (tenant_id, code, year, last_no) values (p_tid, p_code, p_year, 1)
  on conflict (tenant_id, code, year) do update set last_no = public.doc_counters.last_no + 1
  returning last_no
$$;
revoke execute on function app.next_doc_no(uuid, text, int) from public, anon, authenticated;

create table public.official_docs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null default app.current_tenant_id() references public.tenants (id),
  template      text not null check (template in ('qd_bo_nhiem', 'qd_atgt', 'cong_van', 'quyet_dinh', 'thong_bao')),
  code          text not null check (code in ('QD', 'CV', 'TB')),
  year          int not null,
  seq           int not null check (seq > 0),
  number        text not null,
  signed_on     date not null,
  title         text not null check (length(trim(title)) between 1 and 300),   -- trích yếu
  staff_id      uuid,                                                          -- người liên quan (bổ nhiệm…)
  content       jsonb not null default '{}' check (jsonb_typeof(content) = 'object'),
  status        text not null default 'hieu_luc' check (status in ('hieu_luc', 'da_huy')),
  cancel_reason text,
  request_id    uuid,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, code, year, seq),
  unique (tenant_id, request_id),
  check (year = extract(year from signed_on)::int),
  foreign key (tenant_id, staff_id) references public.staff_members (tenant_id, id) on delete set null (staff_id)
);
create index official_docs_list_idx on public.official_docs (tenant_id, year desc, code, seq desc);
create index official_docs_staff_idx on public.official_docs (tenant_id, staff_id);
create trigger official_docs_touch before update on public.official_docs for each row execute function app.touch_updated_at();
create trigger official_docs_audit after insert or update or delete on public.official_docs for each row execute function app.write_audit();

alter table public.official_docs enable row level security;
revoke all on public.official_docs from public, anon, authenticated;
grant select on public.official_docs to authenticated;
grant select, insert, update, delete on public.official_docs to service_role;
create policy official_docs_select on public.official_docs for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('doc.manage'));

/** Soạn mới (cấp số) hoặc sửa văn bản. Mới: p_id null, p_request_id chống bấm 2 lần. Trả { id, number }. */
create function public.save_official_doc(p_id uuid, p_template text, p_signed_on date, p_title text, p_staff_id uuid, p_content jsonb, p_request_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_code text := case p_template when 'cong_van' then 'CV' when 'thong_bao' then 'TB' when 'qd_bo_nhiem' then 'QD' when 'qd_atgt' then 'QD' when 'quyet_dinh' then 'QD' end;
  v_label text;
  v_year int := extract(year from p_signed_on)::int;
  v_seq int;
  v_suffix text;
  v_row public.official_docs;
begin
  if v_tid is null or not app.has_permission('doc.manage') then
    raise exception 'Không có quyền soạn văn bản' using errcode = '42501';
  end if;
  if v_code is null or p_signed_on is null or nullif(trim(p_title), '') is null then
    raise exception 'Chọn loại văn bản, nhập ngày ký và trích yếu' using errcode = '22023';
  end if;
  if p_content is not null and jsonb_typeof(p_content) <> 'object' then
    raise exception 'Nội dung không hợp lệ' using errcode = '22023';
  end if;
  if p_staff_id is not null and not exists (select 1 from public.staff_members where tenant_id = v_tid and id = p_staff_id) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;

  if p_id is null then
    if p_request_id is not null then
      select * into v_row from public.official_docs where tenant_id = v_tid and request_id = p_request_id;
      if found then return jsonb_build_object('id', v_row.id, 'number', v_row.number); end if;
    end if;
    v_seq := app.next_doc_no(v_tid, v_code, v_year);
    -- phòng khi đã có số lớn hơn bộ đếm (dữ liệu nhập tay): nhảy qua, không bao giờ trùng
    if exists (select 1 from public.official_docs where tenant_id = v_tid and code = v_code and year = v_year and seq >= v_seq) then
      select max(seq) + 1 into v_seq from public.official_docs where tenant_id = v_tid and code = v_code and year = v_year;
      update public.doc_counters set last_no = v_seq where tenant_id = v_tid and code = v_code and year = v_year;
    end if;
    v_label := case v_code when 'QD' then 'QĐ' else v_code end;
    select upper(value #>> '{}') into v_suffix from public.tenant_settings where tenant_id = v_tid and key = 'lenh.hau_to';
    insert into public.official_docs (tenant_id, template, code, year, seq, number, signed_on, title, staff_id, content, request_id)
    values (v_tid, p_template, v_code, v_year, v_seq,
            lpad(v_seq::text, 3, '0') || '/' || v_year || '/' || v_label || coalesce('-' || nullif(trim(v_suffix), ''), ''),
            p_signed_on, trim(p_title), p_staff_id, coalesce(p_content, '{}'), p_request_id)
    returning * into v_row;
    return jsonb_build_object('id', v_row.id, 'number', v_row.number);
  end if;

  select * into v_row from public.official_docs where tenant_id = v_tid and id = p_id for update;
  if not found then
    raise exception 'Không tìm thấy văn bản' using errcode = 'P0002';
  end if;
  if v_row.status = 'da_huy' then
    raise exception 'Văn bản đã hủy, không sửa được' using errcode = '22023';
  end if;
  if v_row.code <> v_code then
    raise exception 'Không đổi được loại văn bản đã cấp số (số % thuộc dãy %)', v_row.number, v_row.code using errcode = '22023';
  end if;
  if v_row.year <> v_year then
    raise exception 'Số % đã cấp theo năm %; đổi sang năm khác thì hủy văn bản này và soạn văn bản mới', v_row.number, v_row.year using errcode = '22023';
  end if;
  update public.official_docs set template = p_template, signed_on = p_signed_on, title = trim(p_title), staff_id = p_staff_id,
    content = coalesce(p_content, '{}')
  where tenant_id = v_tid and id = p_id;
  return jsonb_build_object('id', v_row.id, 'number', v_row.number);
end;
$$;
revoke execute on function public.save_official_doc(uuid, text, date, text, uuid, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.save_official_doc(uuid, text, date, text, uuid, jsonb, uuid) to authenticated;

/** Hủy văn bản: giữ số trong sổ (không cấp lại cho văn bản khác). */
create function public.cancel_official_doc(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.has_permission('doc.manage') then
    raise exception 'Không có quyền hủy văn bản' using errcode = '42501';
  end if;
  if nullif(trim(p_reason), '') is null then
    raise exception 'Nhập lý do hủy' using errcode = '22023';
  end if;
  update public.official_docs set status = 'da_huy', cancel_reason = trim(p_reason)
  where tenant_id = v_tid and id = p_id and status = 'hieu_luc';
  if not found then
    raise exception 'Không tìm thấy văn bản' using errcode = 'P0002';
  end if;
end;
$$;
revoke execute on function public.cancel_official_doc(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_official_doc(uuid, text) to authenticated;
