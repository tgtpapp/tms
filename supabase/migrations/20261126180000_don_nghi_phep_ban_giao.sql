-- Đơn xin nghỉ phép (mẫu in): thêm người nhận bàn giao công việc. Chỉ THÊM 1 cột mới, không đổi / xóa cột cũ.
-- handover_staff_id: nhân viên cùng nhà xe nhận bàn giao (khóa ngoại kép theo tenant); chức vụ lấy theo hồ sơ khi in.
alter table public.staff_leaves add column handover_staff_id uuid;
alter table public.staff_leaves add constraint staff_leaves_handover_fk
  foreign key (tenant_id, handover_staff_id) references public.staff_members (tenant_id, id) on delete set null (handover_staff_id);

-- save_leave thêm tham số p_handover (mặc định null: lời gọi cũ 7 tham số vẫn chạy)
drop function public.save_leave(uuid, uuid, text, date, date, numeric, text);
create function public.save_leave(p_id uuid, p_staff_id uuid, p_kind text, p_from date, p_to date, p_days numeric, p_reason text,
                                  p_handover uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_old public.staff_leaves;
begin
  if v_tid is null then raise exception 'Không có quyền' using errcode = '42501'; end if;
  if p_id is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'Ngày nghỉ không hợp lệ' using errcode = '22023';
  end if;
  if p_days is null or p_days <= 0 or p_days > 366 then raise exception 'Số ngày nghỉ không hợp lệ' using errcode = '22023'; end if;
  if not exists (select 1 from public.staff_members where id = p_staff_id and tenant_id = v_tid) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  if p_handover is not null and (p_handover = p_staff_id
      or not exists (select 1 from public.staff_members where id = p_handover and tenant_id = v_tid)) then
    raise exception 'Người nhận bàn giao không hợp lệ' using errcode = '22023';
  end if;
  if not (app.is_my_staff(p_staff_id::text) or app.has_permission('leave.add')) then
    raise exception 'Không có quyền ghi đơn nghỉ cho người khác' using errcode = '42501';
  end if;
  select * into v_old from public.staff_leaves where id = p_id;
  if found then
    if v_old.tenant_id <> v_tid then raise exception 'Không tìm thấy đơn nghỉ' using errcode = 'P0002'; end if;
    if v_old.status <> 'cho_duyet' then raise exception 'Đơn đã duyệt / từ chối / hủy, không sửa được' using errcode = '22023'; end if;
    if not (v_old.created_by = auth.uid() or app.has_permission('leave.edit')) then
      raise exception 'Không có quyền sửa đơn này' using errcode = '42501';
    end if;
    update public.staff_leaves set staff_id = p_staff_id, kind = p_kind, from_on = p_from, to_on = p_to, days = p_days,
           reason = nullif(trim(p_reason), ''), handover_staff_id = p_handover where id = p_id;
  else
    insert into public.staff_leaves (id, tenant_id, staff_id, kind, from_on, to_on, days, reason, handover_staff_id)
    values (p_id, v_tid, p_staff_id, p_kind, p_from, p_to, p_days, nullif(trim(p_reason), ''), p_handover);
  end if;
  return p_id;
end;
$$;
revoke execute on function public.save_leave(uuid, uuid, text, date, date, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.save_leave(uuid, uuid, text, date, date, numeric, text, uuid) to authenticated;
