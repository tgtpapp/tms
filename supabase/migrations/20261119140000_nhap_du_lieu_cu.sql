-- =====================================================================
-- Nhập dữ liệu từ app cũ (file sao lưu .json đọc trên máy người dùng, không gửi file lên máy chủ)
-- - Nhân viên / xe: dùng save_staff và bảng vehicles như nhập tay (id cố định theo mã cũ → nhập lại không trùng).
-- - Giấy tờ: import_document – giống add_*_document nhưng
--     * cho phép chưa có tệp (giấy cũ chỉ có số / hạn, ảnh nằm trên Google Drive),
--     * KHÔNG thay bản hiện hành đã có (dữ liệu nhập tay trong TMS được ưu tiên): đã có thì bỏ qua, trả null.
-- =====================================================================

create function public.import_document(
  p_owner_kind text, p_owner_id uuid, p_doc_type text, p_doc_no text, p_issuer text, p_issued_on date,
  p_valid_from date, p_expires_on date, p_data jsonb, p_files text[], p_note text, p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_id uuid;
begin
  if p_owner_kind not in ('xe', 'nhan_su') then
    raise exception 'Loại giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  if v_tid is null or not app.can_manage_documents(p_owner_kind) then
    raise exception 'Không có quyền quản lý giấy tờ' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'Thiếu khóa chống lưu trùng' using errcode = '22023';
  end if;
  select id into v_id from public.documents where tenant_id = v_tid and request_id = p_request_id;
  if found then return v_id; end if;
  if p_owner_kind = 'xe' and not exists (select 1 from public.vehicles where id = p_owner_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy xe' using errcode = 'P0002';
  end if;
  if p_owner_kind = 'nhan_su' and not exists (select 1 from public.staff_members where id = p_owner_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.document_types where code = p_doc_type and owner_kind = p_owner_kind) then
    raise exception 'Loại giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  if p_data is not null and jsonb_typeof(p_data) <> 'object' then
    raise exception 'Thông tin giấy tờ không hợp lệ' using errcode = '22023';
  end if;
  perform app.check_document_files(v_tid, p_owner_kind, p_owner_id, coalesce(p_files, '{}'));
  -- Đã có giấy hiện hành loại này: giữ nguyên, không nhập đè
  if exists (select 1 from public.documents where tenant_id = v_tid and doc_type = p_doc_type and is_current
               and (vehicle_id = p_owner_id or staff_id = p_owner_id)) then
    return null;
  end if;

  insert into public.documents (tenant_id, owner_kind, vehicle_id, staff_id, doc_type, doc_no, issuer, issued_on, valid_from,
                                expires_on, data, files, note, request_id, created_by)
  values (v_tid, p_owner_kind, case when p_owner_kind = 'xe' then p_owner_id end, case when p_owner_kind = 'nhan_su' then p_owner_id end,
          p_doc_type, nullif(trim(p_doc_no), ''), nullif(trim(p_issuer), ''), p_issued_on,
          p_valid_from, case when p_valid_from is not null and p_expires_on < p_valid_from then null else p_expires_on end,
          coalesce(p_data, '{}'), coalesce(p_files, '{}'), nullif(trim(p_note), ''), p_request_id, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function public.import_document(text, uuid, text, text, text, date, date, date, jsonb, text[], text, uuid)
  from public, anon, authenticated;
grant execute on function public.import_document(text, uuid, text, text, text, date, date, date, jsonb, text[], text, uuid)
  to authenticated;
