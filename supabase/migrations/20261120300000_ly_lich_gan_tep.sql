-- =====================================================================
-- Gắn ảnh / PDF vào dòng lý lịch hành nghề đang chưa có tệp (giấy khám sức khỏe, giấy tập huấn chuyển từ app cũ
-- không kèm tệp). Chỉ người có quyền Sửa Lái xe & nhân viên; dòng đã có tệp thì không đổi (giữ bản gốc).
-- =====================================================================
create function public.attach_staff_record_files(p_id uuid, p_files text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r public.staff_records;
begin
  if v_tid is null or not app.has_permission('staff.edit') then
    raise exception 'Không có quyền sửa lý lịch' using errcode = '42501';
  end if;
  select * into r from public.staff_records where tenant_id = v_tid and id = p_id for update;
  if not found then raise exception 'Không tìm thấy lý lịch' using errcode = 'P0002'; end if;
  if coalesce(array_length(p_files, 1), 0) = 0 then raise exception 'Chưa có tệp' using errcode = '22023'; end if;
  if cardinality(r.files) > 0 then raise exception 'Dòng lý lịch này đã có tệp' using errcode = '22023'; end if;
  perform app.check_document_files(v_tid, 'nhan_su', r.staff_id, p_files);
  update public.staff_records set files = p_files where tenant_id = v_tid and id = p_id;
end;
$$;
revoke execute on function public.attach_staff_record_files(uuid, text[]) from public, anon, authenticated;
grant execute on function public.attach_staff_record_files(uuid, text[]) to authenticated;
