-- =====================================================================
-- 1) Hủy vé: lý do hủy để trống được (lưu "Không ghi lý do").
-- 2) Vé đã hủy: quản trị (Chủ nhà xe, Quản trị) toàn quyền — sửa thông tin khách và xóa hẳn vé đã hủy.
--    Chỉ xóa dòng vé đã hủy / hết hạn; sổ cái (thu, hoàn, phí hủy) giữ nguyên, nhật ký thao tác ghi lại việc xóa.
-- =====================================================================
do $$
declare v text;
begin
  v := pg_get_functiondef('public.cancel_tickets(uuid[], text, text, integer, text, text, bigint)'::regprocedure);
  v := replace(v, E'  if nullif(trim(p_reason), '''') is null then\n    raise exception ''Nhập lý do hủy vé'' using errcode = ''22023'';\n  end if;\n', '');
  v := replace(v, 'cancel_reason = trim(p_reason) ||', 'cancel_reason = coalesce(nullif(trim(p_reason), ''''), ''Không ghi lý do'') ||');
  v := replace(v, '''Hủy vé: '' || trim(p_reason)', '''Hủy vé'' || coalesce('': '' || nullif(trim(p_reason), ''''), '''')');
  if v like '%Nhập lý do hủy vé%' or v not like '%Không ghi lý do%' or v not like '%coalesce('': '' || nullif(trim(p_reason)%' then
    raise exception 'Không sửa được cancel_tickets';
  end if;
  execute v;
end;
$$;

-- nhóm quyền riêng (không thuộc nhóm Bán vé) để vai trò Bán vé / Điều hành không tự có
insert into public.permissions (code, module, name) values ('sell_admin.cancelled', 'sell_admin', 'Bán vé: Sửa / xóa vé đã hủy (quản trị)')
on conflict (code) do nothing;
select app.grant_permission_to_admins('sell_admin.cancelled');

-- Sửa thông tin khách: vé đã hủy chỉ quản trị sửa được
do $$
declare v text;
begin
  v := pg_get_functiondef('public.update_ticket_info(uuid, text, text, text, text)'::regprocedure);
  v := replace(v, 'and status in (''dat'', ''da_tt'');',
    'and (status in (''dat'', ''da_tt'') or (status in (''huy'', ''het_han'') and app.has_permission(''sell_admin.cancelled'')));');
  if v not like '%sell_admin.cancelled%' then raise exception 'Không sửa được update_ticket_info'; end if;
  execute v;
end;
$$;

create function public.delete_cancelled_ticket(p_ticket_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_row public.seat_inventory;
begin
  if v_tid is null or not app.has_permission('sell_admin.cancelled') then
    raise exception 'Chỉ quản trị được xóa vé đã hủy' using errcode = '42501';
  end if;
  select * into v_row from public.seat_inventory where tenant_id = v_tid and id = p_ticket_id for update;
  if not found then
    raise exception 'Không tìm thấy vé' using errcode = 'P0002';
  end if;
  if v_row.status not in ('huy', 'het_han') then
    raise exception 'Chỉ xóa được vé đã hủy' using errcode = '22023';
  end if;
  delete from public.transfer_items where tenant_id = v_tid and ticket_id = p_ticket_id;
  delete from public.seat_inventory where tenant_id = v_tid and id = p_ticket_id;
  -- đơn không còn vé và chưa có giao dịch tiền thì xóa luôn đơn
  if not exists (select 1 from public.seat_inventory where tenant_id = v_tid and booking_id = v_row.booking_id)
     and not exists (select 1 from public.ledger_transactions where tenant_id = v_tid and booking_id = v_row.booking_id) then
    begin
      delete from public.bookings where tenant_id = v_tid and id = v_row.booking_id;
    exception when foreign_key_violation then
      null;
    end;
  end if;
end;
$$;
revoke execute on function public.delete_cancelled_ticket(uuid) from public, anon, authenticated;
grant execute on function public.delete_cancelled_ticket(uuid) to authenticated;
